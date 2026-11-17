/**
 * Which game art we extract — the one place that decides it.
 *
 * The CDN holds ~14,400 bundles; we take ~1,150 icons. Each category is the
 * union of
 *   - the address patterns below (catalogue addresses are lower-cased asset
 *     names, e.g. "merc_guard_flying_9_icon_72"), and
 *   - the icons the game's own static data names for that category (see
 *     staticIconsByCategory), so a new hero, unit, tech or chest is picked up
 *     without touching this file.
 * An address in more than one category goes to the first in ART_CATEGORIES.
 */
import type { ArtStatic } from './art-static.js';

/**
 * `ui` is the client's own interface art (unit frames, backs, tier badges):
 * not in the catalogue at all, it comes from the WebGL client build
 * (webgl-client.ts, unit-frames.ts), so it has no pattern here.
 *
 * `items` last: every other item icon (T8) that no category above took — a
 * clan treasury or inventory row shows its item's own icon (by item id).
 */
export const ART_CATEGORIES = ['heroes', 'frames', 'cities', 'troops', 'research', 'chests', 'resources', 'clan', 'events', 'status', 'factions', 'dragon', 'titles', 'ui', 'items'] as const;
export type ArtCategory = (typeof ART_CATEGORIES)[number];

/**
 * Event pictures the app shows by key (Tools → Ancient planner), the game's
 * own art. With a `region`, the address is a Spine animation and the picture
 * is that region of its atlas (spine.ts): the Ancients artifacts exist in the
 * game only as animated icons. Without one, the plain image.
 */
export const EVENT_ART: Record<string, { address: string; region?: string }> = {
  tome: { address: 'clandoom_icon_book_anim', region: 'book' },
  figurine: { address: 'clandoom_icons_statue_anim', region: 'Layer 107' },
  clock: { address: 'clandoom_icons_hourglass_anim', region: 'hourglass' },
  // The Ancients boss as the event map shows it.
  tinman: { address: 'map_clan_doomsday_boss_scaled' },
};

/**
 * Small pictures for a player's city state and holdings, by key (the
 * `status` mapping; lib/game-art.js statusIconUrl). The game's own icons:
 *   shield      the Shield of Peace item icon — what most "Shield of Peace"
 *               items (T8) use, and named in the client's own code
 *   burning     "fire in the fort": a fortress wall in flames
 *   wallsDown   the destroyed-fortress icon (a city with its walls broken)
 *   flame       a plain flame that stays legible at 16 px (the 72s do not)
 *   city        the default city look at level 1 (T52 "Player's City");
 *               a player's own look by level is the `cityLooks` mapping
 *   goldIngots  the Gold Ingots item icon (T8 item 16)
 * Not `player_feiry_city_*`: that is the "Fiery" city look, not a city on fire.
 */
export const STATUS_ART: Record<string, string> = {
  shield: 'booster_piece_shield_orange_72',
  burning: 'fire_in_the_fort_72',
  wallsDown: 'destroyed_fortress_icon',
  flame: 'spells_magic_fire_22',
  city: 'player_city_lv1_icon',
  goldIngots: 'gold_bar_72',
};

/**
 * The Hall of Fame's factions (profile → Captains). The faction table (T78)
 * names each faction's art by colour — red Lions of Courage, green Eagles of
 * Resolve, blue Wolves of Tenacity — and the server hands the names out
 * (game-protocol/factions.ts). A window (`stainedglass_*`) is a Spine
 * animation whose atlas packs the still window with its glow frames: the
 * picture is the window's region. The crest (`fraction_*`) is a plain icon.
 */
export const FACTION_WINDOWS: Readonly<Record<string, string>> = {
  stainedglass_red: 'redv',
  stainedglass_green: 'greenv',
  stainedglass_blue: 'bluev',
};
export const FACTION_ART: readonly RegExp[] = [
  new RegExp(`^(${Object.keys(FACTION_WINDOWS).join('|')})$`),
  /^fraction_(red|green|blue)$/,
];

