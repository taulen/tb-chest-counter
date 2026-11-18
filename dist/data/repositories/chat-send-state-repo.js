"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MUTE_END_MARGIN_MS = exports.MUTE_BACKOFF_MS = void 0;
exports.getChatSendState = getChatSendState;
exports.chatPausedUntil = chatPausedUntil;
exports.noteChatSendAttempt = noteChatSendAttempt;
exports.noteChatSent = noteChatSent;
exports.noteChatMuted = noteChatMuted;
exports.noteMuteEnd = noteMuteEnd;
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
const database_js_1 = require("../database.js");
/**
 * How long sending pauses after a mute: the game's mute was about an hour,
 * so the first pause is a little longer; mutes in a row (the first message
 * after a pause muted again) wait longer each time.
 */
exports.MUTE_BACKOFF_MS = [75 * 60_000, 3 * 3600_000, 12 * 3600_000, 24 * 3600_000];
const EMPTY = { lastSendAt: null, pausedUntil: null, mutedAt: null, muteCount: 0, lastError: null };
function getChatSendState(clanId) {
    const r = (0, database_js_1.getDb)().prepare('SELECT last_send_at, paused_until, muted_at, mute_count, last_error FROM chat_send_state WHERE clan_id = ?').get(clanId);
    if (!r)
        return { ...EMPTY };
    return { lastSendAt: r.last_send_at, pausedUntil: r.paused_until, mutedAt: r.muted_at, muteCount: r.mute_count, lastError: r.last_error };
}
function save(clanId, s, nowMs) {
    (0, database_js_1.getDb)().prepare(`INSERT INTO chat_send_state (clan_id, last_send_at, paused_until, muted_at, mute_count, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id) DO UPDATE SET last_send_at = excluded.last_send_at, paused_until = excluded.paused_until,
       muted_at = excluded.muted_at, mute_count = excluded.mute_count, last_error = excluded.last_error, updated_at = excluded.updated_at`).run(clanId, s.lastSendAt, s.pausedUntil, s.mutedAt, s.muteCount, s.lastError, new Date(nowMs).toISOString());
}
/** When the clan's sending may start again, while a mute's pause runs; null when nothing is paused. */
function chatPausedUntil(clanId, nowMs = Date.now()) {
    const until = getChatSendState(clanId).pausedUntil;
    return until !== null && until > nowMs ? until : null;
}
/** An invite DM is about to go out (stamped before the send, whatever comes of it). */
function noteChatSendAttempt(clanId, nowMs = Date.now()) {
    save(clanId, { ...getChatSendState(clanId), lastSendAt: nowMs }, nowMs);
}
/** A message got through: the account isn't muted (any more), the backoff starts over. */
function noteChatSent(clanId, nowMs = Date.now()) {
    const s = getChatSendState(clanId);
    if (s.muteCount === 0 && s.lastError === null)
        return;
    save(clanId, { ...s, muteCount: 0, lastError: null }, nowMs);
}
/** Past the mute's own end, when the chat service says it: clocks differ a little. */
exports.MUTE_END_MARGIN_MS = 2 * 60_000;
/**
 * The game refused a message with "You are muted.": pause the clan's sending
 * at once, for the backoff's guess. Returns when sending may start again.
 */
function noteChatMuted(clanId, error, nowMs = Date.now()) {
    const s = getChatSendState(clanId);
    const pausedUntil = nowMs + exports.MUTE_BACKOFF_MS[Math.min(s.muteCount, exports.MUTE_BACKOFF_MS.length - 1)];
    save(clanId, { ...s, pausedUntil, mutedAt: nowMs, muteCount: s.muteCount + 1, lastError: error.slice(0, 300) }, nowMs);
    return pausedUntil;
}
/**
 * The chat service told us when the mute ends: the pause runs to exactly then
 * (plus a margin) in place of the backoff's guess — nothing is tried before
 * it. An end already past changes nothing. Returns the pause's end.
 */
function noteMuteEnd(clanId, endsAt, nowMs = Date.now()) {
    const s = getChatSendState(clanId);
    if (endsAt <= nowMs)
        return s.pausedUntil ?? nowMs;
    const pausedUntil = endsAt + exports.MUTE_END_MARGIN_MS;
    save(clanId, { ...s, pausedUntil }, nowMs);
    return pausedUntil;
}
//# sourceMappingURL=chat-send-state-repo.js.map