/**
 * How a page names and draws a chest reward (a T8 item) or a chest type (a
 * gift type) by its id: the game's English name (shown through tGame), the
 * item kind, quality grade and duration, and the icon URL. One describer for
 * every page that shows what chests paid out — Resources → Chest rewards and
 * Scan History — so an item looks the same on both.
 */
import { loadGameNames, type GameNames } from '../game-protocol/static-data.js';
import { itemIconUrls } from '../game-art/item-icons.js';

export interface RewardItemInfo {
  name: string;
  kind: number;
  quality: number;
  seconds: number;
  iconUrl: string | null;
}

/** id → what to show it as. Ids the names lack still answer (empty name, no grade). */
export async function describeRewardItems(
  ids: readonly number[],
  names: GameNames | null,
): Promise<Record<string, RewardItemInfo>> {
  const unique = [...new Set(ids)];
  const icons = await itemIconUrls(unique);
  const out: Record<string, RewardItemInfo> = {};
  for (const id of unique) {
    const it = names?.items?.[String(id)];
    out[String(id)] = {
      name: names?.gifts?.[String(id)]?.chest ?? '',
      kind: it?.kind ?? 0,
      quality: it?.quality ?? 0,
      seconds: it?.seconds ?? 0,
      iconUrl: icons.get(id) ?? null,
    };
  }
  return out;
}

/**
 * names.json for Scan History. loadGameNames asks the game's versions endpoint
 * on every call, and the scan list is opened often: once names are in hand
 * they are served at once and refreshed in the background at most every 10
 * minutes. Only the very first call waits; a failed refresh keeps the names
 * it had (null before any arrived — amounts then stay unresolved counts).
 */
const NAMES_TTL_MS = 10 * 60_000;
let namesCache: { at: number; names: GameNames | null; refreshing: Promise<GameNames | null> | null } = { at: 0, names: null, refreshing: null };

export async function rewardGameNames(): Promise<GameNames | null> {
  const c = namesCache;
  if (c.names && Date.now() - c.at < NAMES_TTL_MS) return c.names;
  if (!c.refreshing) {
    c.refreshing = loadGameNames()
      .then((n) => { namesCache = { at: Date.now(), names: n, refreshing: null }; return n; })
      .catch(() => { namesCache = { ...namesCache, at: Date.now(), refreshing: null }; return namesCache.names; });
  }
  return c.names ?? c.refreshing;
}

/** Test seam. */
export function resetRewardNamesCache(): void {
  namesCache = { at: 0, names: null, refreshing: null };
}
