"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePointsForKey = exports.makeCacheKey = void 0;
exports.invalidateSourceKeySummary = invalidateSourceKeySummary;
exports.getSourceKeySummary = getSourceKeySummary;
exports.todayGameDay = todayGameDay;
exports.loadPointEntries = loadPointEntries;
exports.loadPointSchedule = loadPointSchedule;
exports.getAllOverrides = getAllOverrides;
exports.loadOverrides = loadOverrides;
exports.getPointsForSourceAt = getPointsForSourceAt;
exports.savePointEntries = savePointEntries;
exports.listPointChanges = listPointChanges;
exports.getPointChange = getPointChange;
exports.upsertStep = upsertStep;
exports.updateStep = updateStep;
exports.insertPointLog = insertPointLog;
exports.recalculatePoints = recalculatePoints;
exports.applyTimelineChange = applyTimelineChange;
const database_js_1 = require("../database.js");
const logger_js_1 = require("../../utils/logger.js");
const ttl_cache_js_1 = require("../../utils/ttl-cache.js");
const source_names_js_1 = require("../../vision/source-names.js");
const index_js_1 = require("../../config/index.js");
const game_day_js_1 = require("../../utils/game-day.js");
const chest_summary_repo_js_1 = require("./chest-summary-repo.js");
const point_timeline_js_1 = require("../point-timeline.js");
const log = (0, logger_js_1.childLogger)('source-points-repo');
// Source point values are PER CLAN (v86) and superadmin-managed: each clan has
// its own override table, and a clan with no override for a chest scores the
// built-in default. They were one global table from v43 to v85; v86 copied
// that table to every clan, so the clans started out identical.
//
// Since v99 a value applies FROM a game day (point-timeline.ts): the table
// holds each key's timeline, and a record scores the values of the day it was
// earned. "Current values" below means the ones in force today.
const SOURCE_KEY_SUMMARY_CACHE_KEY = 'sourceKeySummary';
// The source-points summary is an expensive aggregate read by the leaderboard
// FAQ. It only changes on point overrides, recalculation, scan completion, or
// chest reassignment, so it is memoized per clan under this prefix and
// invalidated explicitly at those sites (with a 5-min TTL backstop). See
// src/utils/ttl-cache.ts.
const SOURCE_KEY_SUMMARY_TTL_MS = 300000;
/** Drop every clan's cached source-key summary so the next read recomputes fresh. */
function invalidateSourceKeySummary() {
    (0, ttl_cache_js_1.invalidate)(SOURCE_KEY_SUMMARY_CACHE_KEY);
}
var point_timeline_js_2 = require("../point-timeline.js");
Object.defineProperty(exports, "makeCacheKey", { enumerable: true, get: function () { return point_timeline_js_2.makeCacheKey; } });
Object.defineProperty(exports, "resolvePointsForKey", { enumerable: true, get: function () { return point_timeline_js_2.resolvePointsForKey; } });
/**
 * Sort chest rows: wildcard pinned first, then alphabetical by chest name.
 */
