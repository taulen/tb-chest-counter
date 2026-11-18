/**
 * Account invites via the in-game chat (v127; docs/account-invites.md).
 *
 * A player DMs their clan's scanner account one keyword ("code", "invite",
 * "tracker", "код", "código"). The chat is read every minute
 * (chat-capture.ts); here each new keyword DM is checked and, when it passes,
 * answered in that same private chat with a one-time code for /join.
 *
 * Replies go only to the player who asked, in the 1:1 chat they opened
 * (chat-send.ts sendInviteMessage). The one unprompted message — the welcome
 * code for a player who joins, its own setting — is at the end of this file.
 * The checks for a reply:
 *   - invites are switched on for the clan (off by default), and the DM was
 *     sent after they were switched on and within MAX_REQUEST_AGE_MS;
 *   - the sender is a player on the clan's current roster (never a
 *     non-member — they get no answer at all);
 *   - the chat is a `whisper` with exactly the scanner and the sender in it;
 *   - the sender's chat account (tb:<n>) is the one that player has always
 *     written from: the pinned one once linked, else no stored message shows
 *     the player writing from a different chat account (the player id comes
 *     from chat metadata, which a modified client could fake);
 *   - one code per player per 10 minutes, one open request per player;
 *   - nothing while the game has the scanner account muted (the pause in
 *     chat-send-state-repo.ts — a mute refuses every recipient alike);
 *   - CHAT_SEND_DISABLED=1 answers nothing.
 * Every keyword DM is recorded once (chat_invite_requests), answered or not,
 * so it is never handled twice. A send with no answer (`unknown`) is never
 * resent. The code exists in plain text only in the reply; the database keeps
 * its sha256.
 */
import { getDb } from '../data/database.js';
import {
  CODE_TTL_MS,
  WELCOME_CANDIDATES_PER_RUN,
  WELCOME_DRY_RUN_LIMIT,
  WELCOME_MIN_GAP_MS,
  welcomeGapMs,
  WELCOME_WAIT_MS,
  finishInviteSend,
  finishWelcomeSend,
  formatCode,
  getInviteSettings,
  pendingInviteRequests,
  pinnedChatUserFor,
  playerHasOpenRequest,
  playerInCooldown,
  recordInviteRequest,
  reserveInviteSend,
  reserveWelcomeSend,
  setRequestStatus,
  setWelcomeStatus,
  welcomeCandidates,
} from '../data/repositories/account-invite-repo.js';
import { clanPublicUrl, getClanById } from '../data/repositories/clan-repo.js';
import { clanChatChannels } from '../data/repositories/chat-repo.js';
import { listChannelMembers, myMuteInfo, openPrivateChat, type ChatChannel, type ChatMember, type ChatSession, type MuteInfo } from '../game-protocol/chat.js';
import { chatSenderPlayerId } from '../game-protocol/chat-text.js';
import { MAX_INVITE_REPLY_CHARS, assertInviteChannel, chatSendingDisabled, isMutedRefusal, sendInviteMessage, type SendOutcome, type SocketSender } from '../game-protocol/chat-send.js';
import { chatPausedUntil, getChatSendState, noteChatMuted, noteChatSendAttempt, noteChatSent, noteMuteEnd } from '../data/repositories/chat-send-state-repo.js';
import { loadConfig } from '../config/index.js';
import { readEnvValue } from '../config/persistent-env.js';
import { resolveEntries } from '../utils/log-buffer.js';
import { childLogger } from '../utils/logger.js';
import { createCoalescedWarner } from '../utils/log-throttle.js';

const log = childLogger('chat-invites');
const quietWarner = createCoalescedWarner((m) => log.warn({ noAlert: true }, m), 24 * 3600_000);
const alertWarner = createCoalescedWarner((m) => log.warn(m), 3600_000);

/** The System-page key of a clan's "scanner account muted" warning, resolved by the next send that gets through. */
export function chatMutedWarningKey(clanId: number): string {
  return `chat-muted:clan:${clanId}`;
}

/**
 * After a send: a message that got through clears a mute's record; a "You
 * are muted." refusal pauses the clan's sending at once (every recipient
 * would get the same answer), then — when `readMute` can ask the chat
 * service — runs the pause to the mute's own end instead of the backoff's
 * guess. The log line keeps the refusal frame and the mute info as the chat
 * service gave them. Returns whether it was a mute.
 */
