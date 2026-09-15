"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeShareLinkLabel = normalizeShareLinkLabel;
exports.createShareLink = createShareLink;
exports.resolveActiveShareLink = resolveActiveShareLink;
exports.shareLinkTokenExists = shareLinkTokenExists;
exports.getShareLink = getShareLink;
exports.listActiveShareLinks = listActiveShareLinks;
exports.revokeShareLink = revokeShareLink;
exports.setShareLinkLabel = setShareLinkLabel;
exports.restoreShareLink = restoreShareLink;
exports.deleteShareLink = deleteShareLink;
exports.recordVisit = recordVisit;
exports.recordApiHit = recordApiHit;
exports.recordBeacon = recordBeacon;
exports.listRecentRevoked = listRecentRevoked;
exports.getShareLinkDaily = getShareLinkDaily;
exports.getShareLinkAnalytics = getShareLinkAnalytics;
const database_js_1 = require("../database.js");
const logger_js_1 = require("../../utils/logger.js");
const log = (0, logger_js_1.childLogger)('share-link-repo');
function rowToShareLink(row) {
    return {
        id: row.id,
        clanId: row.clan_id,
        token: row.token,
        label: row.label || '',
        isVanity: !!row.is_vanity,
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
/** Trim + cap a user-supplied label. Empty string means "unnamed". */
function normalizeShareLinkLabel(raw) {
    return typeof raw === 'string' ? raw.trim().slice(0, 60) : '';
}
/** Insert a new active link for a clan. */
function createShareLink(clanId, token, createdBy, opts = {}) {
    const db = (0, database_js_1.getDb)();
    const now = new Date().toISOString();
    const result = db
        .prepare(`INSERT INTO share_links (clan_id, token, created_at, created_by, label, is_vanity)
       VALUES (?, ?, ?, ?, ?, ?)`)
        .run(clanId, token, now, createdBy, normalizeShareLinkLabel(opts.label), opts.isVanity ? 1 : 0);
    const created = db
        .prepare('SELECT * FROM share_links WHERE id = ?')
        .get(result.lastInsertRowid);
    return rowToShareLink(created);
}
/**
 * Resolve a URL key to its LIVE link row. Exact match first (generated tokens
 * are case-sensitive, which is where their 62^6 entropy lives); a vanity key,
 * stored lowercase, also answers to any casing a visitor types.
 */
function resolveActiveShareLink(token) {
    if (!token)
        return null;
    const db = (0, database_js_1.getDb)();
    const exact = db
        .prepare('SELECT * FROM share_links WHERE token = ? AND revoked_at IS NULL')
        .get(token);
    if (exact)
        return rowToShareLink(exact);
    const vanity = db
        .prepare('SELECT * FROM share_links WHERE is_vanity = 1 AND token = ? AND revoked_at IS NULL')
        .get(token.toLowerCase());
    return vanity ? rowToShareLink(vanity) : null;
}
/**
 * True if any row (active or revoked, any clan) already holds this key,
 * compared case-INSENSITIVELY. Revoked rows count: their key is recoverable,
 * so handing it to someone else would silently repoint an old URL at a
 * different clan.
 */
function shareLinkTokenExists(token) {
    const db = (0, database_js_1.getDb)();
    const row = db
        .prepare('SELECT 1 FROM share_links WHERE token = ? COLLATE NOCASE')
        .get(token);
    return !!row;
}
/** One link, scoped to the clan that owns it (so a linkId can't cross clans). */
function getShareLink(clanId, linkId) {
    const db = (0, database_js_1.getDb)();
    const row = db
        .prepare('SELECT * FROM share_links WHERE id = ? AND clan_id = ?')
        .get(linkId, clanId);
    return row ? rowToShareLink(row) : null;
}
/** Every live link a clan holds, newest first. */
function listActiveShareLinks(clanId) {
    const db = (0, database_js_1.getDb)();
    const rows = db
        .prepare(`SELECT * FROM share_links
       WHERE clan_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC, id DESC`)
        .all(clanId);
    return rows.map(rowToShareLink);
}
/** Revoke one link. Returns false when the id isn't this clan's or is already revoked. */
function revokeShareLink(clanId, linkId, reason, userId) {
    const db = (0, database_js_1.getDb)();
    const res = db
        .prepare(`UPDATE share_links
       SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
       WHERE id = ? AND clan_id = ? AND revoked_at IS NULL`)
        .run(new Date().toISOString(), userId, reason, linkId, clanId);
    return res.changes > 0;
}
/** Rename (or clear the name of) one link. */
function setShareLinkLabel(clanId, linkId, label) {
    const db = (0, database_js_1.getDb)();
    const res = db
        .prepare('UPDATE share_links SET label = ? WHERE id = ? AND clan_id = ?')
        .run(normalizeShareLinkLabel(label), linkId, clanId);
    return res.changes > 0;
}
/**
 * Bring a revoked link back. No swap any more — a clan can hold any number of
 * live links, so restoring one leaves the others alone. The ledger's unique
 * key means nobody else can have taken the token in the meantime, which is
 * what makes this unconditional.
 */
function restoreShareLink(clanId, linkId) {
    const db = (0, database_js_1.getDb)();
    const link = getShareLink(clanId, linkId);
    if (!link)
        return { ok: false, reason: 'Link not found' };
    if (link.revokedAt == null)
        return { ok: false, reason: 'That link is already active' };
    db.prepare(`UPDATE share_links SET revoked_at = NULL, revoked_by = NULL, revoke_reason = ''
     WHERE id = ?`).run(linkId);
    log.info(`Restored share link #${linkId} for clan #${clanId}`);
    return { ok: true, token: link.token };
}
/**
 * Permanently delete a revoked link, freeing its key for reuse — the only
 * reason this exists, since a vanity key stays claimed for as long as any row
 * holds it. Refuses to touch a live link: deleting one is indistinguishable
 * from revoking it except that the history goes too.
 */
function deleteShareLink(clanId, linkId) {
    const db = (0, database_js_1.getDb)();
    const link = getShareLink(clanId, linkId);
    if (!link)
        return { ok: false, reason: 'Link not found' };
    if (link.revokedAt == null) {
        return { ok: false, reason: 'Disable the link before deleting it' };
    }
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM share_link_daily WHERE link_id = ?').run(linkId);
        db.prepare('DELETE FROM share_links WHERE id = ?').run(linkId);
    });
    tx();
    log.info(`Deleted share link #${linkId} (${link.token}) for clan #${clanId}`);
    return { ok: true };
}
/**
 * Count a page load of /<key>. Best-effort: bumps the row's
 * hit_count/last_used_at and the per-day rollup in one transaction, and
 * swallows any error so a counter hiccup never breaks the public page.
 *
 * Takes a link id rather than a token: the caller has already resolved the
 * row (including the vanity case-fold), so re-looking-it-up by the string the
 * visitor typed would miscount a differently-cased vanity URL.
 */
