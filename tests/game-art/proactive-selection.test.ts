// Extract before a page needs it (Nov 18 2026): My Clan showed "Clan
// territories" without its picture because nothing had "wanted" clan_fort_4_72.
// Every tree's picture, every sprite name in names.json and every UI icon in
// the catalogue are now selected by construction; the pipeline skips oversized
// catch-all pictures, retries downloads that failed, and never fails a run on a
// catch-all bundle. Synthetic names and bundles only — no game bytes.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildArtStatic, type ArtStatic } from '../../src/game-art/art-static.js';
import {
  ART_KEYS, LIBRARY_ART, LIBRARY_DENY, LIBRARY_MAX_SIDE, artNamesFromGameNames, isLibraryArt, selectArt,
} from '../../src/game-art/selection.js';
import { ART_SELECTION_VERSION, CATALOG_NAMES_FILE, ensureGameArt, gameArtUrl, loadIndex, resetGameArtMemo } from '../../src/game-art/store.js';
import { CLASS_TEXTURE2D } from '../../src/game-art/serialized-file.js';
import { VERSIONS_URL, UNITY_BASE } from '../../src/game-art/catalog.js';
import { buildBundle, buildSerializedFile, patternPixels, TEXTURE2D_TREE } from './synthetic-bundle.js';

const emptyStatic = (over: Partial<ArtStatic> = {}): ArtStatic => ({
  version: 'v-test', heroes: {}, units: [], techs: {}, items: [], captains: {}, ...over,
});

describe("trees' own pictures (T1 branches)", () => {
  it('buildArtStatic reads every research, talent and clan tree picture from the client config', () => {
    const config = JSON.stringify({ tabs: [], branches: [
      { id: 12, tree: 'clanTree', type: 'clan', name: 'k.clan', visual: 'clan_fort_4_72' },
      { id: 1, tree: 'guardTree', type: 'research', name: 'k.guards', visual: 'tech_guards_new' },
      { id: 30, tree: 'oddTree', type: 'research', name: 'k.odd', visual: 'not a sprite!' },
    ] });
    const st = buildArtStatic('v-test', ['academy/branches', config], [], new Map([[1, { 0: [0, 1] }]]),
      new Map([['k.clan', 'Clan territories'], ['k.guards', 'Guardsmen I']]));
    expect(st.branches).toEqual({
      12: { name: 'Clan territories', visual: 'clan_fort_4_72' },
      1: { name: 'Guardsmen I', visual: 'tech_guards_new' },
    });
  });

  it('selects a tree picture as research, size suffix or not', () => {
    const st = emptyStatic({ branches: { 12: { name: 'Clan territories', visual: 'Clan_Fort_4_72' }, 1: { name: 'Guardsmen I', visual: 'tech_guards_new' } } });
    const sel = selectArt(['clan_fort_4_72', 'tech_guards_new'], st);
    expect(Object.fromEntries(sel)).toEqual({ clan_fort_4_72: 'research', tech_guards_new: 'research' });
  });
});

