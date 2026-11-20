"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getChatCommandSettings = getChatCommandSettings;
exports.setChatCommandsEnabled = setChatCommandsEnabled;
exports.setChatCommandsGroupEnabled = setChatCommandsGroupEnabled;
exports.recordCommandRequest = recordCommandRequest;
exports.pendingCommandRequests = pendingCommandRequests;
exports.setCommandRequestStatus = setCommandRequestStatus;
exports.commandRepeated = commandRepeated;
exports.channelRepliesSince = channelRepliesSince;
exports.playerCommandCount = playerCommandCount;
exports.clanRepliesSince = clanRepliesSince;
exports.reserveCommandSend = reserveCommandSend;
exports.finishCommandSend = finishCommandSend;
exports.recentCommandRequests = recentCommandRequests;
exports.commandRepliesSentSince = commandRepliesSentSince;
/**
 * Chat commands (v135; docs/chat-commands.md): the per-clan switch and the
 * record of every command message the scanner account was sent.
 *
 * A member messages the clan's scanner account one word ("me", "top", …) and
 * gets their numbers back in that same 1:1 chat (scheduler/chat-commands.ts).
 * Every command message is recorded once (UNIQUE clan + channel + message),
 * answered or not, so nothing is answered twice — restarts and redeploys
 * included. A reply is reserved (`sending`) before it goes out, and one that
 * may have gone out (`unknown`) is never resent.
 */
