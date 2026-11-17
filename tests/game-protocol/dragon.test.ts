/**
 * The Dragon (city field 26 on the Dragons table, T73): names.json's `dragon`
 * from T73 rows, the profile's view of a stored dragon (level out of its
 * evolution's cap, XP window, bonuses now › next), and the archive replay
 * that gives old daily snapshots their stage and name.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Wire } from '../../src/game-protocol/codec.js';
import { TABLE_DRAGONS, buildDragon, buildNames, type GameDragon } from '../../src/game-protocol/static-data.js';
import { dragonView } from '../../src/game-protocol/dragon.js';
import { saveCitySnapshot, updateCityDragon } from '../../src/data/repositories/game-protocol-repo.js';
import { getLatestCity } from '../../src/data/repositories/game-profile-repo.js';
import { makeTestDb } from '../helpers/test-db.js';

// A miniature T73 in the static data's shape, hand-written: four levels
// `[level, xpRequired, effectId, textRef, 0]`, three stages
// `[stage, levelCap, cost, effectId, textRef, n]` (caps 2 / 3 / 4) and the
// window's config. Texts are effect_strings JSON, ids out of order on purpose.
const fx = (power: number, pvp: number, valor: number) => JSON.stringify({
  effect_strings: [
    { id: 2, text: 'fd.valor', value: valor },
    { id: 0, text: 'fd.power', value: power },
    { id: 1, text: 'fd.pvp', value: pvp },
  ],
});
const strings: Wire[] = [
  fx(5, 0, 0), // 0  level 1
  fx(6, 0, 0), // 1  level 2
  fx(8, 2, 0), // 2  level 3
  fx(10, 2, 1), // 3  level 4 (against players unchanged from level 3)
  JSON.stringify({ ...JSON.parse(fx(0, 0, 0)), icon_linkage: 'icon_red_dragon_1', full_dragon_linkage: 'red_dragon_1' }), // 4
  JSON.stringify({ ...JSON.parse(fx(0, 15, 0)), icon_linkage: 'icon_red_dragon_2', full_dragon_linkage: 'red_dragon_2' }), // 5
  JSON.stringify({ ...JSON.parse(fx(0, 45, 5)), icon_linkage: 'icon_red_dragon_3', full_dragon_linkage: 'red_dragon_3' }), // 6
  JSON.stringify({ icon_frame_linkage: 'frame_icon_red_dragon', background_linkage: 'red_dragon_back', dragon_name_title: 'fd.name' }), // 7
];
const str = (ref: Wire): string | undefined => (typeof ref === 'number' && typeof strings[ref] === 'string' ? strings[ref] as string : undefined);
const en = new Map([
  ['fd.name', 'Dragon'],
  ['fd.power', 'Army strength'],
  ['fd.pvp', 'Strength against players'],
  ['fd.valor', 'Valor points'],
]);
const row: Wire = [1, [0], {
  1: [1, 0, 30460, 0, 0],
  2: [2, 70000, 30461, 1, 0],
  3: [3, 250000, 30462, 2, 0],
  4: [4, 900000, 30463, 3, 0],
}, {
  1: [1, 2, [{}, {}, 3], 30760, 4, 10000],
  2: [2, 3, [{ 602002: 3000 }, {}, 1], 30761, 5, 55000],
  3: [3, 4, [{ 602002: 7500 }, {}, 1], 30762, 6, 220000],
}, 7, 602001, []];
const table: Record<string, Wire> = { 1: row };

const art = (n: string) => `/art/${n}.png`;

describe('buildDragon (T73)', () => {
  it('reads the levels, bonuses, evolution stages and sprites', () => {
    const d = buildDragon(table, str, en)!;
    expect(d.name).toBe('Dragon');
    expect(d.bonusNames).toEqual(['Army strength', 'Strength against players', 'Valor points']);
    expect(d.xp).toEqual([0, 70000, 250000, 900000]);
    expect(d.levelBonuses).toEqual([[5, 0, 0], [6, 0, 0], [8, 2, 0], [10, 2, 1]]);
    expect(d.stages['2']).toEqual({ levelCap: 3, bonuses: [0, 15, 0], icon: 'icon_red_dragon_2', art: 'red_dragon_2' });
    expect(Object.keys(d.stages)).toEqual(['1', '2', '3']);
    expect(d.art).toEqual({ frame: 'frame_icon_red_dragon', back: 'red_dragon_back' });
  });

  it('is null without a usable table — no row, or levels with a gap', () => {
    expect(buildDragon(undefined, str, en)).toBeNull();
    expect(buildDragon({}, str, en)).toBeNull();
    const gap: Wire = [1, [0], { 1: [1, 0, 0, 0, 0], 3: [3, 9, 0, 2, 0] }, {}, 7];
    expect(buildDragon({ 1: gap }, str, en)).toBeNull();
  });

  it('lands in names.json', () => {
    const n = buildNames('v1', strings, [], new Map([[TABLE_DRAGONS, table]]), en);
    expect(n.dragon?.xp).toEqual([0, 70000, 250000, 900000]);
    expect(buildNames('v1', strings, [], new Map(), en).dragon).toBeUndefined();
  });
});

describe('dragonView', () => {
  const names = { dragon: buildDragon(table, str, en) as GameDragon };

  it("shows a dragon as the game's window does: level out of its evolution's cap, XP window, bonuses now › next", () => {
    const v = dragonView(names, { level: 2, xp: 100000, stage: 2, name: ' Salty ' }, art)!;
    expect(v).toMatchObject({
      name: 'Salty', title: 'Dragon', level: 2, maxLevel: 4, stage: 2, maxStage: 3, levelCap: 3,
      xp: 100000, xpFloor: 70000, xpNext: 250000, atCap: false,
      iconUrl: '/art/icon_red_dragon_2.png', artUrl: '/art/red_dragon_2.png',
      frameUrl: '/art/frame_icon_red_dragon.png', backUrl: '/art/red_dragon_back.png',
    });
    // A line shows when either side gives something; a zero now is "+0%".
    expect(v.levelLines).toEqual([['Army strength', '+6%'], ['Strength against players', '+0%']]);
    expect(v.nextLevel).toEqual({ level: 3, lines: [['Army strength', '+8%'], ['Strength against players', '+2%']] });
    expect(v.stageLines).toEqual([['Strength against players', '+15%'], ['Valor points', '+0%']]);
    expect(v.nextStage).toEqual({ stage: 3, levelCap: 4, lines: [['Strength against players', '+45%'], ['Valor points', '+5%']] });
  });

  it("at its evolution's cap it gains no XP until it evolves; at the top there is no next level", () => {
    const capped = dragonView(names, { level: 3, xp: 250000, stage: 2 }, art)!;
    expect(capped).toMatchObject({ atCap: true, xpNext: 900000 });
    // The next level's values only where they move: against players stays +2%.
    expect(capped.levelLines).toEqual([['Army strength', '+8%'], ['Strength against players', '+2%'], ['Valor points', '+0%']]);
    expect(capped.nextLevel).toEqual({ level: 4, lines: [['Army strength', '+10%'], ['Valor points', '+1%']] });
    const top = dragonView(names, { level: 4, xp: 950000, stage: 3 }, art)!;
    expect(top).toMatchObject({ atCap: false, xpNext: null, nextLevel: null, nextStage: null, levelCap: 4 });
    expect(top.levelLines).toEqual([['Army strength', '+10%'], ['Strength against players', '+2%'], ['Valor points', '+1%']]);
  });

  it('a read from before the stage was parsed: level and XP, no evolution or stage art', () => {
    const v = dragonView(names, { level: 2, xp: 100000 }, art)!;
    expect(v).toMatchObject({ stage: null, levelCap: null, atCap: false, stageLines: [], nextStage: null, iconUrl: null, artUrl: null, name: null });
    expect(v.frameUrl).toBe('/art/frame_icon_red_dragon.png');
  });

  it('is null without a dragon or without T73', () => {
    expect(dragonView(names, {}, art)).toBeNull();
    expect(dragonView(names, { level: 0 }, art)).toBeNull();
    expect(dragonView(names, { level: 9 }, art)).toBeNull();
    expect(dragonView({}, { level: 2 }, art)).toBeNull();
    expect(dragonView(null, { level: 2 }, art)).toBeNull();
  });
});

describe('the archive replay', () => {
  let cleanup: () => void;
  beforeEach(() => { ({ cleanup } = makeTestDb()); });
  afterEach(() => cleanup());

  it("gives a day's stored snapshot the stage and name from that day's archived reply, never inventing a day", () => {
    saveCitySnapshot(1, 42, '2026-11-16', { techCount: 3, buildings: {}, dragon: { level: 236, xp: 1 } }, '2026-11-16T20:00:00Z');
    expect(updateCityDragon(1, 42, '2026-11-16', { level: 236, xp: 1, stage: 6, name: 'Salty' })).toBe(true);
    expect(getLatestCity(1, 42)?.dragon).toEqual({ level: 236, xp: 1, stage: 6, name: 'Salty' });
    // Same again: nothing to change. A day with no snapshot: left alone.
    expect(updateCityDragon(1, 42, '2026-11-16', { level: 236, xp: 1, stage: 6, name: 'Salty' })).toBe(false);
    expect(updateCityDragon(1, 42, '2026-11-15', { level: 235, xp: 0, stage: 6, name: 'Salty' })).toBe(false);
    expect(getLatestCity(1, 42)?.gameDate).toBe('2026-11-16');
  });
});
