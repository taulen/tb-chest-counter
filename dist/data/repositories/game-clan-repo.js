"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveClanInfo = saveClanInfo;
exports.saveClanStats = saveClanStats;
exports.saveClanTechs = saveClanTechs;
exports.hasClanTechs = hasClanTechs;
exports.latestArchivedClanObject = latestArchivedClanObject;
exports.saveClanTreasury = saveClanTreasury;
exports.saveClanMedals = saveClanMedals;
exports.getClanInfo = getClanInfo;
exports.getLatestClanStats = getLatestClanStats;
exports.getDailyClanStats = getDailyClanStats;
exports.getClanTechs = getClanTechs;
exports.getClanTechChanges = getClanTechChanges;
exports.getClanTreasury = getClanTreasury;
exports.getClanMedals = getClanMedals;
exports.getClanLeader = getClanLeader;
/**
 * The clan's own game data (v111): what the in-game clan window shows — the
 * Information tab (tag, name, members, might, founded, medals), wealth and
 * help points, the Clan Capital's research and treasury — written by the scan
 * (game-protocol-phase.ts) and read by the Clan page (/api/game/clan).
 *
 * History: game_clan_stats keeps a row per scan; research keeps a history row
 * only when a level moves (the first read is the baseline, not a change); the
 * treasury keeps the day's latest read per resource.
 */
