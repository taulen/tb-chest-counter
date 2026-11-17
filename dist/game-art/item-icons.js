"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.itemIconUrls = itemIconUrls;
exports.setItemIconsForTest = setItemIconsForTest;
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
const art_static_js_1 = require("./art-static.js");
const store_js_1 = require("./store.js");
const selection_js_1 = require("./selection.js");
/** The static slice changes with a game patch; an hour old is fresh enough. */
const TTL_MS = 60 * 60 * 1000;
let memo = null;
function iconsById(st) {
    const out = new Map();
    for (const it of st.items)
        if (!out.has(Number(it.id)))
            out.set(Number(it.id), (0, selection_js_1.safeArtName)(it.icon));
    return out;
}
async function byId() {
    if (memo && Date.now() - memo.at < TTL_MS)
        return memo.byId;
    try {
        memo = { at: Date.now(), byId: iconsById(await (0, art_static_js_1.loadArtStatic)((0, store_js_1.gameArtDir)())) };
    }
    catch {
        memo = { at: Date.now() - TTL_MS + 60_000, byId: memo?.byId ?? new Map() };
    }
    return memo.byId;
}
/** URL of each item's icon in the current art version (only the ids that have one). */
async function itemIconUrls(ids) {
    const icons = await byId();
    const out = new Map();
    for (const id of ids) {
        const name = icons.get(id);
        const url = name ? (0, store_js_1.gameArtUrl)(name) : null;
        if (url)
            out.set(id, url);
    }
    return out;
}
/** Tests only. */
function setItemIconsForTest(items) {
    memo = items ? { at: Date.now(), byId: iconsById({ items: items.map((i) => ({ ...i, name: '' })) }) } : null;
}
//# sourceMappingURL=item-icons.js.map