import { getDb } from '../database.js';
import { childLogger } from '../../utils/logger.js';
import { cached, invalidate } from '../../utils/ttl-cache.js';
import { getDefaultPointsFor, getDefaultPointsForKey, getSourceKey, isKnownSourceKey, canonicalSourceKey } from '../../vision/source-names.js';
import { notifyChestDataChanged } from './chest-summary-repo.js';
import { listClans } from './clan-repo.js';

const log = childLogger('source-points-repo');

// Source point values are a single GLOBAL scoring table shared by every
// clan (superadmin-managed). The overrides table has no clan_id; only the
// chest_records backfill/recalculate is per-clan (looped over listClans()).
const SOURCE_KEY_SUMMARY_CACHE_KEY = 'sourceKeySummary';

// The source-points summary is an expensive aggregate read by a polled
// admin endpoint (GET /api/admin/source-points). It only changes on point
// overrides, recalculation, scan completion, or chest reassignment, so we
// memoize it under a single global key and invalidate explicitly at those
// sites (with a 5-min TTL backstop). See src/utils/ttl-cache.ts.
const SOURCE_KEY_SUMMARY_TTL_MS = 300000;

/** Drop the cached source-key summary so the next read recomputes fresh. */
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

export function getSourceKeySummary(): SourceKeySummary[] {
  // Read-mostly aggregate behind a polled admin endpoint; memoize under a
  // single global key. Invalidated on every mutation that changes the
  // summary (overrides, recalculate, scan completion, reassignment) so
  // admins never see stale counts. TTL is only a backstop.
  return cached(SOURCE_KEY_SUMMARY_CACHE_KEY, SOURCE_KEY_SUMMARY_TTL_MS, () =>
    computeSourceKeySummary(),
  );
}

function computeSourceKeySummary(): SourceKeySummary[] {
  const db = getDb();
  const overrides = getAllOverrides();

  // Group by the FK ids on the base table (index-friendly), then join for
  // display columns. Aggregated across ALL clans — the scoring table is
  // global, so every admin sees the same authoritative source list.
  // chest_sources.source and chests.name are UNIQUE so grouping on
  // (chest_source_id, chest_id) is identical to grouping on
  // (chest_source, chest_name, chest_type) — chest_type is 1:1 with the
  // chest row, so dropping it from the GROUP BY changes nothing.
  const rows = db.prepare(`
    SELECT cs.source AS chest_source, ch.name AS chest_name, ch.chest_type, g.cnt
    FROM (
      SELECT chest_source_id, chest_id, COUNT(*) AS cnt
      FROM chest_records
      WHERE chest_source_id IS NOT NULL
      GROUP BY chest_source_id, chest_id
    ) g
    JOIN chest_sources cs ON cs.id = g.chest_source_id
    JOIN chests ch ON ch.id = g.chest_id
    WHERE cs.source != ''
  `).all() as { chest_source: string; chest_name: string; chest_type: string; cnt: number }[];

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

export function getAllOverrides(): SourcePointOverride[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, source_key, chest_name, point_value, updated_at FROM source_point_overrides ORDER BY source_key, chest_name',
  ).all() as {
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
 * Load all overrides into an in-memory map keyed on makeCacheKey(source,
 * chest_name). Called once per scan and passed to getPointsForSourceCached()
 * in the hot loop. Overrides are global, so every clan's scan uses the same
 * map.
 */
export function loadOverrides(): Map<string, number> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT source_key, chest_name, point_value FROM source_point_overrides',
  ).all() as { source_key: string; chest_name: string; point_value: number }[];
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
  const exact = overrides.get(makeCacheKey(key, chestName));
  if (exact !== undefined) return exact;
  const wildcard = overrides.get(makeCacheKey(key, ''));
  if (wildcard !== undefined) return wildcard;
  return getDefaultPointsFor(key, chestName);
}

/**
 * UPSERT an override row for (source_key, chest_name) and backfill all
 * historical chest_records rows whose (source, name) resolves to this
 * override. chest_name = '' means wildcard — it applies to every chest
 * under this source that doesn't have its own more-specific override.
 * Returns the number of chest records updated by the backfill.
 */
