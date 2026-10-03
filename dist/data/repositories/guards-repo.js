"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidateGuardsCache = invalidateGuardsCache;
exports.getGuardsEstimates = getGuardsEstimates;
exports.summarizeEstimate = summarizeEstimate;
exports.getGuardsSummaries = getGuardsSummaries;
exports.getClanGuardsOverview = getClanGuardsOverview;
exports.listGuardsReports = listGuardsReports;
exports.addGuardsReport = addGuardsReport;
exports.deleteGuardsReport = deleteGuardsReport;
/**
 * Guards (guardsmen) levels per member — estimated, never stored.
 *
 * Every read rebuilds each member's evidence from resource_transactions (Omen
 * Essence and Scientific Tractates donations, see src/config/guards-ladder.ts)
 * plus any level an admin entered in member_guards_reports, and runs the
 * estimator over it (src/data/guards-estimator.ts). The result is cached briefly
 * per clan; the inputs change at most once a day.
 *
 * Two passes per clan: the first with no prior, then again with the clan's own
 * level make-up as a tie-breaker, so a member whose only donation fits two
 * levels equally lands on the one their clan is made of rather than the lower
 * by default.
 *
 * Deliberately unrelated to the ChestTracker `guardsLevel` the external ingest
 * carries: that is hand-maintained elsewhere, lags real level-ups, and uses G1
 * as "not set". Nothing here reads it.
 */
const database_js_1 = require("../database.js");
const ttl_cache_js_1 = require("../../utils/ttl-cache.js");
const logger_js_1 = require("../../utils/logger.js");
const game_day_js_1 = require("../../utils/game-day.js");
const guards_ladder_js_1 = require("../../config/guards-ladder.js");
const guards_estimator_js_1 = require("../guards-estimator.js");
const log = (0, logger_js_1.childLogger)('guards-repo');
const CACHE_TTL_MS = 60_000;
const CACHE_PREFIX = 'guards:';
/** Drop the cached estimates — one clan, or every clan. */
function invalidateGuardsCache(clanId) {
    (0, ttl_cache_js_1.invalidate)(clanId === undefined ? CACHE_PREFIX : `${CACHE_PREFIX}${clanId}:`);
}
// One warning per missing slug per process: a renamed resource type would
// otherwise turn every member's level into a quiet "unknown".
const warnedSlugs = new Set();
function warnIfSlugMissing() {
    const db = (0, database_js_1.getDb)();
    for (const slug of [guards_ladder_js_1.ESSENCE_RESOURCE_SLUG, guards_ladder_js_1.TRACTATE_RESOURCE_SLUG]) {
        if (warnedSlugs.has(slug))
            continue;
        const hit = db.prepare('SELECT 1 AS ok FROM resource_types WHERE slug = ?').get(slug);
        if (!hit) {
            warnedSlugs.add(slug);
            log.warn(`Guards levels: no resource type with slug "${slug}" — every estimate that depends on it `
                + 'will read as unknown. Check ESSENCE_RESOURCE_SLUG / TRACTATE_RESOURCE_SLUG in '
                + 'src/config/guards-ladder.ts against resource_types.');
        }
    }
}
/** Every member's raw evidence, keyed by member id. */
function loadObservations(clanId) {
    const db = (0, database_js_1.getDb)();
    warnIfSlugMissing();
    // Tractates are filtered to the tier amounts in SQL: the table holds thousands
    // of other tractate lines (the 250k gold-pass line alone is most of them), none
    // of which says anything about a level.
    const tierAmounts = guards_ladder_js_1.TRACTATE_TIERS.map((t) => t.amount);
    const rows = db.prepare(`
    SELECT rt.member_id AS memberId, t.slug AS slug, rt.transaction_date AS date, rt.amount AS amount
    FROM resource_transactions rt
    JOIN resource_types t ON t.id = rt.resource_type_id
    WHERE rt.clan_id = ? AND rt.direction = 1
      AND (t.slug = ? OR (t.slug = ? AND rt.amount IN (${tierAmounts.map(() => '?').join(',')})))
  `).all(clanId, guards_ladder_js_1.ESSENCE_RESOURCE_SLUG, guards_ladder_js_1.TRACTATE_RESOURCE_SLUG, ...tierAmounts);
    const reports = db.prepare(`
    SELECT member_id AS memberId, level, observed_date AS date
    FROM member_guards_reports WHERE clan_id = ?
  `).all(clanId);
    const out = new Map();
    const push = (memberId, o) => {
        const list = out.get(memberId);
        if (list)
            list.push(o);
        else
            out.set(memberId, [o]);
    };
    for (const r of rows) {
        push(r.memberId, {
            kind: r.slug === guards_ladder_js_1.ESSENCE_RESOURCE_SLUG ? 'essence' : 'tractate',
            date: r.date,
            amount: r.amount,
        });
    }
    for (const r of reports)
        push(r.memberId, { kind: 'report', date: r.date, level: r.level });
    return out;
}
/**
 * Every member's estimate for one clan, members with no usable evidence absent.
 *
 * Returns a SHARED cached Map — read it, never mutate it.
 */
