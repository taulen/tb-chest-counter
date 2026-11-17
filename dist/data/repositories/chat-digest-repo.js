"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_ATTEMPTS = exports.DEFAULT_POST_UTC_MINUTE = exports.DIGEST_ENTRIES_MAX = exports.DIGEST_ENTRIES_MIN = void 0;
exports.getChatDigestSettings = getChatDigestSettings;
exports.enabledChatDigestClanIds = enabledChatDigestClanIds;
exports.saveChatDigestSettings = saveChatDigestSettings;
exports.requestTestPost = requestTestPost;
exports.clearTestRequest = clearTestRequest;
exports.setPostableChannels = setPostableChannels;
exports.getPostableChannels = getPostableChannels;
exports.getDigestPost = getDigestPost;
exports.recentDigestPosts = recentDigestPosts;
exports.attemptBlocker = attemptBlocker;
exports.reserveDigestPost = reserveDigestPost;
exports.finishDigestPost = finishDigestPost;
/**
 * The in-game chat digest's storage (v116): per-clan settings, the group chats
 * the clan's scanner account belongs to (the only ones it may post into), and
 * the post ledger — one row per clan per digest day, RESERVED before anything
 * is sent, which is what makes "at most one message a day" hold across
 * restarts, redeploys and the admin's test button.
 */
const database_js_1 = require("../database.js");
exports.DIGEST_ENTRIES_MIN = 3;
exports.DIGEST_ENTRIES_MAX = 20;
exports.DEFAULT_POST_UTC_MINUTE = 17 * 60 + 30;
/** Total sends for one digest day: the first, and one retry after a VERIFIED failure. */
exports.MAX_ATTEMPTS = 2;
const toSettings = (r) => ({
    clanId: r.clan_id,
    enabled: r.enabled === 1,
    channelUrl: r.channel_url,
    channelName: r.channel_name,
    entries: r.entries,
    postUtcMinute: r.post_utc_minute,
    testRequestedAt: r.test_requested_at,
    testRequestedBy: r.test_requested_by,
    posterUserId: r.poster_user_id,
    posterName: r.poster_name,
    channelsCheckedAt: r.channels_checked_at,
});
/** A clan's settings; a clan never configured is off. */
function getChatDigestSettings(clanId) {
    const r = (0, database_js_1.getDb)().prepare('SELECT * FROM chat_digest_settings WHERE clan_id = ?').get(clanId);
    return r ? toSettings(r) : {
        clanId, enabled: false, channelUrl: null, channelName: '', entries: exports.DIGEST_ENTRIES_MAX, postUtcMinute: exports.DEFAULT_POST_UTC_MINUTE,
        testRequestedAt: null, testRequestedBy: null, posterUserId: null, posterName: null, channelsCheckedAt: null,
    };
}
/** Every clan with the digest switched on. */
function enabledChatDigestClanIds() {
    return (0, database_js_1.getDb)().prepare('SELECT clan_id FROM chat_digest_settings WHERE enabled = 1').all().map((r) => r.clan_id);
}
/** Save the admin's choices. Only stores — saving never posts anything. */
function saveChatDigestSettings(clanId, s, now = new Date().toISOString()) {
    (0, database_js_1.getDb)().prepare(`INSERT INTO chat_digest_settings (clan_id, enabled, channel_url, channel_name, entries, post_utc_minute, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id) DO UPDATE SET
       enabled = excluded.enabled, channel_url = excluded.channel_url, channel_name = excluded.channel_name,
       entries = excluded.entries, post_utc_minute = excluded.post_utc_minute, updated_at = excluded.updated_at`).run(clanId, s.enabled ? 1 : 0, s.channelUrl, s.channelName, s.entries, s.postUtcMinute, now);
    return getChatDigestSettings(clanId);
}
/** Queue the admin's "Send test post now" for the clan's next scan. */
function requestTestPost(clanId, userId, now = new Date().toISOString()) {
    // A clan never configured gets its row here (off, no chat — the scan then refuses with a reason).
    (0, database_js_1.getDb)().prepare(`INSERT INTO chat_digest_settings (clan_id, test_requested_at, test_requested_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (clan_id) DO UPDATE SET test_requested_at = excluded.test_requested_at, test_requested_by = excluded.test_requested_by`).run(clanId, now, userId, now);
}
function clearTestRequest(clanId) {
    (0, database_js_1.getDb)().prepare('UPDATE chat_digest_settings SET test_requested_at = NULL, test_requested_by = NULL WHERE clan_id = ?').run(clanId);
}
/**
 * Replace the clan's postable channels with what the scanner account's chat
 * service listed just now, and remember who that account is. A channel the
 * account left drops out — and with it, the right to post there.
 */
