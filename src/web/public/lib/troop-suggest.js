// Tools → Citadel's "Suggest troops for my levels" (the user, Nov 28 2026): a
// new player knows their levels (G6, S5, M5, E6…) but not which troops a
// citadel wants. The page offers every line that matters at its best unlocked
// tiers, lets Auto size them (a troop it sizes to 0 is not needed and is
// dropped), and starts each bonus from:
//   - the player's own rows already on the page (the same troop, else its
//     bonus family: a card's lines apply to every tier of a line), else
//   - the baseline for their level in that kind (lib/baseline-bonuses.js),
//     marked as one: the page says plainly to replace it with theirs.
// Mercenaries (the user's rule): only ones the player already has on the page
// (from a report or typed), and only where they lose nothing — the page drops
// them and searches again when they would lose any.
// Pure: no DOM; tests/web/troop-suggest.test.ts.

import { TROOPS, troopById, troopUnlocked, BONUS_FAMILIES, bonusFamily, gmCounts } from './citadel-sim.js';
import { baselineBonus } from './baseline-bonuses.js';

/** Each line a citadel army draws from, best tier last, and how many of its top unlocked tiers are offered. */
export const SUGGEST_LINES = [
  // Flying lines: the first strikers and cleanups of every proven citadel army — four tiers, so a G9
  // player's Corax II / I come with game01master's Griffin and Vulture VII and VI cleanups.
  { take: 4, ids: ['griffin-5', 'griffin-6', 'griffin-7', 'corax-1', 'corax-2'] },
  { take: 4, ids: ['vulture-5', 'vulture-6', 'vulture-7', 'royal-lion-1', 'royal-lion-2'] },
  // Ground lines: their best tier only.
  ...['melee-guardsmen', 'ranged-guardsmen', 'mounted-guardsmen', 'melee-specialists', 'ranged-specialists', 'mounted-specialists']
    .map((fam) => ({ take: 1, ids: BONUS_FAMILIES[fam] })),
];
/** Monsters: the strongest this many unlocked. */
const MONSTERS = 2;
/** Siege engines, best first: one, the best unlocked. */
const SIEGE_LADDER = ['josephine-2', 'josephine-1', 'siege-ballistae-7', 'siege-ballistae-6', 'catapult-5', 'catapult-4', 'catapult-3', 'catapult-2', 'catapult-1'];
/** A level kind's key in `levels` per troop group. */
const LEVEL_OF = { guardsmen: 'g', specialists: 's', monsters: 'm', siege: 'e' };

/** Whether every level the suggestion needs is set (not "any"). */
export function levelsSet(levels) {
  return ['g', 's', 'm', 'e'].every((k) => Number.isInteger(levels?.[k]));
}

/** "G6 · S5 · M5 · E6" */
export function levelsLabel(levels) {
  return ['g', 's', 'm', 'e'].map((k) => `${k.toUpperCase()}${levels?.[k] ?? '?'}`).join(' · ');
}

/**
 * The suggested rows for a citadel, before Auto sizes them: [{ troopId, count:
 * 0, strengthPct, healthPct, baseline: ['strengthPct'?, 'healthPct'?] }],
 * siege first. `keep`: the rows on the page now (their bonuses carry over;
 * their mercenaries are the only ones offered). `extra`: troop ids offered
 * too (a proven setup's troops: game01master's for Elven 25/30). Null when
 * the levels aren't set.
 */
export function suggestRows(levels, keep = [], extra = []) {
  if (!levelsSet(levels)) return null;
  const ids = [];
  const siege = SIEGE_LADDER.find((id) => troopById(id) && troopUnlocked(id, levels));
  if (siege) ids.push(siege);
  for (const line of SUGGEST_LINES) {
    const open = line.ids.filter((id) => troopById(id) && troopUnlocked(id, levels));
    ids.push(...open.slice(-line.take).reverse());
  }
  const monsters = TROOPS.filter((tr) => tr.group === 'monsters' && troopUnlocked(tr.id, levels))
    .sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0) || b.str - a.str)
    .slice(0, MONSTERS);
  ids.push(...monsters.map((tr) => tr.id));
  // A setup's own siege engine is not added: the suggestion's (the best unlocked) stands in for it.
  for (const id of extra) {
    const d = troopById(id);
    if (d && d.group !== 'mercenaries' && !d.siegeEngine && troopUnlocked(id, levels) && !ids.includes(id)) ids.push(id);
  }
  for (const r of keep) if (troopById(r.troopId)?.group === 'mercenaries' && !ids.includes(r.troopId)) ids.push(r.troopId);

  return ids.map((troopId) => {
    const own = keep.find((r) => r.troopId === troopId)
      ?? keep.find((r) => bonusFamily(r.troopId) && bonusFamily(r.troopId) === bonusFamily(troopId));
    const def = troopById(troopId);
    const base = baselineBonus(def.group, levels[LEVEL_OF[def.group]] ?? def.tier);
    const row = { troopId, count: 0, strengthPct: null, healthPct: null, baseline: [] };
    for (const field of ['strengthPct', 'healthPct']) {
      const mine = own?.[field];
      const mineIsBaseline = own?.baseline?.includes(field);
      if (mine !== null && mine !== undefined && !mineIsBaseline) row[field] = mine;
      else if (base && def.group !== 'mercenaries') {
        row[field] = base[field];
        row.baseline.push(field);
      }
    }
    return row;
  });
}

/**
 * Starting counts for the suggestion's search from proven setups: each
 * `setups` entry is a troop id list in game01master's role order (siege,
 * 1st, 2nd, 3rd striker, cleanups), sized by game01master (gmCounts) with the
 * suggestion's bonuses and placed on the suggestion's rows. So the search
 * starts from game01master's answer and can only match or beat it. A setup
 * game01master can't size (another citadel, a troop missing) gives none.
 * @param {string} citadelId
 * @param {Array<{ troopId: string, strengthPct: number|null, healthPct: number|null }>} rows
 * @param {string[][]} setups
 * @returns {number[][]}
 */
export function setupStarts(citadelId, rows, setups) {
  const out = [];
  for (const ids of setups) {
    const at = ids.map((id) => rows.findIndex((r) => r.troopId === id));
    if (!ids.length || at.some((k) => k < 0)) continue;
    const counts = gmCounts(citadelId, at.map((k) => ({ ...rows[k], count: 0, healthPct: rows[k].healthPct ?? 0 })));
    if (!counts.every((n) => Number.isFinite(n))) continue;
    const start = rows.map(() => 0);
    at.forEach((k, j) => { start[k] = Math.max(0, counts[j]); });
    out.push(start);
  }
  return out;
}

/**
 * Rows of a suggestion that the search sized to 0 are not needed: the rows and counts kept.
 * @template {{ troopId: string }} R
 * @param {R[]} rows
 * @param {number[]} counts
 * @returns {{ rows: Array<R & { count: number }>, counts: number[] }}
 */
export function keepSized(rows, counts) {
  const keep = rows.map((r, i) => [r, counts[i]]).filter(([, n]) => n > 0);
  return { rows: keep.map(([r, n]) => ({ ...r, count: n })), counts: keep.map(([, n]) => n) };
}
