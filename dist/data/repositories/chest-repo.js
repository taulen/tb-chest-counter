"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ANALYTICS_CACHE_TTL_MS = void 0;
exports.invalidateUnknownChestsCount = invalidateUnknownChestsCount;
exports.slugifyChestName = slugifyChestName;
exports.resolveChestName = resolveChestName;
exports.getOrCreateChestId = getOrCreateChestId;
exports.getOrCreateChestSourceId = getOrCreateChestSourceId;
exports.insertChest = insertChest;
exports.getRawPlayerOcrForMember = getRawPlayerOcrForMember;
exports.purgeRawPlayerOcr = purgeRawPlayerOcr;
exports.getRawPlayerOcrCounts = getRawPlayerOcrCounts;
exports.deleteChestsBySession = deleteChestsBySession;
exports.countChestsBySession = countChestsBySession;
exports.getChestsBySession = getChestsBySession;
exports.getChestsByMember = getChestsByMember;
exports.getMemberAggregateInRange = getMemberAggregateInRange;
exports.countChestsByMember = countChestsByMember;
exports.getChests = getChests;
exports.getMemberStats = getMemberStats;
exports.getLeaderboard = getLeaderboard;
exports.getTotalChestCount = getTotalChestCount;
exports.getRecentChests = getRecentChests;
exports.getSingleDayRecords = getSingleDayRecords;
exports.getDailyDigestData = getDailyDigestData;
exports.getMembersByChestName = getMembersByChestName;
exports.getChestHistoryForChestAndMember = getChestHistoryForChestAndMember;
exports.getUnknownChests = getUnknownChests;
exports.countUnknownChests = countUnknownChests;
exports.getDebugCropPathForChest = getDebugCropPathForChest;
exports.reassignChestsToMember = reassignChestsToMember;
exports.clearResolvedManualReviewErrors = clearResolvedManualReviewErrors;
exports.deleteOrphanedEmptyMembers = deleteOrphanedEmptyMembers;
exports.getDistinctChestSources = getDistinctChestSources;
exports.getChestCountsByMember = getChestCountsByMember;
exports.getDistinctChestNames = getDistinctChestNames;
exports.getChestBreakdowns = getChestBreakdowns;
exports.getActivityClock = getActivityClock;
exports.getMemberSourceMix = getMemberSourceMix;
const database_js_1 = require("../database.js");
const clan_reward_chests_js_1 = require("../clan-reward-chests.js");
const chestSummaryRepo = __importStar(require("./chest-summary-repo.js"));
const session_repo_js_1 = require("./session-repo.js");
const review_queue_repo_js_1 = require("./review-queue-repo.js");
const source_points_repo_js_1 = require("./source-points-repo.js");
const source_names_js_1 = require("../../vision/source-names.js");
const logger_js_1 = require("../../utils/logger.js");
const ttl_cache_js_1 = require("../../utils/ttl-cache.js");
const log = (0, logger_js_1.childLogger)('chest-repo');
// Analytics / leaderboard reads are cached per (clan, params) for this window.
// Short enough to still feel live during a scan, long enough to collapse the
// burst of identical requests when several people open the same page at once
// (which is what pins the synchronous event loop). Dropped immediately on
// scan completion and other chest-data mutations via the invalidation hooks.
exports.ANALYTICS_CACHE_TTL_MS = 15000;
// The unknown-chest badge count is read by the polled nav-status endpoint.
// The underlying query is sub-millisecond, but we memoize it per clan for
// consistency with the other nav counts and to shield the event loop under
// contention. Invalidated on scan completion, reassignment, and any
// member-name edit that changes the [Unknown]/blank sentinel set.
const UNKNOWN_CHESTS_COUNT_TTL_MS = 60000;
/** Drop the cached unknown-chests count so the next nav-status read recomputes. */
function invalidateUnknownChestsCount(clanId) {
    (0, ttl_cache_js_1.invalidate)(clanId === undefined ? 'unknownChestsCount:' : `unknownChestsCount:${clanId}`);
}
// ─── captured_at + confidence storage conversions ───
//
// Post-v30 captured_at is stored as INTEGER ms-since-epoch (was a
// 24-char ISO TEXT) and confidence is stored as INTEGER 0–100 (was
// REAL 0.0–1.0). The application surface stays the same — repo
// callers pass / receive ISO strings and 0.0–1.0 floats — and these
// helpers convert at the boundary. Filter args (from / to) get the
// same treatment so `WHERE captured_at >= ?` keeps comparing
// numbers to numbers.
function isoToMs(iso) {
    return Date.parse(iso);
}
function msToIso(ms) {
    return new Date(ms).toISOString();
}
function confFloatToInt(f) {
    return Math.round(f * 100);
}
function confIntToFloat(i) {
    return i / 100;
}
/**
 * Convert an `MIN(captured_at)` / `MAX(captured_at)` SQLite aggregate
 * result back to an ISO string. Returns null for null/0 inputs so
 * callers using the "no rows" sentinel keep working.
 */
function aggMsToIso(value) {
    if (value === null || value === undefined)
        return null;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n))
        return null;
    return msToIso(n);
}
/**
 * Normalize a chest name to a URL-safe slug: lowercase, runs of
 * non-alphanumerics collapsed to `-`, trimmed. Used on both the server
 * (see `resolveChestName`) and client to keep URLs like
 * `#chest/rare-dragon-chest` reversible back to the canonical chest name.
 */
function slugifyChestName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
/**
 * Resolve a chest-name input (either the exact canonical name or a slug)
 * back to the canonical chest_name stored in the DB. Returns the input
 * unchanged if no match is found, so callers always get a usable name
 * to pass to downstream queries that will then return empty results —
 * matching the pre-slug behavior for unknown names.
 *
 * When multiple chest_names collapse to the same slug (rare, but possible
 * if names differ only in punctuation/case), we pick the one with the
 * most records so the drill-down is most useful.
 *
 * Reads from the global `chests` reference table (clan-agnostic) but
 * filters to names actually observed in this clan's chest_records, so
 * a clan can't surface chest names imported by a different clan.
 */