export function setOverride(
  sourceKey: string,
  chestName: string,
  pointValue: number,
): number {
  const db = getDb();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO source_point_overrides (source_key, chest_name, point_value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_key, chest_name) DO UPDATE SET point_value = ?, updated_at = ?
    `).run(sourceKey, chestName, pointValue, now, pointValue, now);
  });
  tx();

  // The override is global, but chest_records are per-clan — backfill each
  // clan's historical rows and notify only the clans that actually changed.
  let updated = 0;
  for (const clan of listClans()) {
    const changed = backfillPointsForComposite(sourceKey, chestName, pointValue, clan.id);
    updated += changed;
    if (changed > 0) notifyChestDataChanged(clan.id);
  }
  const label = chestName === '' ? `${sourceKey} (wildcard)` : `${sourceKey} / ${chestName}`;
  log.info(`Override set: ${label} = ${pointValue} (backfilled ${updated} rows across all clans)`);
  invalidateSourceKeySummary();
  return updated;
}

/**
 * Remove an override row and backfill affected chest_records with the
 * correct fallback value (the wildcard override if one exists, else the
 * hardcoded default).
 */
export function deleteOverride(
  sourceKey: string,
  chestName: string,
): number {
  const db = getDb();
  db.prepare(
    'DELETE FROM source_point_overrides WHERE source_key = ? AND chest_name = ?',
  ).run(sourceKey, chestName);

  const fallback = resolveFallbackValue(sourceKey, chestName);
  let updated = 0;
  for (const clan of listClans()) {
    const changed = backfillPointsForComposite(sourceKey, chestName, fallback, clan.id);
    updated += changed;
    if (changed > 0) notifyChestDataChanged(clan.id);
  }
  const label = chestName === '' ? `${sourceKey} (wildcard)` : `${sourceKey} / ${chestName}`;
  log.info(`Override removed: ${label} (reverted to ${fallback}, backfilled ${updated} rows across all clans)`);
  invalidateSourceKeySummary();
  return updated;
}

/**
 * Compute the value that applies to (source_key, chest_name) when no
 * name-specific override exists: the wildcard override if set, else the
 * hardcoded default. Used when deleting a row so the backfill uses the
 * value the live lookup path would produce.
 */
function resolveFallbackValue(sourceKey: string, chestName: string): number {
  const db = getDb();
  if (chestName !== '') {
    const wildcard = db.prepare(
      'SELECT point_value FROM source_point_overrides WHERE source_key = ? AND chest_name = \'\'',
    ).get(sourceKey) as { point_value: number } | undefined;
    if (wildcard) return wildcard.point_value;
  }
  return getDefaultPointsFor(sourceKey, chestName);
}

/**
 * Recalculate chest_records.point_value across EVERY clan using the current
 * global override + default stack. The override map is global, so it's
 * loaded once and applied to each clan's rows in turn.
 */
export function recalculateAllPoints(): number {
  const overrideMap = loadOverrides();
  let totalUpdated = 0;
  let clanCount = 0;
  for (const clan of listClans()) {
    clanCount++;
    totalUpdated += recalculatePointsForClan(clan.id, overrideMap);
  }
  log.info(`Recalculated point values: ${totalUpdated} rows updated across ${clanCount} clan(s)`);
  invalidateSourceKeySummary();
  return totalUpdated;
}

/**
 * Recalculate one clan's chest_records.point_value using the given global
 * override map. Groups by (source_key, chest_name) so every chest name gets
 * its effective value applied in one UPDATE. Notifies the daily-summary
 * rollup when the clan's rows actually changed.
 */
function recalculatePointsForClan(clanId: number, overrideMap: Map<string, number>): number {
  const db = getDb();

  const distinct = db.prepare(`
    SELECT DISTINCT chest_source, chest_name
    FROM chest_records_v
    WHERE clan_id = ? AND chest_source != ''
  `).all(clanId) as { chest_source: string; chest_name: string }[];

  interface Group { chestName: string; sources: string[] }
  const groups = new Map<string, Group>();
  for (const row of distinct) {
    const key = getSourceKey(row.chest_source);
    if (!key) continue;
    const cacheKey = makeCacheKey(key, row.chest_name);
    const existing = groups.get(cacheKey);
    if (existing) {
      existing.sources.push(row.chest_source);
    } else {
      groups.set(cacheKey, { chestName: row.chest_name, sources: [row.chest_source] });
    }
  }

  let totalUpdated = 0;
  const tx = db.transaction(() => {
    for (const [cacheKey, group] of groups.entries()) {
      const sourceKey = cacheKey.split('\t')[0];
      const exact = overrideMap.get(cacheKey);
      const wildcard = overrideMap.get(makeCacheKey(sourceKey, ''));
      const value = exact ?? wildcard ?? getDefaultPointsFor(sourceKey, group.chestName);

      // Resolve string source/name values to their FK ids and UPDATE on
      // those — the chest_source / chest_name columns no longer exist on
      // chest_records post-D3 (they live in the chest_sources / chests
      // reference tables now).
      const placeholders = group.sources.map(() => '?').join(', ');
      const result = db.prepare(`
        UPDATE chest_records
           SET point_value = ?
         WHERE clan_id = ?
           AND chest_source_id IN (
             SELECT id FROM chest_sources WHERE source IN (${placeholders})
           )
           AND chest_id = (SELECT id FROM chests WHERE name = ?)
      `).run(value, clanId, ...group.sources, group.chestName);
      totalUpdated += result.changes;
    }
  });
  tx();
  if (totalUpdated > 0) notifyChestDataChanged(clanId);
  return totalUpdated;
}

/**
 * Update chest_records.point_value for every row whose (chest_source,
 * chest_name) resolves to this (source_key, chest_name) override.
 *
 * Wildcard writes (chest_name = '') backfill every chest_records row
 * whose source resolves to this key AND which has no more-specific
 * override covering its chest_name — otherwise the wildcard would clobber
 * a name-specific value that should win.
 */
function backfillPointsForComposite(
  sourceKey: string,
  chestName: string,
  newValue: number,
  clanId: number,
): number {
  const db = getDb();
  // Read distinct chest_source strings via the view (chest_source is
  // denormalized through chest_sources post-D3) so the JS-side
  // getSourceKey() filter can still group sources that share a key.
  const sources = db.prepare(
    "SELECT DISTINCT chest_source FROM chest_records_v WHERE clan_id = ? AND chest_source != ''",
  ).all(clanId) as { chest_source: string }[];

  const matching = sources
    .map((r) => r.chest_source)
    .filter((s) => getSourceKey(s) === sourceKey);

  if (matching.length === 0) return 0;
  const placeholders = matching.map(() => '?').join(', ');
  // Reusable subquery — chest_records.chest_source_id IN (the FK ids of
  // every chest_source string in `matching`). Built once and inlined
  // into each UPDATE branch.
  const sourceIdSubquery = `(SELECT id FROM chest_sources WHERE source IN (${placeholders}))`;

  if (chestName !== '') {
    const result = db.prepare(`
      UPDATE chest_records SET point_value = ?
       WHERE clan_id = ?
         AND chest_source_id IN ${sourceIdSubquery}
         AND chest_id = (SELECT id FROM chests WHERE name = ?)
    `).run(newValue, clanId, ...matching, chestName);
    return result.changes;
  }

  const specific = db.prepare(
    "SELECT chest_name FROM source_point_overrides WHERE source_key = ? AND chest_name != ''",
  ).all(sourceKey) as { chest_name: string }[];

  if (specific.length === 0) {
    const result = db.prepare(`
      UPDATE chest_records SET point_value = ?
       WHERE clan_id = ?
         AND chest_source_id IN ${sourceIdSubquery}
    `).run(newValue, clanId, ...matching);
    return result.changes;
  }

  const namePlaceholders = specific.map(() => '?').join(', ');
  const result = db.prepare(`
    UPDATE chest_records SET point_value = ?
       WHERE clan_id = ?
         AND chest_source_id IN ${sourceIdSubquery}
         AND chest_id NOT IN (
           SELECT id FROM chests WHERE name IN (${namePlaceholders})
         )
  `).run(newValue, clanId, ...matching, ...specific.map((r) => r.chest_name));
  return result.changes;
}
