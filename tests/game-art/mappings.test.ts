// Selection and the static-data mappings, on synthetic tables.

import { describe, expect, it } from 'vitest';
import { buildArtStatic, type ArtStatic } from '../../src/game-art/art-static.js';
import { selectArt, safeArtName, ART_PATTERNS } from '../../src/game-art/selection.js';
import {
  matchTroopIcons,
  chestIcons,
  resourceIcons,
  buildMappings,
  heroAvatarImageFrom,
} from '../../src/game-art/mappings.js';
import type { Wire } from '../../src/game-protocol/codec.js';

// String pool, vector pool and tables in the shape the game's static files use:
// cells hold string indexes; names are vectors of string indexes; English
// comes from the translations CSV keyed by the string.
const strings: Wire[] = [
  'hero.name.a', 'icon_alpha_72', 'unit.name.w', 'map_wyvern_icon_72', 'tech.name.t', 'tech_thing_72',
  'item.name.silver', '{"icon":"silver_72"}', 'item.name.chest', '{"icon":"stock_wood_chest_72"}',
  '{"icon":"tutor_chest_72"}', '{"icon":"booster_silver_72"}', 'not json',
];
const vectors: Wire[] = [[0], [2], [4], [6], [8]];
const en = new Map([
  ['hero.name.a', 'Alpha'], ['unit.name.w', 'Wyvern'], ['tech.name.t', 'Thing I'],
  ['item.name.silver', 'Silver'], ['item.name.chest', 'Wooden Chest'],
]);
const row = (cells: Record<number, Wire>, len: number): Wire[] => Array.from({ length: len }, (_, i) => cells[i] ?? 0);
const tables = new Map<number, Record<string, Wire>>([
  [13, { '2': row({ 1: 0, 3: 1 }, 9) }],
  [9, {
    '3089': row({ 1: 1, 4: 3, 10: 690000, 12: 2070000 }, 13),
    '6075': row({ 1: 1, 4: 3, 10: 690000, 12: 2070000 }, 13),
  }],
  [21, { '7': row({ 1: 2, 3: 5 }, 6) }],
  [8, {
    '2': row({ 3: 3, 6: 7 }, 7),
    '1028': row({ 3: 3, 6: 11 }, 7),
    '50': row({ 3: 4, 6: 10 }, 7),
    '60': row({ 3: 4, 6: 9 }, 7),
    '61': row({ 3: 4, 6: 9 }, 7),
    '62': row({ 3: 4, 6: 12 }, 7),
  }],
]);

const st: ArtStatic = buildArtStatic('v-test', strings, vectors, tables, en);

describe('buildArtStatic', () => {
  it('reads hero, unit, tech and item icons with English names', () => {
    expect(st.heroes).toEqual({ '2': { name: 'Alpha', icon: 'icon_alpha_72' } });
    expect(st.units).toEqual([
      { id: 3089, name: 'Wyvern', strength: 690000, health: 2070000, icon: 'map_wyvern_icon_72' },
      { id: 6075, name: 'Wyvern', strength: 690000, health: 2070000, icon: 'map_wyvern_icon_72' },
    ]);
    expect(st.techs).toEqual({ '7': { name: 'Thing I', icon: 'tech_thing_72' } });
    // item 62's visual is not JSON and is skipped
    expect(st.items.map((i) => `${i.id}:${i.name}:${i.icon}`)).toEqual([
      '2:Silver:silver_72', '50:Wooden Chest:tutor_chest_72', '60:Wooden Chest:stock_wood_chest_72',
      '61:Wooden Chest:stock_wood_chest_72', '1028:Silver:booster_silver_72',
    ]);
  });
});

