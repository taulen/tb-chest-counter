/**
 * The leaderboard FAQ's "points per chest" table, built from what the scoring
 * actually does rather than from a hand-kept list.
 *
 * The input is the same summary the Source Point Values admin page reads
 * (getSourceKeySummary): every (source key, chest name) pair observed in
 * chest_records, carrying its effective value from the override → wildcard →
 * seeded-default stack. So a superadmin changing a value changes this table on
 * the next read, and a chest the game adds shows up after its first scan with
 * whatever it currently scores — 0 included, which is the honest answer for a
 * source nobody has valued yet.
 *
 * Only OBSERVED chests are listed. The override table also holds keys no chest
 * has ever resolved to (OCR-typo keys like "rise of the anclents event", levels
 * that never drop anything) and listing those would advertise values no player
 * can earn.
 *
 * The scoring table is global, so this is too: every clan sees the same values.
 * Observation counts are used here to drop OCR strays and never leave the
 * server — a public share page must not reveal another clan's volumes.
 */

import { getDb } from './database.js';
import { clanRewardChestIds } from './clan-reward-chests.js';
import { getSourceKeySummary } from './repositories/source-points-repo.js';
import { canonicalSourceKey, parseSourceLevelRange } from '../vision/source-names.js';
import { foldDiacritics } from '../vision/ocr-normalize.js';

/** One row per crypt/citadel type, one column per level. */
export interface PointsGuideMatrix {
  kind: 'matrix';
  key: string;
  title: string;
  levels: number[];
  rows: { label: string; cells: (number | null)[] }[];
}

/** A level ladder. Adjacent levels paying the same are merged into one range. */
export interface PointsGuideTiers {
  kind: 'tiers';
  key: string;
  title: string;
  rows: { from: number; to: number; points: number }[];
}

/** Named chests, each with the source it drops from. */
export interface PointsGuideChests {
  kind: 'chests';
  key: string;
  title: string;
  rows: { chest: string; source: string; points: number }[];
}

export type PointsGuideSection = PointsGuideMatrix | PointsGuideTiers | PointsGuideChests;

export interface PointsGuide {
  sections: PointsGuideSection[];
  /** Chests the leaderboard leaves out (end-of-event clan rewards). */
  notCounted: string[];
}

type MatrixRowId = 'common' | 'rare' | 'epic' | 'tartaros' | 'elven' | 'cursed';

const MATRIX_ROWS: { id: MatrixRowId; label: string }[] = [
  { id: 'common', label: 'Common Crypt' },
  { id: 'rare', label: 'Rare Crypt' },
  { id: 'epic', label: 'Epic Crypt' },
  { id: 'tartaros', label: 'Tartaros Crypt' },
  { id: 'elven', label: 'Elven Citadel' },
  { id: 'cursed', label: 'Cursed Citadel' },
];

type TierSectionKey = 'heroic' | 'runic' | 'vault';
type ChestSectionKey = 'squads' | 'events' | 'tournaments' | 'shops' | 'other';

// Display order. A section with nothing observed is dropped from the output.
const SECTIONS: { key: 'crypts' | TierSectionKey | ChestSectionKey; title: string }[] = [
  { key: 'crypts', title: 'Crypts & Citadels' },
  { key: 'heroic', title: 'Heroic Monsters' },
  { key: 'squads', title: 'Epic Squads' },
  { key: 'runic', title: 'Runic Raids' },
  { key: 'vault', title: 'Vault of the Ancients' },
  { key: 'events', title: 'Events' },
  { key: 'tournaments', title: 'Tournaments' },
  { key: 'shops', title: 'Shops' },
  { key: 'other', title: 'Other' },
];

type Placement =
  | { section: 'crypts'; row: MatrixRowId; level: number }
  | { section: TierSectionKey; from: number; to: number }
  | { section: ChestSectionKey };

/**
 * Below this many sightings AND under this share of its source (or of its
 * chest name), a row is an OCR stray rather than a real drop: six crypt chests
 * filed once each under "Alchemy tournament", one Rare Chest of Wealth under a
 * Level 20 Crypt. Both conditions, so a genuinely rare chest that is the only
 * thing its source ever drops — one Sacred Rituals Chest a year — still lists.
 */
