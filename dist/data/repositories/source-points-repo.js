"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidateSourceKeySummary = invalidateSourceKeySummary;
exports.makeCacheKey = makeCacheKey;
exports.getSourceKeySummary = getSourceKeySummary;
exports.getAllOverrides = getAllOverrides;
exports.loadOverrides = loadOverrides;
exports.getPointsForSourceCached = getPointsForSourceCached;
exports.resolvePointsForKey = resolvePointsForKey;
exports.writeOverrides = writeOverrides;
exports.recalculateAllPoints = recalculateAllPoints;
const database_js_1 = require("../database.js");
const logger_js_1 = require("../../utils/logger.js");
const ttl_cache_js_1 = require("../../utils/ttl-cache.js");
const source_names_js_1 = require("../../vision/source-names.js");
const chest_summary_repo_js_1 = require("./chest-summary-repo.js");
const clan_repo_js_1 = require("./clan-repo.js");
const log = (0, logger_js_1.childLogger)('source-points-repo');
// Source point values are a single GLOBAL scoring table shared by every
// clan (superadmin-managed). The overrides table has no clan_id; only the
// chest_records backfill/recalculate is per-clan (looped over listClans()).
const SOURCE_KEY_SUMMARY_CACHE_KEY = 'sourceKeySummary';
// The source-points summary is an expensive aggregate read by a polled
// admin endpoint (GET /api/admin/source-points). It only changes on point
// overrides, recalculation, scan completion, or chest reassignment, so we
// memoize it under a single global key and invalidate explicitly at those
// sites (with a 5-min TTL backstop). See src/utils/ttl-cache.ts.
const SOURCE_KEY_SUMMARY_TTL_MS = 300000;
/** Drop the cached source-key summary so the next read recomputes fresh. */
function invalidateSourceKeySummary() {
    (0, ttl_cache_js_1.invalidate)(SOURCE_KEY_SUMMARY_CACHE_KEY);
}
/**
 * Build a cache-map key for (source_key, chest_name). Using a tab separator
 * keeps the composite unambiguous without colliding with either column's
 * value space (source keys and chest names never contain tabs).
 */
