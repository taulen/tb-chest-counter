"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CAPTAIN_STAR_OFF = exports.CAPTAIN_STAR_ON = exports.CAPTAIN_LEVEL_PLATE = exports.CAPTAIN_RARITY_COLOURS = exports.HERO_LEVEL_BADGE = exports.TIER_NUMERALS = exports.UNIT_TIER_COLOURS = void 0;
exports.unitFrameTextures = unitFrameTextures;
exports.captainTileArt = captainTileArt;
exports.clientUiTextures = clientUiTextures;
exports.unitFrameArt = unitFrameArt;
/**
 * How the game frames a unit's icon — read from the WebGL client's own UI
 * (prefab `Core/Icon/UnitIconView` in its Resources, Nov 2026; webgl-client.ts
 * extracts the sprites):
 *
 *   a 72×72 box holding, back to front,
 *     Back        back_icon_units_72x72_<colour>     72×72, centred
 *     Icon        the unit's portrait (T9 f4)         72×72 — most are cut-outs,
 *                                                     so the back shows through
 *     UnitBorder  frame_icon_units_94x92_<colour>    94×92, centred 2 px low
 *     TierIcon    icons_tir_<roman>_1                33×33, top-left 12 px left
 *                                                     of and 10 px above the box
 *
 * <colour> is the unit's tier (T9 f2) on the game's tier ladder, the same one
 * its per-tier draperies (drapery_tir_<roman>_1) are coloured by: 0 grey,
 * I white, II green, III blue, IV violet, V orange, VI red, VII gold, then
 * VIII–X the "II" shades (whiteII, greenII, blueII). The client's code picks
 * the sprites at run time; the ladder is what its art is named and coloured by.
 *
 * The roman badge exists for tiers I–VII only (icons_tir_I_1 … _VII_1) and a
 * plain grey disc for 0 (icons_tir_0_3). Tiers VIII–X have no badge sprite:
 * we show the plain disc of their colour family (icons_tir_<I|II|III>_3: white,
 * green, blue) with the numeral written over it (`numeral`).
 *
 * The geometry lives in style.css (.unit-icon) and is kept in step with this.
 */
const selection_js_1 = require("./selection.js");
/** Tier → the colour suffix of its back and frame sprites (index = tier). */
exports.UNIT_TIER_COLOURS = [
    'grey', 'white', 'green', 'blue', 'violet', 'orange', 'red', 'gold', 'whiteII', 'greenII', 'blueII',
];
exports.TIER_NUMERALS = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
/** The highest tier with a roman badge sprite of its own. */
const LAST_BADGE_TIER = 7;
const backName = (colour) => `back_icon_units_72x72_${colour}`;
const frameName = (colour) => `frame_icon_units_94x92_${colour}`;
/** A tier's badge sprite, and the numeral to write over it when the sprite has none. */
function badgeOf(tier) {
    if (tier === 0)
        return { sprite: 'icons_tir_0_3', numeral: null };
    if (tier <= LAST_BADGE_TIER)
        return { sprite: `icons_tir_${exports.TIER_NUMERALS[tier]}_1`, numeral: null };
    // VIII → I's white disc, IX → II's green, X → III's blue.
    return { sprite: `icons_tir_${exports.TIER_NUMERALS[tier - LAST_BADGE_TIER]}_3`, numeral: exports.TIER_NUMERALS[tier] };
}
/** The client texture names a unit frame uses (exact, case kept: "whiteII"). */
function unitFrameTextures() {
    const out = new Set();
    exports.UNIT_TIER_COLOURS.forEach((colour, tier) => {
        out.add(backName(colour));
        out.add(frameName(colour));
        out.add(badgeOf(tier).sprite);
    });
    return [...out];
}
/**
 * The plate the game writes a player's hero level on, at the top-right of
 * their framed portrait (prefab `UserIconView`, child `LevelView__level`:
 * 29×35, its top-left 53 px right of the portrait's left edge and 8 px above
 * it; the number centred, 1.5 px high). The view chooses among icons_tir_1 and
 * icons_tir_shield_1…6 in code we cannot read; this is the sprite the prefab
 * is saved with.
 */
exports.HERO_LEVEL_BADGE = 'icons_tir_shield_4';
/**
 * A captain's tile, as the game's line-up draws it (user's screenshot, Nov
 * 2026: Carter purple = epic, Helen gold = legendary, Farhad red = mythic):
 * the unit icon's back and frame in the captain's RARITY colour (T75 f2:
 * 1 rare → blue, 2 epic → violet, 3 legendary → gold, 4 mythic → red — the
 * same back_icon_units / frame_icon_units sprites a unit icon uses), the
 * captain's head shot (T75 smallIcon) between them, the level on a dark
 * shield plate at the top-right, and the stars along the bottom edge.
 */
exports.CAPTAIN_RARITY_COLOURS = {
    1: 'blue', 2: 'violet', 3: 'gold', 4: 'red',
};
exports.CAPTAIN_LEVEL_PLATE = 'icons_tir_shield_2';
exports.CAPTAIN_STAR_ON = 'icons_star_up';
exports.CAPTAIN_STAR_OFF = 'icons_star_down';
function captainTileArt(available) {
    const out = { backs: {}, frames: {}, levelPlate: null, starOn: null, starOff: null };
    for (const [rarity, colour] of Object.entries(exports.CAPTAIN_RARITY_COLOURS)) {
        const back = (0, selection_js_1.safeArtName)(backName(colour));
        const frame = (0, selection_js_1.safeArtName)(frameName(colour));
        if (available(back) && available(frame)) {
            out.backs[rarity] = back;
            out.frames[rarity] = frame;
        }
    }
    const pick = (n) => (available((0, selection_js_1.safeArtName)(n)) ? (0, selection_js_1.safeArtName)(n) : null);
    out.levelPlate = pick(exports.CAPTAIN_LEVEL_PLATE);
    out.starOn = pick(exports.CAPTAIN_STAR_ON);
    out.starOff = pick(exports.CAPTAIN_STAR_OFF);
    return out;
}
/** Every texture we take from the client build. */
function clientUiTextures() {
    return [...new Set([...unitFrameTextures(), exports.HERO_LEVEL_BADGE, exports.CAPTAIN_LEVEL_PLATE, exports.CAPTAIN_STAR_ON, exports.CAPTAIN_STAR_OFF])];
}
/**
 * Tier ("0"–"10") → its frame art, for the tiers whose back and frame were
 * extracted. A missing badge leaves the frame without one.
 */
function unitFrameArt(available) {
    const out = {};
    exports.UNIT_TIER_COLOURS.forEach((colour, tier) => {
        const back = (0, selection_js_1.safeArtName)(backName(colour));
        const frame = (0, selection_js_1.safeArtName)(frameName(colour));
        if (!available(back) || !available(frame))
            return;
        const b = badgeOf(tier);
        const badge = (0, selection_js_1.safeArtName)(b.sprite);
        out[String(tier)] = available(badge) ? { back, frame, badge, numeral: b.numeral } : { back, frame, badge: null, numeral: null };
    });
    return out;
}
//# sourceMappingURL=unit-frames.js.map