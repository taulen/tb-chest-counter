/**
 * battle-data.json from the game's own tables (battle-data.ts): units (T9)
 * with their numbers, tags, "vs" features, march costs and kind; monster
 * targets (T7) with their armies. The rows are made-up rows in the game's shape.
 */
import { describe, expect, it } from 'vitest';
import { buildBattleData, battleUnitNames } from '../../src/game-protocol/battle-data.js';
import type { Wire } from '../../src/game-protocol/codec.js';

// String pool: tags, icons and name keys.
const S: Record<number, string> = {
  1: 'MELEE', 2: 'MOUNTED', 3: 'FLYING', 4: 'GUARDSMEN', 5: 'HUMAN', 6: 'CITYWALLS', 7: 'SIEGE', 8: 'ENGINE', 9: 'BEAST',
  20: 'icon_corax', 21: 'icon_bear', 22: 'icon_walls', 23: 'icon_ballista',
};
// Name vectors → their text (undefined = a key the game's files have no text for).
const NAMES: Record<number, string | undefined> = {
  100: 'Corax I', 101: 'Bear', 102: 'Citadel Walls', 103: 'Siege Ballistae VII', 104: 'Wyvern', 105: 'Phoenix',
  200: 'Common Elf squad', 201: 'Elven Citadel', 202: undefined, 203: "Exiles' Grove",
};
const look = {
  str: (r: Wire | undefined) => (typeof r === 'number' ? S[r] : undefined),
  name: (r: Wire | undefined) => (typeof r === 'number' ? NAMES[r] : undefined),
};
const PRICED: Wire = [{ 1: 80 }, {}, 1];
const FREE: Wire = [{}, {}, 2];
/** A T9 row: [id, name, tier, …, f6 price, …, f10 str, f12 hp, f16 lead×100, f17 auth×100, f18 dom×100, f23 tags, f38 vs]. */
function unit(id: number, name: number, tier: number, price: Wire, str: number, hp: number, cost: [number, number, number], tags: number[], vs: Wire[], icon: number): Wire[] {
  const r: Wire[] = new Array(44).fill(0);
  r[0] = id; r[1] = name; r[2] = tier; r[4] = icon; r[6] = price; r[10] = str; r[12] = hp;
  [r[16], r[17], r[18]] = cost;
  r[23] = tags; r[38] = vs;
  return r;
}
const T9: Record<string, Wire> = {
  206: unit(206, 100, 8, PRICED, 61200, 183600, [2000, 0, 0], [3, 4, 5], [[[2], 1333, 100], [[6], 701, 100]], 20),
  // The same troop again, no cost (the game's 75xxx copies): left out.
  75078: unit(75078, 100, 8, PRICED, 61200, 183600, [0, 0, 0], [3, 4, 5], [], 20),
  6033: unit(6033, 101, 5, FREE, 22000, 66000, [0, 0, 0], [1, 9], [[[2], 70, 100]], 21),
  51: unit(51, 102, 5, FREE, 10000, 30000, [0, 0, 0], [6, 8], [[[1], 100, 100]], 22),
  // A siege engine: ×20 against walls lives in the feature's third value.
  87: unit(87, 103, 7, PRICED, 8500, 51000, [1000, 0, 0], [7, 8, 5], [[[6], 740, 2000]], 23),
  3089: unit(3089, 104, 9, PRICED, 690000, 2070000, [0, 6300, 0], [3], [], 20),
  191: unit(191, 105, 8, PRICED, 660000, 1980000, [0, 0, 5400], [3], [], 20),
};
/** A T7 row: [id, type, …, f3 name, …, f6 [{}, army], …, f15 level, …, f18 class]. */
function obj(id: number, type: number, name: number, army: Record<number, number>, level: number, cls: number): Wire[] {
  const r: Wire[] = new Array(30).fill(0);
  r[0] = id; r[1] = type; r[3] = name; r[6] = [{}, army, [], []]; r[15] = level; r[18] = cls;
  return r;
}
const T7: Record<string, Wire> = {
  // An older version at the same level steps aside for the current one.
  990: obj(990, 6, 200, { 6033: 750 }, 30, 0),
  1531: obj(1531, 6, 200, { 6033: 780000 }, 30, 1),
  // The same army again under another id: one target, both ids.
  188029: obj(188029, 6, 200, { 6033: 780000 }, 30, 1),
  1817: obj(1817, 6, 201, { 51: 135000, 6033: 12000 }, 30, 4),
  // No text in the game's files (a test object): left out.
  5000: obj(5000, 6, 202, { 6033: 1 }, 1, 1),
  // Exiles' Grove (type 22): not an ordinary army.
  75322: obj(75322, 22, 203, { 6033: 5 }, 10, 0),
  // A unit the table doesn't have: left out.
  6000: obj(6000, 6, 200, { 99999: 5 }, 31, 1),
};

describe('battle data from the game tables', () => {
  const d = buildBattleData(T7, T9, look, 'v1');

  it('keeps a unit\'s numbers, lower-case tags and features with their damage multiplier', () => {
    expect(d.units['206']).toEqual({
      name: 'Corax I', tier: 8, str: 61200, hp: 183600, tags: ['flying', 'guardsmen', 'human'],
      vs: [[['mounted'], 1333, 1], [['citywalls'], 701, 1]], icon: 'icon_corax', kind: 'guardsmen', lead: 20,
    });
    expect(d.units['87'].vs).toEqual([[['citywalls'], 740, 20]]);
    expect(d.units['87']).toMatchObject({ kind: 'siege', lead: 10 });
  });

  it('tells a player\'s kinds apart by march cost, and keeps map monsters without one', () => {
    expect(d.units['3089']).toMatchObject({ kind: 'mercenaries', auth: 63 });
    expect(d.units['191']).toMatchObject({ kind: 'monsters', dom: 54 });
    expect(d.units['6033'].kind).toBeUndefined();
    expect(d.units['51'].kind).toBeUndefined();
  });

  it('leaves out the free copy of a troop', () => {
    expect(d.units['75078']).toBeUndefined();
  });

  it('keeps one target per name, level and army, current versions first', () => {
    const elf = d.targets.filter((t) => t.name === 'Common Elf squad');
    expect(elf).toEqual([{ ids: [1531, 188029], name: 'Common Elf squad', level: 30, cls: 1, army: [[6033, 780000]] }]);
  });

  it('keeps walls in a citadel\'s army, strongest stack first', () => {
    expect(d.targets.find((t) => t.name === 'Elven Citadel')?.army).toEqual([[51, 135000], [6033, 12000]]);
  });

  it('leaves out unnamed objects, Exiles\' Grove and armies with unknown units', () => {
    expect(d.targets.map((t) => t.ids[0])).toEqual([1531, 1817]);
  });

  it('names every unit it keeps, for the game texts', () => {
    expect(battleUnitNames(d)).toEqual({
      51: 'Citadel Walls', 87: 'Siege Ballistae VII', 191: 'Phoenix', 206: 'Corax I', 3089: 'Wyvern', 6033: 'Bear',
    });
  });
});
