/**
 * Artifacts (T110–T113 + city field 14) and captain equipment (T11 + T8 inserts
 * + city fields 9/10): the static tables become names.json entries, and a
 * city's effects / item instances become what the Captains tab shows. All data
 * here is hand-written in the game's layout (Nov 2026) with made-up ids, never
 * game bytes.
 */
import { describe, expect, it } from 'vitest';
import { encodeValues, type Wire } from '../../src/game-protocol/codec.js';
import {
  TABLE_ARTIFACTS,
  TABLE_ARTIFACT_BONUSES,
  TABLE_ARTIFACT_LEVELS,
  TABLE_ARTIFACT_STARS,
  TABLE_EQUIPMENT,
  TABLE_GIFT_TYPES,
  asIdRecord,
  buildNames,
  readTables,
} from '../../src/game-protocol/static-data.js';
import { artifactsFromEffects, describeArtifact } from '../../src/game-protocol/artifacts.js';
import { captainEquipment, describeItem } from '../../src/game-protocol/equipment.js';

const strings: Wire[] = [
  '{"icon":"artifact_olympic_torch_icon","animation":"artifact_animation_olympic_torch"}', // 0
  'artifact.name.olympic_torch', // 1
  '{"props":[{"propText":"levels.client_config.props.all_crypt_effectiveness","propValue":"+20.0%"}]}', // 2
  '{"props":[{"propText":"levels.client_config.props.all_crypt_effectiveness","propValue":"+22.0%"}]}', // 3
  '{"props":[{"propText":"levels.client_config.props.all_crypt_effectiveness","propValue":"+128.0%"}]}', // 4
  '{"props":[{"propText":"levels.client_config.props.all_crypt_effectiveness","propValue":"+130.0%"}]}', // 5
  'levels.client_config.props.bonus_epic_crypt', // 6
  '+100%', // 7
  'levels.client_config.props.bonus_rare_crypt', // 8
  '+50%', // 9
  'arch_body', // 10
  'equipment.name.claw_coat', // 11
  '{"props":[{"icon":"","propText":"equipment.client_info.n0019","propValue":"+50,0%"},{"icon":"","isEffect":0,"propText":"equipment.client_info.n0001","propValue":"30"}]}', // 12
  'item.name.amber', // 13
  '{"icon":"oval_orange_gem_72"}', // 14
  'item.name.pioneer', // 15
  '{"icon":"ench_page_exploration_72"}', // 16
];
const vectors: Wire[] = [
  [1], // 0: Torch of Olympus
  [11], // 1: Cursed Claw Coat
  [13], // 2: Amber
  [15], // 3: Pioneer Enchantment
];
const en = new Map([
  ['artifact.name.olympic_torch', 'Torch of Olympus'],
  ['client.artifact.window.artifact.legendary_rarity', 'Legendary'],
  ['levels.client_config.props.all_crypt_effectiveness', 'Crypt exploration efficiency'],
  ['levels.client_config.props.bonus_epic_crypt', 'Epic Crypt exploration efficiency'],
  ['levels.client_config.props.bonus_rare_crypt', 'Rare Crypt exploration efficiency'],
  ['equipment.name.claw_coat', 'Cursed Claw Coat'],
  ['equipment.client_info.n0019', 'Crypt exploration efficiency'],
  ['equipment.client_info.n0001', 'Durability'],
  ['client.craft.gold_item_title', 'Godlike'],
  ['item.name.amber', 'Amber'],
  ['item.name.pioneer', 'Pioneer Enchantment'],
]);

// Artifact type 16 with two levels, two star levels and two possible rolls.
const tables = new Map<number, Record<string, Wire>>([
  [TABLE_ARTIFACTS, { 16: [[16], [16], [16], [16], [{ 701116: 50 }, {}, 1], [], [], 0, 0, 0, 0, 5] }],
  [TABLE_ARTIFACT_STARS, { 16: [[16], { 1: [1, 1, 9375, [{}, {}, 1], 2, 400000, []], 21: [21, 5, 9395, [{}, {}, 1], 3, 800000, []] }] }],
  [TABLE_ARTIFACT_LEVELS, { 16: [[16], 701100, { 49: [49, 8948, [], 1000, 4, 0], 50: [50, 8949, [], 1100, 5, 0] }] }],
  [TABLE_ARTIFACT_BONUSES, { 16: [[16], { 9681: [15, 6, 7, 5], 9686: [75, 8, 9, 4] }, []] }],
  [TABLE_EQUIPMENT, { 4423: [4423, 6, 10, 1, 3, 8, 0, 30, [{}, {}, 1], 12, [{}, {}, 1], [], 0, 0, 0] }],
  [TABLE_GIFT_TYPES, {
    257: [257, 8, 99999, 2, 0, 2, 14, [[]], 0, 0, 6],
    8408: [8408, 9, 99999, 3, 0, 2, 16, [[]], 0, 0, 5],
  }],
]);

const names = buildNames('v1', strings, vectors, tables, en);

