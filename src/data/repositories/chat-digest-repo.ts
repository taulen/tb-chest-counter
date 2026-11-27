/**
 * The in-game chat digest's storage (v116): per-clan settings, the group chats
 * the clan's scanner account belongs to (the only ones it may post into), and
 * the post ledger — one row per clan per digest day, RESERVED before anything
 * is sent, which is what makes "at most one message a day" hold across
 * restarts, redeploys and the admin's test button.
 */
import { getDb } from '../database.js';

export interface ChatDigestSettings {
  clanId: number;
  enabled: boolean;
  /** The chosen group chat; null until the scanner account's channel list resolves `channelName`. */
  channelUrl: string | null;
  channelName: string;
  entries: number;
  /** Minutes after 00:00 UTC (1050 = 17:30 UTC). */
  postUtcMinute: number;
  /** The post's language (v122): en (default), es, fr, ru, de. */
  language: DigestLanguage;
  testRequestedAt: string | null;
  testRequestedBy: number | null;
  posterUserId: string | null;
  posterName: string | null;
  channelsCheckedAt: string | null;
}

export interface PostableChannel {
  url: string;
  customType: string;
  name: string;
  memberCount: number;
  seenAt: string;
}

export type DigestPostStatus = 'sending' | 'sent' | 'failed' | 'unknown';

export interface ChatDigestPost {
  id: number;
  clanId: number;
  gameDate: string;
  sentGameDate: string;
  channelUrl: string;
  channelName: string;
  status: DigestPostStatus;
  attempts: number;
  messageId: number | null;
  text: string;
  error: string | null;
  trigger: 'scheduled' | 'test';
  createdAt: string;
  updatedAt: string;
}

/** Languages the digest post can be written in (the site's languages). */
export const DIGEST_LANGUAGES = ['en', 'es', 'fr', 'ru', 'de'] as const;
export type DigestLanguage = (typeof DIGEST_LANGUAGES)[number];
export const isDigestLanguage = (v: unknown): v is DigestLanguage =>
  typeof v === 'string' && (DIGEST_LANGUAGES as readonly string[]).includes(v);

export const DIGEST_ENTRIES_MIN = 3;
export const DIGEST_ENTRIES_MAX = 20;
export const DEFAULT_POST_UTC_MINUTE = 17 * 60 + 30;
/** Total sends for one digest day: the first, and one retry after a VERIFIED failure. */
export const MAX_ATTEMPTS = 2;

type SettingsRow = {
  clan_id: number; enabled: number; channel_url: string | null; channel_name: string; entries: number;
  post_utc_minute: number; test_requested_at: string | null; test_requested_by: number | null;
  poster_user_id: string | null; poster_name: string | null; channels_checked_at: string | null;
  language?: string | null;
};

const toSettings = (r: SettingsRow): ChatDigestSettings => ({
  clanId: r.clan_id,
  enabled: r.enabled === 1,
  channelUrl: r.channel_url,
  channelName: r.channel_name,
  entries: r.entries,
  postUtcMinute: r.post_utc_minute,
  language: isDigestLanguage(r.language) ? r.language : 'en',
  testRequestedAt: r.test_requested_at,
  testRequestedBy: r.test_requested_by,
  posterUserId: r.poster_user_id,
  posterName: r.poster_name,
  channelsCheckedAt: r.channels_checked_at,
});

/** A clan's settings; a clan never configured is off. */
export function getChatDigestSettings(clanId: number): ChatDigestSettings {
  const r = getDb().prepare('SELECT * FROM chat_digest_settings WHERE clan_id = ?').get(clanId) as SettingsRow | undefined;
  return r ? toSettings(r) : {
    clanId, enabled: false, channelUrl: null, channelName: '', entries: DIGEST_ENTRIES_MAX, postUtcMinute: DEFAULT_POST_UTC_MINUTE,
    language: 'en', testRequestedAt: null, testRequestedBy: null, posterUserId: null, posterName: null, channelsCheckedAt: null,
  };
}

/** Every clan with the digest switched on. */
export function enabledChatDigestClanIds(): number[] {
  return (getDb().prepare('SELECT clan_id FROM chat_digest_settings WHERE enabled = 1').all() as Array<{ clan_id: number }>).map((r) => r.clan_id);
}

