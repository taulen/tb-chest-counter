import { getDb } from '../database.js';
import { childLogger } from '../../utils/logger.js';
import { cached, invalidate } from '../../utils/ttl-cache.js';
import { getDefaultPointsFor, getDefaultPointsForKey, getSourceKey, isKnownSourceKey, canonicalSourceKey } from '../../vision/source-names.js';
import { loadConfig } from '../../config/index.js';
import { currentGameDate } from '../../utils/game-day.js';
import { notifyChestDataChanged } from './chest-summary-repo.js';
import {
  buildSchedule, changedRuns, makeCacheKey, pointsAt, valueRuns, valuesOn,
  type PointEntry, type PointSchedule,
} from '../point-timeline.js';

const log = childLogger('source-points-repo');

// Source point values are PER CLAN (v86) and superadmin-managed: each clan has
// its own override table, and a clan with no override for a chest scores the
// built-in default. They were one global table from v43 to v85; v86 copied
// that table to every clan, so the clans started out identical.
//
// Since v99 a value applies FROM a game day (point-timeline.ts): the table
// holds each key's timeline, and a record scores the values of the day it was
// earned. "Current values" below means the ones in force today.
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

export { makeCacheKey, resolvePointsForKey, type OverrideWrite } from '../point-timeline.js';

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

/** Today's game day (YYYY-MM-DD) — the day a "from today on" save applies from. */
export function todayGameDay(): string {
  return currentGameDate(loadConfig().gameDayRolloverUtcHour);
}

/** Every value row of the clan — its whole timeline, oldest first. */
export function loadPointEntries(clanId: number): PointEntry[] {
  const rows = getDb().prepare(`
    SELECT source_key, chest_name, point_value, effective_from, change_id, updated_at
      FROM source_point_overrides WHERE clan_id = ?
     ORDER BY effective_from, source_key, chest_name
  `).all(clanId) as {
    source_key: string; chest_name: string; point_value: number | null;
    effective_from: string; change_id: number | null; updated_at: string;
  }[];
  return rows.map((r) => ({
    sourceKey: r.source_key,
    chestName: r.chest_name,
    from: r.effective_from,
    value: r.point_value,
    changeId: r.change_id,
    updatedAt: r.updated_at,
  }));
}

/** The clan's values as a step function of time. */
export function loadPointSchedule(clanId: number): PointSchedule {
  return buildSchedule(loadPointEntries(clanId), loadConfig().gameDayRolloverUtcHour);
}

/** The values in force today, one row per key that has one. */
export function getAllOverrides(clanId: number): SourcePointOverride[] {
  const entries = loadPointEntries(clanId);
  const today = valuesOn(entries, todayGameDay());
  const latest = new Map<string, PointEntry>();
  for (const e of entries) {
    const k = makeCacheKey(e.sourceKey, e.chestName);
    if (!today.has(k)) continue;
    const cur = latest.get(k);
    if (!cur || e.from > cur.from) latest.set(k, e);
  }
  return [...latest.values()]
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey) || a.chestName.localeCompare(b.chestName))
    .map((e, i) => ({
      id: i + 1,
      sourceKey: e.sourceKey,
      chestName: e.chestName,
      pointValue: e.value as number,
      updatedAt: e.updatedAt,
    }));
}

/**
 * The clan's values in force today, keyed on makeCacheKey(source, chest_name)
 * — what the board shows and what a save is planned against.
 */
export function loadOverrides(clanId: number): Map<string, number> {
  return valuesOn(loadPointEntries(clanId), todayGameDay());
}

/**
 * Hot-path point lookup for a scan: the values of the game day the chest was
 * earned on (`earnedAtMs`, i.e. what becomes `effective_at`), then exact
 * override → wildcard → default. Load the schedule once per scan.
 */
export function getPointsForSourceAt(
  schedule: PointSchedule,
  source: string,
  chestName: string,
  earnedAtMs: number,
): number {
  return pointsAt(schedule, source, chestName, earnedAtMs);
}

