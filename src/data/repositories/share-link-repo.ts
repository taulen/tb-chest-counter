import { getDb } from '../database.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('share-link-repo');

/**
 * share_links is the ONLY authority on what `/<key>` resolves to.
 *
 * It used to be a ledger mirroring one live token on clans.public_share_token,
 * which capped a clan at a single public link. A clan now holds as many active
 * links as it likes — one per audience (Discord, the forum, a recruiting post) —
 * and every link carries its own counters, so "which link is actually being
 * used" became a question the data can answer. Migration v73 dropped the clans
 * column outright rather than keeping it as a "primary" link: two sources of
 * truth for the same resolution is exactly the drift that column would have
 * been.
 *
 * A row is live while revoked_at IS NULL and revoked otherwise; a revoked row
 * keeps its history and can be restored or permanently deleted (which is the
 * only way to free a vanity key for reuse).
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
  /** Admin-supplied note ("Discord", "recruiting post"). Empty when unnamed. */
  label: string;
  /** True when the key was chosen by an admin rather than generated. */
  isVanity: boolean;
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

/** A link plus its own 30-day visit series — one card in the analytics modal. */
export interface ShareLinkWithSeries extends ShareLink {
  daily: { day: string; views: number }[];
}

function rowToShareLink(row: Record<string, unknown>): ShareLink {
  return {
    id: row.id as number,
    clanId: row.clan_id as number,
    token: row.token as string,
    label: (row.label as string) || '',
    isVanity: !!(row.is_vanity as number),
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

/** Trim + cap a user-supplied label. Empty string means "unnamed". */
export function normalizeShareLinkLabel(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, 60) : '';
}

/** Insert a new active link for a clan. */
export function createShareLink(
  clanId: number,
  token: string,
  createdBy: number | null,
  opts: { label?: string; isVanity?: boolean } = {},
): ShareLink {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO share_links (clan_id, token, created_at, created_by, label, is_vanity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(clanId, token, now, createdBy, normalizeShareLinkLabel(opts.label), opts.isVanity ? 1 : 0);
  const created = db
    .prepare('SELECT * FROM share_links WHERE id = ?')
    .get(result.lastInsertRowid as number) as Record<string, unknown>;
  return rowToShareLink(created);
}

/**
 * Resolve a URL key to its LIVE link row. Exact match first (generated tokens
 * are case-sensitive, which is where their 62^6 entropy lives); a vanity key,
 * stored lowercase, also answers to any casing a visitor types.
 */
export function resolveActiveShareLink(token: string): ShareLink | null {
  if (!token) return null;
  const db = getDb();
  const exact = db
    .prepare('SELECT * FROM share_links WHERE token = ? AND revoked_at IS NULL')
    .get(token) as Record<string, unknown> | undefined;
  if (exact) return rowToShareLink(exact);
  const vanity = db
    .prepare(
      'SELECT * FROM share_links WHERE is_vanity = 1 AND token = ? AND revoked_at IS NULL',
    )
    .get(token.toLowerCase()) as Record<string, unknown> | undefined;
  return vanity ? rowToShareLink(vanity) : null;
}

/**
 * True if any row (active or revoked, any clan) already holds this key,
 * compared case-INSENSITIVELY. Revoked rows count: their key is recoverable,
 * so handing it to someone else would silently repoint an old URL at a
 * different clan.
 */
export function shareLinkTokenExists(token: string): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT 1 FROM share_links WHERE token = ? COLLATE NOCASE')
    .get(token);
  return !!row;
}

/** One link, scoped to the clan that owns it (so a linkId can't cross clans). */
export function getShareLink(clanId: number, linkId: number): ShareLink | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM share_links WHERE id = ? AND clan_id = ?')
    .get(linkId, clanId) as Record<string, unknown> | undefined;
  return row ? rowToShareLink(row) : null;
}

/** Every live link a clan holds, newest first. */
export function listActiveShareLinks(clanId: number): ShareLink[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM share_links
       WHERE clan_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC, id DESC`,
    )
    .all(clanId) as Record<string, unknown>[];
  return rows.map(rowToShareLink);
}

/** Revoke one link. Returns false when the id isn't this clan's or is already revoked. */
export function revokeShareLink(
  clanId: number,
  linkId: number,
  reason: string,
  userId: number | null,
): boolean {
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE share_links
       SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
       WHERE id = ? AND clan_id = ? AND revoked_at IS NULL`,
    )
    .run(new Date().toISOString(), userId, reason, linkId, clanId);
  return res.changes > 0;
}

