/**
 * The Chest Points admin board: one line per chest SOURCE with the value it
 * pays, instead of one line per (source, chest name) with a default and an
 * override each.
 *
 * Why a source is the unit. 90 of the ~100 sources seen in production pay every
 * chest they drop the same amount — a Level 25 epic crypt is 450 whichever of
 * its seventeen chests you get — so listing chests made a 369-row page whose
 * information was ~100 numbers. The few sources that genuinely pay chests
 * differently (the three omen chests, a citadel's cursed chest) show
 * their odd ones out as exceptions under the source line.
 *
 * What the board shows is the EFFECTIVE value, never the layer it came from.
 * The storage keeps its three layers (exact override → wildcard override →
 * seeded default, see resolvePointsForKey), but which layer holds a number is
 * an implementation detail an admin should not have to reason about — so a
 * save is expressed as a target state ("this source pays 50, except the Epic
 * Omen Chest at 150") and planChanges works out the override rows that produce it.
 *
 * Every write is previewed first: previewPointChanges / previewRecalculate
 * compute exactly which stored chest_records values would move, and by how
 * much, through the same resolver the write uses. Nothing is lost by a wrong
 * save, but a save nobody can check before making is how values drift.
 *
 * The board is one clan's: each clan has its own values (v86), so its record
 * counts, its previews and its saves all stay inside that clan. The sources it
 * lists are every clan's, so a value can be set before the first chest lands.
 *
 * Values have a history (v99, docs/chest-points-history.md). The board shows
 * and edits the values in force TODAY; a save applies them either from today's
 * game day on (a dated step — earlier chests keep their points) or to all
 * history (a correction — every record is rescored). The History view lists
 * the steps, and a step can be moved, re-valued or removed, each previewed the
 * same way a save is.
 */
import { getDb } from './database.js';
import { cached } from '../utils/ttl-cache.js';
import { loadConfig } from '../config/index.js';
import { getClanById } from './repositories/clan-repo.js';
import {
  getAllOverrides, loadPointEntries, savePointEntries, recalculatePoints, applyTimelineChange, todayGameDay,
  upsertStep, updateStep, insertPointLog, listPointChanges, getPointChange,
} from './repositories/source-points-repo.js';
import {
  applyWrites, buildSchedule, collapseRepeats, currentValues, dayStartMs, isGameDay, makeCacheKey,
  resolvePointsForKey, valuesAt, valuesOn,
  type OverrideWrite, type PointEntry, type PointSchedule,
} from './point-timeline.js';
import {
  canonicalSourceKey, getSourceKey, getDefaultPointsFor, hasDefaultPointsFor, parseSourceLevelRange,
  SOURCE_CHEST_POINTS, SOURCE_POINT_KEYS,
} from '../vision/source-names.js';
import { SOURCE_CATEGORIES, sourceCategory, type SourceCategory } from './source-categories.js';

/** Largest value a save accepts — the biggest real one is 10,000. */
export const MAX_POINTS = 1_000_000;

// Under the summary's prefix on purpose: invalidateSourceKeySummary() drops by
// prefix, so every site that already invalidates the summary (scan completion,
// reassignment, override writes) refreshes the board too.
const BOARD_CACHE_KEY = 'sourceKeySummary:board';
const BOARD_TTL_MS = 300000;

export interface BoardChest {
  name: string;
  records: number;
  points: number;
  /** Scores 0 because nothing — override or built-in — gives it a value. */
  unset: boolean;
}

export interface BoardSource {
  /** Source key as stored in overrides; what a change addresses. */
  key: string;
  /** Readable name: "Epic Crypt · Level 25", or the in-game text. */
  label: string;
  /** The most common in-game spelling, for search and hover. */
  source: string;
  category: SourceCategory;
  records: number;
  /** What the source pays — the value most of its chest records score. */
  points: number;
  /** Every chest seen from this source, by name. Those whose points differ
   *  from the source's are its exceptions. */
  chests: BoardChest[];
  unset: boolean;
  /** Records whose stored value no longer matches the current one. */
  staleRecords: number;
  /** The board group this source is shown under (see SOURCE_GROUPS), or null. */
  group: string | null;
}

/**
 * Several sources shown — and set — as one row. Purely presentation: every
 * member keeps its own key, overrides and stored values, so a group can be
 * redrawn without touching scoring.
 */
export interface BoardGroup {
  id: string;
  label: string;
  category: SourceCategory;
}

export interface PointsBoard {
  /** The clan these values belong to. A save names it back, so an edit made on
   *  one clan's board can never land on another's. */
  clan: { id: number; name: string };
  categories: { key: SourceCategory; title: string; sources: number; unset: number }[];
  sources: BoardSource[];
  groups: BoardGroup[];
  staleRecords: number;
  /** Today's game day — the day a "from today on" save applies from. */
  today: string;
  /** Dated changes in the clan's history (the History view's steps). */
  historySteps: number;
}

/**
 * Heroic monsters are one source per level, but the game pays them by tier, so
 * thirty rows of mostly repeated numbers read better as six. The ranges are
 * the admins' own tiers. A level outside every range (the game adding level
 * 46) stays a row of its own rather than vanishing into a neighbour.
 */
const HEROIC_TIERS: readonly [number, number][] = [
  [16, 19], [20, 24], [25, 29], [30, 35], [36, 40], [41, 45],
];

function sourceGroup(key: string, category: SourceCategory): BoardGroup | null {
  if (category !== 'heroic') return null;
  const level = Number(/(\d+)/.exec(key)?.[1]);
  const tier = HEROIC_TIERS.find(([from, to]) => level >= from && level <= to);
  if (!tier) return null;
  return { id: `heroic-${tier[0]}-${tier[1]}`, label: `Heroic Monster · Level ${tier[0]}–${tier[1]}`, category };
}

