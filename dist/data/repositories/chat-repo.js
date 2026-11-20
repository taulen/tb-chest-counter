"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertChatChannel = upsertChatChannel;
exports.newestChatMessageAt = newestChatMessageAt;
exports.oldestChatMessageAt = oldestChatMessageAt;
exports.isChatHistoryComplete = isChatHistoryComplete;
exports.markChatHistoryComplete = markChatHistoryComplete;
exports.saveChatMessages = saveChatMessages;
exports.clanChatChannels = clanChatChannels;
exports.ftsQuery = ftsQuery;
exports.readChatPage = readChatPage;
exports.countChatMatches = countChatMatches;
exports.chatAnchorAt = chatAnchorAt;
exports.readChatAround = readChatAround;
exports.readChatMessage = readChatMessage;
exports.chatSenders = chatSenders;
exports.chatHistoryInfo = chatHistoryInfo;
/**
 * In-game chat storage (v104, v113): channels and messages per clan, read from
 * the game's chat service by scheduler/chat-capture.ts.
 *
 * PERMANENT and append-only: a message is stored the first time any read
 * returns it and is never deleted or blanked by a later read — the service
 * only serves recent history, so once it stops returning a line, our copy is
 * the only one left. A later read of the same message id may only replace its
 * text when the text really changed (an edit), and the replaced text is kept in
 * previous_message. The only delete path is deleting the whole clan.
 */
const database_js_1 = require("../database.js");
const chat_text_js_1 = require("../../game-protocol/chat-text.js");
function upsertChatChannel(clanId, c, now = new Date().toISOString()) {
    (0, database_js_1.getDb)().prepare(`INSERT INTO chat_channels (clan_id, channel_url, custom_type, name, member_count, members, last_message_at, max_length, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, channel_url) DO UPDATE SET
       custom_type = excluded.custom_type, name = excluded.name, member_count = excluded.member_count,
       members = excluded.members, last_message_at = COALESCE(excluded.last_message_at, chat_channels.last_message_at),
       max_length = COALESCE(excluded.max_length, chat_channels.max_length),
       last_seen = excluded.last_seen`).run(clanId, c.url, c.customType, c.name, c.memberCount, JSON.stringify(c.members), c.lastMessageAt, c.maxLength ?? null, now, now);
}
/** Newest stored message time in a channel (ms), or 0 when none is stored yet. */
function newestChatMessageAt(clanId, channelUrl) {
    const r = (0, database_js_1.getDb)().prepare('SELECT MAX(created_at) AS t FROM chat_messages WHERE clan_id = ? AND channel_url = ?')
        .get(clanId, channelUrl);
    return r.t ?? 0;
}
/** Oldest stored message time in a channel (ms), or 0 when none is stored yet. */
function oldestChatMessageAt(clanId, channelUrl) {
    const r = (0, database_js_1.getDb)().prepare('SELECT MIN(created_at) AS t FROM chat_messages WHERE clan_id = ? AND channel_url = ?')
        .get(clanId, channelUrl);
    return r.t ?? 0;
}
/** Whether the backfill of a channel has reached the start of its history. */
function isChatHistoryComplete(clanId, channelUrl) {
    const r = (0, database_js_1.getDb)().prepare('SELECT history_complete AS c FROM chat_channels WHERE clan_id = ? AND channel_url = ?')
        .get(clanId, channelUrl);
    return r?.c === 1;
}
function markChatHistoryComplete(clanId, channelUrl) {
    (0, database_js_1.getDb)().prepare('UPDATE chat_channels SET history_complete = 1 WHERE clan_id = ? AND channel_url = ?').run(clanId, channelUrl);
}
/**
 * Store messages; returns how many were new. Known ones are only touched when
 * a read brings an edited text (the old text kept in previous_message) or a
 * translations map we did not have — never blanked by an empty re-read.
 */