const zlib_1 = require("zlib");
const database_js_1 = require("../database.js");
function saveClanInfo(clanId, info, now = new Date().toISOString()) {
    (0, database_js_1.getDb)().prepare(`
    INSERT INTO game_clan_info (clan_id, game_clan_id, tag, name, founded_at, language, capital_id, realm, capital_x, capital_y, updated_at)
    VALUES (@clanId, @gameClanId, @tag, @name, @foundedAt, @language, @capitalId, @realm, @x, @y, @now)
    ON CONFLICT (clan_id) DO UPDATE SET
      game_clan_id = excluded.game_clan_id, tag = excluded.tag, name = excluded.name,
      founded_at = COALESCE(excluded.founded_at, game_clan_info.founded_at),
      language = excluded.language,
      capital_id = COALESCE(excluded.capital_id, game_clan_info.capital_id),
      realm = COALESCE(excluded.realm, game_clan_info.realm),
      capital_x = COALESCE(excluded.capital_x, game_clan_info.capital_x),
      capital_y = COALESCE(excluded.capital_y, game_clan_info.capital_y),
      updated_at = excluded.updated_at
  `).run({
        clanId,
        gameClanId: info.gameClanId,
        tag: info.tag,
        name: info.name,
        foundedAt: info.foundedAt ? new Date(info.foundedAt * 1000).toISOString() : null,
        language: info.language || null,
        capitalId: info.capitalId,
        realm: info.position?.[0] ?? null,
        x: info.position?.[1] ?? null,
        y: info.position?.[2] ?? null,
        now,
    });
}
function saveClanStats(clanId, gameDate, s, now = new Date().toISOString()) {
    (0, database_js_1.getDb)().prepare(`
    INSERT OR REPLACE INTO game_clan_stats (clan_id, captured_at, game_date, members, member_limit, might, wealth, help_points, wealth_rank, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(clanId, now, gameDate, s.members, s.memberLimit, s.might, s.wealth, s.helpPoints, s.wealthRank, JSON.stringify(s.raw));
}
/** Save the clan's research; a history row only for a tech that is new or whose level moved. Returns the changes. */
function saveClanTechs(clanId, techs, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    const current = new Map(db.prepare('SELECT tech_id, level FROM game_clan_techs WHERE clan_id = ?').all(clanId)
        .map((r) => [r.tech_id, r.level]));
    const upsert = db.prepare(`
    INSERT INTO game_clan_techs (clan_id, tech_id, level, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (clan_id, tech_id) DO UPDATE SET level = excluded.level, last_seen = excluded.last_seen
  `);
    const history = db.prepare('INSERT OR IGNORE INTO game_clan_tech_history (clan_id, tech_id, level, changed_at) VALUES (?, ?, ?, ?)');
    let changed = 0;
    db.transaction(() => {
        for (const [id, level] of Object.entries(techs)) {
            const techId = Number(id);
            upsert.run(clanId, techId, level, now, now);
            if (current.get(techId) !== level) {
                history.run(clanId, techId, level, now);
                changed++;
            }
        }
    })();
    return changed;
}
function hasClanTechs(clanId) {
    return !!(0, database_js_1.getDb)().prepare('SELECT 1 FROM game_clan_techs WHERE clan_id = ? LIMIT 1').get(clanId);
}
/** The latest archived raw reply of one clan-owned object (kind 'clan_object'), gunzipped. */
function latestArchivedClanObject(clanId, objectId) {
    const row = (0, database_js_1.getDb)().prepare(`
    SELECT captured_at AS capturedAt, payload FROM game_raw_snapshots
     WHERE clan_id = ? AND kind = 'clan_object' AND ref_id = ?
     ORDER BY game_date DESC LIMIT 1
  `).get(clanId, objectId);
    if (!row)
        return null;
    return { capturedAt: row.capturedAt, body: JSON.parse((0, zlib_1.gunzipSync)(row.payload).toString('utf8')) };
}
function saveClanTreasury(clanId, gameDate, treasury, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    const put = db.prepare(`
    INSERT OR REPLACE INTO game_clan_treasury (clan_id, game_date, resource_id, amount, captured_at) VALUES (?, ?, ?, ?, ?)
  `);
    db.transaction(() => {
        for (const [id, amount] of Object.entries(treasury))
            put.run(clanId, gameDate, Number(id), amount, now);
    })();
}
function saveClanMedals(clanId, medals, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    const put = db.prepare(`
    INSERT INTO game_clan_medals (clan_id, medal_id, earned_at, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (clan_id, medal_id) DO UPDATE SET earned_at = excluded.earned_at, last_seen = excluded.last_seen
  `);
    db.transaction(() => {
        for (const m of medals)
            put.run(clanId, m.medalId, new Date(m.earnedAt * 1000).toISOString(), now, now);
    })();
}
function getClanInfo(clanId) {
    const r = (0, database_js_1.getDb)().prepare(`
    SELECT game_clan_id AS gameClanId, tag, name, founded_at AS foundedAt, language, capital_id AS capitalId,
           realm, capital_x AS capitalX, capital_y AS capitalY, updated_at AS updatedAt
      FROM game_clan_info WHERE clan_id = ?
  `).get(clanId);
    return r ?? null;
}
const STATS_COLUMNS = `captured_at AS capturedAt, game_date AS gameDate, members, member_limit AS memberLimit, might,
  wealth, help_points AS helpPoints, wealth_rank AS wealthRank`;
function getLatestClanStats(clanId) {
    const r = (0, database_js_1.getDb)().prepare(`SELECT ${STATS_COLUMNS} FROM game_clan_stats WHERE clan_id = ? ORDER BY captured_at DESC LIMIT 1`)
        .get(clanId);
    return r ?? null;
}
/** One row per game day — the day's last read — for the last `days` game days, oldest first. */
function getDailyClanStats(clanId, sinceGameDate) {
    return (0, database_js_1.getDb)().prepare(`
    SELECT ${STATS_COLUMNS} FROM game_clan_stats s
     WHERE clan_id = ? AND game_date >= ?
       AND captured_at = (SELECT MAX(captured_at) FROM game_clan_stats WHERE clan_id = s.clan_id AND game_date = s.game_date)
     ORDER BY game_date
  `).all(clanId, sinceGameDate);
}
/** The clan's research levels and when they were last read. */
function getClanTechs(clanId) {
    const rows = (0, database_js_1.getDb)().prepare('SELECT tech_id, level, last_seen FROM game_clan_techs WHERE clan_id = ?')
        .all(clanId);
    const levels = {};
    let readAt = null;
    for (const r of rows) {
        levels[String(r.tech_id)] = r.level;
        if (!readAt || r.last_seen > readAt)
            readAt = r.last_seen;
    }
    return { levels, readAt };
}
/**
 * Research levels reached since `sinceIso`, newest first. The first read of the
 * clan is its baseline (every tech "appears" then), so it is not a change.
 */
function getClanTechChanges(clanId, sinceIso) {
    return (0, database_js_1.getDb)().prepare(`
    SELECT tech_id AS techId, level, changed_at AS changedAt FROM game_clan_tech_history
     WHERE clan_id = ? AND changed_at >= ?
       AND changed_at > (SELECT MIN(changed_at) FROM game_clan_tech_history WHERE clan_id = ?)
     ORDER BY changed_at DESC, tech_id
  `).all(clanId, sinceIso, clanId);
}
/** The treasury's latest day, with each resource's amount on the previous day it was read (for the change). */
function getClanTreasury(clanId) {
    const db = (0, database_js_1.getDb)();
    const last = db.prepare('SELECT MAX(game_date) AS d FROM game_clan_treasury WHERE clan_id = ?').get(clanId);
    if (!last.d)
        return { gameDate: null, capturedAt: null, rows: [] };
    const rows = db.prepare(`
    SELECT t.resource_id AS resourceId, t.amount, t.captured_at AS capturedAt,
           (SELECT p.amount FROM game_clan_treasury p
             WHERE p.clan_id = t.clan_id AND p.resource_id = t.resource_id AND p.game_date < t.game_date
             ORDER BY p.game_date DESC LIMIT 1) AS previous
      FROM game_clan_treasury t
     WHERE t.clan_id = ? AND t.game_date = ?
     ORDER BY t.resource_id
  `).all(clanId, last.d);
    return {
        gameDate: last.d,
        capturedAt: rows.reduce((m, r) => (!m || r.capturedAt > m ? r.capturedAt : m), null),
        rows: rows.map(({ resourceId, amount, previous }) => ({ resourceId, amount, previous })),
    };
}
function getClanMedals(clanId) {
    return (0, database_js_1.getDb)().prepare(`
    SELECT medal_id AS medalId, earned_at AS earnedAt, last_seen AS lastSeen FROM game_clan_medals
     WHERE clan_id = ? AND last_seen = (SELECT MAX(last_seen) FROM game_clan_medals WHERE clan_id = ?)
     ORDER BY earned_at DESC
  `).all(clanId, clanId);
}
/** The clan's leader (game role 1) as the roster last read them, with the member row it links to. */
function getClanLeader(clanId) {
    const r = (0, database_js_1.getDb)().prepare(`
    SELECT gp.name, m.id AS memberId FROM game_players gp
      LEFT JOIN members m ON m.clan_id = gp.clan_id AND m.game_player_id = gp.player_id
     WHERE gp.clan_id = ? AND gp.role = 1 AND gp.in_clan = 1
     ORDER BY gp.last_seen DESC LIMIT 1
  `).get(clanId);
    return r ?? null;
}
//# sourceMappingURL=game-clan-repo.js.map