"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.heroAvatarUrl = heroAvatarUrl;
exports.avatarFrameUrl = avatarFrameUrl;
exports.gamePlayerIdForMember = gamePlayerIdForMember;
exports.getGamePlayer = getGamePlayer;
exports.getGamePlayersByMember = getGamePlayersByMember;
exports.getLatestCity = getLatestCity;
exports.getPlayerTechs = getPlayerTechs;
exports.getPlayerTechChanges = getPlayerTechChanges;
exports.getPlayerCaptains = getPlayerCaptains;
exports.getPlayerCaptainChanges = getPlayerCaptainChanges;
/**
 * Read side of the game-protocol tables for the member profile and member
 * lists: what the game says about a player (game_players), their city
 * (game_city_snapshots), research + hero talents (game_player_techs) and how
 * those changed (game_player_tech_history). Members link to players through
 * members.game_player_id (v103).
 */
const database_js_1 = require("../database.js");
const index_js_1 = require("../../game-art/index.js");
const toProfile = (r) => ({
    playerId: r.player_id,
    name: r.name,
    role: r.role,
    joinedAt: r.joined_at,
    inClan: r.in_clan === 1,
    might: r.might,
    heroLevel: r.hero_level,
    cityLevel: r.city_level,
    vip: r.vip,
    goldPass: r.gold_pass === 1,
    goldIngots: r.gold_ingots ?? null,
    shielded: r.shielded == null ? null : r.shielded === 1,
    burning: r.burning == null ? null : r.burning === 1,
    mapSeenAt: r.map_seen_at ?? null,
    heroAvatar: r.hero_avatar,
    avatarUrl: heroAvatarUrl(r.hero_avatar),
    avatarFrame: r.avatar_frame ?? null,
    frameUrl: avatarFrameUrl(r.avatar_frame),
    cityAppearance: r.city_appearance ?? null,
    lastSeen: r.last_seen,
});
/** URL of a hero portrait by the game's avatar id, or null. */
function heroAvatarUrl(heroAvatar) {
    const name = (0, index_js_1.heroAvatarImage)(heroAvatar);
    return name ? (0, index_js_1.gameArtUrl)(name) : null;
}
/** URL of the frame a portrait is drawn in, by the player's frame id (the game's default when unknown), or null. */
function avatarFrameUrl(frameId) {
    const name = (0, index_js_1.avatarFrameImage)(frameId);
    return name ? (0, index_js_1.gameArtUrl)(name) : null;
}
/** The game player a member is linked to, or null when not linked yet. */
function gamePlayerIdForMember(memberId, clanId) {
    const r = (0, database_js_1.getDb)().prepare('SELECT game_player_id AS id FROM members WHERE id = ? AND clan_id = ?').get(memberId, clanId);
    return r?.id ?? null;
}
function getGamePlayer(clanId, playerId) {
    const r = (0, database_js_1.getDb)().prepare('SELECT * FROM game_players WHERE clan_id = ? AND player_id = ?').get(clanId, playerId);
    return r ? toProfile(r) : null;
}
/** Every member of the clan that is linked to a game player: memberId → profile. */
function getGamePlayersByMember(clanId) {
    const rows = (0, database_js_1.getDb)().prepare(`SELECT m.id AS member_id, g.* FROM members m
       JOIN game_players g ON g.clan_id = m.clan_id AND g.player_id = m.game_player_id
      WHERE m.clan_id = ?`).all(clanId);
    return new Map(rows.map((r) => [r.member_id, toProfile(r)]));
}
function getLatestCity(clanId, playerId) {
    const r = (0, database_js_1.getDb)().prepare(`SELECT game_date, captured_at, tech_count, buildings, hero FROM game_city_snapshots
      WHERE clan_id = ? AND player_id = ? ORDER BY game_date DESC LIMIT 1`).get(clanId, playerId);
    if (!r)
        return null;
    return {
        gameDate: r.game_date,
        capturedAt: r.captured_at,
        techCount: r.tech_count,
        buildings: JSON.parse(r.buildings || '{}'),
        hero: JSON.parse(r.hero || '{}'),
    };
}
/** techId → level, plus when the levels were last read. */
function getPlayerTechs(clanId, playerId) {
    const rows = (0, database_js_1.getDb)().prepare('SELECT tech_id, level, last_seen FROM game_player_techs WHERE clan_id = ? AND player_id = ?')
        .all(clanId, playerId);
    const levels = {};
    let readAt = null;
    for (const r of rows) {
        levels[r.tech_id] = r.level;
        if (!readAt || r.last_seen > readAt)
            readAt = r.last_seen;
    }
    return { levels, readAt };
}
/**
 * Level changes since `sinceIso`, newest first. The first read of a player
 * records every tech at once; that baseline is left out (it is not a change),
 * by skipping rows stamped with the player's earliest history time.
 */
function getPlayerTechChanges(clanId, playerId, sinceIso, limit = 200) {
    return (0, database_js_1.getDb)().prepare(`SELECT tech_id AS techId, level, changed_at AS changedAt FROM game_player_tech_history h
      WHERE clan_id = ? AND player_id = ? AND changed_at >= ?
        AND changed_at > (SELECT MIN(changed_at) FROM game_player_tech_history WHERE clan_id = h.clan_id AND player_id = h.player_id)
      ORDER BY changed_at DESC LIMIT ?`).all(clanId, playerId, sinceIso, limit);
}
/** A player's captains as last read, highest level first (the game's own order). */
function getPlayerCaptains(clanId, playerId) {
    return (0, database_js_1.getDb)().prepare(`SELECT captain_id AS captainId, level, stars, xp, slot, first_seen AS firstSeen, last_seen AS lastSeen
       FROM game_player_captains WHERE clan_id = ? AND player_id = ?
      ORDER BY level DESC, stars DESC, captain_id`).all(clanId, playerId);
}
/**
 * Captain level/star changes since `sinceIso`, newest first, each with the
 * values it moved from. The first read's baseline is left out: it is when we
 * started looking, not when the player got there.
 */
function getPlayerCaptainChanges(clanId, playerId, sinceIso, limit = 100) {
    return (0, database_js_1.getDb)().prepare(`WITH h AS (
       SELECT captain_id, level, stars, changed_at,
              LAG(level) OVER w AS prev_level, LAG(stars) OVER w AS prev_stars
         FROM game_player_captain_history
        WHERE clan_id = ? AND player_id = ?
       WINDOW w AS (PARTITION BY captain_id ORDER BY changed_at)
     )
     SELECT captain_id AS captainId, level, stars, prev_level AS prevLevel, prev_stars AS prevStars, changed_at AS changedAt
       FROM h
      WHERE changed_at >= ?
        AND changed_at > (SELECT MIN(changed_at) FROM game_player_captain_history WHERE clan_id = ? AND player_id = ?)
      ORDER BY changed_at DESC, level DESC LIMIT ?`).all(clanId, playerId, sinceIso, clanId, playerId, limit);
}
//# sourceMappingURL=game-profile-repo.js.map