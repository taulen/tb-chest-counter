import { describe, expect, it } from 'vitest';
import { encodeValues, type Wire } from '../../src/game-protocol/codec.js';
import { TABLE_TECHS } from '../../src/game-protocol/static-data.js';
import {
  TABLE_CLIENT_CONFIG,
  asTreeLayout,
  buildTechTrees,
  readAnyTables,
  readBranches,
  type TreeLayout,
  type TreeSources,
} from '../../src/game-protocol/tech-trees.js';
import {
  jsonTextAssets,
  lz4BlockDecompress,
  parseAssetCatalog,
  unityFsPayload,
} from '../../src/game-protocol/unity-assets.js';

// ---------------------------------------------------------------------------
// A miniature of the game's static data, built through an interning pool so
// the refs stay readable. Synthetic throughout — no game bytes.
// ---------------------------------------------------------------------------

const strings: Wire[] = ['gabp4k80'];
const s = (v: string): number => {
  const i = strings.indexOf(v);
  if (i >= 0) return i;
  strings.push(v);
  return strings.length - 1;
};
const vectors: Wire[] = [];
const vec = (...refs: number[]): number => {
  vectors.push(refs);
  return vectors.length - 1;
};

/** A T21 row: [id, nameVec, descVec, icon, branch, {level: [level, …, [cond], …]}]. */
function tech(id: number, name: string, branch: number, conds: string[], opts: { desc?: string; icon?: string } = {}): Wire {
  const levels: Record<string, Wire> = {};
  conds.forEach((c, i) => {
    levels[String(i + 1)] = [i + 1, 0, 0, [s(c)], 0, 0, 0];
  });
  return [id, vec(s(`tech.name.${id}`)), vec(s(opts.desc ?? `tech.desc.${id}`)), s(opts.icon ?? `tech_${id}_72`), branch, levels];
}

const academy = {
  branches: [
    { id: 1, name: 'cfg.b1.name', description: 'cfg.b1.desc', tree: 'guardTree', type: 'tech', visual: 'tech_guards_new' },
    { id: 6, name: 'cfg.b6.name', description: '', tree: 'pvpTree', type: 'tech', visual: 'tech_army_new' },
    { id: 12, name: 'cfg.b12.name', tree: 'clanTree12', type: 'tech', visual: 'clan_fort_72' },
    { id: 17, name: 'cfg.b12.name', tree: 'clanTalentsTree17', type: 'clanTalents', visual: 'clan_fort_72' },
    { id: 18, name: 'cfg.b18.name', tree: 'heroTree25', type: 'heroAbility', visual: 'talent_72' },
    { id: 30, name: 'cfg.b30.name', tree: 'neverShippedTree', type: 'tech', visual: 'x_72' },
  ],
  order: [6, 1],
  tabs: [
    { id: 1, name: 'cfg.tab1', branches: [1] },
    { id: 2, name: 'cfg.tab2', branches: [6] },
  ],
};
const heroInfo = {
  branch: { id: 14, name: 'cfg.talents', tree: 'heroTree14', type: 'heroAbility', visual: 'old_72' },
  branches: [18],
  unrelated: { nested: [{ id: 99, label: 'not a branch' }] },
};

const en = new Map<string, string>([
  ['cfg.b1.name', 'Guardsmen I'],
  ['cfg.b1.desc', 'Train and upgrade guardsmen.'],
  ['cfg.b6.name', 'Army modernization'],
  ['cfg.b12.name', 'Clan territories'],
  ['cfg.b18.name', 'Battle tactics'],
  ['cfg.talents', 'Talents'],
  ['cfg.tab1', 'Unlock'],
  ['cfg.tab2', 'Boost'],
  ['tech.name.1197', 'Archers I'],
  ['tech.name.1198', 'Spearmen I'],
  ['tech.name.1200', "Guardsmen's training cost I"],
  ['tech.name.700', 'Army strength I'],
  ['tech.name.25000', "Guardsmen's training speed I"],
  ['tech.desc.1197', 'Allows you to train archers I.'],
  ['tech.desc.retired', '(!!!)Irrelevant(!!!)'],
]);

