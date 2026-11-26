"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.heroAvatarUrl = heroAvatarUrl;
exports.avatarFrameUrl = avatarFrameUrl;
exports.gamePlayerIdForMember = gamePlayerIdForMember;
exports.getGamePlayer = getGamePlayer;
exports.getGamePlayersByMember = getGamePlayersByMember;
exports.getLatestCity = getLatestCity;
exports.getPlayerSpeeds = getPlayerSpeeds;
exports.getPlayerStats = getPlayerStats;
exports.getPlayerTechs = getPlayerTechs;
exports.getPlayerTechChanges = getPlayerTechChanges;
exports.getPlayerGoldIngotsDaily = getPlayerGoldIngotsDaily;
exports.getPlayerCaptains = getPlayerCaptains;
exports.getPlayerHeroEntry = getPlayerHeroEntry;
exports.getPlayerHeroLevelChanges = getPlayerHeroLevelChanges;
exports.getPlayerCaptainChanges = getPlayerCaptainChanges;
exports.getPlayerArtifacts = getPlayerArtifacts;
exports.getPlayerArtifactChanges = getPlayerArtifactChanges;
exports.getPlayerEquipment = getPlayerEquipment;
exports.getPlayerEquipmentChanges = getPlayerEquipmentChanges;
exports.getPlayerTitles = getPlayerTitles;
/**
 * Read side of the game-protocol tables for the member profile and member
 * lists: what the game says about a player (game_players), their city
 * (game_city_snapshots), research + hero talents (game_player_techs) and how
 * those changed (game_player_tech_history). Members link to players through
 * members.game_player_id (v103).
 */
const database_js_1 = require("../database.js");
const index_js_1 = require("../../game-art/index.js");
const equipment_js_1 = require("../../game-protocol/equipment.js");
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
        dragon: JSON.parse(r.hero || '{}'),
    };
}
/**
 * A player's city speeds (city-speeds.ts), one per game day the city was read
 * and worked out, oldest first.
 */
