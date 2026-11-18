/**
 * The scanner account's own messages, per clan (v131): when it last sent an
 * invite DM (welcome codes keep WELCOME_MIN_GAP_MS apart), and a pause after
 * the game muted it.
 *
 * The game mutes an account that sends too many messages — on Nov 18 2026,
 * CWB's scanner after 20 welcome codes in three minutes, for about an hour.
 * While muted every send comes back "You are muted." for EVERY recipient: it
 * is our account that is muted, not the players. So a mute pauses all of the
 * clan's sending (code replies, welcome codes, the daily digest) without a
 * single try until the pause is over, and a mute again right after grows the
 * pause (MUTE_BACKOFF_MS). A send that gets through resets it.
 * See docs/account-invites.md.
 */
import { getDb } from '../database.js';

/**
 * How long sending pauses after a mute: the game's mute was about an hour,
 * so the first pause is a little longer; mutes in a row (the first message
 * after a pause muted again) wait longer each time.
 */
export const MUTE_BACKOFF_MS: readonly number[] = [75 * 60_000, 3 * 3600_000, 12 * 3600_000, 24 * 3600_000];

export interface ChatSendState {
  /** Epoch ms of the last invite DM tried (reply or welcome). */
  lastSendAt: number | null;
  /** Epoch ms sending may start again after a mute; null = never muted. */
  pausedUntil: number | null;
  /** Epoch ms the latest mute was seen. */
  mutedAt: number | null;
  /** Mutes in a row (a send that gets through resets it). */
  muteCount: number;
  lastError: string | null;
}

const EMPTY: ChatSendState = { lastSendAt: null, pausedUntil: null, mutedAt: null, muteCount: 0, lastError: null };

export function getChatSendState(clanId: number): ChatSendState {
  const r = getDb().prepare(
    'SELECT last_send_at, paused_until, muted_at, mute_count, last_error FROM chat_send_state WHERE clan_id = ?',
  ).get(clanId) as { last_send_at: number | null; paused_until: number | null; muted_at: number | null; mute_count: number; last_error: string | null } | undefined;
  if (!r) return { ...EMPTY };
  return { lastSendAt: r.last_send_at, pausedUntil: r.paused_until, mutedAt: r.muted_at, muteCount: r.mute_count, lastError: r.last_error };
}

function save(clanId: number, s: ChatSendState, nowMs: number): void {
  getDb().prepare(
    `INSERT INTO chat_send_state (clan_id, last_send_at, paused_until, muted_at, mute_count, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id) DO UPDATE SET last_send_at = excluded.last_send_at, paused_until = excluded.paused_until,
       muted_at = excluded.muted_at, mute_count = excluded.mute_count, last_error = excluded.last_error, updated_at = excluded.updated_at`,
  ).run(clanId, s.lastSendAt, s.pausedUntil, s.mutedAt, s.muteCount, s.lastError, new Date(nowMs).toISOString());
}

/** When the clan's sending may start again, while a mute's pause runs; null when nothing is paused. */
export function chatPausedUntil(clanId: number, nowMs = Date.now()): number | null {
  const until = getChatSendState(clanId).pausedUntil;
  return until !== null && until > nowMs ? until : null;
}

/** An invite DM is about to go out (stamped before the send, whatever comes of it). */
export function noteChatSendAttempt(clanId: number, nowMs = Date.now()): void {
  save(clanId, { ...getChatSendState(clanId), lastSendAt: nowMs }, nowMs);
}

/** A message got through: the account isn't muted (any more), the backoff starts over. */
export function noteChatSent(clanId: number, nowMs = Date.now()): void {
  const s = getChatSendState(clanId);
  if (s.muteCount === 0 && s.lastError === null) return;
  save(clanId, { ...s, muteCount: 0, lastError: null }, nowMs);
}

/** Past the mute's own end, when the chat service says it: clocks differ a little. */
export const MUTE_END_MARGIN_MS = 2 * 60_000;

/**
 * The game refused a message with "You are muted.": pause the clan's sending
 * at once, for the backoff's guess. Returns when sending may start again.
 */
export function noteChatMuted(clanId: number, error: string, nowMs = Date.now()): number {
  const s = getChatSendState(clanId);
  const pausedUntil = nowMs + MUTE_BACKOFF_MS[Math.min(s.muteCount, MUTE_BACKOFF_MS.length - 1)];
  save(clanId, { ...s, pausedUntil, mutedAt: nowMs, muteCount: s.muteCount + 1, lastError: error.slice(0, 300) }, nowMs);
  return pausedUntil;
}

/**
 * The chat service told us when the mute ends: the pause runs to exactly then
 * (plus a margin) in place of the backoff's guess — nothing is tried before
 * it. An end already past changes nothing. Returns the pause's end.
 */
export function noteMuteEnd(clanId: number, endsAt: number, nowMs = Date.now()): number {
  const s = getChatSendState(clanId);
  if (endsAt <= nowMs) return s.pausedUntil ?? nowMs;
  const pausedUntil = endsAt + MUTE_END_MARGIN_MS;
  save(clanId, { ...s, pausedUntil }, nowMs);
  return pausedUntil;
}
