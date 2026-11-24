"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeEventTitle = normalizeEventTitle;
exports.catalogKeyForEventTitle = catalogKeyForEventTitle;
exports.olympusStageDay = olympusStageDay;
/**
 * Which of the site's events (EVENT_CATALOG) a game event is: by its English
 * title against the catalog's in-game names (`calendarNames`, the names the
 * tbclanportal feed uses — "Rise of the Ancients", "Trials of Olympus",
 * "Ragnarök", "Dark Omens") and the catalog name. No per-event code: an event
 * the catalog doesn't know stays unmapped and is shown under the game's own
 * title.
 *
 * Olympus' five stages are game events of their own ("Trial of the Chimera" …
 * "Trial of Briareus", game-protocol/olympus.ts) and map onto olympus too —
 * they are its days.
 */
const event_catalog_js_1 = require("../config/event-catalog.js");
const olympus_js_1 = require("./olympus.js");
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
    for (const s of olympus_js_1.OLYMPUS_STAGES)
        index.set(normalizeEventTitle(s.title), 'olympus');
    return index;
}
/** The catalog key for a game event title, or null when the site has no tab for it. */
function catalogKeyForEventTitle(title) {
    if (!title)
        return null;
    return titleIndex().get(normalizeEventTitle(title)) ?? null;
}
let stageIndex = null;
/** The day of an Olympus run a game event title is the stage of, or null when it is no Olympus stage. */
function olympusStageDay(title) {
    if (!title)
        return null;
    stageIndex ??= new Map(olympus_js_1.OLYMPUS_STAGES.map((s) => [normalizeEventTitle(s.title), s.day]));
    return stageIndex.get(normalizeEventTitle(title)) ?? null;
}
//# sourceMappingURL=event-mapping.js.map