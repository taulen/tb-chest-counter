import { getDb } from '../database.js';
import { childLogger } from '../../utils/logger.js';
import { cached, invalidate } from '../../utils/ttl-cache.js';
import { getDefaultPointsFor, getDefaultPointsForKey, getSourceKey, isKnownSourceKey, canonicalSourceKey } from '../../vision/source-names.js';
import { notifyChestDataChanged } from './chest-summary-repo.js';

const log = childLogger('source-points-repo');

// Source point values are PER CLAN (v86) and superadmin-managed: each clan has
// its own override table, and a clan with no override for a chest scores the
// built-in default. They were one global table from v43 to v85; v86 copied
// that table to every clan, so the clans started out identical.
const SOURCE_KEY_SUMMARY_CACHE_KEY = 'sourceKeySummary';

// The source-points summary is an expensive aggregate read by the leaderboard
// FAQ. It only changes on point overrides, recalculation, scan completion, or
// chest reassignment, so it is memoized per clan under this prefix and
// invalidated explicitly at those sites (with a 5-min TTL backstop). See
// src/utils/ttl-cache.ts.
const SOURCE_KEY_SUMMARY_TTL_MS = 300000;

/** Drop every clan's cached source-key summary so the next read recomputes fresh. */
export function invalidateSourceKeySummary(): void {
  invalidate(SOURCE_KEY_SUMMARY_CACHE_KEY);
}

export interface SourcePointOverride {
  id: number;
  sourceKey: string;
  chestName: string;
  pointValue: number;
  updatedAt: string;
}

/**
 * One summary entry per source_key, with a nested list of chest_name rows
 * that either appear in chest_records under that source or have an
 * override row. The admin UI renders one <details> block per source with
 * a list of chest-name rows beneath.
 */
export interface SourceKeySummary {
  sourceKey: string;
  sampleSource: string;
  totalCount: number;
  defaultPoints: number;
  wildcardOverride: number | null;
  /**
   * False when the key was produced by the structured pattern matchers in
   * `getSourceKey()`. True when it came from the slug fallback — i.e. a
   * source type the parser doesn't know yet and which the admin probably
   * wants to review and assign a point value to.
   */
  isCustom: boolean;
  chestRows: SourceChestRowSummary[];
}

export interface SourceChestRowSummary {
  chestName: string;
  /**
   * The value this row would score with no override of its own — the wildcard
   * override, else the seeded default for this chest, else the source default.
   * The admin input shows it as the placeholder, so clearing an override
   * previews what the row reverts to (which is NOT always the source default
   * now that SOURCE_CHEST_POINTS seeds per-chest values).
   */
  fallbackPoints: number;
  /** The chest_type observed on rows with this chest_name — used only for
   *  colored badges in the admin UI, not for lookup. */
  chestType: string;
  count: number;
  override: number | null;
  effectivePoints: number;
  isWildcard: boolean;
}

/**
 * Build a cache-map key for (source_key, chest_name). Using a tab separator
 * keeps the composite unambiguous without colliding with either column's
 * value space (source keys and chest names never contain tabs).
 */
export function makeCacheKey(sourceKey: string, chestName: string): string {
  // Canonicalize the source part (space-insensitive) so overrides match
  // regardless of whether the source was OCR'd with spaces (Tesseract /
  // historical) or without (PaddleOCR). The chest name is already canonical
  // via correctChestName, so it's compared verbatim. See canonicalSourceKey.
  return `${canonicalSourceKey(sourceKey)}\t${chestName}`;
}

/**
 * Sort chest rows: wildcard pinned first, then alphabetical by chest name.
 */
function sortChestRows(rows: SourceChestRowSummary[]): SourceChestRowSummary[] {
  return rows.sort((a, b) => {
    if (a.isWildcard !== b.isWildcard) return a.isWildcard ? -1 : 1;
    return a.chestName.localeCompare(b.chestName);
  });
}

export function getSourceKeySummary(clanId: number): SourceKeySummary[] {
  // Read-mostly aggregate; memoize per clan. Invalidated on every mutation
  // that changes the summary (overrides, recalculate, scan completion,
  // reassignment) so nobody sees stale counts. TTL is only a backstop.
  return cached(`${SOURCE_KEY_SUMMARY_CACHE_KEY}:${clanId}`, SOURCE_KEY_SUMMARY_TTL_MS, () =>
    computeSourceKeySummary(clanId),
  );
}

