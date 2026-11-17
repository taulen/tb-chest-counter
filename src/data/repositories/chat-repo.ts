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
import { getDb } from '../database.js';
import type { ChatChannel, ChatMessage } from '../../game-protocol/chat.js';
import { chatSearchText, chatSenderPlayerId } from '../../game-protocol/chat-text.js';

export function upsertChatChannel(clanId: number, c: ChatChannel, now = new Date().toISOString()): void {
  getDb().prepare(
    `INSERT INTO chat_channels (clan_id, channel_url, custom_type, name, member_count, members, last_message_at, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, channel_url) DO UPDATE SET
       custom_type = excluded.custom_type, name = excluded.name, member_count = excluded.member_count,
       members = excluded.members, last_message_at = COALESCE(excluded.last_message_at, chat_channels.last_message_at),
       last_seen = excluded.last_seen`,
  ).run(clanId, c.url, c.customType, c.name, c.memberCount, JSON.stringify(c.members), c.lastMessageAt, now, now);
}

/** Newest stored message time in a channel (ms), or 0 when none is stored yet. */
export function newestChatMessageAt(clanId: number, channelUrl: string): number {
  const r = getDb().prepare('SELECT MAX(created_at) AS t FROM chat_messages WHERE clan_id = ? AND channel_url = ?')
    .get(clanId, channelUrl) as { t: number | null };
  return r.t ?? 0;
}

/** Oldest stored message time in a channel (ms), or 0 when none is stored yet. */
export function oldestChatMessageAt(clanId: number, channelUrl: string): number {
  const r = getDb().prepare('SELECT MIN(created_at) AS t FROM chat_messages WHERE clan_id = ? AND channel_url = ?')
    .get(clanId, channelUrl) as { t: number | null };
  return r.t ?? 0;
}

/** Whether the backfill of a channel has reached the start of its history. */
export function isChatHistoryComplete(clanId: number, channelUrl: string): boolean {
  const r = getDb().prepare('SELECT history_complete AS c FROM chat_channels WHERE clan_id = ? AND channel_url = ?')
    .get(clanId, channelUrl) as { c: number } | undefined;
  return r?.c === 1;
}

export function markChatHistoryComplete(clanId: number, channelUrl: string): void {
  getDb().prepare('UPDATE chat_channels SET history_complete = 1 WHERE clan_id = ? AND channel_url = ?').run(clanId, channelUrl);
}

/**
 * Store messages; returns how many were new. Known ones are only touched when
 * a read brings an edited text (the old text kept in previous_message) or a
 * translations map we did not have — never blanked by an empty re-read.
 */
