import zlib from 'zlib';
import { describe, expect, it } from 'vitest';
import { encodeValues, type Wire } from '../../src/game-protocol/codec.js';
import {
  TABLE_CAPTAINS,
  TABLE_CLAN_MEDALS,
  TABLE_TERRAINS,
  TABLE_GIFT_TYPES,
  TABLE_HEROES,
  TABLE_HERO_LEVELS,
  TABLE_MAP_OBJECTS,
  TABLE_TECHS,
  NAMES_FORMAT,
  buildNames,
  fixedResourceGrants,
  parseTranslationsCsv,
  readTables,
  unzipFirst,
} from '../../src/game-protocol/static-data.js';

// A miniature of the game's static data: string pool, vectors of string refs
// (a localised field), and tables keyed by their own ids.
const strings: Wire[] = [
  'gabp4k80', // 0
  'item.name.n0176', // 1
  'Level %value% Crypt', // 2
  '%value%', // 3
  '15', // 4
  'tech.name.n1197', // 5
  'tech.name.n0020', // 6
  '%level%', // 7
  'I', // 8
  'hero_avatar.avatar_name.n0001', // 9
  'icon_garvel_72', // 10
  'map_object.vault', // 11
  '{}', // 12
  'unit.name.carter', // 13
  '{"smallIcon":"carter_icon","unitAltarArt":"lvlup_carter"}', // 14
  '{"props":[{"icon":"","propText":"hero_level.client_info.n0002","propValue":"+5,0%"},{"icon":"","propText":"hero_level.client_info.resolve_points","propValue":"315"}]}', // 15
];
const vectors: Wire[] = [
  [1], // 0: Infernal Chest
  [2, 3, 4], // 1: Level 15 Crypt
  [5], // 2: Archers I
  [6, 7, 8], // 3: Sacred Potion production %level% → I
  [9], // 4: Garvel
  [11], // 5: Vault of the Ancients
  [12], // 6: JSON fragment, not a name
  [13], // 7: Carter
];
const en = new Map([
  ['item.name.n0176', 'Infernal Chest'],
  ['Level %value% Crypt', 'Level %value% Crypt'],
  ['tech.name.n1197', 'Archers I'],
  ['tech.name.n0020', 'Sacred Potion production %level%'],
  ['hero_avatar.avatar_name.n0001', 'Garvel'],
  ['map_object.vault', 'Vault of the Ancients'],
  ['unit.name.carter', 'Carter'],
  ['client.captain.info.epic_captain', 'Epic Captain'],
  ['hero_level.client_info.n0002', 'Crypt exploration efficiency'],
  ['hero_level.client_info.resolve_points', 'Eagles of Resolve points'],
]);
const tables = new Map<number, Record<string, Wire>>([
  [TABLE_GIFT_TYPES, {
    5622: [5622, 10, 9999, 0, 0, 2, 4963, [], 0, 0, 4, 0, 0, 0, 1, 0, [{}]].map((v, i) => (i === 3 ? 0 : v)) as Wire,
    7: [7, 0, 0, 6, 0, 0, 0, [], 0, 0, 0, 0, 0, 0, 6, 0, [{}]],
  }],
  [TABLE_TECHS, {
    1197: [1197, 2, 0, 10, 1, { 1: [1, 0, 0, [], 0, 100, 0] }],
    20: [20, 3, 0, 10, 1, { 1: [], 2: [], 3: [] }],
  }],
  [TABLE_HEROES, { 1: [1, 4, 1489, 10, 0, [2747], 0, 1, 0] }],
  [TABLE_MAP_OBJECTS, { 150329: [150329, 6, 0, 5, 0, 0] }],
  // Carter's real layout, trimmed: f2 rarity, f5 name, f7 sprites, f12 star levels.
  [TABLE_CAPTAINS, {
    8: [8, 2, 2, 0, 0, 7, 0, 14, [], [], {}, {}, {
      1: [1, [0], [{}, {}, 1], 0, 80, 10000, 0, 12, 0, []],
      2: [2, [0], [{ 71008: 40 }, {}, 1], 0, 0, 11500, 0, 15, 420, []],
    }, 0],
  }],
]);

