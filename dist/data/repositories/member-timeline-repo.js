"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadTimelineSources = loadTimelineSources;
/**
 * The rows a member's timeline is built from (data/member-timeline.ts), all
 * already kept by other features: the player record's history, the site's
 * audit log, research / captain / artifact / equipment history, troop tier
 * changes, the city's shield / burning history and the daily might. Every
 * read is clan-scoped; a member without a linked game player gets only the
 * site's own entries (renames, merges, left / restored).
 */
const database_js_1 = require("../database.js");
const member_repo_js_1 = require("./member-repo.js");
const game_profile_repo_js_1 = require("./game-profile-repo.js");
const member_tiers_js_1 = require("../member-tiers.js");
const ALL_TIME = '0000';
const NO_LIMIT = 1_000_000;
/** Everything the timeline needs for one member, or null when the member isn't in this clan. */
function loadTimelineSources(clanId, memberId, playerId) {
    const member = (0, member_repo_js_1.getMemberById)(memberId, clanId);
    if (!member)
        return null;
    const db = (0, database_js_1.getDb)();
    // The site's actions about this member: a manual rename (the sync's own
    // carry source "game" and show as the player renaming in the game), a merge
    // of another name INTO this member (by the member's name or an alias), and
    // leaving / being restored.
    const names = [member.name, ...member.aliases];
    const auditRows = db.prepare(`SELECT created_at AS at, action, details FROM audit_log
      WHERE action IN ('rename_member', 'merge_player', 'member.left_clan', 'restore_member')
        AND (clan_id = ? OR clan_id IS NULL)
      ORDER BY created_at`).all(clanId);
    const audit = [];
    for (const r of auditRows) {
        let d = {};
        try {
            d = r.details ? JSON.parse(r.details) : {};
        }
        catch {
            continue;
        }
        const forMember = (r.action === 'rename_member' && Number(d.id) === memberId) ||
            (r.action === 'member.left_clan' && Number(d.id) === memberId) ||
            (r.action === 'merge_player' && typeof d.to === 'string' && names.includes(d.to) && (d.clanId === undefined || Number(d.clanId) === clanId)) ||
            (r.action === 'restore_member' && typeof d.name === 'string' && names.includes(d.name));
        if (forMember)
            audit.push({ at: r.at, action: r.action, details: d });
    }
    const mightDays = db.prepare(`SELECT game_date AS day, captured_at AS at, power AS might FROM member_snapshots
      WHERE member_id = ? AND clan_id = ? AND game_date != '' AND power > 0 ORDER BY game_date`).all(memberId, clanId);
    if (playerId === null) {
        return {
            joinedAt: null, playerHistory: [], audit, techChanges: [], tierChanges: [], captainChanges: [],
            artifactChanges: [], equipmentChanges: [], cityStatus: [], mightDays,
        };
    }
    const joined = db.prepare('SELECT joined_at AS joinedAt FROM game_players WHERE clan_id = ? AND player_id = ?')
        .get(clanId, playerId);
    const playerHistory = db.prepare(`SELECT captured_at AS at, name, hero_level AS heroLevel, city_level AS cityLevel, vip, gold_pass AS goldPass,
            hero_avatar AS heroAvatar, role
       FROM game_player_history WHERE clan_id = ? AND player_id = ? ORDER BY captured_at`).all(clanId, playerId);
    // Research and talent changes with the level each moved from; the player's
    // first read is the baseline and left out.
    const techChanges = db.prepare(`WITH h AS (
       SELECT tech_id, level, changed_at, LAG(level) OVER (PARTITION BY tech_id ORDER BY changed_at) AS prev_level
         FROM game_player_tech_history WHERE clan_id = ? AND player_id = ?
     )
     SELECT tech_id AS techId, level, prev_level AS prevLevel, changed_at AS at FROM h
      WHERE changed_at > (SELECT MIN(changed_at) FROM game_player_tech_history WHERE clan_id = ? AND player_id = ?)
        AND NOT (prev_level IS level)
      ORDER BY changed_at`).all(clanId, playerId, clanId, playerId);
    const tiers = (0, member_tiers_js_1.getMemberTiers)(clanId).get(memberId);
    const tierChanges = [];
    for (const [family, list] of Object.entries(tiers?.changes ?? {})) {
        for (const c of list)
            tierChanges.push({ at: c.at, family, from: c.from, to: c.to });
    }
    const cityStatus = db.prepare(`SELECT changed_at AS at, shielded, burning FROM game_city_status_history
      WHERE clan_id = ? AND player_id = ? ORDER BY changed_at`).all(clanId, playerId);
    return {
        joinedAt: joined?.joinedAt ?? null,
        playerHistory,
        audit,
        techChanges,
        tierChanges,
        captainChanges: (0, game_profile_repo_js_1.getPlayerCaptainChanges)(clanId, playerId, ALL_TIME, NO_LIMIT),
        artifactChanges: (0, game_profile_repo_js_1.getPlayerArtifactChanges)(clanId, playerId, ALL_TIME, NO_LIMIT),
        equipmentChanges: (0, game_profile_repo_js_1.getPlayerEquipmentChanges)(clanId, playerId, ALL_TIME, NO_LIMIT),
        cityStatus,
        mightDays,
    };
}
//# sourceMappingURL=member-timeline-repo.js.map