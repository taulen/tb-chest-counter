import { getDb } from '../database.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('share-link-repo');

/**
 * The share_links table is an append-only ledger of a clan's public
 * read-only share tokens. The live token stays authoritative on
 * clans.public_share_token (that's what /<token> resolution reads); each
 * row here mirrors one token's lifecycle — active while revoked_at IS NULL,
 * revoked otherwise — plus aggregate usage counters.
 *
 * We keep aggregate counts + timestamps only (no per-visit rows, no IP or
 * user-agent) to preserve the share path's noindex / no-referrer / no-store
 * privacy posture. share_link_daily rolls visits up per UTC day so the
 * analytics modal can draw a 30-day sparkline cheaply.
 */
export interface ShareLink {
  id: number;
  clanId: number;
  token: string;
  createdAt: string;
  createdBy: number | null;
  revokedAt: string | null;
  revokedBy: number | null;
  revokeReason: string;
  hitCount: number;
  lastUsedAt: string | null;
  apiHitCount: number;
  apiLastUsedAt: string | null;
  // Best-effort, beacon-derived (see recordBeacon). All default to 0 for
  // links that predate the analytics beacon or whose viewers' beacons never
  // fired.
  uniqueVisits: number;
  returnVisits: number;
  durationMsTotal: number;
  durationSamples: number;
  timeframeChanges: number;
}

function rowToShareLink(row: Record<string, unknown>): ShareLink {
  return {
    id: row.id as number,
    clanId: row.clan_id as number,
    token: row.token as string,
    createdAt: row.created_at as string,
    createdBy: (row.created_by as number | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
    revokedBy: (row.revoked_by as number | null) ?? null,
    revokeReason: (row.revoke_reason as string) || '',
    hitCount: (row.hit_count as number) ?? 0,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    apiHitCount: (row.api_hit_count as number) ?? 0,
    apiLastUsedAt: (row.api_last_used_at as string | null) ?? null,
    uniqueVisits: (row.unique_visits as number) ?? 0,
    returnVisits: (row.return_visits as number) ?? 0,
    durationMsTotal: (row.duration_ms_total as number) ?? 0,
    durationSamples: (row.duration_samples as number) ?? 0,
    timeframeChanges: (row.timeframe_changes as number) ?? 0,
  };
}

/** Insert a new active ledger row for a freshly generated token. */
export function createShareLink(
  clanId: number,
  token: string,
  createdBy: number | null,
): ShareLink {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO share_links (clan_id, token, created_at, created_by)
       VALUES (?, ?, ?, ?)`,
    )
    .run(clanId, token, now, createdBy);
  const created = db
    .prepare('SELECT * FROM share_links WHERE id = ?')
    .get(result.lastInsertRowid as number) as Record<string, unknown>;
  return rowToShareLink(created);
}

/**
 * Mark the clan's currently-active token as revoked. reason is one of
 * 'disabled' | 'regenerated' | 'swapped'. No-op if nothing is active.
 */
export function revokeActiveShareLink(
  clanId: number,
  reason: string,
  userId: number | null,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE share_links
     SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
     WHERE clan_id = ? AND revoked_at IS NULL`,
  ).run(new Date().toISOString(), userId, reason, clanId);
}

export function getActiveShareLink(clanId: number): ShareLink | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM share_links WHERE clan_id = ? AND revoked_at IS NULL')
    .get(clanId) as Record<string, unknown> | undefined;
  return row ? rowToShareLink(row) : null;
}

/** True if any ledger row (active or revoked) already holds this token. */
export function shareLinkTokenExists(token: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM share_links WHERE token = ?').get(token);
  return !!row;
}

/**
 * Count a page load of /<token>. Best-effort: bumps the ledger row's
 * hit_count/last_used_at and the per-day rollup in one transaction, and
 * swallows any error so a counter hiccup never breaks the public page.
 */
export function recordVisit(token: string): void {
  try {
    const db = getDb();
    const link = db.prepare('SELECT id FROM share_links WHERE token = ?').get(token) as
      | { id: number }
      | undefined;
    if (!link) return;
    const now = new Date().toISOString();
    const day = now.slice(0, 10);
    const tx = db.transaction(() => {
      db.prepare(
        'UPDATE share_links SET hit_count = hit_count + 1, last_used_at = ? WHERE id = ?',
      ).run(now, link.id);
      db.prepare(
        `INSERT INTO share_link_daily (link_id, day, views) VALUES (?, ?, 1)
         ON CONFLICT(link_id, day) DO UPDATE SET views = views + 1`,
      ).run(link.id, day);
    });
    tx();
  } catch (err) {
    log.warn({ err }, 'recordVisit failed (ignored)');
  }
}

