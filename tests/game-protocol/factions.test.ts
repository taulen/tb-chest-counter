import { describe, expect, it } from 'vitest';
import type { Wire } from '../../src/game-protocol/codec.js';
import {
  TABLE_FACTIONS,
  TABLE_TECHS,
  buildFactions,
  buildNames,
  conditionTexts,
} from '../../src/game-protocol/static-data.js';
import { FACTION_DISPLAY_ORDER, hallOfFameView } from '../../src/game-protocol/factions.js';

// A miniature Hall of Fame in the static data's shape: T78 faction rows
// [id, …, visual JSON ref, techId] and T21 tech rows whose levels are
// [level, effect, …, [condition refs], props ref, …]. Hand-written values.
const strings: Wire[] = [
  '{"stainedGlass":"stainedglass_red","icon":"fraction_red","banner":"fraction_banner_red","frameIcon":"fraction_on_frame_red","tooltipDescription":"battler_fraction.tooltip.courage"}', // 0
  '{"stainedGlass":"stainedglass_blue","icon":"fraction_blue","banner":"fraction_banner_blue","frameIcon":"fraction_on_frame_blue","tooltipDescription":"battler_fraction.tooltip.tenacity"}', // 1
  '{"stainedGlass":"stainedglass_green","icon":"fraction_green","banner":"fraction_banner_green","frameIcon":"fraction_on_frame_green","tooltipDescription":"battler_fraction.tooltip.resolve"}', // 2
  '{"props":[{"propText":"p.army","propValue":"+0,5%"},{"propText":"p.authority","propValue":"+0,1%"}]}', // 3
  '{"props":[{"propText":"p.army","propValue":"+1,0%"},{"propText":"p.authority","propValue":"+0,2%"}]}', // 4
  'HasCaptainFractionRarityLevel(30,1,2,1)', // 5
  'HasTech(800,1,1) && HasCaptainFractionRarityLevel(150,1,3,2)', // 6
  'HasFractionLevel(800,801,802,40)', // 7
  'HasTech(803,1,1) && HasFractionLevel(800,801,802,41)', // 8
  '{"props":[{"propText":"p.conquest","propValue":"+0,25%"}]}', // 9
  '{"props":[{"propText":"p.conquest","propValue":"+0,5%"}]}', // 10
  'HasSomethingNew(1)', // 11
];
const str = (ref: Wire): string | undefined => (typeof ref === 'number' && typeof strings[ref] === 'string' ? strings[ref] as string : undefined);
const en = new Map([
  ['battler_fraction.description.courage', 'Lions of Courage'],
  ['battler_fraction.description.tenacity', 'Wolves of Tenacity'],
  ['battler_fraction.description.resolve', 'Eagles of Resolve'],
  ['client.fractions_hall.title', 'Hall of Fame'],
  ['p.army', 'Army strength'],
  ['p.authority', 'Authority'],
  ['p.conquest', 'Conquest points'],
  ['client_config.value.conditions.has_captain_fraction_rarity_level.epic', 'Level %lvl% epic, legendary or mythic Captains of this faction needed: %count%'],
  ['client_config.value.conditions.has_captain_fraction_rarity_level.legendary', 'Level %lvl% legendary or mythic Captains of this faction needed: %count%'],
  ['client.conditions.has_fraction_level', 'Required level of all factions: %lvl%'],
]);
const twoLevels = (techId: number): Wire => [techId, 0, 0, 0, 1, {
  1: [1, 0, 0, [5], 3, 0, 0],
  2: [2, 0, 0, [6], 4, 0, 0],
}];
const tables = new Map<number, Record<string, Wire>>([
  // f4 = the visual JSON's string ref, f5 = the faction's tech.
  [TABLE_FACTIONS, {
    1: [1, 0, 0, 0, 0, 800],
    3: [3, 0, 0, 0, 1, 801],
    2: [2, 0, 0, 0, 2, 802],
  }],
  [TABLE_TECHS, {
    800: twoLevels(800),
    801: twoLevels(801),
    802: twoLevels(802),
    803: [803, 0, 0, 0, 1, { 1: [1, 0, 0, [7], 9, 0, 0], 2: [2, 0, 0, [8, 11], 10, 0, 0] }],
  }],
]);

describe('Hall of Fame conditions', () => {
  it("words the faction-captain and all-factions conditions as the game does, skipping the rest", () => {
    expect(conditionTexts(['HasTech(800,54,54) && HasCaptainFractionRarityLevel(150,1,2,2)'], en))
      .toEqual(['Level 150 epic, legendary or mythic Captains of this faction needed: 2']);
    expect(conditionTexts(['HasCaptainFractionRarityLevel(160,3,3,1)'], en))
      .toEqual(['Level 160 legendary or mythic Captains of this faction needed: 1']);
    expect(conditionTexts(['HasFractionLevel(800,801,802,46)'], en)).toEqual(['Required level of all factions: 46']);
    expect(conditionTexts(['HasTech(1,2,2)', 'HasSomethingNew(1)'], en)).toEqual([]);
    // No text for it in the translations: left out, never shown raw.
    expect(conditionTexts(['HasFractionLevel(800,801,802,46)'], new Map())).toEqual([]);
  });
});

