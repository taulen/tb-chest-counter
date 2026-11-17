"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncMembersFromGame = syncMembersFromGame;
/**
 * Bring our members in line with what the game says, keyed on the game's
 * permanent player id (members.game_player_id, v103).
 *
 * For every member of the clan record (name first run through the clan's
 * player merge rules, like every OCR read path):
 *   1. already linked → that member;
 *   2. else link an unlinked member whose name matches exactly (accent- and
 *      space-insensitive, aliases included — exactMatchMember);
 *   3. else link an unlinked ACTIVE member that fuzzy-matches (OCR damage) AND
 *      whose latest might is within ±15 % of the game's — the might check is
 *      what makes a fuzzy link safe enough to do automatically;
 *   4. else create the member under its exact game name and link it.
 * Then: the member takes the game's exact name (old name kept as an alias,
 * rename audited), is marked seen, gets the day's might/hero snapshot, and
 * members linked to players no longer in the clan record are marked as left.
 *
 * The snapshot replaces the OCR might capture: that phase skips a game day that
 * already has a snapshot. markMembersSeen + snapshots also keep the inactivity
 * sweeps working (they key on both).
 */
const database_js_1 = require("../data/database.js");
const member_repo_js_1 = require("../data/repositories/member-repo.js");
const merge_repo_js_1 = require("../data/repositories/merge-repo.js");
const might_repo_js_1 = require("../data/repositories/might-repo.js");
const user_repo_js_1 = require("../data/repositories/user-repo.js");
const fuzzy_js_1 = require("../utils/fuzzy.js");
const logger_js_1 = require("../utils/logger.js");
const log = (0, logger_js_1.childLogger)('member-sync');
const MIGHT_TOLERANCE = 0.15;
/** Never treat a member list this short as the whole clan (a bad read must not retire everyone). */
const MIN_ROSTER_FOR_DEPARTURES = 5;
function linkedMembers(clanId) {
    return new Map((0, database_js_1.getDb)().prepare('SELECT game_player_id, id FROM members WHERE clan_id = ? AND game_player_id IS NOT NULL').all(clanId).map((r) => [r.game_player_id, r.id]));
}
function latestMight(clanId) {
    return new Map((0, database_js_1.getDb)().prepare(`SELECT s.member_id, s.power FROM member_snapshots s
        JOIN (SELECT member_id, MAX(captured_at) AS at FROM member_snapshots WHERE clan_id = ? GROUP BY member_id) l
          ON l.member_id = s.member_id AND l.at = s.captured_at
       WHERE s.clan_id = ? AND s.power > 0`).all(clanId, clanId).map((r) => [r.member_id, r.power]));
}
function link(clanId, memberId, playerId) {
    try {
        (0, database_js_1.getDb)().prepare('UPDATE members SET game_player_id = ? WHERE id = ? AND clan_id = ? AND game_player_id IS NULL').run(playerId, memberId, clanId);
        return true;
    }
    catch (err) {
        log.warn({ noAlert: true }, `Clan #${clanId}: could not link member ${memberId} to game player ${playerId}: ${String(err)}`);
        return false;
    }
}
function syncMembersFromGame(clanId, roster, players, gameDate, now = new Date().toISOString()) {
    const byPlayer = new Map(players.map((p) => [p.playerId, p]));
    const linked = linkedMembers(clanId);
    const linkedIds = new Set(linked.values());
    const all = [...(0, member_repo_js_1.getAllMembers)(true, clanId), ...(0, member_repo_js_1.getAllMembers)(false, clanId).filter((m) => !m.isActive)];
    const unlinked = () => all.filter((m) => !linkedIds.has(m.id));
    const might = latestMight(clanId);
    const result = { linked: 0, newlyLinked: 0, created: 0, renamed: 0, departed: 0, mergedByRule: 0, memberIds: new Map() };
    /** Players whose member is linked to them — the only ones that may rename, re-role or snapshot it. */
    const owned = new Set();
    // A player merge rule is the admin saying "this name IS that member" — it
    // decides the match, exactly as on every OCR read path.
    const canonical = (0, merge_repo_js_1.loadPlayerNameCanonicaliser)(clanId);
    for (const rm of roster) {
        const p = byPlayer.get(rm.playerId);
        if (!p)
            continue;
        let memberId = linked.get(rm.playerId);
        if (memberId === undefined) {
            const name = canonical(p.name);
            const candidates = unlinked();
            let match = (0, fuzzy_js_1.exactMatchMember)(name, candidates);
            if (!match) {
                const fuzzy = (0, fuzzy_js_1.fuzzyMatchMember)(name, candidates.filter((m) => m.isActive));
                const known = fuzzy ? might.get(fuzzy.id) : undefined;
                if (fuzzy && known && p.might && Math.abs(known - p.might) / p.might <= MIGHT_TOLERANCE)
                    match = fuzzy;
            }
            if (!match && name !== p.name) {
                // The rule points at a member another player already owns: an alt the
                // admin merged into a main. Count the alt as seen there, but never link,
                // rename, re-role or snapshot that member from the alt's record.
                const owner = (0, fuzzy_js_1.exactMatchMember)(name, all);
                if (owner) {
                    result.memberIds.set(rm.playerId, owner.id);
                    result.mergedByRule++;
                    continue;
                }
            }
            if (match) {
                if (link(clanId, match.id, rm.playerId)) {
                    memberId = match.id;
                    result.newlyLinked++;
                }
            }
            else {
                const created = (0, member_repo_js_1.upsertMember)(name, clanId);
                if (!linkedIds.has(created.id) && link(clanId, created.id, rm.playerId)) {
                    memberId = created.id;
                    result.created++;
                    if (!all.some((m) => m.id === created.id))
                        all.push(created);
                }
                else {
                    // The name (or an alias of it) belongs to a member linked to someone
                    // else — e.g. a newcomer took a renamed player's old name.
                    log.info(`Clan #${clanId}: game player ${rm.playerId} "${p.name}" matches a member owned by another player; left unlinked`);
                }
            }
            if (memberId !== undefined) {
                linked.set(rm.playerId, memberId);
                linkedIds.add(memberId);
            }
        }
        if (memberId === undefined)
            continue;
        result.memberIds.set(rm.playerId, memberId);
        owned.add(rm.playerId);
        // The game's spelling is authoritative: rename, keep the old name as an alias.
        const member = all.find((m) => m.id === memberId);
        if (member && member.name !== p.name) {
            try {
                (0, member_repo_js_1.renameMember)(memberId, p.name, clanId);
                (0, member_repo_js_1.addAlias)(memberId, member.name, clanId);
                (0, user_repo_js_1.logSystemAction)(clanId, 'rename_member', { id: memberId, from: member.name, newName: p.name, source: 'game' });
                member.name = p.name;
                result.renamed++;
            }
            catch (err) {
                log.warn({ noAlert: true }, `Clan #${clanId}: kept "${member.name}" — renaming to the game's "${p.name}" collided: ${String(err)}`);
            }
        }
        (0, database_js_1.getDb)().prepare('UPDATE members SET clan_role = ? WHERE id = ? AND clan_id = ?').run(String(rm.role), memberId, clanId);
    }
    const ids = [...new Set(result.memberIds.values())];
    result.linked = owned.size;
    if (ids.length)
        (0, member_repo_js_1.markMembersSeen)(clanId, ids, now);
    (0, might_repo_js_1.saveSnapshots)(clanId, gameDate, now, roster
        .map((rm) => ({ rm, p: byPlayer.get(rm.playerId), id: result.memberIds.get(rm.playerId) }))
        .filter((x) => x.p && x.id !== undefined && x.p.might && owned.has(x.rm.playerId))
        .map((x) => ({ memberId: x.id, might: x.p.might, level: x.p.heroLevel ?? null })));
    // Departures: linked members whose player is no longer in the clan record.
    if (roster.length >= MIN_ROSTER_FOR_DEPARTURES) {
        const inClan = new Set(roster.map((r) => r.playerId));
        for (const [playerId, memberId] of linked) {
            if (inClan.has(playerId))
                continue;
            const m = all.find((x) => x.id === memberId);
            if (m?.isActive) {
                (0, member_repo_js_1.removeMember)(memberId, clanId);
                (0, user_repo_js_1.logSystemAction)(clanId, 'member.left_clan', { id: memberId, name: m.name, source: 'game' });
                result.departed++;
            }
        }
    }
    return result;
}
//# sourceMappingURL=member-sync.js.map