describe('names.json sprite names (`named`)', () => {
  // Shaped like static-data.ts GameNames: every kind of field that names art.
  const names = {
    heroes: { 1: { name: 'Hero', icon: 'hero_a_icon' } },
    medals: { 3: { name: 'Medal', icon: 'achievement_x_gold', inactiveIcon: 'achievement_x_gold_inactive', tierName: 'Gold' } },
    factions: { 1: { key: 'red', art: { stainedGlass: 'stainedglass_red', icon: 'fraction_red', banner: 'fraction_banner_red', frameIcon: 'fraction_on_frame_red' } } },
    dragon: { name: 'Dragon', art: { frame: 'frame_icon_red_dragon', back: 'red_dragon_back' }, stages: { 1: { icon: 'icon_red_dragon_1', art: 'red_dragon_1' } } },
    titles: { 29: { name: 'Prefect', description: 'x', source: 'y', seconds: 1, icon: 'perfect_28', art: 'bonus_perfect_72' } },
    captains: { 4: { name: 'Carter', rarityName: 'Epic', icon: 'carter_icon', art: 'carter_art' } },
    artifacts: { 5: { name: 'Pearl', icon: 'artifact_pearl_icon' } },
    items: { 6: { name: 'Thing', icon: 'thing_icon_pic' } },
    events: { 7: { code: 'ancients', titleKey: 'events.title', title: 'Ancients' } },
  };

  it('collects every sprite name by key, at any depth; nothing else', () => {
    expect([...artNamesFromGameNames(names)].sort()).toEqual([
      'achievement_x_gold', 'achievement_x_gold_inactive', 'artifact_pearl_icon', 'bonus_perfect_72', 'carter_art',
      'carter_icon', 'fraction_banner_red', 'fraction_on_frame_red', 'fraction_red', 'frame_icon_red_dragon',
      'hero_a_icon', 'icon_red_dragon_1', 'perfect_28', 'red_dragon_1', 'red_dragon_back', 'stainedglass_red', 'thing_icon_pic',
    ]);
  });

  it('selects every one the catalogue lists — the coverage guard', () => {
    const wanted = [...artNamesFromGameNames(names)];
    const sel = selectArt([...wanted, 'unrelated_scene'], null, new Set(), names);
    for (const n of wanted) expect(sel.has(n), n).toBe(true);
    expect(sel.has('unrelated_scene')).toBe(false);
    // A name nothing more specific claims is `named`.
    expect(sel.get('carter_art')).toBe('named');
  });

  it('ART_KEYS covers every sprite-name field names.json declares (static-data.ts)', () => {
    // A field added to a Game* interface whose name says it holds art must be
    // collected, or its picture would be a hole again.
    const src = fs.readFileSync(path.resolve('src/game-protocol/static-data.ts'), 'utf8');
    const fields = new Set<string>();
    for (const m of src.matchAll(/^\s+(\w*(?:[iI]con|[vV]isual|Glass|[bB]anner|[fF]rame|[bB]ack|^art|art))\??:\s*string;/gm)) fields.add(m[1]);
    for (const m of src.matchAll(/^\s+art\??:\s*\{([^}]*)\}/gm)) for (const k of m[1].matchAll(/(\w+)\??:\s*string/g)) fields.add(k[1]);
    expect(fields.size).toBeGreaterThan(3);
    for (const f of fields) expect(ART_KEYS.test(f), `names.json field "${f}"`).toBe(true);
  });
});

describe('the `icons` catch-all', () => {
  it('takes UI icons by name and leaves the rest', () => {
    for (const a of ['academy_10_72', 'pve_resource_22', 'perfect_28', 'icon_debuff_tower', 'babel_tower_icon', 'battler_technology_branch_icon_125']) {
      expect(isLibraryArt(a), a).toBe(true);
    }
    for (const a of [
      'clandoom_icon_book_anim', 'dragon_6_interface_spine_animation', 'leonardo_t5_artbundle', 'battle_sound_72',
      'daily_quests_icon_ru', 'promo_sale_girl_72', 'map_wyvern_icon', 'realm_35_minimap_64', 'tutorial_fort_icon',
      'icon_debuff_tower_72x72', 'some_icon_old', 'loyalty_bonus_back', 'gryphon_t7_scaled', 'random_banner',
    ]) {
      expect(isLibraryArt(a), a).toBe(false);
    }
  });

  it('patterns are anchored', () => {
    for (const p of [...LIBRARY_ART, ...LIBRARY_DENY]) expect(p.source.startsWith('^') && p.source.endsWith('$'), p.source).toBe(true);
  });

  it('comes last: a specific category keeps what it claims', () => {
    const st = emptyStatic({ techs: { 1: { name: 'T', icon: 'tech_alpha_72' } } });
    const sel = selectArt(['tech_alpha_72', 'misc_thing_72'], st);
    expect(Object.fromEntries(sel)).toEqual({ tech_alpha_72: 'research', misc_thing_72: 'icons' });
  });
});

// ---------------------------------------------------------------------------
// The pipeline, on a fake CDN
// ---------------------------------------------------------------------------

const VERSION = 'a'.repeat(32);
const hash = (n: number): string => n.toString(16).padStart(32, '0');

function textureBundle(name: string, w: number, h: number): Buffer {
  const serialized = buildSerializedFile([{
    pathId: 1n,
    classId: CLASS_TEXTURE2D,
    tree: TEXTURE2D_TREE,
    value: { m_Name: name, m_Width: w, m_Height: h, m_TextureFormat: 4, m_IsReadable: false, 'image data': patternPixels(w, h) },
  }]);
  return buildBundle([{ path: `CAB-${name}`, data: serialized }]);
}

function catalogue(entries: Array<{ bundle: string; addresses: string[] }>): Buffer {
  const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const parts: Buffer[] = [Buffer.from([0x49, 0x17, 0x50, 0x2e]), u32(entries.length)];
  const str = (s: string): Buffer => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
  for (const e of entries) {
    parts.push(str(e.addresses[0]), u32(0), Buffer.from(e.bundle, 'hex'), Buffer.from(e.bundle, 'hex'), u32(e.addresses.length));
    for (const a of e.addresses) parts.push(str(a));
  }
  return Buffer.concat(parts);
}

