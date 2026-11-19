/**
 * Accounts from the game (v127; docs/account-invites.md).
 *
 * A player DMs the clan's scanner account a keyword; the scanner answers in
 * that private chat with a one-time code (scheduler/chat-invites.ts); the code
 * on /join creates a site account linked to that game player, recovers the
 * account already linked to them, or adds this clan to the signed-in account.
 * From then on the account's role in the clan follows the player's in-game
 * rank on every scan: Leader or Superior → admin, anyone else → user, gone
 * from the roster → no access to that clan until they are back.
 *
 * Old password accounts (no link) are never touched by any of this.
 * Superadmins are never linked and never touched.
 */
import crypto from 'crypto';
import { getDb } from '../database.js';
import {
  createUser,
  changePassword,
  getUserById,
  getClanAccessRole,
  listClanAccess,
  logSystemAction,
  removeClanAccess,
  setHomeAndClanAccess,
  type ClanRole,
  type User,
} from './user-repo.js';

/** How long a code works after it was sent: 72 hours, asked for or not (a player may not read their chat for a while). */
export const CODE_TTL_MS = 72 * 3600_000;
/** At most one code per player in this window (any clan). */
export const CODE_COOLDOWN_MS = 10 * 60_000;
/** Code length and alphabet: no 0/O, 1/I/L — read off a phone and typed. */
export const CODE_LENGTH = 8;
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** A roster this short is a partial read: nobody loses access on it (member-sync uses the same floor). */
export const MIN_ROSTER_FOR_ACCESS_CHANGES = 5;

/** The in-game ranks that run a clan get the site's admin role there. */
export function rankRole(rank: number | null | undefined): ClanRole {
  return rank === 1 || rank === 2 ? 'admin' : 'user';
}

// ── Settings ────────────────────────────────────────────────────────────────

/**
 * Codes for new members, unprompted: `off`; `dry-run` (each join that would
 * get one is logged and recorded, nothing is sent); `on`.
 */
export type WelcomeMode = 'off' | 'dry-run' | 'on';
export const WELCOME_MODES: readonly WelcomeMode[] = ['off', 'dry-run', 'on'];
export function isWelcomeMode(v: unknown): v is WelcomeMode {
  return typeof v === 'string' && (WELCOME_MODES as readonly string[]).includes(v);
}

export interface InviteSettings {
  enabled: boolean;
  /** Epoch ms of the latest switch-on; requests sent before it are ignored. */
  enabledAt: number | null;
  welcomeMode: WelcomeMode;
  /** Epoch ms the welcome mode last changed to dry-run/on; joins after it count. */
  welcomeEnabledAt: number | null;
  /**
   * Epoch ms the mode was FIRST switched on: from then on every current member
   * without a linked account is due a code too (the backlog). Never reset.
   */
  welcomeBacklogAt: number | null;
  updatedAt: string | null;
}

export function getInviteSettings(clanId: number): InviteSettings {
  const r = getDb().prepare(
    'SELECT enabled, enabled_at, welcome_mode, welcome_enabled_at, welcome_backlog_at, updated_at FROM account_invite_settings WHERE clan_id = ?',
  ).get(clanId) as {
    enabled: number; enabled_at: number | null; welcome_mode: string; welcome_enabled_at: number | null;
    welcome_backlog_at: number | null; updated_at: string;
  } | undefined;
  if (!r) return { enabled: false, enabledAt: null, welcomeMode: 'off', welcomeEnabledAt: null, welcomeBacklogAt: null, updatedAt: null };
  return {
    enabled: r.enabled === 1,
    enabledAt: r.enabled_at,
    welcomeMode: isWelcomeMode(r.welcome_mode) ? r.welcome_mode : 'off',
    welcomeEnabledAt: r.welcome_enabled_at,
    welcomeBacklogAt: r.welcome_backlog_at,
    updatedAt: r.updated_at,
  };
}

function saveSettings(clanId: number, s: InviteSettings, nowMs: number): InviteSettings {
  getDb().prepare(
    `INSERT INTO account_invite_settings (clan_id, enabled, enabled_at, welcome_mode, welcome_enabled_at, welcome_backlog_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id) DO UPDATE SET enabled = excluded.enabled, enabled_at = excluded.enabled_at,
       welcome_mode = excluded.welcome_mode, welcome_enabled_at = excluded.welcome_enabled_at,
       welcome_backlog_at = excluded.welcome_backlog_at, updated_at = excluded.updated_at`,
  ).run(clanId, s.enabled ? 1 : 0, s.enabledAt, s.welcomeMode, s.welcomeEnabledAt, s.welcomeBacklogAt, new Date(nowMs).toISOString());
  return getInviteSettings(clanId);
}

/** Switch invites on or off. Switching on stamps the time: only DMs sent after it are answered. */
export function setInvitesEnabled(clanId: number, enabled: boolean, nowMs = Date.now()): InviteSettings {
  const current = getInviteSettings(clanId);
  const enabledAt = enabled ? (current.enabled ? current.enabledAt ?? nowMs : nowMs) : current.enabledAt;
  return saveSettings(clanId, { ...current, enabled, enabledAt }, nowMs);
}

/**
 * Set the welcome mode. Any change of mode into dry-run or on stamps the
 * time joins count from; the FIRST switch to `on` also starts the backlog
 * (every current member without an account). Off stops both where they are.
 */
export function setWelcomeMode(clanId: number, mode: WelcomeMode, nowMs = Date.now()): InviteSettings {
  const current = getInviteSettings(clanId);
  const welcomeEnabledAt = mode === 'off' ? current.welcomeEnabledAt
    : mode === current.welcomeMode ? current.welcomeEnabledAt ?? nowMs : nowMs;
  const welcomeBacklogAt = current.welcomeBacklogAt ?? (mode === 'on' ? nowMs : null);
  return saveSettings(clanId, { ...current, welcomeMode: mode, welcomeEnabledAt, welcomeBacklogAt }, nowMs);
}

// ── Requests (the handled-message record) ──────────────────────────────────

export type RequestStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'ignored';

export interface InviteRequest {
  id: number;
  clanId: number;
  channelUrl: string;
  messageId: number;
  senderChatId: string;
  playerId: number | null;
  requestedAt: number;
  status: RequestStatus;
  reason: string | null;
  attempts: number;
}

function rowToRequest(r: Record<string, unknown>): InviteRequest {
  return {
    id: r.id as number,
    clanId: r.clan_id as number,
    channelUrl: r.channel_url as string,
    messageId: r.message_id as number,
    senderChatId: r.sender_chat_id as string,
    playerId: (r.player_id as number | null) ?? null,
    requestedAt: r.requested_at as number,
    status: r.status as RequestStatus,
    reason: (r.reason as string | null) ?? null,
    attempts: r.attempts as number,
  };
}