function resolveChestName(input, clanId) {
    const trimmed = input.trim();
    if (!trimmed)
        return trimmed;
    const db = (0, database_js_1.getDb)();
    const exact = db.prepare(`SELECT 1 FROM chest_records_v WHERE clan_id = ? AND chest_name = ? LIMIT 1`).get(clanId, trimmed);
    if (exact)
        return trimmed;
    const targetSlug = slugifyChestName(trimmed);
    if (!targetSlug)
        return trimmed;
    const candidate = db.prepare(`
    SELECT chest_name, COUNT(*) AS cnt
    FROM chest_records_v
    WHERE clan_id = ?
    GROUP BY chest_name
    ORDER BY cnt DESC
  `).all(clanId);
    for (const row of candidate) {
        if (slugifyChestName(row.chest_name) === targetSlug) {
            return row.chest_name;
        }
    }
    return trimmed;
}
function rowToChest(row) {
    return {
        id: row.id,
        sessionId: row.session_id,
        playerName: row.player_name,
        memberId: row.member_id || null,
        chestName: row.chest_name,
        chestType: row.chest_type,
        chestSource: row.chest_source || '',
        pointValue: row.point_value,
        capturedAt: msToIso(row.captured_at),
        effectiveAt: msToIso((row.effective_at ?? row.captured_at)),
        confidence: confIntToFloat(row.confidence),
    };
}
/**
 * Upsert a chest into the `chests` reference table and return its id.
 * Hot path during scans — gets called once per inserted chest.
 *
 * On the first time a chest is observed, `chest_type` is set from
 * `defaultType` (the OCR-detected rarity for that scan). Subsequent
 * observations leave `chest_type` alone — the admin's
 * `setChestType` override stays sticky and a single bad OCR rarity
 * read on a later scan can't quietly flip the canonical value.
 */
function getOrCreateChestId(name, defaultType) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`
    INSERT INTO chests (name, chest_type) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET name = excluded.name
    RETURNING id
  `).get(name, defaultType);
    return row.id;
}
/** Same as getOrCreateChestId for the chest_sources reference table.
 *  Returns null for empty source strings — chest_records.chest_source_id
 *  is nullable for that case. */
