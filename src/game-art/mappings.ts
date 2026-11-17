/**
 * Game data → image name, computed from the game's static data (never hand-typed):
 *
 *   heroAvatars  a player's heroAvatar (game_players.hero_avatar, message 402
 *                field [4]) is the id of a T13 hero-avatar row; that row's icon
 *                is the portrait ("icon_garvel_72").
 *   mercenaries  each Tools → Stacks/Citadel mercenary (TROOPS in
 *                web/public/lib/citadel-sim.js) is matched to a T9 unit by its
 *                English name AND its strength/health, which the game has many
 *                rows for (one per event realm) but all with the same icon.
 *   chests       English chest name → the icon most of the T8 items of that
 *                name use (one name can be several items, e.g. per source).
 *   resources    English resource name → the icon of the lowest-id T8 item of
 *                that name (the base resource; later ids are boosters/packs).
 *   techs        T21 tech/talent id → icon.
 *
 * Every mapping only names images that were actually extracted.
 */
import fs from 'fs';
import path from 'path';
import type { ArtItem, ArtStatic, ArtUnit } from './art-static.js';
import { isChestName, isResourceItem, safeArtName } from './selection.js';

export interface TroopStats {
  id: string;
  name: string;
  strength: number;
  health: number;
}

export interface ArtMappings {
  heroAvatars: Record<string, string>;
  mercenaries: Record<string, string | null>;
  chests: Record<string, string>;
  resources: Record<string, string>;
  techs: Record<string, string>;
  /** T75 captain id → portrait image (smallIcon, else the level-up art). */
  captains: Record<string, string>;
}

export function emptyMappings(): ArtMappings {
  return { heroAvatars: {}, mercenaries: {}, chests: {}, resources: {}, techs: {}, captains: {} };
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

export function heroAvatarIcons(st: ArtStatic, available: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, h] of Object.entries(st.heroes)) {
    const icon = safeArtName(h.icon);
    if (available(icon)) out[id] = icon;
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

export function captainIcons(st: ArtStatic, available: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, c] of Object.entries(st.captains ?? {})) {
    const pick = [c.icon, c.art].map((n) => (n ? safeArtName(n) : '')).find((n) => n && available(n));
    if (pick) out[id] = pick;
  }
  return out;
}

export function buildMappings(
  st: ArtStatic,
  mercenaries: TroopStats[],
  resourceNames: ReadonlySet<string>,
  available: (name: string) => boolean,
): ArtMappings {
  return {
    heroAvatars: heroAvatarIcons(st, available),
    mercenaries: matchTroopIcons(mercenaries, st.units, available),
    chests: chestIcons(st.items, available),
    resources: resourceIcons(st.items, resourceNames, available),
    techs: techIcons(st, available),
    captains: captainIcons(st, available),
  };
}

/** The image for a heroAvatar value, or null (unknown avatar, art not extracted yet). */
export function heroAvatarImageFrom(mappings: ArtMappings | null, heroAvatar: number | null | undefined): string | null {
  if (heroAvatar === null || heroAvatar === undefined || !Number.isInteger(heroAvatar)) return null;
  return mappings?.heroAvatars[String(heroAvatar)] ?? null;
}

const TROOP_FILE = path.resolve('src', 'web', 'public', 'lib', 'citadel-sim.js');

/**
 * The mercenaries Tools → Stacks sizes, straight from the frontend's own troop
 * list (a plain ES module with no imports), so the two can never disagree.
 */
export async function loadMercenaryList(file: string = TROOP_FILE): Promise<TroopStats[]> {
  const src = await fs.promises.readFile(file, 'utf8');
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)) as {
    TROOPS?: Array<{ id: string; name: string; group: string; str: number; hp: number }>;
  };
  if (!Array.isArray(mod.TROOPS)) throw new Error(`${file} exports no TROOPS`);
  return mod.TROOPS
    .filter((t) => t.group === 'mercenaries')
    .map((t) => ({ id: t.id, name: t.name, strength: t.str, health: t.hp }));
}