describe('artifact and equipment names from static data', () => {
  it('reads an artifact type: name, rarity, icon, and each level / star level / roll by effect id', () => {
    expect(names.artifacts?.['16']).toEqual({
      name: 'Torch of Olympus',
      rarity: 5,
      rarityName: 'Legendary',
      icon: 'artifact_olympic_torch_icon',
      maxLevel: 50,
      maxStar: 21,
      levels: {
        8948: [49, [['Crypt exploration efficiency', '+128.0%']]],
        8949: [50, [['Crypt exploration efficiency', '+130.0%']]],
      },
      stars: {
        9375: [1, [['Crypt exploration efficiency', '+20.0%']]],
        9395: [21, [['Crypt exploration efficiency', '+22.0%']]],
      },
      bonuses: {
        9681: ['Epic Crypt exploration efficiency', '+100%', 5],
        9686: ['Rare Crypt exploration efficiency', '+50%', 4],
      },
    });
  });

  it('reads equipment by item type with its grade and bonuses (durability left out), and gems / enchantments', () => {
    expect(names.equipment?.['4423']).toEqual({
      name: 'Cursed Claw Coat', icon: 'arch_body', grade: 8, lines: [['Crypt exploration efficiency', '+50,0%']],
    });
    expect(names.equipmentGrades?.['8']).toBe('Godlike');
    expect(names.inserts).toEqual({
      257: { name: 'Amber', icon: 'oval_orange_gem_72', kind: 'gem' },
      8408: { name: 'Pioneer Enchantment', icon: 'ench_page_exploration_72', kind: 'enchantment' },
    });
  });

  it('reads $pairs tables keyed [id] like plain ones, and leaves other tables as they were', () => {
    expect(asIdRecord({ $pairs: [[[16], ['a']], [[17], ['b']]] })).toEqual({ 16: ['a'], 17: ['b'] });
    expect(asIdRecord({ 3: ['c'] })).toEqual({ 3: ['c'] });
    expect(asIdRecord([1, 2])).toBeNull();
    const buf = encodeValues([[{ 1: ['a'] }, { $pairs: [[[7], ['b']]] }, { 3: ['c'] }]]);
    const t = readTables(buf, [0, 1]);
    expect(t.get(0)).toEqual({ 1: ['a'] });
    expect(t.get(1)).toEqual({ 7: ['b'] });
    expect(t.has(2)).toBe(false);
  });
});

describe('artifacts from a city\'s active effects', () => {
  it('finds the worn artifact with its level, star level and rolls (a doubled roll counted twice)', () => {
    const effects = [
      { id: 1215, source: 2, count: 1 }, // research — not an artifact
      { id: 8949, source: 16384, count: 1 },
      { id: 9395, source: 8192, count: 1 },
      { id: 9686, source: 1, count: 2 },
      { id: 9681, source: 1, count: 1 },
    ];
    expect(artifactsFromEffects(effects, names.artifacts)).toEqual([{ type: 16, level: 50, star: 21, bonuses: [9681, 9686, 9686] }]);
    expect(artifactsFromEffects(effects, undefined)).toEqual([]);
    expect(artifactsFromEffects([{ id: 1215, source: 2, count: 1 }], names.artifacts)).toEqual([]);
  });

  it('describes it like the artifact book: level line, star line, best roll first', () => {
    const v = describeArtifact(16, 50, 21, [9686, 9681], names.artifacts);
    expect(v).toMatchObject({
      name: 'Torch of Olympus', rarityName: 'Legendary', maxLevel: 50, maxStar: 21,
      levelLines: [['Crypt exploration efficiency', '+130.0%']],
      starLines: [['Crypt exploration efficiency', '+22.0%']],
      bonusLines: [
        { text: 'Epic Crypt exploration efficiency', value: '+100%', quality: 5 },
        { text: 'Rare Crypt exploration efficiency', value: '+50%', quality: 4 },
      ],
    });
    expect(describeArtifact(99, 1, 1, [], names.artifacts).name).toBe('#99');
  });
});

describe('captain equipment', () => {
  it('joins the captain\'s six positions to the item instances, skipping empty and unknown uids', () => {
    const captains = [{ id: 8, level: 200, stars: 6, xp: 0, slot: 1, equipment: ['', '', '', 'u1', 'u9', 'u2'] }];
    const items = [
      { uid: 'u1', type: 4423, enchantment: 8408, gems: [257], presetId: 128, raw: [1000, 10, 40, 0] },
      { uid: 'u2', type: 4430, enchantment: 0, gems: [], presetId: 128, raw: [1000, 6, 36, 0] },
    ];
    expect(captainEquipment(captains, items)).toEqual([
      { captainId: 8, position: 3, uid: 'u1', type: 4423, enchantment: 8408, gems: [257], raw: [1000, 10, 40, 0] },
      { captainId: 8, position: 5, uid: 'u2', type: 4430, enchantment: 0, gems: [], raw: [1000, 6, 36, 0] },
    ]);
  });

  it('describes an item with its grade, bonuses, enchantment and gems', () => {
    expect(describeItem(4423, 8408, [257], names)).toEqual({
      name: 'Cursed Claw Coat', grade: 8, gradeName: 'Godlike', icon: 'arch_body',
      lines: [['Crypt exploration efficiency', '+50,0%']],
      enchantment: { id: 8408, name: 'Pioneer Enchantment' },
      gems: [{ id: 257, name: 'Amber' }],
    });
    expect(describeItem(1, 0, [], names)).toMatchObject({ name: '#1', grade: 0, enchantment: null, gems: [] });
  });
});
