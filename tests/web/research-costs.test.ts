/**
 * Tools → Costs data (lib/research-costs.js), imported from kingdom289.com's
 * Costs & Upgrades sheet. The rows point at shared curves and the page merges
 * rows that cost the same, so a mistyped curve key or a lost row would silently
 * move a research to the wrong price — this pins the import against the sheet.
 */
import { describe, it, expect } from 'vitest';
// Plain ESM with no DOM access at import time.
import {
  CURVES,
  TREES,
  mergeRows,
  rowTotal,
  pathSkipsSome,
  PATH_PICKS,
  curveTotal,
  GUARDSMEN_TIERS,
  tierTotal,
  BLUEPRINTS,
} from '../../src/web/public/lib/research-costs.js';

type Row = [string, string | number];
const curves: Record<string, number[]> = CURVES;
const sections = TREES.flatMap((tree) => tree.sections) as { name: string; rows: Row[] }[];
const allRows = sections.flatMap((s) => s.rows.map(([name, cost]) => ({ section: s.name, name, cost })));
const find = (section: string, name: string) => allRows.find((r) => r.section === section && r.name === name);

describe('research costs data', () => {
  it('keeps all 418 rows of the 14 sheets', () => {
    expect(sections).toHaveLength(14);
    expect(allRows).toHaveLength(418);
  });

  it('gives every curve 10 rising levels, and every row a known curve or a price', () => {
    for (const levels of Object.values(CURVES)) {
      expect(levels).toHaveLength(10);
      for (let i = 1; i < 10; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1]);
    }
    for (const r of allRows) {
      if (typeof r.cost === 'string') expect(CURVES, `${r.section}: ${r.name}`).toHaveProperty(r.cost);
      else expect(r.cost, `${r.section}: ${r.name}`).toBeGreaterThan(0);
    }
  });

  it('lists no research twice in a sheet', () => {
    for (const s of sections) {
      const names = s.rows.map(([n]) => n);
      expect(new Set(names).size, s.name).toBe(names.length);
    }
  });

  it("matches the sheet's totals for levels 1 to 10", () => {
    const total = (section: string, name: string) => {
      const row = find(section, name);
      expect(row, name).toBeDefined();
      return typeof row!.cost === 'string' ? curveTotal(row!.cost) : row!.cost;
    };
    const near = (value: number, expected: number) => expect(Math.abs(value - expected) / expected).toBeLessThan(0.006);
    near(total('Guardsmen I', "Guardsmen's Training Cost I"), 843.2e3);
    near(total('Guardsmen I', "Guardsmen's Training Cost IV"), 33.2e9);
    near(total('Specialists I', "Specialists' March Speed II"), 95.7e6);
    near(total('Monsters I', "Monsters' Cost IV"), 271.1e9);
    near(total('Guardsmen II', "Guardsmen's March Speed VI"), 4153.9e9);
    near(total('Monsters II', "Monsters' Carrying Capacity V"), 41460e9);
    near(total('Specialists II', "Specialists' Training Cost VII"), 15014e9);
    expect(total('Guardsmen II', 'Purifier II')).toBe(9000e9);
    expect(total('Logistics', 'Captain Stror')).toBe(80e6);
  });

  it('applies the fixes where the sheet contradicts itself', () => {
    // 14.0M at level 2 of the 9.6M curve on most sheets, 19.0M on the rest.
    expect(curves[find('Economy', 'Silver Production III')!.cost as string][1]).toBe(19e6);
    // Blank level 4.
    expect(curves[find('Monsters I', "Monsters' March Speed III")!.cost as string][3]).toBe(400e6);
    // The sheet listed Ranged Units' Health V twice and no Strength V.
    expect(find('Army Modernization', "Ranged Units' Strength V")).toBeDefined();
  });

  it('reproduces the Guardsmen tier overview', () => {
    const totals = Object.fromEntries(GUARDSMEN_TIERS.map((x) => [x.tier, tierTotal(x)]));
    expect(totals.G4 / 1e6).toBeCloseTo(480.2, 1);
    expect(totals.G5 / 1e9).toBeCloseTo(6.3252, 3);
    expect(totals.G6 / 1e9).toBeCloseTo(75.4, 1);
    expect(totals.G7 / 1e9).toBeCloseTo(1062, 0);
    expect(totals.G8 / 1e12).toBeCloseTo(9.2078, 3);
  });

  it('prices blueprints at 10 Gold each', () => {
    expect(BLUEPRINTS.map((b) => b.level)).toEqual([10, 15, 20, 25, 30, 35, 40, 45]);
    for (const b of BLUEPRINTS) expect(b.gold).toBe(b.blueprints * 10);
  });
});