function saveChatMessages(clanId, messages, now = new Date().toISOString()) {
    if (!messages.length)
        return 0;
    const db = (0, database_js_1.getDb)();
    const known = db.prepare('SELECT 1 FROM chat_messages WHERE clan_id = ? AND channel_url = ? AND message_id = ?');
    const stmt = db.prepare(`INSERT INTO chat_messages
       (clan_id, channel_url, message_id, created_at, custom_type, sender_id, sender_name, sender_info, message, data,
        captured_at, sender_player_id, search_text, updated_at, translations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, channel_url, message_id) DO UPDATE SET
       previous_message = CASE WHEN excluded.message <> chat_messages.message
                               THEN chat_messages.message ELSE chat_messages.previous_message END,
       message = CASE WHEN excluded.message <> '' THEN excluded.message ELSE chat_messages.message END,
       data = CASE WHEN excluded.data <> '' THEN excluded.data ELSE chat_messages.data END,
       search_text = CASE WHEN excluded.message <> '' THEN excluded.search_text ELSE chat_messages.search_text END,
       updated_at = MAX(excluded.updated_at, chat_messages.updated_at),
       translations = CASE WHEN excluded.translations <> '' THEN excluded.translations ELSE chat_messages.translations END
     WHERE (excluded.message <> '' AND excluded.message <> chat_messages.message)
        OR (excluded.data <> '' AND excluded.data <> chat_messages.data)
        OR (excluded.translations <> '' AND excluded.translations <> chat_messages.translations)`);
    let added = 0;
    db.transaction(() => {
        for (const m of messages) {
            const isNew = !known.get(clanId, m.channelUrl, m.messageId);
            stmt.run(clanId, m.channelUrl, m.messageId, m.createdAt, m.customType, m.senderId, m.senderName, m.senderInfo, m.message, m.data, now, (0, chat_text_js_1.chatSenderPlayerId)(m.senderInfo), (0, chat_text_js_1.chatSearchText)(m.message, m.data), m.updatedAt ?? 0, m.translations ?? '');
            if (isNew)
                added++;
        }
    })();
    return added;
}
// ── Read side (the Chats page) ──────────────────────────────────────────────
/**
 * The clan chat channel(s) of a clan: its `clanGroup` channel, named after the
 * game clan the latest capture read (`triumph_clan_channel_<gameClanId>`);
 * every clanGroup channel stored for the clan when that is not known. Never a
 * private (whisper) or realm channel.
 */
function clanChatChannels(clanId) {
    const db = (0, database_js_1.getDb)();
    const all = db.prepare("SELECT channel_url AS url FROM chat_channels WHERE clan_id = ? AND custom_type = 'clanGroup' AND channel_url LIKE 'triumph_clan_channel_%'").all(clanId).map((r) => r.url);
    const run = db.prepare('SELECT game_clan_id AS g FROM game_capture_runs WHERE clan_id = ? AND game_clan_id IS NOT NULL ORDER BY id DESC LIMIT 1').get(clanId);
    if (run?.g) {
        const own = `triumph_clan_channel_${run.g}`;
        if (all.includes(own))
            return [own];
    }
    return all;
}
/**
 * FTS5 query from what a person typed: every word must match, each as a
 * prefix. Quotes are stripped and each word quoted, so nothing typed is ever
 * read as FTS syntax. Empty when nothing searchable remains.
 */