function getPlayerSpeeds(clanId, playerId) {
    const rows = (0, database_js_1.getDb)().prepare(`SELECT game_date, captured_at, speeds FROM game_city_snapshots
      WHERE clan_id = ? AND player_id = ? AND speeds IS NOT NULL ORDER BY game_date`).all(clanId, playerId);
    const out = [];
    for (const r of rows) {
        try {
            out.push({ gameDate: r.game_date, capturedAt: r.captured_at, speeds: JSON.parse(r.speeds) });
        }
        catch { /* a damaged row is skipped */ }
    }
    return out;
}
/** A player's every city bonus (city-stats.ts), one per game day read and worked out, oldest first. */
function getPlayerStats(clanId, playerId) {
    const rows = (0, database_js_1.getDb)().prepare(`SELECT game_date, captured_at, stats FROM game_city_snapshots
      WHERE clan_id = ? AND player_id = ? AND stats IS NOT NULL ORDER BY game_date`).all(clanId, playerId);
    const out = [];
    for (const r of rows) {
        try {
            out.push({ gameDate: r.game_date, capturedAt: r.captured_at, stats: JSON.parse(r.stats) });
        }
        catch { /* a damaged row is skipped */ }
    }
    return out;
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
/**
 * A player's Gold Ingots per game day (game_player_daily, v110: the day's
 * latest reading), oldest first, plus the newest reading. Ingots tick up every
 * few minutes, so the day's last value is what a history needs.
 */
function getPlayerGoldIngotsDaily(clanId, playerId, sinceGameDate = '') {
    const db = (0, database_js_1.getDb)();
    const points = db.prepare(`SELECT game_date AS gameDate, gold_ingots AS goldIngots FROM game_player_daily
      WHERE clan_id = ? AND player_id = ? AND gold_ingots IS NOT NULL AND game_date >= ?
      ORDER BY game_date`).all(clanId, playerId, sinceGameDate);
    const now = db.prepare('SELECT gold_ingots AS v, last_seen AS at FROM game_players WHERE clan_id = ? AND player_id = ?')
        .get(clanId, playerId);
    return { current: now?.v ?? null, readAt: now?.at ?? null, points };
}
/** A player's captains as last read, highest level first (the game's own order). The hero's entry is left out. */
function getPlayerCaptains(clanId, playerId) {
    return (0, database_js_1.getDb)().prepare(`SELECT captain_id AS captainId, level, stars, xp, slot, first_seen AS firstSeen, last_seen AS lastSeen
       FROM game_player_captains WHERE clan_id = ? AND player_id = ? AND captain_id <> ?
      ORDER BY level DESC, stars DESC, captain_id`).all(clanId, playerId, equipment_js_1.HERO_ENTRY_ID);
}
/**
 * The hero as city field 9 lists it (entry id 1: level and XP on the Heroes
 * table's own curve), or null until a city read since Nov 2026 stored it.
 */
function getPlayerHeroEntry(clanId, playerId) {
    return (0, database_js_1.getDb)().prepare(`SELECT captain_id AS captainId, level, stars, xp, slot, first_seen AS firstSeen, last_seen AS lastSeen
       FROM game_player_captains WHERE clan_id = ? AND player_id = ? AND captain_id = ?`).get(clanId, playerId, equipment_js_1.HERO_ENTRY_ID) ?? null;
}
/**
 * The hero's level-ups since `sinceIso`, newest first, from the player record
 * history (game_player_history.hero_level: the hero has no captain history
 * rows). The first reading is a starting point, never a change.
 */
function getPlayerHeroLevelChanges(clanId, playerId, sinceIso, limit = 50) {
    return (0, database_js_1.getDb)().prepare(`WITH h AS (
       SELECT hero_level AS level, captured_at AS changedAt,
              LAG(hero_level) OVER (ORDER BY captured_at) AS prevLevel
         FROM game_player_history
        WHERE clan_id = ? AND player_id = ? AND hero_level IS NOT NULL
     )
     SELECT level, prevLevel, changedAt FROM h
      WHERE prevLevel IS NOT NULL AND level <> prevLevel AND changedAt >= ?
      ORDER BY changedAt DESC LIMIT ?`).all(clanId, playerId, sinceIso, limit);
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
/** The artifacts a player has been seen wearing (v112): line-up ones first, then by level. */
function getPlayerArtifacts(clanId, playerId) {
    const rows = (0, database_js_1.getDb)().prepare(`SELECT artifact_type AS artifactType, level, star, bonuses, in_lineup AS inLineup, first_seen AS firstSeen, last_seen AS lastSeen
       FROM game_player_artifacts WHERE clan_id = ? AND player_id = ?
      ORDER BY in_lineup DESC, level DESC, star DESC, artifact_type`).all(clanId, playerId);
    return rows.map((r) => ({ ...r, inLineup: r.inLineup === 1, bonuses: parseIds(r.bonuses) }));
}
function parseIds(json) {
    try {
        const v = JSON.parse(json);
        return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
    }
    catch {
        return [];
    }
}
/**
 * Artifact changes since `sinceIso`, newest first: level / star level / roll
 * moves and line-up moves. The first read's baseline is left out, as for
 * captains.
 */
function getPlayerArtifactChanges(clanId, playerId, sinceIso, limit = 100) {
    const rows = (0, database_js_1.getDb)().prepare(`WITH h AS (
       SELECT artifact_type, level, star, bonuses, in_lineup, changed_at,
              LAG(level) OVER w AS prev_level, LAG(star) OVER w AS prev_star, LAG(bonuses) OVER w AS prev_bonuses,
              LAG(in_lineup) OVER w AS prev_in_lineup
         FROM game_player_artifact_history
        WHERE clan_id = ? AND player_id = ?
       WINDOW w AS (PARTITION BY artifact_type ORDER BY changed_at)
     )
     SELECT artifact_type AS artifactType, level, star, prev_level AS prevLevel, prev_star AS prevStar,
            (prev_bonuses IS NOT NULL AND prev_bonuses <> bonuses) AS rerolled,
            in_lineup AS inLineup, prev_in_lineup AS prevInLineup, changed_at AS changedAt
       FROM h
      WHERE changed_at >= ?
        AND changed_at > (SELECT MIN(changed_at) FROM game_player_artifact_history WHERE clan_id = ? AND player_id = ?)
        -- An archive replay can leave a row equal to the one before it (the
        -- live read, replayed past): not a change.
        AND NOT (prev_level IS level AND prev_star IS star AND prev_bonuses IS bonuses AND prev_in_lineup IS in_lineup)
      ORDER BY changed_at DESC, level DESC, artifact_type LIMIT ?`).all(clanId, playerId, sinceIso, clanId, playerId, limit);
    return rows.map(({ inLineup, prevInLineup, ...r }) => ({
        ...r,
        rerolled: r.rerolled === 1,
        lineup: inLineup === 0 ? 'out' : prevInLineup === null || prevInLineup === 0 ? 'in' : null,
    }));
}
/** What every captain of a player wears (v112), by captain then position. */
function getPlayerEquipment(clanId, playerId) {
    const rows = (0, database_js_1.getDb)().prepare(`SELECT captain_id AS captainId, position, item_type AS itemType, enchantment, gems, first_seen AS firstSeen
       FROM game_player_captain_equipment WHERE clan_id = ? AND player_id = ?
      ORDER BY captain_id, position`).all(clanId, playerId);
    return rows.map((r) => ({ ...r, gems: parseIds(r.gems) }));
}
/** Equipment changes since `sinceIso`, newest first; the first read's baseline is left out. */
function getPlayerEquipmentChanges(clanId, playerId, sinceIso, limit = 100) {
    const rows = (0, database_js_1.getDb)().prepare(`WITH h AS (
       SELECT captain_id, position, item_uid, item_type, enchantment, gems, changed_at,
              LAG(item_uid) OVER w AS prev_uid, LAG(item_type) OVER w AS prev_type,
              LAG(enchantment) OVER w AS prev_enchantment, LAG(gems) OVER w AS prev_gems
         FROM game_player_equipment_history
        WHERE clan_id = ? AND player_id = ?
       WINDOW w AS (PARTITION BY captain_id, position ORDER BY changed_at)
     )
     SELECT captain_id AS captainId, position, item_type AS itemType,
            CASE WHEN prev_type = 0 THEN NULL ELSE prev_type END AS prevType,
            (prev_uid IS NOT NULL AND prev_uid = item_uid) AS reworked, changed_at AS changedAt
       FROM h
      WHERE changed_at >= ?
        AND changed_at > (SELECT MIN(changed_at) FROM game_player_equipment_history WHERE clan_id = ? AND player_id = ?)
        -- A replayed read equal to the row before it is not a change.
        AND NOT (prev_uid IS item_uid AND prev_type IS item_type AND prev_enchantment IS enchantment AND prev_gems IS gems)
      ORDER BY changed_at DESC, captain_id, position LIMIT ?`).all(clanId, playerId, sinceIso, clanId, playerId, limit);
    return rows.map((r) => ({ ...r, reworked: r.reworked === 1 }));
}
/**
 * The titles a player held at their latest read (gone_at unset). Whether a
 * title has run out since is the caller's call (titles.ts titleViews): its
 * duration is static data.
 */
function getPlayerTitles(clanId, playerId) {
    return (0, database_js_1.getDb)().prepare(`SELECT t.title_id AS titleId, t.assigned_at AS assignedAt, t.event_id AS eventId,
            t.first_seen AS firstSeen, t.last_seen AS lastSeen, c.times AS times
       FROM game_player_titles t
       LEFT JOIN game_player_title_counts c
         ON c.clan_id = t.clan_id AND c.player_id = t.player_id AND c.title_id = t.title_id
      WHERE t.clan_id = ? AND t.player_id = ? AND t.gone_at IS NULL
      ORDER BY t.assigned_at DESC, t.title_id`).all(clanId, playerId);
}
//# sourceMappingURL=game-profile-repo.js.map