const STRAY_MAX_COUNT = 5;
const STRAY_MAX_SHARE = 0.01;

function isStray(count: number, total: number): boolean {
  return count < STRAY_MAX_COUNT && count < total * STRAY_MAX_SHARE;
}

/**
 * The level range a source string names ("Lvl 20-24 Raid Runic squad" → 20-24),
 * falling back to a single level. "Lvl 45-45" collapses to 45.
 */
function rangeFromSource(source: string, fallback: number): { from: number; to: number } {
  const label = parseSourceLevelRange(source);
  if (!label) return { from: fallback, to: fallback };
  const [a, b] = label.split('-').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(a)) return { from: fallback, to: fallback };
  const to = Number.isFinite(b) && b >= a ? b : a;
  return { from: a, to };
}

/**
 * Which section a (source key, chest) pair belongs to. Keys are matched in
 * their despaced canonical form too, because PaddleOCR drops the spaces the
 * slug-fallback keys are built from ("level16heroicmonster").
 *
 * Anything unrecognised lands in "Other" — the failure mode of a new source is
 * a row in the wrong box, never a missing one.
 */
export function placeChest(key: string, source: string, chest: string): Placement {
  const canon = canonicalSourceKey(key);
  const foldedChest = foldDiacritics(chest).toLowerCase();

  let m = /^(common|rare|epic) (\d+)$/.exec(key);
  if (m) {
    const level = Number(m[2]);
    // Tartaros drops from a common-crypt key but pays its own ladder.
    if (foldedChest.includes('tartaros')) return { section: 'crypts', row: 'tartaros', level };
    return { section: 'crypts', row: m[1] as MatrixRowId, level };
  }
  m = /^(elven|cursed) citadel (\d+)$/.exec(key);
  if (m) {
    // The source string reads "Level 20 Citadel" for both kinds, so the key is
    // "elven" for a cursed one too — the chest name is what tells them apart.
    const cursed = m[1] === 'cursed' || foldedChest.includes('cursed');
    return { section: 'crypts', row: cursed ? 'cursed' : 'elven', level: Number(m[2]) };
  }
  m = /^level(\d+)heroicmonster$/.exec(canon);
  if (m) {
    const level = Number(m[1]);
    return { section: 'heroic', from: level, to: level };
  }
  m = /^vault (\d+)$/.exec(key);
  if (m) return { section: 'vault', ...rangeFromSource(source, Number(m[1])) };
  if (canon.includes('runic')) {
    const first = /(\d+)/.exec(key);
    if (first) return { section: 'runic', ...rangeFromSource(source, Number(first[1])) };
  }
  if (canon.includes('squad') || canon === 'shadowcity') return { section: 'squads' };
  if (canon.includes('tournament')) return { section: 'tournaments' };
  if (/shop|store|exchange/.test(canon)) return { section: 'shops' };
  if (/event|omens|carrot|beastman|yokai|sakura/.test(canon)) return { section: 'events' };
  return { section: 'other' };
}

/** Names of the clan-reward chests the leaderboard excludes, as stored. */
function clanRewardChestNamesStored(): string[] {
  const ids = clanRewardChestIds();
  if (ids.length === 0) return [];
  const rows = getDb()
    .prepare(`SELECT name FROM chests WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`)
    .all(...ids) as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * Merge a ladder: sort by level, drop exact repeats, and fold a level into the
 * previous range when it directly follows it at the same value — so the heroic
 * levels read "16–19 · 20" rather than four identical lines.
 */
function mergeTiers(rows: { from: number; to: number; points: number }[]): PointsGuideTiers['rows'] {
  const sorted = [...rows].sort((a, b) => a.from - b.from || a.to - b.to || a.points - b.points);
  const out: PointsGuideTiers['rows'] = [];
  for (const row of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.from === row.from && prev.to === row.to && prev.points === row.points) continue;
    if (prev && prev.points === row.points && row.from === prev.to + 1) {
      prev.to = row.to;
      continue;
    }
    out.push({ ...row });
  }
  return out;
}

