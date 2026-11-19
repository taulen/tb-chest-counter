"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.describeRewardItems = describeRewardItems;
exports.rewardGameNames = rewardGameNames;
exports.resetRewardNamesCache = resetRewardNamesCache;
/**
 * How a page names and draws a chest reward (a T8 item) or a chest type (a
 * gift type) by its id: the game's English name (shown through tGame), the
 * item kind, quality grade and duration, and the icon URL. One describer for
 * every page that shows what chests paid out — Resources → Chest rewards and
 * Scan History — so an item looks the same on both.
 */
const static_data_js_1 = require("../game-protocol/static-data.js");
const item_icons_js_1 = require("../game-art/item-icons.js");
/** id → what to show it as. Ids the names lack still answer (empty name, no grade). */
async function describeRewardItems(ids, names) {
    const unique = [...new Set(ids)];
    const icons = await (0, item_icons_js_1.itemIconUrls)(unique);
    const out = {};
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
let namesCache = { at: 0, names: null, refreshing: null };
async function rewardGameNames() {
    const c = namesCache;
    if (c.names && Date.now() - c.at < NAMES_TTL_MS)
        return c.names;
    if (!c.refreshing) {
        c.refreshing = (0, static_data_js_1.loadGameNames)()
            .then((n) => { namesCache = { at: Date.now(), names: n, refreshing: null }; return n; })
            .catch(() => { namesCache = { ...namesCache, at: Date.now(), refreshing: null }; return namesCache.names; });
    }
    return c.names ?? c.refreshing;
}
/** Test seam. */
function resetRewardNamesCache() {
    namesCache = { at: 0, names: null, refreshing: null };
}
//# sourceMappingURL=reward-items.js.map