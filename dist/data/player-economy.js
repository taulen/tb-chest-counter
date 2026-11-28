"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EPIC_STRENGTH_LABEL = exports.TRAINING_COST_LABELS = void 0;
exports.playerEconomy = playerEconomy;
/**
 * What a player's losses cost them, from their city as the last scan read it
 * (game_city_snapshots: `stats` from city-stats.ts, `buildings` `{slot: {type,
 * level}}`) — for Tools → Citadel and → Monsters, which plan for one of the
 * viewer's own linked players:
 *
 *  - training discounts per troop kind (the game's "Guardsmen's training
 *    cost" −78 % …): a guardsman, specialist or siege engine lost is trained
 *    again with Silver (the user, Nov 28 2026), and the discounts differ per
 *    kind, so they change which loss is cheaper. Checked in the game: Heavy
 *    Halberdier VII 1,500 × (1 − 0.78) = 330 Silver, the training window's price.
 *  - the Temple's level: a mercenary or monster lost is revived with Gold,
 *    divided by the Temple's factor (battle-data.json `temple`, 5.91 at 45).
 *  - the strength bonus against epic monsters, which the page names when a
 *    battle against an epic is the source of a plan against something else.
 *
 * Pure; tests/data/player-economy.test.ts.
 */
const city_stats_js_1 = require("../game-protocol/city-stats.js");
/** The game's own labels (English) of the lines read, by what they are. */
exports.TRAINING_COST_LABELS = {
    guardsmen: "Guardsmen's training cost",
    specialists: "Specialists' training cost",
    siege: "Siege engines' training cost",
};
exports.EPIC_STRENGTH_LABEL = 'Strength of your entire army against epic monsters';
/** A label's percent among a city's stats (any effect kind), or null. */
function statPercent(stats, label) {
    let found = null;
    for (const [key, v] of Object.entries(stats)) {
        if ((0, city_stats_js_1.splitStatKey)(key).label !== label || !Array.isArray(v))
            continue;
        const pct = Number(v[0]);
        if (Number.isFinite(pct))
            found = (found ?? 0) + pct;
    }
    return found;
}
function playerEconomy(stats, buildings, templeType) {
    const s = stats ?? {};
    const training = Object.fromEntries(Object.keys(exports.TRAINING_COST_LABELS).map((k) => [k, statPercent(s, exports.TRAINING_COST_LABELS[k])]));
    let templeLevel = null;
    if (templeType !== null && buildings && typeof buildings === 'object') {
        for (const b of Object.values(buildings)) {
            if (b && Number(b.type) === templeType && Number.isFinite(Number(b.level)))
                templeLevel = Math.max(templeLevel ?? 0, Number(b.level));
        }
    }
    return { training, templeLevel, epicStrength: statPercent(s, exports.EPIC_STRENGTH_LABEL) ?? 0 };
}
//# sourceMappingURL=player-economy.js.map