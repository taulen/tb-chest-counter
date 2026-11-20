/**
 * Chat commands (v135; docs/chat-commands.md).
 *
 * A member messages the clan's scanner account one word in the game and gets
 * their numbers back in that same 1:1 chat — the site's Members board, goal
 * and pace, read where they play:
 *
 *   me        this week: rank, points, chests, today, the goal, last week,
 *             might / guards / Gold Pass
 *   points    this week's points, rank, today, the goal
 *   chests    this week's chests, today
 *   top       the clan's top 10 this week
 *   progress  the last 4 weeks against the goal
 *   events    events running now and coming up (the event calendar)
 *   help      the list
 *   missing   (Leader / Superior only) who is behind pace this week
 *
 * Off by default, per clan (Clans → Chat commands). The chat is read every
 * minute (chat-capture.ts); a reply goes out within a minute when the clan's
 * last scan kept a game session for a chat token. When none is kept (the
 * server restarted since), a waiting command asks for a scan of that clan,
 * like a code request — at most once per clan every 10 minutes.
 *
 * A second switch also answers commands written in the clan's chat digest
 * group chat (the named chat its admins picked — CWB • Carter), there, for
 * everyone in it: never any other group chat, never the clan or kingdom chat
 * (assertCommandGroupChannel). That chat is read forward only, from the
 * switch-on; its history is not stored.
 *
 * Every reply is one message no longer than the digest's ceiling (898 chars,
 * 1,114 bytes) or the chat's own max_length_message when that is smaller:
 * lists drop lines ("… and 4 more") until it fits.
 *
 * The same guards as an account-invite reply (chat-invites.ts), the only
 * other message the scanner account sends into a private chat:
 *   - commands are on for the clan, and the message came after the switch-on
 *     and within MAX_COMMAND_AGE_MS;
 *   - the sender is on the clan's roster (anyone else gets no answer at all);
 *   - the chat is a `whisper` with exactly the scanner and the sender in it;
 *   - the sender's chat account is the one that player writes from;
 *   - nothing while the game has the scanner account muted, and
 *     CHAT_SEND_DISABLED=1 answers nothing.
 * And because every reply is one more message from an account the game has
 * muted before (Nov 18 2026: 20 messages in three minutes, an hour's mute),
 * the scanner never bursts:
 *   - the same command again within REPEAT_WINDOW_MS gets nothing (the answer
 *     is already in their chat), and a player gets at most
 *     PLAYER_MAX_PER_HOUR replies an hour;
 *   - at most COMMAND_REPLIES_PER_RUN replies a minute, COMMAND_SEND_GAP_MS
 *     apart, one per player, and at most CLAN_MAX_PER_HOUR an hour for the
 *     whole clan (the rest wait);
 *   - in the group chat, one reply a minute and GROUP_MAX_PER_HOUR an hour,
 *     and a shared answer (top, events, help, missing) asked again by anyone
 *     within REPEAT_WINDOW_MS gets nothing — it is right there above.
 * Every command message is recorded once (chat_command_requests), answered or
 * not, so nothing is answered twice. A reply with no answer (`unknown`) is
 * never resent. Anything that isn't a command gets no reply.
 */
import { getDb } from '../data/database.js';
import {
  channelRepliesSince,
  clanRepliesSince,
  commandRepeated,
  finishCommandSend,
  getChatCommandSettings,
  pendingCommandRequests,
  playerCommandCount,
  recordCommandRequest,
  reserveCommandSend,
  setCommandRequestStatus,
  type CommandRequest,
} from '../data/repositories/chat-command-repo.js';
import { getClanById, type Clan } from '../data/repositories/clan-repo.js';
import { accountForPlayer, getInviteSettings, rankRole } from '../data/repositories/account-invite-repo.js';
import { getUserById, isValidLanguage } from '../data/repositories/user-repo.js';
import { getChatDigestSettings } from '../data/repositories/chat-digest-repo.js';
import { chatPausedUntil } from '../data/repositories/chat-send-state-repo.js';
import { getLeaderboard } from '../data/repositories/chest-repo.js';
import { queryLeaderboard, resolveWeeklyGoal } from '../web/routes/leaderboard-handler.js';
import { gameDateFor, gameWindow, weekLengthDays } from '../utils/game-day.js';
import { weeklyGoalForDays } from '../utils/weekly-goal.js';
import { loadConfig } from '../config/index.js';
import { EVENT_CATALOG } from '../config/event-catalog.js';
import { getEventOccurrences, getEventSchedule } from '../external/event-calendar.js';
import { gameTextsResponse } from '../game-protocol/game-texts.js';
import { myMuteInfo, type ChatSession, type MuteInfo } from '../game-protocol/chat.js';
import {
  assertCommandGroupChannel,
  assertInviteChannel,
  chatSendingDisabled,
  fitsCommandReply,
  sendCommandReply,
  sendGroupCommandReply,
  type SocketSender,
} from '../game-protocol/chat-send.js';
import { COMMAND_TEXTS, pluralWord, type CommandTexts, type Forms, type ReplyLanguage } from './chat-command-texts.js';
import { channelFor, chatAccountMismatch, isInviteKeyword, noteSendOutcome } from './chat-invites.js';
import { childLogger } from '../utils/logger.js';
import { createCoalescedWarner } from '../utils/log-throttle.js';
import type { LeaderboardEntry } from '../models/types.js';

