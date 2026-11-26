/**
 * Tools → Costs helpers (lib/research-costs.js). The research costs are the
 * game's own (GET /api/game/research-costs, read every patch); these pin how a
 * tree's currency is picked and how research that costs the same shares a row,
 * in the tree's order — never by price.
 */
import { describe, it, expect } from 'vitest';
// Plain ESM with no DOM access at import time.
import { BLUEPRINTS, LEVEL_COLUMNS, levelValues, mergeLevelRows, treeCurrency } from '../../src/web/public/lib/research-costs.js';

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
