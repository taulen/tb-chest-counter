"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMemberTiers = getMemberTiers;
/**
 * Every linked member's troop tiers (G/S/E/M and crypt level), computed from
 * their research as the game reports it (game_player_techs) and the game's
 * research trees. Replaces the levels clans used to post by hand; see
 * game-protocol/troop-tiers.ts for the rules and how they were checked.
 *
 * Synchronous: uses the trees already loaded or cached on disk
 * (cachedTechTrees); the scan loop keeps them current. Null tiers until the
 * trees exist on this install.
 */
const database_js_1 = require("./database.js");
const ttl_cache_js_1 = require("../utils/ttl-cache.js");
const tech_trees_js_1 = require("../game-protocol/tech-trees.js");
const troop_tiers_js_1 = require("../game-protocol/troop-tiers.js");
const CACHE_TTL_MS = 60_000;
let built = null;
function index() {
    const trees = (0, tech_trees_js_1.cachedTechTrees)();
    if (!trees)
        return null;
    if (built?.version !== trees.version) {
        const idx = (0, troop_tiers_js_1.unlockIndex)(trees);
        built = { version: trees.version, index: idx, ids: [...new Set(Object.values(idx).flatMap((m) => [...m.keys()]))] };
    }
    return built;
}
/** memberId → tiers, for every member linked to a game player whose research has been read. */
function getMemberTiers(clanId) {
    return (0, ttl_cache_js_1.cached)(`member-tiers:${clanId}`, CACHE_TTL_MS, () => {
        const out = new Map();
        const ix = index();
        if (!ix || !ix.ids.length)
            return out;
        const db = (0, database_js_1.getDb)();
        const rows = db.prepare(`
      SELECT m.id AS memberId, t.tech_id AS techId, t.level, t.last_seen AS seen
        FROM members m
        JOIN game_player_techs t ON t.clan_id = m.clan_id AND t.player_id = m.game_player_id
       WHERE m.clan_id = ? AND t.tech_id IN (${ix.ids.map(() => '?').join(',')})
    `).all(clanId, ...ix.ids);
        // Members whose research was read at all (any tech), for "read but has no unlocks yet".
        const readRows = db.prepare(`
      SELECT m.id AS memberId, MAX(t.last_seen) AS seen
        FROM members m JOIN game_player_techs t ON t.clan_id = m.clan_id AND t.player_id = m.game_player_id
       WHERE m.clan_id = ? GROUP BY m.id
    `).all(clanId);
        const levels = new Map();
        for (const r of rows) {
            const l = levels.get(r.memberId) ?? {};
            l[r.techId] = r.level;
            levels.set(r.memberId, l);
        }
        for (const r of readRows) {
            // An empty map would read as "not read"; a placeholder key keeps crypts at I.
            const l = levels.get(r.memberId) ?? { 0: 0 };
            out.set(r.memberId, { tiers: (0, troop_tiers_js_1.troopTiers)(l, ix.index), readAt: r.seen });
        }
        return out;
    });
}
//# sourceMappingURL=member-tiers.js.map