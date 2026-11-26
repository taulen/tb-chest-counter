// What a troop tier costs (src/game-protocol/tier-costs.ts), from the game's
// prerequisites: a step is what the next tier's unlocks need beyond the tier
// before; a unit alone; research the next tier doesn't need is optional (the
// "only 2 of 3 are needed" rule). Synthetic trees and levels, shaped like the
// game's (Guardsmen I + II, Valor points = item 8).

import { describe, expect, it } from 'vitest';
import { tierCosts, tiersForPlayer } from '../../src/game-protocol/tier-costs.js';
import type { TechLevel, TechLevels, TechTrees } from '../../src/game-protocol/tech-trees.js';

const node = (techId: number, name: string, maxLevel: number, col: number, row = 0) => ({ techId, name, description: '', icon: '', maxLevel, col, row, requires: [] });
const lv = (level: number, valor: number, needs: Array<[number, number]> = [], building?: [number, number]): TechLevel => ({
  level, cost: { 8: valor }, seconds: 100, might: 1, lines: [], ...(needs.length ? { needs } : {}), ...(building ? { building } : {}),
});
const levels: TechLevels = {
  version: 'v',
  buildings: { 1: 'Academy' },
  techs: {
    1197: [lv(1, 300)],
    1198: [lv(1, 300)],
    // Training cost I: its level 2 asks for Spearmen I.
    1200: [lv(1, 300, [[1197, 1]]), lv(2, 700, [[1198, 1]]), lv(3, 1800, [], [1, 10])],
    // Carrying capacity I: a dead end.
    1202: [lv(1, 300, [[1197, 1]]), lv(2, 700)],
    1201: [lv(1, 45000, [[1200, 3]])],
    1203: [lv(1, 45000, [[1200, 3], [1202, 2]])],
    2005: [lv(1, 900000, [[1201, 1]], [1, 40])],
    9999: [lv(1, 5, [[1197, 1]])],
  },
};
const trees: TechTrees = {
  version: 'v',
  builtAt: '2026-11-26T00:00:00Z',
  trees: [
    {
      id: 1, name: 'Guardsmen I', description: '', kind: 'research', tab: 'Unlock', icon: '', layout: 'guardTree',
      nodes: [node(1197, 'Archers I', 1, 0, 0), node(1198, 'Spearmen I', 1, 0, 1), node(1200, "Guardsmen's training cost I", 3, 1), node(1202, "Guardsmen's carrying capacity I", 2, 1, 1), node(1201, 'Archers II', 1, 2), node(1203, 'Riders II', 1, 2, 1)],
      unplaced: [{ techId: 9999, name: "Guardsmen's upkeep cost I", description: '', icon: '', maxLevel: 1, requires: [] }],
    },
    { id: 23, name: 'Guardsmen II', description: '', kind: 'research', tab: 'Unlock', icon: '', layout: 'guardTreeII', nodes: [node(2005, 'Smiter I', 1, 0)] },
  ],
};