/** Record a keyword DM once. False when it was already recorded (handled before). */
export function recordInviteRequest(
  req: { clanId: number; channelUrl: string; messageId: number; senderChatId: string; playerId: number | null; requestedAt: number },
  status: 'pending' | 'ignored',
  reason: string | null,
  now = new Date().toISOString(),
): boolean {
  return getDb().prepare(
    `INSERT OR IGNORE INTO chat_invite_requests
       (clan_id, channel_url, message_id, sender_chat_id, player_id, requested_at, status, reason, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(req.clanId, req.channelUrl, req.messageId, req.senderChatId, req.playerId, req.requestedAt, status, reason, now, now).changes > 0;
}

export function isRequestRecorded(clanId: number, channelUrl: string, messageId: number): boolean {
  return !!getDb().prepare('SELECT 1 FROM chat_invite_requests WHERE clan_id = ? AND channel_url = ? AND message_id = ?')
    .get(clanId, channelUrl, messageId);
}

export function pendingInviteRequests(clanId: number): InviteRequest[] {
  return (getDb().prepare("SELECT * FROM chat_invite_requests WHERE clan_id = ? AND status = 'pending' ORDER BY requested_at, id")
    .all(clanId) as Record<string, unknown>[]).map(rowToRequest);
}

export function setRequestStatus(id: number, status: RequestStatus, reason: string | null, now = new Date().toISOString()): void {
  getDb().prepare('UPDATE chat_invite_requests SET status = ?, reason = ?, updated_at = ? WHERE id = ?').run(status, reason, now, id);
}

/** A request for this player is already waiting or on its way (any clan). */
export function playerHasOpenRequest(playerId: number, exceptId?: number): boolean {
  return !!getDb().prepare(
    "SELECT 1 FROM chat_invite_requests WHERE player_id = ? AND status IN ('pending', 'sending') AND id <> ?",
  ).get(playerId, exceptId ?? -1);
}

export function recentInviteRequests(clanId: number, limit = 20): InviteRequest[] {
  return (getDb().prepare('SELECT * FROM chat_invite_requests WHERE clan_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?')
    .all(clanId, limit) as Record<string, unknown>[]).map(rowToRequest);
}

// ── Codes ───────────────────────────────────────────────────────────────────

/** Upper-case, separators and spaces dropped: what the player typed → what was hashed. */
export function normalizeCode(input: string): string {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashCode(code: string): string {
  return crypto.createHash('sha256').update(normalizeCode(code), 'utf8').digest('hex');
}

/** "ABCD-EFGH": how a code is shown in the DM. */
export function formatCode(code: string): string {
  const c = normalizeCode(code);
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** A fresh code, uniform over the alphabet (rejection sampling). */
export function generateCode(): string {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const b of crypto.randomBytes(CODE_LENGTH * 2)) {
      if (b < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

/**
 * The player was sent a code in the chat within the cooldown (any clan). A
 * code an admin made by hand doesn't count: it sent no message, and must not
 * mark the player's welcome as "asked for a code themselves".
 */
export function playerInCooldown(playerId: number, nowMs = Date.now()): boolean {
  const since = new Date(nowMs - CODE_COOLDOWN_MS).toISOString();
  return !!getDb().prepare("SELECT 1 FROM account_invite_codes WHERE player_id = ? AND created_at > ? AND kind <> 'manual'").get(playerId, since);
}

/**
 * Reserve a request for sending: in ONE transaction the request goes to
 * `sending` (a crash leaves it there, and a `sending` row is never sent again)
 * and the code's hash is stored, valid from now. Returns the plaintext code —
 * the only place it ever exists — or null when the request is no longer pending.
 */
export function reserveInviteSend(requestId: number, nowMs = Date.now()): { code: string; codeId: number } | null {
  const db = getDb();
  return db.transaction(() => {
    const r = db.prepare("SELECT * FROM chat_invite_requests WHERE id = ? AND status = 'pending'").get(requestId) as Record<string, unknown> | undefined;
    if (!r || r.player_id === null) return null;
    const now = new Date(nowMs).toISOString();
    db.prepare("UPDATE chat_invite_requests SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now, requestId);
    for (let tries = 0; tries < 5; tries++) {
      const code = generateCode();
      const inserted = db.prepare(
        `INSERT OR IGNORE INTO account_invite_codes (clan_id, player_id, chat_user_id, request_id, code_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(r.clan_id, r.player_id, r.sender_chat_id, requestId, hashCode(code), now, new Date(nowMs + CODE_TTL_MS).toISOString());
      if (inserted.changes > 0) return { code, codeId: Number(inserted.lastInsertRowid) };
    }
    throw new Error('could not generate a unique code');
  })();
}

/**
 * The send's outcome. `sent`: done. `refused` (nothing went out): the code is
 * withdrawn and the request waits for another try, up to three. `unknown` (it
 * may have gone out): the code stays valid and the request is never resent.
 * `muted` (refused because the scanner account is muted): the code is
 * withdrawn and the request waits, the try not counted — it wasn't the
 * request's fault.
 */
export function finishInviteSend(
  requestId: number,
  codeId: number,
  outcome: { status: 'sent'; messageId: number } | { status: 'refused'; error: string } | { status: 'unknown'; error: string },
  now = new Date().toISOString(),
  opts: { muted?: boolean } = {},
): void {
  const db = getDb();
  db.transaction(() => {
    if (outcome.status === 'sent') {
      db.prepare("UPDATE chat_invite_requests SET status = 'sent', reason = NULL, reply_message_id = ?, updated_at = ? WHERE id = ?")
        .run(outcome.messageId, now, requestId);
    } else if (outcome.status === 'refused' && opts.muted) {
      db.prepare('DELETE FROM account_invite_codes WHERE id = ? AND used_at IS NULL').run(codeId);
      db.prepare("UPDATE chat_invite_requests SET status = 'pending', reason = 'muted', attempts = MAX(attempts - 1, 0), updated_at = ? WHERE id = ?")
        .run(now, requestId);
    } else if (outcome.status === 'refused') {
      db.prepare('DELETE FROM account_invite_codes WHERE id = ? AND used_at IS NULL').run(codeId);
      const attempts = (db.prepare('SELECT attempts FROM chat_invite_requests WHERE id = ?').get(requestId) as { attempts: number } | undefined)?.attempts ?? 0;
      db.prepare('UPDATE chat_invite_requests SET status = ?, reason = ?, updated_at = ? WHERE id = ?')
        .run(attempts >= 3 ? 'failed' : 'pending', outcome.error.slice(0, 300), now, requestId);
    } else {
      db.prepare("UPDATE chat_invite_requests SET status = 'unknown', reason = ?, updated_at = ? WHERE id = ?")
        .run(outcome.error.slice(0, 300), now, requestId);
    }
  })();
}

// ── Welcome codes (unprompted, for players who join) ───────────────────────