function setPostableChannels(clanId, channels, poster, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    db.transaction(() => {
        db.prepare('DELETE FROM chat_post_channels WHERE clan_id = ?').run(clanId);
        const ins = db.prepare('INSERT OR REPLACE INTO chat_post_channels (clan_id, channel_url, custom_type, name, member_count, seen_at) VALUES (?, ?, ?, ?, ?, ?)');
        for (const c of channels)
            ins.run(clanId, c.url, c.customType, c.name, c.memberCount, now);
        db.prepare(`INSERT INTO chat_digest_settings (clan_id, poster_user_id, poster_name, channels_checked_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (clan_id) DO UPDATE SET poster_user_id = excluded.poster_user_id, poster_name = excluded.poster_name,
         channels_checked_at = excluded.channels_checked_at`).run(clanId, poster.userId, poster.name, now, now);
    })();
}
function getPostableChannels(clanId) {
    return (0, database_js_1.getDb)().prepare('SELECT channel_url, custom_type, name, member_count, seen_at FROM chat_post_channels WHERE clan_id = ? ORDER BY name COLLATE NOCASE').all(clanId)
        .map((r) => ({ url: r.channel_url, customType: r.custom_type, name: r.name, memberCount: r.member_count, seenAt: r.seen_at }));
}
const toPost = (r) => ({
    id: r.id, clanId: r.clan_id, gameDate: r.game_date, sentGameDate: r.sent_game_date, channelUrl: r.channel_url,
    channelName: r.channel_name, status: r.status, attempts: r.attempts, messageId: r.message_id, text: r.text,
    error: r.error, trigger: r.trigger, createdAt: r.created_at, updatedAt: r.updated_at,
});
function getDigestPost(clanId, gameDate) {
    const r = (0, database_js_1.getDb)().prepare('SELECT * FROM chat_digest_posts WHERE clan_id = ? AND game_date = ?').get(clanId, gameDate);
    return r ? toPost(r) : null;
}
function recentDigestPosts(clanId, limit = 7) {
    return (0, database_js_1.getDb)().prepare('SELECT * FROM chat_digest_posts WHERE clan_id = ? ORDER BY game_date DESC LIMIT ?').all(clanId, limit).map(toPost);
}
function attemptBlocker(clanId, gameDate, sentGameDate) {
    const row = getDigestPost(clanId, gameDate);
    if (row) {
        if (row.status === 'sent')
            return { code: 'posted', message: 'already posted' };
        if (row.status === 'sending' || row.status === 'unknown')
            return { code: 'maybe-posted', message: 'may already have gone out — never resent' };
        if (row.status === 'failed' && row.attempts >= exports.MAX_ATTEMPTS)
            return { code: 'gave-up', message: 'failed twice — given up for that day' };
    }
    const other = (0, database_js_1.getDb)().prepare(`SELECT game_date FROM chat_digest_posts
      WHERE clan_id = ? AND sent_game_date = ? AND game_date <> ? AND status IN ('sent', 'sending', 'unknown') LIMIT 1`).get(clanId, sentGameDate, gameDate);
    if (other)
        return { code: 'other-today', message: `a message already went out today (the ${other.game_date} digest)`, otherDay: other.game_date };
    return null;
}
/**
 * Reserve the day's one message BEFORE sending: in one transaction, check the
 * blocker and write the row as `sending` (a crash mid-send leaves it there,
 * and `sending` is never retried). Returns the row id, or the blocker.
 */
function reserveDigestPost(p, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    return db.transaction(() => {
        const blocked = attemptBlocker(p.clanId, p.gameDate, p.sentGameDate);
        if (blocked)
            return { blocked: blocked.message };
        const row = getDigestPost(p.clanId, p.gameDate);
        if (row) {
            db.prepare(`UPDATE chat_digest_posts SET status = 'sending', attempts = attempts + 1, sent_game_date = ?, channel_url = ?,
           channel_name = ?, text = ?, error = NULL, trigger = ?, updated_at = ? WHERE id = ?`).run(p.sentGameDate, p.channelUrl, p.channelName, p.text, p.trigger, now, row.id);
            return { id: row.id };
        }
        const r = db.prepare(`INSERT INTO chat_digest_posts (clan_id, game_date, sent_game_date, channel_url, channel_name, status, attempts, text, trigger, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'sending', 1, ?, ?, ?, ?)`).run(p.clanId, p.gameDate, p.sentGameDate, p.channelUrl, p.channelName, p.text, p.trigger, now, now);
        return { id: Number(r.lastInsertRowid) };
    })();
}
/** Record how the send went: `sent` with the message id, `failed` (verified, nothing went out) or `unknown`. */
function finishDigestPost(id, outcome, now = new Date().toISOString()) {
    (0, database_js_1.getDb)().prepare('UPDATE chat_digest_posts SET status = ?, message_id = ?, error = ?, updated_at = ? WHERE id = ?').run(outcome.status, outcome.status === 'sent' ? outcome.messageId : null, outcome.status === 'sent' ? null : outcome.error, now, id);
}
//# sourceMappingURL=chat-digest-repo.js.map