function computeSourceKeySummary(clanId: number): SourceKeySummary[] {
  const db = getDb();
  const overrides = getAllOverrides(clanId);

  // Group by the FK ids on the base table (index-friendly), then join for
  // display columns. This clan's records only — its values are its own, so
  // the sources listed are the ones its members actually receive.
  // chest_sources.source and chests.name are UNIQUE so grouping on
  // (chest_source_id, chest_id) is identical to grouping on
  // (chest_source, chest_name, chest_type) — chest_type is a function of the
  // (source, chest) pair (crypt rarity first, v83), so dropping it from the
  // GROUP BY changes nothing.
  const rows = db.prepare(`
    SELECT cs.source AS chest_source, ch.name AS chest_name,
           COALESCE(cs.rarity, ch.chest_type) AS chest_type, g.cnt
    FROM (
      SELECT chest_source_id, chest_id, COUNT(*) AS cnt
      FROM chest_records
      WHERE clan_id = ? AND chest_source_id IS NOT NULL
      GROUP BY chest_source_id, chest_id
    ) g
    JOIN chest_sources cs ON cs.id = g.chest_source_id
    JOIN chests ch ON ch.id = g.chest_id
    WHERE cs.source != ''
  `).all(clanId) as { chest_source: string; chest_name: string; chest_type: string; cnt: number }[];

  interface Bucket {
    sampleSource: string;
    sampleCount: number;
    totalCount: number;
    rowsByName: Map<string, { count: number; chestType: string; typeCount: number; override: number | null }>;
  }
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    const key = getSourceKey(row.chest_source);
    if (!key) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        sampleSource: row.chest_source,
        sampleCount: row.cnt,
        totalCount: 0,
        rowsByName: new Map(),
      };
      buckets.set(key, bucket);
    }
    bucket.totalCount += row.cnt;
    if (row.cnt > bucket.sampleCount) {
      bucket.sampleSource = row.chest_source;
      bucket.sampleCount = row.cnt;
    }
    const existing = bucket.rowsByName.get(row.chest_name);
    if (existing) {
      existing.count += row.cnt;
      if (row.cnt > existing.typeCount) {
        existing.chestType = row.chest_type;
        existing.typeCount = row.cnt;
      }
    } else {
      bucket.rowsByName.set(row.chest_name, {
        count: row.cnt,
        chestType: row.chest_type,
        typeCount: row.cnt,
        override: null,
      });
    }
  }

  for (const ov of overrides) {
    let bucket = buckets.get(ov.sourceKey);
    if (!bucket) {
      bucket = {
        sampleSource: '',
        sampleCount: 0,
        totalCount: 0,
        rowsByName: new Map(),
      };
      buckets.set(ov.sourceKey, bucket);
    }
    const existing = bucket.rowsByName.get(ov.chestName);
    if (existing) {
      existing.override = ov.pointValue;
    } else {
      bucket.rowsByName.set(ov.chestName, {
        count: 0,
        chestType: '',
        typeCount: 0,
        override: ov.pointValue,
      });
    }
  }

  const summary: SourceKeySummary[] = [];
  for (const [key, bucket] of buckets.entries()) {
    const defaultPoints = getDefaultPointsForKey(key);
    const wildcardOverride = bucket.rowsByName.get('')?.override ?? null;

    if (!bucket.rowsByName.has('')) {
      bucket.rowsByName.set('', { count: 0, chestType: '', typeCount: 0, override: null });
    }

    const chestRows: SourceChestRowSummary[] = [];
    for (const [chestName, r] of bucket.rowsByName.entries()) {
      const isWildcard = chestName === '';
      // What applies to this row with no override of its own: the source-wide
      // wildcard override if the admin set one, else the seeded default for
      // this exact chest, else the source-wide default. getDefaultPointsFor
      // collapses the last two (it returns the key default for '').
      const fallback = !isWildcard && wildcardOverride !== null
        ? wildcardOverride
        : getDefaultPointsFor(key, chestName);
      chestRows.push({
        chestName,
        chestType: r.chestType,
        count: r.count,
        override: r.override,
        effectivePoints: r.override !== null ? r.override : fallback,
        fallbackPoints: fallback,
        isWildcard,
      });
    }

    summary.push({
      sourceKey: key,
      sampleSource: bucket.sampleSource,
      totalCount: bucket.totalCount,
      defaultPoints,
      wildcardOverride,
      isCustom: !isKnownSourceKey(key),
      chestRows: sortChestRows(chestRows),
    });
  }

  summary.sort((a, b) => {
    if (a.isCustom !== b.isCustom) return a.isCustom ? -1 : 1;
    return a.sourceKey.localeCompare(b.sourceKey);
  });
  return summary;
}