/** A welcome code lasts longer: a new member may not read their chat for a while. */
export const WELCOME_CODE_TTL_MS = CODE_TTL_MS;
/**
 * Welcome codes go ONE at a time, at least this long after the scanner's last
 * invite DM (a reply counts too). On Nov 18 2026, 20 in three minutes got the
 * scanner account muted for an hour; one every 10 min is 6 an hour.
 */
export const WELCOME_MIN_GAP_MS = 10 * 60_000;
/** For a week after a mute the game may be stricter: the gap doubles. */
export const WELCOME_GAP_AFTER_MUTE_MS = 20 * 60_000;
export const MUTE_CAUTION_MS = 7 * 24 * 3600_000;
/** The gap before the next welcome code: doubled while a mute is less than a week old. */
export function welcomeGapMs(mutedAt: number | null, nowMs: number): number {
  return mutedAt !== null && nowMs - mutedAt < MUTE_CAUTION_MS ? WELCOME_GAP_AFTER_MUTE_MS : WELCOME_MIN_GAP_MS;
}
/** A run looks this far down the queue for the one player it can send to (the first may have no chat account yet). */
export const WELCOME_CANDIDATES_PER_RUN = 10;
/** A dry run sends nothing, so it lists everyone due at once (up to this many). */
export const WELCOME_DRY_RUN_LIMIT = 1000;
/** How long a join waits for its chat account to show up before it is given up. */
export const WELCOME_WAIT_MS = 24 * 3600_000;

/**
 *   waiting   the player's chat account isn't known yet / a refused send: tried again next scan
 *   dry-run   would have been sent (dry-run mode); never sent later
 *   sending   reserved; a crash leaves it here and it is never sent again
 *   sent      done
 *   unknown   may have gone out: never resent
 *   skipped   given up (reason): never sent
 */
export type WelcomeStatus = 'waiting' | 'dry-run' | 'sending' | 'sent' | 'unknown' | 'skipped';

export interface WelcomeCandidate { playerId: number; name: string; joinedAt: number; attempts: number }

const DUE_WHERE = `
  gp.clan_id = ? AND gp.in_clan = 1 AND gp.joined_at IS NOT NULL
  AND (? = 1 OR gp.joined_at * 1000 >= ?)
  AND (w.status IS NULL OR w.status = 'waiting' OR (? = 1 AND w.status = 'dry-run'))
  AND NOT EXISTS (SELECT 1 FROM user_game_links l WHERE l.player_id = gp.player_id)`;

/**
 * Players due a welcome code: on the roster now, no linked account, never a
 * welcome row past `waiting` (a dry-run row counts as not sent once `live`),
 * and either joined after `sinceMs` or — with `backlog` — any current member.
 * Recent joins first (they are the ones who just arrived), at most `limit`.
 */
export function welcomeCandidates(
  clanId: number,
  sinceMs: number,
  opts: { backlog?: boolean; live?: boolean; limit?: number } = {},
): WelcomeCandidate[] {
  const backlog = opts.backlog ? 1 : 0;
  const live = opts.live ? 1 : 0;
  return (getDb().prepare(
    `SELECT gp.player_id, gp.name, gp.joined_at, COALESCE(w.attempts, 0) AS attempts
       FROM game_players gp
       LEFT JOIN chat_invite_welcomes w ON w.clan_id = gp.clan_id AND w.player_id = gp.player_id
      WHERE ${DUE_WHERE}
      ORDER BY (gp.joined_at * 1000 >= ?) DESC, gp.joined_at DESC, gp.player_id LIMIT ?`,
  ).all(clanId, backlog, sinceMs, live, sinceMs, opts.limit ?? WELCOME_CANDIDATES_PER_RUN) as Array<{ player_id: number; name: string; joined_at: number; attempts: number }>)
    .map((r) => ({ playerId: r.player_id, name: r.name, joinedAt: r.joined_at, attempts: r.attempts }));
}

/**
 * The clan's welcome progress, over the members on the roster now: codes
 * sent (or possibly sent), still due, given up — "Codes sent: 34 of 98".
 * A member who linked an account on their own drops out of the count.
 */
export function welcomeProgress(clanId: number): { sent: number; due: number; skipped: number; total: number; backlogDue: number } {
  const s = getInviteSettings(clanId);
  const db = getDb();
  const counts = db.prepare(
    `SELECT
       SUM(CASE WHEN w.status IN ('sent', 'unknown', 'sending') THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN w.status = 'skipped' THEN 1 ELSE 0 END) AS skipped
       FROM chat_invite_welcomes w JOIN game_players gp ON gp.clan_id = w.clan_id AND gp.player_id = w.player_id AND gp.in_clan = 1
      WHERE w.clan_id = ?`,
  ).get(clanId) as { sent: number | null; skipped: number | null };
  const dueCount = (backlog: boolean): number => (db.prepare(
    `SELECT COUNT(*) AS n FROM game_players gp
       LEFT JOIN chat_invite_welcomes w ON w.clan_id = gp.clan_id AND w.player_id = gp.player_id
      WHERE ${DUE_WHERE}`,
  ).get(clanId, backlog ? 1 : 0, s.welcomeEnabledAt ?? Number.MAX_SAFE_INTEGER, 1) as { n: number }).n;
  const due = s.welcomeMode === 'off' && s.welcomeBacklogAt === null ? 0 : dueCount(s.welcomeBacklogAt !== null);
  const sent = counts.sent ?? 0;
  const skipped = counts.skipped ?? 0;
  // What the first switch-on would send to: every current member without an account.
  const backlogDue = s.welcomeBacklogAt === null ? dueCount(true) : 0;
  return { sent, due, skipped, total: sent + due + skipped, backlogDue };
}

export function setWelcomeStatus(
  clanId: number,
  c: { playerId: number; name: string; joinedAt: number },
  status: WelcomeStatus,
  reason: string | null,
  extra: { chatUserId?: string | null; channelUrl?: string | null; messageId?: number | null; countAttempt?: boolean } = {},
  now = new Date().toISOString(),
): void {
  getDb().prepare(
    `INSERT INTO chat_invite_welcomes (clan_id, player_id, player_name, joined_at, status, reason, chat_user_id, channel_url, attempts, message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, player_id) DO UPDATE SET
       player_name = excluded.player_name, joined_at = excluded.joined_at, status = excluded.status, reason = excluded.reason,
       chat_user_id = COALESCE(excluded.chat_user_id, chat_invite_welcomes.chat_user_id),
       channel_url = COALESCE(excluded.channel_url, chat_invite_welcomes.channel_url),
       attempts = chat_invite_welcomes.attempts + ?, message_id = COALESCE(excluded.message_id, chat_invite_welcomes.message_id),
       updated_at = excluded.updated_at`,
  ).run(clanId, c.playerId, c.name, c.joinedAt, status, reason, extra.chatUserId ?? null, extra.channelUrl ?? null,
    extra.countAttempt ? 1 : 0, extra.messageId ?? null, now, now, extra.countAttempt ? 1 : 0);
}