describe('Hall of Fame from static data', () => {
  it('ties each faction (T78) to its tech, name, art and per-level bonuses and requirements', () => {
    const { factions, hallOfFame } = buildFactions(tables, str, en);
    expect(Object.keys(factions).sort()).toEqual(['1', '2', '3']);
    expect(factions['3']).toMatchObject({ id: 3, key: 'tenacity', name: 'Wolves of Tenacity', techId: 801, maxLevel: 2 });
    expect(factions['1'].art).toEqual({ stainedGlass: 'stainedglass_red', icon: 'fraction_red', banner: 'fraction_banner_red', frameIcon: 'fraction_on_frame_red' });
    expect(factions['1'].levels['1']).toEqual({
      lines: [['Army strength', '+0,5%'], ['Authority', '+0,1%']],
      requires: ['Level 30 epic, legendary or mythic Captains of this faction needed: 1'],
    });
    expect(factions['1'].levels['2'].requires).toEqual(['Level 150 legendary or mythic Captains of this faction needed: 2']);
    // The hall is the tech whose levels require HasFractionLevel(…).
    expect(hallOfFame).toMatchObject({ techId: 803, name: 'Hall of Fame', maxLevel: 2 });
    expect(hallOfFame?.levels['2']).toEqual({ lines: [['Conquest points', '+0,5%']], requires: ['Required level of all factions: 41'] });
  });

  it("gives techs 800–803 their real names (T21's own are placeholders)", () => {
    const n = buildNames('v1', strings, [], tables, en);
    expect(n.techs['800']).toEqual({ name: 'Lions of Courage', maxLevel: 2 });
    expect(n.techs['801'].name).toBe('Wolves of Tenacity');
    expect(n.techs['803'].name).toBe('Hall of Fame');
    expect(n.factions?.['2']?.name).toBe('Eagles of Resolve');
    expect(n.hallOfFame?.techId).toBe(803);
  });

  it('has no factions when the tables lack them', () => {
    expect(buildFactions(new Map(), str, en)).toEqual({ factions: {}, hallOfFame: null });
  });
});

describe('hallOfFameView', () => {
  const names = (() => {
    const { factions, hallOfFame } = buildFactions(tables, str, en);
    return { factions, hallOfFame: hallOfFame ?? undefined };
  })();
  const art = (n: string) => `/game-art/v/${n}.png`;

  it('shows the factions in the game order with level, bonuses, the next step and art', () => {
    const v = hallOfFameView(names, { 800: 2, 801: 1, 803: 1, 1197: 9 }, art);
    expect(v?.factions.map((f) => f.id)).toEqual([...FACTION_DISPLAY_ORDER]);
    const [wolves, lions, eagles] = v!.factions;
    expect(wolves).toMatchObject({ name: 'Wolves of Tenacity', level: 1, lines: [['Army strength', '+0,5%'], ['Authority', '+0,1%']] });
    expect(wolves.next).toEqual({
      level: 2,
      lines: [['Army strength', '+1,0%'], ['Authority', '+0,2%']],
      requires: ['Level 150 legendary or mythic Captains of this faction needed: 2'],
    });
    // At the top level: no next step.
    expect(lions).toMatchObject({ level: 2, maxLevel: 2, next: null, windowUrl: '/game-art/v/stainedglass_red.png', crestUrl: '/game-art/v/fraction_red.png' });
    // Not raised yet: level 0, nothing yet, the first level's requirement next.
    expect(eagles).toMatchObject({ level: 0, lines: [], next: { level: 1, requires: ['Level 30 epic, legendary or mythic Captains of this faction needed: 1'] } });
    expect(v).toMatchObject({ level: 1, maxLevel: 2, lines: [['Conquest points', '+0,25%']], next: { level: 2, requires: ['Required level of all factions: 41'] } });
  });

  it('is null without static factions or without a read of the techs', () => {
    expect(hallOfFameView(null, { 800: 1 }, art)).toBeNull();
    expect(hallOfFameView({ factions: {}, hallOfFame: undefined }, { 800: 1 }, art)).toBeNull();
    expect(hallOfFameView(names, null, art)).toBeNull();
  });

  it('leaves art null until it is extracted', () => {
    const v = hallOfFameView(names, {}, () => null);
    expect(v?.factions.every((f) => f.windowUrl === null && f.crestUrl === null)).toBe(true);
  });
});
