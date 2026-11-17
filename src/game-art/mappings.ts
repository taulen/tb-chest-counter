/**
 * Game data → image name, computed from the game's static data (never hand-typed):
 *
 *   heroAvatars  a player's heroAvatar (game_players.hero_avatar, message 402
 *                field [4]) is the id of a T13 hero-avatar row; that row's icon
 *                is the portrait ("icon_garvel_72").
 *   avatarFrames a player's portrait frame (game_players.avatar_frame, 402
 *                field [6]) is the id of a T52 customization; its visual is
 *                the frame sprite ("vip_frame"). 1 = "Standard", the default.
 *   troops      every Tools → Citadel/Stacks troop and citadel defender
 *                (TROOPS + DEFENDERS in web/public/lib/citadel-sim.js) is
 *                matched to a T9 unit by its English name AND its
 *                strength/health, which the game has many rows for (one per
 *                event realm) but all with the same icon.
 *   troopTiers   the same troops → the matched unit's tier (T9 f2), which
 *                picks the game's frame for its icon.
 *   unitFrames   tier → the back, frame and badge the game draws a unit icon
 *                in (unit-frames.ts; extracted from the WebGL client).
 *   chests       English chest name → the icon most of the T8 items of that
 *                name use (one name can be several items, e.g. per source).
 *   resources    English resource name → the icon of the lowest-id T8 item of
 *                that name (the base resource; later ids are boosters/packs).
 *   techs        T21 tech/talent id → icon.
 *   ancients     the Ancient planner's pictures by key (EVENT_ART in
 *                selection.ts): tome, figurine, clock, tinman.
 *   cityLooks    a player's city look (game_players.city_appearance, 402
 *                field [5], a T52 customization) → lowest city level → icon;
 *                9 = "Player's City", the default.
 *   status       city state and holdings by key (STATUS_ART in selection.ts):
 *                shield, burning, wallsDown, flame, city, goldIngots.
 *   artifacts    T110 artifact type → its icon (the type's config `icon`).
 *   equipment    T11 equipment item type → its icon (f2 address, "arch_body").
 *   inserts      T8 gem / enchantment id → its icon (f6 visual).
 *   itemFrames   item quality grade → the back an item tile is drawn on, the
 *                plain back of an ungraded item, and the item frame
 *                (unit-frames.ts; from the WebGL client). Item icons
 *                themselves go by id (item-icons.ts), not through here.
 *
 * Every mapping only names images that were actually extracted.
 */
import fs from 'fs';
import path from 'path';
import type { ArtItem, ArtStatic, ArtUnit } from './art-static.js';
import { EVENT_ART, STATUS_ART, isChestName, isResourceItem, safeArtName } from './selection.js';
import {
  HERO_LEVEL_BADGE,
  captainTileArt,
  itemFrameArt,
  unitFrameArt,
  type CaptainTileArt,
  type ItemFrameArt,
  type UnitFrameArt,
} from './unit-frames.js';

export interface TroopStats {
  id: string;
  name: string;
  strength: number;
  health: number;
}

