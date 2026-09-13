"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidateScanStats = invalidateScanStats;
exports.createSession = createSession;
exports.updateSession = updateSession;
exports.getRecentSessions = getRecentSessions;
exports.getLastCompletedSession = getLastCompletedSession;
exports.getLatestCompletedAt = getLatestCompletedAt;
exports.getFirstCompletedAtOrAfter = getFirstCompletedAtOrAfter;
exports.getSessionById = getSessionById;
exports.getSessionClanId = getSessionClanId;
exports.getScanSessionCount = getScanSessionCount;
exports.deleteSessionById = deleteSessionById;
exports.failStalePendingSessions = failStalePendingSessions;
exports.getScanStats = getScanStats;
exports.getScanCoverage = getScanCoverage;
exports.getScanHealthSeries = getScanHealthSeries;
const database_js_1 = require("../database.js");
const index_js_1 = require("../../config/index.js");
const ttl_cache_js_1 = require("../../utils/ttl-cache.js");
const chest_summary_repo_js_1 = require("./chest-summary-repo.js");
const enums_js_1 = require("../../models/enums.js");
const gift_time_js_1 = require("../../utils/gift-time.js");
const SCAN_STATS_TTL_MS = 15000;
/** Drop cached scan stats so the next read recomputes fresh numbers. */
function invalidateScanStats(clanId) {
    (0, ttl_cache_js_1.invalidate)(clanId === undefined ? 'scanStats:' : `scanStats:${clanId}`);
}
function rowToSession(row) {
    return {
        id: row.id,
        startedAt: row.started_at,
        completedAt: row.completed_at || null,
        status: row.status,
        chestsFound: row.chests_found,
        screenshotsTaken: row.screenshots_taken,
        errorsEncountered: row.errors_encountered,
        triggerSource: (row.trigger_source || 'scheduled'),
        errorMessage: row.error_message || null,
        errorPhase: row.error_phase || null,
    };
}
function createSession(triggerSource, clanId) {
    const db = (0, database_js_1.getDb)();
    const now = new Date().toISOString();
    const result = db.prepare(`
    INSERT INTO scan_sessions (clan_id, started_at, status, trigger_source)
    VALUES (?, ?, ?, ?)
  `).run(clanId, now, enums_js_1.ScanStatus.PENDING, triggerSource);
    return {
        id: result.lastInsertRowid,
        startedAt: now,
        completedAt: null,
        status: enums_js_1.ScanStatus.PENDING,
        chestsFound: 0,
        screenshotsTaken: 0,
        errorsEncountered: 0,
        triggerSource,
        errorMessage: null,
        errorPhase: null,
    };
}
/**
 * Update a scan session row. Scoped by clanId so a stale id from another
 * clan can't be accidentally written through this path; UPDATE silently
 * matches zero rows in that case.
 */