describe('tierCosts', () => {
  const [guards] = tierCosts(trees, levels);
  const step = (label: string) => guards.steps.find((s) => s.label === label)!;

  it('steps a family tier by tier, the II tree continuing at 8', () => {
    expect(guards.letter).toBe('G');
    expect(guards.steps.map((s) => s.label)).toEqual(['G1', 'G2', 'G8']);
  });

  it('a step is everything the next tier needs beyond the one before, level by level, in tree order', () => {
    expect(step('G1').items.map((i) => [i.techId, i.from, i.to])).toEqual([[1197, 0, 1], [1198, 0, 1]]);
    // G2 needs carrying capacity too: Riders II asks for it.
    expect(step('G2').items.map((i) => [i.techId, i.from, i.to])).toEqual([[1200, 0, 3], [1202, 0, 2], [1201, 0, 1], [1203, 0, 1]]);
    expect(step('G2').cost).toEqual({ 8: 300 + 700 + 1800 + 300 + 700 + 45000 + 45000 });
    expect(step('G2').buildings).toEqual({ 1: 10 });
    expect(step('G8')).toMatchObject({ cost: { 8: 900000 }, buildings: { 1: 40 } });
  });

  it("prices each unit alone: Archers II needs only training cost, not carrying capacity", () => {
    expect(step('G2').units.map(({ techId, cost, seconds }) => ({ techId, cost, seconds }))).toEqual([
      { techId: 1201, cost: { 8: 300 + 700 + 1800 + 45000 }, seconds: 400 },
      { techId: 1203, cost: { 8: 300 + 700 + 1800 + 300 + 700 + 45000 }, seconds: 600 },
    ]);
    expect(step('G2').units[0].items.map((i) => [i.techId, i.from, i.to])).toEqual([[1200, 0, 3], [1201, 0, 1]]);
  });

  it('lists what no tier needs as optional where it opens, never research the game does not draw', () => {
    const noRiders = tierCosts(
      { ...trees, trees: [{ ...trees.trees[0], nodes: trees.trees[0].nodes.filter((n) => n.techId !== 1203) }, trees.trees[1]] },
      levels,
    )[0];
    const g1 = noRiders.steps.find((s) => s.label === 'G1')!;
    expect(g1.optional.map((o) => [o.techId, o.from, o.to, o.cost])).toEqual([[1202, 0, 2, { 8: 1000 }]]);
    expect(noRiders.steps.flatMap((s) => s.optional.map((o) => o.techId))).not.toContain(9999);
  });
});

describe('tiersForPlayer', () => {
  const families = tierCosts(trees, levels);
  // Both G1 units, training cost done, carrying capacity to level 1, one G2
  // unit (Archers II): G2 by the site's count.
  const have = { 1197: 1, 1198: 1, 1200: 3, 1202: 1, 1201: 1 };
  const [guards] = tiersForPlayer(families, have, levels);
  const step = (label: string) => guards.steps.find((s) => s.label === label)!;

  it("finds their tier the site's way — the highest unit they have — and the next one", () => {
    expect([guards.current, guards.next]).toEqual([2, 8]);
    const [fresh] = tiersForPlayer(families, {}, levels);
    expect([fresh.current, fresh.next]).toEqual([0, 1]);
  });

  it('takes what they have off each step, level by level', () => {
    expect(step('G1').items).toEqual([]);
    expect(step('G1').cost).toEqual({});
    // Carrying capacity from level 1 on, then Riders II; training cost and Archers II are theirs.
    expect(step('G2').items.map((i) => [i.techId, i.from, i.to])).toEqual([[1202, 1, 2], [1203, 0, 1]]);
    expect(step('G2').cost).toEqual({ 8: 700 + 45000 });
    // The Academy level only training cost's last level asked for: done.
    expect(step('G2').buildings).toEqual({});
    // Untouched steps stay as they were.
    expect(step('G8').cost).toEqual(families[0].steps.find((s) => s.label === 'G8')!.cost);
  });

  it('prices what is left of each unit alone: nothing for the one they have', () => {
    expect(step('G2').units.map((u) => [u.techId, u.cost])).toEqual([
      [1201, {}],
      [1203, { 8: 700 + 45000 }],
    ]);
  });

  it('keeps only the optional research they have not finished', () => {
    const noRiders = tierCosts(
      { ...trees, trees: [{ ...trees.trees[0], nodes: trees.trees[0].nodes.filter((n) => n.techId !== 1203) }, trees.trees[1]] },
      levels,
    );
    const g1 = (h: Record<string, number>) => tiersForPlayer(noRiders, h, levels)[0].steps.find((s) => s.label === 'G1')!.optional;
    expect(g1({ 1202: 1 }).map((o) => [o.techId, o.from, o.to, o.cost])).toEqual([[1202, 1, 2, { 8: 700 }]]);
    expect(g1({ 1202: 2 })).toEqual([]);
  });
});
