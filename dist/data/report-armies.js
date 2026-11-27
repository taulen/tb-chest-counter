"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportArmiesFor = reportArmiesFor;
/**
 * A player's own armies as their shared battle reports recorded them, for
 * Tools → Citadel and → Stacks: "use the bonuses from my report"
 * (docs/battle-reports.md). The bonuses themselves are worked out in the
 * browser (lib/report-bonuses.js), which has the calculators' troops and the
 * citadels' defenders; this sends what the game measured:
 *
 *  - each troop's units and the game's base strength and health (T9);
 *  - its health per unit with every bonus: the stack's pool on the first hit
 *    it took ÷ its units — exact, a full stack's pool is units × unit health;
 *  - every strike it made with the strike's base damage — the log's extraB
 *    when the strike doubled (that is the damage before the luck), else the
 *    damage when the target survived (not capped). Checked against the Nov 7
 *    2026 Elven 30 report: extraB is the simulator's units × strength ×
 *    (1 + bonus + features) to the unit.
 */
const database_js_1 = require("./database.js");
const art_static_js_1 = require("../game-art/art-static.js");
const store_js_1 = require("../game-art/store.js");
const static_data_js_1 = require("../game-protocol/static-data.js");
const LIVE = {
    units: () => (0, art_static_js_1.cachedArtUnits)((0, store_js_1.gameArtDir)()),
    objects: async () => (await (0, static_data_js_1.loadGameNames)()).objects,
};
/** The newest battles these players fought whose strike log was read, newest first. */
async function reportArmiesFor(playerIds, limit = 8, lookups = LIVE) {
    if (!playerIds.length)
        return [];
    const ph = playerIds.map(() => '?').join(',');
    const rows = (0, database_js_1.getDb)().prepare(`SELECT entry_id, report_at, target_static_id, won, summary FROM battle_reports
     WHERE status = 'ok' AND kind = 'battle' AND attacker_player_id IN (${ph}) AND summary LIKE '%"strikes"%'
     ORDER BY report_at DESC LIMIT ?`).all(...playerIds, limit);
    if (!rows.length)
        return [];
    const units = lookups.units();
    let objects = {};
    try {
        objects = await lookups.objects();
    }
    catch { /* names unavailable: targets go unnamed */ }
    const unitOf = (id) => {
        const u = units.get(id);
        return { unit: id, name: u?.name ?? '', strength: u?.strength ?? 0, health: u?.health ?? 0 };
    };
    const out = [];
    for (const r of rows) {
        let s;
        try {
            s = JSON.parse(r.summary);
        }
        catch {
            continue;
        }
        const mine = s.attackers[0];
        if (!mine)
            continue;
        const strikes = s.strikes ?? [];
        const troops = mine.units.map(([unit, count]) => {
            const firstHit = strikes.find((x) => x.targetArmyId === mine.army && x.targetUnit === unit && x.targetCount > 0);
            const own = strikes.filter((x) => x.byAttacker && x.armyId === mine.army && x.unit === unit && x.count > 0);
            return {
                ...unitOf(unit),
                count,
                unitHealth: firstHit ? firstHit.poolBefore / firstHit.targetCount : null,
                strikes: own.flatMap((x) => {
                    const base = x.extraB > 0 ? x.extraB : x.countAfter > 0 ? x.damage : 0;
                    return base > 0 ? [{ count: x.count, base, target: unitOf(x.targetUnit) }] : [];
                }),
            };
        });
        out.push({
            entryId: r.entry_id,
            at: new Date(r.report_at * 1000).toISOString(),
            target: { staticId: r.target_static_id, name: r.target_static_id !== null ? objects[String(r.target_static_id)] ?? '' : '' },
            won: r.won === 1,
            troops,
        });
    }
    return out;
}
//# sourceMappingURL=report-armies.js.map