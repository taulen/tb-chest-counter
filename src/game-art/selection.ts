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

export const ART_CATEGORIES = ['heroes', 'troops', 'research', 'chests', 'resources', 'clan'] as const;
export type ArtCategory = (typeof ART_CATEGORIES)[number];

export const ART_PATTERNS: Record<ArtCategory, RegExp[]> = {
  // Hero avatar portraits come from the hero-avatar table (T13) alone.
  heroes: [],
  // Troop cards: guardsmen/specialists/siege ("unit_knight_72"), mercenaries
  // ("merc_spec_flying_9_icon_72"); monster and event mercs come via T9.
  troops: [/^unit_[a-z0-9_]+_72$/, /^merc_[a-z0-9_]+_icon_72$/],
  // Research and hero talents share the tech icon set.
  research: [/^tech_[a-z0-9_]+_72$/],
  chests: [/^chest_[a-z0-9_]+_72$/],
  // Resources come from the item table (T8) alone.
  resources: [],
  // Clan frames and emblems, small and large ("clan_frame_12_lg").
  clan: [/^clan_(frame|emblem)_\d+(_lg)?$/],
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
  }
  for (const u of st.units) out.troops.add(u.icon.toLowerCase());
  for (const t of Object.values(st.techs)) out.research.add(t.icon.toLowerCase());
  for (const it of st.items) {
    if (isChestName(it.name)) out.chests.add(it.icon.toLowerCase());
    else if (isResourceItem(it, resourceNames)) out.resources.add(it.icon.toLowerCase());
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