/**
 * The welcome codes sent in a clan, newest first, each with what became of it:
 * the account now linked to the player (whichever code they used), the
 * member it is (for a profile link) and when its code runs out.
 */
export function recentWelcomes(clanId: number, limit = 15): Array<{
  player: string; joinedAt: number | null; status: WelcomeStatus; reason: string | null; updatedAt: string;
  account: string | null; linkedAt: string | null; memberId: number | null; codeExpiresAt: string | null;
}> {
  return (getDb().prepare(
    `SELECT w.player_name, w.joined_at, w.status, w.reason, w.updated_at,
            u.username AS account, l.linked_at,
            (SELECT m.id FROM members m WHERE m.clan_id = w.clan_id AND m.game_player_id = w.player_id
              ORDER BY m.is_active DESC, m.id DESC LIMIT 1) AS member_id,
            (SELECT MAX(c.expires_at) FROM account_invite_codes c
              WHERE c.clan_id = w.clan_id AND c.player_id = w.player_id AND c.kind = 'welcome') AS code_expires_at
       FROM chat_invite_welcomes w
       LEFT JOIN user_game_links l ON l.clan_id = w.clan_id AND l.player_id = w.player_id
       LEFT JOIN users u ON u.id = l.user_id
      WHERE w.clan_id = ? ORDER BY w.updated_at DESC LIMIT ?`,
  ).all(clanId, limit) as Array<{
    player_name: string; joined_at: number | null; status: WelcomeStatus; reason: string | null; updated_at: string;
    account: string | null; linked_at: string | null; member_id: number | null; code_expires_at: string | null;
  }>).map((r) => ({
    player: r.player_name, joinedAt: r.joined_at, status: r.status, reason: r.reason, updatedAt: r.updated_at,
    account: r.account, linkedAt: r.linked_at, memberId: r.member_id, codeExpiresAt: r.code_expires_at,
  }));
}

/** Key of {@link memberIdsByPlayer}'s map: a game player in one clan. */
export function playerKey(clanId: number, playerId: number): string {
  return `${clanId}:${playerId}`;
}

/**
 * The member each game player is, per clan (one at most: members are unique
 * on clan + game player): what a profile link opens (#member/<id>). One clan,
 * or every clan with null.
 */
export function memberIdsByPlayer(clanId: number | null): Map<string, number> {
  const rows = getDb().prepare(
    `SELECT clan_id, game_player_id, id FROM members
      WHERE game_player_id IS NOT NULL${clanId === null ? '' : ' AND clan_id = ?'}`,
  ).all(...(clanId === null ? [] : [clanId])) as Array<{ clan_id: number; game_player_id: number; id: number }>;
  return new Map(rows.map((r) => [playerKey(r.clan_id, r.game_player_id), r.id]));
}

/**
 * Reserve a welcome send, like reserveInviteSend: in one transaction the row
 * goes to `sending` and the code's hash is stored (72 h, single use, bound to
 * the clan and the player). Null when the row is already past `waiting`.
 */
export function reserveWelcomeSend(
  clanId: number,
  c: { playerId: number; name: string; joinedAt: number },
  chatUserId: string,
  channelUrl: string,
  nowMs = Date.now(),
): { code: string; codeId: number } | null {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT status FROM chat_invite_welcomes WHERE clan_id = ? AND player_id = ?').get(clanId, c.playerId) as { status: string } | undefined;
    // Only a join still waiting, or one a dry run listed, may be sent — never twice.
    if (row && row.status !== 'waiting' && row.status !== 'dry-run') return null;
    const now = new Date(nowMs).toISOString();
    setWelcomeStatus(clanId, c, 'sending', null, { chatUserId, channelUrl, countAttempt: true }, now);
    for (let tries = 0; tries < 5; tries++) {
      const code = generateCode();
      const inserted = db.prepare(
        `INSERT OR IGNORE INTO account_invite_codes (clan_id, player_id, chat_user_id, kind, request_id, code_hash, created_at, expires_at)
         VALUES (?, ?, ?, 'welcome', NULL, ?, ?, ?)`,
      ).run(clanId, c.playerId, chatUserId, hashCode(code), now, new Date(nowMs + WELCOME_CODE_TTL_MS).toISOString());
      if (inserted.changes > 0) return { code, codeId: Number(inserted.lastInsertRowid) };
    }
    throw new Error('could not generate a unique code');
  })();
}

/**
 * The welcome send's outcome: refused → the code is withdrawn and the join
 * waits (three tries); unknown → never resent; `muted` (the scanner account
 * is muted) → withdrawn and waiting, the try not counted.
 */
export function finishWelcomeSend(
  clanId: number,
  c: { playerId: number; name: string; joinedAt: number },
  codeId: number,
  outcome: { status: 'sent'; messageId: number } | { status: 'refused'; error: string } | { status: 'unknown'; error: string },
  now = new Date().toISOString(),
  opts: { muted?: boolean } = {},
): void {
  const db = getDb();
  db.transaction(() => {
    if (outcome.status === 'sent') {
      setWelcomeStatus(clanId, c, 'sent', null, { messageId: outcome.messageId }, now);
    } else if (outcome.status === 'refused' && opts.muted) {
      db.prepare('DELETE FROM account_invite_codes WHERE id = ? AND used_at IS NULL').run(codeId);
      setWelcomeStatus(clanId, c, 'waiting', 'muted', {}, now);
      db.prepare('UPDATE chat_invite_welcomes SET attempts = MAX(attempts - 1, 0) WHERE clan_id = ? AND player_id = ?').run(clanId, c.playerId);
    } else if (outcome.status === 'refused') {
      db.prepare('DELETE FROM account_invite_codes WHERE id = ? AND used_at IS NULL').run(codeId);
      const attempts = (db.prepare('SELECT attempts FROM chat_invite_welcomes WHERE clan_id = ? AND player_id = ?')
        .get(clanId, c.playerId) as { attempts: number } | undefined)?.attempts ?? 0;
      setWelcomeStatus(clanId, c, attempts >= 3 ? 'skipped' : 'waiting', outcome.error.slice(0, 300), {}, now);
    } else {
      setWelcomeStatus(clanId, c, 'unknown', outcome.error.slice(0, 300), {}, now);
    }
  })();
}

// ── Codes made by hand (an admin, on the site) ─────────────────────────────

/** At most this many unused codes made by hand per clan at once. */
export const MANUAL_OPEN_LIMIT = 50;

/**
 * Why an admin can't make a code for this player now, or null when they can:
 *   not-on-roster   not in the clan's roster (the code would not work)
 *   has-account     already linked to an account: a code from a clan admin
 *                   could only take that account over, so only the
 *                   superadmin may make one (it then resets the password)
 *   superadmin      linked to a superadmin: no code ever resets that
 *   too-many        MANUAL_OPEN_LIMIT unused codes already
 */
