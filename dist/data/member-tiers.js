"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMemberTiers = getMemberTiers;
exports.tierChanges = tierChanges;
/**
 * Every linked member's troop tiers (G/S/E/M and crypt level), computed from
 * their research as the game reports it (game_player_techs) and the game's
 * research trees. Replaces the levels clans used to post by hand; see
 * game-protocol/troop-tiers.ts for the rules and how they were checked.
 *
 * Also when each tier was reached: game_player_tech_history keeps a row per
 * research change, so walking the unlock techs' rows in time order gives every
 * tier change seen AFTER the member's first read. A tier held at the first
 * read has no date — it was reached at some point before we started looking.
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
const FAMILIES = ['guardsmen', 'specialists', 'engineers', 'monsters', 'crypts'];
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
function noChanges() {
    return { guardsmen: [], specialists: [], engineers: [], monsters: [], crypts: [] };
}
/** memberId → tiers, for every member linked to a game player whose research has been read. */
function getMemberTiers(clanId) {
    return (0, ttl_cache_js_1.cached)(`member-tiers:${clanId}`, CACHE_TTL_MS, () => {
        const out = new Map();
        const ix = index();
        if (!ix || !ix.ids.length)
            return out;
        const db = (0, database_js_1.getDb)();
        const idList = ix.ids.map(() => '?').join(',');
        const rows = db.prepare(`
      SELECT m.id AS memberId, t.tech_id AS techId, t.level
        FROM members m
        JOIN game_player_techs t ON t.clan_id = m.clan_id AND t.player_id = m.game_player_id
       WHERE m.clan_id = ? AND t.tech_id IN (${idList})
    `).all(clanId, ...ix.ids);
        // Members whose research was read at all (any tech), for "read but has no
        // unlocks yet", with the first and last read.
        const readRows = db.prepare(`
      SELECT m.id AS memberId, MIN(t.first_seen) AS firstRead, MAX(t.last_seen) AS seen
        FROM members m JOIN game_player_techs t ON t.clan_id = m.clan_id AND t.player_id = m.game_player_id
       WHERE m.clan_id = ? GROUP BY m.id
    `).all(clanId);
        const history = db.prepare(`
      SELECT m.id AS memberId, h.tech_id AS techId, h.level, h.changed_at AS at
        FROM members m
        JOIN game_player_tech_history h ON h.clan_id = m.clan_id AND h.player_id = m.game_player_id
       WHERE m.clan_id = ? AND h.tech_id IN (${idList})
       ORDER BY m.id, h.changed_at
    `).all(clanId, ...ix.ids);
        const levels = new Map();
        for (const r of rows) {
            const l = levels.get(r.memberId) ?? {};
            l[r.techId] = r.level;
            levels.set(r.memberId, l);
        }
        const historyBy = new Map();
        for (const h of history) {
            const list = historyBy.get(h.memberId);
            if (list)
                list.push(h);
            else
                historyBy.set(h.memberId, [h]);
        }
        for (const r of readRows) {
            // An empty map would read as "not read"; a placeholder key keeps crypts at I.
            const l = levels.get(r.memberId) ?? { 0: 0 };
            out.set(r.memberId, {
                tiers: (0, troop_tiers_js_1.troopTiers)(l, ix.index),
                readAt: r.seen,
                firstReadAt: r.firstRead,
                changes: tierChanges(historyBy.get(r.memberId) ?? [], r.firstRead, ix.index),
            });
        }
        return out;
    });
}
/**
 * Replay one member's unlock-tech history (time order) and keep every tier
 * change after the first read. Rows at or before `firstReadAt` are the
 * baseline: what the member already had when we started looking.
 */
function tierChanges(rows, firstReadAt, idx) {
    const changes = noChanges();
    const levels = { 0: 0 };
    let prev = (0, troop_tiers_js_1.troopTiers)(levels, idx);
    for (let i = 0; i < rows.length;) {
        const at = rows[i].at;
        for (; i < rows.length && rows[i].at === at; i++)
            levels[rows[i].techId] = rows[i].level;
        const now = (0, troop_tiers_js_1.troopTiers)(levels, idx);
        if (at > firstReadAt) {
            for (const f of FAMILIES) {
                const to = now[f];
                if (to !== null && to !== prev[f])
                    changes[f].push({ from: prev[f], to, at });
            }
        }
        prev = now;
    }
    return changes;
}
//# sourceMappingURL=member-tiers.js.map