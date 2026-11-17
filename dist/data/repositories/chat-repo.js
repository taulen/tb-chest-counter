"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertChatChannel = upsertChatChannel;
exports.newestChatMessageAt = newestChatMessageAt;
exports.saveChatMessages = saveChatMessages;
/**
 * In-game chat storage (v104): channels and messages per clan, read from the
 * game's chat service by scheduler/chat-capture.ts. Insert-only for messages
 * (Sendbird message ids are unique per channel).
 */
const database_js_1 = require("../database.js");
function upsertChatChannel(clanId, c, now = new Date().toISOString()) {
    (0, database_js_1.getDb)().prepare(`INSERT INTO chat_channels (clan_id, channel_url, custom_type, name, member_count, members, last_message_at, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, channel_url) DO UPDATE SET
       custom_type = excluded.custom_type, name = excluded.name, member_count = excluded.member_count,
       members = excluded.members, last_message_at = COALESCE(excluded.last_message_at, chat_channels.last_message_at),
       last_seen = excluded.last_seen`).run(clanId, c.url, c.customType, c.name, c.memberCount, JSON.stringify(c.members), c.lastMessageAt, now, now);
}
/** Newest stored message time in a channel (ms), or 0 when none is stored yet. */
function newestChatMessageAt(clanId, channelUrl) {
    const r = (0, database_js_1.getDb)().prepare('SELECT MAX(created_at) AS t FROM chat_messages WHERE clan_id = ? AND channel_url = ?')
        .get(clanId, channelUrl);
    return r.t ?? 0;
}
/** Store messages; returns how many were new. */
function saveChatMessages(clanId, messages, now = new Date().toISOString()) {
    if (!messages.length)
        return 0;
    const db = (0, database_js_1.getDb)();
    const stmt = db.prepare(`INSERT OR IGNORE INTO chat_messages
       (clan_id, channel_url, message_id, created_at, custom_type, sender_id, sender_name, sender_info, message, data, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let added = 0;
    db.transaction(() => {
        for (const m of messages) {
            added += stmt.run(clanId, m.channelUrl, m.messageId, m.createdAt, m.customType, m.senderId, m.senderName, m.senderInfo, m.message, m.data, now).changes;
        }
    })();
    return added;
}
//# sourceMappingURL=chat-repo.js.map