/** Rename (or clear the name of) one link. */
export function setShareLinkLabel(clanId: number, linkId: number, label: string): boolean {
  const db = getDb();
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
export function restoreShareLink(
  clanId: number,
  linkId: number,
): { ok: true; token: string } | { ok: false; reason: string } {
  const db = getDb();
  const link = getShareLink(clanId, linkId);
  if (!link) return { ok: false, reason: 'Link not found' };
  if (link.revokedAt == null) return { ok: false, reason: 'That link is already active' };
  db.prepare(
    `UPDATE share_links SET revoked_at = NULL, revoked_by = NULL, revoke_reason = ''
     WHERE id = ?`,
  ).run(linkId);
  log.info(`Restored share link #${linkId} for clan #${clanId}`);
  return { ok: true, token: link.token };
}

/**
 * Permanently delete a revoked link, freeing its key for reuse — the only
 * reason this exists, since a vanity key stays claimed for as long as any row
 * holds it. Refuses to touch a live link: deleting one is indistinguishable
 * from revoking it except that the history goes too.
 */
export function deleteShareLink(
  clanId: number,
  linkId: number,
): { ok: true } | { ok: false; reason: string } {
  const db = getDb();
  const link = getShareLink(clanId, linkId);
  if (!link) return { ok: false, reason: 'Link not found' };
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
export function recordVisit(linkId: number): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const day = now.slice(0, 10);
    const tx = db.transaction(() => {
      db.prepare(
        'UPDATE share_links SET hit_count = hit_count + 1, last_used_at = ? WHERE id = ?',
      ).run(now, linkId);
      db.prepare(
        `INSERT INTO share_link_daily (link_id, day, views) VALUES (?, ?, 1)
         ON CONFLICT(link_id, day) DO UPDATE SET views = views + 1`,
      ).run(linkId, day);
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
export function recordApiHit(linkId: number): void {
  try {
    getDb()
      .prepare(
        'UPDATE share_links SET api_hit_count = api_hit_count + 1, api_last_used_at = ? WHERE id = ?',
      )
      .run(new Date().toISOString(), linkId);
  } catch (err) {
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
export function recordBeacon(
  linkId: number,
  payload: {
    event: 'enter' | 'leave';
    isReturning?: boolean;
    durationMs?: number;
    changedTimeframe?: boolean;
  },
): void {
  try {
    const db = getDb();
    if (payload.event === 'enter') {
      const col = payload.isReturning ? 'return_visits' : 'unique_visits';
      db.prepare(`UPDATE share_links SET ${col} = ${col} + 1 WHERE id = ?`).run(linkId);
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
    ).run(durationMs, tfTick, linkId);
  } catch (err) {
    log.warn({ err }, 'recordBeacon failed (ignored)');
  }
}

/** Most-recently revoked links for a clan (for the recovery list). */
export function listRecentRevoked(clanId: number, limit = 5): ShareLink[] {
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

/**
 * One link's daily visit series over the trailing `days` UTC days. Sparse —
 * missing days mean zero, and the frontend fills them.
 */
export function getShareLinkDaily(linkId: number, days = 30): { day: string; views: number }[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return db
    .prepare(
      `SELECT day, views FROM share_link_daily
       WHERE link_id = ? AND day >= ?
       ORDER BY day ASC`,
    )
    .all(linkId, cutoff) as { day: string; views: number }[];
}

export interface ShareLinkAnalytics {
  links: ShareLinkWithSeries[];
  recentRevoked: ShareLink[];
}

/**
 * Analytics for every live link a clan holds — each with its own 30-day
 * series, which is the point of per-link counters: the modal compares the
 * Discord link against the forum link rather than showing one merged total.
 */
export function getShareLinkAnalytics(clanId: number, revokedLimit = 5): ShareLinkAnalytics {
  return {
    links: listActiveShareLinks(clanId).map((link) => ({
      ...link,
      daily: getShareLinkDaily(link.id),
    })),
    recentRevoked: listRecentRevoked(clanId, revokedLimit),
  };
}