const t1: Wire = [
  [s('academy/branches'), s(JSON.stringify(academy))],
  [s('hero_info'), s(JSON.stringify(heroInfo))],
  [s('clan'), s(JSON.stringify({ branches: [17] }))],
  [s('broken'), s('{not json')],
];
const t21: Record<string, Wire> = {
  1197: tech(1197, 'Archers I', 1, ['Enabled()']),
  1198: tech(1198, 'Spearmen I', 1, ['!HasTech(1198,1,1)', 'HasTech(1198,1,10)']),
  1200: tech(1200, "Guardsmen's training cost I", 1, [
    'HasTech(1197,1,10)&&HasTech(1198,2,10)&&HasBuildingLevel(1,5,1)',
    'HasTech(1200,1,10)',
    'HasTech(1200,2,10)&&HasTech(700,3,10)&&HasTech(1197,1,10)',
  ], { desc: 'tech.desc.retired' }),
  700: tech(700, 'Army strength I', 6, ['Enabled()'], { icon: '{}' }),
  25000: tech(25000, '', 18, ['HasLevel(25,0)&&!HasTech(25000,1,1)', 'HasTech(25000,1,1)']),
  10000: tech(10000, '', 12, ['Enabled()']),
  7000: tech(7000, '', 17, ['Enabled()']),
  3000: tech(3000, '', 14, ['Enabled()']),
  9999: tech(9999, '', 1, ['Enabled()']),
};

const src: TreeSources = {
  strings,
  vectors,
  tables: new Map<number, Wire>([[TABLE_CLIENT_CONFIG, t1], [TABLE_TECHS, t21]]),
  en,
};

const layouts: TreeLayout[] = [
  { name: 'guardTree', techs: [{ id: 1197, x: 0, y: 0 }, { id: 1198, x: 0, y: -330 }, { id: 1200, x: 391, y: -165 }, { id: 4242, x: 780, y: 0 }] },
  { name: 'pvptree', techs: [{ id: 700, x: 195, y: -81 }] },
  { name: 'heroTree25', techs: [{ id: 25000, x: 0, y: 1 }] },
  { name: 'clanTree12', techs: [{ id: 10000, x: 0, y: 0 }] },
  { name: 'clanTalentsTree17', techs: [{ id: 7000, x: 0, y: 0 }] },
  { name: 'heroTree14', techs: [{ id: 3000, x: 0, y: 0 }] },
  { name: 'strayTree', techs: [{ id: 1197, x: 0, y: 0 }] },
];