export interface ArtMappings {
  heroAvatars: Record<string, string>;
  /** T52 frame id (game_players.avatar_frame) → the frame drawn around the hero portrait. */
  avatarFrames: Record<string, string>;
  /** The plate the hero level is written on over a framed portrait (client UI art), or null. */
  heroLevelBadge: string | null;
  /** Tools troop/defender id → icon (null: no T9 unit matched). Was `mercenaries` (mercs only) before Nov 2026. */
  troops: Record<string, string | null>;
  /** Tools troop/defender id → the matched unit's tier (null: none, or its rows disagree). */
  troopTiers: Record<string, number | null>;
  /** Tier ("0"–"10") → the game's frame art for a unit icon of that tier. */
  unitFrames: Record<string, UnitFrameArt>;
  chests: Record<string, string>;
  resources: Record<string, string>;
  techs: Record<string, string>;
  /** T75 captain id → portrait image (smallIcon, else the level-up art). */
  captains: Record<string, string>;
  /**
   * T75 captain id → the full-body picture the game's captain screen shows
   * (`<smallIcon base>_scaled`: carter_icon → carter_scaled), else the
   * level-up art. Absent in an index built before Nov 2026.
   */
  captainArt?: Record<string, string>;
  /** The pieces of a captain's tile (unit-frames.ts). Absent before Nov 2026. */
  captainTile?: CaptainTileArt;
  /** EVENT_ART key (tome, figurine, clock, tinman) → image. */
  ancients: Record<string, string>;
  /** T52 city look id (game_players.city_appearance) → lowest city level → icon. */
  cityLooks: Record<string, Record<string, string>>;
  /** STATUS_ART key (shield, burning, wallsDown, flame, city, goldIngots) → image. */
  status: Record<string, string>;
  /** T110 artifact type → icon. Absent in an index built before Nov 2026's artifacts. */
  artifacts?: Record<string, string>;
  /** T11 equipment item type → icon. Same age as `artifacts`. */
  equipment?: Record<string, string>;
  /** T8 gem / enchantment id → icon. Same age as `artifacts`. */
  inserts?: Record<string, string>;
  /** The pieces of an item tile (unit-frames.ts). Absent in an index built before the chest rewards (selection 10). */
  itemFrames?: ItemFrameArt;
}

export function emptyMappings(): ArtMappings {
  return {
    heroAvatars: {}, avatarFrames: {}, heroLevelBadge: null, troops: {}, troopTiers: {}, unitFrames: {},
    chests: {}, resources: {}, techs: {}, captains: {}, captainArt: {}, ancients: {}, cityLooks: {}, status: {},
    artifacts: {}, equipment: {}, inserts: {}, itemFrames: { backs: {}, plainBack: null, frame: null },
  };
}

/** id → its icon, for the ones that were extracted (artifacts, equipment, gems). */
export function iconsById(rows: Record<string, { icon: string }> | undefined, available: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, r] of Object.entries(rows ?? {})) {
    const icon = r.icon ? safeArtName(r.icon) : '';
    if (icon && available(icon)) out[id] = icon;
  }
  return out;
}

export function normalizeGameName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The value that occurs most often; ties go to the one seen first. */
function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Troop → icon. Name and stats must both match; when no row has the same stats,
 * a name match still counts if every row of that name uses one icon.
 */
export function matchTroopIcons(
  troops: TroopStats[],
  units: ArtUnit[],
  available: (name: string) => boolean,
): Record<string, string | null> {
  const byName = new Map<string, ArtUnit[]>();
  for (const u of units) {
    const k = normalizeGameName(u.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(u);
  }
  const out: Record<string, string | null> = {};
  for (const t of troops) {
    const named = (byName.get(normalizeGameName(t.name)) ?? []).filter((u) => available(safeArtName(u.icon)));
    const exact = named.filter((u) => u.strength === t.strength && u.health === t.health);
    let pick: string | null = null;
    if (exact.length) pick = mostCommon(exact.map((u) => safeArtName(u.icon)));
    else if (named.length && new Set(named.map((u) => safeArtName(u.icon))).size === 1) pick = safeArtName(named[0].icon);
    out[t.id] = pick;
  }
  return out;
}

/**
 * Troop → the tier of the unit it matches, on the same rule as its icon: the
 * rows with its name AND stats decide (most common tier); without such a row,
 * a name whose rows all share one tier. Rows that disagree give null — the
 * icon is then shown without a frame rather than in a guessed one.
 */
export function matchTroopTiers(troops: TroopStats[], units: ArtUnit[]): Record<string, number | null> {
  const byName = new Map<string, ArtUnit[]>();
  for (const u of units) {
    if (typeof u.tier !== 'number') continue; // a cache from before tiers were read
    const k = normalizeGameName(u.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(u);
  }
  const out: Record<string, number | null> = {};
  for (const t of troops) {
    const named = byName.get(normalizeGameName(t.name)) ?? [];
    const exact = named.filter((u) => u.strength === t.strength && u.health === t.health);
    let tier: number | null = null;
    if (exact.length) tier = Number(mostCommon(exact.map((u) => String(u.tier))));
    else if (named.length && new Set(named.map((u) => u.tier)).size === 1) tier = named[0].tier;
    out[t.id] = tier;
  }
  return out;
}

export function heroAvatarIcons(st: ArtStatic, available: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, h] of Object.entries(st.heroes)) {
    const icon = safeArtName(h.icon);
    if (available(icon)) out[id] = icon;
  }
  return out;
}

