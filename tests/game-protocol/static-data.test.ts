import zlib from 'zlib';
import { describe, expect, it } from 'vitest';
import { encodeValues, type Wire } from '../../src/game-protocol/codec.js';
import {
  TABLE_GIFT_TYPES,
  TABLE_HEROES,
  TABLE_MAP_OBJECTS,
  TABLE_TECHS,
  buildNames,
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
];
const vectors: Wire[] = [
  [1], // 0: Infernal Chest
  [2, 3, 4], // 1: Level 15 Crypt
  [5], // 2: Archers I
  [6, 7, 8], // 3: Sacred Potion production %level% → I
  [9], // 4: Garvel
  [11], // 5: Vault of the Ancients
  [12], // 6: JSON fragment, not a name
];
const en = new Map([
  ['item.name.n0176', 'Infernal Chest'],
  ['Level %value% Crypt', 'Level %value% Crypt'],
  ['tech.name.n1197', 'Archers I'],
  ['tech.name.n0020', 'Sacred Potion production %level%'],
  ['hero_avatar.avatar_name.n0001', 'Garvel'],
  ['map_object.vault', 'Vault of the Ancients'],
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
});

describe('translations', () => {
  it('parses the key,text CSV with quotes, escaped quotes and embedded newlines', () => {
    const csv = '"__translationfile__.lang","en_US"\n"a","Plain"\n"b","Say ""hi"""\n"c","two\nlines"\n';
    const m = parseTranslationsCsv(csv);
    expect(m.get('a')).toBe('Plain');
    expect(m.get('b')).toBe('Say "hi"');
    expect(m.get('c')).toBe('two\nlines');
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