describe('tech trees from static data + client layouts', () => {
  const built = buildTechTrees('v1', src, layouts);
  const tree = (id: number) => built.trees.find((t) => t.id === id)!;

  it('finds every declared tree in the client config, wherever it is declared', () => {
    expect(readBranches(src).map((b) => b.id).sort((a, b) => a - b)).toEqual([1, 6, 12, 14, 17, 18, 30]);
    expect(readBranches(src).find((b) => b.id === 14)).toEqual({
      id: 14, name: 'Talents', description: '', tree: 'heroTree14', type: 'heroAbility', visual: 'old_72',
    });
  });

  it('keeps trees that have a layout, in the game order: academy order, talents, then by id', () => {
    expect(built.version).toBe('v1');
    expect(built.trees.map((t) => t.id)).toEqual([6, 1, 18, 12, 14, 17]);
  });

  it('classifies research, talents, clan trees and the retired talent tree', () => {
    expect(built.trees.map((t) => [t.id, t.kind, t.tab])).toEqual([
      [6, 'research', 'Boost'],
      [1, 'research', 'Unlock'],
      [18, 'talent', null],
      [12, 'clan', null],
      [14, 'other', null],
      [17, 'clan', null],
    ]);
  });

  it('carries the tree name, description, icon and layout name', () => {
    expect(tree(1)).toMatchObject({ name: 'Guardsmen I', description: 'Train and upgrade guardsmen.', icon: 'tech_guards_new', layout: 'guardTree' });
    expect(tree(17).name).toBe('Clan territories');
  });

  it('places nodes on the grid, skipping layout ids the tech table lacks', () => {
    expect(tree(1).nodes.map((n) => [n.techId, n.col, n.row])).toEqual([[1197, 0, 0], [1198, 0, 2], [1200, 1, 1]]);
    expect(tree(6).nodes.map((n) => [n.col, n.row])).toEqual([[0.5, 0.5]]);
    expect(Object.is(tree(18).nodes[0].row, 0)).toBe(true);
  });

  it('resolves names, max levels, and drops placeholder descriptions and non-sprite icons', () => {
    const [archers, , cost] = tree(1).nodes;
    expect(archers).toMatchObject({ name: 'Archers I', description: 'Allows you to train archers I.', icon: 'tech_1197_72', maxLevel: 1 });
    expect(cost).toMatchObject({ name: "Guardsmen's training cost I", description: '', maxLevel: 3 });
    expect(tree(6).nodes[0].icon).toBe('');
  });

  it('reads prerequisites from the level conditions: other techs only, first level that asks', () => {
    const [archers, spearmen, cost] = tree(1).nodes;
    expect(archers.requires).toEqual([]);
    expect(spearmen.requires).toEqual([]);
    expect(cost.requires).toEqual([
      { techId: 1197, level: 1, atLevel: 1 },
      { techId: 1198, level: 2, atLevel: 1 },
      { techId: 700, level: 3, atLevel: 3 },
    ]);
    expect(tree(18).nodes[0].requires).toEqual([]);
  });

  it('builds nothing from a missing client config', () => {
    const bare: TreeSources = { ...src, tables: new Map<number, Wire>([[TABLE_TECHS, t21]]) };
    expect(buildTechTrees('v1', bare, layouts).trees).toEqual([]);
  });

  it('accepts only well-formed layout JSON', () => {
    expect(asTreeLayout({ name: 'guardTree', techs: [{ id: 1, x: 0, y: -165, linkType: '_1_1' }, { id: 'x' }] })).toEqual({
      name: 'guardTree', techs: [{ id: 1, x: 0, y: -165 }],
    });
    expect(asTreeLayout({ techs: [] })).toBeNull();
    expect(asTreeLayout([1, 2])).toBeNull();
  });

  it('decodes array tables (the client config) as well as keyed ones, skipping the rest', () => {
    const buf = encodeValues([[[[1, 2]], { 5: ['x'] }, { 7: ['y'] }]]);
    const t = readAnyTables(buf, [0, 2]);
    expect([...t.keys()]).toEqual([0, 2]);
    expect(t.get(0)).toEqual([[1, 2]]);
    expect(t.get(2)).toEqual({ 7: ['y'] });
  });
});

// ---------------------------------------------------------------------------
// Unity asset delivery: catalog, LZ4, UnityFS, JSON TextAssets
// ---------------------------------------------------------------------------

const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const be16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const be64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

/** A valid LZ4 block holding `data` as one literal run. */
function lz4Literals(data: Buffer): Buffer {
  const head: number[] = [];
  if (data.length < 15) head.push(data.length << 4);
  else {
    head.push(0xf0);
    let rest = data.length - 15;
    for (; rest >= 255; rest -= 255) head.push(255);
    head.push(rest);
  }
  return Buffer.concat([Buffer.from(head), data]);
}