function getGuardsEstimates(clanId) {
    return (0, ttl_cache_js_1.cached)(`${CACHE_PREFIX}${clanId}:estimates`, CACHE_TTL_MS, () => {
        const observations = loadObservations(clanId);
        const firstPass = [];
        for (const obs of observations.values()) {
            const e = (0, guards_estimator_js_1.estimateGuardsLevel)(obs);
            // Only levels the evidence actually settled feed the prior; a coin-flip
            // member would otherwise vote for whichever level wins ties by default.
            if (e && e.confidence !== 'low')
                firstPass.push(e.level);
        }
        const prior = (0, guards_estimator_js_1.buildLevelPrior)(firstPass);
        const out = new Map();
        for (const [memberId, obs] of observations) {
            const e = (0, guards_estimator_js_1.estimateGuardsLevel)(obs, prior);
            if (e)
                out.set(memberId, e);
        }
        return out;
    });
}
/** Cut an estimate down to what a table cell shows. `today` is a game day. */
function summarizeEstimate(e, today) {
    const age = (0, game_day_js_1.daysBetweenGameDates)(e.asOf, today);
    const newest = e.evidence[e.evidence.length - 1];
    return {
        level: e.level,
        asOf: e.asOf,
        confidence: e.confidence,
        stale: age !== null && age > guards_ladder_js_1.GUARDS_STALE_DAYS,
        reported: newest?.kind === 'report' && newest.agrees,
        lastLevelUp: e.levelUps.length > 0 ? e.levelUps[e.levelUps.length - 1] : null,
    };
}
/** memberId → summary for every member with an estimate. */
function getGuardsSummaries(clanId, today) {
    const out = new Map();
    for (const [memberId, e] of getGuardsEstimates(clanId))
        out.set(memberId, summarizeEstimate(e, today));
    return out;
}
/** The clan's make-up for the Analytics overview — active members only. */
function getClanGuardsOverview(clanId, today, recentDays = 30) {
    const db = (0, database_js_1.getDb)();
    const active = db.prepare('SELECT id, name FROM members WHERE clan_id = ? AND is_active = 1').all(clanId);
    const estimates = getGuardsEstimates(clanId);
    const counts = new Map();
    let estimated = 0;
    let stale = 0;
    let lowConfidence = 0;
    const recentLevelUps = [];
    for (const m of active) {
        const e = estimates.get(m.id);
        if (!e)
            continue;
        estimated++;
        counts.set(e.level, (counts.get(e.level) ?? 0) + 1);
        const s = summarizeEstimate(e, today);
        if (s.stale)
            stale++;
        if (e.confidence === 'low')
            lowConfidence++;
        for (const up of e.levelUps) {
            const age = (0, game_day_js_1.daysBetweenGameDates)(up.by, today);
            if (age !== null && age <= recentDays)
                recentLevelUps.push({ ...up, memberId: m.id, name: m.name });
        }
    }
    recentLevelUps.sort((a, b) => (a.by < b.by ? 1 : a.by > b.by ? -1 : a.name.localeCompare(b.name)));
    const distribution = [...counts.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([level, members]) => ({ level, members }));
    return {
        distribution,
        estimated,
        unknown: active.length - estimated,
        stale,
        lowConfidence,
        recentLevelUps,
    };
}
// ─── Admin-entered levels ─────────────────────────────────────
function listGuardsReports(memberId, clanId) {
    const db = (0, database_js_1.getDb)();
    return db.prepare(`
    SELECT r.id, r.member_id AS memberId, r.level, r.observed_date AS observedDate, r.note,
           r.created_by AS createdBy, u.username AS createdByName, r.created_at AS createdAt
    FROM member_guards_reports r
    LEFT JOIN users u ON u.id = r.created_by
    WHERE r.member_id = ? AND r.clan_id = ?
    ORDER BY r.observed_date DESC, r.id DESC
  `).all(memberId, clanId);
}
function addGuardsReport(input) {
    const db = (0, database_js_1.getDb)();
    const result = db.prepare(`
    INSERT INTO member_guards_reports (clan_id, member_id, level, observed_date, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(input.clanId, input.memberId, input.level, input.observedDate, input.note, input.createdBy, new Date().toISOString());
    invalidateGuardsCache(input.clanId);
    return Number(result.lastInsertRowid);
}
/** The deleted report's member, or null when the id isn't this clan's. */
function deleteGuardsReport(id, clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT member_id AS memberId, level FROM member_guards_reports WHERE id = ? AND clan_id = ?').get(id, clanId);
    if (!row)
        return null;
    db.prepare('DELETE FROM member_guards_reports WHERE id = ? AND clan_id = ?').run(id, clanId);
    invalidateGuardsCache(clanId);
    return row;
}
//# sourceMappingURL=guards-repo.js.map