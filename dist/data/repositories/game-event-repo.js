"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveEventRun = saveEventRun;
exports.touchEventRun = touchEventRun;
exports.saveEventStandings = saveEventStandings;
exports.saveEventRead = saveEventRead;
exports.listEventReads = listEventReads;
exports.listStandingHistory = listStandingHistory;
exports.liveEventRun = liveEventRun;
exports.listRunsOfType = listRunsOfType;
exports.listEventRuns = listEventRuns;
exports.latestEventRuns = latestEventRuns;
exports.getEventStandings = getEventStandings;
exports.getEventRun = getEventRun;
/**
 * Event standings read from the game (v121): every running event's "Clan
 * members" tab (message 38003), per run. A run is (event_type, run,
 * occurrence) — the occurrence changes each time the event comes round, so a
 * finished run keeps its standings. History rows only when a player's points
 * move; the first read of a run is its baseline (stored, never a "change").
 */
const database_js_1 = require("../database.js");
const OPEN_ENDED = 4294967295;
/** Record (or refresh) a run the list showed running. */
function saveEventRun(clanId, e, meta, now = new Date().toISOString()) {
    (0, database_js_1.getDb)().prepare(`INSERT INTO game_event_runs (clan_id, event_type, run, occurrence, code, title, starts_at, ends_at, first_seen, last_read)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, event_type, run, occurrence) DO UPDATE SET
       code = CASE WHEN excluded.code != '' THEN excluded.code ELSE game_event_runs.code END,
       title = CASE WHEN excluded.title != '' THEN excluded.title ELSE game_event_runs.title END,
       starts_at = excluded.starts_at, ends_at = excluded.ends_at, last_read = excluded.last_read`).run(clanId, e.type, e.run, e.occurrence, meta.code, meta.title, e.startsAt, e.endsAt === OPEN_ENDED ? null : e.endsAt, now, now);
}
/** A run read again between scans: only its last-read time moves. */
function touchEventRun(clanId, key, now = new Date().toISOString()) {
    (0, database_js_1.getDb)().prepare('UPDATE game_event_runs SET last_read = ? WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?').run(now, clanId, key.eventType, key.run, key.occurrence);
}
/**
 * The run's standings as read now. Upserts every player's latest points/rank;
 * a history row when the player is new to the run or the points moved.
 */