function updateSession(id, clanId, updates) {
    const db = (0, database_js_1.getDb)();
    const sets = [];
    const params = [];
    if (updates.status !== undefined) {
        sets.push('status = ?');
        params.push(updates.status);
    }
    if (updates.chestsFound !== undefined) {
        sets.push('chests_found = ?');
        params.push(updates.chestsFound);
    }
    if (updates.screenshotsTaken !== undefined) {
        sets.push('screenshots_taken = ?');
        params.push(updates.screenshotsTaken);
    }
    if (updates.errorsEncountered !== undefined) {
        sets.push('errors_encountered = ?');
        params.push(updates.errorsEncountered);
    }
    if (updates.completedAt !== undefined) {
        sets.push('completed_at = ?');
        params.push(updates.completedAt);
    }
    if (updates.errorMessage !== undefined) {
        sets.push('error_message = ?');
        params.push(updates.errorMessage);
    }
    if (updates.errorPhase !== undefined) {
        sets.push('error_phase = ?');
        params.push(updates.errorPhase);
    }
    if (sets.length === 0)
        return;
    params.push(id, clanId);
    db.prepare(`UPDATE scan_sessions SET ${sets.join(', ')} WHERE id = ? AND clan_id = ?`).run(...params);
    // A finished scan changes the headline totals; drop the cached stats so the
    // dashboard reflects the new numbers immediately instead of waiting out the
    // TTL. Only status transitions to COMPLETED/FAILED matter here. A scan also
    // ingests new chest names / sources and unknown-name rows, so drop the
    // nav-badge and source-points caches too. We invalidate by key prefix
    // directly (rather than importing each repo's invalidator) to avoid an
    // import cycle — chest-repo already depends on this module.
    if (updates.status === enums_js_1.ScanStatus.COMPLETED || updates.status === enums_js_1.ScanStatus.FAILED) {
        invalidateScanStats(clanId);
        (0, ttl_cache_js_1.invalidate)(`reviewQueueCount:${clanId}`);
        (0, ttl_cache_js_1.invalidate)(`unknownChestsCount:${clanId}`);
        (0, ttl_cache_js_1.invalidate)(`sourceKeySummary:${clanId}`);
        // A finished (or failed-but-partial) scan changed this clan's chests:
        // mark the daily-summary rollup stale and drop the analytics/leaderboard
        // aggregate caches so both recompute against the new data.
        (0, chest_summary_repo_js_1.notifyChestDataChanged)(clanId);
    }
}
function getRecentSessions(limit, clanId) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare(`
    SELECT s.*, (
      SELECT COUNT(*) FROM triumphal_chest_records t
      WHERE t.session_id = s.id AND t.clan_id = s.clan_id
    ) AS triumphal_chests_found
    FROM scan_sessions s
    WHERE s.clan_id = ?
    ORDER BY s.started_at DESC
    LIMIT ?
  `).all(clanId, limit);
    return rows.map((row) => ({
        ...rowToSession(row),
        triumphalChestsFound: row.triumphal_chests_found ?? 0,
    }));
}
/**
 * Get the most recent successfully completed scan session for a clan.
 * Used by the scan-stats summary.
 */
function getLastCompletedSession(clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT * FROM scan_sessions WHERE clan_id = ? AND status = ? AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1').get(clanId, enums_js_1.ScanStatus.COMPLETED);
    return row ? rowToSession(row) : null;
}
/**
 * The newest `completed_at` across a set of clans (ISO string), or null if
 * none have completed a scan. Used by the scan loop's startup deferral:
 * the loop runs one global cycle over every active clan per tick, so the
 * decision to skip an immediate scan on redeploy must consider the most
 * recent completion across all of them — keying off a single clan made a
 * redeploy scan immediately whenever a different clan was scanned last.
 */
function getLatestCompletedAt(clanIds) {
    if (clanIds.length === 0)
        return null;
    const db = (0, database_js_1.getDb)();
    const placeholders = clanIds.map(() => '?').join(', ');
    const row = db.prepare(`SELECT completed_at FROM scan_sessions
     WHERE clan_id IN (${placeholders}) AND status = ? AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`).get(...clanIds, enums_js_1.ScanStatus.COMPLETED);
    return row?.completed_at ?? null;
}
/**
 * `completed_at` (ISO) of the earliest COMPLETED scan that finished at or after
 * `iso`, for a clan — or null if no scan has completed since then.
 *
 * Used by the Events per-occurrence timeframe: captured_at is the scan/claim
 * time, not the in-game earn time, and each gift is claimed exactly once by the
 * scan that opens it. So event chests earned in the final hours before the
 * event's reset are only claimed by the FIRST scan after the reset, and would
 * be lost if the occurrence window ended hard at the reset instant. Extending
 * the window's upper bound to this session's completion captures that trailing
 * scan. Backed by idx_scan_sessions_clan_status_completed.
 */
function getFirstCompletedAtOrAfter(clanId, iso) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`SELECT completed_at FROM scan_sessions
     WHERE clan_id = ? AND status = ? AND completed_at IS NOT NULL AND completed_at >= ?
     ORDER BY completed_at ASC LIMIT 1`).get(clanId, enums_js_1.ScanStatus.COMPLETED, iso);
    return row?.completed_at ?? null;
}
/**
 * Look up a scan session by primary key, scoped to a clan. Returns null
 * for both "id not found" and "id belongs to another clan".
 */
function getSessionById(id, clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT * FROM scan_sessions WHERE id = ? AND clan_id = ?').get(id, clanId);
    return row ? rowToSession(row) : null;
}
/**
 * Resolve which clan a session id belongs to. Used by routes that take a
 * raw sessionId and need to authorize the caller before loading the
 * session proper.
 */