export interface PointChange {
  sourceKey: string;
  /** '' = the source's own value (every chest paying it). */
  chestName: string;
  points: number;
}

/** One line of "what this save changes", in the board's own terms. */
export interface PlannedEdit {
  key: string;
  label: string;
  chestName: string;
  from: number;
  to: number;
}

/**
 * Records of one source that all move to the same value. One line per
 * (source, new value) rather than per chest: a source-wide change moves a
 * dozen crypt chests together, and twelve identical lines hide the one that
 * matters.
 */
export interface ImpactLine {
  key: string;
  label: string;
  /** The chests moving, most records first. */
  chests: string[];
  records: number;
  /** Distinct values those records hold today — usually one. */
  from: number[];
  to: number;
  delta: number;
}

export interface PointsImpact {
  records: number;
  delta: number;
  clans: { id: number; name: string; records: number; delta: number }[];
  lines: ImpactLine[];
  /** Lines left out of `lines` to keep the payload small. */
  moreLines: number;
}

/** A change request the board can't place — surfaced as a 400. */
export class PointsChangeError extends Error {}

const IMPACT_LINE_LIMIT = 60;

interface RecordGroup {
  clanId: number;
  source: string;
  key: string;
  canon: string;
  chestName: string;
  stored: number;
  count: number;
  /** Start (epoch ms) of the stretch of time these records were earned in; 0
   *  for the first. Within a stretch no value changes, so resolving at `at`
   *  is resolving every record of the group. */
  at: number;
}

/** Every segment start of the given schedules (plus extra instants), the cuts
 *  a set of record groups must be split at for all of them to resolve exactly. */
function cutsOf(schedules: PointSchedule[], extra: number[] = []): number[] {
  return [...new Set([...schedules.flatMap((s) => s.starts), ...extra])]
    .filter((c) => c > 0 && Number.isSafeInteger(c))
    .sort((a, b) => a - b);
}

/**
 * One clan's chest_records grouped down to (source, chest, stored value) — the
 * same rows recalculatePoints walks, so a preview counts exactly what a write
 * would touch — and split at `cuts`: the days a value changes on, so each
 * group sits inside one stretch of constant values.
 */
function loadRecordGroups(clanId: number, cuts: readonly number[] = []): RecordGroup[] {
  // The cuts are integers this module computed, never request input.
  const seg = cuts.length === 0
    ? '0'
    : `CASE ${cuts.map((c, i) => `WHEN cr.effective_at < ${Math.trunc(c)} THEN ${i}`).join(' ')} ELSE ${cuts.length} END`;
  const rows = getDb().prepare(`
    SELECT cr.clan_id, cs.source, ch.name AS chest_name, cr.point_value, ${seg} AS seg, COUNT(*) AS cnt
      FROM chest_records cr
      JOIN chest_sources cs ON cs.id = cr.chest_source_id
      JOIN chests ch ON ch.id = cr.chest_id
     WHERE cr.clan_id = ? AND cs.source != ''
     GROUP BY cr.clan_id, cr.chest_source_id, cr.chest_id, cr.point_value, seg
  `).all(clanId) as { clan_id: number; source: string; chest_name: string; point_value: number; seg: number; cnt: number }[];

  const keyOf = new Map<string, string | null>();
  const groups: RecordGroup[] = [];
  for (const r of rows) {
    let key = keyOf.get(r.source);
    if (key === undefined) {
      key = getSourceKey(r.source);
      keyOf.set(r.source, key);
    }
    if (!key) continue;
    groups.push({
      clanId: r.clan_id,
      source: r.source,
      key,
      canon: canonicalSourceKey(key),
      chestName: r.chest_name,
      stored: r.point_value,
      count: r.cnt,
      at: r.seg === 0 ? 0 : cuts[r.seg - 1],
    });
  }
  return groups;
}

/**
 * Every source and chest the app knows of, as zero-count groups: whatever any
 * live clan has recorded, plus the built-in default tables and every live
 * clan's saved values. A clan can only score what it has seen, but it needs to
 * value a source before its first chest arrives — a clan added mid-month would
 * otherwise see no event, tournament or Tartaros row until that chest had
 * already been scored. Counts, previews and saves stay the board clan's own.
 *
 * chestName '' = a source known with no chest name (a flat default, or a
 * source-wide value): it gets a row, but no chest under it.
 */