export function avatarFrameIcons(st: ArtStatic, available: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, f] of Object.entries(st.frames ?? {})) {
    const img = safeArtName(f.visual);
    if (available(img)) out[id] = img;
  }
  return out;
}

export function chestIcons(items: ArtItem[], available: (name: string) => boolean): Record<string, string> {
  const byName = new Map<string, string[]>();
  for (const it of [...items].sort((a, b) => a.id - b.id)) {
    if (!isChestName(it.name)) continue;
    const icon = safeArtName(it.icon);
    if (!available(icon)) continue;
    if (!byName.has(it.name)) byName.set(it.name, []);
    byName.get(it.name)!.push(icon);
  }
  const out: Record<string, string> = {};
  for (const [name, icons] of byName) {
    const pick = mostCommon(icons);
    if (pick) out[name] = pick;
  }
  return out;
}

export function resourceIcons(
  items: ArtItem[],
  resourceNames: ReadonlySet<string>,
  available: (name: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of [...items].sort((a, b) => a.id - b.id)) {
    if (!isResourceItem(it, resourceNames) || it.name in out) continue;
    const icon = safeArtName(it.icon);
    if (available(icon)) out[it.name] = icon;
  }
  return out;
}

export function techIcons(st: ArtStatic, available: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, t] of Object.entries(st.techs)) {
    const icon = safeArtName(t.icon);
    if (available(icon)) out[id] = icon;
  }
  return out;
}

/**
 * The full-body art for a captain's smallIcon: carter_icon → carter_scaled —
 * the still of the captain screen's art (carter_artbundle's front image); the
 * client derives the name, nothing in the static data spells it out. '' when
 * the icon doesn't end in _icon.
 */
export function captainScaledArt(icon: string): string {
  return /_icon$/i.test(icon) ? `${icon.replace(/_icon$/i, '')}_scaled` : '';
}

/** Captain → full-body art (`_scaled`), else the level-up art, for those extracted. */
export function captainFullArt(st: ArtStatic, available: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, c] of Object.entries(st.captains ?? {})) {
    const pick = [captainScaledArt(c.icon), c.art].map((n) => (n ? safeArtName(n) : '')).find((n) => n && available(n));
    if (pick) out[id] = pick;
  }
  return out;
}

export function captainIcons(st: ArtStatic, available: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, c] of Object.entries(st.captains ?? {})) {
    const pick = [c.icon, c.art].map((n) => (n ? safeArtName(n) : '')).find((n) => n && available(n));
    if (pick) out[id] = pick;
  }
  return out;
}

/** City look → its icons by lowest city level, for the looks with at least one extracted. */
export function cityLookIcons(st: ArtStatic, available: (name: string) => boolean): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [id, look] of Object.entries(st.cityLooks ?? {})) {
    const icons: Record<string, string> = {};
    for (const [lvl, icon] of Object.entries(look.icons)) {
      const img = safeArtName(icon);
      if (available(img)) icons[lvl] = img;
    }
    if (Object.keys(icons).length) out[id] = icons;
  }
  return out;
}

/** STATUS_ART key → its image, for the ones that were extracted. */
export function statusIcons(available: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, address] of Object.entries(STATUS_ART)) {
    const name = safeArtName(address);
    if (available(name)) out[key] = name;
  }
  return out;
}

/** EVENT_ART key → its image, for the ones that were extracted. */
export function eventIcons(available: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, e] of Object.entries(EVENT_ART)) {
    const name = safeArtName(e.address);
    if (available(name)) out[key] = name;
  }
  return out;
}

