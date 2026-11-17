// Selection and the static-data mappings, on synthetic tables.

import { describe, expect, it } from 'vitest';
import { buildArtStatic, ART_STATIC_FORMAT, type ArtStatic, type ArtUnit } from '../../src/game-art/art-static.js';
import { selectArt, safeArtName, ART_PATTERNS, SPINE_REGIONS } from '../../src/game-art/selection.js';
import {
  matchTroopIcons,
  matchTroopTiers,
  chestIcons,
  resourceIcons,
  buildMappings,
  heroAvatarImageFrom,
  avatarFrameImageFrom,
  cityLookImageFrom,
  loadTroopList,
} from '../../src/game-art/mappings.js';
import {
  unitFrameArt, unitFrameTextures, clientUiTextures, HERO_LEVEL_BADGE, UNIT_TIER_COLOURS, TIER_NUMERALS,
  CAPTAIN_LEVEL_PLATE, CAPTAIN_STAR_ON, CAPTAIN_STAR_OFF, captainTileArt,
  itemFrameArt, itemFrameTextures, ITEM_FRAME, ITEM_PLAIN_BACK, ITEM_QUALITY_COLOURS,
} from '../../src/game-art/unit-frames.js';
import { captainScaledArt, captainFullArt } from '../../src/game-art/mappings.js';
import type { Wire } from '../../src/game-protocol/codec.js';

// String pool, vector pool and tables in the shape the game's static files use:
// cells hold string indexes; names are vectors of string indexes; English
// comes from the translations CSV keyed by the string.
const strings: Wire[] = [
  'hero.name.a', 'icon_alpha_72', 'unit.name.w', 'map_wyvern_icon_72', 'tech.name.t', 'tech_thing_72',
  'item.name.silver', '{"icon":"silver_72"}', 'item.name.chest', '{"icon":"stock_wood_chest_72"}',
  '{"icon":"tutor_chest_72"}', '{"icon":"booster_silver_72"}', 'not json',
  // 13–17: customizations (portrait frames and a city look)
  'custom.name.std', '{"visual":"custom_frame_default","mobileCircle":""}', 'custom.name.vip', '{"visual":"vip_frame"}',
  JSON.stringify({ visual: JSON.stringify({ visual: {}, icon: { 1: 'player_city_lv1_icon', 20: 'player_city_lv5_icon' } }) }),
];
const vectors: Wire[] = [[0], [2], [4], [6], [8], [13], [15]];
const en = new Map([
  ['hero.name.a', 'Alpha'], ['unit.name.w', 'Wyvern'], ['tech.name.t', 'Thing I'],
  ['item.name.silver', 'Silver'], ['item.name.chest', 'Wooden Chest'],
  ['custom.name.std', 'Standard'], ['custom.name.vip', 'VIP'],
]);
const row = (cells: Record<number, Wire>, len: number): Wire[] => Array.from({ length: len }, (_, i) => cells[i] ?? 0);
const tables = new Map<number, Record<string, Wire>>([
  [13, { '2': row({ 1: 0, 3: 1 }, 9) }],
  [9, {
    '3089': row({ 1: 1, 2: 9, 4: 3, 10: 690000, 12: 2070000 }, 13),
    '6075': row({ 1: 1, 2: 9, 4: 3, 10: 690000, 12: 2070000 }, 13),
  }],
  [52, {
    '1': row({ 0: 1, 1: 1, 2: 5, 4: 14 }, 11),
    '26': row({ 0: 26, 1: 1, 2: 6, 4: 16 }, 11),
    '9': row({ 0: 9, 1: 2, 2: 6, 4: 17 }, 11), // a city look, not a frame
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
      { id: 3089, name: 'Wyvern', tier: 9, strength: 690000, health: 2070000, icon: 'map_wyvern_icon_72' },
      { id: 6075, name: 'Wyvern', tier: 9, strength: 690000, health: 2070000, icon: 'map_wyvern_icon_72' },
    ]);
    expect(st.format).toBe(ART_STATIC_FORMAT);
    expect(st.techs).toEqual({ '7': { name: 'Thing I', icon: 'tech_thing_72' } });
    // item 62's visual is not JSON and is skipped
    expect(st.items.map((i) => `${i.id}:${i.name}:${i.icon}`)).toEqual([
      '2:Silver:silver_72', '50:Wooden Chest:tutor_chest_72', '60:Wooden Chest:stock_wood_chest_72',
      '61:Wooden Chest:stock_wood_chest_72', '1028:Silver:booster_silver_72',
    ]);
  });

  it('reads portrait frames and city looks (icon per city level) from the customizations table', () => {
    expect(st.frames).toEqual({
      '1': { name: 'Standard', visual: 'custom_frame_default' },
      '26': { name: 'VIP', visual: 'vip_frame' },
    });
    expect(st.cityLooks).toEqual({
      '9': { name: 'VIP', icons: { '1': 'player_city_lv1_icon', '20': 'player_city_lv5_icon' } },
    });
  });
});

