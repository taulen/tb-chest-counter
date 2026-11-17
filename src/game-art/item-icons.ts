/**
 * An item's own icon by its id (T8 f6 visual {"icon": …}): whatever a page
 * lists by item id — the Clan Capital's treasury (Clan Shield of Peace →
 * booster_piece_shield_blue_72, Proof of Glory in the Dark Omens tournament →
 * icon_sabotage_victory_points, …) — shows the game's icon without any hand
 * mapping. The icons are extracted under the `items` category (selection.ts).
 *
 * Server side on purpose: ~6,500 items would bloat /api/game-art, which every
 * page loads; a page gets the URL for the few ids it shows.
 */
import { loadArtStatic, type ArtStatic } from './art-static.js';
import { gameArtDir, gameArtUrl } from './store.js';
import { safeArtName } from './selection.js';

/** The static slice changes with a game patch; an hour old is fresh enough. */
const TTL_MS = 60 * 60 * 1000;
let memo: { at: number; byId: Map<number, string> } | null = null;

function iconsById(st: Pick<ArtStatic, 'items'>): Map<number, string> {
  const out = new Map<number, string>();
  for (const it of st.items) if (!out.has(Number(it.id))) out.set(Number(it.id), safeArtName(it.icon));
  return out;
}

async function byId(): Promise<Map<number, string>> {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.byId;
  try {
    memo = { at: Date.now(), byId: iconsById(await loadArtStatic(gameArtDir())) };
  } catch {
    memo = { at: Date.now() - TTL_MS + 60_000, byId: memo?.byId ?? new Map() };
  }
  return memo.byId;
}

/** URL of each item's icon in the current art version (only the ids that have one). */
export async function itemIconUrls(ids: number[]): Promise<Map<number, string>> {
  const icons = await byId();
  const out = new Map<number, string>();
  for (const id of ids) {
    const name = icons.get(id);
    const url = name ? gameArtUrl(name) : null;
    if (url) out.set(id, url);
  }
  return out;
}

/** Tests only. */
export function setItemIconsForTest(items: Array<{ id: number; icon: string }> | null): void {
  memo = items ? { at: Date.now(), byId: iconsById({ items: items.map((i) => ({ ...i, name: '' })) as ArtStatic['items'] }) } : null;
}