export type ManualCodeBlocker = 'not-on-roster' | 'has-account' | 'superadmin' | 'too-many';

export function manualCodeBlocker(clanId: number, playerId: number, issuer: { role: string }, nowMs = Date.now()): ManualCodeBlocker | null {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM game_players WHERE clan_id = ? AND player_id = ? AND in_clan = 1').get(clanId, playerId)) return 'not-on-roster';
  const owner = accountForPlayer(playerId);
  if (owner !== null) {
    if (getUserById(owner)?.role === 'superadmin') return 'superadmin';
    if (issuer.role !== 'superadmin') return 'has-account';
  }
  // The player's own earlier code is replaced, so it doesn't count.
  const open = (db.prepare(
    "SELECT COUNT(*) AS n FROM account_invite_codes WHERE clan_id = ? AND kind = 'manual' AND used_at IS NULL AND expires_at > ? AND player_id <> ?",
  ).get(clanId, new Date(nowMs).toISOString(), playerId) as { n: number }).n;
  return open >= MANUAL_OPEN_LIMIT ? 'too-many' : null;
}

/**
 * Make a code by hand: the same code as the chat's — 72 hours, single use,
 * bound to the clan and the player — with no chat account behind it and the
 * issuing account kept. The player's earlier unused code made by hand is
 * withdrawn (one at a time). Returns the plaintext, the only place it ever
 * exists. Callers check {@link manualCodeBlocker} first.
 */
export function issueManualCode(
  clanId: number,
  playerId: number,
  issuerId: number,
  nowMs = Date.now(),
): { code: string; codeId: number; expiresAt: string; replaced: number } {
  const db = getDb();
  return db.transaction(() => {
    const now = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + CODE_TTL_MS).toISOString();
    const replaced = db.prepare(
      "DELETE FROM account_invite_codes WHERE clan_id = ? AND player_id = ? AND kind = 'manual' AND used_at IS NULL",
    ).run(clanId, playerId).changes;
    for (let tries = 0; tries < 5; tries++) {
      const code = generateCode();
      const inserted = db.prepare(
        `INSERT OR IGNORE INTO account_invite_codes (clan_id, player_id, chat_user_id, kind, request_id, code_hash, created_at, expires_at, issued_by)
         VALUES (?, ?, '', 'manual', NULL, ?, ?, ?, ?)`,
      ).run(clanId, playerId, hashCode(code), now, expiresAt, issuerId);
      if (inserted.changes > 0) return { code, codeId: Number(inserted.lastInsertRowid), expiresAt, replaced };
    }
    throw new Error('could not generate a unique code');
  })();
}

/** Withdraw an unused code made by hand. The player it was for, or null when there was no such code. */
export function withdrawManualCode(clanId: number, codeId: number): { playerId: number; player: string | null } | null {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(
      `SELECT c.player_id, gp.name FROM account_invite_codes c
         LEFT JOIN game_players gp ON gp.clan_id = c.clan_id AND gp.player_id = c.player_id
        WHERE c.id = ? AND c.clan_id = ? AND c.kind = 'manual' AND c.used_at IS NULL`,
    ).get(codeId, clanId) as { player_id: number; name: string | null } | undefined;
    if (!row) return null;
    db.prepare('DELETE FROM account_invite_codes WHERE id = ?').run(codeId);
    return { playerId: row.player_id, player: row.name ?? null };
  })();
}

export interface ManualCodeRow {
  id: number;
  player: string;
  memberId: number | null;
  issuedBy: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
}