describe('ensureGameArt with the catch-alls', () => {
  let dir: string;
  // bundle → contents; `down` makes a bundle fail to download.
  const bundles = new Map<string, { name: string; w: number; h: number }>([
    [hash(1), { name: 'tech_alpha_72', w: 4, h: 4 }], // research (static)
    [hash(2), { name: 'misc_thing_72', w: 4, h: 4 }], // icons
    [hash(3), { name: 'big_backdrop_icon', w: LIBRARY_MAX_SIDE + 88, h: 4 }], // icons, too big
    [hash(4), { name: 'other_icon', w: 4, h: 4 }], // icons, download fails on run 1
    [hash(5), { name: 'named_banner', w: 4, h: 4 }], // named (names.json)
  ]);
  const down = new Set<string>();
  const fetched: string[] = [];
  const fakeFetch = (async (input: string | URL) => {
    const url = String(input);
    if (url === VERSIONS_URL) return new Response(JSON.stringify({ result: { unity_catalog_version: { webgl: VERSION } } }));
    if (url === UNITY_BASE + VERSION) {
      return new Response(new Uint8Array(catalogue([...bundles].map(([bundle, b]) => ({ bundle, addresses: [b.name] })))));
    }
    const b = bundles.get(url.slice(UNITY_BASE.length));
    if (!b || down.has(url.slice(UNITY_BASE.length))) return new Response('nope', { status: 500 });
    fetched.push(b.name);
    return new Response(new Uint8Array(textureBundle(b.name, b.w, b.h)));
  }) as typeof fetch;
  const opts = () => ({
    dir,
    fetchImpl: fakeFetch,
    loadStatic: async () => emptyStatic({ techs: { 1: { name: 'Alpha', icon: 'tech_alpha_72' } } }),
    loadTroops: async () => [],
    resourceNames: () => [],
    loadNames: async () => ({ medals: { 1: { banner: 'named_banner' } } }),
    concurrency: 2,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-art-'));
    down.clear();
    fetched.length = 0;
    resetGameArtMemo();
  });
  afterEach(() => {
    resetGameArtMemo();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('extracts the catch-alls, skips an oversized one, and fills a failed download on the next run', async () => {
    down.add(hash(4));
    const first = await ensureGameArt(opts());
    expect(first.status).toBe('updated');
    const index = loadIndex(dir, VERSION)!;
    expect(index.selection).toBe(ART_SELECTION_VERSION);
    expect(Object.fromEntries(Object.entries(index.images).map(([n, i]) => [n, i.category]))).toEqual({
      tech_alpha_72: 'research', misc_thing_72: 'icons', named_banner: 'named',
    });
    expect(index.skipped).toEqual(['big_backdrop_icon']);
    expect(index.retry).toEqual(['other_icon']);
    // The catalogue's names are kept for the hole log.
    expect(fs.readFileSync(path.join(dir, VERSION, CATALOG_NAMES_FILE), 'utf8').split('\n')).toContain('other_icon');

    // Next run: same art, same selection — the retry list alone rebuilds it,
    // downloading only the bundle that failed (the oversized one is not fetched again).
    fetched.length = 0;
    down.clear();
    const second = await ensureGameArt(opts());
    expect(second.status).toBe('updated');
    expect(fetched).toEqual(['other_icon']);
    const again = loadIndex(dir, VERSION)!;
    expect(again.retry).toBeUndefined();
    expect(again.images.other_icon?.category).toBe('icons');
    expect(again.stats.reused).toBe(4);

    // And then nothing to do.
    expect((await ensureGameArt(opts())).status).toBe('unchanged');
  });

  it('a catch-all bundle that fails never fails the run', async () => {
    down.add(hash(2));
    down.add(hash(3));
    down.add(hash(4));
    down.add(hash(5));
    const r = await ensureGameArt(opts());
    expect(r.status).toBe('updated');
    expect(Object.keys(loadIndex(dir, VERSION)!.images)).toEqual(['tech_alpha_72']);
  });

  it('gameArtUrl serves what was extracted and nothing else', async () => {
    await ensureGameArt(opts());
    expect(gameArtUrl('misc_thing_72', dir)).toBe(`/game-art/${VERSION}/misc_thing_72.png`);
    expect(gameArtUrl('big_backdrop_icon', dir)).toBeNull();
  });
});
