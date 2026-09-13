"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertChest = insertChest;
exports.deleteBySession = deleteBySession;
exports.countBySession = countBySession;
exports.getBySession = getBySession;
exports.getChestsByMember = getChestsByMember;
exports.countChestsByMember = countChestsByMember;
exports.getMemberStats = getMemberStats;
exports.getRawPlayerOcrForMember = getRawPlayerOcrForMember;
exports.getLeaderboardForClan = getLeaderboardForClan;
exports.getRecent = getRecent;
exports.getStats = getStats;
const database_js_1 = require("../database.js");
const chest_repo_js_1 = require("./chest-repo.js");
// Local conversion helpers — captured_at is INTEGER ms, confidence is
// INTEGER 0–100 post-v30; the public surface still works with ISO
// strings + 0.0–1.0 floats. Same shape as in chest-repo.ts.
function isoToMs(iso) {
    return Date.parse(iso);
}
function msToIso(ms) {
    return new Date(ms).toISOString();
}
function aggMsToIso(value) {
    if (value === null || value === undefined)
        return null;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n))
        return null;
    return msToIso(n);
}
// Triumphal chests are stored in a dedicated table so no existing
// aggregate (leaderboard, points, exports, ChestTracker push, Discord
// digest, CSV/JSON exports) can sum them by accident. They carry no
// point_value at the row level — points are a presentation-only metric
// computed in getLeaderboardForClan, not persisted.
// Triumphal points are awarded per *individual* chest — packages used
// to always be groups of 3, but a game update now sells them singly
// (1, 2, or 3 at a time), so every chest scores on its own worth exactly
// one third of its package value. Package values live in the global,
// superadmin-managed `triumphal_chest_points` table (see
// triumphal-points-repo.ts), joined in below on chest_name — a chest
// with no configured value (a brand-new one awaiting review) scores 0.
// SQL fragment for a member's total triumphal points, aggregated over a
// pre-grouped subquery that exposes `cnt` and the joined `package_points`.
// Sums cnt * package_points at full integer precision, divides by 3.0,
// and ROUNDs *once* at the end — so 3 identical chests recover the exact
// package value (3 Golden = 50, not 51) while a single chest rounds to a
// whole number (1 Golden = 17). COALESCE handles unconfigured chests (0).
const TRIUMPHAL_POINTS_EXPR = 'ROUND(SUM(cnt * COALESCE(package_points, 0)) / 3.0)';
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
        confidence: row.confidence / 100,
    };
}
function insertChest(chest) {
    const db = (0, database_js_1.getDb)();
    if (chest.memberId === null || chest.memberId === undefined) {
        throw new Error('triumphal insertChest: memberId is required (post-D4 schema enforces NOT NULL)');
    }
    // Sanity guard: a triumphal record must at least have a non-empty name.
    // The set of valid names is no longer closed (new bank chests like
    // Conqueror's Chest are captured and score 0 until a superadmin assigns
    // a value), so we only reject the truly-nameless — the scan path already
    // resolves/cleans names via correctTriumphalChestName().
    if (!chest.chestName || !chest.chestName.trim()) {
        throw new Error('triumphal insertChest: chestName is required');
    }
    const chestId = (0, chest_repo_js_1.getOrCreateChestId)(chest.chestName, chest.chestType);
    const chestSourceId = (0, chest_repo_js_1.getOrCreateChestSourceId)(chest.chestSource);
    const result = db.prepare(`
    INSERT INTO triumphal_chest_records
      (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence, debug_crop_path, raw_player_ocr, earned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(chest.clanId, chest.sessionId, chest.memberId, chestId, chestSourceId, chest.pointValue, isoToMs(chest.capturedAt), Math.round(chest.confidence * 100), chest.debugCropPath ?? null, chest.rawPlayerOcr ?? null, chest.earnedAt ?? null);
    return { id: result.lastInsertRowid, ...chest };
}
function deleteBySession(sessionId, clanId) {
    const db = (0, database_js_1.getDb)();
    const result = db.prepare('DELETE FROM triumphal_chest_records WHERE session_id = ? AND clan_id = ?').run(sessionId, clanId);
    return result.changes;
}
/** Triumphal counterpart to chestRepo.countChestsBySession — the triumphal
 *  sweep is pipelined the same way, so a crash mid-sweep leaves rows here
 *  that no in-memory tally survived to describe. */
function countBySession(sessionId, clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT COUNT(*) AS c FROM triumphal_chest_records WHERE session_id = ? AND clan_id = ?').get(sessionId, clanId);
    return row.c;
}
function getBySession(sessionId, clanId) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare('SELECT * FROM triumphal_chest_records_v WHERE session_id = ? AND clan_id = ? ORDER BY captured_at DESC').all(sessionId, clanId);
    return rows.map(rowToChest);
}
/**
 * Paginated triumphal-chest history for a single member. Mirrors
 * chest-repo's getChestsByMember so the member detail page can render
 * a triumphal tab next to the normal chest tab. Triumphals never
 * carry points, so the caller doesn't need pointValue aggregation
 * here — just the rows.
 */
function getChestsByMember(memberId, clanId, from, to, limit, offset) {
    const db = (0, database_js_1.getDb)();
    let query = 'SELECT * FROM triumphal_chest_records_v WHERE member_id = ? AND clan_id = ?';
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
function countChestsByMember(memberId, clanId, from, to) {
    const db = (0, database_js_1.getDb)();
    let query = 'SELECT COUNT(*) as count FROM triumphal_chest_records WHERE member_id = ? AND clan_id = ?';
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
/**
 * Per-member triumphal totals (chests, points). Same per-chest points
 * math as getLeaderboardForClan but filtered to a single member, so the
 * member detail page's headline stats match exactly what the global
 * Triumphals page would show for this player. Returns zeros when the
 * member has no triumphals.
 */
function getMemberStats(memberId, clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`
    SELECT
      COALESCE(SUM(cnt), 0)          AS totalChests,
      COALESCE(${TRIUMPHAL_POINTS_EXPR}, 0) AS totalPoints
    FROM (
      SELECT tp.package_points AS package_points, COUNT(*) AS cnt
      FROM triumphal_chest_records t
      JOIN chests ch ON ch.id = t.chest_id
      LEFT JOIN triumphal_chest_points tp ON tp.chest_name = ch.name
      WHERE t.member_id = ? AND t.clan_id = ?
      GROUP BY ch.name, tp.package_points
    )
  `).get(memberId, clanId);
    return {
        totalChests: row.totalChests || 0,
        totalPoints: row.totalPoints || 0,
    };
}
/**
 * Triumphal twin of chest-repo's getRawPlayerOcrForMember. Returns
 * the captured raw OCR strings that resolved to this member on the
 * triumphal scan path, for the System-page "Raw OCR Capture" feature.
 */
function getRawPlayerOcrForMember(memberId, clanId, limit) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare(`SELECT raw_player_ocr AS rawPlayerOcr, captured_at AS capturedAt, session_id AS sessionId
     FROM triumphal_chest_records
     WHERE member_id = ? AND clan_id = ? AND raw_player_ocr IS NOT NULL
     ORDER BY captured_at DESC LIMIT ?`).all(memberId, clanId, limit);
    return rows;
}
function getLeaderboardForClan(clanId, from, to) {
    const db = (0, database_js_1.getDb)();
    const conditions = ['t.clan_id = ?'];
    const params = [clanId];
    if (from) {
        conditions.push('t.effective_at >= ?');
        params.push(isoToMs(from));
    }
    if (to) {
        conditions.push('t.effective_at < ?');
        params.push(isoToMs(to));
    }
    const where = conditions.join(' AND ');
    // Points are per individual chest (one third of the package value,
    // summed at full precision and rounded once — see TRIUMPHAL_POINTS_EXPR).
    // package_points comes from the global triumphal_chest_points table;
    // an unconfigured (brand-new) chest joins to NULL and scores 0. Every
    // chest of a given type scores the same whether it arrived 1, 2, or 3
    // at a time.
    const rows = db.prepare(`
    SELECT
      member_id AS memberId,
      member_name AS memberName,
      SUM(cnt) AS totalChests,
      COALESCE(${TRIUMPHAL_POINTS_EXPR}, 0) AS totalPoints
    FROM (
      SELECT
        t.member_id AS member_id,
        m.name AS member_name,
        ch.name AS chest_name,
        tp.package_points AS package_points,
        COUNT(*) AS cnt
      FROM triumphal_chest_records t
      JOIN members m ON m.id = t.member_id AND m.clan_id = t.clan_id
      JOIN chests ch ON ch.id = t.chest_id
      LEFT JOIN triumphal_chest_points tp ON tp.chest_name = ch.name
      WHERE ${where}
      GROUP BY t.member_id, m.name, ch.name, tp.package_points
    )
    GROUP BY member_id, member_name
    ORDER BY totalPoints DESC, totalChests DESC, LOWER(memberName) ASC
  `).all(...params);
    return rows.map((row, index) => ({
        rank: index + 1,
        memberId: row.memberId,
        memberName: row.memberName,
        totalChests: row.totalChests,
        totalPoints: row.totalPoints,
    }));
}
function getRecent(clanId, limit, from, to, memberId) {
    const db = (0, database_js_1.getDb)();
    const conditions = ['clan_id = ?'];
    const params = [clanId];
    if (from) {
        conditions.push('effective_at >= ?');
        params.push(isoToMs(from));
    }
    if (to) {
        conditions.push('effective_at < ?');
        params.push(isoToMs(to));
    }
    if (typeof memberId === 'number') {
        conditions.push('member_id = ?');
        params.push(memberId);
    }
    const where = conditions.join(' AND ');
    params.push(limit);
    const rows = db.prepare(`
    SELECT id, session_id, captured_at, effective_at, member_id, player_name, chest_name, chest_source, chest_type, quantity
    FROM triumphal_chest_records_v
    WHERE ${where}
    ORDER BY captured_at DESC
    LIMIT ?
  `).all(...params);
    return rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        capturedAt: msToIso(r.captured_at),
        effectiveAt: msToIso((r.effective_at ?? r.captured_at)),
        memberId: r.member_id ?? null,
        playerName: r.player_name ?? '',
        chestName: r.chest_name,
        chestSource: r.chest_source || '',
        chestType: r.chest_type || '',
        quantity: r.quantity,
    }));
}
function getStats(clanId, from, to) {
    const db = (0, database_js_1.getDb)();
    const conditions = ['clan_id = ?'];
    const params = [clanId];
    if (from) {
        conditions.push('effective_at >= ?');
        params.push(isoToMs(from));
    }
    if (to) {
        conditions.push('effective_at < ?');
        params.push(isoToMs(to));
    }
    const where = conditions.join(' AND ');
    const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM triumphal_chest_records WHERE ${where}) AS totalChests,
      (SELECT COUNT(DISTINCT member_id) FROM triumphal_chest_records WHERE ${where}) AS uniqueMembers,
      (SELECT MAX(captured_at) FROM triumphal_chest_records WHERE ${where}) AS latestCapturedAt
  `).get(...params, ...params, ...params);
    return {
        totalChests: row.totalChests ?? 0,
        uniqueMembers: row.uniqueMembers ?? 0,
        latestCapturedAt: aggMsToIso(row.latestCapturedAt),
    };
}
//# sourceMappingURL=triumphal-chest-repo.js.map