/** The clan's codes made by hand, newest first — who made each and what became of it (never the code). */
export function manualCodes(clanId: number, limit = 30): ManualCodeRow[] {
  return (getDb().prepare(
    `SELECT c.id, c.created_at, c.expires_at, c.used_at,
            COALESCE(gp.name, '#' || c.player_id) AS player, iu.username AS issued_by, uu.username AS used_by,
            (SELECT m.id FROM members m WHERE m.clan_id = c.clan_id AND m.game_player_id = c.player_id
              ORDER BY m.is_active DESC, m.id DESC LIMIT 1) AS member_id
       FROM account_invite_codes c
       LEFT JOIN game_players gp ON gp.clan_id = c.clan_id AND gp.player_id = c.player_id
       LEFT JOIN users iu ON iu.id = c.issued_by
       LEFT JOIN users uu ON uu.id = c.used_by
      WHERE c.clan_id = ? AND c.kind = 'manual'
      ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
  ).all(clanId, limit) as Array<{
    id: number; created_at: string; expires_at: string; used_at: string | null;
    player: string; issued_by: string | null; used_by: string | null; member_id: number | null;
  }>).map((r) => ({
    id: r.id, player: r.player, memberId: r.member_id, issuedBy: r.issued_by,
    createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at, usedBy: r.used_by,
  }));
}

/** The roster to pick a player from: everyone in the clan now, with the account each is linked to. */
export function rosterForCodes(clanId: number): Array<{ playerId: number; name: string; rank: number | null; account: string | null }> {
  return (getDb().prepare(
    `SELECT gp.player_id, gp.name, gp.role,
            (SELECT u.username FROM user_game_links l JOIN users u ON u.id = l.user_id
              WHERE l.player_id = gp.player_id ORDER BY l.linked_at LIMIT 1) AS account
       FROM game_players gp
      WHERE gp.clan_id = ? AND gp.in_clan = 1
      ORDER BY gp.name COLLATE NOCASE, gp.player_id`,
  ).all(clanId) as Array<{ player_id: number; name: string; role: number | null; account: string | null }>)
    .map((r) => ({ playerId: r.player_id, name: r.name, rank: r.role ?? null, account: r.account }));
}

export interface CodeInfo {
  codeId: number;
  clanId: number;
  clanName: string;
  playerId: number;
  playerName: string;
  rank: number | null;
  chatUserId: string;
  expiresAt: string;
  /** 'reply' / 'welcome' (sent in the chat) or 'manual' (made by an admin on the site). */
  kind: string;
  /** The account that made a 'manual' code; null otherwise (or once it was deleted). */
  issuedBy: number | null;
}

/**
 * A code that can be used right now: known, unused, unexpired, its clan live
 * and its player still on that clan's roster. Null otherwise — the reason is
 * deliberately not told apart (no oracle for guessing).
 */
export function lookupCode(input: string, nowMs = Date.now()): CodeInfo | null {
  const normalized = normalizeCode(input);
  if (normalized.length !== CODE_LENGTH) return null;
  const r = getDb().prepare(
    `SELECT c.id, c.clan_id, c.player_id, c.chat_user_id, c.expires_at, c.kind, c.issued_by, cl.name AS clan_name, cl.short_code,
            gp.name AS player_name, gp.role AS rank
       FROM account_invite_codes c
       JOIN clans cl ON cl.id = c.clan_id AND cl.deleted_at = ''
       JOIN game_players gp ON gp.clan_id = c.clan_id AND gp.player_id = c.player_id AND gp.in_clan = 1
      WHERE c.code_hash = ? AND c.used_at IS NULL AND c.expires_at > ?`,
  ).get(hashCode(normalized), new Date(nowMs).toISOString()) as Record<string, unknown> | undefined;
  if (!r) return null;
  const code = String(r.short_code ?? '').trim();
  return {
    codeId: r.id as number,
    clanId: r.clan_id as number,
    clanName: code ? `${code} - ${r.clan_name as string}` : r.clan_name as string,
    playerId: r.player_id as number,
    playerName: r.player_name as string,
    rank: (r.rank as number | null) ?? null,
    chatUserId: r.chat_user_id as string,
    expiresAt: r.expires_at as string,
    kind: String(r.kind ?? 'reply'),
    issuedBy: (r.issued_by as number | null) ?? null,
  };
}

// ── Links ───────────────────────────────────────────────────────────────────

export interface GameLink {
  userId: number;
  clanId: number;
  playerId: number;
  playerName: string;
  chatUserId: string;
  rank: number | null;
  onRoster: boolean;
  linkedAt: string;
}

function rowToLink(r: Record<string, unknown>): GameLink {
  return {
    userId: r.user_id as number,
    clanId: r.clan_id as number,
    playerId: r.player_id as number,
    playerName: r.player_name as string,
    chatUserId: r.chat_user_id as string,
    rank: (r.rank as number | null) ?? null,
    onRoster: r.on_roster === 1,
    linkedAt: r.linked_at as string,
  };
}

export function linksForUser(userId: number): GameLink[] {
  return (getDb().prepare('SELECT * FROM user_game_links WHERE user_id = ? ORDER BY clan_id, linked_at, player_id').all(userId) as Record<string, unknown>[]).map(rowToLink);
}

export function allGameLinks(): GameLink[] {
  return (getDb().prepare('SELECT * FROM user_game_links ORDER BY user_id, clan_id, linked_at, player_id').all() as Record<string, unknown>[]).map(rowToLink);
}

export function linksForClan(clanId: number): GameLink[] {
  return (getDb().prepare('SELECT * FROM user_game_links WHERE clan_id = ? ORDER BY user_id, linked_at, player_id').all(clanId) as Record<string, unknown>[]).map(rowToLink);
}

/** Every player the account is linked to in one clan (alts, v130), earliest first. */
export function linksInClan(userId: number, clanId: number): GameLink[] {
  return (getDb().prepare('SELECT * FROM user_game_links WHERE user_id = ? AND clan_id = ? ORDER BY linked_at, player_id')
    .all(userId, clanId) as Record<string, unknown>[]).map(rowToLink);
}

/**
 * The account's MAIN player in a clan — the one it plays as there and whose
 * picture it shows: the one it picked (user_clan_main), else its earliest
 * link. Null when it has none there.
 */
export function mainLink(userId: number, clanId: number): GameLink | null {
  const links = linksInClan(userId, clanId);
  if (!links.length) return null;
  const picked = getDb().prepare('SELECT player_id FROM user_clan_main WHERE user_id = ? AND clan_id = ?')
    .get(userId, clanId) as { player_id: number } | undefined;
  return (picked && links.find((l) => l.playerId === picked.player_id)) || links[0];
}

/** Pick which of its players the account plays as in a clan. False when it isn't linked to that player there. */
export function setMainPlayer(userId: number, clanId: number, playerId: number): boolean {
  if (!linksInClan(userId, clanId).some((l) => l.playerId === playerId)) return false;
  getDb().prepare(
    `INSERT INTO user_clan_main (user_id, clan_id, player_id, set_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, clan_id) DO UPDATE SET player_id = excluded.player_id, set_at = excluded.set_at`,
  ).run(userId, clanId, playerId, new Date().toISOString());
  return true;
}

/** The account's main link in a clan (see mainLink); null when it has none there. */
export function linkFor(userId: number, clanId: number): GameLink | null {
  return mainLink(userId, clanId);
}

/** The game player an account plays as in a clan (its main), or null (old, unlinked accounts). */
export function linkedGamePlayerId(userId: number, clanId: number): number | null {
  return mainLink(userId, clanId)?.playerId ?? null;
}

/** Every game player id the account is linked to in a clan (the Members board's "You"). */
export function linkedPlayerIds(userId: number, clanId: number): number[] {
  return linksInClan(userId, clanId).map((l) => l.playerId);
}

/** The account a game player is linked to (any clan), or null. */
export function accountForPlayer(playerId: number): number | null {
  const r = getDb().prepare('SELECT user_id FROM user_game_links WHERE player_id = ? ORDER BY linked_at LIMIT 1').get(playerId) as { user_id: number } | undefined;
  return r?.user_id ?? null;
}

/** The chat account (tb:<n>) a player's codes go to, once linked; null before. */
export function pinnedChatUserFor(playerId: number): string | null {
  const r = getDb().prepare(
    "SELECT chat_user_id FROM user_game_links WHERE player_id = ? AND chat_user_id <> '' ORDER BY linked_at LIMIT 1",
  ).get(playerId) as { chat_user_id: string } | undefined;
  return r?.chat_user_id ?? null;
}

/**
 * The role the account's linked players give it in a clan: admin when ANY of
 * them on the roster is Leader or Superior, user when some are on the roster,
 * null when none of them is (the account has no access there from the game).
 */
export function linkedClanRole(userId: number, clanId: number): ClanRole | null {
  const on = linksInClan(userId, clanId).filter((l) => l.onRoster);
  if (!on.length) return null;
  return on.some((l) => rankRole(l.rank) === 'admin') ? 'admin' : 'user';
}

/**
 * Whether the account can be used at all: false only for a linked account
 * whose home-clan players have ALL left that clan in the game and that has no
 * other clan it is still in (ensureHomeOnRoster moves the home when it does).
 */
export function isAccountBlocked(userId: number): boolean {
  return !!getDb().prepare(
    `SELECT 1 FROM users u JOIN user_game_links l ON l.user_id = u.id AND l.clan_id = u.clan_id
      WHERE u.id = ? AND u.role <> 'superadmin'
      GROUP BY u.id HAVING SUM(l.on_roster) = 0`,
  ).get(userId);
}

/** Give the account `role` in `clanId`: the home role, or an extra-clan grant. */
function applyClanRole(userId: number, clanId: number, role: ClanRole): { from: ClanRole | null; to: ClanRole } {
  const db = getDb();
  const u = db.prepare('SELECT role, clan_id FROM users WHERE id = ?').get(userId) as { role: string; clan_id: number | null } | undefined;
  if (!u || u.role === 'superadmin') return { from: null, to: role };
  if (u.clan_id === clanId) {
    if (u.role !== role) db.prepare("UPDATE users SET role = ? WHERE id = ? AND role <> 'superadmin'").run(role, userId);
    return { from: u.role as ClanRole, to: role };
  }
  const from = getClanAccessRole(userId, clanId);
  if (from !== role) {
    db.prepare(
      `INSERT INTO user_clan_access (user_id, clan_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, clan_id) DO UPDATE SET role = excluded.role`,
    ).run(userId, clanId, role, new Date().toISOString());
  }
  return { from, to: role };
}

/**
 * When the account's home clan is a linked clan all its players there have
 * left, and it is still in another linked clan, that clan becomes the home
 * (the old home is not kept as an extra: they left it). Nothing to do otherwise.
 */
export function ensureHomeOnRoster(userId: number): void {
  const db = getDb();
  const u = db.prepare('SELECT role, clan_id FROM users WHERE id = ?').get(userId) as { role: string; clan_id: number | null } | undefined;
  if (!u || u.role === 'superadmin' || u.clan_id === null) return;
  if (!linksInClan(userId, u.clan_id).length || linkedClanRole(userId, u.clan_id) !== null) return;
  const next = db.prepare(
    `SELECT l.clan_id FROM user_game_links l JOIN clans c ON c.id = l.clan_id AND c.deleted_at = ''
      WHERE l.user_id = ? AND l.clan_id <> ? AND l.on_roster = 1 ORDER BY l.linked_at LIMIT 1`,
  ).get(userId, u.clan_id) as { clan_id: number } | undefined;
  if (!next) return;
  const extras = listClanAccess(userId).filter((a) => a.clanId !== next.clan_id);
  setHomeAndClanAccess(userId, { clanId: next.clan_id, role: linkedClanRole(userId, next.clan_id) ?? 'user' }, extras);
  logSystemAction(next.clan_id, 'account.home_moved', { userId, from: u.clan_id, to: next.clan_id, source: 'game' });
}

/**
 * After a scan read the clan's roster: every linked player is marked on or
 * off the roster with its rank, then each account gets the role its players
 * there give it (any Leader/Superior on the roster → admin; linkedClanRole),
 * loses the clan only when NONE of its players is still on the roster, and
 * gets it back when one returns. A short roster (a partial read) changes no
 * access. Superadmins are never touched. Every change is audited (source 'game').
 */
export function syncLinkedAccounts(
  clanId: number,
  roster: Array<{ playerId: number; role: number; name?: string }>,
  now = new Date().toISOString(),
): { roleChanges: number; left: number; rejoined: number } {
  const out = { roleChanges: 0, left: 0, rejoined: 0 };
  if (roster.length < MIN_ROSTER_FOR_ACCESS_CHANGES) return out;
  const db = getDb();
  const byPlayer = new Map(roster.map((m) => [m.playerId, m]));
  const links = db.prepare(
    `SELECT l.*, u.role AS user_role, u.clan_id AS home_clan_id, u.username
       FROM user_game_links l JOIN users u ON u.id = l.user_id WHERE l.clan_id = ?`,
  ).all(clanId) as Array<Record<string, unknown>>;
  const accounts = new Map<number, { username: string; home: number | null; changed: Array<{ playerId: number; player: string; fromRank: number | null; toRank: number | null }> }>();
  db.transaction(() => {
    // 1. Every linked player: on or off the roster, with its rank now.
    for (const row of links) {
      const link = rowToLink(row);
      // A superadmin's players (their own, linked with a code) stay current —
      // rank, name, on the roster or not — but the account itself is never
      // touched: no role, grant, home or block follows from the game.
      const isSuper = row.user_role === 'superadmin';
      const acct = accounts.get(link.userId) ?? { username: row.username as string, home: (row.home_clan_id as number | null) ?? null, changed: [] };
      if (!isSuper) accounts.set(link.userId, acct);
      const m = byPlayer.get(link.playerId);
      if (m) {
        if (!link.onRoster) {
          out.rejoined++;
          logSystemAction(clanId, 'account.rejoined_in_game', { userId: link.userId, username: acct.username, playerId: link.playerId, player: m.name ?? link.playerName, source: 'game' });
        }
        if (link.rank !== m.role) acct.changed.push({ playerId: link.playerId, player: m.name ?? link.playerName, fromRank: link.rank, toRank: m.role });
        db.prepare('UPDATE user_game_links SET on_roster = 1, rank = ?, player_name = ?, synced_at = ? WHERE user_id = ? AND clan_id = ? AND player_id = ?')
          .run(m.role, m.name || link.playerName, now, link.userId, clanId, link.playerId);
      } else {
        if (link.onRoster) {
          out.left++;
          logSystemAction(clanId, 'account.left_in_game', { userId: link.userId, username: acct.username, playerId: link.playerId, player: link.playerName, source: 'game' });
        }
        db.prepare('UPDATE user_game_links SET on_roster = 0, synced_at = ? WHERE user_id = ? AND clan_id = ? AND player_id = ?')
          .run(now, link.userId, clanId, link.playerId);
      }
    }
    // 2. Each account: the role its players give it, both directions; no
    //    access only when none of them is on the roster.
    for (const [userId, acct] of accounts) {
      const role = linkedClanRole(userId, clanId);
      if (role === null) {
        if (acct.home !== clanId) removeClanAccess(userId, clanId);
        continue;
      }
      const { from, to } = applyClanRole(userId, clanId, role);
      if (from !== to) {
        out.roleChanges++;
        logSystemAction(clanId, from === null ? 'account.clan_access_from_game' : 'account.role_from_game', {
          // The player whose rank decided it on top (what the audit view reads), every alt that moved beside.
          userId, username: acct.username, ...(acct.changed[0] ?? {}), from, to,
          ...(acct.changed.length > 1 ? { players: acct.changed } : {}), source: 'game',
        });
      }
    }
    for (const userId of accounts.keys()) ensureHomeOnRoster(userId);
  })();
  return out;
}

/**
 * Superadmin: forget an account's link to its players in a clan — one player
 * (`playerId`) or all of them. The account keeps the access and role it has
 * now, as a plain (old-style) grant. Returns the links removed.
 */
export function unlinkGameAccount(userId: number, clanId: number, playerId?: number): GameLink[] {
  const links = linksInClan(userId, clanId).filter((l) => playerId === undefined || l.playerId === playerId);
  if (!links.length) return [];
  const db = getDb();
  db.transaction(() => {
    for (const l of links) db.prepare('DELETE FROM user_game_links WHERE user_id = ? AND clan_id = ? AND player_id = ?').run(userId, clanId, l.playerId);
    db.prepare(
      'DELETE FROM user_clan_main WHERE user_id = ? AND clan_id = ? AND player_id NOT IN (SELECT player_id FROM user_game_links WHERE user_id = ? AND clan_id = ?)',
    ).run(userId, clanId, userId, clanId);
  })();
  return links;
}

// ── Joining with a code ─────────────────────────────────────────────────────

/**
 *   new           signed out, the player has no account yet → create one
 *   recover       signed out, the player's account exists → new password
 *   link          signed in, this clan is the account's own (home or extra)
 *                 but it isn't linked to a player here yet → link it
 *   add-clan      signed in, a clan the account doesn't have → add it
 *   add-player    signed in, the account already has a player in this clan
 *                 → add this one too (an alt; v130)
 *   already       signed in, already linked to this player here
 *   link-player   signed in as the superadmin → link the player to the account
 *                 and nothing else: a superadmin holds no grants and its role,
 *                 home and access never follow the game
 *   conflict      the player is linked to a different account
 *   superadmin-recover  signed out, the player's account is a superadmin:
 *                 refused — a code from the game never resets a superadmin's
 *                 password (a shared game account must not open the site's top role)
 *   manual-recover  signed out, the player has an account, and the code was
 *                 made by hand by someone other than the superadmin: refused —
 *                 it would hand a clan admin the account (and its other clans)
 */
export type JoinMode = 'new' | 'recover' | 'link' | 'add-clan' | 'add-player' | 'link-player' | 'already' | 'conflict' | 'superadmin-recover' | 'manual-recover';
export const JOIN_ACTIONS: ReadonlySet<JoinMode> = new Set(['new', 'recover', 'link', 'add-clan', 'add-player', 'link-player']);

export interface JoinPlan {
  mode: JoinMode;
  /** The account the code acts on (recover, link, add-clan, add-player, already). */
  userId: number | null;
  username: string | null;
  /** The role the account will hold in the code's clan. */
  role: ClanRole;
}

/** What a code would do for this viewer (null = signed out). Reads only. */
export function planJoin(info: CodeInfo, viewer: User | null): JoinPlan {
  const role = rankRole(info.rank);
  const owner = accountForPlayer(info.playerId);
  if (!viewer) {
    if (owner === null) return { mode: 'new', userId: null, username: null, role };
    const u = getUserById(owner);
    if (u?.role === 'superadmin') return { mode: 'superadmin-recover', userId: null, username: null, role };
    // A code made by hand proves only that an admin made it, not who holds it:
    // it resets a password only when the superadmin made it. Decided now, not
    // when it was made — the player may have made an account since.
    if (info.kind === 'manual' && !(info.issuedBy !== null && getUserById(info.issuedBy)?.role === 'superadmin')) {
      return { mode: 'manual-recover', userId: null, username: null, role };
    }
    return { mode: 'recover', userId: owner, username: u?.username ?? null, role };
  }
  const home = getUserById(viewer.id);
  if (!home) return { mode: 'conflict', userId: null, username: null, role };
  if (owner !== null && owner !== viewer.id) return { mode: 'conflict', userId: null, username: null, role };
  const here = linksInClan(viewer.id, info.clanId);
  if (here.some((l) => l.playerId === info.playerId)) return { mode: 'already', userId: viewer.id, username: home.username, role };
  if (home.role === 'superadmin') return { mode: 'link-player', userId: viewer.id, username: home.username, role };
  if (here.length) {
    // An alt: the account's role there is the best its players give it.
    const now = linkedClanRole(viewer.id, info.clanId);
    return { mode: 'add-player', userId: viewer.id, username: home.username, role: now === 'admin' || role === 'admin' ? 'admin' : 'user' };
  }
  const hasClan = home.clanId === info.clanId || getClanAccessRole(viewer.id, info.clanId) !== null;
  return { mode: hasClan ? 'link' : 'add-clan', userId: viewer.id, username: home.username, role };
}

function insertLink(userId: number, info: CodeInfo, now: string): void {
  getDb().prepare(
    `INSERT INTO user_game_links (user_id, clan_id, player_id, player_name, chat_user_id, rank, on_roster, linked_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(userId, info.clanId, info.playerId, info.playerName, info.chatUserId, info.rank, now, now);
}

function consumeCode(codeId: number, userId: number, now: string): boolean {
  return getDb().prepare('UPDATE account_invite_codes SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL')
    .run(now, userId, codeId).changes > 0;
}

export class JoinError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'JoinError';
  }
}

/**
 * Carry out the plan in one transaction: the code is consumed exactly once
 * (a second use, or a race, fails as invalid), the link and the account's
 * role in the clan are written together. Callers validate username and
 * password against the policies first.
 */
export function redeemJoin(
  input: string,
  viewer: User | null,
  creds: { username?: string; password?: string },
  nowMs = Date.now(),
): { mode: JoinMode; user: User; clanId: number } {
  const db = getDb();
  const now = new Date(nowMs).toISOString();
  return db.transaction(() => {
    const info = lookupCode(input, nowMs);
    if (!info) throw new JoinError('This code is not valid or has expired.', 404);
    const plan = planJoin(info, viewer);
    if (!JOIN_ACTIONS.has(plan.mode)) throw new JoinError(plan.mode, 409);

    let userId: number;
    if (plan.mode === 'new') {
      if (!creds.username || !creds.password) throw new JoinError('Username and password required');
      const taken = db.prepare('SELECT 1 FROM users WHERE username = ?').get(creds.username.trim());
      if (taken) throw new JoinError('Username already exists', 409);
      userId = createUser(creds.username, creds.password, plan.role, undefined, info.clanId).id;
      insertLink(userId, info, now);
    } else if (plan.mode === 'link-player') {
      // The superadmin: the link and nothing else (no grant, role or home).
      userId = plan.userId!;
      insertLink(userId, info, now);
    } else if (plan.mode === 'recover') {
      if (!creds.password) throw new JoinError('Password required');
      userId = plan.userId!;
      changePassword(userId, creds.password);
      if (!linksInClan(userId, info.clanId).some((l) => l.playerId === info.playerId)) {
        insertLink(userId, info, now);
        applyClanRole(userId, info.clanId, linkedClanRole(userId, info.clanId) ?? plan.role);
      }
      ensureHomeOnRoster(userId);
      // Every session the account had ends: whoever held the old password is out.
      db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
    } else {
      userId = plan.userId!;
      insertLink(userId, info, now);
      applyClanRole(userId, info.clanId, linkedClanRole(userId, info.clanId) ?? plan.role);
      ensureHomeOnRoster(userId);
    }
    if (!consumeCode(info.codeId, userId, now)) throw new JoinError('This code is not valid or has expired.', 404);
    const user = getUserById(userId)!;
    logSystemAction(info.clanId, `account.join.${plan.mode}`, {
      userId, username: user.username, playerId: info.playerId, player: info.playerName, role: plan.role, rank: info.rank, source: 'game',
    });
    return { mode: plan.mode, user, clanId: info.clanId };
  })();
}
