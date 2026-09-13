"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createShareLink = createShareLink;
exports.revokeActiveShareLink = revokeActiveShareLink;
exports.getActiveShareLink = getActiveShareLink;
exports.shareLinkTokenExists = shareLinkTokenExists;
exports.recordVisit = recordVisit;
exports.recordApiHit = recordApiHit;
exports.recordBeacon = recordBeacon;
exports.listRecentRevoked = listRecentRevoked;
exports.getShareLinkAnalytics = getShareLinkAnalytics;
exports.recoverShareLink = recoverShareLink;
const database_js_1 = require("../database.js");
const logger_js_1 = require("../../utils/logger.js");
const log = (0, logger_js_1.childLogger)('share-link-repo');
function rowToShareLink(row) {
    return {
        id: row.id,
        clanId: row.clan_id,
        token: row.token,
        createdAt: row.created_at,
        createdBy: row.created_by ?? null,
        revokedAt: row.revoked_at ?? null,
        revokedBy: row.revoked_by ?? null,
        revokeReason: row.revoke_reason || '',
        hitCount: row.hit_count ?? 0,
        lastUsedAt: row.last_used_at ?? null,
        apiHitCount: row.api_hit_count ?? 0,
        apiLastUsedAt: row.api_last_used_at ?? null,
        uniqueVisits: row.unique_visits ?? 0,
        returnVisits: row.return_visits ?? 0,
        durationMsTotal: row.duration_ms_total ?? 0,
        durationSamples: row.duration_samples ?? 0,
        timeframeChanges: row.timeframe_changes ?? 0,
    };
}
/** Insert a new active ledger row for a freshly generated token. */
function createShareLink(clanId, token, createdBy) {
    const db = (0, database_js_1.getDb)();
    const now = new Date().toISOString();
    const result = db
        .prepare(`INSERT INTO share_links (clan_id, token, created_at, created_by)
       VALUES (?, ?, ?, ?)`)
        .run(clanId, token, now, createdBy);
    const created = db
        .prepare('SELECT * FROM share_links WHERE id = ?')
        .get(result.lastInsertRowid);
    return rowToShareLink(created);
}
/**
 * Mark the clan's currently-active token as revoked. reason is one of
 * 'disabled' | 'regenerated' | 'swapped'. No-op if nothing is active.
 */