describe('row totals and the unlock path', () => {
  const tree = (key: string) => TREES.find((x) => x.key === key)!;
  const groupOf = (key: string, section: string, name: string) =>
    mergeRows(tree(key).sections.find((s) => s.name === section)!.rows).find((g) => g.names.includes(name))!;

  it('totals every research in a row, and says only two of a troop-tree trio are needed', () => {
    const vii = groupOf('guardsmen', 'Guardsmen II', "Guardsmen's Training Cost VII");
    expect(vii.names).toHaveLength(3);
    expect(rowTotal(vii) / 1e12).toBeCloseTo(124.707, 3); // 3 × 41.569T
    expect(pathSkipsSome(tree('guardsmen'), vii)).toBe(true);
    expect((vii.total * PATH_PICKS) / 1e12).toBeCloseTo(83.138, 3);
    // The tier overview's "2×" is the same two (G8 on the VI curve).
    const vi = groupOf('guardsmen', 'Guardsmen II', "Guardsmen's Training Cost VI");
    expect(vi.total * PATH_PICKS + 900e9).toBe(tierTotal(GUARDSMEN_TIERS.find((x) => x.tier === 'G8')!));
    expect(pathSkipsSome(tree('monsters'), groupOf('monsters', 'Monsters I', "Monsters' Cost IV"))).toBe(true);
  });

  it('has nothing to skip in a pair, an unlock, or a tree that is not a troop line', () => {
    expect(pathSkipsSome(tree('guardsmen'), groupOf('guardsmen', 'Guardsmen I', "Guardsmen's Training Cost II"))).toBe(false);
    const units = groupOf('guardsmen', 'Guardsmen II', 'Purifier I');
    expect(pathSkipsSome(tree('guardsmen'), units)).toBe(false);
    expect(rowTotal(units)).toBe(4 * 900e9);
    expect(pathSkipsSome(tree('army'), groupOf('army', 'Army Modernization', "Scouts' Strength II"))).toBe(false);
    expect(pathSkipsSome(tree('economy'), groupOf('economy', 'Economy', 'Silver Production III'))).toBe(false);
  });
});

describe('mergeRows', () => {
  it('keeps every name exactly once, cheapest first', () => {
    for (const s of sections) {
      const groups = mergeRows(s.rows);
      expect(groups.flatMap((g) => g.names).sort()).toEqual(s.rows.map(([n]) => n).sort());
      for (let i = 1; i < groups.length; i++) expect(groups[i].first).toBeGreaterThanOrEqual(groups[i - 1].first);
    }
  });

  it('merges same-cost rows and keeps unlocks apart from curves', () => {
    const groups = mergeRows([
      ['A I', 300],
      ['B I', 's1'],
      ['C I', 's1'],
      ['A II', 450_000],
      ['B II', 's2'],
      ['D I', 300],
    ]);
    expect(groups).toEqual([
      { curve: null, unlock: 300, names: ['A I', 'D I'], first: 300, total: 300 },
      { curve: 's1', unlock: null, names: ['B I', 'C I'], first: 300, total: curveTotal('s1') },
      { curve: 's2', unlock: null, names: ['B II'], first: 45_000, total: curveTotal('s2') },
      { curve: null, unlock: 450_000, names: ['A II'], first: 450_000, total: 450_000 },
    ]);
  });
});