function getSessionClanId(id) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT clan_id FROM scan_sessions WHERE id = ?').get(id);
    return row?.clan_id ?? null;
}
function getScanSessionCount(clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT COUNT(*) as count FROM scan_sessions WHERE clan_id = ?').get(clanId);
    return row.count;
}
/**
 * Delete a scan session row, scoped to a clan. Caller is responsible for
 * first removing any chest_records that reference this session_id (the
 * chest_records FK has no ON DELETE CASCADE), so this is normally invoked
 * alongside chestRepo.deleteChestsBySession(id, clanId).
 */
function deleteSessionById(id, clanId) {
    const db = (0, database_js_1.getDb)();
    const result = db.prepare('DELETE FROM scan_sessions WHERE id = ? AND clan_id = ?').run(id, clanId);
    return result.changes;
}
/**
 * Mark any sessions still in PENDING status as FAILED across every clan.
 * Called on startup; PENDING sessions are leftovers from scans that crashed
 * or were interrupted before they could be finalized. The cross-clan scope
 * is intentional — when the process restarts, every clan's in-flight scan
 * is dead, and we don't have a per-clan startup hook.
 */
function failStalePendingSessions() {
    const db = (0, database_js_1.getDb)();
    const now = new Date().toISOString();
    const result = db.prepare(`UPDATE scan_sessions
     SET status = ?, completed_at = ?,
         errors_encountered = COALESCE(errors_encountered, 0) + 1,
         error_message = COALESCE(error_message, ?),
         error_phase = COALESCE(error_phase, ?)
     WHERE status = ?`).run(enums_js_1.ScanStatus.FAILED, now, 'Process crashed or was interrupted before the scan could finalize', 'Interrupted mid-scan', enums_js_1.ScanStatus.PENDING);
    return result.changes;
}
function getScanStats(clanId) {
    // Short-TTL cache: every dashboard/analytics/status surface reads the same
    // headline aggregate, and these are read-mostly. Invalidated explicitly on
    // scan completion and chest reassignment so fresh numbers show immediately.
    return (0, ttl_cache_js_1.cached)(`scanStats:${clanId}`, SCAN_STATS_TTL_MS, () => computeScanStats(clanId));
}
function computeScanStats(clanId) {
    const db = (0, database_js_1.getDb)();
    const sessionCount = db.prepare('SELECT COUNT(*) as count FROM scan_sessions WHERE clan_id = ?').get(clanId);
    // Headline totals live in a single aggregate so every surface that shows
    // them (dashboard card, analytics header, /status embed) reads the same
    // numbers from the same query.
    const chestAgg = db.prepare('SELECT COUNT(*) as chests, COALESCE(SUM(point_value), 0) as points FROM chest_records WHERE clan_id = ?').get(clanId);
    const memberCount = db.prepare('SELECT COUNT(*) as count FROM members WHERE clan_id = ? AND is_active = 1').get(clanId);
    const lastScan = db.prepare('SELECT MAX(started_at) as last FROM scan_sessions WHERE clan_id = ?').get(clanId);
    const lastCompleted = getLastCompletedSession(clanId);
    const avg = sessionCount.count > 0
        ? chestAgg.chests / sessionCount.count
        : 0;
    return {
        totalSessions: sessionCount.count,
        totalChests: chestAgg.chests,
        totalPoints: chestAgg.points,
        totalMembers: memberCount.count,
        lastScanAt: lastScan.last,
        lastScanChests: lastCompleted?.chestsFound ?? null,
        lastScanCompletedAt: lastCompleted?.completedAt ?? null,
        avgChestsPerScan: Math.round(avg * 10) / 10,
        gameDayRolloverUtcHour: (0, index_js_1.loadConfig)().gameDayRolloverUtcHour,
    };
}
/**
 * Where a window's chest data may be incomplete because nothing scanned.
 *
 * A gift sits on the Gifts tab for GIFT_LIFETIME_MS (20h) and then is gone
 * forever, so the question is not "did we scan on the usual schedule" but "was
 * there ever a stretch longer than a gift's life with no scan in it". That is
 * why the threshold is the gift lifetime and NOT a multiple of the scan
 * interval: a clan scanning every two hours that misses six scans in a row has
 * lost nothing, and flagging it would put a warning on windows where every
 * chest was captured. Only a gap past 20h can actually have dropped a gift.
 *
 * Which sessions count as covering their instant is deliberately not
 * `status = 'completed'`, which is wrong in both directions — a maintenance
 * abort is marked COMPLETED part-way through a sweep, and a FAILED session can
 * still have persisted every row it read before it died. A session counts if it
 * demonstrably stored gifts (chests_found > 0) or it ran to a clean end, which
 * is the honest reading of "this scan looked at the Gifts tab".
 *
 * Returns the gaps, not a verdict. The caller decides whether a two-day hole in
 * a yearly window is worth mentioning; usually it is not.
 */
