// A city's construction, training and research speed (src/game-protocol/
// city-speeds.ts) from its active effects (field 14), VIP and the clan's
// research, and the effect table they're read from (static-data.ts
// buildSpeeds, T20). Shaped like the game's rows; the numbers are small.

import { describe, expect, it } from 'vitest';
import { citySpeeds } from '../../src/game-protocol/city-speeds.js';
import { buildSpeeds, type GameSpeeds } from '../../src/game-protocol/static-data.js';
import type { Wire } from '../../src/game-protocol/codec.js';

// T20 rows: [id, 1, 1, [[kind, textRef, [], [cond], 0, value ×10000, flat]], …]. Text 51 is the general one.
const effect = (id: number, ...entries: Array<[number, number, number]>): Wire[] =>
  [id, 1, 1, entries.map(([kind, text, value]) => [kind, text, [], [2786], 0, value, 0])];
const T20: Record<string, Wire> = {
  // Research speed V level 20: +60 % research.
  29159: effect(29159, [17, 51, 16000]),
  // A gear piece: +30 % construction and research, and food production (kind 1, ignored).
  6257: effect(6257, [1, 24829, 13000], [0, 51, 13000], [17, 51, 13000]),
  // The Academy building at 45: +300 % research, and a flat cap (kind 15, ignored).
  4203: effect(4203, [17, 51, 40000], [15, 25142, 0]),
  // Troop training: the general line counts, a troop type's own line doesn't.
  4231: effect(4231, [2, 51, 22500], [2, 25421, 10120]),
  // A captain whose construction line carries its own text: it still counts.
  90705: effect(90705, [0, 25623, 30600]),
  // VIP 21 and a clan research level.
  4020: effect(4020, [0, 51, 13300], [17, 51, 13300], [1, 24829, 14000]),
  61309: effect(61309, [17, 51, 13000]),
  // Nothing the three speeds care about.
  777: effect(777, [4, 24815, 12000]),
};
const techRows: Array<[string, Wire[]]> = [
  ['1000', [1000, 0, 0, 0, 0, { 21: [21, 4020, 0, [], 0, 0, 0], 22: [22, 9999, 0, [], 0, 0, 0] }]],
  ['10130', [10130, 0, 0, 0, 0, { 10: [10, 61309, 0, [], 0, 0, 0] }]],
  ['1215', [1215, 0, 0, 0, 0, { 1: [1, 777, 0, [], 0, 0, 0] }]],
];

describe('buildSpeeds', () => {
  const table = buildSpeeds(T20, techRows);

  it('reads construction (kind 0), troop training (kind 2, general line only) and research (kind 17)', () => {
    expect(table.effects['29159']).toEqual([0, 0, 60]);
    expect(table.effects['6257']).toEqual([30, 0, 30]);
    expect(table.effects['4231']).toEqual([0, 125, 0]);
    expect(table.effects['90705']).toEqual([206, 0, 0]);
    expect(table.effects['777']).toBeUndefined();
  });

  it('maps research levels to their effect, only where the effect gives a speed', () => {
    expect(table.techs['1000']).toEqual({ 21: 4020 });
    expect(table.techs['10130']).toEqual({ 10: 61309 });
    expect(table.techs['1215']).toBeUndefined();
  });
});

describe('citySpeeds', () => {
  const table: GameSpeeds = buildSpeeds(T20, techRows);
  // Field 14: [effectId, sourceBits, count].
  const effects = [
    { id: 29159, source: 2, count: 1 },
    { id: 6257, source: 16, count: 5 },
    { id: 4203, source: 4, count: 1 },
    { id: 4231, source: 4, count: 1 },
    { id: 90705, source: 128, count: 1 },
    { id: 777, source: 2, count: 1 },
  ];

  it('adds every effect up, counted as often as the city has it, by where it comes from', () => {
    const s = citySpeeds(effects, table)!;
    expect(s.research).toEqual({ total: 60 + 150 + 300, by: { research: 60, gear: 150, buildings: 300 } });
    expect(s.construction).toEqual({ total: 150 + 206, by: { gear: 150, captains: 206 } });
    expect(s.training).toEqual({ total: 125, by: { buildings: 125 } });
  });

  it('adds VIP and the clan research the city record leaves out, by level', () => {
    const s = citySpeeds(effects, table, { vip: 21, clanLevels: { 10130: 10, 10006: 10 } })!;
    expect(s.research.by).toMatchObject({ vip: 33, clan: 30 });
    expect(s.research.total).toBe(510 + 33 + 30);
    expect(s.construction.by.vip).toBe(33);
    // A VIP level without a speed, or no VIP, adds nothing.
    expect(citySpeeds(effects, table, { vip: 3 })!.research.total).toBe(510);
  });

  it('is null for a reply without effects (malformed, not a city without bonuses)', () => {
    expect(citySpeeds([], table)).toBeNull();
  });
});