/**
 * Replace the clan's whole timeline with `entries`, then delete any dated step
 * no entry belongs to any more. Call inside the caller's transaction when
 * steps are written alongside. Records are NOT touched here; the caller
 * recalculates afterwards.
 */
export function savePointEntries(clanId: number, entries: readonly PointEntry[]): void {
  const db = getDb();
  const ins = db.prepare(`
    INSERT INTO source_point_overrides (clan_id, source_key, chest_name, point_value, effective_from, change_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    db.prepare('DELETE FROM source_point_overrides WHERE clan_id = ?').run(clanId);
    for (const e of entries) {
      ins.run(clanId, e.sourceKey, e.chestName, e.value, e.from, e.from === '' ? null : e.changeId, e.updatedAt);
    }
    db.prepare(`
      DELETE FROM source_point_changes
       WHERE clan_id = ? AND kind = 'step'
         AND NOT EXISTS (SELECT 1 FROM source_point_overrides o WHERE o.change_id = source_point_changes.id)
    `).run(clanId);
  })();
  invalidateSourceKeySummary();
}

// ─── The History view's rows (source_point_changes) ───

export type PointChangeKind = 'step' | 'correction' | 'copy';

/** One row of a change's stored lines — the board's own terms. */
export interface StoredLine {
  key: string;
  label: string;
  chestName: string;
  from: number;
  to: number;
}

export interface PointChangeRow {
  id: number;
  kind: PointChangeKind;
  /** A step's game day; '' for corrections and copies (all history). */
  effectiveFrom: string;
  /** Corrections and copies only: what they changed, as shown when saved.
   *  A step's lines are worked out from the timeline instead. */
  lines: StoredLine[];
  note: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface ChangeDbRow {
  id: number; kind: PointChangeKind; effective_from: string; lines: string; note: string;
  created_at: string; created_by: string; updated_at: string | null; updated_by: string | null;
}

function toChangeRow(r: ChangeDbRow): PointChangeRow {
  let lines: StoredLine[] = [];
  try {
    const parsed = JSON.parse(r.lines) as unknown;
    if (Array.isArray(parsed)) lines = parsed as StoredLine[];
  } catch { /* a malformed log row shows no lines */ }
  return {
    id: r.id,
    kind: r.kind,
    effectiveFrom: r.effective_from,
    lines,
    note: r.note,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

/** The clan's history rows: dated steps newest day first, then the log newest first. */
export function listPointChanges(clanId: number): PointChangeRow[] {
  const rows = getDb().prepare(`
    SELECT * FROM source_point_changes WHERE clan_id = ?
     ORDER BY kind = 'step' DESC, effective_from DESC, created_at DESC, id DESC
  `).all(clanId) as ChangeDbRow[];
  return rows.map(toChangeRow);
}

export function getPointChange(clanId: number, id: number): PointChangeRow | null {
  const row = getDb().prepare('SELECT * FROM source_point_changes WHERE clan_id = ? AND id = ?').get(clanId, id) as ChangeDbRow | undefined;
  return row ? toChangeRow(row) : null;
}

/**
 * The step for `day`, created if the clan has none yet. A second save on the
 * same day joins the first: the note is replaced only when a new one is given.
 */
export function upsertStep(clanId: number, day: string, user: string, note: string, now: string): number {
  const db = getDb();
  const existing = db.prepare(
    "SELECT id FROM source_point_changes WHERE clan_id = ? AND kind = 'step' AND effective_from = ?",
  ).get(clanId, day) as { id: number } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE source_point_changes
         SET updated_at = ?, updated_by = ?, note = CASE WHEN ? != '' THEN ? ELSE note END
       WHERE id = ?
    `).run(now, user, note, note, existing.id);
    return existing.id;
  }
  return (db.prepare(`
    INSERT INTO source_point_changes (clan_id, kind, effective_from, note, created_at, created_by)
    VALUES (?, 'step', ?, ?, ?, ?) RETURNING id
  `).get(clanId, day, note, now, user) as { id: number }).id;
}

