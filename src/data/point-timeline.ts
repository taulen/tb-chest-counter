/**
 * Chest point values over time (v99) — the pure half: no database here.
 * See docs/chest-points-history.md for the rules this implements.
 *
 * A clan's values are a list of entries. Each says "for this (source key,
 * chest name), from game day `from` on, the value is `value`". `from` '' means
 * all history, and `value` null means "from that day on, no value of its own"
 * (the chest falls back to the source value, then the built-in default). The
 * value in force on a day is the latest entry dated on or before it.
 *
 * A chest record is scored with the values of the game day it was EARNED on
 * (`effective_at`, the clock every ranking buckets by), so changing a value
 * from a date never moves a record from before that date.
 */
import {
  canonicalSourceKey, getDefaultPointsFor, getDefaultPointsForKey, getSourceKey, SOURCE_CHEST_POINTS,
} from '../vision/source-names.js';

export interface PointEntry {
  sourceKey: string;
  /** '' = the source-wide value (every chest without one of its own). */
  chestName: string;
  /** '' = all history; otherwise the game day (YYYY-MM-DD) it applies from. */
  from: string;
  /** null = from this day on, the key holds no value of its own. */
  value: number | null;
  /** The dated step this entry belongs to (source_point_changes.id); null for all-history values. */
  changeId: number | null;
  updatedAt: string;
}