describe('selectArt', () => {
  it('takes static icons and pattern matches the catalogue lists, first category wins', () => {
    const addresses = ['icon_alpha_72', 'map_wyvern_icon_72', 'tech_thing_72', 'tech_other_72', 'silver_72',
      'stock_wood_chest_72', 'clan_frame_3_lg', 'clan_emblem_12', 'unit_knight_72', 'random_banner', 'booster_silver_72'];
    const sel = selectArt(addresses, st);
    expect(Object.fromEntries(sel)).toEqual({
      icon_alpha_72: 'heroes',
      map_wyvern_icon_72: 'troops',
      unit_knight_72: 'troops',
      tech_thing_72: 'research',
      tech_other_72: 'research',
      stock_wood_chest_72: 'chests',
      silver_72: 'resources',
      clan_frame_3_lg: 'clan',
      clan_emblem_12: 'clan',
    });
  });

  it('a resource type name pulls in its item even past the currency id range', () => {
    expect(selectArt(['booster_silver_72'], st).has('booster_silver_72')).toBe(false);
    const big = { ...st, items: [{ id: 703005, name: 'Omen Essence', icon: 'icon_sabotage_clan_resource' }] };
    expect(selectArt(['icon_sabotage_clan_resource'], big, new Set(['omen essence'])).get('icon_sabotage_clan_resource')).toBe('resources');
  });

  it('patterns are anchored', () => {
    for (const p of Object.values(ART_PATTERNS).flat()) {
      expect(p.source.startsWith('^') && p.source.endsWith('$'), p.source).toBe(true);
    }
    expect(safeArtName('PvE_resource_22')).toBe('pve_resource_22');
    expect(safeArtName('../x y')).toBe('___x_y');
  });
});

describe('mappings', () => {
  const all = (): boolean => true;

  it('matches troops on name AND stats, falling back to a single shared icon', () => {
    const units = [
      ...st.units,
      { id: 1, name: 'Sandworm', strength: 1, health: 3, icon: 'monster_sandworm_72' },
      { id: 2, name: 'Sandworm', strength: 430000, health: 1290000, icon: 'icon_sandworm_72' },
      { id: 3, name: 'Bear', strength: 5, health: 15, icon: 'icon_bear_72' },
      { id: 4, name: 'Twin', strength: 1, health: 1, icon: 'twin_a' },
      { id: 5, name: 'Twin', strength: 2, health: 2, icon: 'twin_b' },
    ];
    const got = matchTroopIcons([
      { id: 'wyvern', name: 'Wyvern', strength: 690000, health: 2070000 },
      { id: 'sandworm', name: 'Sandworm', strength: 430000, health: 1290000 },
      { id: 'bear', name: 'bear', strength: 22000, health: 66000 }, // stats differ, one icon → still matched
      { id: 'twin', name: 'Twin', strength: 9, health: 9 }, // ambiguous → null
      { id: 'ghost', name: 'Ghost', strength: 1, health: 1 },
    ], units, all);
    expect(got).toEqual({ wyvern: 'map_wyvern_icon_72', sandworm: 'icon_sandworm_72', bear: 'icon_bear_72', twin: null, ghost: null });
  });

  it('only maps to images that were extracted', () => {
    const got = matchTroopIcons([{ id: 'wyvern', name: 'Wyvern', strength: 690000, health: 2070000 }], st.units, () => false);
    expect(got.wyvern).toBeNull();
  });

  it('chests take the icon most items of that name use; resources the lowest id', () => {
    expect(chestIcons(st.items, all)).toEqual({ 'Wooden Chest': 'stock_wood_chest_72' });
    expect(resourceIcons(st.items, new Set(), all)).toEqual({ Silver: 'silver_72' });
  });

  it('builds every mapping and resolves a heroAvatar', () => {
    const m = buildMappings(st, [{ id: 'wyvern', name: 'Wyvern', strength: 690000, health: 2070000 }], new Set(), all);
    expect(m.heroAvatars).toEqual({ '2': 'icon_alpha_72' });
    expect(m.techs).toEqual({ '7': 'tech_thing_72' });
    expect(m.mercenaries).toEqual({ wyvern: 'map_wyvern_icon_72' });
    expect(heroAvatarImageFrom(m, 2)).toBe('icon_alpha_72');
    expect(heroAvatarImageFrom(m, 3)).toBeNull();
    expect(heroAvatarImageFrom(m, null)).toBeNull();
    expect(heroAvatarImageFrom(null, 2)).toBeNull();
  });
});
