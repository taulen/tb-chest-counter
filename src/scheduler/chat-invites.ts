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
 *   - CHAT_SEND_DISABLED=1 answers nothing.
 * Every keyword DM is recorded once (chat_invite_requests), answered or not,
 * so it is never handled twice. A send with no answer (`unknown`) is never
 * resent. The code exists in plain text only in the reply; the database keeps
 * its sha256.
 */
import { getDb } from '../data/database.js';
import {
  CODE_TTL_MS,
  WELCOME_SENDS_PER_SCAN,
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
import { listChannelMembers, openPrivateChat, type ChatChannel, type ChatMember, type ChatSession } from '../game-protocol/chat.js';
import { chatSenderPlayerId } from '../game-protocol/chat-text.js';
import { assertInviteChannel, chatSendingDisabled, sendInviteMessage, type SocketSender } from '../game-protocol/chat-send.js';
import { loadConfig } from '../config/index.js';
import { readEnvValue } from '../config/persistent-env.js';
import { requestGap } from '../utils/request-gap.js';
import { childLogger } from '../utils/logger.js';
import { createCoalescedWarner } from '../utils/log-throttle.js';

const log = childLogger('chat-invites');
const quietWarner = createCoalescedWarner((m) => log.warn({ noAlert: true }, m), 24 * 3600_000);
const alertWarner = createCoalescedWarner((m) => log.warn(m), 3600_000);

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
  const base = clanPublicUrl(getClanById(clanId), loadConfig().webExternalUrl);
  const spaced = base ? spacedSiteName(base) : '';
  return spaced || null;
}

function whereToGo(site: string | null): string {
  return site ? `Go to ${site} and pick "${JOIN_ENTRY_LABEL}"` : `On the TB Chest Counter site, pick "${JOIN_ENTRY_LABEL}"`;
}

/** The reply: the code, where to enter it and how long it lasts. English, one short line, no link. */
export function inviteReplyText(code: string, site: string | null): string {
  const minutes = Math.round(CODE_TTL_MS / 60_000);
  return `TB Chest Counter code: ${formatCode(code)}. ${whereToGo(site)} within ${minutes} minutes. It works once.`;
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
  now?: () => number;
}

/**
 * Answer the clan's pending requests, oldest first: each is re-checked, then
 * reserved (status `sending` + the code's hash, in one transaction), then the
 * reply goes out and its outcome is recorded. Stops (leaving the rest pending)
 * when no chat token can be had. Returns how many replies went out.
 */
