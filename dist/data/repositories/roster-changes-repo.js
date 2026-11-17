"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadRosterSources = loadRosterSources;
exports.rosterReadSince = rosterReadSince;
/**
 * The rows the clan's joins & leaves are built from (data/roster-changes.ts),
 * all already kept by other features: the members (first_seen, left_at, the
 * game link), the game's players (joined_at, in_clan) and the audit rows the
 * member sync and the admins write (member.left_clan, restore_member). Every
 * read is clan-scoped; a clan is a few hundred rows of each.
 */
const database_js_1 = require("../database.js");
const merge_repo_js_1 = require("./merge-repo.js");
const fuzzy_js_1 = require("../../utils/fuzzy.js");
function parseAliases(raw) {
    try {
        const v = JSON.parse(raw || '[]');
        return Array.isArray(v) ? v.filter((a) => typeof a === 'string') : [];
    }
    catch {
        return [];
    }
}
function loadRosterSources(clanId) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare(`SELECT id, name, normalized_name, aliases, first_seen, last_seen, is_active, left_at, game_player_id
       FROM members WHERE clan_id = ? ORDER BY id`).all(clanId);
    const members = rows.map((r) => ({
        id: r.id, name: r.name, normalizedName: r.normalized_name, aliases: parseAliases(r.aliases),
        firstSeen: r.first_seen, lastSeen: r.last_seen, isActive: r.is_active === 1, leftAt: r.left_at,
    }));
    const byPlayer = new Map(rows.filter((r) => r.game_player_id !== null).map((r) => [r.game_player_id, r.id]));
    // A player no member is linked to is an alt an admin's merge rule folds into
    // a main (the member sync counts it there and never links it) — or a
    // newcomer whose name a linked member already owns, which stays on its own.
    const canonical = (0, merge_repo_js_1.loadPlayerNameCanonicaliser)(clanId);
    const players = db.prepare('SELECT player_id, name, joined_at, in_clan FROM game_players WHERE clan_id = ? ORDER BY player_id').all(clanId).map((p) => {
        const linked = byPlayer.get(p.player_id);
        let memberId = linked ?? null;
        if (memberId === null) {
            const ruled = canonical(p.name);
            if (ruled !== p.name)
                memberId = (0, fuzzy_js_1.exactMatchMember)(ruled, members)?.id ?? null;
        }
        return { playerId: p.player_id, name: p.name, joinedAt: p.joined_at, inClan: p.in_clan === 1, memberId, linked: linked !== undefined };
    });
    // Departures are logged by the sync with the clan; a restore before the
    // audit log carried the clan (Oct 2026) has none, and is matched by name.
    const audit = [];
    for (const r of db.prepare(`SELECT created_at AS at, action, details FROM audit_log
      WHERE (action = 'member.left_clan' AND clan_id = ?)
         OR (action = 'restore_member' AND (clan_id = ? OR clan_id IS NULL))
      ORDER BY created_at, id`).all(clanId, clanId)) {
        try {
            audit.push({ at: r.at, action: r.action, details: r.details ? JSON.parse(r.details) : {} });
        }
        catch { /* unreadable details: skipped */ }
    }
    return { members, players, audit };
}
/**
 * The game's first read of the clan's roster (game_players.first_seen): join
 * times exist for everyone in the clan from then on. Null before any.
 */
function rosterReadSince(clanId) {
    const r = (0, database_js_1.getDb)().prepare('SELECT MIN(first_seen) AS at FROM game_players WHERE clan_id = ?').get(clanId);
    return r.at;
}
//# sourceMappingURL=roster-changes-repo.js.map