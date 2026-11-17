"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CITY_LOOK = exports.DEFAULT_AVATAR_FRAME = void 0;
exports.emptyMappings = emptyMappings;
exports.iconsById = iconsById;
exports.normalizeGameName = normalizeGameName;
exports.matchTroopIcons = matchTroopIcons;
exports.matchTroopTiers = matchTroopTiers;
exports.heroAvatarIcons = heroAvatarIcons;
exports.avatarFrameIcons = avatarFrameIcons;
exports.chestIcons = chestIcons;
exports.resourceIcons = resourceIcons;
exports.techIcons = techIcons;
exports.captainScaledArt = captainScaledArt;
exports.captainFullArt = captainFullArt;
exports.captainIcons = captainIcons;
exports.cityLookIcons = cityLookIcons;
exports.statusIcons = statusIcons;
exports.eventIcons = eventIcons;
exports.buildMappings = buildMappings;
exports.heroAvatarImageFrom = heroAvatarImageFrom;
exports.avatarFrameImageFrom = avatarFrameImageFrom;
exports.cityLookImageFrom = cityLookImageFrom;
exports.loadTroopList = loadTroopList;
/**
 * Game data → image name, computed from the game's static data (never hand-typed):
 *
 *   heroAvatars  a player's heroAvatar (game_players.hero_avatar, message 402
 *                field [4]) is the id of a T13 hero-avatar row; that row's icon
 *                is the portrait ("icon_garvel_72").
 *   avatarFrames a player's portrait frame (game_players.avatar_frame, 402
 *                field [6]) is the id of a T52 customization; its visual is
 *                the frame sprite ("vip_frame"). 1 = "Standard", the default.
 *   troops      every Tools → Citadel/Stacks troop and citadel defender
 *                (TROOPS + DEFENDERS in web/public/lib/citadel-sim.js) is
 *                matched to a T9 unit by its English name AND its
 *                strength/health, which the game has many rows for (one per
 *                event realm) but all with the same icon.
 *   troopTiers   the same troops → the matched unit's tier (T9 f2), which
 *                picks the game's frame for its icon.
 *   unitFrames   tier → the back, frame and badge the game draws a unit icon
 *                in (unit-frames.ts; extracted from the WebGL client).
 *   chests       English chest name → the icon most of the T8 items of that
 *                name use (one name can be several items, e.g. per source).
 *   resources    English resource name → the icon of the lowest-id T8 item of
 *                that name (the base resource; later ids are boosters/packs).
 *   techs        T21 tech/talent id → icon.
 *   ancients     the Ancient planner's pictures by key (EVENT_ART in
 *                selection.ts): tome, figurine, clock, tinman.
 *   cityLooks    a player's city look (game_players.city_appearance, 402
 *                field [5], a T52 customization) → lowest city level → icon;
 *                9 = "Player's City", the default.
 *   status       city state and holdings by key (STATUS_ART in selection.ts):
 *                shield, burning, wallsDown, flame, city, goldIngots.
 *   artifacts    T110 artifact type → its icon (the type's config `icon`).
 *   equipment    T11 equipment item type → its icon (f2 address, "arch_body").
 *   inserts      T8 gem / enchantment id → its icon (f6 visual).
 *   titles       T29 title id → its round icon (visual smallIcon, 28 px).
 *   titleArt     T29 title id → its 72 px picture (visual mobileIcon).
 *   itemFrames   item quality grade → the back an item tile is drawn on, the
 *                plain back of an ungraded item, and the item frame
 *                (unit-frames.ts; from the WebGL client). Item icons
 *                themselves go by id (item-icons.ts), not through here.
 *
 * Every mapping only names images that were actually extracted.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const selection_js_1 = require("./selection.js");
const unit_frames_js_1 = require("./unit-frames.js");
function emptyMappings() {
    return {
        heroAvatars: {}, avatarFrames: {}, heroLevelBadge: null, troops: {}, troopTiers: {}, unitFrames: {},
        chests: {}, resources: {}, techs: {}, captains: {}, captainArt: {}, ancients: {}, cityLooks: {}, status: {},
        artifacts: {}, equipment: {}, inserts: {}, titles: {}, titleArt: {}, itemFrames: { backs: {}, plainBack: null, frame: null },
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
/**
 * Troop → the tier of the unit it matches, on the same rule as its icon: the
 * rows with its name AND stats decide (most common tier); without such a row,
 * a name whose rows all share one tier. Rows that disagree give null — the
 * icon is then shown without a frame rather than in a guessed one.
 */
