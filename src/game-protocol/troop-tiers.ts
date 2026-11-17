/**
 * A player's troop tiers, read from their research (game_player_techs) and the
 * game's research trees (tech-trees.ts) — what the clan otherwise reports by
 * hand as "G9 S8 E7 M8 C7".
 *
 * Each troop family has an "I" tree whose unit unlocks are numbered with the
 * tier (Archers I … Archers V, Heavy arbalester VI, … VII) and a "II" tree whose
 * unlocks restart at I for tiers 8 and 9 (Smiter I = G8, Smiter II = G9). A
 * family's tier is the highest unlock the player has researched. Crypts are the
 * "Crypts II … VII" unlocks in Archeology (Crypts I needs no research), reported
 * the way the clan writes it: the crypt LEVEL, numeral × 5 (Crypts VII = C35).
 *
 * Checked against the levels SIK members posted by hand (Nov 2026): G/S/E/M and
 * the crypt level match for every member, except where research moved on after
 * the post. The Guards level the clan tracks is the Guardsmen tier.
 *
 * Unlock nodes are the one-level nodes whose name ends in a roman numeral; the
 * ten-level nodes beside them (training cost, march speed, …) are boosts.
 */
import type { TechTrees } from './tech-trees.js';

export type TroopFamily = 'guardsmen' | 'specialists' | 'engineers' | 'monsters' | 'crypts';

export type TroopTiers = Record<TroopFamily, number | null>;

/** Tree ids per family: [tree whose numerals ARE the tier, tree whose numerals are tier − 7]. */
const FAMILY_TREES: Record<TroopFamily, { base: number[]; plus7: number[] }> = {
  guardsmen: { base: [1], plus7: [23] },
  specialists: { base: [2], plus7: [24] },
  engineers: { base: [8], plus7: [25] },
  monsters: { base: [15], plus7: [26] },
  crypts: { base: [5], plus7: [] },
};

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

function numeral(name: string): number | null {
  const m = /\s([IVX]+)$/.exec(name.trim());
  return m ? ROMAN[m[1]] ?? null : null;
}

/** techId → tier it unlocks, per family (built once per trees version). */
export function unlockIndex(trees: TechTrees): Record<TroopFamily, Map<number, number>> {
  const out = {} as Record<TroopFamily, Map<number, number>>;
  for (const [family, ids] of Object.entries(FAMILY_TREES) as Array<[TroopFamily, { base: number[]; plus7: number[] }]>) {
    const map = new Map<number, number>();
    for (const tree of trees.trees) {
      const offset = ids.base.includes(tree.id) ? 0 : ids.plus7.includes(tree.id) ? 7 : null;
      if (offset === null) continue;
      for (const node of tree.nodes) {
        if (node.maxLevel !== 1) continue;
        if (family === 'crypts' && !/^Crypts\b/.test(node.name)) continue;
        const n = numeral(node.name);
        if (n !== null) map.set(node.techId, n + offset);
      }
    }
    out[family] = map;
  }
  return out;
}

/** The player's tiers from their tech levels. Crypts start at I without research. */
export function troopTiers(levels: Record<string, number>, index: Record<TroopFamily, Map<number, number>>): TroopTiers {
  const tiers = { guardsmen: null, specialists: null, engineers: null, monsters: null, crypts: null } as TroopTiers;
  for (const family of Object.keys(index) as TroopFamily[]) {
    let best: number | null = null;
    for (const [techId, tier] of index[family]) {
      if ((levels[techId] ?? 0) >= 1 && (best === null || tier > best)) best = tier;
    }
    if (family === 'crypts') {
      const tier = best === null && Object.keys(levels).length ? 1 : best;
      tiers.crypts = tier === null ? null : tier * 5;
    } else {
      tiers[family] = best;
    }
  }
  return tiers;
}