/** Move a step to another day and/or change its note. */
export function updateStep(id: number, day: string, note: string, user: string, now: string): void {
  getDb().prepare(
    'UPDATE source_point_changes SET effective_from = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?',
  ).run(day, note, now, user, id);
}

/** Log a correction to all history, or a copy, with the lines it changed. */
export function insertPointLog(
  clanId: number, kind: 'correction' | 'copy', lines: StoredLine[], note: string, user: string, now: string,
): number {
  return (getDb().prepare(`
    INSERT INTO source_point_changes (clan_id, kind, effective_from, lines, note, created_at, created_by)
    VALUES (?, ?, '', ?, ?, ?, ?) RETURNING id
  `).get(clanId, kind, JSON.stringify(lines), note, now, user) as { id: number }).id;
}

/**
 * Recalculate one clan's chest_records.point_value from its timeline: each
 * record gets the value in force on the game day it was earned. Another clan's
 * records are never touched: its values are its own.
 *
 * `onlyCanonKeys` limits the pass to sources whose canonical key is in the
 * set — what a save uses, so it rewrites exactly the sources it changed.
 * Returns the number of rows whose value actually changed.
 */
export function recalculatePoints(clanId: number, onlyCanonKeys?: ReadonlySet<string>): number {
  const schedule = loadPointSchedule(clanId);
  const updated = rewriteRecords(clanId, (key, chest) => valueRuns(schedule, key, chest), onlyCanonKeys);
  log.info(`Recalculated point values for clan ${clanId}: ${updated} rows updated`);
  invalidateSourceKeySummary();
  return updated;
}

/**
 * Carry a dated change into the stored records: a record whose value under
 * the timeline `next` differs from its value under `prev` gets the `next`
 * one, and nothing else is touched — not even a record that was already out
 * of line before, which only Recalculate (or a correction to all history)
 * rewrites. That is what keeps a dated change off the days it doesn't cover.
 */
export function applyTimelineChange(
  clanId: number, prev: PointSchedule, next: PointSchedule, onlyCanonKeys?: ReadonlySet<string>,
): number {
  const updated = rewriteRecords(clanId, (key, chest) => changedRuns(prev, next, key, chest), onlyCanonKeys);
  log.info(`Applied a dated points change for clan ${clanId}: ${updated} rows updated`);
  invalidateSourceKeySummary();
  return updated;
}

/**
 * Rewrite one clan's chest_records.point_value. Groups by (source_key,
 * chest_name), and `runsFor` says which stretches of time to write and with
 * what value — one UPDATE each, a single one for a pair no dated change
 * touches. Notifies the daily-summary rollup when rows actually changed.
 */
function rewriteRecords(
  clanId: number,
  runsFor: (key: string, chestName: string) => { from: number; to: number; value: number }[],
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
      // Resolve string source/name values to their FK ids and UPDATE on
      // those — the chest_source / chest_name columns no longer exist on
      // chest_records post-D3 (they live in the chest_sources / chests
      // reference tables now). `point_value != ?` keeps the count honest:
      // SQLite counts a row rewritten to the value it already held.
      const placeholders = group.sources.map(() => '?').join(', ');
      for (const run of runsFor(group.sourceKey, group.chestName)) {
        const range: string[] = [];
        const rangeArgs: number[] = [];
        if (run.from > 0) { range.push('AND effective_at >= ?'); rangeArgs.push(run.from); }
        if (Number.isFinite(run.to)) { range.push('AND effective_at < ?'); rangeArgs.push(run.to); }
        const result = db.prepare(`
          UPDATE chest_records
             SET point_value = ?
           WHERE clan_id = ?
             AND chest_source_id IN (
               SELECT id FROM chest_sources WHERE source IN (${placeholders})
             )
             AND chest_id = (SELECT id FROM chests WHERE name = ?)
             AND point_value != ?
             ${range.join(' ')}
        `).run(run.value, clanId, ...group.sources, group.chestName, run.value, ...rangeArgs);
        totalUpdated += result.changes;
      }
    }
  });
  tx();
  if (totalUpdated > 0) notifyChestDataChanged(clanId);
  return totalUpdated;
}