export function saveChatMessages(clanId: number, messages: ChatMessage[], now = new Date().toISOString()): number {
  if (!messages.length) return 0;
  const db = getDb();
  const known = db.prepare('SELECT 1 FROM chat_messages WHERE clan_id = ? AND channel_url = ? AND message_id = ?');
  const stmt = db.prepare(
    `INSERT INTO chat_messages
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
        OR (excluded.translations <> '' AND excluded.translations <> chat_messages.translations)`,
  );
  let added = 0;
  db.transaction(() => {
    for (const m of messages) {
      const isNew = !known.get(clanId, m.channelUrl, m.messageId);
      stmt.run(clanId, m.channelUrl, m.messageId, m.createdAt, m.customType, m.senderId, m.senderName,
        m.senderInfo, m.message, m.data, now, chatSenderPlayerId(m.senderInfo), chatSearchText(m.message, m.data),
        m.updatedAt ?? 0, m.translations ?? '');
      if (isNew) added++;
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
export function clanChatChannels(clanId: number): string[] {
  const db = getDb();
  const all = (db.prepare(
    "SELECT channel_url AS url FROM chat_channels WHERE clan_id = ? AND custom_type = 'clanGroup' AND channel_url LIKE 'triumph_clan_channel_%'",
  ).all(clanId) as Array<{ url: string }>).map((r) => r.url);
  const run = db.prepare(
    'SELECT game_clan_id AS g FROM game_capture_runs WHERE clan_id = ? AND game_clan_id IS NOT NULL ORDER BY id DESC LIMIT 1',
  ).get(clanId) as { g: number } | undefined;
  if (run?.g) {
    const own = `triumph_clan_channel_${run.g}`;
    if (all.includes(own)) return [own];
  }
  return all;
}

export interface StoredChatMessage {
  id: number;
  channelUrl: string;
  messageId: number;
  createdAt: number;
  customType: string;
  senderName: string;
  senderInfo: string;
  senderPlayerId: number | null;
  message: string;
  data: string;
  updatedAt: number;
  previousMessage: string | null;
  translations: string;
}

/** A position in the log: messages are ordered by (created_at, message_id). */
export interface ChatCursor { at: number; id: number }

export interface ChatQuery {
  /** Older than this position (exclusive). */
  before?: ChatCursor | null;
  /** Newer than this position (exclusive); with it, the page is read oldest first. */
  after?: ChatCursor | null;
  /** Full-text search (every word, prefix match). */
  q?: string;
  senderPlayerId?: number | null;
  /** created_at bounds in ms (inclusive from, exclusive to). */
  fromMs?: number | null;
  toMs?: number | null;
  limit?: number;
}

/**
 * FTS5 query from what a person typed: every word must match, each as a
 * prefix. Quotes are stripped and each word quoted, so nothing typed is ever
 * read as FTS syntax. Empty when nothing searchable remains.
 */
export function ftsQuery(q: string): string {
  const words = q.replace(/["*^():]/g, ' ').split(/\s+/).map((w) => w.trim()).filter(Boolean).slice(0, 12);
  return words.map((w) => `"${w}"*`).join(' ');
}

/**
 * One page of the stored chat of the given channels, newest first — or, with
 * `after`, oldest first (the newer side of a position). Clan-scoped by
 * `clanId` AND the channel list, so another clan's or a private channel can
 * never be read through it.
 */
export function readChatPage(clanId: number, channels: string[], query: ChatQuery): StoredChatMessage[] {
  if (!channels.length) return [];
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
  const { from, where, args, empty } = filterSql(clanId, channels, query.q, query.senderPlayerId);
  if (empty) return [];
  if (query.fromMs) { where.push('m.created_at >= ?'); args.push(query.fromMs); }
  if (query.toMs) { where.push('m.created_at < ?'); args.push(query.toMs); }
  let order = 'm.created_at DESC, m.message_id DESC';
  if (query.after) {
    where.push('(m.created_at > ? OR (m.created_at = ? AND m.message_id > ?))');
    args.push(query.after.at, query.after.at, query.after.id);
    order = 'm.created_at ASC, m.message_id ASC';
  } else if (query.before) {
    where.push('(m.created_at < ? OR (m.created_at = ? AND m.message_id < ?))');
    args.push(query.before.at, query.before.at, query.before.id);
  }
  const rows = getDb().prepare(
    `SELECT m.id, m.channel_url AS channelUrl, m.message_id AS messageId, m.created_at AS createdAt,
            m.custom_type AS customType, m.sender_name AS senderName, m.sender_info AS senderInfo,
            m.sender_player_id AS senderPlayerId, m.message, m.data, m.updated_at AS updatedAt,
            m.previous_message AS previousMessage, m.translations
       FROM ${from}
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ${limit}`,
  ).all(...args) as StoredChatMessage[];
  return rows;
}

/** WHERE clause + args for a search/filter over the channels (shared by the count). */
function filterSql(clanId: number, channels: string[], q: string | undefined, senderPlayerId: number | null | undefined) {
  const where: string[] = ['m.clan_id = ?', `m.channel_url IN (${channels.map(() => '?').join(',')})`];
  const args: unknown[] = [clanId, ...channels];
  let from = 'chat_messages m';
  const fts = q ? ftsQuery(q) : '';
  if (fts) {
    from = 'chat_messages_fts f JOIN chat_messages m ON m.id = f.rowid';
    where.push('chat_messages_fts MATCH ?');
    args.push(fts);
  }
  if (senderPlayerId) { where.push('m.sender_player_id = ?'); args.push(senderPlayerId); }
  return { from, where, args, empty: !!q && !fts };
}

/**
 * How many stored messages a search / writer filter matches across the WHOLE
 * stored history (not just what a page loaded), and the oldest one's time.
 */
export function countChatMatches(
  clanId: number, channels: string[], q?: string, senderPlayerId?: number | null,
): { total: number; oldestAt: number | null } {
  if (!channels.length) return { total: 0, oldestAt: null };
  const f = filterSql(clanId, channels, q, senderPlayerId);
  if (f.empty) return { total: 0, oldestAt: null };
  return getDb().prepare(`SELECT COUNT(*) AS total, MIN(m.created_at) AS oldestAt FROM ${f.from} WHERE ${f.where.join(' AND ')}`)
    .get(...f.args) as { total: number; oldestAt: number | null };
}

/**
 * The message a conversation opens at for a time: the first one at or after
 * `ms`, else the last one before it (a date after the newest line), or null
 * when the channels hold nothing.
 */
export function chatAnchorAt(clanId: number, channels: string[], ms: number): ChatCursor | null {
  if (!channels.length) return null;
  const ph = channels.map(() => '?').join(',');
  const db = getDb();
  const next = db.prepare(
    `SELECT created_at AS at, message_id AS id FROM chat_messages
      WHERE clan_id = ? AND channel_url IN (${ph}) AND created_at >= ?
      ORDER BY created_at ASC, message_id ASC LIMIT 1`,
  ).get(clanId, ...channels, ms) as ChatCursor | undefined;
  if (next) return next;
  const prev = db.prepare(
    `SELECT created_at AS at, message_id AS id FROM chat_messages
      WHERE clan_id = ? AND channel_url IN (${ph})
      ORDER BY created_at DESC, message_id DESC LIMIT 1`,
  ).get(clanId, ...channels) as ChatCursor | undefined;
  return prev ?? null;
}

/**
 * The conversation around one message: up to `side` before it, the message
 * itself, and up to `side` after it — oldest first. Unfiltered: opening a
 * search hit shows what was said around it, not only other hits.
 */
export function readChatAround(
  clanId: number, channels: string[], at: ChatCursor, side = 50,
): { messages: StoredChatMessage[]; hasOlder: boolean; hasNewer: boolean } {
  const older = readChatPage(clanId, channels, { before: at, limit: side });
  // `after` is exclusive: one id below the anchor's includes the anchor itself.
  const newer = readChatPage(clanId, channels, { after: { at: at.at, id: at.id - 1 }, limit: side + 1 });
  return {
    messages: [...older.reverse(), ...newer],
    hasOlder: older.length === side,
    hasNewer: newer.length === side + 1,
  };
}

export interface ChatSender { playerId: number; name: string; messages: number; lastAt: number }

/** Everyone who wrote in these channels: their latest name and message count, busiest first. */
export function chatSenders(clanId: number, channels: string[]): ChatSender[] {
  if (!channels.length) return [];
  return getDb().prepare(
    `SELECT sender_player_id AS playerId,
            (SELECT s.sender_name FROM chat_messages s
              WHERE s.clan_id = m.clan_id AND s.sender_player_id = m.sender_player_id
              ORDER BY s.created_at DESC LIMIT 1) AS name,
            COUNT(*) AS messages, MAX(created_at) AS lastAt
       FROM chat_messages m
      WHERE m.clan_id = ? AND m.channel_url IN (${channels.map(() => '?').join(',')})
        AND m.sender_player_id IS NOT NULL AND m.custom_type = 'user'
      GROUP BY sender_player_id
      ORDER BY messages DESC`,
  ).all(clanId, ...channels) as ChatSender[];
}

export interface ChatHistoryInfo { total: number; oldestAt: number | null; newestAt: number | null; complete: boolean }

/** How much of the channels' history is stored, and whether the backfill reached the start. */
export function chatHistoryInfo(clanId: number, channels: string[]): ChatHistoryInfo {
  if (!channels.length) return { total: 0, oldestAt: null, newestAt: null, complete: false };
  const ph = channels.map(() => '?').join(',');
  const db = getDb();
  const r = db.prepare(
    `SELECT COUNT(*) AS total, MIN(created_at) AS oldestAt, MAX(created_at) AS newestAt
       FROM chat_messages WHERE clan_id = ? AND channel_url IN (${ph})`,
  ).get(clanId, ...channels) as { total: number; oldestAt: number | null; newestAt: number | null };
  const c = db.prepare(
    `SELECT MIN(history_complete) AS c FROM chat_channels WHERE clan_id = ? AND channel_url IN (${ph})`,
  ).get(clanId, ...channels) as { c: number | null };
  return { ...r, complete: c.c === 1 };
}