function revokeActiveShareLink(clanId, reason, userId) {
    const db = (0, database_js_1.getDb)();
    db.prepare(`UPDATE share_links
     SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
     WHERE clan_id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), userId, reason, clanId);
}
function getActiveShareLink(clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db
        .prepare('SELECT * FROM share_links WHERE clan_id = ? AND revoked_at IS NULL')
        .get(clanId);
    return row ? rowToShareLink(row) : null;
}
/** True if any ledger row (active or revoked) already holds this token. */
function shareLinkTokenExists(token) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT 1 FROM share_links WHERE token = ?').get(token);
    return !!row;
}
/**
 * Count a page load of /<token>. Best-effort: bumps the ledger row's
 * hit_count/last_used_at and the per-day rollup in one transaction, and
 * swallows any error so a counter hiccup never breaks the public page.
 */
function recordVisit(token) {
    try {
        const db = (0, database_js_1.getDb)();
        const link = db.prepare('SELECT id FROM share_links WHERE token = ?').get(token);
        if (!link)
            return;
        const now = new Date().toISOString();
        const day = now.slice(0, 10);
        const tx = db.transaction(() => {
            db.prepare('UPDATE share_links SET hit_count = hit_count + 1, last_used_at = ? WHERE id = ?').run(now, link.id);
            db.prepare(`INSERT INTO share_link_daily (link_id, day, views) VALUES (?, ?, 1)
         ON CONFLICT(link_id, day) DO UPDATE SET views = views + 1`).run(link.id, day);
        });
        tx();
    }
    catch (err) {
        log.warn({ err }, 'recordVisit failed (ignored)');
    }
}
/**
 * Count a data-API request (/api/public/:token/*). Best-effort — a data
 * page fires several of these per visit, so this is a secondary metric.
 */
function recordApiHit(token) {
    try {
        const db = (0, database_js_1.getDb)();
        db.prepare('UPDATE share_links SET api_hit_count = api_hit_count + 1, api_last_used_at = ? WHERE token = ?').run(new Date().toISOString(), token);
    }
    catch (err) {
        log.warn({ err }, 'recordApiHit failed (ignored)');
    }
}
/**
 * Fold a client analytics beacon into the ledger's aggregate counters.
 * Best-effort — swallows errors so a bad/absent beacon never surfaces. The
 * caller (public beacon route) has already validated + clamped the payload.
 *
 * `enter` events classify the viewer (new vs returning, decided client-side
 * from localStorage). `leave` events contribute a visit-duration sample and,
 * if the viewer switched day/week/month while reading, a timeframe-change tick.
 */
function recordBeacon(token, payload) {
    try {
        const db = (0, database_js_1.getDb)();
        const link = db.prepare('SELECT id FROM share_links WHERE token = ?').get(token);
        if (!link)
            return;
        if (payload.event === 'enter') {
            const col = payload.isReturning ? 'return_visits' : 'unique_visits';
            db.prepare(`UPDATE share_links SET ${col} = ${col} + 1 WHERE id = ?`).run(link.id);
            return;
        }
        // 'leave': record a duration sample (already clamped by the caller) and,
        // if the viewer changed timeframe at least once, tick that counter.
        const durationMs = Number.isFinite(payload.durationMs) ? Math.trunc(payload.durationMs) : 0;
        const tfTick = payload.changedTimeframe ? 1 : 0;
        db.prepare(`UPDATE share_links
       SET duration_ms_total = duration_ms_total + ?,
           duration_samples = duration_samples + 1,
           timeframe_changes = timeframe_changes + ?
       WHERE id = ?`).run(durationMs, tfTick, link.id);
    }
    catch (err) {
        log.warn({ err }, 'recordBeacon failed (ignored)');
    }
}
/** Most-recently revoked links for a clan (for the recovery list). */
function listRecentRevoked(clanId, limit = 3) {
    const db = (0, database_js_1.getDb)();
    const rows = db
        .prepare(`SELECT * FROM share_links
       WHERE clan_id = ? AND revoked_at IS NOT NULL
       ORDER BY revoked_at DESC
       LIMIT ?`)
        .all(clanId, limit);
    return rows.map(rowToShareLink);
}
/**
 * Active-link analytics for the Clans settings modal: the live link, its
 * last-30-day daily visit series (sparse — gaps mean zero, the frontend
 * fills them), and up to `revokedLimit` recoverable links.
 */
function getShareLinkAnalytics(clanId, revokedLimit = 3) {
    const db = (0, database_js_1.getDb)();
    const active = getActiveShareLink(clanId);
    let daily = [];
    if (active) {
        // 30-day window ending today (UTC). 29 whole days back + today.
        const cutoff = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10);
        daily = db
            .prepare(`SELECT day, views FROM share_link_daily
         WHERE link_id = ? AND day >= ?
         ORDER BY day ASC`)
            .all(active.id, cutoff);
    }
    return { active, daily, recentRevoked: listRecentRevoked(clanId, revokedLimit) };
}
/**
 * Restore a previously-revoked link. Swaps it in as the active token: the
 * clan's current active link (if any) is revoked as 'swapped', the chosen
 * row is un-revoked, and its token is mirrored back onto
 * clans.public_share_token. Refuses if the token has since been reissued
 * live to another clan (astronomically unlikely, but the guard keeps the
 * clans-column uniqueness invariant intact).
 */
function recoverShareLink(clanId, linkId) {
    const db = (0, database_js_1.getDb)();
    const link = db
        .prepare('SELECT * FROM share_links WHERE id = ? AND clan_id = ?')
        .get(linkId, clanId);
    if (!link)
        return { ok: false, reason: 'Link not found' };
    if (link.revoked_at == null)
        return { ok: false, reason: 'That link is already active' };
    const token = link.token;
    const owner = db
        .prepare("SELECT id FROM clans WHERE public_share_token = ?")
        .get(token);
    if (owner && owner.id !== clanId) {
        return { ok: false, reason: 'That link code is in use elsewhere and can no longer be restored' };
    }
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
        db.prepare(`UPDATE share_links SET revoked_at = ?, revoke_reason = 'swapped'
       WHERE clan_id = ? AND revoked_at IS NULL`).run(now, clanId);
        db.prepare(`UPDATE share_links SET revoked_at = NULL, revoked_by = NULL, revoke_reason = ''
       WHERE id = ?`).run(linkId);
        db.prepare('UPDATE clans SET public_share_token = ? WHERE id = ?').run(token, clanId);
    });
    tx();
    log.info(`Recovered share link #${linkId} for clan #${clanId}`);
    return { ok: true, token };
}
//# sourceMappingURL=share-link-repo.js.map