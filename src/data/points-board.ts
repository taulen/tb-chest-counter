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
 * compute exactly which stored chest_records values would move, by how much,
 * per clan, through the same resolver the write uses. Nothing is lost by a
 * wrong save, but a save nobody can check before making is how values drift.
 */
import { getDb } from './database.js';
import { cached } from '../utils/ttl-cache.js';
import { listClans } from './repositories/clan-repo.js';
import {
  getAllOverrides, loadOverrides, makeCacheKey, resolvePointsForKey,
  writeOverrides, recalculateAllPoints, type OverrideWrite,
} from './repositories/source-points-repo.js';
import {
  canonicalSourceKey, getSourceKey, getDefaultPointsFor, hasDefaultPointsFor, parseSourceLevelRange,
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
}

export interface PointsBoard {
  categories: { key: SourceCategory; title: string; sources: number; unset: number }[];
  sources: BoardSource[];
  staleRecords: number;
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
}

/**
 * chest_records grouped down to (clan, source, chest, stored value), for live
 * clans only — the same rows recalculateAllPoints walks, so a preview counts
 * exactly what a write would touch.
 */
function loadRecordGroups(): RecordGroup[] {
  const clanIds = new Set(listClans().map((c) => c.id));
  const rows = getDb().prepare(`
    SELECT cr.clan_id, cs.source, ch.name AS chest_name, cr.point_value, COUNT(*) AS cnt
      FROM chest_records cr
      JOIN chest_sources cs ON cs.id = cr.chest_source_id
      JOIN chests ch ON ch.id = cr.chest_id
     WHERE cs.source != ''
     GROUP BY cr.clan_id, cr.chest_source_id, cr.chest_id, cr.point_value
  `).all() as { clan_id: number; source: string; chest_name: string; point_value: number; cnt: number }[];

  const keyOf = new Map<string, string | null>();
  const groups: RecordGroup[] = [];
  for (const r of rows) {
    if (!clanIds.has(r.clan_id)) continue;
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
    });
  }
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
    const range = parseSourceLevelRange(sample) ?? /(\d+)/.exec(key)?.[1];
    return range ? `${name} · Level ${range.replace('-', '–')}` : name;
  }
  return sample || titleCase(key);
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

function buildBoard(groups: RecordGroup[], overrides: Map<string, number>): PointsBoard {
  const overridden = new Set(getAllOverrides().map((o) => makeCacheKey(o.sourceKey, o.chestName)));

  interface Bucket {
    keys: Map<string, number>;
    sources: Map<string, number>;
    chests: Map<string, Map<number, number>>;
  }
  // One bucket per CANONICAL key: a source read with and without spaces is
  // one source, scored by one set of overrides.
  const buckets = new Map<string, Bucket>();
  for (const g of groups) {
    let b = buckets.get(g.canon);
    if (!b) {
      b = { keys: new Map(), sources: new Map(), chests: new Map() };
      buckets.set(g.canon, b);
    }
    b.keys.set(g.key, (b.keys.get(g.key) ?? 0) + g.count);
    b.sources.set(g.source, (b.sources.get(g.source) ?? 0) + g.count);
    const stored = b.chests.get(g.chestName) ?? new Map<number, number>();
    stored.set(g.stored, (stored.get(g.stored) ?? 0) + g.count);
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
      for (const [value, count] of stored) {
        n += count;
        if (value !== points) stale += count;
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
    staleTotal += stale;
    sources.push({
      key,
      label,
      source: sample,
      category,
      records,
      points: majorityPoints(chests),
      chests,
      unset: chests.some((c) => c.unset),
      staleRecords: stale,
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

  return {
    categories,
    sources: sources.map(({ rank: _rank, ...s }) => s),
    staleRecords: staleTotal,
  };
}

/** The board as the admin page reads it. Cached; every write invalidates it. */
export function getPointsBoard(): PointsBoard {
  return cached(BOARD_CACHE_KEY, BOARD_TTL_MS, () => buildBoard(loadRecordGroups(), loadOverrides()));
}

/**
 * What re-resolving every record under `overrides` would change: per clan, and
 * per (source, chest), largest point swing first.
 */
function computeImpact(
  groups: RecordGroup[],
  overrides: Map<string, number>,
  board: PointsBoard,
  onlyCanon?: ReadonlySet<string>,
): PointsImpact {
  const labels = new Map(board.sources.map((s) => [canonicalSourceKey(s.key), s]));
  const clanNames = new Map(listClans().map((c) => [c.id, c.name]));
  const clans = new Map<number, { records: number; delta: number }>();
  const lines = new Map<string, ImpactLine & { fromSet: Set<number>; chestRecords: Map<string, number> }>();
  let records = 0;
  let delta = 0;

  for (const g of groups) {
    if (onlyCanon && !onlyCanon.has(g.canon)) continue;
    const to = resolvePointsForKey(overrides, g.key, g.chestName);
    if (to === g.stored) continue;
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

function withWrites(overrides: Map<string, number>, writes: OverrideWrite[]): Map<string, number> {
  const next = new Map(overrides);
  for (const w of writes) {
    const k = makeCacheKey(w.sourceKey, w.chestName);
    if (w.points === null) next.delete(k);
    else next.set(k, w.points);
  }
  return next;
}

export interface ChangesPreview {
  edits: PlannedEdit[];
  impact: PointsImpact;
}

/** Dry run of a save: the edits it amounts to and what they do to stored records. */
export function previewPointChanges(changes: PointChange[]): ChangesPreview {
  const groups = loadRecordGroups();
  const overrides = loadOverrides();
  const board = buildBoard(groups, overrides);
  const plan = planChanges(board, overrides, changes);
  return { edits: plan.edits, impact: computeImpact(groups, withWrites(overrides, plan.writes), board, plan.canonKeys) };
}

/**
 * Save: write the override rows, then recalculate every record of the sources
 * touched — which also settles any of their records that were already stale,
 * exactly as the preview reported.
 */
export function applyPointChanges(changes: PointChange[]): ChangesPreview & { updated: number } {
  const groups = loadRecordGroups();
  const overrides = loadOverrides();
  const board = buildBoard(groups, overrides);
  const plan = planChanges(board, overrides, changes);
  const impact = computeImpact(groups, withWrites(overrides, plan.writes), board, plan.canonKeys);
  writeOverrides(plan.writes);
  const updated = plan.canonKeys.size > 0 ? recalculateAllPoints(plan.canonKeys) : 0;
  return { edits: plan.edits, impact, updated };
}

/** Dry run of Recalculate: every record whose stored value is out of date. */
export function previewRecalculate(): PointsImpact {
  const groups = loadRecordGroups();
  const overrides = loadOverrides();
  return computeImpact(groups, overrides, buildBoard(groups, overrides));
}