/**
 * The Dragon (profile → Captains), as the Dragons table (T73) names its art:
 * per evolution stage the small icon (`icon_red_dragon_<s>`) and the full
 * picture (`red_dragon_<s>`), plus the icon's frame and the window's
 * background. Not the `widget_`, `_city` or march (`_pet_`) variants.
 */
export const DRAGON_ART: readonly RegExp[] = [
  /^icon_red_dragon_\d+$/,
  /^red_dragon_\d+$/,
  /^frame_icon_red_dragon$/,
  /^red_dragon_back$/,
];

/** Address → the Spine atlas region its picture is cut from. */
export const SPINE_REGIONS: ReadonlyMap<string, string> = new Map([
  ...Object.values(EVENT_ART).filter((e) => e.region).map((e): [string, string] => [e.address, e.region as string]),
  ...Object.entries(FACTION_WINDOWS),
]);

/**
 * The clan ranking window's categories by ranking kind (message 23), with the
 * game's icon for each — the client config's rating tabs, RATING_CLANS.
 */
export const CLAN_RANKING_ICONS: Readonly<Record<number, string>> = {
  7: 'options_clan_wealth_22',
  1: '1_power_22',
  3: 'pve_resource_22',
  4: 'pvp_resource_22',
  5: 'scorched_oil_28',
};

export const ART_PATTERNS: Record<ArtCategory, RegExp[]> = {
  // Hero avatar portraits come from the hero-avatar table (T13) alone.
  heroes: [],
  // Portrait frames come from the customizations table (T52) alone.
  frames: [],
  // City looks (icon per city level) come from T52 alone.
  cities: [],
  // Troop cards: guardsmen/specialists/siege ("unit_knight_72"), mercenaries
  // ("merc_spec_flying_9_icon_72"); monster and event mercs come via T9.
  troops: [/^unit_[a-z0-9_]+_72$/, /^merc_[a-z0-9_]+_icon_72$/],
  // Research and hero talents share the tech icon set.
  research: [/^tech_[a-z0-9_]+_72$/],
  chests: [/^chest_[a-z0-9_]+_72$/],
  // Resources come from the item table (T8) alone.
  resources: [],
  clan: [
    // Clan logo layers, small and large ("clan_frame_12_lg"): background, the
    // frame's mask that clips it, frame, emblem — composed by clan-logo.ts.
    /^clan_(frame|emblem|background|mask)_\d+(_lg)?$/,
    // Clan medals (T62 f1, "achievement_capitals_competition_gold"), not
    // their greyed "_inactive" twins.
    /^achievement_[a-z0-9_]+_(bronze|silver|gold|platinum)$/,
    // The clan ranking window's category icons.
    new RegExp(`^(${Object.values(CLAN_RANKING_ICONS).join('|')})$`),
  ],
  // Exactly the EVENT_ART addresses.
  events: Object.values(EVENT_ART).map((e) => new RegExp(`^${e.address}$`)),
  // Exactly the STATUS_ART addresses.
  status: Object.values(STATUS_ART).map((a) => new RegExp(`^${a}$`)),
  factions: [...FACTION_ART],
  dragon: [...DRAGON_ART],
  // A player's titles (profile header): the titles table (T29) alone.
  titles: [],
  // From the client build, not the catalogue (see ART_CATEGORIES).
  ui: [],
  // Item icons come from the item table (T8) alone.
  items: [],
};

/** Items (T8) below this id are the game's currencies and base resources. */
export const RESOURCE_ITEM_MAX_ID = 100;
/** An item whose English name says "Chest" is a chest. */
export const CHEST_ITEM_NAME = /\bchest\b/i;

export function isChestName(name: string): boolean {
  return CHEST_ITEM_NAME.test(name);
}

