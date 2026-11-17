"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyMappings = emptyMappings;
exports.iconsById = iconsById;
exports.normalizeGameName = normalizeGameName;
exports.matchTroopIcons = matchTroopIcons;
exports.heroAvatarIcons = heroAvatarIcons;
exports.chestIcons = chestIcons;
exports.resourceIcons = resourceIcons;
exports.techIcons = techIcons;
exports.captainIcons = captainIcons;
exports.eventIcons = eventIcons;
exports.buildMappings = buildMappings;
exports.heroAvatarImageFrom = heroAvatarImageFrom;
exports.loadTroopList = loadTroopList;
/**
 * Game data → image name, computed from the game's static data (never hand-typed):
 *
 *   heroAvatars  a player's heroAvatar (game_players.hero_avatar, message 402
 *                field [4]) is the id of a T13 hero-avatar row; that row's icon
 *                is the portrait ("icon_garvel_72").
 *   troops       every Tools → Citadel/Stacks troop and citadel defender
 *                (TROOPS + DEFENDERS in web/public/lib/citadel-sim.js) is
 *                matched to a T9 unit by its English name AND its
 *                strength/health, which the game has many rows for (one per
 *                event realm) but all with the same icon.
 *   chests       English chest name → the icon most of the T8 items of that
 *                name use (one name can be several items, e.g. per source).
 *   resources    English resource name → the icon of the lowest-id T8 item of
 *                that name (the base resource; later ids are boosters/packs).
 *   techs        T21 tech/talent id → icon.
 *   ancients     the Ancient planner's pictures by key (EVENT_ART in
 *                selection.ts): tome, figurine, clock, tinman.
 *   artifacts    T110 artifact type → its icon (the type's config `icon`).
 *   equipment    T11 equipment item type → its icon (f2 address, "arch_body").
 *   inserts      T8 gem / enchantment id → its icon (f6 visual).
 *
 * Every mapping only names images that were actually extracted.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const selection_js_1 = require("./selection.js");
function emptyMappings() {
    return {
        heroAvatars: {}, troops: {}, chests: {}, resources: {}, techs: {}, captains: {}, ancients: {},
        artifacts: {}, equipment: {}, inserts: {},
    };
}
/** id → its icon, for the ones that were extracted (artifacts, equipment, gems). */
function iconsById(rows, available) {
    const out = {};
    for (const [id, r] of Object.entries(rows ?? {})) {
        const icon = r.icon ? (0, selection_js_1.safeArtName)(r.icon) : '';
        if (icon && available(icon))
            out[id] = icon;
    }
    return out;
}
function normalizeGameName(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
/** The value that occurs most often; ties go to the one seen first. */
function mostCommon(values) {
    const counts = new Map();
    for (const v of values)
        counts.set(v, (counts.get(v) ?? 0) + 1);
    let best = null;
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
function matchTroopIcons(troops, units, available) {
    const byName = new Map();
    for (const u of units) {
        const k = normalizeGameName(u.name);
        if (!byName.has(k))
            byName.set(k, []);
        byName.get(k).push(u);
    }
    const out = {};
    for (const t of troops) {
        const named = (byName.get(normalizeGameName(t.name)) ?? []).filter((u) => available((0, selection_js_1.safeArtName)(u.icon)));
        const exact = named.filter((u) => u.strength === t.strength && u.health === t.health);
        let pick = null;
        if (exact.length)
            pick = mostCommon(exact.map((u) => (0, selection_js_1.safeArtName)(u.icon)));
        else if (named.length && new Set(named.map((u) => (0, selection_js_1.safeArtName)(u.icon))).size === 1)
            pick = (0, selection_js_1.safeArtName)(named[0].icon);
        out[t.id] = pick;
    }
    return out;
}
function heroAvatarIcons(st, available) {
    const out = {};
    for (const [id, h] of Object.entries(st.heroes)) {
        const icon = (0, selection_js_1.safeArtName)(h.icon);
        if (available(icon))
            out[id] = icon;
    }
    return out;
}
function chestIcons(items, available) {
    const byName = new Map();
    for (const it of [...items].sort((a, b) => a.id - b.id)) {
        if (!(0, selection_js_1.isChestName)(it.name))
            continue;
        const icon = (0, selection_js_1.safeArtName)(it.icon);
        if (!available(icon))
            continue;
        if (!byName.has(it.name))
            byName.set(it.name, []);
        byName.get(it.name).push(icon);
    }
    const out = {};
    for (const [name, icons] of byName) {
        const pick = mostCommon(icons);
        if (pick)
            out[name] = pick;
    }
    return out;
}
function resourceIcons(items, resourceNames, available) {
    const out = {};
    for (const it of [...items].sort((a, b) => a.id - b.id)) {
        if (!(0, selection_js_1.isResourceItem)(it, resourceNames) || it.name in out)
            continue;
        const icon = (0, selection_js_1.safeArtName)(it.icon);
        if (available(icon))
            out[it.name] = icon;
    }
    return out;
}
function techIcons(st, available) {
    const out = {};
    for (const [id, t] of Object.entries(st.techs)) {
        const icon = (0, selection_js_1.safeArtName)(t.icon);
        if (available(icon))
            out[id] = icon;
    }
    return out;
}
function captainIcons(st, available) {
    const out = {};
    for (const [id, c] of Object.entries(st.captains ?? {})) {
        const pick = [c.icon, c.art].map((n) => (n ? (0, selection_js_1.safeArtName)(n) : '')).find((n) => n && available(n));
        if (pick)
            out[id] = pick;
    }
    return out;
}
/** EVENT_ART key → its image, for the ones that were extracted. */
function eventIcons(available) {
    const out = {};
    for (const [key, e] of Object.entries(selection_js_1.EVENT_ART)) {
        const name = (0, selection_js_1.safeArtName)(e.address);
        if (available(name))
            out[key] = name;
    }
    return out;
}
function buildMappings(st, troops, resourceNames, available) {
    return {
        heroAvatars: heroAvatarIcons(st, available),
        troops: matchTroopIcons(troops, st.units, available),
        chests: chestIcons(st.items, available),
        resources: resourceIcons(st.items, resourceNames, available),
        techs: techIcons(st, available),
        captains: captainIcons(st, available),
        ancients: eventIcons(available),
        artifacts: iconsById(st.artifacts, available),
        equipment: iconsById(st.equipment, available),
        inserts: iconsById(st.inserts, available),
    };
}
/** The image for a heroAvatar value, or null (unknown avatar, art not extracted yet). */
function heroAvatarImageFrom(mappings, heroAvatar) {
    if (heroAvatar === null || heroAvatar === undefined || !Number.isInteger(heroAvatar))
        return null;
    return mappings?.heroAvatars[String(heroAvatar)] ?? null;
}
const TROOP_FILE = path_1.default.resolve('src', 'web', 'public', 'lib', 'citadel-sim.js');
/**
 * Every troop Tools → Citadel and → Stacks show, and the citadels' defenders,
 * straight from the frontend's own troop list (a plain ES module with no
 * imports), so the two can never disagree. A defender sharing a troop's id is
 * that troop.
 */
async function loadTroopList(file = TROOP_FILE) {
    const src = await fs_1.default.promises.readFile(file, 'utf8');
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`));
    if (!Array.isArray(mod.TROOPS))
        throw new Error(`${file} exports no TROOPS`);
    const rows = [...mod.TROOPS, ...Object.values(mod.DEFENDERS ?? {})];
    const seen = new Set();
    return rows
        .filter((t) => !seen.has(t.id) && !!seen.add(t.id))
        .map((t) => ({ id: t.id, name: t.name, strength: t.str, health: t.hp }));
}
//# sourceMappingURL=mappings.js.map