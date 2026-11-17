"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHEST_ITEM_NAME = exports.RESOURCE_ITEM_MAX_ID = exports.ART_PATTERNS = exports.SPINE_REGIONS = exports.EVENT_ART = exports.ART_CATEGORIES = void 0;
exports.isChestName = isChestName;
exports.isResourceItem = isResourceItem;
exports.staticIconsByCategory = staticIconsByCategory;
exports.selectArt = selectArt;
exports.safeArtName = safeArtName;
exports.ART_CATEGORIES = ['heroes', 'troops', 'research', 'chests', 'resources', 'clan', 'events'];
/**
 * Event pictures the app shows by key (Tools → Ancient planner), the game's
 * own art. With a `region`, the address is a Spine animation and the picture
 * is that region of its atlas (spine.ts): the Ancients artifacts exist in the
 * game only as animated icons. Without one, the plain image.
 */
exports.EVENT_ART = {
    tome: { address: 'clandoom_icon_book_anim', region: 'book' },
    figurine: { address: 'clandoom_icons_statue_anim', region: 'Layer 107' },
    clock: { address: 'clandoom_icons_hourglass_anim', region: 'hourglass' },
    // The Ancients boss as the event map shows it.
    tinman: { address: 'map_clan_doomsday_boss_scaled' },
};
/** Address → the Spine atlas region its picture is cut from. */
exports.SPINE_REGIONS = new Map(Object.values(exports.EVENT_ART).filter((e) => e.region).map((e) => [e.address, e.region]));
exports.ART_PATTERNS = {
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
    // Exactly the EVENT_ART addresses.
    events: Object.values(exports.EVENT_ART).map((e) => new RegExp(`^${e.address}$`)),
};
/** Items (T8) below this id are the game's currencies and base resources. */
exports.RESOURCE_ITEM_MAX_ID = 100;
/** An item whose English name says "Chest" is a chest. */
exports.CHEST_ITEM_NAME = /\bchest\b/i;
function isChestName(name) {
    return exports.CHEST_ITEM_NAME.test(name);
}
/** Is this item a resource: a base currency, or one of the app's resource types? */
function isResourceItem(item, resourceNames) {
    if (isChestName(item.name))
        return false;
    return item.id < exports.RESOURCE_ITEM_MAX_ID || resourceNames.has(item.name.toLowerCase());
}
/** The icons the static data names per category (lower-cased addresses). */
function staticIconsByCategory(st, resourceNames) {
    const out = Object.fromEntries(exports.ART_CATEGORIES.map((c) => [c, new Set()]));
    if (!st)
        return out;
    for (const h of Object.values(st.heroes))
        out.heroes.add(h.icon.toLowerCase());
    // Captain portraits sit with the hero portraits.
    for (const c of Object.values(st.captains ?? {})) {
        if (c.icon)
            out.heroes.add(c.icon.toLowerCase());
        if (c.art)
            out.heroes.add(c.art.toLowerCase());
    }
    for (const u of st.units)
        out.troops.add(u.icon.toLowerCase());
    for (const t of Object.values(st.techs))
        out.research.add(t.icon.toLowerCase());
    for (const it of st.items) {
        if (isChestName(it.name))
            out.chests.add(it.icon.toLowerCase());
        else if (isResourceItem(it, resourceNames))
            out.resources.add(it.icon.toLowerCase());
    }
    return out;
}
/**
 * The addresses to extract, each with its category. Only addresses the
 * catalogue actually lists are returned.
 */
function selectArt(catalogAddresses, st, resourceNames = new Set()) {
    const available = new Set();
    for (const a of catalogAddresses)
        available.add(a.toLowerCase());
    const fromStatic = staticIconsByCategory(st, resourceNames);
    const out = new Map();
    for (const cat of exports.ART_CATEGORIES) {
        for (const a of fromStatic[cat])
            if (available.has(a) && !out.has(a))
                out.set(a, cat);
        const patterns = exports.ART_PATTERNS[cat];
        if (!patterns.length)
            continue;
        for (const a of available) {
            if (!out.has(a) && patterns.some((p) => p.test(a)))
                out.set(a, cat);
        }
    }
    return out;
}
/** The file-system-safe form of an address: lower case, [a-z0-9_-] only. */
function safeArtName(address) {
    return address.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 128);
}
//# sourceMappingURL=selection.js.map