function recordVisit(linkId) {
    try {
        const db = (0, database_js_1.getDb)();
        const now = new Date().toISOString();
        const day = now.slice(0, 10);
        const tx = db.transaction(() => {
            db.prepare('UPDATE share_links SET hit_count = hit_count + 1, last_used_at = ? WHERE id = ?').run(now, linkId);
            db.prepare(`INSERT INTO share_link_daily (link_id, day, views) VALUES (?, ?, 1)
         ON CONFLICT(link_id, day) DO UPDATE SET views = views + 1`).run(linkId, day);
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
function recordApiHit(linkId) {
    try {
        (0, database_js_1.getDb)()
            .prepare('UPDATE share_links SET api_hit_count = api_hit_count + 1, api_last_used_at = ? WHERE id = ?')
            .run(new Date().toISOString(), linkId);
    }
    catch (err) {
        log.warn({ err }, 'recordApiHit failed (ignored)');
    }
}
/**
 * Fold a client analytics beacon into one link's aggregate counters.
 * Best-effort — swallows errors so a bad/absent beacon never surfaces. The
 * caller (public beacon route) has already resolved the link and clamped the
 * payload.
 *
 * `enter` events classify the viewer (new vs returning, decided client-side
 * from localStorage). `leave` events contribute a visit-duration sample and,
 * if the viewer switched day/week/month while reading, a timeframe-change tick.
 */
function recordBeacon(linkId, payload) {
    try {
        const db = (0, database_js_1.getDb)();
        if (payload.event === 'enter') {
            const col = payload.isReturning ? 'return_visits' : 'unique_visits';
            db.prepare(`UPDATE share_links SET ${col} = ${col} + 1 WHERE id = ?`).run(linkId);
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
       WHERE id = ?`).run(durationMs, tfTick, linkId);
    }
    catch (err) {
        log.warn({ err }, 'recordBeacon failed (ignored)');
    }
}
/** Most-recently revoked links for a clan (for the recovery list). */
function listRecentRevoked(clanId, limit = 5) {
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
 * One link's daily visit series over the trailing `days` UTC days. Sparse —
 * missing days mean zero, and the frontend fills them.
 */
function getShareLinkDaily(linkId, days = 30) {
    const db = (0, database_js_1.getDb)();
    const cutoff = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
    return db
        .prepare(`SELECT day, views FROM share_link_daily
       WHERE link_id = ? AND day >= ?
       ORDER BY day ASC`)
        .all(linkId, cutoff);
}
/**
 * Analytics for every live link a clan holds — each with its own 30-day
 * series, which is the point of per-link counters: the modal compares the
 * Discord link against the forum link rather than showing one merged total.
 */
function getShareLinkAnalytics(clanId, revokedLimit = 5) {
    return {
        links: listActiveShareLinks(clanId).map((link) => ({
            ...link,
            daily: getShareLinkDaily(link.id),
        })),
        recentRevoked: listRecentRevoked(clanId, revokedLimit),
    };
}
//# sourceMappingURL=share-link-repo.js.map