function loadKnownGroups(clanId: number): RecordGroup[] {
  const db = getDb();
  const recorded = db.prepare(`
    SELECT DISTINCT cs.source, ch.name AS chest_name
      FROM chest_records cr
      JOIN clans c ON c.id = cr.clan_id AND c.deleted_at = ''
      JOIN chest_sources cs ON cs.id = cr.chest_source_id
      JOIN chests ch ON ch.id = cr.chest_id
     WHERE cs.source != ''
  `).all() as { source: string; chest_name: string }[];
  const saved = db.prepare(`
    SELECT DISTINCT o.source_key, o.chest_name
      FROM source_point_overrides o
      JOIN clans c ON c.id = o.clan_id AND c.deleted_at = ''
  `).all() as { source_key: string; chest_name: string }[];

  const groups: RecordGroup[] = [];
  const add = (source: string, key: string, chestName: string): void => {
    groups.push({ clanId, source, key, canon: canonicalSourceKey(key), chestName, stored: 0, count: 0, at: 0 });
  };
  for (const r of recorded) {
    const key = getSourceKey(r.source);
    if (key) add(r.source, key, r.chest_name);
  }
  for (const key of SOURCE_POINT_KEYS) add('', key, '');
  for (const [key, chests] of Object.entries(SOURCE_CHEST_POINTS)) {
    for (const name of Object.keys(chests)) add('', key, name);
  }
  for (const o of saved) add('', o.source_key, o.chest_name);
  return groups;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * The structured families get a name built from the key, because the game's
 * own strings for them are inconsistent ("Level 25 Crypt", "Lvl 25-29 Vault of
 * the Ancients", "Level 45 Vault of the Ancients"). Everything else is shown as
 * the game spells it.
 */
function sourceLabel(key: string, category: SourceCategory, sample: string): string {
  let m = /^(common|rare|epic|tartaros) (\d+)$/.exec(key);
  if (m) return `${titleCase(m[1])} Crypt · Level ${m[2]}`;
  m = /^(elven|cursed) citadel (\d+)$/.exec(key);
  if (m) return `${m[1] === 'cursed' ? 'Cursed Citadel' : 'Citadel'} · Level ${m[2]}`;
  if (category === 'heroic') {
    const level = /(\d+)/.exec(key)?.[1];
    return level ? `Heroic Monster · Level ${level}` : 'Heroic Monster';
  }
  if (category === 'runic' || category === 'vault') {
    const name = category === 'runic' ? 'Raid Runic Squad' : 'Vault of the Ancients';
    // A key known only from the tables has no in-game text: "lvl 20 24 raid runic squad".
    const fromKey = /(\d+)(?: (\d+))?/.exec(key);
    const range = parseSourceLevelRange(sample)
      ?? (fromKey ? (fromKey[2] ? `${fromKey[1]}-${fromKey[2]}` : fromKey[1]) : undefined);
    return range ? `${name} · Level ${range.replace('-', '–')}` : name;
  }
  // Keys flatten an apostrophe to a space: "azada s shop" is Azada's Shop.
  return sample || titleCase(key).replace(/ S\b/g, '\'s');
}

/** Order within a category: crypt tier / citadel kind first, then the label. */
function sortRank(key: string): number {
  if (/^tartaros \d+$/.test(key)) return 3;
  if (/^rare \d+$/.test(key)) return 1;
  if (/^epic \d+$/.test(key)) return 2;
  if (/^cursed citadel \d+$/.test(key)) return 1;
  return 0;
}

/** The value most records score; ties go to the value more chests share, then the lower. */
function majorityPoints(chests: BoardChest[]): number {
  const byValue = new Map<number, { records: number; chests: number }>();
  for (const c of chests) {
    const v = byValue.get(c.points) ?? { records: 0, chests: 0 };
    v.records += c.records;
    v.chests += 1;
    byValue.set(c.points, v);
  }
  let best: [number, { records: number; chests: number }] | null = null;
  for (const entry of byValue) {
    if (!best
      || entry[1].records > best[1].records
      || (entry[1].records === best[1].records && entry[1].chests > best[1].chests)
      || (entry[1].records === best[1].records && entry[1].chests === best[1].chests && entry[0] < best[0])) {
      best = entry;
    }
  }
  return best ? best[0] : 0;
}

/** What a source pays: its chests' majority, or — known only by key (a default
 *  or a saved value, no chest name yet) — its source-wide value. */
function sourcePoints(chests: BoardChest[], overrides: Map<string, number>, key: string): number {
  return chests.length > 0 ? majorityPoints(chests) : resolvePointsForKey(overrides, key, '');
}

interface BoardOptions {
  /** The timeline stored records are checked against for "out of date" —
   *  each record against the values of its own day. Omitted: not counted. */
  stale?: PointSchedule;
  /** loadKnownGroups(clanId), for a caller building several boards. */
  known?: RecordGroup[];
  today?: string;
  historySteps?: number;
}

/**
 * The board with `overrides` as its values — today's for the page, a past
 * day's when a dated step is planned or described.
 */
function buildBoard(clanId: number, groups: RecordGroup[], overrides: Map<string, number>, opts: BoardOptions = {}): PointsBoard {
  const overridden = new Set(overrides.keys());

  interface Stored { at: number; value: number; count: number }
  interface Bucket {
    keys: Map<string, number>;
    sources: Map<string, number>;
    chests: Map<string, Stored[]>;
  }
  // One bucket per CANONICAL key: a source read with and without spaces is
  // one source, scored by one set of overrides.
  const buckets = new Map<string, Bucket>();
  for (const g of [...groups, ...(opts.known ?? loadKnownGroups(clanId))]) {
    let b = buckets.get(g.canon);
    if (!b) {
      b = { keys: new Map(), sources: new Map(), chests: new Map() };
      buckets.set(g.canon, b);
    }
    b.keys.set(g.key, (b.keys.get(g.key) ?? 0) + g.count);
    if (g.source) b.sources.set(g.source, (b.sources.get(g.source) ?? 0) + g.count);
    if (!g.chestName) continue;
    const stored = b.chests.get(g.chestName) ?? [];
    // A chest only another clan has recorded: listed, with nothing stored.
    if (g.count > 0) stored.push({ at: g.at, value: g.stored, count: g.count });
    b.chests.set(g.chestName, stored);
  }

  const mostCommon = (m: Map<string, number>): string =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';

  const sources: (BoardSource & { rank: number })[] = [];
  let staleTotal = 0;
  for (const [canon, b] of buckets) {
    // The spaced spelling of a key is the readable one; prefer it.
    const key = [...b.keys.entries()]
      .sort((a, c) => c[0].split(' ').length - a[0].split(' ').length || c[1] - a[1])[0][0];
    const sample = mostCommon(b.sources);
    const wildcardSet = overridden.has(`${canon}\t`);
    let records = 0;
    let stale = 0;
    const chests: BoardChest[] = [];
    for (const [name, stored] of b.chests) {
      const points = resolvePointsForKey(overrides, key, name);
      let n = 0;
      for (const s of stored) {
        n += s.count;
        if (opts.stale && s.value !== resolvePointsForKey(valuesAt(opts.stale, s.at), key, name)) stale += s.count;
      }
      records += n;
      chests.push({
        name,
        records: n,
        points,
        unset: points === 0 && !wildcardSet && !overridden.has(`${canon}\t${name}`) && !hasDefaultPointsFor(key, name),
      });
    }
    chests.sort((a, c) => collator.compare(a.name, c.name));
    const category = sourceCategory(key);
    const label = sourceLabel(key, category, sample);
    const points = sourcePoints(chests, overrides, key);
    staleTotal += stale;
    sources.push({
      key,
      label,
      source: sample || label,
      category,
      records,
      points,
      chests,
      unset: chests.length > 0
        ? chests.some((c) => c.unset)
        : points === 0 && !wildcardSet && !hasDefaultPointsFor(key, ''),
      staleRecords: stale,
      group: sourceGroup(key, category)?.id ?? null,
      rank: sortRank(key),
    });
  }

  const order = new Map(SOURCE_CATEGORIES.map((c, i) => [c.key, i]));
  sources.sort((a, b) =>
    (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99)
    || a.rank - b.rank
    || collator.compare(a.label, b.label));

  const categories = SOURCE_CATEGORIES
    .map((c) => {
      const inCat = sources.filter((s) => s.category === c.key);
      return { key: c.key, title: c.title, sources: inCat.length, unset: inCat.filter((s) => s.unset).length };
    })
    .filter((c) => c.sources > 0);

  // In board order: a group sits where its first member would.
  const boardGroups = new Map<string, BoardGroup>();
  for (const s of sources) {
    const g = sourceGroup(s.key, s.category);
    if (g && !boardGroups.has(g.id)) boardGroups.set(g.id, g);
  }

  return {
    clan: { id: clanId, name: getClanById(clanId)?.name ?? `Clan #${clanId}` },
    categories,
    sources: sources.map(({ rank: _rank, ...s }) => s),
    groups: [...boardGroups.values()],
    staleRecords: staleTotal,
    today: opts.today ?? todayGameDay(),
    historySteps: opts.historySteps ?? 0,
  };
}

/** Everything a read or write of one clan's values starts from. */
interface Ctx {
  clanId: number;
  entries: PointEntry[];
  schedule: PointSchedule;
  rollover: number;
  /** Today's game day, and the instant it started. */
  today: string;
  todayStart: number;
  steps: number;
}

function context(clanId: number): Ctx {
  const rollover = loadConfig().gameDayRolloverUtcHour;
  const entries = loadPointEntries(clanId);
  const today = todayGameDay();
  return {
    clanId,
    entries,
    schedule: buildSchedule(entries, rollover),
    rollover,
    today,
    todayStart: dayStartMs(today, rollover),
    steps: listPointChanges(clanId).filter((c) => c.kind === 'step').length,
  };
}

/** Today's board, out-of-date counts checked against each record's own day. */
function currentBoard(ctx: Ctx, groups: RecordGroup[], known?: RecordGroup[]): PointsBoard {
  return buildBoard(ctx.clanId, groups, currentValues(ctx.schedule), {
    stale: ctx.schedule, known, today: ctx.today, historySteps: ctx.steps,
  });
}

/** One clan's board as the admin page reads it. Cached; every write invalidates it. */
export function getPointsBoard(clanId: number): PointsBoard {
  return cached(`${BOARD_CACHE_KEY}:${clanId}`, BOARD_TTL_MS, () => {
    const ctx = context(clanId);
    return currentBoard(ctx, loadRecordGroups(clanId, cutsOf([ctx.schedule])));
  });
}

/**
 * What re-resolving every record under `next` would change — each record with
 * the values of its own day: per clan, and per (source, new value), largest
 * point swing first. `groups` must be cut at every segment start of `next`
 * (and of `prev`).
 *
 * With `prev` — a dated change — only records whose value differs between the
 * two timelines count, exactly as applyTimelineChange writes them; a record
 * that was already out of line elsewhere is left alone. Without it — a
 * correction, a copy, Recalculate — every record off its value counts.
 */
function computeImpact(
  groups: RecordGroup[],
  next: PointSchedule,
  board: PointsBoard,
  onlyCanon?: ReadonlySet<string>,
  prev?: PointSchedule,
): PointsImpact {
  const labels = new Map(board.sources.map((s) => [canonicalSourceKey(s.key), s]));
  const clanNames = new Map([[board.clan.id, board.clan.name]]);
  const clans = new Map<number, { records: number; delta: number }>();
  const lines = new Map<string, ImpactLine & { fromSet: Set<number>; chestRecords: Map<string, number> }>();
  let records = 0;
  let delta = 0;

  for (const g of groups) {
    if (onlyCanon && !onlyCanon.has(g.canon)) continue;
    const to = resolvePointsForKey(valuesAt(next, g.at), g.key, g.chestName);
    if (to === g.stored) continue;
    if (prev && resolvePointsForKey(valuesAt(prev, g.at), g.key, g.chestName) === to) continue;
    const d = (to - g.stored) * g.count;
    records += g.count;
    delta += d;
    const clan = clans.get(g.clanId) ?? { records: 0, delta: 0 };
    clan.records += g.count;
    clan.delta += d;
    clans.set(g.clanId, clan);

    const id = `${g.canon}\t${to}`;
    let line = lines.get(id);
    if (!line) {
      const src = labels.get(g.canon);
      line = {
        key: src?.key ?? g.key,
        label: src?.label ?? g.source,
        chests: [],
        records: 0,
        from: [],
        to,
        delta: 0,
        fromSet: new Set(),
        chestRecords: new Map(),
      };
      lines.set(id, line);
    }
    line.records += g.count;
    line.delta += d;
    line.fromSet.add(g.stored);
    line.chestRecords.set(g.chestName, (line.chestRecords.get(g.chestName) ?? 0) + g.count);
  }

  const sorted = [...lines.values()]
    .map(({ fromSet, chestRecords, ...l }) => ({
      ...l,
      from: [...fromSet].sort((a, b) => a - b),
      chests: [...chestRecords.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.records - a.records || collator.compare(a.label, b.label));

  return {
    records,
    delta,
    clans: [...clans.entries()]
      .map(([id, c]) => ({ id, name: clanNames.get(id) ?? `Clan #${id}`, ...c }))
      .sort((a, b) => a.id - b.id),
    lines: sorted.slice(0, IMPACT_LINE_LIMIT),
    moreLines: Math.max(0, sorted.length - IMPACT_LINE_LIMIT),
  };
}

function validPoints(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_POINTS;
}

/**
 * Turn the board-level target state into override rows.
 *
 * A source-level change means "every chest paying the source's value now pays
 * v, and so does any chest this source drops in future": it sets the wildcard
 * and lets those chests fall through to it. The source's exceptions keep their
 * values — pinned with an exact row where the new wildcard would otherwise
 * swallow them (a value that came from the old wildcard or from a per-chest
 * seed, which the wildcard outranks). A chest-level change pins that chest.
 * Any exact row that would only restate what the chest resolves to anyway is
 * removed, so the table converges on the fewest rows that say the same thing.
 */
function planChanges(board: PointsBoard, overrides: Map<string, number>, changes: PointChange[]) {
  const byCanon = new Map(board.sources.map((s) => [canonicalSourceKey(s.key), s]));
  const perSource = new Map<string, PointChange[]>();
  for (const c of changes) {
    if (!c || typeof c.sourceKey !== 'string' || typeof c.chestName !== 'string') {
      throw new PointsChangeError('Each change needs a sourceKey and a chestName');
    }
    if (!validPoints(c.points)) {
      throw new PointsChangeError(`Points must be a whole number from 0 to ${MAX_POINTS.toLocaleString('en')}`);
    }
    const canon = canonicalSourceKey(c.sourceKey);
    if (!byCanon.has(canon)) throw new PointsChangeError(`Unknown source "${c.sourceKey}"`);
    const list = perSource.get(canon) ?? [];
    list.push(c);
    perSource.set(canon, list);
  }

  const writes: OverrideWrite[] = [];
  const edits: PlannedEdit[] = [];
  const canonKeys = new Set<string>();

  for (const [canon, list] of perSource) {
    const src = byCanon.get(canon) as BoardSource;
    const current = new Map(src.chests.map((c) => [c.name, c.points]));
    const whole = list.find((c) => c.chestName === '');
    const wholeChanged = whole !== undefined && whole.points !== src.points;

    const target = new Map(current);
    if (wholeChanged) {
      for (const c of src.chests) if (c.points === src.points) target.set(c.name, whole.points);
    }
    for (const c of list) {
      if (c.chestName === '') continue;
      if (!current.has(c.chestName)) {
        throw new PointsChangeError(`"${c.chestName}" has never dropped from ${src.label}`);
      }
      target.set(c.chestName, c.points);
    }

    const changedChests = src.chests.filter((c) => target.get(c.name) !== c.points);
    if (!wholeChanged && changedChests.length === 0) continue;
    canonKeys.add(canon);

    const wildcard = wholeChanged ? whole.points : overrides.get(makeCacheKey(src.key, ''));
    if (wholeChanged) {
      writes.push({ sourceKey: src.key, chestName: '', points: whole.points });
      edits.push({ key: src.key, label: src.label, chestName: '', from: src.points, to: whole.points });
    }
    // With a new wildcard every chest's fallback moves, so every chest is
    // re-checked; otherwise only the ones asked about.
    for (const c of wholeChanged ? src.chests : changedChests) {
      const to = target.get(c.name) as number;
      const fallback = wildcard ?? getDefaultPointsFor(src.key, c.name);
      const hasExact = overrides.has(makeCacheKey(src.key, c.name));
      if (to === fallback) {
        if (hasExact) writes.push({ sourceKey: src.key, chestName: c.name, points: null });
      } else if (!hasExact || overrides.get(makeCacheKey(src.key, c.name)) !== to) {
        writes.push({ sourceKey: src.key, chestName: c.name, points: to });
      }
      // A chest swept along by the source's new value is covered by the
      // source line; only a chest moved on its own gets a line of its own.
      const sweptByWhole = wholeChanged && c.points === src.points && to === whole.points;
      if (to !== c.points && !sweptByWhole) {
        edits.push({ key: src.key, label: src.label, chestName: c.name, from: c.points, to });
      }
    }
  }
  return { writes, edits, canonKeys };
}

/** Where a save applies: from today's game day on, or to all history. */
export type SaveMode = 'forward' | 'history';

export function isSaveMode(v: unknown): v is SaveMode {
  return v === 'forward' || v === 'history';
}

const NOTE_MAX = 300;

/** A note as stored: one line, trimmed, capped. */
function cleanNote(note: unknown): string {
  if (typeof note !== 'string') return '';
  return note.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, NOTE_MAX);
}

export interface ChangesPreview {
  edits: PlannedEdit[];
  /** Today's game day — where a "from today on" save starts. */
  today: string;
  forward: {
    impact: PointsImpact;
    /** Today already has a dated change; this save joins it. */
    joinsStep: boolean;
  };
  history: {
    impact: PointsImpact;
    /** Days of dated changes that lose values to this correction — it replaces
     *  those values for the chests it sets. */
    replacesSteps: string[];
  };
}

interface SavePlan {
  ctx: Ctx;
  groups: RecordGroup[];
  board: PointsBoard;
  plan: ReturnType<typeof planChanges>;
}

function planSave(clanId: number, changes: PointChange[]): SavePlan {
  const ctx = context(clanId);
  // Cut at today's start too: a "from today on" save splits the timeline there.
  const groups = loadRecordGroups(clanId, cutsOf([ctx.schedule], [ctx.todayStart]));
  const board = currentBoard(ctx, groups);
  return { ctx, groups, board, plan: planChanges(board, currentValues(ctx.schedule), changes) };
}

/**
 * Dry run of a save, both ways: the edits it amounts to, and what each mode
 * does to the clan's stored records. The page shows both and lets the admin
 * pick before anything is written.
 */
export function previewPointChanges(clanId: number, changes: PointChange[]): ChangesPreview {
  const now = new Date().toISOString();
  const { ctx, groups, board, plan } = planSave(clanId, changes);
  const forward = applyWrites(ctx.entries, ctx.today, plan.writes, null, now);
  const history = applyWrites(ctx.entries, '', plan.writes, null, now);
  const kept = new Set(history);
  return {
    edits: plan.edits,
    today: ctx.today,
    forward: {
      impact: computeImpact(groups, buildSchedule(forward, ctx.rollover), board, plan.canonKeys, ctx.schedule),
      joinsStep: ctx.entries.some((e) => e.from === ctx.today),
    },
    history: {
      impact: computeImpact(groups, buildSchedule(history, ctx.rollover), board, plan.canonKeys),
      replacesSteps: [...new Set(ctx.entries.filter((e) => e.from !== '' && !kept.has(e)).map((e) => e.from))].sort(),
    },
  };
}

export interface SaveResult {
  mode: SaveMode;
  /** The game day the values apply from; '' = all history. */
  effectiveFrom: string;
  edits: PlannedEdit[];
  impact: PointsImpact;
  updated: number;
}

/**
 * Save. 'forward' writes the values as today's dated step (joining one already
 * saved today) and moves only the records it changes — today's. 'history'
 * writes them for all history, replacing any dated value of the same chests,
 * logs the correction, and recalculates every record of the sources touched —
 * which also settles any that were already out of date. Either way exactly as
 * the preview reported.
 */
export function applyPointChanges(
  clanId: number,
  changes: PointChange[],
  opts: { mode: SaveMode; note?: unknown; user?: string },
): SaveResult {
  const now = new Date().toISOString();
  const { ctx, groups, board, plan } = planSave(clanId, changes);
  const note = cleanNote(opts.note);
  const user = opts.user ?? '';
  let next: PointEntry[] = ctx.entries;
  getDb().transaction(() => {
    if (opts.mode === 'forward') {
      const stepId = upsertStep(clanId, ctx.today, user, note, now);
      next = applyWrites(ctx.entries, ctx.today, plan.writes, stepId, now);
      savePointEntries(clanId, next);
    } else {
      next = applyWrites(ctx.entries, '', plan.writes, null, now);
      savePointEntries(clanId, next);
      if (plan.edits.length > 0) insertPointLog(clanId, 'correction', plan.edits, note, user, now);
    }
  })();
  const nextSchedule = buildSchedule(next, ctx.rollover);
  let impact: PointsImpact;
  let updated = 0;
  if (opts.mode === 'forward') {
    // Only what the dated change moves: today's chests, never an older one.
    impact = computeImpact(groups, nextSchedule, board, plan.canonKeys, ctx.schedule);
    if (plan.canonKeys.size > 0) updated = applyTimelineChange(clanId, ctx.schedule, nextSchedule, plan.canonKeys);
  } else {
    // Every record of the sources touched, which also settles any of them that
    // were already out of date.
    impact = computeImpact(groups, nextSchedule, board, plan.canonKeys);
    if (plan.canonKeys.size > 0) updated = recalculatePoints(clanId, plan.canonKeys);
  }
  return {
    mode: opts.mode,
    effectiveFrom: opts.mode === 'forward' ? ctx.today : '',
    edits: plan.edits,
    impact,
    updated,
  };
}

export interface CopyPreview {
  from: { id: number; name: string };
  /** Values the source clan holds — exactly what the board's clan holds after. */
  values: number;
  /** What changes on the board's clan, in the board's own terms. */
  edits: PlannedEdit[];
  impact: PointsImpact;
  /** The board clan's dated changes, which the copy replaces. */
  dropsSteps: number;
}

/**
 * The board's lines that move when `next` replaces the clan's overrides: a
 * source whose own value changes gets one line, and a chest only when it moves
 * apart from its source — the same shape a hand-made save previews as.
 */
function boardEdits(board: PointsBoard, next: Map<string, number>): PlannedEdit[] {
  const edits: PlannedEdit[] = [];
  for (const src of board.sources) {
    const after = src.chests.map((c) => ({ ...c, points: resolvePointsForKey(next, src.key, c.name) }));
    const to = sourcePoints(after, next, src.key);
    if (to !== src.points) edits.push({ key: src.key, label: src.label, chestName: '', from: src.points, to });
    after.forEach((c, i) => {
      const from = src.chests[i].points;
      const swept = from === src.points && c.points === to;
      if (c.points !== from && !swept) {
        edits.push({ key: src.key, label: src.label, chestName: c.name, from, to: c.points });
      }
    });
  }
  return edits;
}

function copySource(clanId: number, fromClanId: number): { id: number; name: string } {
  if (!Number.isInteger(fromClanId) || fromClanId === clanId) {
    throw new PointsChangeError('Pick a different clan to copy the values from');
  }
  const from = getClanById(fromClanId);
  if (!from) throw new PointsChangeError(`No clan #${fromClanId}`);
  return { id: from.id, name: from.name };
}

/** The other clan's values in force today, as all-history entries. */
function copiedEntries(fromClanId: number, now: string): PointEntry[] {
  return getAllOverrides(fromClanId).map((o) => ({
    sourceKey: o.sourceKey, chestName: o.chestName, from: '', value: o.pointValue, changeId: null, updatedAt: now,
  }));
}

/** Dry run of copying every value of `fromClanId` onto `clanId`. */
export function previewCopyFrom(clanId: number, fromClanId: number): CopyPreview {
  const from = copySource(clanId, fromClanId);
  const ctx = context(clanId);
  const groups = loadRecordGroups(clanId, cutsOf([ctx.schedule]));
  const board = currentBoard(ctx, groups);
  const next = copiedEntries(fromClanId, new Date().toISOString());
  return {
    from,
    values: next.length,
    edits: boardEdits(board, valuesOn(next, '')),
    impact: computeImpact(groups, buildSchedule(next, ctx.rollover), board),
    dropsSteps: ctx.steps,
  };
}

/**
 * Copy: the clan's values become an exact copy of the values `fromClanId`
 * holds today, for all history — its dated changes go — then every one of its
 * records is recalculated, which also settles any that were already stale,
 * exactly as the preview reported. Logged in the History view. The source clan
 * is untouched.
 */
export function applyCopyFrom(clanId: number, fromClanId: number, opts: { user?: string } = {}): CopyPreview & { updated: number } {
  const preview = previewCopyFrom(clanId, fromClanId);
  const now = new Date().toISOString();
  getDb().transaction(() => {
    savePointEntries(clanId, copiedEntries(fromClanId, now));
    insertPointLog(clanId, 'copy', preview.edits, preview.from.name, opts.user ?? '', now);
  })();
  const updated = recalculatePoints(clanId);
  return { ...preview, updated };
}

/** Dry run of Recalculate: every record of the clan whose stored value is out of date for its day. */
export function previewRecalculate(clanId: number): PointsImpact {
  const ctx = context(clanId);
  const groups = loadRecordGroups(clanId, cutsOf([ctx.schedule]));
  return computeImpact(groups, ctx.schedule, currentBoard(ctx, groups));
}

// ─── History ───

export interface HistoryStep {
  id: number;
  /** The game day its values apply from. */
  effectiveFrom: string;
  /** What it changes against the values in force the day before, in the
   *  board's terms — worked out from the timeline as it stands now. */
  lines: PlannedEdit[];
  note: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface HistoryLogEntry {
  id: number;
  kind: 'correction' | 'copy';
  /** What it changed, as shown when it was saved. */
  lines: PlannedEdit[];
  /** A correction's note; for a copy, the clan it copied from. */
  note: string;
  createdAt: string;
  createdBy: string;
}

export interface PointsHistory {
  clan: { id: number; name: string };
  today: string;
  /** Dated changes, newest day first. */
  steps: HistoryStep[];
  /** Corrections to all history and copies, newest first. */
  log: HistoryLogEntry[];
}

/** What the change dated `day` does, against the values of the day before it. */
function stepLines(ctx: Ctx, groups: RecordGroup[], known: RecordGroup[], day: string): PlannedEdit[] {
  const before = valuesOn(ctx.entries, day, { before: true });
  const board = buildBoard(ctx.clanId, groups, before, { known, today: ctx.today });
  return boardEdits(board, valuesOn(ctx.entries, day));
}

/** The clan's History view. */
export function getPointsHistory(clanId: number): PointsHistory {
  const ctx = context(clanId);
  const rows = listPointChanges(clanId);
  // Counts over all time are all a description needs (they pick a source's
  // majority value); no cuts.
  const groups = loadRecordGroups(clanId);
  const known = loadKnownGroups(clanId);
  return {
    clan: { id: clanId, name: getClanById(clanId)?.name ?? `Clan #${clanId}` },
    today: ctx.today,
    steps: rows.filter((r) => r.kind === 'step').map((r) => ({
      id: r.id,
      effectiveFrom: r.effectiveFrom,
      lines: stepLines(ctx, groups, known, r.effectiveFrom),
      note: r.note,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
      updatedAt: r.updatedAt,
      updatedBy: r.updatedBy,
    })),
    log: rows.filter((r) => r.kind !== 'step').map((r) => ({
      id: r.id,
      kind: r.kind as 'correction' | 'copy',
      lines: r.lines,
      note: r.note,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
    })),
  };
}

/** The earliest day a change may be dated from. */
const MIN_DAY = '2020-01-01';

/** An edit of a dated change: its day, the values it sets (the board's terms), its note. */
export interface StepEdit {
  effectiveFrom: string;
  changes: PointChange[];
  note?: unknown;
}

export interface StepPreview {
  /** The game day it applies from after the edit. */
  effectiveFrom: string;
  /** What it changes after the edit; empty = it no longer changes anything and goes. */
  edits: PlannedEdit[];
  impact: PointsImpact;
  /** The change is deleted (removed, or left holding no value of its own). */
  removes: boolean;
}

interface StepPlan {
  id: number;
  ctx: Ctx;
  groups: RecordGroup[];
  next: PointEntry[];
  day: string;
  edits: PlannedEdit[];
  /** Canonical source keys whose records may move. */
  canon: Set<string>;
  note: string;
}

function lineId(key: string, chestName: string): string {
  return `${canonicalSourceKey(key)}\t${chestName}`;
}

/**
 * Plan an edit (or, with `edit` null, the removal) of dated change `id`.
 *
 * Its values are taken out of the timeline and put back at the new day. A
 * move that keeps every value shifts the change's own rows as they are;
 * anything else is planned again against the values in force on the new day,
 * exactly as a board save would be. A change can't be moved past another
 * dated change that sets values for one of the same sources — their order
 * would silently swap which one wins.
 */
function planStepEdit(clanId: number, id: number, edit: StepEdit | null, now: string): StepPlan {
  const ctx = context(clanId);
  const step = getPointChange(clanId, id);
  if (!step || step.kind !== 'step') {
    throw new PointsChangeError('That dated change no longer exists. Reload the history.');
  }
  const own = ctx.entries.filter((e) => e.changeId === id);
  const base = ctx.entries.filter((e) => e.changeId !== id);
  const canon = new Set(own.map((e) => canonicalSourceKey(e.sourceKey)));

  if (edit === null) {
    return {
      id,
      ctx,
      groups: loadRecordGroups(clanId, cutsOf([ctx.schedule])),
      next: collapseRepeats(base),
      day: step.effectiveFrom,
      edits: [],
      canon,
      note: step.note,
    };
  }

  const day = edit.effectiveFrom;
  if (!isGameDay(day) || day < MIN_DAY) throw new PointsChangeError('Pick a valid game day.');
  if (day > ctx.today) throw new PointsChangeError(`A change can't start after today (${ctx.today}).`);
  if (listPointChanges(clanId).some((r) => r.kind === 'step' && r.id !== id && r.effectiveFrom === day)) {
    throw new PointsChangeError(`There is already a change from ${day}. Edit that one instead.`);
  }
  if (!Array.isArray(edit.changes)) throw new PointsChangeError('changes must be an array');
  for (const c of edit.changes) {
    if (c && typeof c.sourceKey === 'string') canon.add(canonicalSourceKey(c.sourceKey));
  }
  const lo = day < step.effectiveFrom ? day : step.effectiveFrom;
  const hi = day < step.effectiveFrom ? step.effectiveFrom : day;
  const crossing = base.find((e) => e.from > lo && e.from < hi && canon.has(canonicalSourceKey(e.sourceKey)));
  if (crossing) {
    throw new PointsChangeError(`The change from ${crossing.from} sets values for the same sources, so this one can't move past it. Move or remove that one first.`);
  }

  const groups = loadRecordGroups(clanId, cutsOf([ctx.schedule], [dayStartMs(day, ctx.rollover)]));
  const known = loadKnownGroups(clanId);
  const current = stepLines(ctx, groups, known, step.effectiveFrom);
  const asked = new Map(edit.changes.map((c) => [lineId(c?.sourceKey ?? '', c?.chestName ?? ''), c?.points]));
  const unchanged = asked.size === current.length
    && current.every((l) => asked.get(lineId(l.key, l.chestName)) === l.to);

  let next: PointEntry[];
  if (unchanged) {
    next = collapseRepeats([...base, ...own.map((e) => ({ ...e, from: day, updatedAt: now }))]);
  } else {
    // Nothing else is dated `day`, so the values on it are those of the day before.
    const before = valuesOn(base, day);
    const plan = planChanges(buildBoard(clanId, groups, before, { known, today: ctx.today }), before, edit.changes);
    for (const k of plan.canonKeys) canon.add(k);
    next = applyWrites(base, day, plan.writes, id, now);
  }
  const before = valuesOn(next, day, { before: true });
  const edits = boardEdits(buildBoard(clanId, groups, before, { known, today: ctx.today }), valuesOn(next, day));
  return {
    id, ctx, groups, next, day, edits, canon,
    note: edit.note === undefined ? step.note : cleanNote(edit.note),
  };
}

function stepPreview(p: StepPlan): StepPreview {
  const board = currentBoard(p.ctx, p.groups);
  return {
    effectiveFrom: p.day,
    edits: p.edits,
    impact: computeImpact(p.groups, buildSchedule(p.next, p.ctx.rollover), board, p.canon, p.ctx.schedule),
    removes: !p.next.some((e) => e.changeId === p.id),
  };
}

function applyStepPlan(clanId: number, p: StepPlan, user: string, now: string): StepPreview & { updated: number } {
  const preview = stepPreview(p);
  getDb().transaction(() => {
    updateStep(p.id, p.day, p.note, user, now);
    // A change left holding no value is deleted here (savePointEntries).
    savePointEntries(clanId, p.next);
  })();
  const updated = p.canon.size > 0
    ? applyTimelineChange(clanId, p.ctx.schedule, buildSchedule(p.next, p.ctx.rollover), p.canon)
    : 0;
  return { ...preview, updated };
}

/** Dry run of editing dated change `id`. */
export function previewStepEdit(clanId: number, id: number, edit: StepEdit): StepPreview {
  return stepPreview(planStepEdit(clanId, id, edit, new Date().toISOString()));
}

/** Edit dated change `id`, then move the records whose value it changes. */
export function applyStepEdit(clanId: number, id: number, edit: StepEdit, opts: { user?: string } = {}): StepPreview & { updated: number } {
  const now = new Date().toISOString();
  return applyStepPlan(clanId, planStepEdit(clanId, id, edit, now), opts.user ?? '', now);
}

/** Dry run of removing dated change `id`: its days go back to the values before it. */
export function previewStepRemove(clanId: number, id: number): StepPreview {
  return stepPreview(planStepEdit(clanId, id, null, new Date().toISOString()));
}

/** Remove dated change `id`, then move the records whose value it changes. */
export function applyStepRemove(clanId: number, id: number, opts: { user?: string } = {}): StepPreview & { updated: number } {
  const now = new Date().toISOString();
  return applyStepPlan(clanId, planStepEdit(clanId, id, null, now), opts.user ?? '', now);
}
