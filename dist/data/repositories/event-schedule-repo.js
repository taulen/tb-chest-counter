"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listArchivedRuns = listArchivedRuns;
exports.syncArchivedRuns = syncArchivedRuns;
exports.listCorrections = listCorrections;
exports.setCorrection = setCorrection;
exports.deleteCorrection = deleteCorrection;
const database_js_1 = require("../database.js");
const iso = (ms) => new Date(ms).toISOString();
/** Archived runs of one event, ascending, as epoch ms. */
function listArchivedRuns(eventKey) {
    const rows = (0, database_js_1.getDb)()
        .prepare(`SELECT start_at, end_at FROM event_calendar_runs
        WHERE event_key = ? ORDER BY start_at`)
        .all(eventKey);
    return rows.map((r) => ({ start: Date.parse(r.start_at), end: Date.parse(r.end_at) }));
}
/**
 * Mirror the feed into the archive for every run it shows as already started.
 *
 * Inside the feed's reach (`horizonMs` → `nowMs`) the archive is REPLACED by
 * what the feed says now, so a run the portal later moves or deletes doesn't
 * linger as a phantom beside its corrected copy. Older rows — the ones the
 * feed has forgotten — are never touched; that is the whole point of keeping
 * them. Future runs are never stored: they can still move.
 */
function syncArchivedRuns(horizonMs, nowMs, runs) {
    const db = (0, database_js_1.getDb)();
    const del = db.prepare('DELETE FROM event_calendar_runs WHERE start_at >= ? AND start_at <= ?');
    const ins = db.prepare(`INSERT OR REPLACE INTO event_calendar_runs (event_key, start_at, end_at)
     VALUES (?, ?, ?)`);
    db.transaction(() => {
        del.run(iso(horizonMs), iso(nowMs));
        for (const r of runs) {
            if (r.start < horizonMs || r.start > nowMs)
                continue;
            ins.run(r.eventKey, iso(r.start), iso(r.end));
        }
    })();
}
function listCorrections() {
    const rows = (0, database_js_1.getDb)()
        .prepare(`SELECT id, event_key, feed_start_at, actual_start_at, created_at
         FROM event_schedule_corrections ORDER BY feed_start_at DESC`)
        .all();
    return rows.map((r) => ({
        id: r.id,
        eventKey: r.event_key,
        feedStartAt: r.feed_start_at,
        actualStartAt: r.actual_start_at,
        createdAt: r.created_at,
    }));
}
/** Insert or replace the correction for one feed run. */
function setCorrection(eventKey, feedStartMs, actualStartMs, userId) {
    (0, database_js_1.getDb)()
        .prepare(`INSERT INTO event_schedule_corrections
         (event_key, feed_start_at, actual_start_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (event_key, feed_start_at) DO UPDATE SET
         actual_start_at = excluded.actual_start_at,
         created_by = excluded.created_by,
         created_at = excluded.created_at`)
        .run(eventKey, iso(feedStartMs), iso(actualStartMs), userId, new Date().toISOString());
}
/** Returns true when a row was removed. */
function deleteCorrection(id) {
    return (0, database_js_1.getDb)().prepare('DELETE FROM event_schedule_corrections WHERE id = ?').run(id).changes > 0;
}
//# sourceMappingURL=event-schedule-repo.js.map