describe('selectArt', () => {
  it('takes static icons and pattern matches the catalogue lists, first category wins', () => {
    const addresses = ['icon_alpha_72', 'map_wyvern_icon_72', 'tech_thing_72', 'tech_other_72', 'silver_72',
      'stock_wood_chest_72', 'clan_frame_3_lg', 'clan_emblem_12', 'unit_knight_72', 'random_banner', 'booster_silver_72'];
    const sel = selectArt([...addresses, 'vip_frame', 'player_city_lv5_icon', 'fire_in_the_fort_72', 'player_feiry_city_72'], st);
    expect(Object.fromEntries(sel)).toEqual({
      icon_alpha_72: 'heroes',
      vip_frame: 'frames',
      player_city_lv5_icon: 'cities',
      fire_in_the_fort_72: 'status',
      map_wyvern_icon_72: 'troops',
      unit_knight_72: 'troops',
      tech_thing_72: 'research',
      tech_other_72: 'research',
      stock_wood_chest_72: 'chests',
      silver_72: 'resources',
      clan_frame_3_lg: 'clan',
      clan_emblem_12: 'clan',
      // Every other item's icon, for rows listed by item id (Clan Capital treasury).
      booster_silver_72: 'items',
    });
  });

  it('takes exactly the event art the Ancient planner shows', () => {
    const sel = selectArt(['clandoom_icon_book_anim', 'map_clan_doomsday_boss_scaled', 'clandoom_icon_book_anim_old'], st);
    expect(Object.fromEntries(sel)).toEqual({ clandoom_icon_book_anim: 'events', map_clan_doomsday_boss_scaled: 'events' });
  });

  it("takes the Hall of Fame's faction windows (cut to the still window) and crests, nothing else of theirs", () => {
    const sel = selectArt(['stainedglass_red', 'stainedglass_interior_gems', 'fraction_blue', 'fraction_barbarian_on_56', 'fraction_banner_red'], st);
    expect(Object.fromEntries(sel)).toEqual({ stainedglass_red: 'factions', fraction_blue: 'factions' });
    expect(SPINE_REGIONS.get('stainedglass_red')).toBe('redv');
    expect(SPINE_REGIONS.get('clandoom_icon_book_anim')).toBe('book');
  });

  it("takes the Dragon's icons, frame, pictures and background — not its widget, city or march sprites", () => {
    const sel = selectArt([
      'icon_red_dragon_6', 'red_dragon_6', 'frame_icon_red_dragon', 'red_dragon_back',
      'widget_red_dragon_6', 'red_dragon_6_city', 'red_dragon_six_pet_attack', 'dragon_6_interface_spine_animation',
    ], st);
    expect(Object.fromEntries(sel)).toEqual({
      icon_red_dragon_6: 'dragon', red_dragon_6: 'dragon', frame_icon_red_dragon: 'dragon', red_dragon_back: 'dragon',
    });
  });

  it('a resource type name pulls in its item even past the currency id range', () => {
    // Not a resource: an item icon like any other.
    expect(selectArt(['booster_silver_72'], st).get('booster_silver_72')).toBe('items');
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
      { id: 1, name: 'Sandworm', tier: 3, strength: 1, health: 3, icon: 'monster_sandworm_72' },
      { id: 2, name: 'Sandworm', tier: 5, strength: 430000, health: 1290000, icon: 'icon_sandworm_72' },
      { id: 3, name: 'Bear', tier: 4, strength: 5, health: 15, icon: 'icon_bear_72' },
      { id: 4, name: 'Twin', tier: 1, strength: 1, health: 1, icon: 'twin_a' },
      { id: 5, name: 'Twin', tier: 2, strength: 2, health: 2, icon: 'twin_b' },
    ];
    const got = matchTroopIcons([
      { id: 'wyvern', name: 'Wyvern', strength: 690000, health: 2070000 },
      { id: 'sandworm', name: 'Sandworm', strength: 430000, health: 1290000 },
      { id: 'bear', name: 'bear', strength: 22000, health: 66000 }, // stats differ, one icon → still matched
      { id: 'twin', name: 'Twin', strength: 9, health: 9 }, // ambiguous → null
      { id: 'ghost', name: 'Ghost', strength: 1, health: 1 },
    ], units, all);
    expect(got).toEqual({ wyvern: 'map_wyvern_icon_72', sandworm: 'icon_sandworm_72', bear: 'icon_bear_72', twin: null, ghost: null });
    // The tier follows the same rows: exact stats first, else one shared tier.
    expect(matchTroopTiers([
      { id: 'wyvern', name: 'Wyvern', strength: 690000, health: 2070000 },
      { id: 'sandworm', name: 'Sandworm', strength: 430000, health: 1290000 },
      { id: 'bear', name: 'bear', strength: 22000, health: 66000 },
      { id: 'twin', name: 'Twin', strength: 9, health: 9 }, // rows disagree → null, never a guess
      { id: 'ghost', name: 'Ghost', strength: 1, health: 1 },
    ], units)).toEqual({ wyvern: 9, sandworm: 5, bear: 4, twin: null, ghost: null });
    // A static cache from before tiers were read has none to give.
    const old = [{ id: 9, name: 'Ent', strength: 1, health: 1, icon: 'ent' }] as unknown as ArtUnit[];
    expect(matchTroopTiers([{ id: 'ent', name: 'Ent', strength: 1, health: 1 }], old)).toEqual({ ent: null });
  });

  it('frames a unit icon by tier on the game ladder; VIII–X get a numeral on a plain disc', () => {
    const textures = unitFrameTextures();
    expect(textures).toEqual(expect.arrayContaining([
      'back_icon_units_72x72_grey', 'frame_icon_units_94x92_whiteII', 'icons_tir_VII_1', 'icons_tir_0_3', 'icons_tir_II_3',
    ]));
    expect(textures).not.toContain('icons_tir_VIII_1'); // the game has no such sprite
    const names = new Set(textures.map((n) => safeArtName(n)));
    const frames = unitFrameArt((n) => names.has(n));
    expect(Object.keys(frames)).toHaveLength(11);
    expect(frames['5']).toEqual({
      back: 'back_icon_units_72x72_orange', frame: 'frame_icon_units_94x92_orange', badge: 'icons_tir_v_1', numeral: null,
    });
    expect(frames['0'].badge).toBe('icons_tir_0_3');
    expect(frames['9']).toEqual({
      back: 'back_icon_units_72x72_greenii', frame: 'frame_icon_units_94x92_greenii', badge: 'icons_tir_ii_3', numeral: 'IX',
    });
    // No back or frame → no entry; no badge → framed without one.
    const partial = unitFrameArt((n) => n !== 'frame_icon_units_94x92_gold' && n !== 'icons_tir_vi_1' && names.has(n));
    expect(partial['7']).toBeUndefined();
    expect(partial['6']).toEqual({ back: 'back_icon_units_72x72_red', frame: 'frame_icon_units_94x92_red', badge: null, numeral: null });
    expect(UNIT_TIER_COLOURS).toHaveLength(TIER_NUMERALS.length);
    expect(clientUiTextures()).toEqual([
      ...textures, HERO_LEVEL_BADGE, CAPTAIN_LEVEL_PLATE, CAPTAIN_STAR_ON, CAPTAIN_STAR_OFF, ...itemFrameTextures(),
    ]);
  });

  it('draws an item tile on the back of its quality grade, the plain back without one, in the item frame', () => {
    const textures = itemFrameTextures();
    expect(textures).toEqual([
      'back_icon_subject_72x72_grey', 'back_icon_subject_72x72_white', 'back_icon_subject_72x72_green',
      'back_icon_subject_72x72_blue', 'back_icon_subject_72x72_violet', 'back_icon_subject_72x72_orange',
      'back_icon_subject_72x72_red', 'back_icon_subject_72x72_gold', ITEM_PLAIN_BACK, ITEM_FRAME,
    ]);
    expect(Object.keys(ITEM_QUALITY_COLOURS)).toHaveLength(8);
    const all = new Set(textures.map((n) => safeArtName(n)));
    const art = itemFrameArt((n) => all.has(n));
    expect(art.backs['4']).toBe('back_icon_subject_72x72_blue');
    expect(art.backs['8']).toBe('back_icon_subject_72x72_gold');
    expect(art.plainBack).toBe('back_icon_resources_72x72');
    expect(art.frame).toBe('frame_icon_thing_94x92');
    // Only what was extracted is named.
    expect(itemFrameArt((n) => n === 'back_icon_subject_72x72_green')).toEqual({
      backs: { 3: 'back_icon_subject_72x72_green' }, plainBack: null, frame: null,
    });
  });

  it('builds a captain tile from the unit icon sprites in its rarity colour, and picks the full-body art', () => {
    const have = new Set(['back_icon_units_72x72_violet', 'frame_icon_units_94x92_violet', 'back_icon_units_72x72_gold',
      'frame_icon_units_94x92_gold', 'icons_tir_shield_2', 'icons_star_up']);
    expect(captainTileArt((n) => have.has(n))).toEqual({
      backs: { 2: 'back_icon_units_72x72_violet', 3: 'back_icon_units_72x72_gold' },
      frames: { 2: 'frame_icon_units_94x92_violet', 3: 'frame_icon_units_94x92_gold' },
      levelPlate: 'icons_tir_shield_2',
      starOn: 'icons_star_up',
      starOff: null,
    });
    // carter_icon → carter_scaled (the captain screen's still); no _scaled → the level-up art.
    expect(captainScaledArt('carter_icon')).toBe('carter_scaled');
    expect(captainScaledArt('odd_name')).toBe('');
    const art = captainFullArt({
      captains: {
        8: { name: 'Carter', icon: 'carter_icon', art: 'lvlup_carter' },
        32: { name: 'Artemisia', icon: 'artemisia_icon', art: 'lvlup_artemisia' },
      },
    } as never, (n) => n === 'carter_scaled' || n === 'lvlup_carter' || n === 'lvlup_artemisia');
    expect(art).toEqual({ 8: 'carter_scaled', 32: 'lvlup_artemisia' });
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
    expect(m.troops).toEqual({ wyvern: 'map_wyvern_icon_72' });
    expect(m.troopTiers).toEqual({ wyvern: 9 });
    expect(m.unitFrames['9']?.numeral).toBe('IX');
    expect(m.avatarFrames).toEqual({ '1': 'custom_frame_default', '26': 'vip_frame' });
    // A player's own frame, else the game's default "Standard".
    expect(avatarFrameImageFrom(m, 26)).toBe('vip_frame');
    expect(avatarFrameImageFrom(m, 777)).toBe('custom_frame_default');
    expect(avatarFrameImageFrom(m, null)).toBe('custom_frame_default');
    expect(avatarFrameImageFrom({ ...m, avatarFrames: {} }, 26)).toBeNull();
    expect(avatarFrameImageFrom(null, 26)).toBeNull();
    // The hero-level plate comes from the client build, like the unit frames.
    expect(m.heroLevelBadge).toBe('icons_tir_shield_4');
    expect(buildMappings(st, [], new Set(), (n) => n !== 'icons_tir_shield_4').heroLevelBadge).toBeNull();
    // City looks: the step the city level has reached; the default look when unknown.
    expect(m.cityLooks).toEqual({ '9': { '1': 'player_city_lv1_icon', '20': 'player_city_lv5_icon' } });
    expect(cityLookImageFrom(m, 9, 19)).toBe('player_city_lv1_icon');
    expect(cityLookImageFrom(m, 9, 44)).toBe('player_city_lv5_icon');
    expect(cityLookImageFrom(m, 10000090, 25)).toBe('player_city_lv5_icon');
    expect(cityLookImageFrom(m, null, null)).toBe('player_city_lv1_icon');
    expect(cityLookImageFrom(null, 9, 20)).toBeNull();
    // Status icons by key, only the extracted ones.
    expect(m.status).toMatchObject({ shield: 'booster_piece_shield_orange_72', burning: 'fire_in_the_fort_72', goldIngots: 'gold_bar_72' });
    expect(buildMappings(st, [], new Set(), (n) => n === 'gold_bar_72').status).toEqual({ goldIngots: 'gold_bar_72' });
    expect(m.ancients).toEqual({
      tome: 'clandoom_icon_book_anim', figurine: 'clandoom_icons_statue_anim',
      clock: 'clandoom_icons_hourglass_anim', tinman: 'map_clan_doomsday_boss_scaled',
    });
    expect(buildMappings(st, [], new Set(), () => false).ancients).toEqual({});
    expect(heroAvatarImageFrom(m, 2)).toBe('icon_alpha_72');
    expect(heroAvatarImageFrom(m, 3)).toBeNull();
    expect(heroAvatarImageFrom(m, null)).toBeNull();
    expect(heroAvatarImageFrom(null, 2)).toBeNull();
  });
});

describe('loadTroopList', () => {
  it('lists every Tools troop and citadel defender once, from the frontend troop file', async () => {
    const list = await loadTroopList();
    const ids = list.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(list.length).toBeGreaterThan(146);
    // Groups the old mercenary-only list left out, and defenders.
    expect(ids).toEqual(expect.arrayContaining(['corax-1', 'kraken-2', 'josephine-1', 'wyvern', 'dwarf', 'walls']));
    // The game's own name (the wiki said "Many-Armed Giant"), so it matches T9.
    expect(list.find((t) => t.id === 'many-armed-giant')?.name).toBe('Many-Armed Guardian');
  });
});