/** Save the admin's choices. Only stores — saving never posts anything. */
export function saveChatDigestSettings(
  clanId: number,
  s: { enabled: boolean; channelUrl: string | null; channelName: string; entries: number; postUtcMinute: number; language?: DigestLanguage },
  now = new Date().toISOString(),
): ChatDigestSettings {
  // A caller that doesn't name a language keeps the stored one.
  const language = s.language ?? getChatDigestSettings(clanId).language;
  getDb().prepare(
    `INSERT INTO chat_digest_settings (clan_id, enabled, channel_url, channel_name, entries, post_utc_minute, language, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id) DO UPDATE SET
       enabled = excluded.enabled, channel_url = excluded.channel_url, channel_name = excluded.channel_name,
       entries = excluded.entries, post_utc_minute = excluded.post_utc_minute, language = excluded.language,
       updated_at = excluded.updated_at`,
  ).run(clanId, s.enabled ? 1 : 0, s.channelUrl, s.channelName, s.entries, s.postUtcMinute, language, now);
  return getChatDigestSettings(clanId);
}

/** Queue the admin's "Send test post now" for the clan's next scan. */
export function requestTestPost(clanId: number, userId: number, now = new Date().toISOString()): void {
  // A clan never configured gets its row here (off, no chat — the scan then refuses with a reason).
  getDb().prepare(
    `INSERT INTO chat_digest_settings (clan_id, test_requested_at, test_requested_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (clan_id) DO UPDATE SET test_requested_at = excluded.test_requested_at, test_requested_by = excluded.test_requested_by`,
  ).run(clanId, now, userId, now);
}

export function clearTestRequest(clanId: number): void {
  getDb().prepare('UPDATE chat_digest_settings SET test_requested_at = NULL, test_requested_by = NULL WHERE clan_id = ?').run(clanId);
}

/**
 * Replace the clan's postable channels with what the scanner account's chat
 * service listed just now, and remember who that account is. A channel the
 * account left drops out — and with it, the right to post there.
 */
export function setPostableChannels(
  clanId: number,
  channels: Array<{ url: string; customType: string; name: string; memberCount: number }>,
  poster: { userId: string; name: string },
  now = new Date().toISOString(),
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM chat_post_channels WHERE clan_id = ?').run(clanId);
    const ins = db.prepare(
      'INSERT OR REPLACE INTO chat_post_channels (clan_id, channel_url, custom_type, name, member_count, seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const c of channels) ins.run(clanId, c.url, c.customType, c.name, c.memberCount, now);
    db.prepare(
      `INSERT INTO chat_digest_settings (clan_id, poster_user_id, poster_name, channels_checked_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (clan_id) DO UPDATE SET poster_user_id = excluded.poster_user_id, poster_name = excluded.poster_name,
         channels_checked_at = excluded.channels_checked_at`,
    ).run(clanId, poster.userId, poster.name, now, now);
  })();
}

/**
 * The account's group chats as the chat sync lists them every minute (the
 * battle-report chat picker and the digest's both offer them). Rewritten only
 * when the chats, names or member counts changed; the digest's own check
 * (setPostableChannels) also records who posts.
 */
export function refreshGroupChats(
  clanId: number,
  channels: Array<{ url: string; customType: string; name: string; memberCount: number }>,
  now = new Date().toISOString(),
): boolean {
  const key = (c: { url: string; customType: string; name: string; memberCount: number }) => `${c.url}\u0000${c.customType}\u0000${c.name}\u0000${c.memberCount}`;
  const before = getPostableChannels(clanId).map(key).sort();
  const after = channels.map(key).sort();
  if (before.length === after.length && before.every((k, i) => k === after[i])) return false;
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM chat_post_channels WHERE clan_id = ?').run(clanId);
    const ins = db.prepare(
      'INSERT OR REPLACE INTO chat_post_channels (clan_id, channel_url, custom_type, name, member_count, seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const c of channels) ins.run(clanId, c.url, c.customType, c.name, c.memberCount, now);
  })();
  return true;
}

export function getPostableChannels(clanId: number): PostableChannel[] {
  return (getDb().prepare(
    'SELECT channel_url, custom_type, name, member_count, seen_at FROM chat_post_channels WHERE clan_id = ? ORDER BY name COLLATE NOCASE',
  ).all(clanId) as Array<{ channel_url: string; custom_type: string; name: string; member_count: number; seen_at: string }>)
    .map((r) => ({ url: r.channel_url, customType: r.custom_type, name: r.name, memberCount: r.member_count, seenAt: r.seen_at }));
}

type PostRow = {
  id: number; clan_id: number; game_date: string; sent_game_date: string; channel_url: string; channel_name: string;
  status: DigestPostStatus; attempts: number; message_id: number | null; text: string; error: string | null;
  trigger: 'scheduled' | 'test'; created_at: string; updated_at: string;
};

