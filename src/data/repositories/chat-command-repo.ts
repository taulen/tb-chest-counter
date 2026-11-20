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
import { getDb } from '../database.js';

export interface ChatCommandSettings {
  enabled: boolean;
  /** Epoch ms of the latest switch-on; messages sent before it are never answered. */
  enabledAt: number | null;
  /**
   * Also answer commands written in the clan's chat digest group chat, in
   * that chat (only while `enabled` is on too).
   */
  groupEnabled: boolean;
  /** Epoch ms of the latest switch-on of the group chat: messages there before it are never answered. */
  groupEnabledAt: number | null;
  updatedAt: string | null;
}

export function getChatCommandSettings(clanId: number): ChatCommandSettings {
  const r = getDb().prepare('SELECT enabled, enabled_at, group_enabled, group_enabled_at, updated_at FROM chat_command_settings WHERE clan_id = ?')
    .get(clanId) as { enabled: number; enabled_at: number | null; group_enabled: number; group_enabled_at: number | null; updated_at: string } | undefined;
  if (!r) return { enabled: false, enabledAt: null, groupEnabled: false, groupEnabledAt: null, updatedAt: null };
  return { enabled: r.enabled === 1, enabledAt: r.enabled_at, groupEnabled: r.group_enabled === 1, groupEnabledAt: r.group_enabled_at, updatedAt: r.updated_at };
}

function saveSettings(clanId: number, s: ChatCommandSettings, nowMs: number): ChatCommandSettings {
  getDb().prepare(
    `INSERT INTO chat_command_settings (clan_id, enabled, enabled_at, group_enabled, group_enabled_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id) DO UPDATE SET enabled = excluded.enabled, enabled_at = excluded.enabled_at,
       group_enabled = excluded.group_enabled, group_enabled_at = excluded.group_enabled_at, updated_at = excluded.updated_at`,
  ).run(clanId, s.enabled ? 1 : 0, s.enabledAt, s.groupEnabled ? 1 : 0, s.groupEnabledAt, new Date(nowMs).toISOString());
  return getChatCommandSettings(clanId);
}

/** Switch commands on or off. Switching on stamps the time: only messages sent after it are answered. */
export function setChatCommandsEnabled(clanId: number, enabled: boolean, nowMs = Date.now()): ChatCommandSettings {
  const current = getChatCommandSettings(clanId);
  const enabledAt = enabled ? (current.enabled ? current.enabledAt ?? nowMs : nowMs) : current.enabledAt;
  return saveSettings(clanId, { ...current, enabled, enabledAt }, nowMs);
}

/** Switch answering in the digest's group chat on or off; on stamps the time, as above. */
export function setChatCommandsGroupEnabled(clanId: number, groupEnabled: boolean, nowMs = Date.now()): ChatCommandSettings {
  const current = getChatCommandSettings(clanId);
  const groupEnabledAt = groupEnabled ? (current.groupEnabled ? current.groupEnabledAt ?? nowMs : nowMs) : current.groupEnabledAt;
  return saveSettings(clanId, { ...current, groupEnabled, groupEnabledAt }, nowMs);
}

export type CommandRequestStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'ignored';

export interface CommandRequest {
  id: number;
  clanId: number;
  channelUrl: string;
  messageId: number;
  senderChatId: string;
  playerId: number | null;
  command: string;
  /** The language the command word was in ("puntos" → es), when it says one. */
  language: string | null;
  requestedAt: number;
  status: CommandRequestStatus;
  reason: string | null;
  attempts: number;
  sentAt: number | null;
}

function rowToRequest(r: Record<string, unknown>): CommandRequest {
  return {
    id: r.id as number,
    clanId: r.clan_id as number,
    channelUrl: r.channel_url as string,
    messageId: r.message_id as number,
    senderChatId: r.sender_chat_id as string,
    playerId: (r.player_id as number | null) ?? null,
    command: r.command as string,
    language: (r.language as string | null) ?? null,
    requestedAt: r.requested_at as number,
    status: r.status as CommandRequestStatus,
    reason: (r.reason as string | null) ?? null,
    attempts: r.attempts as number,
    sentAt: (r.sent_at as number | null) ?? null,
  };
}