export function getAllOverrides(clanId: number): SourcePointOverride[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, source_key, chest_name, point_value, updated_at FROM source_point_overrides WHERE clan_id = ? ORDER BY source_key, chest_name',
  ).all(clanId) as {
    id: number;
    source_key: string;
    chest_name: string;
    point_value: number;
    updated_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    sourceKey: r.source_key,
    chestName: r.chest_name,
    pointValue: r.point_value,
    updatedAt: r.updated_at,
  }));
}

/**
 * Load one clan's overrides into an in-memory map keyed on makeCacheKey(source,
 * chest_name). Called once per scan and passed to getPointsForSourceCached()
 * in the hot loop.
 */
export function loadOverrides(clanId: number): Map<string, number> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT source_key, chest_name, point_value FROM source_point_overrides WHERE clan_id = ?',
  ).all(clanId) as { source_key: string; chest_name: string; point_value: number }[];
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(makeCacheKey(row.source_key, row.chest_name), row.point_value);
  }
  return map;
}

/**
 * Hot-path point lookup. Tries the exact (source_key, chest_name) override
 * first, then the wildcard (source_key, '') override, then the hardcoded
 * default — which is itself per-chest where the source pays its chests
 * different rates (SOURCE_CHEST_POINTS). Safe to call for every chest inserted
 * during a scan.
 */
export function getPointsForSourceCached(
  overrides: Map<string, number>,
  source: string,
  chestName: string,
): number {
  const key = getSourceKey(source);
  if (!key) return 0;
  return resolvePointsForKey(overrides, key, chestName);
}

/**
 * The lookup stack for an already-derived source key: exact override, then the
 * source's wildcard override, then the seeded default. The one place the order
 * is written down — scans, recalculation and the admin board's previews all
 * resolve through it, so a preview can never disagree with what a save does.
 */
export function resolvePointsForKey(
  overrides: Map<string, number>,
  key: string,
  chestName: string,
): number {
  const exact = overrides.get(makeCacheKey(key, chestName));
  if (exact !== undefined) return exact;
  const wildcard = overrides.get(makeCacheKey(key, ''));
  if (wildcard !== undefined) return wildcard;
  return getDefaultPointsFor(key, chestName);
}


/** One override row to write: `points: null` removes it. `chestName: ''` is the wildcard. */
export interface OverrideWrite {
  sourceKey: string;
  chestName: string;
  points: number | null;
}

/**
 * Apply a batch of one clan's override writes in one transaction. Each write
 * first clears every row for the same (canonical source key, chest name) — a
 * source OCR'd with and without spaces can hold one row per spelling, and the
 * lookup map keys on the canonical form, so leaving a second spelling behind
 * would let it win or lose at random. Records are NOT touched here; the caller
 * recalculates the affected sources afterwards (see points-board.ts
 * applyPointChanges).
 */
export function writeOverrides(clanId: number, writes: OverrideWrite[]): void {
  if (writes.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare(
    'SELECT id, source_key, chest_name FROM source_point_overrides WHERE clan_id = ?',
  ).all(clanId) as { id: number; source_key: string; chest_name: string }[];
  const del = db.prepare('DELETE FROM source_point_overrides WHERE id = ?');
  const ins = db.prepare(
    'INSERT INTO source_point_overrides (clan_id, source_key, chest_name, point_value, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (const w of writes) {
      const canon = canonicalSourceKey(w.sourceKey);
      for (const row of existing) {
        if (row.chest_name === w.chestName && canonicalSourceKey(row.source_key) === canon) del.run(row.id);
      }
      if (w.points !== null) ins.run(clanId, w.sourceKey, w.chestName, w.points, now);
    }
  })();
  const set = writes.filter((w) => w.points !== null).length;
  log.info(`Source points (clan ${clanId}): wrote ${set} value(s), cleared ${writes.length - set}`);
  invalidateSourceKeySummary();
}