const toPost = (r: PostRow): ChatDigestPost => ({
  id: r.id, clanId: r.clan_id, gameDate: r.game_date, sentGameDate: r.sent_game_date, channelUrl: r.channel_url,
  channelName: r.channel_name, status: r.status, attempts: r.attempts, messageId: r.message_id, text: r.text,
  error: r.error, trigger: r.trigger, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function getDigestPost(clanId: number, gameDate: string): ChatDigestPost | null {
  const r = getDb().prepare('SELECT * FROM chat_digest_posts WHERE clan_id = ? AND game_date = ?').get(clanId, gameDate) as PostRow | undefined;
  return r ? toPost(r) : null;
}

export function recentDigestPosts(clanId: number, limit = 7): ChatDigestPost[] {
  return (getDb().prepare('SELECT * FROM chat_digest_posts WHERE clan_id = ? ORDER BY game_date DESC LIMIT ?').all(clanId, limit) as PostRow[]).map(toPost);
}

/**
 * Why a digest day may NOT be attempted, or null when it may. A day is used up
 * once anything may have gone out for it (sent, sending, unknown), after a
 * verified failure has had its one retry, or when another digest already went
 * out on the same game day.
 */
export type BlockerCode = 'posted' | 'maybe-posted' | 'gave-up' | 'other-today';
export interface Blocker { code: BlockerCode; message: string; otherDay?: string }

export function attemptBlocker(clanId: number, gameDate: string, sentGameDate: string): Blocker | null {
  const row = getDigestPost(clanId, gameDate);
  if (row) {
    if (row.status === 'sent') return { code: 'posted', message: 'already posted' };
    if (row.status === 'sending' || row.status === 'unknown') return { code: 'maybe-posted', message: 'may already have gone out — never resent' };
    if (row.status === 'failed' && row.attempts >= MAX_ATTEMPTS) return { code: 'gave-up', message: 'failed twice — given up for that day' };
  }
  const other = getDb().prepare(
    `SELECT game_date FROM chat_digest_posts
      WHERE clan_id = ? AND sent_game_date = ? AND game_date <> ? AND status IN ('sent', 'sending', 'unknown') LIMIT 1`,
  ).get(clanId, sentGameDate, gameDate) as { game_date: string } | undefined;
  if (other) return { code: 'other-today', message: `a message already went out today (the ${other.game_date} digest)`, otherDay: other.game_date };
  return null;
}

/**
 * Reserve the day's one message BEFORE sending: in one transaction, check the
 * blocker and write the row as `sending` (a crash mid-send leaves it there,
 * and `sending` is never retried). Returns the row id, or the blocker.
 */
export function reserveDigestPost(
  p: { clanId: number; gameDate: string; sentGameDate: string; channelUrl: string; channelName: string; text: string; trigger: 'scheduled' | 'test' },
  now = new Date().toISOString(),
): { id: number } | { blocked: string } {
  const db = getDb();
  return db.transaction((): { id: number } | { blocked: string } => {
    const blocked = attemptBlocker(p.clanId, p.gameDate, p.sentGameDate);
    if (blocked) return { blocked: blocked.message };
    const row = getDigestPost(p.clanId, p.gameDate);
    if (row) {
      db.prepare(
        `UPDATE chat_digest_posts SET status = 'sending', attempts = attempts + 1, sent_game_date = ?, channel_url = ?,
           channel_name = ?, text = ?, error = NULL, trigger = ?, updated_at = ? WHERE id = ?`,
      ).run(p.sentGameDate, p.channelUrl, p.channelName, p.text, p.trigger, now, row.id);
      return { id: row.id };
    }
    const r = db.prepare(
      `INSERT INTO chat_digest_posts (clan_id, game_date, sent_game_date, channel_url, channel_name, status, attempts, text, trigger, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'sending', 1, ?, ?, ?, ?)`,
    ).run(p.clanId, p.gameDate, p.sentGameDate, p.channelUrl, p.channelName, p.text, p.trigger, now, now);
    return { id: Number(r.lastInsertRowid) };
  })();
}

/** Record how the send went: `sent` with the message id, `failed` (verified, nothing went out) or `unknown`. */
export function finishDigestPost(
  id: number,
  outcome: { status: 'sent'; messageId: number } | { status: 'failed' | 'unknown'; error: string },
  now = new Date().toISOString(),
): void {
  getDb().prepare('UPDATE chat_digest_posts SET status = ?, message_id = ?, error = ?, updated_at = ? WHERE id = ?').run(
    outcome.status,
    outcome.status === 'sent' ? outcome.messageId : null,
    outcome.status === 'sent' ? null : outcome.error,
    now,
    id,
  );
}
