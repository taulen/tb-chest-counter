/**
 * Tools → Costs helpers (lib/research-costs.js). The research costs are the
 * game's own (GET /api/game/research-costs, read every patch); these pin how a
 * tree's currency is picked and how research that costs the same shares a row,
 * in the tree's order — never by price.
 */
import { describe, it, expect } from 'vitest';
// Plain ESM with no DOM access at import time.
import {
  BLUEPRINTS, LEVEL_COLUMNS, levelValues, mergeLevelRows, rangeSteps, stepOfTech, sumSteps, treeCurrency, withSpeed,
} from '../../src/web/public/lib/research-costs.js';

const lv = (amounts: number[], item = '8', seconds = 300) => amounts.map((a) => ({ cost: { [item]: a }, seconds }));

describe('research costs from the game', () => {
  it("picks the item a tree's levels cost: Valor, Conquest, Battle Crests, Scientific Tractates…", () => {
    expect(treeCurrency({ nodes: [{ levels: lv([300, 700], '8') }], unplaced: [] })).toBe('8');
    expect(treeCurrency({ nodes: [], unplaced: [{ levels: lv([400], '9270000') }] })).toBe('9270000');
    expect(treeCurrency({ nodes: [{ levels: [{ cost: {}, seconds: 0 }] }] })).toBeNull();
  });

  it('reads a level as its cost in the currency, or its research time', () => {
    const node = { levels: [{ cost: { 20: 14000 }, seconds: 342000 }, { cost: {}, seconds: 0 }] };
    expect(levelValues(node, 'cost', '20')).toEqual([14000, 0]);
    expect(levelValues(node, 'time', '20')).toEqual([342000, 0]);
  });

  it('merges research that costs the same at every level, in tree order', () => {
    const nodes = [
      { name: 'Archers I', levels: lv([300]) },
      { name: "Guardsmen's training cost I", levels: lv([300, 700, 1800]) },
      { name: 'Spearmen I', levels: lv([300]) },
      { name: "Guardsmen's carrying capacity I", levels: lv([300, 700, 1800]) },
      { name: 'Archers II', levels: lv([450000]) },
    ];
    const rows = mergeLevelRows(nodes, (n: { levels: Array<{ cost: Record<string, number> }> }) => levelValues(n, 'cost', '8'));
    expect(rows.map((r) => r.nodes.map((n: { name: string }) => n.name))).toEqual([
      ['Archers I', 'Spearmen I'],
      ["Guardsmen's training cost I", "Guardsmen's carrying capacity I"],
      ['Archers II'],
    ]);
    expect(rows[1].total).toBe(2800);
    // A one-level unlock never shares a row with the first level of a ladder.
    expect(mergeLevelRows([{ levels: lv([300]) }, { levels: lv([300, 700]) }], (n: { levels: Array<{ cost: Record<string, number> }> }) => levelValues(n, 'cost', '8'))).toHaveLength(2);
  });

  it('has room for every research and clan tree (10 levels at most)', () => {
    expect(LEVEL_COLUMNS).toBe(10);
  });

  it('prices blueprints at 10 Gold each', () => {
    for (const b of BLUEPRINTS) expect(b.gold).toBe(b.blueprints * 10);
  });
});

describe('tier by tier', () => {
  const family = {
    steps: [
      { tier: 5, label: 'G5', cost: { 8: 9e9 }, seconds: 100, might: 1, buildings: { 1: 25 }, items: [{ techId: 1215 }], optional: [] },
      { tier: 6, label: 'G6', cost: { 8: 102e9 }, seconds: 200, might: 2, buildings: { 1: 30 }, items: [{ techId: 1230 }, { techId: 1215 }], optional: [{ techId: 1235 }] },
      { tier: 7, label: 'G7', cost: { 8: 1.33e12 }, seconds: 300, might: 3, buildings: { 1: 35 }, items: [{ techId: 1237 }], optional: [] },
    ],
  };

  it('a range is the steps after "from" up to "to", and its totals add up', () => {
    expect(rangeSteps(family, 5, 7).map((s: { label: string }) => s.label)).toEqual(['G6', 'G7']);
    expect(rangeSteps(family, 0, 5).map((s: { label: string }) => s.label)).toEqual(['G5']);
    expect(sumSteps(rangeSteps(family, 5, 7))).toEqual({ cost: { 8: 102e9 + 1.33e12 }, seconds: 500, might: 5, buildings: { 1: 35 } });
  });

  it("divides research time by the reader's speed bonus", () => {
    expect(withSpeed(400, 300)).toBe(100);
    expect(withSpeed(400, 0)).toBe(400);
    expect(withSpeed(400, -5)).toBe(400);
  });

  it('puts each research under the first tier that needs it, the optional ones where they open', () => {
    const where = stepOfTech(family);
    expect(where.get(1215)).toEqual({ tier: 5, label: 'G5', optional: false });
    expect(where.get(1235)).toEqual({ tier: 6, label: 'G6', optional: true });
  });
});