/** Is this item a resource: a base currency, or one of the app's resource types? */
export function isResourceItem(item: { id: number; name: string }, resourceNames: ReadonlySet<string>): boolean {
  if (isChestName(item.name)) return false;
  return item.id < RESOURCE_ITEM_MAX_ID || resourceNames.has(item.name.toLowerCase());
}

/** The icons the static data names per category (lower-cased addresses). */
export function staticIconsByCategory(st: ArtStatic | null, resourceNames: ReadonlySet<string>): Record<ArtCategory, Set<string>> {
  const out = Object.fromEntries(ART_CATEGORIES.map((c) => [c, new Set<string>()])) as Record<ArtCategory, Set<string>>;
  if (!st) return out;
  for (const h of Object.values(st.heroes)) out.heroes.add(h.icon.toLowerCase());
  // Captain portraits sit with the hero portraits.
  for (const c of Object.values(st.captains ?? {})) {
    if (c.icon) out.heroes.add(c.icon.toLowerCase());
    if (c.art) out.heroes.add(c.art.toLowerCase());
    // The captain screen's full-body picture: carter_icon → carter_scaled (the
    // client derives the name; nothing in the static data spells it out).
    if (/_icon$/i.test(c.icon)) out.heroes.add(`${c.icon.replace(/_icon$/i, '')}_scaled`.toLowerCase());
  }
  for (const f of Object.values(st.frames ?? {})) out.frames.add(f.visual.toLowerCase());
  for (const c of Object.values(st.cityLooks ?? {})) for (const icon of Object.values(c.icons)) out.cities.add(icon.toLowerCase());
  // Captains' artifacts (T110), equipment (T11) and the gems / enchantments
  // set into it (T8) sit with the captain portraits.
  for (const a of Object.values(st.artifacts ?? {})) if (a.icon) out.heroes.add(a.icon.toLowerCase());
  for (const e of Object.values(st.equipment ?? {})) if (e.icon) out.heroes.add(e.icon.toLowerCase());
  for (const g of Object.values(st.inserts ?? {})) if (g.icon) out.heroes.add(g.icon.toLowerCase());
  // Titles: the round icon (a sprite of the `icons_title_small` atlas) and the
  // 72 px picture the hover card shows.
  for (const tt of Object.values(st.titles ?? {})) {
    if (tt.icon) out.titles.add(tt.icon.toLowerCase());
    if (tt.art) out.titles.add(tt.art.toLowerCase());
  }
  for (const u of st.units) out.troops.add(u.icon.toLowerCase());
  for (const t of Object.values(st.techs)) out.research.add(t.icon.toLowerCase());
  for (const it of st.items) {
    if (isChestName(it.name)) out.chests.add(it.icon.toLowerCase());
    else if (isResourceItem(it, resourceNames)) out.resources.add(it.icon.toLowerCase());
    else out.items.add(it.icon.toLowerCase());
  }
  return out;
}

/**
 * The addresses to extract, each with its category. Only addresses the
 * catalogue actually lists are returned.
 */
export function selectArt(
  catalogAddresses: Iterable<string>,
  st: ArtStatic | null,
  resourceNames: ReadonlySet<string> = new Set(),
): Map<string, ArtCategory> {
  const available = new Set<string>();
  for (const a of catalogAddresses) available.add(a.toLowerCase());
  const fromStatic = staticIconsByCategory(st, resourceNames);
  const out = new Map<string, ArtCategory>();
  for (const cat of ART_CATEGORIES) {
    for (const a of fromStatic[cat]) if (available.has(a) && !out.has(a)) out.set(a, cat);
    const patterns = ART_PATTERNS[cat];
    if (!patterns.length) continue;
    for (const a of available) {
      if (!out.has(a) && patterns.some((p) => p.test(a))) out.set(a, cat);
    }
  }
  return out;
}

/** The file-system-safe form of an address: lower case, [a-z0-9_-] only. */
export function safeArtName(address: string): string {
  return address.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 128);
}