/**
 * Count a data-API request (/api/public/:token/*). Best-effort — a data
 * page fires several of these per visit, so this is a secondary metric.
 */
export function recordApiHit(token: string): void {
  try {
    const db = getDb();
    db.prepare(
      'UPDATE share_links SET api_hit_count = api_hit_count + 1, api_last_used_at = ? WHERE token = ?',
    ).run(new Date().toISOString(), token);
  } catch (err) {
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
export function recordBeacon(
  token: string,
  payload: {
    event: 'enter' | 'leave';
    isReturning?: boolean;
    durationMs?: number;
    changedTimeframe?: boolean;
  },
): void {
  try {
    const db = getDb();
    const link = db.prepare('SELECT id FROM share_links WHERE token = ?').get(token) as
      | { id: number }
      | undefined;
    if (!link) return;

    if (payload.event === 'enter') {
      const col = payload.isReturning ? 'return_visits' : 'unique_visits';
      db.prepare(`UPDATE share_links SET ${col} = ${col} + 1 WHERE id = ?`).run(link.id);
      return;
    }

    // 'leave': record a duration sample (already clamped by the caller) and,
    // if the viewer changed timeframe at least once, tick that counter.
    const durationMs = Number.isFinite(payload.durationMs) ? Math.trunc(payload.durationMs!) : 0;
    const tfTick = payload.changedTimeframe ? 1 : 0;
    db.prepare(
      `UPDATE share_links
       SET duration_ms_total = duration_ms_total + ?,
           duration_samples = duration_samples + 1,
           timeframe_changes = timeframe_changes + ?
       WHERE id = ?`,
    ).run(durationMs, tfTick, link.id);
  } catch (err) {
    log.warn({ err }, 'recordBeacon failed (ignored)');
  }
}

/** Most-recently revoked links for a clan (for the recovery list). */
export function listRecentRevoked(clanId: number, limit = 3): ShareLink[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM share_links
       WHERE clan_id = ? AND revoked_at IS NOT NULL
       ORDER BY revoked_at DESC
       LIMIT ?`,
    )
    .all(clanId, limit) as Record<string, unknown>[];
  return rows.map(rowToShareLink);
}

export interface ShareLinkAnalytics {
  active: ShareLink | null;
  daily: { day: string; views: number }[];
  recentRevoked: ShareLink[];
}

/**
 * Active-link analytics for the Clans settings modal: the live link, its
 * last-30-day daily visit series (sparse — gaps mean zero, the frontend
 * fills them), and up to `revokedLimit` recoverable links.
 */
export function getShareLinkAnalytics(clanId: number, revokedLimit = 3): ShareLinkAnalytics {
  const db = getDb();
  const active = getActiveShareLink(clanId);
  let daily: { day: string; views: number }[] = [];
  if (active) {
    // 30-day window ending today (UTC). 29 whole days back + today.
    const cutoff = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    daily = db
      .prepare(
        `SELECT day, views FROM share_link_daily
         WHERE link_id = ? AND day >= ?
         ORDER BY day ASC`,
      )
      .all(active.id, cutoff) as { day: string; views: number }[];
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
export function recoverShareLink(
  clanId: number,
  linkId: number,
): { ok: true; token: string } | { ok: false; reason: string } {
  const db = getDb();
  const link = db
    .prepare('SELECT * FROM share_links WHERE id = ? AND clan_id = ?')
    .get(linkId, clanId) as Record<string, unknown> | undefined;
  if (!link) return { ok: false, reason: 'Link not found' };
  if (link.revoked_at == null) return { ok: false, reason: 'That link is already active' };

  const token = link.token as string;
  const owner = db
    .prepare("SELECT id FROM clans WHERE public_share_token = ?")
    .get(token) as { id: number } | undefined;
  if (owner && owner.id !== clanId) {
    return { ok: false, reason: 'That link code is in use elsewhere and can no longer be restored' };
  }

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE share_links SET revoked_at = ?, revoke_reason = 'swapped'
       WHERE clan_id = ? AND revoked_at IS NULL`,
    ).run(now, clanId);
    db.prepare(
      `UPDATE share_links SET revoked_at = NULL, revoked_by = NULL, revoke_reason = ''
       WHERE id = ?`,
    ).run(linkId);
    db.prepare('UPDATE clans SET public_share_token = ? WHERE id = ?').run(token, clanId);
  });
  tx();
  log.info(`Recovered share link #${linkId} for clan #${clanId}`);
  return { ok: true, token };
}