function getOrCreateChestSourceId(source) {
    if (!source)
        return null;
    const db = (0, database_js_1.getDb)();
    // Fast path: exact match / existing row.
    const exact = db.prepare('SELECT id FROM chest_sources WHERE source = ?').get(source);
    if (exact)
        return exact.id;
    // No exact row. Before minting a new one, reuse an existing source that is
    // the SAME source spelled differently — PaddleOCR drops inter-word spaces
    // ("Level10rareCrypt") that Tesseract/history kept ("Level 10 rare Crypt"),
    // reads the same accent both ways ("Jörmungandr Shop" / "Jormungandr Shop"),
    // and abbreviates Level as Lvl — and all of those must resolve to one
    // chest_sources row so scoring, aggregates and the admin Source Points UI
    // don't split into duplicates. Prefer the variant with the most existing
    // records (the dominant historical spelling). This scan only runs for
    // genuinely-new source strings (rare), over a tiny table.
    //
    // sourceSpellingKey, not canonicalSourceKey: this is a row-identity question,
    // not a scoring one, so it can fold Lvl/Level too. That also stops migration
    // v63 from undoing itself — once it deletes a duplicate spelling, the next
    // scan reading that spelling misses the exact fast path above and lands here.
    const canon = (0, source_names_js_1.sourceSpellingKey)(source);
    if (canon) {
        const candidates = db.prepare('SELECT id, source FROM chest_sources').all();
        let bestId = null;
        let bestCnt = -1;
        for (const c of candidates) {
            if ((0, source_names_js_1.sourceSpellingKey)(c.source) !== canon)
                continue;
            const cnt = db.prepare('SELECT COUNT(*) AS n FROM chest_records WHERE chest_source_id = ?').get(c.id).n;
            if (cnt > bestCnt) {
                bestCnt = cnt;
                bestId = c.id;
            }
        }
        if (bestId !== null)
            return bestId;
    }
    // Genuinely new source type — insert it.
    const row = db.prepare(`
    INSERT INTO chest_sources (source) VALUES (?)
    ON CONFLICT(source) DO UPDATE SET source = excluded.source
    RETURNING id
  `).get(source);
    return row.id;
}
function insertChest(chest) {
    const db = (0, database_js_1.getDb)();
    if (chest.memberId === null || chest.memberId === undefined) {
        throw new Error('insertChest: memberId is required (post-D4 schema enforces NOT NULL)');
    }
    const chestId = getOrCreateChestId(chest.chestName, chest.chestType);
    const chestSourceId = getOrCreateChestSourceId(chest.chestSource);
    try {
        const result = db.prepare(`
      INSERT INTO chest_records
        (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence, debug_crop_path, raw_player_ocr, earned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(chest.clanId, chest.sessionId, chest.memberId, chestId, chestSourceId, chest.pointValue, isoToMs(chest.capturedAt), confFloatToInt(chest.confidence), chest.debugCropPath ?? null, chest.rawPlayerOcr ?? null, chest.earnedAt ?? null);
        return { id: result.lastInsertRowid, ...chest };
    }
    catch (err) {
        // UNIQUE constraint violation = duplicate. The caller distinguishes
        // dedup-skip (null return) from success (row id) via the truthy check
        // on the return value, so the aggregate `chestsFound − newChests` gap
        // is already visible. Log per-collision details at debug so an
        // operator investigating "why is this row missing" can trace which
        // key collided without re-deriving from the OCR text.
        if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
            log.debug(`insertChest UNIQUE skip: session=${chest.sessionId} player="${chest.playerName}" chest="${chest.chestName}" source="${chest.chestSource}" capturedAt=${chest.capturedAt}`);
            return null;
        }
        throw err;
    }
}
/**
 * Forensic helpers for the toggleable raw-OCR capture feature.
 *
 * `getRawPlayerOcrForMember` returns the last N raw OCR strings ever
 * resolved to a given member (with the timestamp), used by the member-
 * detail page to surface the strings that landed there.
 *
 * `purgeRawPlayerOcr` runs an UPDATE setting the column to NULL on every
 * row that has one; invoked by the System-page toggle when the operator
 * disables capture so the TEXT column doesn't keep eating space.
 */
function getRawPlayerOcrForMember(memberId, clanId, limit) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare(`SELECT raw_player_ocr AS rawPlayerOcr, captured_at AS capturedAt, session_id AS sessionId
     FROM chest_records
     WHERE member_id = ? AND clan_id = ? AND raw_player_ocr IS NOT NULL
     ORDER BY captured_at DESC LIMIT ?`).all(memberId, clanId, limit);
    return rows;
}
function purgeRawPlayerOcr() {
    const db = (0, database_js_1.getDb)();
    const a = db.prepare('UPDATE chest_records SET raw_player_ocr = NULL WHERE raw_player_ocr IS NOT NULL').run();
    const b = db.prepare('UPDATE triumphal_chest_records SET raw_player_ocr = NULL WHERE raw_player_ocr IS NOT NULL').run();
    return { chestRecords: a.changes, triumphalChestRecords: b.changes };
}
/** Count of rows currently carrying a captured raw OCR value. Surfaced
 *  on the System-page toggle so the operator knows how much data is
 *  about to be purged when they disable the feature. */
function getRawPlayerOcrCounts() {
    const db = (0, database_js_1.getDb)();
    const a = db.prepare('SELECT COUNT(*) AS c FROM chest_records WHERE raw_player_ocr IS NOT NULL').get();
    const b = db.prepare('SELECT COUNT(*) AS c FROM triumphal_chest_records WHERE raw_player_ocr IS NOT NULL').get();
    return { chestRecords: a.c, triumphalChestRecords: b.c };
}
/**
 * Delete all chest records for a given scan session.
 * Used to roll back a failed scan so no partial data remains.
 */
function deleteChestsBySession(sessionId, clanId) {
    const db = (0, database_js_1.getDb)();
    const result = db.prepare('DELETE FROM chest_records WHERE session_id = ? AND clan_id = ?').run(sessionId, clanId);
    if (result.changes > 0)
        chestSummaryRepo.notifyChestDataChanged(clanId);
    return result.changes;
}
/**
 * How many chest rows this session has actually landed.
 *
 * The scan writes each chest the moment its card is clicked, so the only
 * trustworthy answer to "did we save anything before it died?" is this
 * count — an in-memory tally is lost with the stack that threw. See
 * scheduler/scan-finalize.ts, which decides keep-or-roll-back from it.
 */
function countChestsBySession(sessionId, clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT COUNT(*) AS c FROM chest_records WHERE session_id = ? AND clan_id = ?').get(sessionId, clanId);
    return row.c;
}
function getChestsBySession(sessionId, clanId) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare('SELECT * FROM chest_records_v WHERE session_id = ? AND clan_id = ? ORDER BY captured_at DESC').all(sessionId, clanId);
    return rows.map(rowToChest);
}
function getChestsByMember(memberId, clanId, from, to, limit, offset) {
    const db = (0, database_js_1.getDb)();
    let query = 'SELECT * FROM chest_records_v WHERE member_id = ? AND clan_id = ?';
    const params = [memberId, clanId];
    if (from) {
        query += ' AND effective_at >= ?';
        params.push(isoToMs(from));
    }
    if (to) {
        query += ' AND effective_at < ?';
        params.push(isoToMs(to));
    }
    query += ' ORDER BY captured_at DESC';
    if (typeof limit === 'number' && limit > 0) {
        query += ' LIMIT ?';
        params.push(limit);
        if (typeof offset === 'number' && offset > 0) {
            query += ' OFFSET ?';
            params.push(offset);
        }
    }
    const rows = db.prepare(query).all(...params);
    return rows.map(rowToChest);
}
/**
 * Aggregate chest count and total point value for a member within a date
 * range. Used to compute "this week vs last week" and similar progress
 * stats on the member detail page.
 */
function getMemberAggregateInRange(memberId, clanId, from, to) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`
    SELECT COUNT(*) as chests,
           COALESCE(SUM(point_value), 0) as points
    FROM chest_records
    WHERE member_id = ?
      AND clan_id = ?
      AND effective_at >= ?
      AND effective_at < ?
  `).get(memberId, clanId, isoToMs(from), isoToMs(to));
    return { chests: row.chests || 0, points: row.points || 0 };
}
function countChestsByMember(memberId, clanId, from, to) {
    const db = (0, database_js_1.getDb)();
    let query = 'SELECT COUNT(*) as count FROM chest_records WHERE member_id = ? AND clan_id = ?';
    const params = [memberId, clanId];
    if (from) {
        query += ' AND effective_at >= ?';
        params.push(isoToMs(from));
    }
    if (to) {
        query += ' AND effective_at < ?';
        params.push(isoToMs(to));
    }
    const row = db.prepare(query).get(...params);
    return row.count;
}
function getChests(filters) {
    const db = (0, database_js_1.getDb)();
    const conditions = ['clan_id = ?'];
    const params = [filters.clanId];
    if (filters.from) {
        conditions.push('effective_at >= ?');
        params.push(isoToMs(filters.from));
    }
    if (filters.to) {
        conditions.push('effective_at < ?');
        params.push(isoToMs(filters.to));
    }
    if (filters.memberId) {
        conditions.push('member_id = ?');
        params.push(filters.memberId);
    }
    if (filters.chestType) {
        conditions.push('chest_type = ?');
        params.push(filters.chestType);
    }
    let query = 'SELECT * FROM chest_records_v WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY captured_at DESC';
    if (filters.limit) {
        query += ' LIMIT ?';
        params.push(filters.limit);
    }
    if (filters.offset) {
        query += ' OFFSET ?';
        params.push(filters.offset);
    }
    const rows = db.prepare(query).all(...params);
    return rows.map(rowToChest);
}
function getMemberStats(memberId, clanId, from, to) {
    const db = (0, database_js_1.getDb)();
    const member = db.prepare('SELECT * FROM members WHERE id = ? AND clan_id = ?').get(memberId, clanId);
    if (!member)
        return null;
    // chest_type lives on chests post-D4; use the view so the per-type
    // breakdown still groups by rarity without a manual JOIN.
    let query = 'SELECT chest_type, COUNT(*) as total, SUM(point_value) as points FROM chest_records_v WHERE member_id = ? AND clan_id = ?';
    const params = [memberId, clanId];
    if (from) {
        query += ' AND effective_at >= ?';
        params.push(isoToMs(from));
    }
    if (to) {
        query += ' AND effective_at < ?';
        params.push(isoToMs(to));
    }
    query += ' GROUP BY chest_type';
    const rows = db.prepare(query).all(...params);
    const chestsByType = {};
    let totalChests = 0;
    let totalPoints = 0;
    for (const row of rows) {
        chestsByType[row.chest_type] = row.total;
        totalChests += row.total;
        totalPoints += row.points;
    }
    return {
        memberId,
        memberName: member.name,
        totalChests,
        totalPoints,
        chestsByType,
        lastSeen: member.last_seen,
    };
}
/**
 * Leaderboard for a clan and optional [from, to] window. Cached per distinct
 * (clan, window, options) key for ANALYTICS_CACHE_TTL_MS: this is the hottest
 * page and many clients poll the same window, so caching collapses concurrent
 * identical requests into a single aggregate scan instead of one per request.
 * The cache is dropped on scan completion (and other chest-data mutations) so
 * numbers stay fresh. See computeLeaderboard for the actual query.
 */
function getLeaderboard(clanId, from, to, options = {}) {
    const { limit, includeAllMembers = false } = options;
    const key = `leaderboard:${clanId}:${from ?? ''}:${to ?? ''}:${includeAllMembers ? 1 : 0}:${limit ?? ''}`;
    return (0, ttl_cache_js_1.cached)(key, exports.ANALYTICS_CACHE_TTL_MS, () => computeLeaderboard(clanId, from, to, options));
}
function computeLeaderboard(clanId, from, to, options = {}) {
    const db = (0, database_js_1.getDb)();
    const { limit, includeAllMembers = false } = options;
    const aggConditions = ['clan_id = ?'];
    const aggParams = [clanId];
    if (from) {
        aggConditions.push('effective_at >= ?');
        aggParams.push(isoToMs(from));
    }
    if (to) {
        aggConditions.push('effective_at < ?');
        aggParams.push(isoToMs(to));
    }
    // End-of-event clan rewards are the clan's prize, handed to one account in a
    // single drop, so they don't belong in a ranking of members against each
    // other — see src/data/clan-reward-chests.ts. This is also what keeps a
    // member's rank badge agreeing with the board it came from (both go through
    // this function).
    //
    // Costs the covering index: chest_id is in none of the chest_records
    // covering indexes, so SQLite fetches the row. Measured on the 185k-record
    // production backup: all-time 27ms → 90ms, windowed 69ms → 101ms. Both sit
    // behind the 15s analytics TTL, and recovering index-only coverage would mean
    // a fifth index on the hot insert path for 60ms — not worth it.
    const aggWhere = `WHERE ${aggConditions.join(' AND ')}${(0, clan_reward_chests_js_1.clanRewardExclusionSql)()} `;
    const aggSql = `
    SELECT member_id,
           COUNT(*) AS chests,
           SUM(point_value) AS points
    FROM chest_records
    ${aggWhere}
    GROUP BY member_id
  `;
    let query;
    const params = [];
    if (includeAllMembers) {
        query = `
      SELECT m.id AS member_id,
             m.name AS member_name,
             COALESCE(agg.chests, 0) AS total_chests,
             COALESCE(agg.points, 0) AS total_points
      FROM members m
      LEFT JOIN (${aggSql}) agg ON agg.member_id = m.id
      WHERE m.clan_id = ? AND m.is_active = 1
      GROUP BY m.id, m.name
      ORDER BY total_points DESC, total_chests DESC, LOWER(m.name) ASC
    `;
        params.push(...aggParams, clanId);
    }
    else {
        query = `
      SELECT m.id AS member_id,
             m.name AS member_name,
             agg.chests AS total_chests,
             agg.points AS total_points
      FROM (${aggSql}) agg
      JOIN members m ON m.id = agg.member_id
      WHERE m.clan_id = ?
      ORDER BY total_points DESC, total_chests DESC, LOWER(m.name) ASC
    `;
        params.push(...aggParams, clanId);
    }
    if (typeof limit === 'number') {
        query += ' LIMIT ?';
        params.push(limit);
    }
    log.debug(`Leaderboard query: clan=${clanId} from=${from || 'none'} to=${to || 'none'} includeAll=${includeAllMembers}`);
    const rows = db.prepare(query).all(...params);
    return rows.map((row, index) => ({
        rank: index + 1,
        memberId: row.member_id,
        memberName: row.member_name,
        totalChests: row.total_chests,
        totalPoints: row.total_points,
    }));
}
function getTotalChestCount(clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT COUNT(*) as total FROM chest_records WHERE clan_id = ?').get(clanId);
    return row.total ?? 0;
}
function getRecentChests(clanId, limit = 10) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare('SELECT * FROM chest_records_v WHERE clan_id = ? ORDER BY captured_at DESC LIMIT ?').all(clanId, limit);
    return rows.map(rowToChest);
}
/**
 * Compute the clan's top 3 single-day performances by chest count and
 * by points, with one entry per member (their personal best day only).
 *
 * `rolloverUtcHour` is the game's fixed UTC hour at which the in-game
 * day boundary resets. Shifting the stored UTC timestamp back by that
 * many hours before feeding it to SQLite's DATE() gives us buckets that
 * align to game days — e.g. with rolloverUtcHour=17, a chest at
 * 2026-04-09T18:30Z is counted as game-day 2026-04-09, while one at
 * 2026-04-09T16:30Z is still game-day 2026-04-08 because the game's
 * day-09 hasn't started yet. Without this, evening play in Europe
 * gets split across two UTC calendar days.
 *
 * Two CTEs: first aggregate chests by (member, game-day), then pick
 * each member's best day. That inner pick is what makes "three
 * different members" — without it a single member having three great
 * days in a row would dominate the podium.
 */
function getSingleDayRecords(rolloverUtcHour, clanId) {
    // Served from the chest_daily_summary rollup: the per-(member, game-day)
    // buckets are already materialized, so this no longer scans the full history
    // or runs DATE() per row. The rollup reads the rollover hour from config
    // itself; rolloverUtcHour is retained in the signature for the caller. Still
    // cached to collapse repeat reads within the TTL window.
    void rolloverUtcHour;
    return (0, ttl_cache_js_1.cached)(`singleDay:${clanId}:${rolloverUtcHour}`, exports.ANALYTICS_CACHE_TTL_MS, () => chestSummaryRepo.getSingleDayRecords(clanId));
}
/**
 * Aggregated stats for a fixed time window, used by the Discord daily
 * digest. Returns the headline counters (chests / points / unique
 * players / scans) plus per-member rows ordered for a leaderboard
 * display. Excludes import sessions from the scan count so the digest
 * only reflects real game activity.
 *
 * Also excludes end-of-event clan rewards, and the headline counters follow —
 * they are summed from the same rows. That is deliberate: the digest prints its
 * totals one line above the per-member table, so the two must be on the same
 * basis or the published post contradicts itself.
 */
function getDailyDigestData(fromIso, toIso, clanId) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare(`
    SELECT
      c.member_id AS memberId,
      m.name AS memberName,
      COUNT(*) AS chests,
      SUM(c.point_value) AS points
    FROM chest_records c
    JOIN members m ON m.id = c.member_id AND m.clan_id = c.clan_id
    WHERE c.clan_id = ? AND c.effective_at >= ? AND c.effective_at < ?
      ${(0, clan_reward_chests_js_1.clanRewardExclusionSql)('c.')}
    GROUP BY c.member_id, m.name
    ORDER BY points DESC, chests DESC, LOWER(memberName) ASC
  `).all(clanId, isoToMs(fromIso), isoToMs(toIso));
    let totalChests = 0;
    let totalPoints = 0;
    for (const row of rows) {
        totalChests += row.chests;
        totalPoints += row.points;
    }
    const scanRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM scan_sessions
    WHERE clan_id = ?
      AND status = 'completed'
      AND trigger_source <> 'import'
      AND completed_at IS NOT NULL
      AND completed_at >= ? AND completed_at < ?
  `).get(clanId, fromIso, toIso);
    return {
        totalChests,
        totalPoints,
        activePlayers: rows.length,
        scanCount: scanRow.cnt,
        topContributors: rows,
    };
}
/**
 * For a given chest name (e.g. "Rare Dragon Chest"), return the per-member
 * tally of how many of that chest each member has collected, plus a bunch
 * of headline stats for the drill-down page header (total, unique
 * collectors, first/last seen, avg points per chest).
 */
function getMembersByChestName(chestName, clanId, from, to) {
    const db = (0, database_js_1.getDb)();
    // Resolve the chest name to its FK once. Skipping the view and
    // filtering chest_records on the indexed chest_id is dramatically
    // faster than going through chest_records_v (which JOINs members +
    // chests + chest_sources for every scanned row).
    const chestRow = db.prepare('SELECT id, chest_type FROM chests WHERE name = ?').get(chestName);
    if (!chestRow) {
        return {
            chestName,
            chestType: null,
            totalCount: 0,
            totalPoints: 0,
            uniqueCollectors: 0,
            avgPerCollector: 0,
            avgPointsPerChest: 0,
            firstSeen: null,
            lastSeen: null,
            members: [],
        };
    }
    const dateConditions = ['clan_id = ?', 'chest_id = ?'];
    const dateParams = [clanId, chestRow.id];
    if (from) {
        dateConditions.push('effective_at >= ?');
        dateParams.push(isoToMs(from));
    }
    if (to) {
        dateConditions.push('effective_at < ?');
        dateParams.push(isoToMs(to));
    }
    const where = `WHERE ${dateConditions.join(' AND ')}`;
    const aliasedWhere = where
        .replace(/\beffective_at\b/g, 'c.effective_at')
        .replace(/\bclan_id\b/g, 'c.clan_id')
        .replace(/\bchest_id\b/g, 'c.chest_id');
    const rawRows = db.prepare(`
    SELECT
      c.member_id AS memberId,
      m.name AS memberName,
      COUNT(*) AS count,
      SUM(c.point_value) AS points,
      MAX(c.effective_at) AS lastSeen
    FROM chest_records c
    JOIN members m ON m.id = c.member_id AND m.clan_id = c.clan_id
    ${aliasedWhere}
    GROUP BY c.member_id, m.name
    ORDER BY points DESC, count DESC, LOWER(memberName) ASC
  `).all(...dateParams);
    // captured_at is INTEGER ms post-v30; convert MAX() back to ISO so
    // the public response shape stays string-typed.
    const rows = rawRows.map((r) => ({
        memberId: r.memberId,
        memberName: r.memberName,
        count: r.count,
        points: r.points,
        lastSeen: aggMsToIso(r.lastSeen),
    }));
    const rawSeen = db.prepare(`
    SELECT MIN(effective_at) as firstSeen, MAX(effective_at) as lastSeen
    FROM chest_records
    ${where}
  `).get(...dateParams);
    const seenRow = {
        firstSeen: aggMsToIso(rawSeen?.firstSeen),
        lastSeen: aggMsToIso(rawSeen?.lastSeen),
    };
    let totalCount = 0;
    let totalPoints = 0;
    for (const row of rows) {
        totalCount += row.count;
        totalPoints += row.points;
    }
    const uniqueCollectors = rows.length;
    const avgPerCollector = uniqueCollectors > 0 ? totalCount / uniqueCollectors : 0;
    const avgPointsPerChest = totalCount > 0 ? totalPoints / totalCount : 0;
    return {
        chestName,
        chestType: chestRow.chest_type,
        totalCount,
        totalPoints,
        uniqueCollectors,
        avgPerCollector: Math.round(avgPerCollector * 10) / 10,
        avgPointsPerChest: Math.round(avgPointsPerChest * 10) / 10,
        firstSeen: seenRow?.firstSeen ?? null,
        lastSeen: seenRow?.lastSeen ?? null,
        members: rows,
    };
}
/**
 * Per-member chest history for the chest-detail drill-down: every
 * individual record of `chestName` for `memberId` (or, when memberId is
 * null, every unassigned row matching `playerName`) within the period.
 * Powers the collapsible row on the chest detail page.
 */
function getChestHistoryForChestAndMember(chestName, memberId, playerName, clanId, from, to) {
    const db = (0, database_js_1.getDb)();
    const params = [chestName, clanId];
    let query = `
    SELECT id, captured_at, effective_at, chest_source, chest_type, quantity, point_value
    FROM chest_records_v
    WHERE chest_name = ? AND clan_id = ?
  `;
    if (memberId !== null) {
        query += ' AND member_id = ?';
        params.push(memberId);
    }
    else {
        query += ' AND member_id IS NULL AND player_name = ?';
        params.push(playerName ?? '');
    }
    if (from) {
        query += ' AND effective_at >= ?';
        params.push(isoToMs(from));
    }
    if (to) {
        query += ' AND effective_at < ?';
        params.push(isoToMs(to));
    }
    query += ' ORDER BY captured_at DESC';
    const rows = db.prepare(query).all(...params);
    return rows.map((r) => ({
        id: r.id,
        capturedAt: msToIso(r.captured_at),
        effectiveAt: msToIso((r.effective_at ?? r.captured_at)),
        chestSource: r.chest_source || '',
        chestType: r.chest_type || '',
        quantity: r.quantity,
        pointValue: r.point_value,
    }));
}
/**
 * Returns every chest record that needs manual player-name attribution:
 * rows where OCR failed to read the name, so the row was saved with an
 * empty/null player_name (legacy pre-fix data) or under the "[Unknown]"
 * sentinel (post-fix). Used by the admin "Needs Review" section.
 */
function getUnknownChests(clanId) {
    const db = (0, database_js_1.getDb)();
    // Push the sentinel predicate onto the members table and match by
    // member_id (uses idx_chest_records_clan_member). member_id is NOT NULL
    // and always joins, so this is equivalent to the old player_name TRIM/
    // LOWER scan over the view but lets the chest_records side stay indexed.
    const rows = db.prepare(`
    SELECT id, session_id, captured_at, effective_at, chest_name, chest_source, chest_type,
           quantity, point_value, member_id, player_name, debug_crop_path
    FROM chest_records_v
    WHERE clan_id = ?
      AND member_id IN (
        SELECT id FROM members
        WHERE clan_id = ?
          AND (name IS NULL OR name = '' OR TRIM(name) = ''
               OR name = '[Unknown]' OR LOWER(TRIM(name)) = 'inactive player')
      )
    ORDER BY session_id DESC, captured_at DESC
  `).all(clanId, clanId);
    return rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        capturedAt: msToIso(r.captured_at),
        effectiveAt: msToIso((r.effective_at ?? r.captured_at)),
        chestName: r.chest_name,
        chestSource: r.chest_source || '',
        chestType: r.chest_type,
        quantity: r.quantity,
        pointValue: r.point_value,
        memberId: r.member_id ?? null,
        playerName: r.player_name ?? '',
        hasCrop: Boolean(r.debug_crop_path),
    }));
}
/**
 * Count-only variant of getUnknownChests — same sentinel predicate, but
 * over the base chest_records table (no view join needed for a count).
 * Backs the nav-status unknown-chest dot (GET /api/admin/nav-status) so the
 * badge never materializes the full list. Memoized per clan with explicit
 * invalidation on scan completion, reassignment, and member-name edits.
 */