/** Record a command message once. False when it was already recorded (handled before). */
export function recordCommandRequest(
  req: { clanId: number; channelUrl: string; messageId: number; senderChatId: string; playerId: number | null; command: string; language: string | null; requestedAt: number },
  status: 'pending' | 'ignored',
  reason: string | null,
  now = new Date().toISOString(),
): boolean {
  return getDb().prepare(
    `INSERT OR IGNORE INTO chat_command_requests
       (clan_id, channel_url, message_id, sender_chat_id, player_id, command, language, requested_at, status, reason, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(req.clanId, req.channelUrl, req.messageId, req.senderChatId, req.playerId, req.command, req.language, req.requestedAt, status, reason, now, now).changes > 0;
}

export function pendingCommandRequests(clanId: number): CommandRequest[] {
  return (getDb().prepare("SELECT * FROM chat_command_requests WHERE clan_id = ? AND status = 'pending' ORDER BY requested_at, id")
    .all(clanId) as Record<string, unknown>[]).map(rowToRequest);
}

export function setCommandRequestStatus(id: number, status: CommandRequestStatus, reason: string | null, now = new Date().toISOString()): void {
  getDb().prepare('UPDATE chat_command_requests SET status = ?, reason = ?, updated_at = ? WHERE id = ?').run(status, reason, now, id);
}

/**
 * This command is already waiting, on its way, or answered since `sinceMs` in
 * this chat — for this player, or (playerId null) for anyone: asking again
 * gets nothing new, the answer is in the chat.
 */
export function commandRepeated(clanId: number, channelUrl: string, playerId: number | null, command: string, sinceMs: number): boolean {
  return !!getDb().prepare(
    `SELECT 1 FROM chat_command_requests
      WHERE clan_id = ? AND channel_url = ? AND (? IS NULL OR player_id = ?) AND command = ?
        AND (status IN ('pending', 'sending') OR (status IN ('sent', 'unknown') AND sent_at >= ?))
      LIMIT 1`,
  ).get(clanId, channelUrl, playerId, playerId, command, sinceMs);
}

/** Replies tried into one chat since `sinceMs` (a group chat's hourly budget). */
export function channelRepliesSince(clanId: number, channelUrl: string, sinceMs: number): number {
  return (getDb().prepare(
    'SELECT COUNT(*) AS n FROM chat_command_requests WHERE clan_id = ? AND channel_url = ? AND sent_at >= ?',
  ).get(clanId, channelUrl, sinceMs) as { n: number }).n;
}

/** How many of the player's command messages since `sinceMs` were taken on (answered, or waiting to be). */
export function playerCommandCount(playerId: number, sinceMs: number): number {
  return (getDb().prepare(
    "SELECT COUNT(*) AS n FROM chat_command_requests WHERE player_id = ? AND requested_at >= ? AND status IN ('pending', 'sending', 'sent', 'unknown', 'failed')",
  ).get(playerId, sinceMs) as { n: number }).n;
}

/** Replies the clan's scanner account tried since `sinceMs` (the clan's hourly budget). */
export function clanRepliesSince(clanId: number, sinceMs: number): number {
  return (getDb().prepare(
    'SELECT COUNT(*) AS n FROM chat_command_requests WHERE clan_id = ? AND sent_at >= ?',
  ).get(clanId, sinceMs) as { n: number }).n;
}

/**
 * Reserve a request for its reply: `pending` → `sending`, the try counted and
 * stamped. A crash leaves it `sending`, and a `sending` row is never sent
 * again. False when it is no longer pending.
 */
export function reserveCommandSend(id: number, nowMs = Date.now()): boolean {
  return getDb().prepare(
    "UPDATE chat_command_requests SET status = 'sending', attempts = attempts + 1, sent_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
  ).run(nowMs, new Date(nowMs).toISOString(), id).changes > 0;
}

/**
 * The reply's outcome. `sent`: done. `refused` (nothing went out): it waits
 * for another try, up to three. `unknown` (it may have gone out): never
 * resent. `muted` (the scanner account is muted): it waits, the try not
 * counted — and not charged to the clan's budget either.
 */
export function finishCommandSend(
  id: number,
  outcome: { status: 'sent'; messageId: number } | { status: 'refused'; error: string } | { status: 'unknown'; error: string },
  opts: { muted?: boolean } = {},
  now = new Date().toISOString(),
): void {
  const db = getDb();
  if (outcome.status === 'sent') {
    db.prepare("UPDATE chat_command_requests SET status = 'sent', reason = NULL, reply_message_id = ?, updated_at = ? WHERE id = ?")
      .run(outcome.messageId, now, id);
  } else if (outcome.status === 'refused' && opts.muted) {
    db.prepare("UPDATE chat_command_requests SET status = 'pending', reason = 'muted', sent_at = NULL, attempts = MAX(attempts - 1, 0), updated_at = ? WHERE id = ?")
      .run(now, id);
  } else if (outcome.status === 'refused') {
    const attempts = (db.prepare('SELECT attempts FROM chat_command_requests WHERE id = ?').get(id) as { attempts: number } | undefined)?.attempts ?? 0;
    db.prepare('UPDATE chat_command_requests SET status = ?, reason = ?, sent_at = NULL, updated_at = ? WHERE id = ?')
      .run(attempts >= 3 ? 'failed' : 'pending', outcome.error.slice(0, 300), now, id);
  } else {
    db.prepare("UPDATE chat_command_requests SET status = 'unknown', reason = ?, updated_at = ? WHERE id = ?")
      .run(outcome.error.slice(0, 300), now, id);
  }
}

export function recentCommandRequests(clanId: number, limit = 25): CommandRequest[] {
  return (getDb().prepare('SELECT * FROM chat_command_requests WHERE clan_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?')
    .all(clanId, limit) as Record<string, unknown>[]).map(rowToRequest);
}

/** Replies sent in the last day, for the settings line. */
export function commandRepliesSentSince(clanId: number, sinceMs: number): number {
  return (getDb().prepare(
    "SELECT COUNT(*) AS n FROM chat_command_requests WHERE clan_id = ? AND status = 'sent' AND sent_at >= ?",
  ).get(clanId, sinceMs) as { n: number }).n;
}