const database_js_1 = require("../database.js");
function getChatCommandSettings(clanId) {
    const r = (0, database_js_1.getDb)().prepare('SELECT enabled, enabled_at, group_enabled, group_enabled_at, updated_at FROM chat_command_settings WHERE clan_id = ?')
        .get(clanId);
    if (!r)
        return { enabled: false, enabledAt: null, groupEnabled: false, groupEnabledAt: null, updatedAt: null };
    return { enabled: r.enabled === 1, enabledAt: r.enabled_at, groupEnabled: r.group_enabled === 1, groupEnabledAt: r.group_enabled_at, updatedAt: r.updated_at };
}
function saveSettings(clanId, s, nowMs) {
    (0, database_js_1.getDb)().prepare(`INSERT INTO chat_command_settings (clan_id, enabled, enabled_at, group_enabled, group_enabled_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id) DO UPDATE SET enabled = excluded.enabled, enabled_at = excluded.enabled_at,
       group_enabled = excluded.group_enabled, group_enabled_at = excluded.group_enabled_at, updated_at = excluded.updated_at`).run(clanId, s.enabled ? 1 : 0, s.enabledAt, s.groupEnabled ? 1 : 0, s.groupEnabledAt, new Date(nowMs).toISOString());
    return getChatCommandSettings(clanId);
}
/** Switch commands on or off. Switching on stamps the time: only messages sent after it are answered. */
function setChatCommandsEnabled(clanId, enabled, nowMs = Date.now()) {
    const current = getChatCommandSettings(clanId);
    const enabledAt = enabled ? (current.enabled ? current.enabledAt ?? nowMs : nowMs) : current.enabledAt;
    return saveSettings(clanId, { ...current, enabled, enabledAt }, nowMs);
}
/** Switch answering in the digest's group chat on or off; on stamps the time, as above. */
function setChatCommandsGroupEnabled(clanId, groupEnabled, nowMs = Date.now()) {
    const current = getChatCommandSettings(clanId);
    const groupEnabledAt = groupEnabled ? (current.groupEnabled ? current.groupEnabledAt ?? nowMs : nowMs) : current.groupEnabledAt;
    return saveSettings(clanId, { ...current, groupEnabled, groupEnabledAt }, nowMs);
}
function rowToRequest(r) {
    return {
        id: r.id,
        clanId: r.clan_id,
        channelUrl: r.channel_url,
        messageId: r.message_id,
        senderChatId: r.sender_chat_id,
        playerId: r.player_id ?? null,
        command: r.command,
        language: r.language ?? null,
        requestedAt: r.requested_at,
        status: r.status,
        reason: r.reason ?? null,
        attempts: r.attempts,
        sentAt: r.sent_at ?? null,
    };
}
/** Record a command message once. False when it was already recorded (handled before). */
function recordCommandRequest(req, status, reason, now = new Date().toISOString()) {
    return (0, database_js_1.getDb)().prepare(`INSERT OR IGNORE INTO chat_command_requests
       (clan_id, channel_url, message_id, sender_chat_id, player_id, command, language, requested_at, status, reason, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(req.clanId, req.channelUrl, req.messageId, req.senderChatId, req.playerId, req.command, req.language, req.requestedAt, status, reason, now, now).changes > 0;
}
function pendingCommandRequests(clanId) {
    return (0, database_js_1.getDb)().prepare("SELECT * FROM chat_command_requests WHERE clan_id = ? AND status = 'pending' ORDER BY requested_at, id")
        .all(clanId).map(rowToRequest);
}
function setCommandRequestStatus(id, status, reason, now = new Date().toISOString()) {
    (0, database_js_1.getDb)().prepare('UPDATE chat_command_requests SET status = ?, reason = ?, updated_at = ? WHERE id = ?').run(status, reason, now, id);
}
/**
 * This command is already waiting, on its way, or answered since `sinceMs` in
 * this chat — for this player, or (playerId null) for anyone: asking again
 * gets nothing new, the answer is in the chat.
 */
function commandRepeated(clanId, channelUrl, playerId, command, sinceMs) {
    return !!(0, database_js_1.getDb)().prepare(`SELECT 1 FROM chat_command_requests
      WHERE clan_id = ? AND channel_url = ? AND (? IS NULL OR player_id = ?) AND command = ?
        AND (status IN ('pending', 'sending') OR (status IN ('sent', 'unknown') AND sent_at >= ?))
      LIMIT 1`).get(clanId, channelUrl, playerId, playerId, command, sinceMs);
}
/** Replies tried into one chat since `sinceMs` (a group chat's hourly budget). */
function channelRepliesSince(clanId, channelUrl, sinceMs) {
    return (0, database_js_1.getDb)().prepare('SELECT COUNT(*) AS n FROM chat_command_requests WHERE clan_id = ? AND channel_url = ? AND sent_at >= ?').get(clanId, channelUrl, sinceMs).n;
}
/** How many of the player's command messages since `sinceMs` were taken on (answered, or waiting to be). */
function playerCommandCount(playerId, sinceMs) {
    return (0, database_js_1.getDb)().prepare("SELECT COUNT(*) AS n FROM chat_command_requests WHERE player_id = ? AND requested_at >= ? AND status IN ('pending', 'sending', 'sent', 'unknown', 'failed')").get(playerId, sinceMs).n;
}
/** Replies the clan's scanner account tried since `sinceMs` (the clan's hourly budget). */
function clanRepliesSince(clanId, sinceMs) {
    return (0, database_js_1.getDb)().prepare('SELECT COUNT(*) AS n FROM chat_command_requests WHERE clan_id = ? AND sent_at >= ?').get(clanId, sinceMs).n;
}
/**
 * Reserve a request for its reply: `pending` → `sending`, the try counted and
 * stamped. A crash leaves it `sending`, and a `sending` row is never sent
 * again. False when it is no longer pending.
 */
function reserveCommandSend(id, nowMs = Date.now()) {
    return (0, database_js_1.getDb)().prepare("UPDATE chat_command_requests SET status = 'sending', attempts = attempts + 1, sent_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(nowMs, new Date(nowMs).toISOString(), id).changes > 0;
}
/**
 * The reply's outcome. `sent`: done. `refused` (nothing went out): it waits
 * for another try, up to three. `unknown` (it may have gone out): never
 * resent. `muted` (the scanner account is muted): it waits, the try not
 * counted — and not charged to the clan's budget either.
 */
function finishCommandSend(id, outcome, opts = {}, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    if (outcome.status === 'sent') {
        db.prepare("UPDATE chat_command_requests SET status = 'sent', reason = NULL, reply_message_id = ?, updated_at = ? WHERE id = ?")
            .run(outcome.messageId, now, id);
    }
    else if (outcome.status === 'refused' && opts.muted) {
        db.prepare("UPDATE chat_command_requests SET status = 'pending', reason = 'muted', sent_at = NULL, attempts = MAX(attempts - 1, 0), updated_at = ? WHERE id = ?")
            .run(now, id);
    }
    else if (outcome.status === 'refused') {
        const attempts = db.prepare('SELECT attempts FROM chat_command_requests WHERE id = ?').get(id)?.attempts ?? 0;
        db.prepare('UPDATE chat_command_requests SET status = ?, reason = ?, sent_at = NULL, updated_at = ? WHERE id = ?')
            .run(attempts >= 3 ? 'failed' : 'pending', outcome.error.slice(0, 300), now, id);
    }
    else {
        db.prepare("UPDATE chat_command_requests SET status = 'unknown', reason = ?, updated_at = ? WHERE id = ?")
            .run(outcome.error.slice(0, 300), now, id);
    }
}
function recentCommandRequests(clanId, limit = 25) {
    return (0, database_js_1.getDb)().prepare('SELECT * FROM chat_command_requests WHERE clan_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?')
        .all(clanId, limit).map(rowToRequest);
}
/** Replies sent in the last day, for the settings line. */
function commandRepliesSentSince(clanId, sinceMs) {
    return (0, database_js_1.getDb)().prepare("SELECT COUNT(*) AS n FROM chat_command_requests WHERE clan_id = ? AND status = 'sent' AND sent_at >= ?").get(clanId, sinceMs).n;
}
//# sourceMappingURL=chat-command-repo.js.map