function countUnknownChests(clanId) {
    return (0, ttl_cache_js_1.cached)(`unknownChestsCount:${clanId}`, UNKNOWN_CHESTS_COUNT_TTL_MS, () => computeUnknownChestsCount(clanId));
}
function computeUnknownChestsCount(clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM chest_records
    WHERE clan_id = ?
      AND member_id IN (
        SELECT id FROM members
        WHERE clan_id = ?
          AND (name IS NULL OR name = '' OR TRIM(name) = ''
               OR name = '[Unknown]' OR LOWER(TRIM(name)) = 'inactive player')
      )
  `).get(clanId, clanId);
    return row.cnt;
}
/**
 * Lookup the saved debug-crop path for a single chest. Returned by the
 * admin crop-image endpoint so the operator can hover a row and see the
 * screenshot that produced it. Scoped to the active clan so admins in
 * clan A can't enumerate clan B's crops by guessing chest IDs.
 */
function getDebugCropPathForChest(chestId, clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT debug_crop_path FROM chest_records WHERE id = ? AND clan_id = ?').get(chestId, clanId);
    return row?.debug_crop_path ?? null;
}
/**
 * Reassign a set of specific chest rows to a member. Updates member_id
 * only — post-D4 the chest_records table no longer carries a denormalized
 * player_name column, so the new member's name is reflected automatically
 * on the next read via the JOIN to members. The toMemberName argument
 * stays in the signature for callers that still pass it (it's ignored).
 */
function reassignChestsToMember(chestIds, toMemberId, _toMemberName, clanId) {
    if (chestIds.length === 0)
        return 0;
    const db = (0, database_js_1.getDb)();
    const placeholders = chestIds.map(() => '?').join(',');
    const result = db.prepare(`UPDATE chest_records
        SET member_id = ?
      WHERE clan_id = ?
        AND id IN (${placeholders})`).run(toMemberId, clanId, ...chestIds);
    // Reassigning chests changes per-member totals the dashboard surfaces, so
    // drop the cached scan stats for this clan. It also moves rows off the
    // [Unknown] sentinel member and can change which chest names/sources are
    // still in the review queue, so drop those nav/summary caches too.
    (0, session_repo_js_1.invalidateScanStats)(clanId);
    invalidateUnknownChestsCount(clanId);
    (0, review_queue_repo_js_1.invalidateReviewQueueCount)(clanId);
    (0, source_points_repo_js_1.invalidateSourceKeySummary)();
    // Moving chests between members changes the per-(member, day) rollup.
    chestSummaryRepo.notifyChestDataChanged(clanId);
    return result.changes;
}
/**
 * Clear the "Manual review needed" error banner from every scan session
 * in this clan that no longer has any unreadable-name rows. Post-D4 the
 * sentinel is detected via the member.name JOIN — every chest record
 * points at a real member row, and "[Unknown]" rows point at the
 * synthetic [Unknown] member.
 */
function clearResolvedManualReviewErrors(clanId) {
    const db = (0, database_js_1.getDb)();
    const result = db.prepare(`
    UPDATE scan_sessions
       SET error_message = NULL, error_phase = NULL
     WHERE clan_id = ?
       AND error_phase = 'Manual review needed'
       AND id NOT IN (
         SELECT DISTINCT cr.session_id
         FROM chest_records cr
         JOIN members m ON m.id = cr.member_id
         WHERE cr.clan_id = ?
           AND (m.name = '[Unknown]'
                OR m.name = ''
                OR TRIM(m.name) = ''
                OR LOWER(TRIM(m.name)) = 'inactive player')
       )
  `).run(clanId, clanId);
    return result.changes;
}
/**
 * Delete phantom empty-name members in this clan that no longer have any
 * data pointing at them.
 *
 * "Orphaned" has to mean orphaned in EVERY table that FKs members(id), not
 * just chest_records — a blank member still referenced by a triumphal row or
 * a resource transaction would otherwise blow up the DELETE with "FOREIGN KEY
 * constraint failed" and take the whole cleanup down with it. member_snapshots
 * is the exception: level/power samples for a nameless phantom are worthless
 * on their own, so they're dropped with it rather than keeping it alive
 * forever (same call the player merge makes for its source member).
 */
function deleteOrphanedEmptyMembers(clanId) {
    const db = (0, database_js_1.getDb)();
    const isBlank = "(name IS NULL OR name = '' OR TRIM(name) = '')";
    const unreferenced = `
        AND NOT EXISTS (SELECT 1 FROM chest_records r WHERE r.member_id = members.id)
        AND NOT EXISTS (SELECT 1 FROM triumphal_chest_records t WHERE t.member_id = members.id)
        AND NOT EXISTS (SELECT 1 FROM resource_transactions x WHERE x.member_id = members.id)`;
    const tx = db.transaction(() => {
        db.prepare(`
      DELETE FROM member_snapshots
      WHERE member_id IN (
        SELECT id FROM members WHERE clan_id = ? AND ${isBlank} ${unreferenced}
      )
    `).run(clanId);
        return db.prepare(`
      DELETE FROM members
      WHERE clan_id = ? AND ${isBlank} ${unreferenced}
    `).run(clanId);
    });
    const result = tx();
    // Removing blank-name members shrinks both the review-queue member list and
    // the unknown-chest sentinel set, so refresh those nav badges.
    if (result.changes > 0) {
        (0, review_queue_repo_js_1.invalidateReviewQueueCount)(clanId);
        invalidateUnknownChestsCount(clanId);
    }
    return result.changes;
}
/**
 * Returns every distinct chest source string with the row count.
 */
function getDistinctChestSources(clanId) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare(`
    SELECT cs.source AS chest_source, g.cnt
    FROM (
      SELECT chest_source_id, COUNT(*) AS cnt
      FROM chest_records
      WHERE clan_id = ? AND chest_source_id IS NOT NULL
      GROUP BY chest_source_id
    ) g
    JOIN chest_sources cs ON cs.id = g.chest_source_id
    WHERE cs.source != ''
    ORDER BY cs.source COLLATE NOCASE
  `).all(clanId);
    return rows.map((r) => ({ source: r.chest_source, count: r.cnt }));
}
/**
 * Chest-record counts per member for one clan, keyed by member id.
 *
 * Feeds the Admin page's merge / reassign dropdowns. A member name carrying a
 * handful of records next to one carrying thousands is almost always an OCR
 * misread of that same player, and the count is the only thing that makes the
 * two distinguishable in a flat alphabetical list. Members with no records at
 * all are absent from the map — callers should default to 0.
 */
function getChestCountsByMember(clanId) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare(`
    SELECT member_id, COUNT(*) AS cnt
    FROM chest_records
    WHERE clan_id = ?
    GROUP BY member_id
  `).all(clanId);
    const counts = {};
    for (const r of rows)
        counts[r.member_id] = r.cnt;
    return counts;
}
/**
 * Returns one row per distinct chest_name with its most recent chest_type
 * and how many chest_records have that name.
 */
function getDistinctChestNames(clanId) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare(`
    SELECT ch.name AS chest_name, ch.chest_type, g.cnt
    FROM (
      SELECT chest_id, COUNT(*) AS cnt
      FROM chest_records
      WHERE clan_id = ?
      GROUP BY chest_id
    ) g
    JOIN chests ch ON ch.id = g.chest_id
    ORDER BY ch.name COLLATE NOCASE
  `).all(clanId);
    return rows.map((r) => ({ name: r.chest_name, currentType: r.chest_type, count: r.cnt }));
}
/**
 * The three "chests grouped by a dimension" aggregates behind the Analytics
 * page, over an earn-time window or all time.
 *
 * These used to be inline in the /analytics/summary route with no window at
 * all. The window is the whole point of moving them: an all-time GROUP BY on a
 * clan with 185k records answers "what have we ever collected", which is not a
 * question anyone has.
 *
 * Windows are half-open [from, to) to match computeGameWindow and
 * getMemberAggregateInRange; `<=` would count a boundary-millisecond row in two
 * adjacent periods.
 *
 * Two things here are load-bearing and were measured with EXPLAIN QUERY PLAN
 * against a seeded 18k-row database, not assumed:
 *
 * 1. byType is DERIVED from byName rather than queried. Grouping by
 *    `ch.chest_type` reads a column on the joined table, so with an
 *    effective_at predicate SQLite gives up on chest_records' indexes entirely
 *    and does `SCAN cr` — a full pass over every row in the clan. Grouping by
 *    `cr.chest_id` keeps idx_cr_clan_chest_pts, and byName is already exactly
 *    that grouping with chest_type attached, so folding it up in JS costs one
 *    pass over ~75 rows and removes a query. It also makes the two physically
 *    incapable of disagreeing, which two independent GROUP BYs were not.
 *    (All-time byType did NOT have this problem — it plans as `SCAN ch` over
 *    the ~75 chests with a covering lookup per chest — but there is no reason
 *    to keep a second query for the case that happened to be fine.)
 *
 * 2. The windowed and all-time forms differ only by the added predicate; the
 *    planner keeps idx_cr_clan_chest_pts / idx_cr_clan_source_pts either way
 *    and simply stops being COVERING once it has to fetch effective_at off the
 *    row. That is the trade being accepted here, and it is much cheaper than
 *    the range-scan-the-effective_at-index plan you might expect it to pick.
 *    tests/data/query-guards.test.ts pins both.
 */
function getChestBreakdowns(clanId, fromMs, toMs) {
    const db = (0, database_js_1.getDb)();
    const windowed = Number.isFinite(fromMs) && Number.isFinite(toMs);
    const range = windowed ? ' AND cr.effective_at >= ? AND cr.effective_at < ?' : '';
    const params = windowed ? [clanId, fromMs, toMs] : [clanId];
    const bySource = db.prepare(`
    SELECT COALESCE(cs.source, '') AS chest_source,
           COUNT(*) AS count,
           SUM(cr.point_value) AS points
    FROM chest_records cr
    LEFT JOIN chest_sources cs ON cs.id = cr.chest_source_id
    WHERE cr.clan_id = ?${range}
    GROUP BY cr.chest_source_id
    ORDER BY count DESC
  `).all(...params);
    const byName = db.prepare(`
    SELECT ch.name AS chest_name,
           ch.chest_type AS chest_type,
           COUNT(*) AS count,
           SUM(cr.point_value) AS points
    FROM chest_records cr
    JOIN chests ch ON ch.id = cr.chest_id
    WHERE cr.clan_id = ?${range}
    GROUP BY cr.chest_id
    ORDER BY count DESC
  `).all(...params);
    // Fold byName up to rarity. See note 1 above for why this is not its own
    // query. Map preserves first-seen order, and byName is already count-desc,
    // so the busiest rarity leads without a second sort.
    const typeTotals = new Map();
    for (const row of byName) {
        const key = row.chest_type ?? 'unknown';
        const hit = typeTotals.get(key);
        if (hit) {
            hit.count += row.count;
            hit.points += row.points;
        }
        else {
            typeTotals.set(key, { chest_type: key, count: row.count, points: row.points });
        }
    }
    const byType = [...typeTotals.values()].sort((a, b) => b.count - a.count);
    return { bySource, byType, byName };
}
/**
 * When the clan is actually playing, by weekday and hour of the day.
 *
 * This is the one thing in this app no competing tool can build. Everyone
 * else's business model gates scan frequency at 30–60 minutes, so their
 * timestamps are scan clocks and an hourly histogram of them would draw their
 * own cron schedule. `earned_at` is derived from the gift card's countdown, so
 * it is the minute the chest was actually claimed.
 *
 * THE PREDICATE IS LOAD-BEARING. `earned_at IS NOT NULL` alone is not enough:
 * when the countdown can't be read, giftEarnedAtMs falls back to the scan clock
 * and stores earned_at == captured_at (see src/utils/gift-time.ts). Those rows
 * are scan times wearing an earn-time column, and including them renders the
 * scanner's 120-minute schedule as spikes — a clan that appears to play in
 * eight sharp bursts a day, every day, forever. Requiring earned_at <
 * captured_at keeps only rows where a countdown genuinely parsed.
 *
 * `timed` and `total` come back so the caller can print what share of the
 * window this is based on, and refuse to draw when it is too thin. That is not
 * decoration: if the Stage-3 calibration crop excludes the "Time left" text,
 * every row falls back and `timed` is zero — the chart having nothing to say is
 * the symptom that tells an operator to recalibrate.
 *
 * Weekday and hour are UTC. The caller draws the game-day rollover as a rule
 * rather than rotating the axis, so the hours stay the ones a person reads off
 * a clock.
 */
function getActivityClock(clanId, fromMs, toMs) {
    const db = (0, database_js_1.getDb)();
    const windowed = Number.isFinite(fromMs) && Number.isFinite(toMs);
    const range = windowed ? ' AND effective_at >= ? AND effective_at < ?' : '';
    const params = windowed ? [clanId, fromMs, toMs] : [clanId];
    const rows = db.prepare(`
    SELECT CAST(strftime('%w', earned_at / 1000, 'unixepoch') AS INTEGER) AS dow,
           CAST(strftime('%H', earned_at / 1000, 'unixepoch') AS INTEGER) AS hour,
           COUNT(*) AS chests
    FROM chest_records
    WHERE clan_id = ?${range}
      AND earned_at IS NOT NULL
      AND earned_at < captured_at
    GROUP BY dow, hour
  `).all(...params);
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let timed = 0;
    for (const r of rows) {
        if (r.dow >= 0 && r.dow < 7 && r.hour >= 0 && r.hour < 24) {
            grid[r.dow][r.hour] = r.chests;
            timed += r.chests;
        }
    }
    const totalRow = db.prepare(`
    SELECT COUNT(*) AS total FROM chest_records WHERE clan_id = ?${range}
  `).get(...params);
    return { grid, timed, total: totalRow.total };
}
/**
 * Where one member's chests actually come from, for a window.
 *
 * Groups on chest_source_id (covered by idx_cr_clan_member_effective_pts) and
 * resolves the names once at the end, rather than GROUP BY-ing the joined
 * string through chest_records_v — same answer, and the aggregate stays on the
 * index instead of dragging a three-way join through every row.
 *
 * Answers "am I actually farming what I think I am". A member who believes they
 * run crypts nightly and finds two thirds of their points came from events has
 * learned something a total never tells them.
 */
function getMemberSourceMix(memberId, clanId, fromMs, toMs) {
    const db = (0, database_js_1.getDb)();
    const windowed = Number.isFinite(fromMs) && Number.isFinite(toMs);
    const range = windowed ? ' AND effective_at >= ? AND effective_at < ?' : '';
    const params = windowed
        ? [clanId, memberId, fromMs, toMs]
        : [clanId, memberId];
    const grouped = db.prepare(`
    SELECT chest_source_id AS sourceId,
           COUNT(*) AS chests,
           SUM(point_value) AS points
    FROM chest_records
    WHERE clan_id = ? AND member_id = ?${range}
    GROUP BY chest_source_id
    ORDER BY points DESC
  `).all(...params);
    if (grouped.length === 0)
        return [];
    const ids = grouped.map((g) => g.sourceId).filter((id) => id !== null);
    const names = new Map();
    if (ids.length > 0) {
        const rows = db.prepare(`SELECT id, source FROM chest_sources WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
        for (const r of rows)
            names.set(r.id, r.source);
    }
    return grouped.map((g) => ({
        source: (g.sourceId !== null ? names.get(g.sourceId) : null) || 'Unknown',
        chests: g.chests,
        points: g.points,
    }));
}
//# sourceMappingURL=chest-repo.js.map