const log = childLogger('chat-commands');
const quietWarner = createCoalescedWarner((m) => log.warn({ noAlert: true }, m), 24 * 3600_000);
const alertWarner = createCoalescedWarner((m) => log.warn(m), 3600_000);

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// ── Limits ─────────────────────────────────────────────────────────────────

/** Older command messages are never answered: waiting for a scan this long, the moment has passed. */
export const MAX_COMMAND_AGE_MS = 3 * HOUR;
/** The same command again within this window gets nothing: the answer is in their chat. */
export const REPEAT_WINDOW_MS = 10 * 60_000;
/** Replies one player can get in an hour; past it their commands are ignored. */
export const PLAYER_MAX_PER_HOUR = 10;
/** Replies a run (the chat is read every minute) — the rest wait for the next one. */
export const COMMAND_REPLIES_PER_RUN = 3;
/** Between two replies in one run. */
export const COMMAND_SEND_GAP_MS = 4_000;
/** Replies the whole clan can get in an hour; past it they wait. */
export const CLAN_MAX_PER_HOUR = 30;
/**
 * Replies into the clan's digest group chat in an hour (one a run at most):
 * everyone there reads each one, and a clan mutes a spammer.
 */
export const GROUP_MAX_PER_HOUR = 12;
/**
 * Commands whose answer is the same for whoever asks: in a group chat,
 * anyone asking again within REPEAT_WINDOW_MS gets nothing — it is right
 * there above. The rest (me, points, …) repeat per player.
 */
export const SHARED_COMMANDS: readonly ChatCommand[] = ['top', 'events', 'help', 'missing'];
/** How many lines `top` lists. */
export const TOP_ENTRIES = 10;
/** How many closed weeks `progress` lists before this one. */
export const PROGRESS_WEEKS = 4;

// ── The words ──────────────────────────────────────────────────────────────

export type ChatCommand = 'help' | 'me' | 'points' | 'chests' | 'top' | 'progress' | 'events' | 'missing';
/** The commands as `help` lists them (English: they work in every language). */
export const MEMBER_COMMANDS: readonly ChatCommand[] = ['me', 'points', 'chests', 'top', 'progress', 'events'];
export const LEADER_COMMANDS: readonly ChatCommand[] = ['missing'];

type Alias = { command: ChatCommand; lang?: ReplyLanguage };
const A = (command: ChatCommand, lang?: ReplyLanguage): Alias => ({ command, lang });
/**
 * Every word that is a command: the English ones (any language) and a few in
 * the site's other languages, which also pick the reply's language. Never an
 * account-invite keyword ("code", "invite", "tracker", …): those are
 * chat-invites.ts's. Short words a player might just say ("yo") are left out.
 */
export const ALIASES: Readonly<Record<string, Alias>> = {
  help: A('help'), commands: A('help'), ayuda: A('help', 'es'), comandos: A('help', 'es'), aide: A('help', 'fr'), commandes: A('help', 'fr'),
  hilfe: A('help', 'de'), befehle: A('help', 'de'), 'помощь': A('help', 'ru'), 'команды': A('help', 'ru'),
  me: A('me'), stats: A('me'), moi: A('me', 'fr'), ich: A('me', 'de'), 'я': A('me', 'ru'),
  points: A('points'), crypt: A('points'), puntos: A('points', 'es'), punkte: A('points', 'de'), 'очки': A('points', 'ru'),
  chests: A('chests'), cofres: A('chests', 'es'), coffres: A('chests', 'fr'), truhen: A('chests', 'de'), 'сундуки': A('chests', 'ru'),
  top: A('top'), leaderboard: A('top'), ranking: A('top'), classement: A('top', 'fr'), rangliste: A('top', 'de'), clasificación: A('top', 'es'),
  clasificacion: A('top', 'es'), 'топ': A('top', 'ru'), 'рейтинг': A('top', 'ru'),
  progress: A('progress'), progreso: A('progress', 'es'), progrès: A('progress', 'fr'), progres: A('progress', 'fr'),
  fortschritt: A('progress', 'de'), 'прогресс': A('progress', 'ru'),
  events: A('events'), calendar: A('events'), eventos: A('events', 'es'), calendario: A('events', 'es'), événements: A('events', 'fr'),
  evenements: A('events', 'fr'), calendrier: A('events', 'fr'), kalender: A('events', 'de'), 'события': A('events', 'ru'), 'календарь': A('events', 'ru'),
  missing: A('missing'), faltan: A('missing', 'es'), manquants: A('missing', 'fr'), fehlen: A('missing', 'de'), 'отстающие': A('missing', 'ru'),
};

/**
 * The command a private message is, or null: the whole message, trimmed and
 * lower-cased, with a leading "!" or "/" and trailing punctuation dropped, is
 * one command word ("me", "!Top", "puntos."). "what are my points" is not.
 */