describe('game names from static data', () => {
  it('resolves gift chests and templated sources, techs, heroes and map objects', () => {
    const n = buildNames('v1', strings, vectors, tables, en);
    expect(n.gifts['5622']).toEqual({ chest: 'Infernal Chest', source: 'Level 15 Crypt' });
    expect(n.techs['1197']).toEqual({ name: 'Archers I', maxLevel: 1 });
    expect(n.techs['20']).toEqual({ name: 'Sacred Potion production I', maxLevel: 3 });
    expect(n.heroes['1']).toEqual({ name: 'Garvel', icon: 'icon_garvel_72' });
    expect(n.objects['150329']).toBe('Vault of the Ancients');
  });

  it('reads captains: rarity label, sprites and the bonuses per star level', () => {
    const n = buildNames('v1', strings, vectors, tables, en);
    expect(n.captains['8']).toEqual({
      name: 'Carter',
      rarity: 2,
      rarityName: 'Epic Captain',
      icon: 'carter_icon',
      art: 'lvlup_carter',
      // Star 1's props string is '{}': no lines, so no entry.
      stars: { 2: [['Crypt exploration efficiency', '+5,0%'], ['Eagles of Resolve points', '315']] },
      // f12 [star][8]: the Might the star level adds.
      starMight: { 1: 0, 2: 420 },
    });
  });

  it('reads hero and captain levels (T10): XP thresholds, Stats ÷ 100, Might per level — each series once', () => {
    // [level, expRequired, reward, leadership, authority, dominance, effectId, clientInfo, might]
    const lv = (level: number, xp: Wire, might: number): Wire =>
      [level, xp, [{ 7: 1 }, {}], level * 1_000_000, level * 500_000, level * 250_000, 0, 0, might];
    const t = new Map(tables);
    t.set(TABLE_HERO_LEVELS, {
      1: [1, 0, 0, 0, 0, [], [], [lv(1, 0, 600), lv(2, 220, 40), lv(3, '9007199254740993n', 60)], [], [], [], 2, 0, [], [], 0],
      8: [8, 1, 0, 0, 0, [], [], [lv(1, 0, 300), lv(2, 110, 20), lv(3, 440, 30)], [], [], [], 1, 0, [], [], 8],
      20: [20, 1, 0, 0, 0, [], [], [lv(2, 110, 30), lv(1, 0, 450), lv(3, 440, 45)], [], [], [], 1, 0, [], [], 20],
      // A gap in the levels: indexing by level would lie, so it is left out.
      99: [99, 1, 0, 0, 0, [], [], [lv(1, 0, 1), lv(3, 9, 1)], [], [], [], 1, 0, [], [], 99],
    });
    const h = buildNames('v1', strings, vectors, t, en).heroLevels!;
    const s = (id: string, f: keyof NonNullable<typeof h>['heroes'][string]) => h.series[h.heroes[id][f]];
    expect(Object.keys(h.heroes).sort()).toEqual(['1', '20', '8']);
    expect(s('8', 'xp')).toEqual([0, 110, 440]);
    expect(s('1', 'xp')).toEqual([0, 220, 9007199254740992]);
    expect(s('8', 'leadership')).toEqual([10_000, 20_000, 30_000]);
    expect(s('8', 'authority')).toEqual([5_000, 10_000, 15_000]);
    expect(s('8', 'dominance')).toEqual([2_500, 5_000, 7_500]);
    expect(s('20', 'might')).toEqual([450, 30, 45]);
    // Captains 8 and 20 share XP and the Stats (rows sorted by level first); only Might differs.
    expect(h.heroes['20'].xp).toBe(h.heroes['8'].xp);
    expect(h.heroes['20'].leadership).toBe(h.heroes['8'].leadership);
    expect(h.heroes['20'].might).not.toBe(h.heroes['8'].might);
  });

  it("names a captain by its battler when the row's own name vector is wrong", () => {
    // id 28 in the real data: f5 says Hercules, the battler (and the sprites) are Helen.
    const helen = new Map([...en, ['battler_unit.name.helen', 'Helen']]);
    const helenStrings: Wire[] = [...strings, '{"smallIcon":"helen_icon","animationLinkage":"battler_helen_unit"}'];
    const t = new Map(tables);
    t.set(TABLE_CAPTAINS, { 28: [28, 2, 3, 0, 1, 7, 0, helenStrings.length - 1, [], [], {}, {}, {}, 0] });
    expect(buildNames('v1', helenStrings, vectors, t, helen).captains['28'].name).toBe('Helen');
  });

  it('reads clan medals (T62): name, unlock text, tier and its label, icon', () => {
    // Medal 23's real layout: f1 icon, f2 inactive icon, f3 requirement vector, f4 unlock text vector,
    // f5 name vector (shared by the medal's tiers), f6 tier, f7 group, f8 threshold.
    const medalStrings: Wire[] = [...strings, 'clan_medals.name.capitals_competition_bronze', 'clan_medals.description_unlock.capitals_competition_bronze', 'achievement_capitals_competition_bronze'];
    const base = strings.length;
    const medalVectors: Wire[] = [...vectors, [base], [base + 1]];
    const medalEn = new Map([
      ...en,
      ['clan_medals.name.capitals_competition_bronze', 'Medal of Prosperity'],
      ['clan_medals.description_unlock.capitals_competition_bronze', 'Clan members earned at least 1B points over the course of one Capital Challenge tournament.'],
      ['client_config.value.goblet_bronze', 'Bronze'],
    ]);
    const t = new Map(tables);
    t.set(TABLE_CLAN_MEDALS, { 23: [23, base + 2, 0, 0, vectors.length + 1, vectors.length, 1, 5, 1000000000, [2747], 1] });
    expect(buildNames('v1', medalStrings, medalVectors, t, medalEn).medals?.['23']).toEqual({
      name: 'Medal of Prosperity',
      description: 'Clan members earned at least 1B points over the course of one Capital Challenge tournament.',
      tier: 1,
      tierName: 'Bronze',
      icon: 'achievement_capitals_competition_bronze',
    });
  });

  it('reads terrain names (T4 f2) for chat tile shares', () => {
    // T4 113's real layout: [id, …, f2 name vector, …].
    const terrainStrings: Wire[] = [...strings, 'terrain_type.name.n0004'];
    const terrainVectors: Wire[] = [...vectors, [strings.length]];
    const t = new Map(tables);
    t.set(TABLE_TERRAINS, { 113: [113, 9004, terrainVectors.length - 1, 40, 1545, 1489] });
    const n = buildNames('v1', terrainStrings, terrainVectors, t, new Map([...en, ['terrain_type.name.n0004', 'Forested hills']]));
    expect(n.terrains?.['113']).toBe('Forested hills');
  });

  it('reads items (T8): kind, quality grade, a pack\'s fixed resource amount, a speedup\'s duration', () => {
    // A T8 payload as the game ships it: [grants, units, items, items, 51, 51, 0, 0, 0, {}, 51, effects, 0, 51, 0, {}].
    const payload = (grants: Record<string, number>, effects: Record<string, number> = {}): Wire =>
      [grants, {}, [], [], 51, 51, 0, 0, 0, {}, 51, effects, 0, 51, 0, {}];
    const entry = (grants: Record<string, number>, weight = 1, effects?: Record<string, number>): Wire =>
      [[2747], weight, payload(grants, effects), 0];
    // [id, kind, max, name, desc, f5, f6 visual, f7 grants, f8 seconds, f9, f10 quality, f11, f12 VIP seconds, f13, f14, f15, f16]
    const row = (id: number, kind: number, f7: Wire, { f8 = 0, f10 = 0, f12 = 0 } = {}): Wire =>
      [id, kind, 999999, 0, 0, 0, 0, f7, f8, 0, f10, 0, f12, 0, 0, 0, [{}]];
    const t = new Map(tables);
    t.set(TABLE_GIFT_TYPES, {
      1123: row(1123, 2, [[entry({ 2: 250000 })]]), // "Silver": 250,000 Silver
      74009: row(74009, 2, [[entry({ 3: 250000, 4: 250000, 5: 250000 })]]), // building resources: all three
      2007: row(2007, 3, [[]], { f8: 28800 }), // Speedup, 8 h
      2053: row(2053, 11, [[]], { f8: 54000 }), // Clan Speedup, 15 h
      3006: row(3006, 6, [[]], { f12: 86400 }), // VIP status, 1 day
      535: row(535, 7, [[]], { f10: 2 }), // Cerberus Fang, grade 2
      1139: row(1139, 2, [[entry({}, 1, { 7803: 21600 })]]), // Army strength booster: an effect, no grant
      73336: row(73336, 2, [[entry({ 80506: 10 }, 50), entry({ 3: 5000 }, 50)]]), // a draw: no fixed grant
      40102: row(40102, 2, [[entry({ 125: 50000000 })]]), // grants an item, not a base resource
      1157: row(1157, 10, [[entry({ 1: 100 }, 1), entry({ 2: 5 }, 1)]], { f10: 6 }), // Golden Chest
      9: [9, 'x', 0, 0], // no kind: no item
    });
    // Every row here is named by vector 0 (f3 = 0 → "Infernal Chest"): only named rows become items.
    const n = buildNames('v1', strings, vectors, t, en);
    expect(n.items?.['1123']).toEqual({ kind: 2, grants: { 2: 250000 } });
    expect(n.items?.['74009']).toEqual({ kind: 2, grants: { 3: 250000, 4: 250000, 5: 250000 } });
    expect(n.items?.['2007']).toEqual({ kind: 3, seconds: 28800 });
    expect(n.items?.['2053']).toEqual({ kind: 11, seconds: 54000 });
    expect(n.items?.['3006']).toEqual({ kind: 6, seconds: 86400 });
    expect(n.items?.['535']).toEqual({ kind: 7, quality: 2 });
    expect(n.items?.['1139']).toEqual({ kind: 2 });
    expect(n.items?.['73336']).toEqual({ kind: 2 });
    expect(n.items?.['40102']).toEqual({ kind: 2 });
    expect(n.items?.['1157']).toEqual({ kind: 10, quality: 6 });
    expect(n.items?.['9']).toBeUndefined();
    expect(NAMES_FORMAT).toBeGreaterThanOrEqual(10);
  });

  it('a fixed grant is one entry of base resources and nothing else', () => {
    const p = (grants: Wire, extra: Partial<Record<number, Wire>> = {}): Wire => {
      const out: Wire[] = [grants, {}, [], [], 51, 51, 0, 0, 0, {}, 51, {}, 0, 51, 0, {}];
      for (const [i, v] of Object.entries(extra)) out[Number(i)] = v as Wire;
      return [[[[2747], 1, out, 0]]];
    };
    expect(fixedResourceGrants(p({ 2: 7500 }))).toEqual({ 2: 7500 });
    expect(fixedResourceGrants(p({ 2: 7500 }, { 2: [[3006, 1]] }))).toBeUndefined(); // also gives an item
    expect(fixedResourceGrants(p({ 2: 7500 }, { 11: { 7803: 21600 } }))).toBeUndefined(); // also a timed effect
    expect(fixedResourceGrants(p({ 2: 0 }))).toBeUndefined();
    expect(fixedResourceGrants(p({}))).toBeUndefined();
    expect(fixedResourceGrants([[]])).toBeUndefined();
    expect(fixedResourceGrants(undefined)).toBeUndefined();
  });

  it('drops names that resolve to a JSON fragment', () => {
    const n = buildNames('v1', strings, vectors, tables, en);
    expect(n.gifts['7']).toBeUndefined();
  });

  it('decodes only the requested tables, skipping the rest unbuilt', () => {
    const buf = encodeValues([[{ 1: ['a'] }, { 2: ['b', [1, 2, 3]] }, { 3: ['c'] }]]);
    const t = readTables(buf, [1]);
    expect([...t.keys()]).toEqual([1]);
    expect(t.get(1)).toEqual({ 2: ['b', [1, 2, 3]] });
  });

  it('keys an array table (T1, the client config) by row index', () => {
    const buf = encodeValues([[[['k1', 'j1'], ['k2', 'j2']], { 3: ['c'] }]]);
    expect(readTables(buf, [0]).get(0)).toEqual({ 0: ['k1', 'j1'], 1: ['k2', 'j2'] });
  });
});

describe('translations', () => {
  it('parses the key,text CSV with quotes, escaped quotes and embedded newlines', () => {
    const csv = '"__translationfile__.lang","en_US"\n"a","Plain"\n"b","Say ""hi"""\n"c","two\nlines"\n';
    const m = parseTranslationsCsv(csv);
    expect(m.get('a')).toBe('Plain');
    expect(m.get('b')).toBe('Say "hi"');
    expect(m.get('c')).toBe('two\nlines');
  });

  it('keeps only the asked-for keys when given a set', () => {
    const m = parseTranslationsCsv('"a","A"\n"b","B"\n"c","C"\n', new Set(['a', 'c', 'z']));
    expect([...m]).toEqual([['a', 'A'], ['c', 'C']]);
  });

  it('extracts the deflated CSV from the translations zip', () => {
    const name = Buffer.from('c1b577f1a3edf352');
    const content = Buffer.from('"a","Plain"\n');
    const data = zlib.deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const cdOffset = local.length + name.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    const zip = Buffer.concat([local, name, data, central, name, eocd]);
    expect(unzipFirst(zip).toString('utf8')).toBe('"a","Plain"\n');
  });
});