export async function noteSendOutcome(
  clanId: number,
  outcome: SendOutcome,
  nowMs: number,
  readMute?: () => Promise<MuteInfo>,
): Promise<boolean> {
  if (outcome.status === 'sent') {
    if (getChatSendState(clanId).muteCount > 0) resolveEntries(chatMutedWarningKey(clanId));
    noteChatSent(clanId, nowMs);
    return false;
  }
  if (!isMutedRefusal(outcome)) return false;
  // Paused before anything is awaited: no other send slips in meanwhile.
  let until = noteChatMuted(clanId, outcome.error, nowMs);
  let said = '';
  let known = false;
  if (readMute) {
    try {
      const info = await readMute();
      said = info.raw;
      if (info.muted && info.endAt !== null && info.endAt > nowMs) {
        until = noteMuteEnd(clanId, info.endAt, nowMs);
        known = true;
      }
    } catch (err) {
      said = `could not be read: ${String(err)}`;
    }
  }
  log.warn(
    { noAlert: true, resolveKey: chatMutedWarningKey(clanId) },
    `Clan #${clanId}: the game muted the scanner account's chat (${outcome.error}) — nothing is sent until ${new Date(until).toISOString()}`
      + ` (${known ? "the mute's own end, plus 2 min" : 'its end unknown: a set pause'}); codes and the digest wait and go out after.`
      + ` Refusal: ${outcome.status === 'refused' && outcome.detail ? outcome.detail : '–'}; mute info: ${said || '–'}`,
  );
  return true;
}

/** The words a DM must be (alone) to ask for a code. Exact match after trimming. */
export const INVITE_KEYWORDS: readonly string[] = ['code', 'invite', 'tracker', 'код', 'código', 'codigo'];
/** Older keyword DMs are never answered (a stale code helps nobody). */
export const MAX_REQUEST_AGE_MS = 6 * 3600_000;

/**
 * Whether a DM asks for a code: the whole message, trimmed, lower-cased, with
 * a leading "!" or "/" and trailing punctuation dropped, is one keyword.
 * "code" and "!Code." ask; "send me the code" does not.
 */