function sortChestRows(rows) {
    return rows.sort((a, b) => {
        if (a.isWildcard !== b.isWildcard)
            return a.isWildcard ? -1 : 1;
        return a.chestName.localeCompare(b.chestName);
    });
}
function getSourceKeySummary(clanId) {
    // Read-mostly aggregate; memoize per clan. Invalidated on every mutation
    // that changes the summary (overrides, recalculate, scan completion,
    // reassignment) so nobody sees stale counts. TTL is only a backstop.
    return (0, ttl_cache_js_1.cached)(`${SOURCE_KEY_SUMMARY_CACHE_KEY}:${clanId}`, SOURCE_KEY_SUMMARY_TTL_MS, () => computeSourceKeySummary(clanId));
}
function computeSourceKeySummary(clanId) {
    const db = (0, database_js_1.getDb)();
    const overrides = getAllOverrides(clanId);
    // Group by the FK ids on the base table (index-friendly), then join for
    // display columns. This clan's records only — its values are its own, so
    // the sources listed are the ones its members actually receive.
    // chest_sources.source and chests.name are UNIQUE so grouping on
    // (chest_source_id, chest_id) is identical to grouping on
    // (chest_source, chest_name, chest_type) — chest_type is a function of the
    // (source, chest) pair (crypt rarity first, v83), so dropping it from the
    // GROUP BY changes nothing.
    const rows = db.prepare(`
    SELECT cs.source AS chest_source, ch.name AS chest_name,
           COALESCE(cs.rarity, ch.chest_type) AS chest_type, g.cnt
    FROM (
      SELECT chest_source_id, chest_id, COUNT(*) AS cnt
      FROM chest_records
      WHERE clan_id = ? AND chest_source_id IS NOT NULL
      GROUP BY chest_source_id, chest_id
    ) g
    JOIN chest_sources cs ON cs.id = g.chest_source_id
    JOIN chests ch ON ch.id = g.chest_id
    WHERE cs.source != ''
  `).all(clanId);
    const buckets = new Map();
    for (const row of rows) {
        const key = (0, source_names_js_1.getSourceKey)(row.chest_source);
        if (!key)
            continue;
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = {
                sampleSource: row.chest_source,
                sampleCount: row.cnt,
                totalCount: 0,
                rowsByName: new Map(),
            };
            buckets.set(key, bucket);
        }
        bucket.totalCount += row.cnt;
        if (row.cnt > bucket.sampleCount) {
            bucket.sampleSource = row.chest_source;
            bucket.sampleCount = row.cnt;
        }
        const existing = bucket.rowsByName.get(row.chest_name);
        if (existing) {
            existing.count += row.cnt;
            if (row.cnt > existing.typeCount) {
                existing.chestType = row.chest_type;
                existing.typeCount = row.cnt;
            }
        }
        else {
            bucket.rowsByName.set(row.chest_name, {
                count: row.cnt,
                chestType: row.chest_type,
                typeCount: row.cnt,
                override: null,
            });
        }
    }
    for (const ov of overrides) {
        let bucket = buckets.get(ov.sourceKey);
        if (!bucket) {
            bucket = {
                sampleSource: '',
                sampleCount: 0,
                totalCount: 0,
                rowsByName: new Map(),
            };
            buckets.set(ov.sourceKey, bucket);
        }
        const existing = bucket.rowsByName.get(ov.chestName);
        if (existing) {
            existing.override = ov.pointValue;
        }
        else {
            bucket.rowsByName.set(ov.chestName, {
                count: 0,
                chestType: '',
                typeCount: 0,
                override: ov.pointValue,
            });
        }
    }
    const summary = [];
    for (const [key, bucket] of buckets.entries()) {
        const defaultPoints = (0, source_names_js_1.getDefaultPointsForKey)(key);
        const wildcardOverride = bucket.rowsByName.get('')?.override ?? null;
        if (!bucket.rowsByName.has('')) {
            bucket.rowsByName.set('', { count: 0, chestType: '', typeCount: 0, override: null });
        }
        const chestRows = [];
        for (const [chestName, r] of bucket.rowsByName.entries()) {
            const isWildcard = chestName === '';
            // What applies to this row with no override of its own: the source-wide
            // wildcard override if the admin set one, else the seeded default for
            // this exact chest, else the source-wide default. getDefaultPointsFor
            // collapses the last two (it returns the key default for '').
            const fallback = !isWildcard && wildcardOverride !== null
                ? wildcardOverride
                : (0, source_names_js_1.getDefaultPointsFor)(key, chestName);
            chestRows.push({
                chestName,
                chestType: r.chestType,
                count: r.count,
                override: r.override,
                effectivePoints: r.override !== null ? r.override : fallback,
                fallbackPoints: fallback,
                isWildcard,
            });
        }
        summary.push({
            sourceKey: key,
            sampleSource: bucket.sampleSource,
            totalCount: bucket.totalCount,
            defaultPoints,
            wildcardOverride,
            isCustom: !(0, source_names_js_1.isKnownSourceKey)(key),
            chestRows: sortChestRows(chestRows),
        });
    }
    summary.sort((a, b) => {
        if (a.isCustom !== b.isCustom)
            return a.isCustom ? -1 : 1;
        return a.sourceKey.localeCompare(b.sourceKey);
    });
    return summary;
}
/** Today's game day (YYYY-MM-DD) — the day a "from today on" save applies from. */
function todayGameDay() {
    return (0, game_day_js_1.currentGameDate)((0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
}
/** Every value row of the clan — its whole timeline, oldest first. */
function loadPointEntries(clanId) {
    const rows = (0, database_js_1.getDb)().prepare(`
    SELECT source_key, chest_name, point_value, effective_from, change_id, updated_at
      FROM source_point_overrides WHERE clan_id = ?
     ORDER BY effective_from, source_key, chest_name
  `).all(clanId);
    return rows.map((r) => ({
        sourceKey: r.source_key,
        chestName: r.chest_name,
        from: r.effective_from,
        value: r.point_value,
        changeId: r.change_id,
        updatedAt: r.updated_at,
    }));
}
/** The clan's values as a step function of time. */
function loadPointSchedule(clanId) {
    return (0, point_timeline_js_1.buildSchedule)(loadPointEntries(clanId), (0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
}
/** The values in force today, one row per key that has one. */
function getAllOverrides(clanId) {
    const entries = loadPointEntries(clanId);
    const today = (0, point_timeline_js_1.valuesOn)(entries, todayGameDay());
    const latest = new Map();
    for (const e of entries) {
        const k = (0, point_timeline_js_1.makeCacheKey)(e.sourceKey, e.chestName);
        if (!today.has(k))
            continue;
        const cur = latest.get(k);
        if (!cur || e.from > cur.from)
            latest.set(k, e);
    }
    return [...latest.values()]
        .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey) || a.chestName.localeCompare(b.chestName))
        .map((e, i) => ({
        id: i + 1,
        sourceKey: e.sourceKey,
        chestName: e.chestName,
        pointValue: e.value,
        updatedAt: e.updatedAt,
    }));
}
/**
 * The clan's values in force today, keyed on makeCacheKey(source, chest_name)
 * — what the board shows and what a save is planned against.
 */
function loadOverrides(clanId) {
    return (0, point_timeline_js_1.valuesOn)(loadPointEntries(clanId), todayGameDay());
}
/**
 * Hot-path point lookup for a scan: the values of the game day the chest was
 * earned on (`earnedAtMs`, i.e. what becomes `effective_at`), then exact
 * override → wildcard → default. Load the schedule once per scan.
 */
function getPointsForSourceAt(schedule, source, chestName, earnedAtMs) {
    return (0, point_timeline_js_1.pointsAt)(schedule, source, chestName, earnedAtMs);
}
/**
 * Replace the clan's whole timeline with `entries`, then delete any dated step
 * no entry belongs to any more. Call inside the caller's transaction when
 * steps are written alongside. Records are NOT touched here; the caller
 * recalculates afterwards.
 */
function savePointEntries(clanId, entries) {
    const db = (0, database_js_1.getDb)();
    const ins = db.prepare(`
    INSERT INTO source_point_overrides (clan_id, source_key, chest_name, point_value, effective_from, change_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
    db.transaction(() => {
        db.prepare('DELETE FROM source_point_overrides WHERE clan_id = ?').run(clanId);
        for (const e of entries) {
            ins.run(clanId, e.sourceKey, e.chestName, e.value, e.from, e.from === '' ? null : e.changeId, e.updatedAt);
        }
        db.prepare(`
      DELETE FROM source_point_changes
       WHERE clan_id = ? AND kind = 'step'
         AND NOT EXISTS (SELECT 1 FROM source_point_overrides o WHERE o.change_id = source_point_changes.id)
    `).run(clanId);
    })();
    invalidateSourceKeySummary();
}
function toChangeRow(r) {
    let lines = [];
    try {
        const parsed = JSON.parse(r.lines);
        if (Array.isArray(parsed))
            lines = parsed;
    }
    catch { /* a malformed log row shows no lines */ }
    return {
        id: r.id,
        kind: r.kind,
        effectiveFrom: r.effective_from,
        lines,
        note: r.note,
        createdAt: r.created_at,
        createdBy: r.created_by,
        updatedAt: r.updated_at,
        updatedBy: r.updated_by,
    };
}
/** The clan's history rows: dated steps newest day first, then the log newest first. */
function listPointChanges(clanId) {
    const rows = (0, database_js_1.getDb)().prepare(`
    SELECT * FROM source_point_changes WHERE clan_id = ?
     ORDER BY kind = 'step' DESC, effective_from DESC, created_at DESC, id DESC
  `).all(clanId);
    return rows.map(toChangeRow);
}
function getPointChange(clanId, id) {
    const row = (0, database_js_1.getDb)().prepare('SELECT * FROM source_point_changes WHERE clan_id = ? AND id = ?').get(clanId, id);
    return row ? toChangeRow(row) : null;
}
/**
 * The step for `day`, created if the clan has none yet. A second save on the
 * same day joins the first: the note is replaced only when a new one is given.
 */
function upsertStep(clanId, day, user, note, now) {
    const db = (0, database_js_1.getDb)();
    const existing = db.prepare("SELECT id FROM source_point_changes WHERE clan_id = ? AND kind = 'step' AND effective_from = ?").get(clanId, day);
    if (existing) {
        db.prepare(`
      UPDATE source_point_changes
         SET updated_at = ?, updated_by = ?, note = CASE WHEN ? != '' THEN ? ELSE note END
       WHERE id = ?
    `).run(now, user, note, note, existing.id);
        return existing.id;
    }
    return db.prepare(`
    INSERT INTO source_point_changes (clan_id, kind, effective_from, note, created_at, created_by)
    VALUES (?, 'step', ?, ?, ?, ?) RETURNING id
  `).get(clanId, day, note, now, user).id;
}
/** Move a step to another day and/or change its note. */
function updateStep(id, day, note, user, now) {
    (0, database_js_1.getDb)().prepare('UPDATE source_point_changes SET effective_from = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(day, note, now, user, id);
}
/** Log a correction to all history, or a copy, with the lines it changed. */
function insertPointLog(clanId, kind, lines, note, user, now) {
    return (0, database_js_1.getDb)().prepare(`
    INSERT INTO source_point_changes (clan_id, kind, effective_from, lines, note, created_at, created_by)
    VALUES (?, ?, '', ?, ?, ?, ?) RETURNING id
  `).get(clanId, kind, JSON.stringify(lines), note, now, user).id;
}
/**
 * Recalculate one clan's chest_records.point_value from its timeline: each
 * record gets the value in force on the game day it was earned. Another clan's
 * records are never touched: its values are its own.
 *
 * `onlyCanonKeys` limits the pass to sources whose canonical key is in the
 * set — what a save uses, so it rewrites exactly the sources it changed.
 * Returns the number of rows whose value actually changed.
 */
function recalculatePoints(clanId, onlyCanonKeys) {
    const schedule = loadPointSchedule(clanId);
    const updated = rewriteRecords(clanId, (key, chest) => (0, point_timeline_js_1.valueRuns)(schedule, key, chest), onlyCanonKeys);
    log.info(`Recalculated point values for clan ${clanId}: ${updated} rows updated`);
    invalidateSourceKeySummary();
    return updated;
}
/**
 * Carry a dated change into the stored records: a record whose value under
 * the timeline `next` differs from its value under `prev` gets the `next`
 * one, and nothing else is touched — not even a record that was already out
 * of line before, which only Recalculate (or a correction to all history)
 * rewrites. That is what keeps a dated change off the days it doesn't cover.
 */
function applyTimelineChange(clanId, prev, next, onlyCanonKeys) {
    const updated = rewriteRecords(clanId, (key, chest) => (0, point_timeline_js_1.changedRuns)(prev, next, key, chest), onlyCanonKeys);
    log.info(`Applied a dated points change for clan ${clanId}: ${updated} rows updated`);
    invalidateSourceKeySummary();
    return updated;
}
/**
 * Rewrite one clan's chest_records.point_value. Groups by (source_key,
 * chest_name), and `runsFor` says which stretches of time to write and with
 * what value — one UPDATE each, a single one for a pair no dated change
 * touches. Notifies the daily-summary rollup when rows actually changed.
 */
function rewriteRecords(clanId, runsFor, onlyCanonKeys) {
    const db = (0, database_js_1.getDb)();
    const distinct = db.prepare(`
    SELECT DISTINCT chest_source, chest_name
    FROM chest_records_v
    WHERE clan_id = ? AND chest_source != ''
  `).all(clanId);
    const groups = new Map();
    for (const row of distinct) {
        const key = (0, source_names_js_1.getSourceKey)(row.chest_source);
        if (!key)
            continue;
        if (onlyCanonKeys && !onlyCanonKeys.has((0, source_names_js_1.canonicalSourceKey)(key)))
            continue;
        const cacheKey = (0, point_timeline_js_1.makeCacheKey)(key, row.chest_name);
        const existing = groups.get(cacheKey);
        if (existing) {
            existing.sources.push(row.chest_source);
        }
        else {
            groups.set(cacheKey, { sourceKey: key, chestName: row.chest_name, sources: [row.chest_source] });
        }
    }
    let totalUpdated = 0;
    const tx = db.transaction(() => {
        for (const group of groups.values()) {
            // Resolve string source/name values to their FK ids and UPDATE on
            // those — the chest_source / chest_name columns no longer exist on
            // chest_records post-D3 (they live in the chest_sources / chests
            // reference tables now). `point_value != ?` keeps the count honest:
            // SQLite counts a row rewritten to the value it already held.
            const placeholders = group.sources.map(() => '?').join(', ');
            for (const run of runsFor(group.sourceKey, group.chestName)) {
                const range = [];
                const rangeArgs = [];
                if (run.from > 0) {
                    range.push('AND effective_at >= ?');
                    rangeArgs.push(run.from);
                }
                if (Number.isFinite(run.to)) {
                    range.push('AND effective_at < ?');
                    rangeArgs.push(run.to);
                }
                const result = db.prepare(`
          UPDATE chest_records
             SET point_value = ?
           WHERE clan_id = ?
             AND chest_source_id IN (
               SELECT id FROM chest_sources WHERE source IN (${placeholders})
             )
             AND chest_id = (SELECT id FROM chests WHERE name = ?)
             AND point_value != ?
             ${range.join(' ')}
        `).run(run.value, clanId, ...group.sources, group.chestName, run.value, ...rangeArgs);
                totalUpdated += result.changes;
            }
        }
    });
    tx();
    if (totalUpdated > 0)
        (0, chest_summary_repo_js_1.notifyChestDataChanged)(clanId);
    return totalUpdated;
}
//# sourceMappingURL=source-points-repo.js.map