/**
 * Replace every override of `toClanId` with a copy of `fromClanId`'s, in one
 * transaction — "this clan pays exactly what that one does". A value the
 * target set that the source doesn't have is removed, so it falls back to the
 * built-in default just as it does in the source clan. Records are NOT touched
 * here; the caller recalculates the target afterwards.
 */
export function copyOverrides(fromClanId: number, toClanId: number): { copied: number; removed: number } {
  const db = getDb();
  const now = new Date().toISOString();
  let copied = 0;
  let removed = 0;
  db.transaction(() => {
    removed = db.prepare('DELETE FROM source_point_overrides WHERE clan_id = ?').run(toClanId).changes;
    copied = db.prepare(
      `INSERT INTO source_point_overrides (clan_id, source_key, chest_name, point_value, updated_at)
       SELECT ?, source_key, chest_name, point_value, ? FROM source_point_overrides WHERE clan_id = ?`,
    ).run(toClanId, now, fromClanId).changes;
  })();
  log.info(`Source points: copied ${copied} value(s) from clan ${fromClanId} to clan ${toClanId} (replacing ${removed})`);
  invalidateSourceKeySummary();
  return { copied, removed };
}

/**
 * Recalculate one clan's chest_records.point_value from its current override +
 * default stack. Another clan's records are never touched: its values are its
 * own.
 *
 * `onlyCanonKeys` limits the pass to sources whose canonical key is in the
 * set — what a save uses, so it rewrites exactly the sources it changed.
 * Returns the number of rows whose value actually changed.
 */
export function recalculatePoints(clanId: number, onlyCanonKeys?: ReadonlySet<string>): number {
  const updated = recalculatePointsForClan(clanId, loadOverrides(clanId), onlyCanonKeys);
  log.info(`Recalculated point values for clan ${clanId}: ${updated} rows updated`);
  invalidateSourceKeySummary();
  return updated;
}

/**
 * Recalculate one clan's chest_records.point_value using the given override
 * map. Groups by (source_key, chest_name) so every chest name gets its
 * effective value applied in one UPDATE. Notifies the daily-summary rollup
 * when the clan's rows actually changed.
 */
function recalculatePointsForClan(
  clanId: number,
  overrideMap: Map<string, number>,
  onlyCanonKeys?: ReadonlySet<string>,
): number {
  const db = getDb();

  const distinct = db.prepare(`
    SELECT DISTINCT chest_source, chest_name
    FROM chest_records_v
    WHERE clan_id = ? AND chest_source != ''
  `).all(clanId) as { chest_source: string; chest_name: string }[];

  interface Group { sourceKey: string; chestName: string; sources: string[] }
  const groups = new Map<string, Group>();
  for (const row of distinct) {
    const key = getSourceKey(row.chest_source);
    if (!key) continue;
    if (onlyCanonKeys && !onlyCanonKeys.has(canonicalSourceKey(key))) continue;
    const cacheKey = makeCacheKey(key, row.chest_name);
    const existing = groups.get(cacheKey);
    if (existing) {
      existing.sources.push(row.chest_source);
    } else {
      groups.set(cacheKey, { sourceKey: key, chestName: row.chest_name, sources: [row.chest_source] });
    }
  }

  let totalUpdated = 0;
  const tx = db.transaction(() => {
    for (const group of groups.values()) {
      const value = resolvePointsForKey(overrideMap, group.sourceKey, group.chestName);

      // Resolve string source/name values to their FK ids and UPDATE on
      // those — the chest_source / chest_name columns no longer exist on
      // chest_records post-D3 (they live in the chest_sources / chests
      // reference tables now). `point_value != ?` keeps the count honest:
      // SQLite counts a row rewritten to the value it already held.
      const placeholders = group.sources.map(() => '?').join(', ');
      const result = db.prepare(`
        UPDATE chest_records
           SET point_value = ?
         WHERE clan_id = ?
           AND chest_source_id IN (
             SELECT id FROM chest_sources WHERE source IN (${placeholders})
           )
           AND chest_id = (SELECT id FROM chests WHERE name = ?)
           AND point_value != ?
      `).run(value, clanId, ...group.sources, group.chestName, value);
      totalUpdated += result.changes;
    }
  });
  tx();
  if (totalUpdated > 0) notifyChestDataChanged(clanId);
  return totalUpdated;
}
