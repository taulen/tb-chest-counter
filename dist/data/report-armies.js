"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportPlayers = reportPlayers;
exports.reportArmiesFor = reportArmiesFor;
/**
 * Players' armies as their shared battle reports recorded them, for Tools →
 * Citadel and → Stacks: "fill in from a battle report" (docs/battle-reports.md).
 * The bonuses themselves are worked out in the browser (lib/report-bonuses.js),
 * which has the calculators' troops and the citadels' defenders; this sends
 * what the game measured:
 *
 *  - each troop's units and the game's base strength and health (T9);
 *  - its health per unit with every bonus: the stack's pool on the first hit
 *    it took ÷ its units — exact, a full stack's pool is units × unit health;
 *  - every strike it made with the strike's base damage — the log's extraB
 *    when the strike doubled (that is the damage before the luck), else the
 *    damage when the target survived (not capped). Checked against the Nov 7
 *    2026 Elven 30 report: extraB is the simulator's units × strength ×
 *    (1 + bonus + features) to the unit.
 *
 * Whose: a player's battles are the ones they FOUGHT (the march owner — the
 * army whose bonuses these are) and the ones they POSTED (usually their own;
 * a report of someone else's army says whose it is). The viewer picks the
 * player (reportPlayers): their own players see every clan's shares, anyone
 * else only what was shared in the clan being viewed.
 */
const database_js_1 = require("./database.js");
const art_static_js_1 = require("../game-art/art-static.js");
const store_js_1 = require("../game-art/store.js");
const static_data_js_1 = require("../game-protocol/static-data.js");
const game_player_names_js_1 = require("./game-player-names.js");
const LIVE = {
    units: () => (0, art_static_js_1.cachedArtUnits)((0, store_js_1.gameArtDir)()),
    objects: async () => (await (0, static_data_js_1.loadGameNames)()).objects,
};
/** Battles of the dialog: read, with a strike log. */
const READABLE = `r.status = 'ok' AND r.kind = 'battle' AND r.summary LIKE '%"strikes"%'`;
/** A player's name: the clan's (member or game), else the game's anywhere, else what they post under. */
function namesFor(clanId, ids) {
    const out = new Map();
    for (const [id, n] of (0, game_player_names_js_1.gamePlayerNames)(clanId, ids))
        if (n.name)
            out.set(id, n.name);
    const db = (0, database_js_1.getDb)();
    for (const id of ids) {
        if (out.has(id))
            continue;
        const g = db.prepare('SELECT name FROM game_players WHERE player_id = ? ORDER BY last_seen DESC LIMIT 1').get(id);
        const s = g ? undefined : db.prepare("SELECT sender_name AS name FROM battle_report_shares WHERE sender_player_id = ? AND sender_name <> '' ORDER BY shared_at DESC LIMIT 1").get(id);
        const name = g?.name ?? s?.name;
        if (name)
            out.set(id, name);
    }
    return out;
}
/**
 * The players the viewer can pick: their own (every clan's shares) and anyone
 * who fought or posted a readable battle shared in `clanId`. Own first, then
 * by name.
 */
function reportPlayers(clanId, ownIds) {
    const db = (0, database_js_1.getDb)();
    const fought = db.prepare(`SELECT r.attacker_player_id AS p, COUNT(DISTINCT r.entry_id) AS n FROM battle_reports r
     JOIN battle_report_shares s ON s.entry_id = r.entry_id AND s.clan_id = ?
     WHERE ${READABLE} AND r.attacker_player_id IS NOT NULL GROUP BY r.attacker_player_id`).all(clanId);
    const posted = db.prepare(`SELECT s.sender_player_id AS p FROM battle_report_shares s JOIN battle_reports r ON r.entry_id = s.entry_id
     WHERE s.clan_id = ? AND ${READABLE} AND s.sender_player_id IS NOT NULL GROUP BY s.sender_player_id`).all(clanId);
    const ids = new Set([...ownIds, ...fought.map((r) => r.p), ...posted.map((r) => r.p)]);
    const names = namesFor(clanId, [...ids]);
    const own = new Set(ownIds);
    return [...ids].map((id) => ({
        playerId: id,
        name: names.get(id) ?? '',
        battles: battleIds(id, own.has(id) ? null : clanId).length,
        own: own.has(id),
    }))
        .filter((p) => p.own || p.battles > 0)
        .sort((a, b) => Number(b.own) - Number(a.own) || Number(!a.name) - Number(!b.name) || a.name.localeCompare(b.name));
}
/** A player's readable battles (fought or posted), newest first; `clanId` = only those shared there. */
function battleIds(playerId, clanId, limit = 1000) {
    return (0, database_js_1.getDb)().prepare(`SELECT r.entry_id FROM battle_reports r
     WHERE ${READABLE}
       AND (r.attacker_player_id = ? OR EXISTS (SELECT 1 FROM battle_report_shares s WHERE s.entry_id = r.entry_id AND s.sender_player_id = ?))
       AND (? IS NULL OR EXISTS (SELECT 1 FROM battle_report_shares s WHERE s.entry_id = r.entry_id AND s.clan_id = ?))
     ORDER BY r.report_at DESC LIMIT ?`).all(playerId, playerId, clanId, clanId, limit).map((r) => r.entry_id);
}
/**
 * A player's newest battles with a strike log (fought or posted), newest first.
 * `clanId` limits them to what was shared in that clan (anyone but the
 * viewer's own players); `namesClanId` is the clan whose names are used.
 */
async function reportArmiesFor(playerId, opts, lookups = LIVE) {
    const ids = battleIds(playerId, opts.clanId, opts.limit ?? 12);
    if (!ids.length)
        return [];
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`SELECT r.entry_id, r.report_at, r.target_static_id, r.won, r.attacker_player_id, r.summary,
            (SELECT s.sender_name FROM battle_report_shares s WHERE s.entry_id = r.entry_id ORDER BY s.shared_at LIMIT 1) AS shared_by
     FROM battle_reports r WHERE r.entry_id = ?`);
    const rows = ids.map((id) => row.get(id));
    const units = lookups.units();
    let objects = {};
    try {
        objects = await lookups.objects();
    }
    catch { /* names unavailable: targets go unnamed */ }
    const attackerNames = namesFor(opts.namesClanId, [...new Set(rows.map((r) => r.attacker_player_id).filter((p) => p !== null))]);
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
            attacker: { playerId: r.attacker_player_id, name: r.attacker_player_id !== null ? attackerNames.get(r.attacker_player_id) ?? '' : '' },
            sharedBy: r.shared_by ?? '',
            troops,
        });
    }
    return out;
}
//# sourceMappingURL=report-armies.js.map