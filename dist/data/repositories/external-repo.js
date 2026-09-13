"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertSnapshot = insertSnapshot;
exports.listClanShareCodes = listClanShareCodes;
exports.listSnapshots = listSnapshots;
exports.listSnapshotWeeks = listSnapshotWeeks;
exports.getSnapshot = getSnapshot;
exports.getLatestSnapshot = getLatestSnapshot;
exports.getSnapshotEtagForWindow = getSnapshotEtagForWindow;
exports.recordPollOutcome = recordPollOutcome;
exports.getLatestPollAt = getLatestPollAt;
exports.listPollLog = listPollLog;
exports.getConfigValue = getConfigValue;
exports.setConfigValue = setConfigValue;
exports.getAllConfig = getAllConfig;
const database_js_1 = require("../database.js");
function parseJson(raw) {
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function rowToSnapshot(row) {
    return {
        id: row.id,
        clanId: row.clan_id ?? 1,
        fetchedAt: row.fetched_at,
        shareCode: row.share_code,
        windowStart: row.window_start,
        windowEnd: row.window_end,
        durationDays: row.duration_days,
        playerCount: row.player_count,
        totalChests: row.total_chests,
        totalPoints: row.total_points,
        trigger: row.trigger ?? 'scheduled',
        etag: row.etag ?? null,
        lastScannedAt: row.last_scanned_at ?? null,
        kingdom: row.kingdom ?? null,
        scoring: parseJson(row.scoring_json),
        settings: parseJson(row.settings_json),
    };
}
/**
 * Insert a snapshot + all its player rows, category rows, and chest
 * definitions inside one transaction so a crash mid-insert can't leave an
 * orphan snapshot row with no payload.
 */
function insertSnapshot(input) {
    const db = (0, database_js_1.getDb)();
    const totalChests = input.players.reduce((sum, p) => sum + p.chests, 0);
    const totalPoints = input.players.reduce((sum, p) => sum + p.points, 0);
    const insertMany = db.transaction(() => {
        // Derive the promoted columns from the stored settings blob. Keeping
        // the extraction here (rather than asking the caller to pass them)
        // means every insert path gets them for free.
        const settingsObj = parseJson(input.settingsJson);
        const lastScannedAt = typeof settingsObj?.lastScannedAt === 'string'
            ? settingsObj.lastScannedAt
            : null;
        const kingdom = typeof settingsObj?.kingdom === 'number'
            ? settingsObj.kingdom
            : null;
        const innerSettings = settingsObj?.settings;
        const general = innerSettings?.general;
        const scoringObj = general?.scoring;
        const scoringJson = scoringObj != null ? JSON.stringify(scoringObj) : null;
        const clanId = input.clanId;
        const snapResult = db
            .prepare(`INSERT INTO snapshot
         (clan_id, fetched_at, share_code, window_start, window_end, duration_days,
          player_count, total_chests, total_points, trigger, etag,
          settings_json, last_scanned_at, kingdom, scoring_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(clanId, input.fetchedAt, input.shareCode, input.windowStart, input.windowEnd, input.durationDays, input.players.length, totalChests, totalPoints, input.trigger, input.etag, input.settingsJson, lastScannedAt, kingdom, scoringJson);
        const snapshotId = snapResult.lastInsertRowid;
        // Post-v30: player_snapshot and player_category reference player
        // names through ct_player_ref(id) instead of carrying the
        // duplicated TEXT name. SELECT-or-INSERT the ref id once per
        // distinct player name in this snapshot, then bind the id into
        // both downstream INSERTs.
        const findPlayerRefStmt = db.prepare(`SELECT id FROM ct_player_ref WHERE clan_id = ? AND name = ?`);
        const insertPlayerRefStmt = db.prepare(`INSERT INTO ct_player_ref (clan_id, name) VALUES (?, ?)`);
        const playerRefId = (name) => {
            const existing = findPlayerRefStmt.get(clanId, name);
            if (existing)
                return existing.id;
            return Number(insertPlayerRefStmt.run(clanId, name).lastInsertRowid);
        };
        const playerStmt = db.prepare(`INSERT INTO player_snapshot
       (clan_id, snapshot_id, player_ref_id, guards_level, points, chests)
       VALUES (?, ?, ?, ?, ?, ?)`);
        const categoryStmt = db.prepare(`INSERT INTO player_category
       (clan_id, snapshot_id, player_ref_id, category, chests)
       VALUES (?, ?, ?, ?, ?)`);
        for (const p of input.players) {
            const refId = playerRefId(p.name);
            playerStmt.run(clanId, snapshotId, refId, p.guardsLevel, p.points, p.chests);
            for (const [cat, count] of Object.entries(p.categories)) {
                categoryStmt.run(clanId, snapshotId, refId, cat, count);
            }
        }
        // Post-D28: chest definitions are stored in a reference table
        // (chest_definition_ref) keyed on (type, name, source, points,
        // override_points) and linked to snapshots via
        // snapshot_chest_definition. This collapses the historical
        // ~286-row-per-snapshot duplication down to one row per distinct
        // catalog entry.
        //
        // The expression-UNIQUE on the ref table can't be reused via
        // ON CONFLICT because SQLite needs a literal column list there
        // (COALESCE in the index forbids it), so the lookup-or-insert
        // dance happens in two statements: SELECT the ref id with `IS`
        // for null-safe equality, INSERT if missing, then link.
        const findRefStmt = db.prepare(`SELECT id FROM chest_definition_ref
       WHERE type = ? AND name = ? AND source = ?
         AND points = ? AND override_points IS ?`);
        const insertRefStmt = db.prepare(`INSERT INTO chest_definition_ref
         (type, name, source, points, override_points)
       VALUES (?, ?, ?, ?, ?)`);
        const linkStmt = db.prepare(`INSERT OR IGNORE INTO snapshot_chest_definition
         (snapshot_id, chest_definition_ref_id, clan_id)
       VALUES (?, ?, ?)`);
        for (const d of input.definitions) {
            const existing = findRefStmt.get(d.type, d.name, d.source, d.points, d.overridePoints);
            const refId = existing
                ? existing.id
                : Number(insertRefStmt.run(d.type, d.name, d.source, d.points, d.overridePoints).lastInsertRowid);
            linkStmt.run(snapshotId, refId, clanId);
        }
        return snapshotId;
    });
    return insertMany();
}
/**
 * Every share code this clan holds snapshots under, most-recently-active
 * first. Drives the ChestTracker tab's archive picker, and is the
 * allow-list the routes validate a requested `?shareCode=` against —
 * derived from clan_id, so one clan can never name another's code.
 */
function listClanShareCodes(clanId) {
    const db = (0, database_js_1.getDb)();
    const rows = db
        .prepare(`SELECT share_code,
              COUNT(*)                       AS snapshots,
              COUNT(DISTINCT window_start)   AS weeks,
              MIN(window_start)              AS first_window,
              MAX(window_start)              AS last_window,
              MIN(fetched_at)                AS first_fetch,
              MAX(fetched_at)                AS last_fetch,
              MAX(kingdom)                   AS kingdom
         FROM snapshot
        WHERE clan_id = ?
        GROUP BY share_code
        ORDER BY last_fetch DESC`)
        .all(clanId);
    return rows.map((r) => ({
        shareCode: r.share_code,
        snapshots: r.snapshots,
        weeks: r.weeks,
        firstWindow: r.first_window,
        lastWindow: r.last_window,
        firstFetch: r.first_fetch,
        lastFetch: r.last_fetch,
        kingdom: r.kingdom ?? null,
    }));
}
function listSnapshots(opts) {
    const db = (0, database_js_1.getDb)();
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const where = [];
    const params = [];
    if (opts.clanId !== undefined) {
        where.push('clan_id = ?');
        params.push(opts.clanId);
    }
    if (opts.shareCode) {
        where.push('share_code = ?');
        params.push(opts.shareCode);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = db
        .prepare(`SELECT COUNT(*) as c FROM snapshot ${whereSql}`)
        .get(...params);
    // Order by the week covered (newest game week first), breaking ties
    // by fetched_at. Sorting only by fetched_at lets a manual backfill of
    // a past week jump ahead of the current week's auto-poll, which made
    // the UI default to the historical snapshot and show empty
    // week-over-week deltas (since that snapshot had no prior-week data
    // to compare against).
    const rows = db
        .prepare(`SELECT * FROM snapshot ${whereSql}
       ORDER BY window_start DESC, fetched_at DESC
       LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
    return { rows: rows.map(rowToSnapshot), total: totalRow.c };
}
/**
 * One canonical snapshot per distinct game-week window for a share code,
 * newest week first. "Canonical" = the most-recently-fetched snapshot of
 * that window — a single week accumulates a fresh snapshot row on every
 * upstream data change (see ingest.ts), so a plain `listSnapshots` page
 * can be many rows deep into a single week. This collapses to exactly one
 * row per week, which is what the ChestTracker tab's week-stepper arrows
 * walk. The id returned is the snapshot to load when that week is selected.
 */
function listSnapshotWeeks(opts) {
    const db = (0, database_js_1.getDb)();
    const limit = Math.max(1, Math.min(opts.limit ?? 520, 520));
    // The canonical-per-window subquery has to carry the same clan filter as
    // the outer one, or a clan sharing a code with another would pick the
    // other's row as "canonical" and then fail the outer id match — silently
    // dropping the week from the stepper.
    const clanSql = opts.clanId !== undefined ? 'AND s.clan_id = ?' : '';
    const clanSubSql = opts.clanId !== undefined ? 'AND s2.clan_id = ?' : '';
    const params = [opts.shareCode];
    if (opts.clanId !== undefined)
        params.push(opts.clanId, opts.clanId);
    params.push(limit);
    const rows = db
        .prepare(`SELECT id, window_start, window_end, fetched_at,
              player_count, total_chests, total_points
         FROM snapshot s
        WHERE s.share_code = ?
          ${clanSql}
          AND id = (
            SELECT id FROM snapshot s2
             WHERE s2.share_code = s.share_code
               ${clanSubSql}
               AND s2.window_start = s.window_start
             ORDER BY s2.fetched_at DESC, s2.id DESC
             LIMIT 1
          )
        ORDER BY window_start DESC
        LIMIT ?`)
        .all(...params);
    return rows.map((r) => ({
        id: r.id,
        windowStart: r.window_start,
        windowEnd: r.window_end,
        fetchedAt: r.fetched_at,
        playerCount: r.player_count,
        totalChests: r.total_chests,
        totalPoints: r.total_points,
    }));
}
function getSnapshot(id) {
    const db = (0, database_js_1.getDb)();
    const row = db
        .prepare('SELECT * FROM snapshot WHERE id = ?')
        .get(id);
    if (!row)
        return null;
    const snapshot = rowToSnapshot(row);
    // Post-v30: player names live in ct_player_ref. Both reads JOIN
    // through it so the consumer-facing shape (player_name strings)
    // stays unchanged.
    const playerRows = db
        .prepare(`SELECT ref.name AS player_name, ps.guards_level, ps.points, ps.chests
       FROM player_snapshot ps
       JOIN ct_player_ref ref ON ref.id = ps.player_ref_id
       WHERE ps.snapshot_id = ?
       ORDER BY ps.points DESC, ps.chests DESC, ref.name ASC`)
        .all(id);
    const categoryRows = db
        .prepare(`SELECT ref.name AS player_name, pc.category, pc.chests
       FROM player_category pc
       JOIN ct_player_ref ref ON ref.id = pc.player_ref_id
       WHERE pc.snapshot_id = ?`)
        .all(id);
    const categoriesByPlayer = new Map();
    for (const c of categoryRows) {
        let m = categoriesByPlayer.get(c.player_name);
        if (!m) {
            m = {};
            categoriesByPlayer.set(c.player_name, m);
        }
        m[c.category] = c.chests;
    }
    const players = playerRows.map((p) => ({
        playerName: p.player_name,
        guardsLevel: p.guards_level,
        points: p.points,
        chests: p.chests,
        categories: categoriesByPlayer.get(p.player_name) ?? {},
    }));
    // Post-D28: chest_definition was replaced by a ref + link table to
    // remove the per-snapshot catalog duplication. Reads go through the
    // link table so the surface returned to the caller is unchanged.
    const definitions = db
        .prepare(`SELECT ref.type, ref.name, ref.source, ref.points, ref.override_points
       FROM snapshot_chest_definition link
       JOIN chest_definition_ref ref ON ref.id = link.chest_definition_ref_id
       WHERE link.snapshot_id = ?
       ORDER BY ref.type, ref.name, ref.source`)
        .all(id);
    // Look up the most-recent snapshot for the immediately-prior weekly
    // window so the UI can show week-over-week deltas. We could recompute
    // the prior window from JS dates but matching on window_end keeps us
    // agnostic to any future window-anchor tweaks — whatever "last week"
    // was labelled as when it was captured, that's what we compare to.
    //
    // Scoped to the same clan AND the same share code: a week-over-week
    // delta only means something within one tracker's history, so an
    // archived code's oldest week must not borrow its "previous week" from
    // whatever code the clan moved to afterwards.
    const priorRow = db
        .prepare(`SELECT * FROM snapshot
       WHERE clan_id = ?
         AND share_code = ?
         AND window_end = ?
         AND id <> ?
       ORDER BY fetched_at DESC
       LIMIT 1`)
        .get(snapshot.clanId, snapshot.shareCode, snapshot.windowStart, id);
    const previousWeek = priorRow ? rowToSnapshot(priorRow) : null;
    return {
        ...snapshot,
        players,
        definitions: definitions.map((d) => ({
            type: d.type,
            name: d.name,
            source: d.source,
            points: d.points,
            overridePoints: d.override_points,
        })),
        previousWeek,
    };
}
/**
 * Return the newest snapshot, or null if none exist. Used by the UI as the
 * default view and by ingest to check idempotency.
 */
function getLatestSnapshot(opts = {}) {
    const db = (0, database_js_1.getDb)();
    const where = [];
    const params = [];
    if (opts.clanId !== undefined) {
        where.push('clan_id = ?');
        params.push(opts.clanId);
    }
    if (opts.shareCode) {
        where.push('share_code = ?');
        params.push(opts.shareCode);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const row = db
        .prepare(`SELECT * FROM snapshot ${whereSql} ORDER BY fetched_at DESC LIMIT 1`)
        .get(...params);
    return row ? rowToSnapshot(row) : null;
}
/**
 * Return the most recent snapshot that exactly matched the given window,
 * used to send If-None-Match on re-fetches of the same window.
 */
function getSnapshotEtagForWindow(clanId, shareCode, windowStart, windowEnd) {
    const db = (0, database_js_1.getDb)();
    // Deliberately keyed on the share code as well as the clan: an etag is
    // the *upstream's* cache validator, so one captured under a code the
    // clan has since moved off is meaningless to the new tracker and must
    // never be sent as If-None-Match against it.
    const row = db
        .prepare(`SELECT etag FROM snapshot
       WHERE clan_id = ? AND share_code = ? AND window_start = ? AND window_end = ?
         AND etag IS NOT NULL AND etag <> ''
       ORDER BY fetched_at DESC LIMIT 1`)
        .get(clanId, shareCode, windowStart, windowEnd);
    return row?.etag ?? null;
}
function recordPollOutcome(input) {
    const db = (0, database_js_1.getDb)();
    db.prepare(`INSERT INTO poll_log
     (clan_id, polled_at, share_code, window_start, window_end, trigger, status,
      etag_changed, prior_etag, new_etag, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.clanId, input.polledAt, input.shareCode, input.windowStart, input.windowEnd, input.trigger, input.status, input.etagChanged ? 1 : 0, input.priorEtag, input.newEtag, input.errorMessage);
}
function getLatestPollAt(opts = {}) {
    const db = (0, database_js_1.getDb)();
    const where = [];
    const params = [];
    if (opts.clanId !== undefined) {
        where.push('clan_id = ?');
        params.push(opts.clanId);
    }
    if (opts.shareCode) {
        where.push('share_code = ?');
        params.push(opts.shareCode);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const row = db
        .prepare(`SELECT MAX(polled_at) AS t FROM poll_log ${whereSql}`)
        .get(...params);
    return row?.t ?? null;
}
function listPollLog(opts = {}) {
    const db = (0, database_js_1.getDb)();
    const where = [];
    const params = [];
    if (opts.clanId !== undefined) {
        where.push('clan_id = ?');
        params.push(opts.clanId);
    }
    if (opts.shareCode) {
        where.push('share_code = ?');
        params.push(opts.shareCode);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(1, opts.limit ?? 5000), 50000);
    const sql = `SELECT id, polled_at, share_code, window_start, window_end,
                      trigger, status, etag_changed, prior_etag, new_etag,
                      error_message
                 FROM poll_log ${whereSql}
                 ORDER BY polled_at DESC
                 LIMIT ${limit}`;
    const rows = db.prepare(sql).all(...params);
    return rows.map((r) => ({
        id: r.id,
        polledAt: r.polled_at,
        shareCode: r.share_code,
        windowStart: r.window_start,
        windowEnd: r.window_end,
        trigger: r.trigger,
        status: r.status,
        etagChanged: r.etag_changed === 1,
        priorEtag: r.prior_etag ?? null,
        newEtag: r.new_etag ?? null,
        errorMessage: r.error_message ?? null,
    }));
}
// ─── Config ───
function getConfigValue(key) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT value FROM ct_config WHERE key = ?').get(key);
    return row?.value ?? null;
}
function setConfigValue(key, value) {
    const db = (0, database_js_1.getDb)();
    db.prepare(`INSERT INTO ct_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, new Date().toISOString());
}
function getAllConfig() {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare('SELECT key, value FROM ct_config').all();
    const out = {};
    for (const r of rows)
        out[r.key] = r.value;
    return out;
}
//# sourceMappingURL=external-repo.js.map