export function isInviteKeyword(text: string): boolean {
  const t = String(text ?? '').normalize('NFC').trim().toLowerCase()
    .replace(/^[!/#¡¿]+/u, '')
    .replace(/[\s.!?…]+$/u, '');
  return INVITE_KEYWORDS.includes(t);
}

/**
 * The game blocks links in chat, so a message never carries one: the site is
 * written as its host with a space around each dot ("cwb . fyi"), and the
 * player picks "Have a code? Join here" on the sign-in page it opens on.
 */
export const JOIN_ENTRY_LABEL = 'Have a code? Join here';
/** The same door inside the app for a signed-in player (account menu; index.html userMenuAddClan). */
export const ADD_CLAN_LABEL = 'Add a clan with a code';

/** "https://www.cwb.fyi/x" or "cwb.fyi" → "cwb . fyi". '' when nothing usable is left. */
export function spacedSiteName(input: string): string {
  const host = String(input ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '')
    .replace(/^www\s*\.\s*/i, '');
  return host.split('.').map((p) => p.trim().toLowerCase()).filter((p) => /^[a-z0-9-]+$/.test(p)).join(' . ');
}

/**
 * Instance-wide override of the site name in messages, '' when unset. Read
 * from the persistent app.env file each time (the settings save writes it
 * there), never process.env, which keeps a removed value until a restart.
 */
export function siteNameOverride(): string {
  return (readEnvValue('INVITE_SITE_NAME') ?? '').trim();
}

/**
 * How messages name the site for this clan: the instance override if set,
 * else the host of the clan's public address (its own domain, or the site's),
 * spaced out. Null when there is neither.
 */
export function siteNameFor(clanId: number): string | null {
  const override = spacedSiteName(siteNameOverride());
  if (override) return override;
  return defaultSiteNameFor(clanId);
}

/** The site name with no override: the clan's public address host, spaced out; null when there is none. */
export function defaultSiteNameFor(clanId: number): string | null {
  const base = clanPublicUrl(getClanById(clanId), loadConfig().webExternalUrl);
  const spaced = base ? spacedSiteName(base) : '';
  return spaced || null;
}

// ── The messages ───────────────────────────────────────────────────────────
//
// The wording varies from message to message (user, Nov 18 2026): the
// scanner account sends many alike, and a spam filter reads repeats. Every
// version says the same things — the code, that it is TB Chest Counter, the
// clan tracker by taulen (user, Nov 18 2026), where to go with both door
// labels exactly, the hours and the single use — in English, one line, no
// link, at most MAX_INVITE_REPLY_CHARS.

/** A random number in [0, 1) — Math.random, or a fixed one in tests. */
export type Rand = () => number;
const pick = <T>(xs: readonly T[], rand: Rand): T => xs[Math.min(xs.length - 1, Math.max(0, Math.floor(rand() * xs.length)))];
/** Always the first (shortest) wording: the fallback when a message would run long. */
const FIRST: Rand = () => 0;

const CODE_LINES: ReadonlyArray<(code: string) => string> = [
  (c) => `Your TB Chest Counter code (the clan tracker by taulen): ${c}.`,
  (c) => `Your code for TB Chest Counter, the clan tracker by taulen: ${c}.`,
  (c) => `TB Chest Counter is the clan tracker by taulen. Your code: ${c}.`,
  (c) => `Here is your code for TB Chest Counter (the clan tracker by taulen): ${c}.`,
];
const GO_TO: ReadonlyArray<(site: string) => string> = [
  (site) => `Go to ${site} and pick`,
  (site) => `Open ${site} and choose`,
  (site) => `On ${site}, pick`,
  (site) => `Visit ${site} and press`,
];
const GO_NO_SITE: readonly string[] = ['On the TB Chest Counter site, pick', 'On the TB Chest Counter site, choose'];
// A player already signed in never sees the sign-in page: their door is named too.
const SIGNED_IN: readonly string[] = [
  `(signed in: "${ADD_CLAN_LABEL}" in your account menu)`,
  `(already signed in? "${ADD_CLAN_LABEL}" in your account menu)`,
  `(or, signed in, "${ADD_CLAN_LABEL}" in your account menu)`,
];
const VALIDITY: ReadonlyArray<(hours: number) => string> = [
  (h) => `within ${h} hours. It works once.`,
  (h) => `within ${h} hours; the code works once.`,
  (h) => `in the next ${h} hours. It can be used once.`,
];
const REPLY_OPENERS: readonly string[] = ['', 'Hi! ', 'Here you go. ', 'Sure! '];
const GREETINGS: ReadonlyArray<(clan: string) => string> = [
  (n) => `Welcome to ${n}!`,
  (n) => `Hi, and welcome to ${n}!`,
  (n) => `Welcome to ${n}, glad to have you!`,
];
const GREETINGS_NO_NAME: readonly string[] = ['Welcome!', 'Hi, and welcome!'];
const FRESH: readonly string[] = [
  'Reply "code" any time for a fresh one.',
  'Need a new one? Reply "code".',
  'Reply "code" whenever you need a new one.',
];

function whereToGo(site: string | null, rand: Rand): string {
  const go = site ? pick(GO_TO, rand)(site) : pick(GO_NO_SITE, rand);
  return `${go} "${JOIN_ENTRY_LABEL}" ${pick(SIGNED_IN, rand)}`;
}

const hours = (): number => Math.round(CODE_TTL_MS / 3600_000);

/** The first wording that fits, trying `rand`'s then the shortest. */
function fitted(build: (rand: Rand) => string, rand: Rand): string {
  const text = build(rand);
  return text.length <= MAX_INVITE_REPLY_CHARS ? text : build(FIRST);
}

/** The reply: the code, what it is for, where to enter it and how long it lasts. */
export function inviteReplyText(code: string, site: string | null, rand: Rand = Math.random): string {
  return fitted((r) => `${pick(REPLY_OPENERS, r)}${pick(CODE_LINES, r)(formatCode(code))} ${whereToGo(site, r)} ${pick(VALIDITY, r)(hours())}`, rand);
}

interface ChannelRow { url: string; customType: string; members: Array<{ userId: string }> }

function channelFor(clanId: number, channelUrl: string): ChannelRow | null {
  const r = getDb().prepare('SELECT channel_url, custom_type, members FROM chat_channels WHERE clan_id = ? AND channel_url = ?')
    .get(clanId, channelUrl) as { channel_url: string; custom_type: string; members: string } | undefined;
  if (!r) return null;
  let members: Array<{ userId: string }> = [];
  try {
    const parsed = JSON.parse(r.members) as Array<{ userId?: string }>;
    if (Array.isArray(parsed)) members = parsed.map((m) => ({ userId: String(m?.userId ?? '') }));
  } catch { /* none */ }
  return { url: r.channel_url, customType: r.custom_type, members };
}

/**
 * Whether `chatUserId` is NOT the chat account this player writes from: the
 * pinned one once the player is linked, else any stored message showing the
 * player writing from a different chat account. (The player id itself comes
 * from chat metadata, which a modified client could fake.)
 */
export function chatAccountMismatch(playerId: number, chatUserId: string): boolean {
  const pinned = pinnedChatUserFor(playerId);
  if (pinned) return pinned !== chatUserId;
  return !!getDb().prepare(
    "SELECT 1 FROM chat_messages WHERE sender_player_id = ? AND custom_type = 'user' AND sender_id <> '' AND sender_id <> ? LIMIT 1",
  ).get(playerId, chatUserId);
}

/**
 * Why a request must not be answered, or null when it may be. Checked when the
 * DM is first seen and again right before the reply.
 */
export function inviteRequestBlocker(
  clanId: number,
  scannerChatId: string,
  req: { channelUrl: string; senderChatId: string; playerId: number | null },
  nowMs = Date.now(),
  exceptRequestId?: number,
): string | null {
  if (chatSendingDisabled()) return 'sending-disabled';
  if (!req.playerId) return 'no-player';
  const db = getDb();
  const onRoster = db.prepare('SELECT 1 FROM game_players WHERE clan_id = ? AND player_id = ? AND in_clan = 1').get(clanId, req.playerId);
  if (!onRoster) return 'not-member';
  const channel = channelFor(clanId, req.channelUrl);
  if (!channel) return 'channel';
  try {
    assertInviteChannel(channel, scannerChatId, req.senderChatId);
  } catch {
    return 'channel';
  }
  if (chatAccountMismatch(req.playerId, req.senderChatId)) return 'chat-account-mismatch';
  if (playerInCooldown(req.playerId, nowMs)) return 'cooldown';
  if (playerHasOpenRequest(req.playerId, exceptRequestId)) return 'duplicate';
  return null;
}

function noteBlocked(clanId: number, playerId: number | null, senderChatId: string, reason: string): void {
  if (reason === 'chat-account-mismatch') {
    // A player id claimed from a chat account that player never wrote from:
    // possibly a faked identity. Worth a look — the request is not answered.
    alertWarner.warn(`mismatch:${clanId}:${playerId}`, `Clan #${clanId}: an account-invite request for player ${playerId} came from a chat account that player has not written from before — not answered`);
  } else if (reason === 'not-member' || reason === 'no-player') {
    quietWarner.warn(`nonmember:${clanId}:${senderChatId}`, `Clan #${clanId}: an account-invite request from a chat user who is not on the clan's roster — not answered`);
  }
}

/**
 * Record every new keyword DM in the clan's private chats once: `pending`
 * when it may be answered, `ignored` (with the reason) when not. Returns how
 * many were recorded.
 */
export function detectInviteRequests(clanId: number, scannerChatId: string, nowMs = Date.now()): number {
  const settings = getInviteSettings(clanId);
  if (!settings.enabled || settings.enabledAt === null || !scannerChatId) return 0;
  const since = Math.max(settings.enabledAt, nowMs - MAX_REQUEST_AGE_MS);
  const rows = getDb().prepare(
    `SELECT m.channel_url, m.message_id, m.created_at, m.sender_id, m.sender_player_id, m.message
       FROM chat_messages m
       JOIN chat_channels c ON c.clan_id = m.clan_id AND c.channel_url = m.channel_url
      WHERE m.clan_id = ? AND c.custom_type = 'whisper' AND m.custom_type = 'user'
        AND m.created_at >= ? AND m.sender_id <> ? AND m.sender_id <> '' AND length(m.message) <= 40
        AND NOT EXISTS (SELECT 1 FROM chat_invite_requests r
                         WHERE r.clan_id = m.clan_id AND r.channel_url = m.channel_url AND r.message_id = m.message_id)
      ORDER BY m.created_at, m.message_id LIMIT 200`,
  ).all(clanId, since, scannerChatId) as Array<{
    channel_url: string; message_id: number; created_at: number; sender_id: string; sender_player_id: number | null; message: string;
  }>;
  let recorded = 0;
  for (const m of rows) {
    if (!isInviteKeyword(m.message)) continue;
    const req = { channelUrl: m.channel_url, senderChatId: m.sender_id, playerId: m.sender_player_id };
    const blocker = inviteRequestBlocker(clanId, scannerChatId, req, nowMs);
    const ok = recordInviteRequest(
      { clanId, channelUrl: m.channel_url, messageId: m.message_id, senderChatId: m.sender_id, playerId: m.sender_player_id, requestedAt: m.created_at },
      blocker ? 'ignored' : 'pending',
      blocker,
    );
    if (!ok) continue;
    recorded++;
    if (blocker) noteBlocked(clanId, m.sender_player_id, m.sender_id, blocker);
  }
  return recorded;
}

export interface InviteRunOptions {
  /** The scanner's chat account (tb:<n>): the one that answers. */
  scannerChatId: string;
  /** A fresh chat token, or null when none can be had now (the next scan answers). */
  chatToken: () => Promise<string | null>;
  /** The transport (the real chat socket by default) — swapped out in tests. */
  send?: SocketSender;
  /** The chat session (REST), to ask when a mute ends; without it a mute gets the set pause. */
  chatSession?: ChatSession | null;
  /** The mute-info read (myMuteInfo by default) — swapped out in tests. */
  muteInfo?: (s: ChatSession, channelUrl: string) => Promise<MuteInfo>;
  now?: () => number;
}

/**
 * Whether the clan has a code request that can be answered now: answering is
 * on, one waits, and the scanner account isn't muted (a mute's pause holds
 * them all until it is over).
 */
export function hasWaitingInviteRequests(clanId: number, nowMs = Date.now()): boolean {
  return getInviteSettings(clanId).enabled && pendingInviteRequests(clanId).length > 0 && chatPausedUntil(clanId, nowMs) === null;
}

/**
 * Answer the clan's pending requests, oldest first: each is re-checked, then
 * reserved (status `sending` + the code's hash, in one transaction), then the
 * reply goes out and its outcome is recorded. Stops (leaving the rest pending)
 * when no chat token can be had, while the scanner account is muted, and at
 * the mute itself. Returns how many replies went out.
 */
export async function answerInviteRequests(clanId: number, opts: InviteRunOptions): Promise<number> {
  const now = opts.now ?? Date.now;
  const pending = pendingInviteRequests(clanId);
  if (!pending.length) return 0;
  if (!getInviteSettings(clanId).enabled) {
    for (const r of pending) setRequestStatus(r.id, 'ignored', 'disabled');
    return 0;
  }
  // Muted: every send would be refused, and trying only adds to it.
  if (chatPausedUntil(clanId, now()) !== null) return 0;
  let sent = 0;
  for (const req of pending) {
    const nowMs = now();
    if (nowMs - req.requestedAt > MAX_REQUEST_AGE_MS) {
      setRequestStatus(req.id, 'ignored', 'too-old');
      continue;
    }
    const blocker = inviteRequestBlocker(clanId, opts.scannerChatId, req, nowMs, req.id);
    if (blocker) {
      setRequestStatus(req.id, 'ignored', blocker);
      noteBlocked(clanId, req.playerId, req.senderChatId, blocker);
      continue;
    }
    const channel = channelFor(clanId, req.channelUrl)!;
    let token: string | null;
    try {
      token = await opts.chatToken();
    } catch (err) {
      quietWarner.warn(`token:${clanId}`, `Clan #${clanId}: no chat token for account-invite replies yet (the next scan answers): ${String(err)}`);
      return sent;
    }
    if (!token) return sent;
    const reserved = reserveInviteSend(req.id, now());
    if (!reserved) continue;
    noteChatSendAttempt(clanId, now());
    const outcome = await sendInviteMessage(
      { userId: opts.scannerChatId, token, channel, recipientUserId: req.senderChatId, text: inviteReplyText(reserved.code, siteNameFor(clanId)) },
      opts.send,
    );
    const session = opts.chatSession;
    const readMute = session ? () => (opts.muteInfo ?? myMuteInfo)(session, channel.url) : undefined;
    const muted = await noteSendOutcome(clanId, outcome, now(), readMute);
    finishInviteSend(req.id, reserved.codeId, outcome, undefined, { muted });
    if (muted) return sent;
    if (outcome.status === 'sent') {
      sent++;
      log.info(`Clan #${clanId}: account-invite code sent to player ${req.playerId} (message ${outcome.messageId})`);
    } else if (outcome.status === 'refused') {
      quietWarner.warn(`refused:${clanId}`, `Clan #${clanId}: an account-invite reply was refused (${outcome.error}); it is tried again`);
    } else {
      quietWarner.warn(`unknown:${clanId}`, `Clan #${clanId}: an account-invite reply may or may not have gone out (${outcome.error}) — it is not resent`);
    }
  }
  return sent;
}

const inFlight = new Set<number>();

/**
 * Detect new keyword DMs and answer them. Called after every chat read (the
 * minute poller and each scan). Never throws; one run per clan at a time.
 */
export async function processInviteRequests(clanId: number, opts: InviteRunOptions): Promise<string> {
  if (inFlight.has(clanId)) return '';
  inFlight.add(clanId);
  try {
    const found = detectInviteRequests(clanId, opts.scannerChatId, (opts.now ?? Date.now)());
    const sent = await answerInviteRequests(clanId, opts);
    return found || sent ? `account invites: ${found} new request(s), ${sent} code(s) sent` : '';
  } catch (err) {
    log.warn({ noAlert: true }, `Clan #${clanId}: account invites failed (nothing else is affected): ${String(err)}`);
    return '';
  } finally {
    inFlight.delete(clanId);
  }
}

// ── Welcome codes: unprompted, once, for players who join ──────────────────
//
// The second, separate exception (its own setting, off by default): the
// scanner opens a private chat with a player and sends a code (72 h).
//   - The first time the setting is switched on, every CURRENT member without
//     a linked account is due (the backlog); switching it off stops it where
//     it is.
//   - After that, every player who joins.
// Once per player per clan, ever (chat_invite_welcomes); never someone with a
// linked account, never someone who has left by the time of the send.
//
// ONE code a run, at least WELCOME_MIN_GAP_MS (20 min for a week after a
// mute) after the scanner's last invite DM: runs come after each scan and,
// between scans, from the minute chat poller while the scan's game session
// is kept — a steady trickle, never a burst. (Nov 18 2026: 10 a scan, 2–4 s apart, and two manual scans sent 20
// in three minutes; the game muted the scanner account for an hour.) A mute
// pauses everything (chat-send-state-repo.ts) and the player stays due.
//
// `dry-run` records and logs who would get one (never a code) and sends
// nothing; those players are still due once it is switched on.

/** Anything a chat filter could read as a link: a scheme, www, or name.tld with no spaces. */
export const LINK_LIKE = /https?:|www|[a-z0-9-]\.[a-z]{2,}/i;

/**
 * The welcome message: a greeting, the code and what it is for, where to
 * enter it, how long it lasts, and how to get a fresh one. No link — the
 * clan's name is left out if it looks like one, or if it makes the message
 * too long.
 */
export function welcomeText(code: string, clanName: string, site: string | null, rand: Rand = Math.random): string {
  const name = clanName.trim();
  const named = name && !LINK_LIKE.test(name) ? name : '';
  const build = (r: Rand, withName: boolean): string => {
    const greet = withName && named ? pick(GREETINGS, r)(named) : pick(GREETINGS_NO_NAME, r);
    return `${greet} ${pick(CODE_LINES, r)(formatCode(code))} ${whereToGo(site, r)} ${pick(VALIDITY, r)(hours())} ${pick(FRESH, r)}`;
  };
  const text = fitted((r) => build(r, true), rand);
  return text.length <= MAX_INVITE_REPLY_CHARS ? text : build(FIRST, false);
}

/**
 * The new member's chat account: the one their own stored chat lines come
 * from (exactly one), else the clan chat member whose memberInfo names their
 * player id AND whose name is their roster name (exactly one). Null when
 * neither is certain.
 */
export function findChatAccount(clanId: number, playerId: number, name: string, members: ChatMember[] | null): string | null {
  const own = (getDb().prepare(
    "SELECT DISTINCT sender_id FROM chat_messages WHERE clan_id = ? AND sender_player_id = ? AND custom_type = 'user' AND sender_id <> ''",
  ).all(clanId, playerId) as Array<{ sender_id: string }>).map((r) => r.sender_id);
  if (own.length === 1) return own[0];
  if (own.length > 1) return null;
  const want = name.trim().toLowerCase();
  const matches = (members ?? []).filter((m) => m.userId && chatSenderPlayerId(m.memberInfo) === playerId && m.nickname.trim().toLowerCase() === want);
  return matches.length === 1 ? matches[0].userId : null;
}

export interface WelcomeRunOptions {
  /** The scanner's chat account (tb:<n>): the one that sends. */
  scannerChatId: string;
  /** The scan's chat session (REST): the clan chat's member list, and opening the private chat. */
  chatSession: ChatSession | null;
  /** A fresh chat token for the send. */
  chatToken: () => Promise<string | null>;
  send?: SocketSender;
  /** A run from the minute chat poller (not a scan): live sends only, never a dry-run listing. */
  betweenScans?: boolean;
  /** The chat REST calls — swapped out in tests. */
  chatApi?: {
    listMembers: (s: ChatSession, channelUrl: string) => Promise<ChatMember[]>;
    openPrivateChat: (s: ChatSession, otherUserId: string) => Promise<ChatChannel>;
    /** Our own mute in a chat (when it ends); absent = not asked. */
    muteInfo?: (s: ChatSession, channelUrl: string) => Promise<MuteInfo>;
  };
  now?: () => number;
}

const welcomeInFlight = new Set<number>();
/** When the minute poller last ran a clan's welcome codes (a run may read the clan chat's members). */
const lastPollerRun = new Map<number, number>();

/**
 * After a scan, and each minute between scans: send the next welcome code
 * due (one, when the gap since the last invite DM allows), or in dry-run note
 * everyone due. Never throws; one run per clan at a time. Returns a note for
 * the log ('' when nothing happened).
 */
export async function sendWelcomeCodes(clanId: number, opts: WelcomeRunOptions): Promise<string> {
  if (welcomeInFlight.has(clanId)) return '';
  welcomeInFlight.add(clanId);
  try {
    return await runWelcome(clanId, opts);
  } catch (err) {
    log.warn({ noAlert: true }, `Clan #${clanId}: welcome codes failed (nothing else is affected): ${String(err)}`);
    return '';
  } finally {
    welcomeInFlight.delete(clanId);
  }
}

async function runWelcome(clanId: number, opts: WelcomeRunOptions): Promise<string> {
  const now = opts.now ?? Date.now;
  const settings = getInviteSettings(clanId);
  if (settings.welcomeMode === 'off' || settings.welcomeEnabledAt === null) return '';
  const live = settings.welcomeMode === 'on';
  if (opts.betweenScans && !live) return '';
  if (live) {
    // Muted: every send would be refused, and trying only adds to it.
    if (chatPausedUntil(clanId, now()) !== null) return '';
    // One at a time, well apart: the scanner account never bursts messages.
    // (Twice as far apart for a week after a mute.)
    const state = getChatSendState(clanId);
    if (state.lastSendAt !== null && now() - state.lastSendAt < welcomeGapMs(state.mutedAt, now())) return '';
    // Between scans a run that found no one to send to (their chat accounts
    // not seen yet) waits as long as a send would before reading again.
    if (opts.betweenScans) {
      if (now() - (lastPollerRun.get(clanId) ?? 0) < WELCOME_MIN_GAP_MS) return '';
      lastPollerRun.set(clanId, now());
    }
  }
  // A dry run previews EVERYONE switching it on would message — the current
  // members without an account (the backlog) as well as new joins — all at
  // once: nothing is sent. (It used to preview only joins after the switch,
  // so a clan with nobody new showed nothing at all.) Live, the backlog
  // starts with the first switch to on, one code at a time.
  const dryRun = settings.welcomeMode === 'dry-run';
  const candidates = welcomeCandidates(clanId, settings.welcomeEnabledAt, {
    backlog: dryRun || settings.welcomeBacklogAt !== null,
    live,
    limit: dryRun ? WELCOME_DRY_RUN_LIMIT : WELCOME_CANDIDATES_PER_RUN,
  });
  if (!candidates.length) return '';

  if (dryRun) {
    for (const c of candidates) setWelcomeStatus(clanId, c, 'dry-run', null);
    const names = candidates.slice(0, 5).map((c) => c.name).join(', ');
    log.info(`Clan #${clanId}: welcome codes DRY RUN — ${candidates.length} would get one (${names}${candidates.length > 5 ? ', …' : ''}); nothing sent`);
    return `welcome codes: ${candidates.length} dry run`;
  }

  if (chatSendingDisabled() || !opts.chatSession || !opts.scannerChatId) return '';
  const session = opts.chatSession;
  const chatApi = opts.chatApi ?? { listMembers: listChannelMembers, openPrivateChat, muteInfo: myMuteInfo };
  const clan = getClanById(clanId);
  if (!clan) return '';

  let members: ChatMember[] | null = null;
  let membersRead = false;
  // The first player who can be sent to gets the code; the rest wait for a later run.
  for (const c of candidates) {
    // Switched off meanwhile: stop where it is.
    if (getInviteSettings(clanId).welcomeMode !== 'on') break;
    const nowMs = now();
    // A join waits a day for its chat account to show up; a backlog member a
    // day from when the backlog started.
    const waitedOut = nowMs - Math.max(c.joinedAt * 1000, settings.welcomeBacklogAt ?? 0) > WELCOME_WAIT_MS;
    if (!membersRead && !hasOwnChatLines(clanId, c.playerId)) {
      membersRead = true;
      const channel = clanChatChannels(clanId)[0];
      try {
        members = channel ? await chatApi.listMembers(session, channel) : null;
      } catch (err) {
        quietWarner.warn(`members:${clanId}`, `Clan #${clanId}: could not read the clan chat's members for welcome codes: ${String(err)}`);
      }
    }
    const chatId = findChatAccount(clanId, c.playerId, c.name, members);
    if (!chatId) {
      setWelcomeStatus(clanId, c, waitedOut ? 'skipped' : 'waiting', 'no-chat-account');
      continue;
    }
    if (chatAccountMismatch(c.playerId, chatId)) {
      setWelcomeStatus(clanId, c, 'skipped', 'chat-account-mismatch', { chatUserId: chatId });
      noteBlocked(clanId, c.playerId, chatId, 'chat-account-mismatch');
      continue;
    }
    if (playerInCooldown(c.playerId, nowMs) || playerHasOpenRequest(c.playerId)) {
      // They asked for a code themselves: that one is theirs.
      setWelcomeStatus(clanId, c, 'skipped', 'asked-themselves', { chatUserId: chatId });
      continue;
    }
    let channel: ChatChannel;
    try {
      channel = await chatApi.openPrivateChat(session, chatId);
    } catch (err) {
      setWelcomeStatus(clanId, c, c.attempts + 1 >= 3 || waitedOut ? 'skipped' : 'waiting', 'open-chat-failed', { chatUserId: chatId, countAttempt: true });
      quietWarner.warn(`open:${clanId}`, `Clan #${clanId}: could not open a private chat for a welcome code: ${String(err)}`);
      continue;
    }
    try {
      assertInviteChannel(channel, opts.scannerChatId, chatId);
    } catch (err) {
      // Never send into a chat that isn't exactly the scanner and that player.
      setWelcomeStatus(clanId, c, 'skipped', 'channel', { chatUserId: chatId, channelUrl: channel.url });
      alertWarner.warn(`channel:${clanId}`, `Clan #${clanId}: the private chat opened for a welcome code was not a 1:1 chat with that player — nothing sent (${(err as Error).message})`);
      continue;
    }
    let token: string | null;
    try {
      token = await opts.chatToken();
    } catch (err) {
      quietWarner.warn(`token:${clanId}`, `Clan #${clanId}: no chat token for welcome codes (the next scan tries again): ${String(err)}`);
      break;
    }
    if (!token) break;
    const reserved = reserveWelcomeSend(clanId, c, chatId, channel.url, now());
    if (!reserved) continue;
    noteChatSendAttempt(clanId, now());
    const outcome = await sendInviteMessage(
      { userId: opts.scannerChatId, token, channel, recipientUserId: chatId, text: welcomeText(reserved.code, clan.name, siteNameFor(clanId)) },
      opts.send,
    );
    const readMute = chatApi.muteInfo ? () => chatApi.muteInfo!(session, channel.url) : undefined;
    const muted = await noteSendOutcome(clanId, outcome, now(), readMute);
    finishWelcomeSend(clanId, c, reserved.codeId, outcome, undefined, { muted });
    if (muted) return '';
    if (outcome.status === 'sent') {
      log.info(`Clan #${clanId}: welcome code sent to ${c.name} (player ${c.playerId}, message ${outcome.messageId})`);
      return 'welcome codes: 1 sent';
    }
    if (outcome.status === 'unknown') {
      quietWarner.warn(`wunknown:${clanId}`, `Clan #${clanId}: a welcome code may or may not have gone out (${outcome.error}) — it is not resent`);
    } else {
      quietWarner.warn(`wrefused:${clanId}`, `Clan #${clanId}: a welcome code was refused (${outcome.error}); it is tried again`);
    }
    // One message a run, whatever came of it.
    return '';
  }
  return '';
}

function hasOwnChatLines(clanId: number, playerId: number): boolean {
  return !!getDb().prepare("SELECT 1 FROM chat_messages WHERE clan_id = ? AND sender_player_id = ? AND custom_type = 'user' AND sender_id <> '' LIMIT 1")
    .get(clanId, playerId);
}