export function buildMappings(
  st: ArtStatic,
  troops: TroopStats[],
  resourceNames: ReadonlySet<string>,
  available: (name: string) => boolean,
): ArtMappings {
  return {
    heroAvatars: heroAvatarIcons(st, available),
    avatarFrames: avatarFrameIcons(st, available),
    heroLevelBadge: available(safeArtName(HERO_LEVEL_BADGE)) ? safeArtName(HERO_LEVEL_BADGE) : null,
    troops: matchTroopIcons(troops, st.units, available),
    troopTiers: matchTroopTiers(troops, st.units),
    unitFrames: unitFrameArt(available),
    chests: chestIcons(st.items, available),
    resources: resourceIcons(st.items, resourceNames, available),
    techs: techIcons(st, available),
    captains: captainIcons(st, available),
    captainArt: captainFullArt(st, available),
    captainTile: captainTileArt(available),
    ancients: eventIcons(available),
    cityLooks: cityLookIcons(st, available),
    status: statusIcons(available),
    artifacts: iconsById(st.artifacts, available),
    equipment: iconsById(st.equipment, available),
    inserts: iconsById(st.inserts, available),
    itemFrames: itemFrameArt(available),
  };
}

/** The image for a heroAvatar value, or null (unknown avatar, art not extracted yet). */
export function heroAvatarImageFrom(mappings: ArtMappings | null, heroAvatar: number | null | undefined): string | null {
  if (heroAvatar === null || heroAvatar === undefined || !Number.isInteger(heroAvatar)) return null;
  return mappings?.heroAvatars[String(heroAvatar)] ?? null;
}

/** The game's default portrait frame ("Standard"), for a player whose frame is unknown. */
export const DEFAULT_AVATAR_FRAME = 1;

/**
 * The frame image a player's hero portrait is drawn in: theirs, else the
 * game's default (a player with none set has 1 = "Standard" anyway). Null when
 * the art has neither.
 */
export function avatarFrameImageFrom(mappings: ArtMappings | null, frameId: number | null | undefined): string | null {
  const frames = mappings?.avatarFrames;
  if (!frames) return null;
  const own = frameId !== null && frameId !== undefined && Number.isInteger(frameId) ? frames[String(frameId)] : undefined;
  return own ?? frames[String(DEFAULT_AVATAR_FRAME)] ?? null;
}

/** The game's default city look ("Player's City"), for a player whose look is unknown. */
export const DEFAULT_CITY_LOOK = 9;

/**
 * The icon of a player's city as the game shows it: their look (theirs, else
 * the default) at the highest level step their city has reached. Null when
 * the art has neither look.
 */
export function cityLookImageFrom(
  mappings: ArtMappings | null,
  lookId: number | null | undefined,
  cityLevel: number | null | undefined,
): string | null {
  const looks = mappings?.cityLooks;
  if (!looks) return null;
  const own = lookId !== null && lookId !== undefined && Number.isInteger(lookId) ? looks[String(lookId)] : undefined;
  const icons = own ?? looks[String(DEFAULT_CITY_LOOK)];
  if (!icons) return null;
  const steps = Object.keys(icons).map(Number).sort((a, b) => a - b);
  const level = typeof cityLevel === 'number' && cityLevel > 0 ? cityLevel : 1;
  const step = [...steps].reverse().find((s) => s <= level) ?? steps[0];
  return icons[String(step)] ?? null;
}

const TROOP_FILE = path.resolve('src', 'web', 'public', 'lib', 'citadel-sim.js');

/**
 * Every troop Tools → Citadel and → Stacks show, and the citadels' defenders,
 * straight from the frontend's own troop list (a plain ES module with no
 * imports), so the two can never disagree. A defender sharing a troop's id is
 * that troop.
 */
export async function loadTroopList(file: string = TROOP_FILE): Promise<TroopStats[]> {
  const src = await fs.promises.readFile(file, 'utf8');
  type Row = { id: string; name: string; str: number; hp: number };
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)) as {
    TROOPS?: Row[];
    DEFENDERS?: Record<string, Row>;
  };
  if (!Array.isArray(mod.TROOPS)) throw new Error(`${file} exports no TROOPS`);
  const rows = [...mod.TROOPS, ...Object.values(mod.DEFENDERS ?? {})];
  const seen = new Set<string>();
  return rows
    .filter((t) => !seen.has(t.id) && !!seen.add(t.id))
    .map((t) => ({ id: t.id, name: t.name, strength: t.str, health: t.hp }));
}