function ftsQuery(q) {
    const words = q.replace(/["*^():]/g, ' ').split(/\s+/).map((w) => w.trim()).filter(Boolean).slice(0, 12);
    return words.map((w) => `"${w}"*`).join(' ');
}
/**
 * One page of the stored chat of the given channels, newest first — or, with
 * `after`, oldest first (the newer side of a position). Clan-scoped by
 * `clanId` AND the channel list, so another clan's or a private channel can
 * never be read through it.
 */
function readChatPage(clanId, channels, query) {
    if (!channels.length)
        return [];
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
    const { from, where, args, empty } = filterSql(clanId, channels, query.q, query.senderPlayerId);
    if (empty)
        return [];
    if (query.fromMs) {
        where.push('m.created_at >= ?');
        args.push(query.fromMs);
    }
    if (query.toMs) {
        where.push('m.created_at < ?');
        args.push(query.toMs);
    }
    let order = 'm.created_at DESC, m.message_id DESC';
    if (query.after) {
        where.push('(m.created_at > ? OR (m.created_at = ? AND m.message_id > ?))');
        args.push(query.after.at, query.after.at, query.after.id);
        order = 'm.created_at ASC, m.message_id ASC';
    }
    else if (query.before) {
        where.push('(m.created_at < ? OR (m.created_at = ? AND m.message_id < ?))');
        args.push(query.before.at, query.before.at, query.before.id);
    }
    const rows = (0, database_js_1.getDb)().prepare(`SELECT m.id, m.channel_url AS channelUrl, m.message_id AS messageId, m.created_at AS createdAt,
            m.custom_type AS customType, m.sender_name AS senderName, m.sender_info AS senderInfo,
            m.sender_player_id AS senderPlayerId, m.message, m.data, m.updated_at AS updatedAt,
            m.previous_message AS previousMessage, m.translations
       FROM ${from}
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ${limit}`).all(...args);
    return rows;
}
/** WHERE clause + args for a search/filter over the channels (shared by the count). */
function filterSql(clanId, channels, q, senderPlayerId) {
    const where = ['m.clan_id = ?', `m.channel_url IN (${channels.map(() => '?').join(',')})`];
    const args = [clanId, ...channels];
    let from = 'chat_messages m';
    const fts = q ? ftsQuery(q) : '';
    if (fts) {
        from = 'chat_messages_fts f JOIN chat_messages m ON m.id = f.rowid';
        where.push('chat_messages_fts MATCH ?');
        args.push(fts);
    }
    if (senderPlayerId) {
        where.push('m.sender_player_id = ?');
        args.push(senderPlayerId);
    }
    return { from, where, args, empty: !!q && !fts };
}
/**
 * How many stored messages a search / writer filter matches across the WHOLE
 * stored history (not just what a page loaded), and the oldest one's time.
 */
function countChatMatches(clanId, channels, q, senderPlayerId) {
    if (!channels.length)
        return { total: 0, oldestAt: null };
    const f = filterSql(clanId, channels, q, senderPlayerId);
    if (f.empty)
        return { total: 0, oldestAt: null };
    return (0, database_js_1.getDb)().prepare(`SELECT COUNT(*) AS total, MIN(m.created_at) AS oldestAt FROM ${f.from} WHERE ${f.where.join(' AND ')}`)
        .get(...f.args);
}
/**
 * The message a conversation opens at for a time: the first one at or after
 * `ms`, else the last one before it (a date after the newest line), or null
 * when the channels hold nothing.
 */
function chatAnchorAt(clanId, channels, ms) {
    if (!channels.length)
        return null;
    const ph = channels.map(() => '?').join(',');
    const db = (0, database_js_1.getDb)();
    const next = db.prepare(`SELECT created_at AS at, message_id AS id FROM chat_messages
      WHERE clan_id = ? AND channel_url IN (${ph}) AND created_at >= ?
      ORDER BY created_at ASC, message_id ASC LIMIT 1`).get(clanId, ...channels, ms);
    if (next)
        return next;
    const prev = db.prepare(`SELECT created_at AS at, message_id AS id FROM chat_messages
      WHERE clan_id = ? AND channel_url IN (${ph})
      ORDER BY created_at DESC, message_id DESC LIMIT 1`).get(clanId, ...channels);
    return prev ?? null;
}
/**
 * The conversation around one message: up to `side` before it, the message
 * itself, and up to `side` after it — oldest first. Unfiltered: opening a
 * search hit shows what was said around it, not only other hits.
 */
function readChatAround(clanId, channels, at, side = 50) {
    const older = readChatPage(clanId, channels, { before: at, limit: side });
    // `after` is exclusive: one id below the anchor's includes the anchor itself.
    const newer = readChatPage(clanId, channels, { after: { at: at.at, id: at.id - 1 }, limit: side + 1 });
    return {
        messages: [...older.reverse(), ...newer],
        hasOlder: older.length === side,
        hasNewer: newer.length === side + 1,
    };
}
/** One stored message at a position, or null. Clan- and channel-scoped like every read here. */
function readChatMessage(clanId, channels, at) {
    // `after` is exclusive: one id below the position reads the message itself first.
    const [m] = readChatPage(clanId, channels, { after: { at: at.at, id: at.id - 1 }, limit: 1 });
    return m && m.createdAt === at.at && m.messageId === at.id ? m : null;
}
/** Everyone who wrote in these channels: their latest name and message count, busiest first. */
function chatSenders(clanId, channels) {
    if (!channels.length)
        return [];
    return (0, database_js_1.getDb)().prepare(`SELECT sender_player_id AS playerId,
            (SELECT s.sender_name FROM chat_messages s
              WHERE s.clan_id = m.clan_id AND s.sender_player_id = m.sender_player_id
              ORDER BY s.created_at DESC LIMIT 1) AS name,
            COUNT(*) AS messages, MAX(created_at) AS lastAt
       FROM chat_messages m
      WHERE m.clan_id = ? AND m.channel_url IN (${channels.map(() => '?').join(',')})
        AND m.sender_player_id IS NOT NULL AND m.custom_type = 'user'
      GROUP BY sender_player_id
      ORDER BY messages DESC`).all(clanId, ...channels);
}
/** How much of the channels' history is stored, and whether the backfill reached the start. */
function chatHistoryInfo(clanId, channels) {
    if (!channels.length)
        return { total: 0, oldestAt: null, newestAt: null, complete: false };
    const ph = channels.map(() => '?').join(',');
    const db = (0, database_js_1.getDb)();
    const r = db.prepare(`SELECT COUNT(*) AS total, MIN(created_at) AS oldestAt, MAX(created_at) AS newestAt
       FROM chat_messages WHERE clan_id = ? AND channel_url IN (${ph})`).get(clanId, ...channels);
    const c = db.prepare(`SELECT MIN(history_complete) AS c FROM chat_channels WHERE clan_id = ? AND channel_url IN (${ph})`).get(clanId, ...channels);
    return { ...r, complete: c.c === 1 };
}
//# sourceMappingURL=chat-repo.js.map