/** A one-block UnityFS bundle; method 0 = stored, 2 = LZ4 (block table and data). */
function unityFs(payload: Buffer, method: 0 | 2): Buffer {
  const block = method ? lz4Literals(payload) : payload;
  const info = Buffer.concat([
    Buffer.alloc(16), be32(1), be32(payload.length), be32(block.length), be16(method),
    be32(1), be64(0), be64(payload.length), be32(4), Buffer.from('CAB-test\0', 'latin1'),
  ]);
  const infoBlock = method ? lz4Literals(info) : info;
  const head = Buffer.from('UnityFS\0\0\0\0\x065.x.x\x002019.4.8f1\0', 'latin1');
  const total = head.length + 8 + 12 + infoBlock.length + block.length;
  return Buffer.concat([head, be64(total), be32(infoBlock.length), be32(info.length), be32(0x40 | method), infoBlock, block]);
}

describe('Unity asset delivery', () => {
  it('maps asset names (case-insensitively) to their bundle via the catalog', () => {
    const str = (v: string) => Buffer.concat([le32(Buffer.byteLength(v)), Buffer.from(v)]);
    const entry = (name: string, kind: number, bundle: string, assets: string[]) =>
      Buffer.concat([str(name), le32(kind), Buffer.alloc(16, 0xaa), Buffer.from(bundle, 'hex'), le32(assets.length), ...assets.map(str)]);
    const cat = Buffer.concat([
      Buffer.from([0x49, 0x17, 0x50, 0x2e, 0x30, 0x38, 0, 0]),
      entry('guardtree', 4, '00112233445566778899aabbccddeeff', ['guardtree']),
      entry('masks', 2, 'ffeeddccbbaa99887766554433221100', ['a_mask', 'B_Mask']),
    ]);
    const m = parseAssetCatalog(cat);
    expect(m.get('guardtree')).toEqual({ name: 'guardtree', kind: 4, bundle: '00112233445566778899aabbccddeeff', assets: ['guardtree'] });
    expect(m.get('b_mask')?.bundle).toBe('ffeeddccbbaa99887766554433221100');
    expect(() => parseAssetCatalog(Buffer.from('nope'))).toThrow(/catalog/);
    expect(() => parseAssetCatalog(cat.subarray(0, cat.length - 3))).toThrow(/truncated/);
  });

  it('decompresses LZ4 blocks with matches and extended lengths', () => {
    // "abc" then a 9-byte match at offset 3 → abcabcabcabc
    expect(lz4BlockDecompress(Buffer.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00]), 12).toString()).toBe('abcabcabcabc');
    // 1 literal "z", then a match of 4+15+1 = 20 at offset 1 (extended match length)
    expect(lz4BlockDecompress(Buffer.from([0x1f, 0x7a, 0x01, 0x00, 0x01]), 21).toString()).toBe('z'.repeat(21));
    const long = Buffer.from('x'.repeat(300));
    expect(lz4BlockDecompress(lz4Literals(long), 300).equals(long)).toBe(true);
    expect(() => lz4BlockDecompress(Buffer.from([0x10, 0x61, 0x05, 0x00]), 10)).toThrow(/offset/);
  });

  it('finds a JSON TextAsset by its length prefix in stored and LZ4 bundles', () => {
    const json = JSON.stringify({ name: 'guardTree', techs: [{ id: 1, x: 0, y: 0, link: { type: '_1_1' } }] });
    const payload = Buffer.concat([
      Buffer.from([0, 1, 2, 3, 0x7b, 0, 0, 0]), // a stray "{" with no sensible length before it
      le32(json.length), Buffer.from(json), Buffer.alloc(3),
    ]);
    for (const method of [0, 2] as const) {
      const bundle = unityFs(payload, method);
      expect(unityFsPayload(bundle).equals(payload)).toBe(true);
      expect(jsonTextAssets(bundle)).toEqual([JSON.parse(json)]);
    }
    expect(() => unityFsPayload(Buffer.from('UnityWeb\0'))).toThrow(/UnityFS/);
  });
});