function getScanCoverage(clanId, fromIso, toIso) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare(`
    SELECT completed_at
    FROM scan_sessions
    WHERE clan_id = ?
      AND completed_at IS NOT NULL
      AND completed_at >= ?
      AND completed_at <= ?
      AND (chests_found > 0 OR status = 'completed')
    ORDER BY completed_at
  `).all(clanId, fromIso, toIso);
    const fromMs = Date.parse(fromIso);
    // A window that has not finished yet can only be judged up to now — the
    // future is not a coverage gap.
    const toMs = Math.min(Date.parse(toIso), Date.now());
    const gaps = [];
    // Walk window-start → each scan → window-end, so a hole at either edge is
    // caught as well as one between two scans.
    let cursor = fromMs;
    for (const row of rows) {
        const at = Date.parse(row.completed_at);
        if (Number.isNaN(at))
            continue;
        if (at - cursor > gift_time_js_1.GIFT_LIFETIME_MS) {
            gaps.push({
                from: new Date(cursor).toISOString(),
                to: row.completed_at,
                hours: Math.round(((at - cursor) / 3_600_000) * 10) / 10,
            });
        }
        cursor = Math.max(cursor, at);
    }
    if (toMs - cursor > gift_time_js_1.GIFT_LIFETIME_MS) {
        gaps.push({
            from: new Date(cursor).toISOString(),
            to: new Date(toMs).toISOString(),
            hours: Math.round(((toMs - cursor) / 3_600_000) * 10) / 10,
        });
    }
    return {
        gaps,
        scans: rows.length,
        worstGapHours: gaps.reduce((max, g) => Math.max(max, g.hours), 0),
    };
}
/**
 * Recent scans as a time series, for the capture-health strip on System.
 *
 * scan_sessions has always been a flat admin list plus one dashboard tile. As a
 * series it is a different thing: duration creeping up over weeks is how a
 * wedged browser announces itself before it costs anyone a five-hour scan, and
 * an error rate that climbs is usually calibration drifting rather than the
 * game changing.
 *
 * Deliberately NOT reporting chests-per-screenshot, which is the obvious third
 * metric and is broken twice over. screenshots_taken stays at its DDL default
 * of 0 on the partial-keep path, so the ratio divides by zero on exactly the
 * aborted sessions worth looking at; and chests_found records new chests, so it
 * tracks how busy the CLAN was, not how well the scanner read.
 *
 * started_at / completed_at are ISO TEXT, so the duration is computed in JS
 * rather than with SQLite date functions on a column that isn't a timestamp.
 */
function getScanHealthSeries(clanId, limit = 60) {
    const rows = (0, database_js_1.getDb)().prepare(`
    SELECT id, started_at, completed_at, status, chests_found, errors_encountered
    FROM scan_sessions
    WHERE clan_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(clanId, limit);
    return rows.reverse().map((r) => {
        const start = Date.parse(r.started_at);
        const end = r.completed_at ? Date.parse(r.completed_at) : NaN;
        return {
            id: r.id,
            startedAt: r.started_at,
            // Null for a scan that never finished — plotting it as zero would draw
            // the worst outcome as the fastest one.
            durationMs: Number.isFinite(start) && Number.isFinite(end) ? end - start : null,
            errors: r.errors_encountered ?? 0,
            chests: r.chests_found ?? 0,
            status: r.status,
        };
    });
}
//# sourceMappingURL=session-repo.js.map