export async function answerInviteRequests(clanId: number, opts: InviteRunOptions): Promise<number> {
  const now = opts.now ?? Date.now;
  const pending = pendingInviteRequests(clanId);
  if (!pending.length) return 0;
  if (!getInviteSettings(clanId).enabled) {
    for (const r of pending) setRequestStatus(r.id, 'ignored', 'disabled');
    return 0;
  }
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
    const outcome = await sendInviteMessage(
      { userId: opts.scannerChatId, token, channel, recipientUserId: req.senderChatId, text: inviteReplyText(reserved.code, siteNameFor(clanId)) },
      opts.send,
    );
    finishInviteSend(req.id, reserved.codeId, outcome);
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
//     a linked account is due (the backlog), worked through at the per-scan
//     cap with a pause between sends; switching it off stops it where it is.
//   - After that, every player who joins.
// Once per player per clan, ever (chat_invite_welcomes); never someone with a
// linked account, never someone who has left by the time of the send; at most
// WELCOME_SENDS_PER_SCAN per scan. `dry-run` records and logs who would get
// one (never a code) and sends nothing; those players are still due once it
// is switched on.
//
// Opening the private chat (chat.ts openPrivateChat) and reading the clan
// chat's member list were NOT confirmed live when this was built: run it in
// dry-run first, then watch the first live sends.

/** The pause between two welcome sends, ms (random in the range). */
export const WELCOME_GAP_MS: readonly [number, number] = [2_000, 4_000];

/** Anything a chat filter could read as a link: a scheme, www, or name.tld with no spaces. */
export const LINK_LIKE = /https?:|www|[a-z0-9-]\.[a-z]{2,}/i;

/**
 * The welcome message: the code, where to enter it, how long it lasts, and
 * how to get a fresh one. No link — and the clan's name is left out if it
 * looks like one.
 */
export function welcomeText(code: string, clanName: string, site: string | null): string {
  const tail = `Your TB Chest Counter code: ${formatCode(code)}. ${whereToGo(site)} within 72 hours. It works once. Reply "code" any time for a fresh one.`;
  const name = clanName.trim();
  const full = name && !LINK_LIKE.test(name) ? `Welcome to ${name}! ${tail}` : `Welcome! ${tail}`;
  return full.length <= 300 ? full : `Welcome! ${tail}`;
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
  /** The pause between two sends (WELCOME_GAP_MS by default) — instant in tests. */
  pause?: () => Promise<void>;
  /** The chat REST calls — swapped out in tests. */
  chatApi?: {
    listMembers: (s: ChatSession, channelUrl: string) => Promise<ChatMember[]>;
    openPrivateChat: (s: ChatSession, otherUserId: string) => Promise<ChatChannel>;
  };
  now?: () => number;
}

/**
 * After a scan: send (or, in dry-run, note) the welcome codes due. Never
 * throws. Returns a note for the scan log ('' when nothing happened).
 */
export async function sendWelcomeCodes(clanId: number, opts: WelcomeRunOptions): Promise<string> {
  try {
    return await runWelcome(clanId, opts);
  } catch (err) {
    log.warn({ noAlert: true }, `Clan #${clanId}: welcome codes failed (nothing else is affected): ${String(err)}`);
    return '';
  }
}

async function runWelcome(clanId: number, opts: WelcomeRunOptions): Promise<string> {
  const now = opts.now ?? Date.now;
  const settings = getInviteSettings(clanId);
  if (settings.welcomeMode === 'off' || settings.welcomeEnabledAt === null) return '';
  const live = settings.welcomeMode === 'on';
  // The backlog (every current member without an account) only once switched
  // on for real; a dry run previews the joins.
  const candidates = welcomeCandidates(clanId, settings.welcomeEnabledAt, {
    backlog: live && settings.welcomeBacklogAt !== null, live, limit: WELCOME_SENDS_PER_SCAN,
  });
  if (!candidates.length) return '';

  if (settings.welcomeMode === 'dry-run') {
    for (const c of candidates) {
      setWelcomeStatus(clanId, c, 'dry-run', null);
      log.info(`Clan #${clanId}: welcome code DRY RUN — would send one to ${c.name} (player ${c.playerId}, joined ${new Date(c.joinedAt * 1000).toISOString()})`);
    }
    return `welcome codes: ${candidates.length} dry run`;
  }

  if (chatSendingDisabled() || !opts.chatSession || !opts.scannerChatId) return '';
  const session = opts.chatSession;
  const chatApi = opts.chatApi ?? { listMembers: listChannelMembers, openPrivateChat };
  const clan = getClanById(clanId);
  if (!clan) return '';

  let members: ChatMember[] | null = null;
  let membersRead = false;
  let sent = 0;
  let attempted = false;
  const pause = opts.pause ?? (() => requestGap(WELCOME_GAP_MS[0], WELCOME_GAP_MS[1]));
  for (const c of candidates) {
    // A pause between sends: the scanner account never bursts messages.
    if (attempted) await pause();
    // Switched off meanwhile (a backlog in progress): stop where it is.
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
    attempted = true;
    const outcome = await sendInviteMessage(
      { userId: opts.scannerChatId, token, channel, recipientUserId: chatId, text: welcomeText(reserved.code, clan.name, siteNameFor(clanId)) },
      opts.send,
    );
    finishWelcomeSend(clanId, c, reserved.codeId, outcome);
    if (outcome.status === 'sent') {
      sent++;
      log.info(`Clan #${clanId}: welcome code sent to ${c.name} (player ${c.playerId}, message ${outcome.messageId})`);
    } else if (outcome.status === 'unknown') {
      quietWarner.warn(`wunknown:${clanId}`, `Clan #${clanId}: a welcome code may or may not have gone out (${outcome.error}) — it is not resent`);
    } else {
      quietWarner.warn(`wrefused:${clanId}`, `Clan #${clanId}: a welcome code was refused (${outcome.error}); it is tried again`);
    }
  }
  return sent ? `welcome codes: ${sent} sent` : '';
}

function hasOwnChatLines(clanId: number, playerId: number): boolean {
  return !!getDb().prepare("SELECT 1 FROM chat_messages WHERE clan_id = ? AND sender_player_id = ? AND custom_type = 'user' AND sender_id <> '' LIMIT 1")
    .get(clanId, playerId);
}