function saveEventStandings(clanId, key, rows, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    const prev = new Map(db.prepare(`SELECT player_id, points FROM game_event_standings
        WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?`).all(clanId, key.eventType, key.run, key.occurrence)
        .map((r) => [r.player_id, r.points]));
    const upsert = db.prepare(`INSERT INTO game_event_standings (clan_id, event_type, run, occurrence, player_id, points, rank, first_seen, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, event_type, run, occurrence, player_id) DO UPDATE SET
       points = excluded.points, rank = excluded.rank, updated_at = excluded.updated_at`);
    const hist = db.prepare(`INSERT OR IGNORE INTO game_event_standing_history (clan_id, event_type, run, occurrence, player_id, points, rank, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    let moved = 0;
    let changed = 0;
    db.transaction(() => {
        for (const r of rows) {
            upsert.run(clanId, key.eventType, key.run, key.occurrence, r.playerId, r.points, r.rank, now, now);
            const before = prev.get(r.playerId);
            if (before === undefined || before !== r.points) {
                hist.run(clanId, key.eventType, key.run, key.occurrence, r.playerId, r.points, r.rank, now);
                if (before !== undefined)
                    moved++;
                if (r.points !== (before ?? 0))
                    changed++;
            }
        }
    })();
    return { moved, changed };
}
/** One read of a run's standings (v124), scan or poll. */
function saveEventRead(clanId, key, read) {
    (0, database_js_1.getDb)().prepare(`INSERT OR REPLACE INTO game_event_reads
       (clan_id, event_type, run, occurrence, read_at, source, members, total_points, changed,
        summons_left, summons_max, summons_used, boss_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(clanId, key.eventType, key.run, key.occurrence, read.readAt, read.source, read.members, read.totalPoints, read.changed, read.summonsLeft, read.summonsMax, read.summonsUsed, read.bossId);
}
/** Every read of a run, oldest first. */
function listEventReads(clanId, key) {
    return (0, database_js_1.getDb)().prepare(`SELECT read_at, source, members, total_points, changed, summons_left, summons_max, summons_used, boss_id
       FROM game_event_reads
      WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?
      ORDER BY read_at`).all(clanId, key.eventType, key.run, key.occurrence).map((r) => ({
        readAt: r.read_at,
        source: r.source === 'poll' ? 'poll' : 'scan',
        members: r.members,
        totalPoints: r.total_points,
        changed: r.changed,
        summonsLeft: r.summons_left,
        summonsMax: r.summons_max,
        summonsUsed: r.summons_used,
        bossId: r.boss_id,
    }));
}
/** Every points change of a run, per player in time order — a player's points at a read are their newest row at or before it. */
function listStandingHistory(clanId, key) {
    const rows = (0, database_js_1.getDb)().prepare(`SELECT player_id, points, changed_at FROM game_event_standing_history
      WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?
      ORDER BY player_id, changed_at`).all(clanId, key.eventType, key.run, key.occurrence);
    const out = new Map();
    for (const r of rows) {
        const list = out.get(r.player_id) ?? [];
        list.push({ points: r.points, at: r.changed_at });
        out.set(r.player_id, list);
    }
    return out;
}
/** The clan's run of an event type that is on now (started, not ended), newest first; null when none. */
function liveEventRun(clanId, eventType, nowSec = Math.floor(Date.now() / 1000)) {
    const r = (0, database_js_1.getDb)().prepare(`SELECT * FROM game_event_runs
      WHERE clan_id = ? AND event_type = ? AND COALESCE(starts_at, 0) <= ? AND (ends_at IS NULL OR ends_at > ?)
      ORDER BY COALESCE(starts_at, 0) DESC, last_read DESC LIMIT 1`).get(clanId, eventType, nowSec, nowSec);
    return r ? rowToRun(r) : null;
}
/** Every run of one event type the clan has, newest first. */
function listRunsOfType(clanId, eventType) {
    return (0, database_js_1.getDb)().prepare(`SELECT * FROM game_event_runs WHERE clan_id = ? AND event_type = ?
      ORDER BY COALESCE(starts_at, 0) DESC, last_read DESC`).all(clanId, eventType).map(rowToRun);
}
const rowToRun = (r) => ({
    eventType: r.event_type, run: r.run, occurrence: r.occurrence, code: r.code, title: r.title,
    startsAt: r.starts_at, endsAt: r.ends_at, firstSeen: r.first_seen, lastRead: r.last_read,
});
/** Every run of the clan that has standings, newest first. */
function listEventRuns(clanId) {
    return (0, database_js_1.getDb)().prepare(`SELECT r.* FROM game_event_runs r
      WHERE r.clan_id = ?
        AND EXISTS (SELECT 1 FROM game_event_standings s
                     WHERE s.clan_id = r.clan_id AND s.event_type = r.event_type AND s.run = r.run AND s.occurrence = r.occurrence)
      ORDER BY COALESCE(r.starts_at, 0) DESC, r.last_read DESC`).all(clanId).map(rowToRun);
}
/** The latest run per event (same code = same event; a code-less run groups by its type). */
function latestEventRuns(clanId) {
    const seen = new Set();
    const out = [];
    for (const r of listEventRuns(clanId)) {
        const group = r.code || `type:${r.eventType}`;
        if (seen.has(group))
            continue;
        seen.add(group);
        out.push(r);
    }
    return out;
}
/** A run's standings, best first, with each player's previous points. */
function getEventStandings(clanId, key) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare(`SELECT player_id, points, rank, updated_at FROM game_event_standings
      WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?
      ORDER BY rank, points DESC`).all(clanId, key.eventType, key.run, key.occurrence);
    // The two newest history rows per player: [latest, previous].
    const hist = db.prepare(`SELECT player_id, points, changed_at FROM game_event_standing_history
      WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?
      ORDER BY player_id, changed_at DESC`).all(clanId, key.eventType, key.run, key.occurrence);
    const latestTwo = new Map();
    for (const h of hist) {
        const list = latestTwo.get(h.player_id) ?? [];
        if (list.length < 2)
            list.push({ points: h.points, changedAt: h.changed_at });
        latestTwo.set(h.player_id, list);
    }
    return rows.map((r) => {
        const h = latestTwo.get(r.player_id) ?? [];
        const previous = h.length >= 2 ? h[1] : null;
        return {
            playerId: r.player_id,
            points: r.points,
            rank: r.rank,
            previousPoints: previous ? previous.points : null,
            changedAt: previous ? h[0].changedAt : null,
            updatedAt: r.updated_at,
        };
    });
}
/** One run's stored row, or null. */
function getEventRun(clanId, key) {
    const r = (0, database_js_1.getDb)().prepare('SELECT * FROM game_event_runs WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?').get(clanId, key.eventType, key.run, key.occurrence);
    return r ? rowToRun(r) : null;
}
//# sourceMappingURL=game-event-repo.js.map