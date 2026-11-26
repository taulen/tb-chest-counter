"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VIP_TECH_ID = exports.SPEED_STATS = void 0;
exports.citySpeeds = citySpeeds;
exports.SPEED_STATS = ['research', 'construction', 'training'];
/** The order the triple in names.json keeps them in. */
const TRIPLE_INDEX = { construction: 0, training: 1, research: 2 };
/**
 * Field 14's source bits, named from what each one's effects belong to:
 * 2 research and Hall of Fame (T21 levels), 4 the main buildings at their
 * levels (the Academy at 45: +300 % research), 32 the Barracks and walls
 * (T17), 16 gear with its gems and enchantments, 128 captain levels and star
 * levels (T10, T75), 256 titles (T29), 1 / 8192 / 16384 an artifact's rolls,
 * star level and level, 2048 / 4096 shop offers (T19).
 */
const SOURCE_BITS = [
    [2, 'research'], [4, 'buildings'], [32, 'buildings'], [16, 'gear'], [128, 'captains'], [256, 'titles'],
    [16384, 'artifacts'], [8192, 'artifacts'], [1, 'artifacts'], [2048, 'offers'], [4096, 'offers'],
];
exports.VIP_TECH_ID = 1000;
function sourceOf(bits) {
    for (const [bit, source] of SOURCE_BITS)
        if ((bits & bit) !== 0)
            return source;
    return 'other';
}
const round = (v) => Math.round(v * 100) / 100;
/**
 * The three speeds of a city. `effects` is field 14 (`[effectId, sourceBits,
 * count]`); `vip` the player's VIP level, `clanLevels` the clan's research
 * levels when the city was read. Null when the reply carried no effects (a
 * malformed reply, not a city without bonuses).
 */
function citySpeeds(effects, table, extra = {}) {
    if (!effects.length)
        return null;
    const out = {};
    for (const stat of exports.SPEED_STATS)
        out[stat] = { total: 0, by: {} };
    const add = (effectId, count, source) => {
        const triple = table.effects[String(effectId)];
        if (!triple)
            return;
        for (const stat of exports.SPEED_STATS) {
            const v = triple[TRIPLE_INDEX[stat]] * count;
            if (!v)
                continue;
            out[stat].total += v;
            out[stat].by[source] = (out[stat].by[source] ?? 0) + v;
        }
    };
    for (const e of effects)
        add(e.id, e.count || 1, sourceOf(e.source));
    const byLevel = (techId, level) => (level ? table.techs[techId]?.[String(level)] : undefined);
    const vipEffect = byLevel(String(exports.VIP_TECH_ID), extra.vip);
    if (vipEffect)
        add(vipEffect, 1, 'vip');
    for (const [techId, level] of Object.entries(extra.clanLevels ?? {})) {
        const effect = byLevel(techId, level);
        if (effect)
            add(effect, 1, 'clan');
    }
    for (const stat of exports.SPEED_STATS) {
        out[stat].total = round(out[stat].total);
        for (const k of Object.keys(out[stat].by))
            out[stat].by[k] = round(out[stat].by[k]);
    }
    return out;
}
//# sourceMappingURL=city-speeds.js.map