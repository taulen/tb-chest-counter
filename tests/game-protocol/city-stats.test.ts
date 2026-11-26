// Every bonus of a city (src/game-protocol/city-stats.ts): effect lines named
// by pairing them with the texts the game prints for them, a city's lines
// summed by "kind:label", and the changes between reads. Synthetic pools and
// tables, shaped like the game's (T20 effects, T21 research levels, T10
// captain levels).

import { describe, expect, it } from 'vitest';
import { buildCityStats, cityStats, splitStatKey, statChanges, type CityStats } from '../../src/game-protocol/city-stats.js';
import type { Wire } from '../../src/game-protocol/codec.js';

// Pools: strings (texts and props JSON) and vectors (a line's target: ids).
const strings: string[] = [];
const S = (s: string): number => strings.push(s) - 1;
const vectors: number[][] = [];
const V = (ids: number[]): number => vectors.push(ids) - 1;
const props = (...lines: Array<[string, string]>): number =>
  S(JSON.stringify({ props: [...lines.map(([propText, propValue]) => ({ icon: '', propText, propValue })), { icon: '1_power_22', propText: 'might', propValue: '10' }] }));

const ALL = V([]);
const FOOD = V([6]);
const LUMBER = V([3]);
const FOOD_AND_LUMBER = V([3, 6]);
const ARMY = V([1, 2, 3]);
const en = new Map([
  ['t.research', 'Research speed'], ['t.food', 'Food production'], ['t.lumber', 'Lumber production'],
  ['t.army', 'Army strength'], ['t.clanResearch', 'Research speed'], ['t.construction', 'Construction speed'],
]);
const line = (kind: number, target: number, value: number, flat = 0): Wire[] => [kind, target, [], [2786], 0, value, flat];
const T20: Record<string, Wire> = {
  100: [100, 1, 1, [line(17, ALL, 10500)]], // research speed +5 %
  101: [101, 1, 1, [line(1, FOOD, 11900)]], // food +19 %
  102: [102, 1, 1, [line(1, LUMBER, 11900)]], // lumber +19 %
  103: [103, 1, 1, [line(1, FOOD_AND_LUMBER, 13000)]], // both +30 %: splits into food and lumber
  104: [104, 1, 1, [line(4, ARMY, 12000), line(17, ALL, 10100)]], // army +20 %, research +1 %
  105: [105, 1, 1, [line(48, ALL, 13000)]], // the clan's own research speed +30 %
  106: [106, 1, 1, [line(0, ALL, 11000), line(17, ALL, 11000)]], // +10 % twice: printed in another order — no vote
  107: [107, 1, 1, [line(99, ALL, 15000)]], // never printed: no name
};
// Research levels: [level, effectId, factoryId, [cond], props, might, cron].
const level = (lv: number, effect: number, text: number): Wire[] => [lv, effect, 0, [], text, 10, 0];
const T21: Record<string, Wire> = {
  1: [1, 0, 0, 0, 0, { 1: level(1, 100, props(['t.research', '+5,0%'])) }],
  2: [2, 0, 0, 0, 0, { 1: level(1, 101, props(['t.food', '+19,0%'])) }],
  3: [3, 0, 0, 0, 0, { 1: level(1, 102, props(['t.lumber', '+19,0%'])) }],
  4: [4, 0, 0, 0, 0, { 1: level(1, 104, props(['t.army', '+20,0%'], ['t.research', '+1,0%'])) }],
  // A clan research whose text reads the same as the city's research speed.
  10006: [10006, 0, 0, 0, 0, { 1: level(1, 105, props(['t.clanResearch', '+30,0%'])) }],
  // Both lines +10 %, printed construction-last: the values can't tell them apart.
  5: [5, 0, 0, 0, 0, { 1: level(1, 106, props(['t.research', '+10,0%'], ['t.construction', '+10,0%'])) }],
};
const tables = new Map<number, Record<string, Wire>>([[20, T20], [21, T21]]);
const str = (ref: Wire): string | undefined => (typeof ref === 'number' ? strings[ref] : undefined);
const vec = (ref: Wire): Wire[] | undefined => (typeof ref === 'number' ? vectors[ref] : undefined);
const table = buildCityStats(tables, str, vec, en);

describe('buildCityStats', () => {
  it("names an effect's lines with the texts the game prints for them, in order", () => {
    const named = (id: number) => (table.effects[String(id)] ?? []).map(([i, pct]) => [table.labels[table.keys[i]], pct]);
    expect(named(100)).toEqual([['Research speed', 5]]);
    expect(named(104)).toEqual([['Army strength', 20], ['Research speed', 1]]);
  });

  it('splits a line aimed at several resources into each one', () => {
    expect((table.effects['103'] ?? []).map(([i, pct]) => [table.labels[table.keys[i]], pct]))
      .toEqual([['Lumber production', 30], ['Food production', 30]]);
  });

  it("never names a line from a text that can't be told apart by its value, or one the game never prints", () => {
    // 106's research line still gets research's name from the other levels; its construction line has none.
    expect((table.effects['106'] ?? []).map(([i]) => table.labels[table.keys[i]])).toEqual(['Research speed']);
    expect(table.effects['107']).toBeUndefined();
  });

  it('keeps research levels by level for VIP and the clan', () => {
    expect(table.techs['10006']).toEqual({ 1: 105 });
  });
});

describe('cityStats', () => {
  const effects = [{ id: 100, count: 1 }, { id: 101, count: 2 }, { id: 103, count: 1 }, { id: 104, count: 1 }];

  it('adds every line up by kind and label, counted as often as the city has it', () => {
    expect(cityStats(effects, table)).toEqual({
      '17:Research speed': [6, 0],
      '1:Food production': [38 + 30, 0],
      '1:Lumber production': [30, 0],
      '4:Army strength': [20, 0],
    });
  });

  it("adds the clan's research only to bonuses the city has itself: its own research speed stays out", () => {
    const s = cityStats(effects, table, { clanLevels: { 10006: 1 } })!;
    expect(s['17:Research speed']).toEqual([6, 0]);
    expect(s['48:Research speed']).toBeUndefined();
  });

  it('is null for a reply without effects', () => {
    expect(cityStats([], table)).toBeNull();
  });

  it('splits a key into its kind and label', () => {
    expect(splitStatKey('17:Research speed')).toEqual({ kind: 17, label: 'Research speed' });
  });
});

describe('statChanges', () => {
  it('lists every bonus that moved, newest first; new and lost ones from and to nothing', () => {
    const history: Array<{ gameDate: string; stats: CityStats }> = [
      { gameDate: '2026-11-20', stats: { a: [10, 0], b: [5, 0] } },
      { gameDate: '2026-11-21', stats: { a: [10, 0], b: [5, 0] } },
      { gameDate: '2026-11-22', stats: { a: [15, 0], c: [0, 100] } },
    ];
    expect(statChanges(history)).toEqual([
      { gameDate: '2026-11-22', stat: 'c', from: [0, 0], to: [0, 100] },
      { gameDate: '2026-11-22', stat: 'b', from: [5, 0], to: [0, 0] },
      { gameDate: '2026-11-22', stat: 'a', from: [10, 0], to: [15, 0] },
    ]);
  });
});