export function parseChatCommand(text: string): { command: ChatCommand; lang: ReplyLanguage | null } | null {
  if (isInviteKeyword(text)) return null;
  const t = String(text ?? '').normalize('NFC').trim().toLowerCase()
    .replace(/^[!/#¡¿]+/u, '')
    .replace(/[\s.!?…]+$/u, '');
  const hit = Object.prototype.hasOwnProperty.call(ALIASES, t) ? ALIASES[t] : undefined;
  return hit ? { command: hit.command, lang: hit.lang ?? null } : null;
}

// ── Who gets an answer ─────────────────────────────────────────────────────

/**
 * The group chat commands are also answered in, or null: the clan's chat
 * digest chat (Clans → In-game chat digest — CWB • Carter), when commands and
 * "answer in the group chat" are both on and a chat is picked there.
 */
export function commandGroupChannel(clanId: number): string | null {
  const s = getChatCommandSettings(clanId);
  if (!s.enabled || !s.groupEnabled) return null;
  return getChatDigestSettings(clanId).channelUrl || null;
}

/**
 * What the chat sync reads of the group chat: its url and the time to read
 * forward from — the switch-on, at most MAX_COMMAND_AGE_MS back. Null when
 * commands aren't answered there. Its history is never read.
 */
export function commandGroupRead(clanId: number, nowMs = Date.now()): { url: string; fromMs: number } | null {
  const url = commandGroupChannel(clanId);
  if (!url) return null;
  const s = getChatCommandSettings(clanId);
  return { url, fromMs: Math.max(s.groupEnabledAt ?? nowMs, s.enabledAt ?? nowMs, nowMs - MAX_COMMAND_AGE_MS) };
}

/**
 * Why a command must not be answered, or null when it may be. In a private
 * chat, the invite reply's guards (roster, the 1:1 chat, the chat account);
 * in the group chat, the same but the chat must be the digest's
 * (assertCommandGroupChannel). Checked when the message is first seen and
 * again right before the reply.
 */
export function commandRequestBlocker(
  clanId: number,
  scannerChatId: string,
  req: { channelUrl: string; senderChatId: string; playerId: number | null },
): string | null {
  if (chatSendingDisabled()) return 'sending-disabled';
  if (!req.playerId) return 'no-player';
  const onRoster = getDb().prepare('SELECT 1 FROM game_players WHERE clan_id = ? AND player_id = ? AND in_clan = 1').get(clanId, req.playerId);
  if (!onRoster) return 'not-member';
  const channel = channelFor(clanId, req.channelUrl);
  if (!channel) return 'channel';
  try {
    if (channel.customType === 'whisper') assertInviteChannel(channel, scannerChatId, req.senderChatId);
    else assertCommandGroupChannel(channel, commandGroupChannel(clanId));
  } catch {
    return channel.customType === 'whisper' ? 'channel' : 'group-off';
  }
  if (chatAccountMismatch(req.playerId, req.senderChatId)) return 'chat-account-mismatch';
  return null;
}

function noteBlocked(clanId: number, playerId: number | null, reason: string): void {
  if (reason === 'chat-account-mismatch') {
    alertWarner.warn(`mismatch:${clanId}:${playerId}`, `Clan #${clanId}: a chat command for player ${playerId} came from a chat account that player has not written from before — not answered`);
  }
}

/**
 * Record every new command message once — in the clan's private chats, and in
 * the digest's group chat when that is on: `pending` when it may be answered,
 * `ignored` (with the reason) when not. Returns how many were recorded.
 */
export function detectChatCommands(clanId: number, scannerChatId: string, nowMs = Date.now()): number {
  const settings = getChatCommandSettings(clanId);
  if (!settings.enabled || settings.enabledAt === null || !scannerChatId) return 0;
  const since = Math.max(settings.enabledAt, nowMs - MAX_COMMAND_AGE_MS);
  const group = commandGroupChannel(clanId);
  const groupSince = Math.max(since, settings.groupEnabledAt ?? Infinity);
  // Newest first, so a chatty hour can't push new messages past the limit;
  // handled oldest first below.
  const rows = (getDb().prepare(
    `SELECT m.channel_url, m.message_id, m.created_at, m.sender_id, m.sender_player_id, m.message
       FROM chat_messages m
       JOIN chat_channels c ON c.clan_id = m.clan_id AND c.channel_url = m.channel_url
      WHERE m.clan_id = ? AND m.custom_type = 'user'
        AND ((c.custom_type = 'whisper' AND m.created_at >= ?) OR (m.channel_url = ? AND m.created_at >= ?))
        AND m.sender_id <> ? AND m.sender_id <> '' AND length(m.message) <= 40
        AND NOT EXISTS (SELECT 1 FROM chat_command_requests r
                         WHERE r.clan_id = m.clan_id AND r.channel_url = m.channel_url AND r.message_id = m.message_id)
      ORDER BY m.created_at DESC, m.message_id DESC LIMIT 500`,
  ).all(clanId, since, group ?? '', Number.isFinite(groupSince) ? groupSince : nowMs + DAY, scannerChatId) as Array<{
    channel_url: string; message_id: number; created_at: number; sender_id: string; sender_player_id: number | null; message: string;
  }>).reverse();
  let recorded = 0;
  for (const m of rows) {
    const parsed = parseChatCommand(m.message);
    if (!parsed) continue;
    const req = { channelUrl: m.channel_url, senderChatId: m.sender_id, playerId: m.sender_player_id };
    let blocker = commandRequestBlocker(clanId, scannerChatId, req);
    if (!blocker && m.sender_player_id) {
      // In the group chat a shared answer (top, events, …) is there for everyone.
      const anyone = m.channel_url === group && SHARED_COMMANDS.includes(parsed.command);
      if (commandRepeated(clanId, m.channel_url, anyone ? null : m.sender_player_id, parsed.command, nowMs - REPEAT_WINDOW_MS)) blocker = 'repeat';
      else if (playerCommandCount(m.sender_player_id, nowMs - HOUR) >= PLAYER_MAX_PER_HOUR) blocker = 'player-limit';
    }
    const ok = recordCommandRequest(
      {
        clanId, channelUrl: m.channel_url, messageId: m.message_id, senderChatId: m.sender_id,
        playerId: m.sender_player_id, command: parsed.command, language: parsed.lang, requestedAt: m.created_at,
      },
      blocker ? 'ignored' : 'pending',
      blocker,
    );
    if (!ok) continue;
    recorded++;
    if (blocker) noteBlocked(clanId, m.sender_player_id, blocker);
  }
  return recorded;
}

// ── The replies ────────────────────────────────────────────────────────────

/**
 * The reply's language: the one the command word was in ("puntos"), else —
 * in a private chat — the player's site account's, else the clan's chat
 * digest language (what the group chat reads), else English.
 */
export function replyLanguage(clanId: number, req: Pick<CommandRequest, 'language' | 'playerId'>, inGroup = false): ReplyLanguage {
  if (isValidLanguage(req.language)) return req.language;
  const userId = !inGroup && req.playerId ? accountForPlayer(req.playerId) : null;
  const own = userId ? getUserById(userId)?.language : null;
  if (isValidLanguage(own)) return own;
  const clanLang = getChatDigestSettings(clanId).language;
  return isValidLanguage(clanLang) ? clanLang : 'en';
}

interface WeekView {
  win: { from: string; to: string };
  rows: LeaderboardEntry[];
  goal: number | null;
  /** The pace mark while the week runs; null once it has ended. */
  pace: number | null;
  day: number;
  days: number;
}

/** The weekly goal for one window: the history's, so a past week is judged by its own goal. */
function goalForWindow(clan: Clan, win: { from: string; to: string }, rollover: number): number | null {
  const { weeklyPoints, history } = resolveWeeklyGoal(clan);
  if (weeklyPoints === null) return null;
  return weeklyGoalForDays(weeklyPoints, history, gameDateFor(Date.parse(win.from), rollover), gameDateFor(Date.parse(win.to) - 1, rollover));
}

/** The clan's week `offset` weeks back: the Members board's rows, its goal and (this week) the pace mark. */
function weekView(clan: Clan, offset: number, nowMs: number): WeekView {
  const rollover = loadConfig().gameDayRolloverUtcHour;
  const weekStart = clan.weekStart ?? 'sunday';
  const win = gameWindow('weekly', offset, rollover, weekStart, nowMs)!;
  const rows = queryLeaderboard(clan.id, { from: win.from, to: win.to, includeAllMembers: true });
  const goal = goalForWindow(clan, win, rollover);
  const days = weekLengthDays(weekStart);
  const fromMs = Date.parse(win.from);
  const toMs = Date.parse(win.to);
  const running = nowMs >= fromMs && nowMs < toMs;
  const day = Math.min(days, Math.max(1, Math.floor((nowMs - fromMs) / DAY) + 1));
  const pace = goal !== null && running ? Math.round(goal * ((nowMs - fromMs) / (toMs - fromMs))) : null;
  return { win, rows, goal, pace, day, days };
}

interface Ctx {
  clan: Clan;
  playerId: number;
  lang: ReplyLanguage;
  tx: CommandTexts;
  nowMs: number;
  /** The reply's chat's own longest message, null when not known (our ceiling then). */
  channelMax: number | null;
  num: (n: number) => string;
  amount: (n: number, forms: Forms) => string;
  fits: (text: string) => boolean;
}

function makeCtx(clan: Clan, playerId: number, lang: ReplyLanguage, nowMs: number, channelMax: number | null): Ctx {
  const tx = COMMAND_TEXTS[lang] ?? COMMAND_TEXTS.en;
  const fmt = new Intl.NumberFormat(tx.locale);
  const num = (n: number) => fmt.format(n);
  return {
    clan, playerId, lang, tx, nowMs, channelMax, num,
    amount: (n, forms) => `${num(n)} ${pluralWord(tx.locale, n, forms)}`,
    fits: (text) => fitsCommandReply(text, channelMax),
  };
}

function memberOf(clanId: number, playerId: number): { id: number; name: string } | null {
  return (getDb().prepare('SELECT id, name FROM members WHERE clan_id = ? AND game_player_id = ? ORDER BY is_active DESC LIMIT 1')
    .get(clanId, playerId) as { id: number; name: string } | undefined) ?? null;
}

function isLeader(clanId: number, playerId: number): boolean {
  const r = getDb().prepare('SELECT role FROM game_players WHERE clan_id = ? AND player_id = ? AND in_clan = 1').get(clanId, playerId) as { role: number | null } | undefined;
  return !!r && rankRole(r.role) === 'admin';
}

/** The goal line for this week, or null without a goal. */
function goalLine(c: Ctx, points: number, week: WeekView): string | null {
  if (week.goal === null) return null;
  if (points >= week.goal) return c.tx.goalReached(c.num(week.goal));
  if (week.pace === null) return null;
  return points >= week.pace
    ? c.tx.goalOnPace(c.num(week.goal), c.num(week.pace))
    : c.tx.goalBehind(c.num(week.goal), c.num(week.pace), c.num(week.goal - points));
}

/** Today's row for the member (the game day so far). */
function todayRow(c: Ctx, memberId: number): { points: number; chests: number } {
  const rollover = loadConfig().gameDayRolloverUtcHour;
  const win = gameWindow('daily', 0, rollover, c.clan.weekStart ?? 'sunday', c.nowMs)!;
  const row = getLeaderboard(c.clan.id, win.from, win.to, { includeAllMembers: true }).find((r) => r.memberId === memberId);
  return { points: row?.totalPoints ?? 0, chests: row?.totalChests ?? 0 };
}

function compactNumber(c: Ctx, n: number): string {
  return new Intl.NumberFormat(c.tx.locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function meReply(c: Ctx): string {
  const member = memberOf(c.clan.id, c.playerId);
  const week = weekView(c.clan, 0, c.nowMs);
  const idx = member ? week.rows.findIndex((r) => r.memberId === member.id) : -1;
  if (!member || idx < 0) return c.tx.notOnBoard;
  const row = week.rows[idx];
  const today = todayRow(c, member.id);
  const last = weekView(c.clan, 1, c.nowMs);
  const lastIdx = last.rows.findIndex((r) => r.memberId === member.id);
  const profile = [
    row.might != null ? `${c.tx.might} ${compactNumber(c, row.might)}` : '',
    row.guardsLevel != null ? `${c.tx.guards} ${row.guardsLevel}` : '',
    row.goldPass === 'current' ? c.tx.goldPass : row.goldPass === 'previous' ? c.tx.goldPassPrevious : '',
  ].filter(Boolean).join(' · ');
  return [
    `${row.memberName} — ${c.tx.thisWeek(week.day, week.days)}`,
    `${c.tx.rankOf(idx + 1, week.rows.length)} · ${c.amount(row.totalPoints, c.tx.points)} · ${c.amount(row.totalChests, c.tx.chests)}`,
    c.tx.today(`${c.amount(today.points, c.tx.points)} · ${c.amount(today.chests, c.tx.chests)}`),
    goalLine(c, row.totalPoints, week),
    lastIdx >= 0 ? c.tx.lastWeek(`${c.amount(last.rows[lastIdx].totalPoints, c.tx.points)} · ${c.tx.rankOf(lastIdx + 1, last.rows.length)}`) : null,
    profile || null,
  ].filter((l): l is string => !!l).join('\n');
}

function pointsReply(c: Ctx): string {
  const member = memberOf(c.clan.id, c.playerId);
  const week = weekView(c.clan, 0, c.nowMs);
  const idx = member ? week.rows.findIndex((r) => r.memberId === member.id) : -1;
  if (!member || idx < 0) return c.tx.notOnBoard;
  const row = week.rows[idx];
  return [
    `${row.memberName}: ${c.amount(row.totalPoints, c.tx.points)} ${c.tx.thisWeek(week.day, week.days)} · ${c.tx.rankOf(idx + 1, week.rows.length)}`,
    c.tx.today(c.amount(todayRow(c, member.id).points, c.tx.points)),
    goalLine(c, row.totalPoints, week),
  ].filter((l): l is string => !!l).join('\n');
}

function chestsReply(c: Ctx): string {
  const member = memberOf(c.clan.id, c.playerId);
  const week = weekView(c.clan, 0, c.nowMs);
  const row = member ? week.rows.find((r) => r.memberId === member.id) : undefined;
  if (!member || !row) return c.tx.notOnBoard;
  // Ranked by chests here (the board ranks by points): ties share the better place.
  const rank = week.rows.filter((r) => r.totalChests > row.totalChests).length + 1;
  return [
    `${row.memberName}: ${c.amount(row.totalChests, c.tx.chests)} ${c.tx.thisWeek(week.day, week.days)} · ${c.tx.rankOf(rank, week.rows.length)}`,
    c.tx.today(c.amount(todayRow(c, member.id).chests, c.tx.chests)),
  ].join('\n');
}

/**
 * Whether a reply fits one message: the size the digest posts (898 chars,
 * 1,114 bytes), or the chat's own `max_length_message` when that is smaller.
 */
export function fitsReply(text: string, channelMax: number | null = null): boolean {
  return fitsCommandReply(text, channelMax);
}

/**
 * Head lines, as many list lines as fit, "… and N more" for the rest, then
 * the tail — one message, never split, never past `fits`.
 */
function fitList(head: string[], items: string[], tail: string[], more: (n: number) => string, fits: (text: string) => boolean): string {
  for (let n = items.length; n >= 0; n--) {
    const rest = items.length - n;
    const text = [...head, ...items.slice(0, n), ...(rest ? [more(rest)] : []), ...tail].join('\n');
    if (fits(text)) return text;
  }
  // Even the head and tail are too long (very long names, a tiny limit): cut to it.
  let text = [...head, ...tail].join('\n');
  while (text.length > 1 && !fits(text)) text = `${[...text].slice(0, -2).join('')}…`;
  return text;
}

function topReply(c: Ctx): string {
  const week = weekView(c.clan, 0, c.nowMs);
  const member = memberOf(c.clan.id, c.playerId);
  const shown = week.rows.filter((r) => r.totalPoints > 0 || r.totalChests > 0).slice(0, TOP_ENTRIES);
  const head = [`${c.tx.topHead(shown.length || TOP_ENTRIES, c.tx.thisWeek(week.day, week.days))} · ${c.tx.pointsChests}`];
  const items = shown.map((r, i) => `${i + 1}. ${r.memberName} ${c.num(r.totalPoints)} (${c.num(r.totalChests)})`);
  const idx = member ? week.rows.findIndex((r) => r.memberId === member.id) : -1;
  const tail = idx >= shown.length && idx >= 0
    ? [`${c.tx.you}: ${c.tx.rankOf(idx + 1, week.rows.length)} · ${c.num(week.rows[idx].totalPoints)} (${c.num(week.rows[idx].totalChests)})`]
    : [];
  return fitList(head, items.length ? items : ['—'], tail, c.tx.andMore, c.fits);
}

function progressReply(c: Ctx): string {
  const member = memberOf(c.clan.id, c.playerId);
  if (!member) return c.tx.notOnBoard;
  const rollover = loadConfig().gameDayRolloverUtcHour;
  const joined = (getDb().prepare('SELECT joined_at FROM game_players WHERE clan_id = ? AND player_id = ?').get(c.clan.id, c.playerId) as { joined_at: number | null } | undefined)?.joined_at ?? null;
  const lines = [c.tx.progressHead(member.name, PROGRESS_WEEKS)];
  for (let offset = PROGRESS_WEEKS; offset >= 1; offset--) {
    const week = weekView(c.clan, offset, c.nowMs);
    const date = gameDateFor(Date.parse(week.win.from), rollover);
    if (joined !== null && joined * 1000 >= Date.parse(week.win.to)) {
      lines.push(`${date}: ${c.tx.notInClanYet}`);
      continue;
    }
    const idx = week.rows.findIndex((r) => r.memberId === member.id);
    const points = idx >= 0 ? week.rows[idx].totalPoints : 0;
    const rank = idx >= 0 ? ` · #${idx + 1}` : '';
    const goal = week.goal === null ? '' : ` · ${c.tx.goalWord} ${points >= week.goal ? '✓' : `✗ (${c.num(week.goal)})`}`;
    lines.push(`${date}: ${c.num(points)}${rank}${goal}`);
  }
  const now = weekView(c.clan, 0, c.nowMs);
  const idx = now.rows.findIndex((r) => r.memberId === member.id);
  if (idx >= 0) lines.push(`${c.tx.thisWeekSoFar}: ${c.num(now.rows[idx].totalPoints)} · #${idx + 1}`);
  return fitList(lines.slice(0, 1), lines.slice(1), [], c.tx.andMore, c.fits);
}

/** "1d 4h", "3h 20m", "12m" — in the reply's language's units. */
export function durationText(ms: number, units: CommandTexts['units']): string {
  const total = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const part = (n: number, u: string) => (units.space ? `${n} ${u}` : `${n}${u}`);
  if (d > 0) return h ? `${part(d, units.d)} ${part(h, units.h)}` : part(d, units.d);
  if (h > 0) return m ? `${part(h, units.h)} ${part(m, units.m)}` : part(h, units.h);
  return part(m, units.m);
}

const textsCache = new Map<string, { etag: string; texts: Record<string, string> }>();
/** A game name in the reply's language, from the game's own translations (as tGame does on the site). */
function gameName(name: string, lang: ReplyLanguage): string {
  if (lang === 'en') return name;
  const res = gameTextsResponse(lang);
  if (!res) return name;
  let hit = textsCache.get(lang);
  if (!hit || hit.etag !== res.etag) {
    let texts: Record<string, string> = {};
    try { texts = (JSON.parse(res.body) as { texts?: Record<string, string> }).texts ?? {}; } catch { /* none */ }
    hit = { etag: res.etag, texts };
    textsCache.set(lang, hit);
  }
  return hit.texts[name] || name;
}

/** At most this many event lines. */
const EVENT_LINES = 6;

async function eventsReply(c: Ctx): Promise<string> {
  const live: Array<{ name: string; endMs: number | null }> = [];
  const next: Array<{ name: string; startMs: number }> = [];
  let tried = 0;
  let failed = 0;
  for (const def of EVENT_CATALOG) {
    const calendarName = def.calendarNames?.[0];
    if (!calendarName) continue;
    tried++;
    try {
      const s = await getEventSchedule(def.key, c.clan.id);
      const name = gameName(calendarName, c.lang);
      if (s.live) {
        const current = (await getEventOccurrences(def.key, c.clan.id)).find((o) => o.isCurrent);
        live.push({ name, endMs: current ? Date.parse(current.resetAt) : null });
      }
      if (s.next) next.push({ name, startMs: Date.parse(s.next.from) });
    } catch (err) {
      failed++;
      quietWarner.warn(`events:${def.key}`, `Chat command "events": could not read ${def.key}'s schedule: ${String(err)}`);
    }
  }
  if (tried > 0 && failed === tried) return c.tx.calendarDown;
  if (!live.length && !next.length) return c.tx.noEvents;
  const lines = [
    c.tx.eventsHead,
    ...live.map((l) => c.tx.liveNow(l.name, l.endMs !== null && l.endMs > c.nowMs ? durationText(l.endMs - c.nowMs, c.tx.units) : null)),
    ...next.sort((a, b) => a.startMs - b.startMs).map((n) => c.tx.nextUp(n.name, durationText(n.startMs - c.nowMs, c.tx.units))),
  ];
  return fitList(lines.slice(0, 1), lines.slice(1, 1 + EVENT_LINES), [], c.tx.andMore, c.fits);
}

function missingReply(c: Ctx): string {
  if (!isLeader(c.clan.id, c.playerId)) return c.tx.leadersOnly;
  const week = weekView(c.clan, 0, c.nowMs);
  if (week.goal === null) return c.tx.noGoal;
  const thisWeek = c.tx.thisWeek(week.day, week.days);
  // The Members board's red: below the goal and below the pace mark.
  const behind = week.rows
    .filter((r) => r.totalPoints < week.goal! && (week.pace === null || r.totalPoints < week.pace))
    .sort((a, b) => a.totalPoints - b.totalPoints || a.memberName.localeCompare(b.memberName));
  if (!behind.length) return capitalize(c.tx.nobodyBehind(thisWeek));
  const head = [
    capitalize(c.tx.missingHead(thisWeek, behind.length, week.rows.length)),
    c.tx.missingPace(c.num(week.pace ?? week.goal), c.num(week.goal)),
  ];
  return fitList(head, behind.map((r) => `${r.memberName} ${c.num(r.totalPoints)}`), [], c.tx.andMore, c.fits);
}

function helpReply(c: Ctx): string {
  return [
    c.tx.helpHead,
    MEMBER_COMMANDS.join(' · '),
    getInviteSettings(c.clan.id).enabled ? c.tx.helpCode : null,
    isLeader(c.clan.id, c.playerId) ? c.tx.helpLeaders : null,
  ].filter((l): l is string => !!l).join('\n');
}

function capitalize(s: string): string {
  return s ? s[0].toLocaleUpperCase() + s.slice(1) : s;
}

/**
 * The reply to one command from one player, in `lang`, at `nowMs`. Always
 * one message the chat takes (fitsReply): our ceiling, or `channelMax` — the
 * chat's own max_length_message — when that is smaller.
 */
export async function buildCommandReply(
  clanId: number, playerId: number, command: ChatCommand, lang: ReplyLanguage, nowMs = Date.now(), channelMax: number | null = null,
): Promise<string> {
  const clan = getClanById(clanId);
  if (!clan) throw new Error(`clan ${clanId} not found`);
  const c = makeCtx(clan, playerId, lang, nowMs, channelMax);
  let text: string;
  switch (command) {
    case 'me': text = meReply(c); break;
    case 'points': text = pointsReply(c); break;
    case 'chests': text = chestsReply(c); break;
    case 'top': text = topReply(c); break;
    case 'progress': text = progressReply(c); break;
    case 'events': text = await eventsReply(c); break;
    case 'missing': text = missingReply(c); break;
    default: text = helpReply(c);
  }
  return c.fits(text) ? text : fitList([], text.split('\n'), [], c.tx.andMore, c.fits);
}

const isCommand = (v: string): v is ChatCommand => v === 'help' || (MEMBER_COMMANDS as readonly string[]).includes(v) || (LEADER_COMMANDS as readonly string[]).includes(v);

// ── Answering ──────────────────────────────────────────────────────────────

export interface CommandRunOptions {
  /** The scanner's chat account (tb:<n>): the one that answers. */
  scannerChatId: string;
  /** A fresh chat token, or null when none can be had now (the next scan answers). */
  chatToken: () => Promise<string | null>;
  /** The transport (the real chat socket by default) — swapped out in tests. */
  send?: SocketSender;
  /** The chat session (REST), to ask when a mute ends. */
  chatSession?: ChatSession | null;
  muteInfo?: (s: ChatSession, channelUrl: string) => Promise<MuteInfo>;
  now?: () => number;
  /** Waits between two replies (COMMAND_SEND_GAP_MS) — instant in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Whether the clan has a command that could be answered now: commands are on,
 * one waits (young enough to answer), and the scanner account isn't muted.
 * After a restart this asks the scan loop for a scan of the clan, like a code
 * request (chat-capture.ts maybeScanForChatReplies).
 */
export function hasWaitingChatCommands(clanId: number, nowMs = Date.now()): boolean {
  if (!getChatCommandSettings(clanId).enabled || chatPausedUntil(clanId, nowMs) !== null) return false;
  return pendingCommandRequests(clanId).some((r) => nowMs - r.requestedAt <= MAX_COMMAND_AGE_MS);
}

/**
 * Answer the clan's pending commands, oldest first, within the limits: each
 * is re-checked, its reply built, reserved (`sending`), sent and its outcome
 * recorded. Stops when no chat token can be had, while (or once) the scanner
 * account is muted, and at the run's or the clan's limit — the rest wait.
 * Returns how many replies went out.
 */
export async function answerChatCommands(clanId: number, opts: CommandRunOptions): Promise<number> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const pending = pendingCommandRequests(clanId);
  if (!pending.length) return 0;
  if (!getChatCommandSettings(clanId).enabled) {
    for (const r of pending) setCommandRequestStatus(r.id, 'ignored', 'disabled');
    return 0;
  }
  // Muted: every send would be refused, and trying only adds to it.
  if (chatPausedUntil(clanId, now()) !== null) return 0;
  let sent = 0;
  let tried = 0;
  let groupTried = false;
  const answered = new Set<number>();
  for (const req of pending) {
    if (tried >= COMMAND_REPLIES_PER_RUN) break;
    const nowMs = now();
    if (nowMs - req.requestedAt > MAX_COMMAND_AGE_MS) {
      setCommandRequestStatus(req.id, 'ignored', 'too-old');
      continue;
    }
    if (!isCommand(req.command)) {
      setCommandRequestStatus(req.id, 'ignored', 'unknown-command');
      continue;
    }
    const blocker = commandRequestBlocker(clanId, opts.scannerChatId, req);
    if (blocker) {
      setCommandRequestStatus(req.id, 'ignored', blocker);
      noteBlocked(clanId, req.playerId, blocker);
      continue;
    }
    // One reply per player a run: their next command waits a minute.
    if (answered.has(req.playerId!)) continue;
    if (clanRepliesSince(clanId, nowMs - HOUR) >= CLAN_MAX_PER_HOUR) {
      quietWarner.warn(`budget:${clanId}`, `Clan #${clanId}: ${CLAN_MAX_PER_HOUR} chat command replies in the last hour — the rest wait`);
      break;
    }
    const channel = channelFor(clanId, req.channelUrl)!;
    const inGroup = channel.customType !== 'whisper';
    // The group chat: one reply a run, GROUP_MAX_PER_HOUR an hour — the rest wait.
    if (inGroup && (groupTried || channelRepliesSince(clanId, channel.url, nowMs - HOUR) >= GROUP_MAX_PER_HOUR)) continue;
    let text: string;
    try {
      text = await buildCommandReply(clanId, req.playerId!, req.command as ChatCommand, replyLanguage(clanId, req, inGroup), nowMs, channel.maxLength);
    } catch (err) {
      setCommandRequestStatus(req.id, 'failed', 'reply-error');
      log.warn({ noAlert: true }, `Clan #${clanId}: the reply to "${req.command}" could not be built: ${String(err)}`);
      continue;
    }
    let token: string | null;
    try {
      token = await opts.chatToken();
    } catch (err) {
      quietWarner.warn(`token:${clanId}`, `Clan #${clanId}: no chat token for chat command replies yet (the next scan answers): ${String(err)}`);
      return sent;
    }
    if (!token) return sent;
    if (tried > 0) await sleep(COMMAND_SEND_GAP_MS);
    if (!reserveCommandSend(req.id, now())) continue;
    tried++;
    answered.add(req.playerId!);
    if (inGroup) groupTried = true;
    const outcome = inGroup
      ? await sendGroupCommandReply({ userId: opts.scannerChatId, token, channel, allowedUrl: commandGroupChannel(clanId), text }, opts.send)
      : await sendCommandReply({ userId: opts.scannerChatId, token, channel, recipientUserId: req.senderChatId, text }, opts.send);
    const session = opts.chatSession;
    const readMute = session ? () => (opts.muteInfo ?? myMuteInfo)(session, channel.url) : undefined;
    const muted = await noteSendOutcome(clanId, outcome, now(), readMute);
    finishCommandSend(req.id, outcome, { muted });
    if (muted) return sent;
    if (outcome.status === 'sent') {
      sent++;
      log.info(`Clan #${clanId}: answered "${req.command}" for player ${req.playerId} (message ${outcome.messageId})`);
    } else if (outcome.status === 'refused') {
      quietWarner.warn(`refused:${clanId}`, `Clan #${clanId}: a chat command reply was refused (${outcome.error}); it is tried again`);
    } else {
      quietWarner.warn(`unknown:${clanId}`, `Clan #${clanId}: a chat command reply may or may not have gone out (${outcome.error}) — it is not resent`);
    }
  }
  return sent;
}

const inFlight = new Set<number>();

/**
 * Detect new command messages and answer them. Called after every chat read
 * (the minute poller and each scan). Never throws; one run per clan at a time.
 */
export async function processChatCommands(clanId: number, opts: CommandRunOptions): Promise<string> {
  if (inFlight.has(clanId)) return '';
  inFlight.add(clanId);
  try {
    const found = detectChatCommands(clanId, opts.scannerChatId, (opts.now ?? Date.now)());
    const sent = await answerChatCommands(clanId, opts);
    return found || sent ? `chat commands: ${found} new, ${sent} answered` : '';
  } catch (err) {
    log.warn({ noAlert: true }, `Clan #${clanId}: chat commands failed (nothing else is affected): ${String(err)}`);
    return '';
  } finally {
    inFlight.delete(clanId);
  }
}
