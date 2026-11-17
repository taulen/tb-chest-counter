"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeEventTitle = normalizeEventTitle;
exports.catalogKeyForEventTitle = catalogKeyForEventTitle;
/**
 * Which of the site's events (EVENT_CATALOG) a game event is: by its English
 * title against the catalog's in-game names (`calendarNames`, the names the
 * tbclanportal feed uses — "Rise of the Ancients", "Trials of Olympus",
 * "Ragnarök", "Dark Omens") and the catalog name. No per-event code: an event
 * the catalog doesn't know stays unmapped and is shown under the game's own
 * title.
 */
const event_catalog_js_1 = require("../config/event-catalog.js");
/** Case-, accent- and spacing-insensitive form of a title. */
function normalizeEventTitle(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
let index = null;
function titleIndex() {
    if (index)
        return index;
    index = new Map();
    for (const e of event_catalog_js_1.EVENT_CATALOG) {
        for (const n of [...(e.calendarNames ?? []), e.name]) {
            const k = normalizeEventTitle(n);
            if (k && !index.has(k))
                index.set(k, e.key);
        }
    }
    return index;
}
/** The catalog key for a game event title, or null when the site has no tab for it. */
function catalogKeyForEventTitle(title) {
    if (!title)
        return null;
    return titleIndex().get(normalizeEventTitle(title)) ?? null;
}
//# sourceMappingURL=event-mapping.js.map