function makeCacheKey(sourceKey, chestName) {
    // Canonicalize the source part (space-insensitive) so overrides match
    // regardless of whether the source was OCR'd with spaces (Tesseract /
    // historical) or without (PaddleOCR). The chest name is already canonical
    // via correctChestName, so it's compared verbatim. See canonicalSourceKey.
    return `${(0, source_names_js_1.canonicalSourceKey)(sourceKey)}\t${chestName}`;
}
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
function getSourceKeySummary() {
    // Read-mostly aggregate behind a polled admin endpoint; memoize under a
    // single global key. Invalidated on every mutation that changes the
    // summary (overrides, recalculate, scan completion, reassignment) so
    // admins never see stale counts. TTL is only a backstop.
    return (0, ttl_cache_js_1.cached)(SOURCE_KEY_SUMMARY_CACHE_KEY, SOURCE_KEY_SUMMARY_TTL_MS, () => computeSourceKeySummary());
}
function computeSourceKeySummary() {
    const db = (0, database_js_1.getDb)();
    const overrides = getAllOverrides();
    // Group by the FK ids on the base table (index-friendly), then join for
    // display columns. Aggregated across ALL clans — the scoring table is
    // global, so every admin sees the same authoritative source list.
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
      WHERE chest_source_id IS NOT NULL
      GROUP BY chest_source_id, chest_id
    ) g
    JOIN chest_sources cs ON cs.id = g.chest_source_id
    JOIN chests ch ON ch.id = g.chest_id
    WHERE cs.source != ''
  `).all();
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
function getAllOverrides() {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare('SELECT id, source_key, chest_name, point_value, updated_at FROM source_point_overrides ORDER BY source_key, chest_name').all();
    return rows.map((r) => ({
        id: r.id,
        sourceKey: r.source_key,
        chestName: r.chest_name,
        pointValue: r.point_value,
        updatedAt: r.updated_at,
    }));
}
/**
 * Load all overrides into an in-memory map keyed on makeCacheKey(source,
 * chest_name). Called once per scan and passed to getPointsForSourceCached()
 * in the hot loop. Overrides are global, so every clan's scan uses the same
 * map.
 */
function loadOverrides() {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare('SELECT source_key, chest_name, point_value FROM source_point_overrides').all();
    const map = new Map();
    for (const row of rows) {
        map.set(makeCacheKey(row.source_key, row.chest_name), row.point_value);
    }
    return map;
}
/**
 * Hot-path point lookup. Tries the exact (source_key, chest_name) override
 * first, then the wildcard (source_key, '') override, then the hardcoded
 * default — which is itself per-chest where the source pays its chests
 * different rates (SOURCE_CHEST_POINTS). Safe to call for every chest inserted
 * during a scan.
 */
function getPointsForSourceCached(overrides, source, chestName) {
    const key = (0, source_names_js_1.getSourceKey)(source);
    if (!key)
        return 0;
    return resolvePointsForKey(overrides, key, chestName);
}
/**
 * The lookup stack for an already-derived source key: exact override, then the
 * source's wildcard override, then the seeded default. The one place the order
 * is written down — scans, recalculation and the admin board's previews all
 * resolve through it, so a preview can never disagree with what a save does.
 */
function resolvePointsForKey(overrides, key, chestName) {
    const exact = overrides.get(makeCacheKey(key, chestName));
    if (exact !== undefined)
        return exact;
    const wildcard = overrides.get(makeCacheKey(key, ''));
    if (wildcard !== undefined)
        return wildcard;
    return (0, source_names_js_1.getDefaultPointsFor)(key, chestName);
}
/**
 * Apply a batch of override writes in one transaction. Each write first clears
 * every row for the same (canonical source key, chest name) — a source OCR'd
 * with and without spaces can hold one row per spelling, and the lookup map
 * keys on the canonical form, so leaving a second spelling behind would let it
 * win or lose at random. Records are NOT touched here; the caller recalculates
 * the affected sources afterwards (see points-board.ts applyPointChanges).
 */
function writeOverrides(writes) {
    if (writes.length === 0)
        return;
    const db = (0, database_js_1.getDb)();
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT id, source_key, chest_name FROM source_point_overrides').all();
    const del = db.prepare('DELETE FROM source_point_overrides WHERE id = ?');
    const ins = db.prepare('INSERT INTO source_point_overrides (source_key, chest_name, point_value, updated_at) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
        for (const w of writes) {
            const canon = (0, source_names_js_1.canonicalSourceKey)(w.sourceKey);
            for (const row of existing) {
                if (row.chest_name === w.chestName && (0, source_names_js_1.canonicalSourceKey)(row.source_key) === canon)
                    del.run(row.id);
            }
            if (w.points !== null)
                ins.run(w.sourceKey, w.chestName, w.points, now);
        }
    })();
    const set = writes.filter((w) => w.points !== null).length;
    log.info(`Source points: wrote ${set} value(s), cleared ${writes.length - set}`);
    invalidateSourceKeySummary();
}
/**
 * Recalculate chest_records.point_value across EVERY clan using the current
 * global override + default stack. The override map is global, so it's
 * loaded once and applied to each clan's rows in turn.
 *
 * `onlyCanonKeys` limits the pass to sources whose canonical key is in the
 * set — what a save uses, so it rewrites exactly the sources it changed.
 * Returns the number of rows whose value actually changed.
 */
function recalculateAllPoints(onlyCanonKeys) {
    const overrideMap = loadOverrides();
    let totalUpdated = 0;
    let clanCount = 0;
    for (const clan of (0, clan_repo_js_1.listClans)()) {
        clanCount++;
        totalUpdated += recalculatePointsForClan(clan.id, overrideMap, onlyCanonKeys);
    }
    log.info(`Recalculated point values: ${totalUpdated} rows updated across ${clanCount} clan(s)`);
    invalidateSourceKeySummary();
    return totalUpdated;
}
/**
 * Recalculate one clan's chest_records.point_value using the given global
 * override map. Groups by (source_key, chest_name) so every chest name gets
 * its effective value applied in one UPDATE. Notifies the daily-summary
 * rollup when the clan's rows actually changed.
 */
function recalculatePointsForClan(clanId, overrideMap, onlyCanonKeys) {
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
        const cacheKey = makeCacheKey(key, row.chest_name);
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
            const value = resolvePointsForKey(overrideMap, group.sourceKey, group.chestName);
            // Resolve string source/name values to their FK ids and UPDATE on
            // those — the chest_source / chest_name columns no longer exist on
            // chest_records post-D3 (they live in the chest_sources / chests
            // reference tables now). `point_value != ?` keeps the count honest:
            // SQLite counts a row rewritten to the value it already held.
            const placeholders = group.sources.map(() => '?').join(', ');
            const result = db.prepare(`
        UPDATE chest_records
           SET point_value = ?
         WHERE clan_id = ?
           AND chest_source_id IN (
             SELECT id FROM chest_sources WHERE source IN (${placeholders})
           )
           AND chest_id = (SELECT id FROM chests WHERE name = ?)
           AND point_value != ?
      `).run(value, clanId, ...group.sources, group.chestName, value);
            totalUpdated += result.changes;
        }
    });
    tx();
    if (totalUpdated > 0)
        (0, chest_summary_repo_js_1.notifyChestDataChanged)(clanId);
    return totalUpdated;
}
//# sourceMappingURL=source-points-repo.js.map