/** One value to write: `points: null` removes it. `chestName: ''` is the source-wide value. */
export interface OverrideWrite {
  sourceKey: string;
  chestName: string;
  points: number | null;
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

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form. */
export function isGameDay(day: unknown): day is string {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/** First instant (epoch ms) of game day `day`; 0 for '' (all history). */
export function dayStartMs(day: string, rolloverUtcHour: number): number {
  if (day === '') return 0;
  return Date.parse(`${day}T00:00:00Z`) + rolloverUtcHour * 3_600_000;
}

/**
 * The values in force on game day `day`: per key, the latest entry dated on or
 * before it (strictly before it with `before`). A null entry removes the key.
 */
export function valuesOn(entries: readonly PointEntry[], day: string, { before = false } = {}): Map<string, number> {
  const latest = new Map<string, PointEntry>();
  for (const e of entries) {
    if (before ? e.from >= day : e.from > day) continue;
    const k = makeCacheKey(e.sourceKey, e.chestName);
    const cur = latest.get(k);
    if (!cur || e.from > cur.from) latest.set(k, e);
  }
  const map = new Map<string, number>();
  for (const [k, e] of latest) if (e.value !== null) map.set(k, e.value);
  return map;
}

/**
 * The values as a step function of time: one segment per day an entry starts
 * on. Built once per scan, board or recalculation.
 */
export interface PointSchedule {
  /** Game day each segment starts on, ascending; the first is '' (all history). */
  days: string[];
  /** Instant (epoch ms) each segment starts at; 0 for the first. */
  starts: number[];
  /** The values in force through each segment. */
  values: Map<string, number>[];
}

export function buildSchedule(entries: readonly PointEntry[], rolloverUtcHour: number): PointSchedule {
  const dated = [...new Set(entries.map((e) => e.from).filter((d) => d !== ''))].sort();
  const days = ['', ...dated];
  return {
    days,
    starts: days.map((d) => dayStartMs(d, rolloverUtcHour)),
    values: days.map((d) => valuesOn(entries, d)),
  };
}

/** Index of the segment holding instant `ms`. */
export function segmentAt(schedule: PointSchedule, ms: number): number {
  let lo = 0;
  let hi = schedule.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (schedule.starts[mid] <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The values in force at instant `ms`. */
export function valuesAt(schedule: PointSchedule, ms: number): Map<string, number> {
  return schedule.values[segmentAt(schedule, ms)];
}

/** The values in force now — what the board shows. No entry is dated after today. */
export function currentValues(schedule: PointSchedule): Map<string, number> {
  return schedule.values[schedule.values.length - 1];
}

/** What a chest from `source` earned at `ms` scores. */
export function pointsAt(schedule: PointSchedule, source: string, chestName: string, ms: number): number {
  const key = getSourceKey(source);
  if (!key) return 0;
  return resolvePointsForKey(valuesAt(schedule, ms), key, chestName);
}

/**
 * The value a (key, chest) scores in each stretch of time, adjacent equal
 * stretches merged: [{ from, to, value }] with `to` exclusive (Infinity for the
 * last). Most keys have one run; a dated change splits it.
 */
export function valueRuns(schedule: PointSchedule, key: string, chestName: string): { from: number; to: number; value: number }[] {
  const runs: { from: number; to: number; value: number }[] = [];
  schedule.values.forEach((values, i) => {
    const value = resolvePointsForKey(values, key, chestName);
    const last = runs[runs.length - 1];
    if (last && last.value === value) return;
    if (last) last.to = schedule.starts[i];
    runs.push({ from: schedule.starts[i], to: Infinity, value });
  });
  return runs;
}

/** Sources whose built-in defaults pay some chests their own rate. */
const SEEDED_PER_CHEST = new Set(Object.keys(SOURCE_CHEST_POINTS).map(canonicalSourceKey));

/**
 * What "no entry" means for a key, as a number when that is exact: a
 * source-wide value with no per-chest defaults under it falls back to the one
 * source default. Anything else falls through to layers that can change on
 * their own, so "no entry" is only equal to itself (null).
 */
function implicitValue(sourceKey: string, chestName: string): number | null {
  if (chestName !== '' || SEEDED_PER_CHEST.has(canonicalSourceKey(sourceKey))) return null;
  return getDefaultPointsForKey(sourceKey);
}

/**
 * The stretches of time in which a (key, chest) scores differently under
 * `next` than under `prev`, with the `next` value: [{ from, to, value }], `to`
 * exclusive. What a dated change moves — and nothing else, so a record it
 * doesn't cover keeps whatever it holds, even a value already out of line.
 */
export function changedRuns(
  prev: PointSchedule, next: PointSchedule, key: string, chestName: string,
): { from: number; to: number; value: number }[] {
  const starts = [...new Set([...prev.starts, ...next.starts])].sort((a, b) => a - b);
  const runs: { from: number; to: number; value: number }[] = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : Infinity;
    const before = resolvePointsForKey(valuesAt(prev, start), key, chestName);
    const after = resolvePointsForKey(valuesAt(next, start), key, chestName);
    if (before === after) return;
    const last = runs[runs.length - 1];
    if (last && last.to === start && last.value === after) {
      last.to = end;
      return;
    }
    runs.push({ from: start, to: end, value: after });
  });
  return runs;
}

const sameKey = (a: { sourceKey: string; chestName: string }, canon: string, chestName: string): boolean =>
  a.chestName === chestName && canonicalSourceKey(a.sourceKey) === canon;

/**
 * Drop dated entries that only repeat the value in force the day before (null
 * and "no entry" are the same thing, and so is a source-wide value equal to a
 * default nothing else overrides). All-history entries always stay: an
 * explicit value outranks a per-chest default even when the numbers match.
 */
export function collapseRepeats(entries: readonly PointEntry[]): PointEntry[] {
  const byKey = new Map<string, PointEntry[]>();
  for (const e of entries) {
    const k = makeCacheKey(e.sourceKey, e.chestName);
    const list = byKey.get(k) ?? [];
    list.push(e);
    byKey.set(k, list);
  }
  const keep = new Set<PointEntry>();
  for (const list of byKey.values()) {
    list.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    const implicit = implicitValue(list[0].sourceKey, list[0].chestName);
    const effective = (v: number | null): number | null => v ?? implicit;
    let prev: number | null = null;
    for (const e of list) {
      if (e.from === '' || effective(e.value) !== effective(prev)) keep.add(e);
      prev = e.value;
    }
  }
  return entries.filter((e) => keep.has(e));
}

/**
 * The entries after `writes` are saved on `day`.
 *
 * - '' (all history): each key's whole timeline is replaced — every dated
 *   value for it goes, and the new value (if any) holds for all history.
 * - A date: the key's value from that day on. A value already saved for that
 *   day is replaced; one that only repeats the value in force the day before
 *   is dropped, so setting a value back leaves nothing behind.
 */
export function applyWrites(
  entries: readonly PointEntry[],
  day: string,
  writes: readonly OverrideWrite[],
  changeId: number | null,
  now: string,
): PointEntry[] {
  let next = [...entries];
  for (const w of writes) {
    const canon = canonicalSourceKey(w.sourceKey);
    if (day === '') {
      next = next.filter((e) => !sameKey(e, canon, w.chestName));
      if (w.points !== null) {
        next.push({ sourceKey: w.sourceKey, chestName: w.chestName, from: '', value: w.points, changeId: null, updatedAt: now });
      }
      continue;
    }
    next = next.filter((e) => !(sameKey(e, canon, w.chestName) && e.from === day));
    next.push({ sourceKey: w.sourceKey, chestName: w.chestName, from: day, value: w.points, changeId, updatedAt: now });
  }
  return collapseRepeats(next);
}