export function buildPointsGuide(): PointsGuide {
  const notCounted = clanRewardChestNamesStored();
  const excluded = new Set(notCounted);

  interface Seen { key: string; source: string; chest: string; points: number; count: number; keyTotal: number }
  const seen: Seen[] = [];
  const chestTotals = new Map<string, number>();
  for (const summary of getSourceKeySummary()) {
    for (const row of summary.chestRows) {
      // The wildcard row is a rule, not a chest anyone received; count 0 is an
      // override for a chest this source has never actually dropped.
      if (row.isWildcard || row.count === 0 || excluded.has(row.chestName)) continue;
      seen.push({
        key: summary.sourceKey,
        source: summary.sampleSource,
        chest: row.chestName,
        points: row.effectivePoints,
        count: row.count,
        keyTotal: summary.totalCount,
      });
      chestTotals.set(row.chestName, (chestTotals.get(row.chestName) ?? 0) + row.count);
    }
  }

  type Cell = { points: number; count: number };
  type ChestRow = PointsGuideChests['rows'][number];
  const matrix = new Map<MatrixRowId, Map<number, Cell>>();
  const tiers = new Map<TierSectionKey, { from: number; to: number; points: number }[]>();
  const chests = new Map<ChestSectionKey, Map<string, ChestRow>>();

  for (const s of seen) {
    if (isStray(s.count, s.keyTotal)) continue;
    const at = placeChest(s.key, s.source, s.chest);
    if (at.section === 'crypts') {
      // One value per type and level; should two disagree, the one most chests
      // were actually scored at is the one a player will meet.
      const cells = matrix.get(at.row) ?? new Map<number, Cell>();
      const cur = cells.get(at.level);
      if (!cur || s.count > cur.count) cells.set(at.level, { points: s.points, count: s.count });
      matrix.set(at.row, cells);
    } else if (at.section === 'heroic' || at.section === 'runic' || at.section === 'vault') {
      const list = tiers.get(at.section) ?? [];
      list.push({ from: at.from, to: at.to, points: s.points });
      tiers.set(at.section, list);
    } else {
      // Named lists also drop a chest that is a stray of its NAME: a known chest
      // read once against the wrong source would otherwise get a line of its own.
      if (isStray(s.count, chestTotals.get(s.chest) ?? s.count)) continue;
      const rows = chests.get(at.section) ?? new Map<string, ChestRow>();
      // Spaced and spaceless spellings of one source are separate summary keys
      // that score identically — one line between them.
      const dedupe = `${canonicalSourceKey(s.key)}\t${s.chest}`;
      if (!rows.has(dedupe)) rows.set(dedupe, { chest: s.chest, source: s.source, points: s.points });
      chests.set(at.section, rows);
    }
  }

  const sections: PointsGuideSection[] = [];
  for (const def of SECTIONS) {
    if (def.key === 'crypts') {
      const levels = [...new Set([...matrix.values()].flatMap((cells) => [...cells.keys()]))]
        .sort((a, b) => a - b);
      const rows = MATRIX_ROWS
        .filter((r) => matrix.has(r.id))
        .map((r) => {
          const cells = matrix.get(r.id) as Map<number, Cell>;
          return { label: r.label, cells: levels.map((lvl) => cells.get(lvl)?.points ?? null) };
        });
      if (rows.length > 0) sections.push({ kind: 'matrix', key: def.key, title: def.title, levels, rows });
    } else if (def.key === 'heroic' || def.key === 'runic' || def.key === 'vault') {
      const rows = mergeTiers(tiers.get(def.key) ?? []);
      if (rows.length > 0) sections.push({ kind: 'tiers', key: def.key, title: def.title, rows });
    } else {
      const rows = [...(chests.get(def.key)?.values() ?? [])].sort((a, b) =>
        a.source.localeCompare(b.source, undefined, { sensitivity: 'base' })
        || a.points - b.points
        || a.chest.localeCompare(b.chest));
      if (rows.length > 0) sections.push({ kind: 'chests', key: def.key, title: def.title, rows });
    }
  }

  return { sections, notCounted };
}