function matchTroopTiers(troops, units) {
    const byName = new Map();
    for (const u of units) {
        if (typeof u.tier !== 'number')
            continue; // a cache from before tiers were read
        const k = normalizeGameName(u.name);
        if (!byName.has(k))
            byName.set(k, []);
        byName.get(k).push(u);
    }
    const out = {};
    for (const t of troops) {
        const named = byName.get(normalizeGameName(t.name)) ?? [];
        const exact = named.filter((u) => u.strength === t.strength && u.health === t.health);
        let tier = null;
        if (exact.length)
            tier = Number(mostCommon(exact.map((u) => String(u.tier))));
        else if (named.length && new Set(named.map((u) => u.tier)).size === 1)
            tier = named[0].tier;
        out[t.id] = tier;
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
function avatarFrameIcons(st, available) {
    const out = {};
    for (const [id, f] of Object.entries(st.frames ?? {})) {
        const img = (0, selection_js_1.safeArtName)(f.visual);
        if (available(img))
            out[id] = img;
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
/**
 * The full-body art for a captain's smallIcon: carter_icon → carter_scaled —
 * the still of the captain screen's art (carter_artbundle's front image); the
 * client derives the name, nothing in the static data spells it out. '' when
 * the icon doesn't end in _icon.
 */
function captainScaledArt(icon) {
    return /_icon$/i.test(icon) ? `${icon.replace(/_icon$/i, '')}_scaled` : '';
}
/** Captain → full-body art (`_scaled`), else the level-up art, for those extracted. */
function captainFullArt(st, available) {
    const out = {};
    for (const [id, c] of Object.entries(st.captains ?? {})) {
        const pick = [captainScaledArt(c.icon), c.art].map((n) => (n ? (0, selection_js_1.safeArtName)(n) : '')).find((n) => n && available(n));
        if (pick)
            out[id] = pick;
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
/** City look → its icons by lowest city level, for the looks with at least one extracted. */
function cityLookIcons(st, available) {
    const out = {};
    for (const [id, look] of Object.entries(st.cityLooks ?? {})) {
        const icons = {};
        for (const [lvl, icon] of Object.entries(look.icons)) {
            const img = (0, selection_js_1.safeArtName)(icon);
            if (available(img))
                icons[lvl] = img;
        }
        if (Object.keys(icons).length)
            out[id] = icons;
    }
    return out;
}
/** STATUS_ART key → its image, for the ones that were extracted. */
function statusIcons(available) {
    const out = {};
    for (const [key, address] of Object.entries(selection_js_1.STATUS_ART)) {
        const name = (0, selection_js_1.safeArtName)(address);
        if (available(name))
            out[key] = name;
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
        avatarFrames: avatarFrameIcons(st, available),
        heroLevelBadge: available((0, selection_js_1.safeArtName)(unit_frames_js_1.HERO_LEVEL_BADGE)) ? (0, selection_js_1.safeArtName)(unit_frames_js_1.HERO_LEVEL_BADGE) : null,
        troops: matchTroopIcons(troops, st.units, available),
        troopTiers: matchTroopTiers(troops, st.units),
        unitFrames: (0, unit_frames_js_1.unitFrameArt)(available),
        chests: chestIcons(st.items, available),
        resources: resourceIcons(st.items, resourceNames, available),
        techs: techIcons(st, available),
        captains: captainIcons(st, available),
        captainArt: captainFullArt(st, available),
        captainTile: (0, unit_frames_js_1.captainTileArt)(available),
        ancients: eventIcons(available),
        cityLooks: cityLookIcons(st, available),
        status: statusIcons(available),
        artifacts: iconsById(st.artifacts, available),
        equipment: iconsById(st.equipment, available),
        inserts: iconsById(st.inserts, available),
        titles: iconsById(st.titles, available),
        titleArt: iconsById(Object.fromEntries(Object.entries(st.titles ?? {}).map(([id, tt]) => [id, { icon: tt.art }])), available),
        itemFrames: (0, unit_frames_js_1.itemFrameArt)(available),
    };
}
/** The image for a heroAvatar value, or null (unknown avatar, art not extracted yet). */
function heroAvatarImageFrom(mappings, heroAvatar) {
    if (heroAvatar === null || heroAvatar === undefined || !Number.isInteger(heroAvatar))
        return null;
    return mappings?.heroAvatars[String(heroAvatar)] ?? null;
}
/** The game's default portrait frame ("Standard"), for a player whose frame is unknown. */
exports.DEFAULT_AVATAR_FRAME = 1;
/**
 * The frame image a player's hero portrait is drawn in: theirs, else the
 * game's default (a player with none set has 1 = "Standard" anyway). Null when
 * the art has neither.
 */
function avatarFrameImageFrom(mappings, frameId) {
    const frames = mappings?.avatarFrames;
    if (!frames)
        return null;
    const own = frameId !== null && frameId !== undefined && Number.isInteger(frameId) ? frames[String(frameId)] : undefined;
    return own ?? frames[String(exports.DEFAULT_AVATAR_FRAME)] ?? null;
}
/** The game's default city look ("Player's City"), for a player whose look is unknown. */
exports.DEFAULT_CITY_LOOK = 9;
/**
 * The icon of a player's city as the game shows it: their look (theirs, else
 * the default) at the highest level step their city has reached. Null when
 * the art has neither look.
 */
function cityLookImageFrom(mappings, lookId, cityLevel) {
    const looks = mappings?.cityLooks;
    if (!looks)
        return null;
    const own = lookId !== null && lookId !== undefined && Number.isInteger(lookId) ? looks[String(lookId)] : undefined;
    const icons = own ?? looks[String(exports.DEFAULT_CITY_LOOK)];
    if (!icons)
        return null;
    const steps = Object.keys(icons).map(Number).sort((a, b) => a - b);
    const level = typeof cityLevel === 'number' && cityLevel > 0 ? cityLevel : 1;
    const step = [...steps].reverse().find((s) => s <= level) ?? steps[0];
    return icons[String(step)] ?? null;
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