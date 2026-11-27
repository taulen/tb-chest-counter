/**
 * Keeps each clan's chat stored: the clan chat and the scanner account's
 * private (1:1) messages (game-protocol/chat.ts, migration v104) — and, only
 * while chat commands are answered there, the clan's digest group chat, read
 * forward from the switch-on (chat-commands.ts commandGroupRead) — and the
 * group chats the clan reads battle reports from (v143, clan_report_chats).
 * Battle reports linked in any of them are opened between scans on the
 * journal token of the clan's last login (battle-reports.ts).
 *
 *   - Every scan, on the game session it just signed in with, asks the game for
 *     a chat token, signs in to the chat service and syncs (refreshChatSession).
 *   - Between scans, a poller reads new messages every minute with the cached
 *     chat session key. That never touches the game or the website login, so it
 *     cannot disturb the account; a rejected key is dropped and the next scan
 *     issues a fresh one.
 *
 * The first sync of a channel backfills its history (the service keeps months);
 * every later sync reads another slice further back until the service has
 * nothing older. Stored messages are permanent (chat-repo.ts): a line the
 * service no longer serves stays on the site.
 * Nothing here may ever fail a scan: every entry point swallows and logs.
 */
import fs from 'fs';
import path from 'path';
import { clanDataDir } from '../config/clan-paths.js';
import type { GameClient } from '../game-protocol/client.js';
import { chatLogin, listChannels, readMessages, readMessagesBefore, type ChatChannel, type ChatSession } from '../game-protocol/chat.js';
import {
  isChatHistoryComplete, markChatHistoryComplete, newestChatMessageAt, oldestChatMessageAt, saveChatMessages, upsertChatChannel,
} from '../data/repositories/chat-repo.js';
import { childLogger } from '../utils/logger.js';
import { createCoalescedWarner } from '../utils/log-throttle.js';
import { hasWaitingInviteRequests, processInviteRequests, sendWelcomeCodes } from './chat-invites.js';
import { commandGroupRead, hasWaitingChatCommands, processChatCommands } from './chat-commands.js';
import { POSTABLE_TYPES } from '../game-protocol/chat-send.js';
import { keptSessionClans, withKeptGameSession } from './event-poller.js';
import { getReportChats } from '../data/repositories/battle-report-repo.js';
import { refreshGroupChats } from '../data/repositories/chat-digest-repo.js';
import { fetchSharedReports } from './battle-reports.js';

const log = childLogger('chat');
const pollWarner = createCoalescedWarner((m) => log.warn({ noAlert: true }, m), 60 * 60_000);

/** Channel kinds we keep: the clan chat and private messages. */
const KEPT_TYPES = ['clanGroup', 'whisper'];
/** How far back the first sync of a channel reads. */
const BACKFILL = { clanGroup: 20_000, whisper: 2_000 } as Record<string, number>;
/** Older history read per sync after that, until the service has nothing older (15 requests). One-time per channel: a complete channel is never asked again. */
const OLDER_PER_SYNC = 3_000;
/**
 * New channels backfilled per sync (the rest wait for the next minute). Until
 * Nov 2026 the channel list asked for "clanGroup%2Cwhisper" and matched
 * nothing, so private chats were never listed; once fixed, an account's ~30
 * private chats would all backfill in one burst. The clan chat goes first.
 */
const FIRST_READS_PER_SYNC = 3;
const POLL_MS = 60_000;

interface ClanChat {
  session: ChatSession;
  /** The game's clan id, for the clan channel URL. */
  gameClanId: number;
  /** The battle-report service's token from the last scan's login (journal-token.ts); null = none or refused. */
  journalToken?: string | null;
}
const sessions = new Map<number, ClanChat>();

// The chat session survives a restart: before, every deploy emptied the map
// and polling (new lines AND the one-time history backfill) stopped until each
// clan's next scan, up to an hour later (user, Nov 2026: "stuck"). Kept next to
// the clan's saved game login; deleted when the service rejects it.
const SESSION_FILE = 'chat-session.json';
function keepSession(clanId: number, chat: ClanChat): void {
  sessions.set(clanId, chat);
  try {
    fs.mkdirSync(clanDataDir(clanId), { recursive: true });
    fs.writeFileSync(path.join(clanDataDir(clanId), SESSION_FILE), JSON.stringify(chat), { mode: 0o600 });
  } catch (err) {
    log.warn({ noAlert: true }, `Clan #${clanId}: could not save the chat session (polling still runs): ${String(err)}`);
  }
}
function dropSession(clanId: number): void {
  sessions.delete(clanId);
  try { fs.rmSync(path.join(clanDataDir(clanId), SESSION_FILE), { force: true }); } catch { /* gone already */ }
}
/** Sessions saved before a restart, so polling resumes without waiting for a scan. */
function restoreSessions(): number {
  let n = 0;
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(path.resolve('data', 'clans')); } catch { return 0; }
  for (const d of dirs) {
    const clanId = Number(d);
    if (!Number.isInteger(clanId) || clanId <= 0 || sessions.has(clanId)) continue;
    try {
      const chat = JSON.parse(fs.readFileSync(path.join(clanDataDir(clanId), SESSION_FILE), 'utf8')) as ClanChat;
      if (chat?.session?.key && chat.session.userId) { sessions.set(clanId, chat); n++; }
    } catch { /* none saved */ }
  }
  return n;
}
let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;

async function sync(clanId: number, chat: ClanChat): Promise<{ channels: number; added: number }> {
  // Chat commands may also be answered in the clan's digest group chat
  // (chat-commands.ts): then the named group chats are listed too, and only
  // that one is kept — read forward from the switch-on, never its history.
  const group = commandGroupRead(clanId);
  // The named group chats are always listed too (no extra request): the clan
  // picks its battle-report chats from them (and the digest its chat), and the
  // picked ones are read like the private chats — history first, then new lines.
  const reportChats = new Set(getReportChats(clanId).map((c) => c.url));
  const all = await listChannels(chat.session, [...KEPT_TYPES, ...POSTABLE_TYPES]);
  refreshGroupChats(clanId, all.filter((c) => (POSTABLE_TYPES as readonly string[]).includes(c.customType)));
  const listed = all.filter((c) => KEPT_TYPES.includes(c.customType) || c.url === group?.url || reportChats.has(c.url));
  const clanUrl = `triumph_clan_channel_${chat.gameClanId}`;
  const channels: ChatChannel[] = listed.some((c) => c.url === clanUrl) || !chat.gameClanId
    ? listed
    : [...listed, { url: clanUrl, customType: 'clanGroup', name: '', memberCount: 0, members: [], lastMessageAt: null }];
  let added = 0;
  let firstReads = 0;
  const now = new Date().toISOString();
  const ordered = [...channels].sort((a, b) => Number(b.customType === 'clanGroup') - Number(a.customType === 'clanGroup'));
  for (const c of ordered) {
    upsertChatChannel(clanId, c, now);
    const after = newestChatMessageAt(clanId, c.url);
    if (group && c.url === group.url) {
      const from = Math.max(after, group.fromMs);
      if (c.lastMessageAt === null || c.lastMessageAt > from) {
        added += saveChatMessages(clanId, await readMessages(chat.session, c.url, from, 200), now);
      }
      continue;
    }
    if (!after) {
      if (firstReads >= FIRST_READS_PER_SYNC) continue; // next sync
      firstReads++;
      // A channel's first read: back from now, as far as its backfill size.
      const first = await readMessagesBefore(chat.session, c.url, Date.now(), BACKFILL[c.customType] ?? 2_000);
      added += saveChatMessages(clanId, first.messages, now);
      if (first.reachedStart) markChatHistoryComplete(clanId, c.url);
      continue;
    }
    // New lines, unless the channel says nothing came after what we hold.
    if (c.lastMessageAt === null || c.lastMessageAt > after) {
      added += saveChatMessages(clanId, await readMessages(chat.session, c.url, after, 2_000), now);
    }
    // Older history the service still serves: a slice per sync, until it has
    // nothing older (then the channel is marked complete and never asked again).
    // Everything stored stays stored — the service only keeps recent history.
    if (!isChatHistoryComplete(clanId, c.url)) {
      const older = await readMessagesBefore(chat.session, c.url, oldestChatMessageAt(clanId, c.url), OLDER_PER_SYNC);
      added += saveChatMessages(clanId, older.messages, now);
      if (older.reachedStart) markChatHistoryComplete(clanId, c.url);
    }
  }
  return { channels: channels.length, added };
}

/**
 * After a scan's game sign-in: fresh chat token → chat session → sync.
 * Returns a short summary for the scan log, never throws.
 */
export async function refreshChatSession(clanId: number, client: GameClient, gameClanId: number): Promise<string> {
  try {
    if (!client.suid) return 'chat skipped (no website user id)';
    const session = await chatLogin(client.suid, await client.chatToken());
    const chat: ClanChat = { session, gameClanId, journalToken: client.journalToken ?? null };
    keepSession(clanId, chat);
    const r = await sync(clanId, chat);
    return `chat: ${r.channels} channels, ${r.added} new messages`;
  } catch (err) {
    dropSession(clanId);
    log.warn({ noAlert: true }, `Clan #${clanId} chat sync failed (the scan is unaffected): ${String(err)}`);
    return 'chat failed';
  }
}

/** The clan's chat session from its last scan, or null (the chat digest lists the account's group chats with it). */
export function chatSessionFor(clanId: number): ChatSession | null {
  return sessions.get(clanId)?.session ?? null;
}

/** Start the between-scans poller (idempotent). */
export function startChatPoller(): void {
  if (pollTimer) return;
  const restored = restoreSessions();
  if (restored) log.info(`Chat polling resumed for ${restored} clan(s) from saved sessions`);
  pollTimer = setInterval(() => { void pollOnce(); }, POLL_MS);
  pollTimer.unref?.();
}

export function stopChatPoller(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/**
 * A code request or a chat command between scans is answered on the game
 * session the clan's last scan kept. After a server restart there is none
 * until the next scan — up to a whole interval (2 h): a code request on Nov
 * 18 2026 sat at "Waiting to send", and so did the first chat command after
 * the Nov 20 deploy. Then the scan loop is asked to scan just that clan
 * (seconds; it answers what waits and keeps a session for the next ones), at
 * most once per clan every REPLY_SCAN_MIN_GAP_MS — only while nothing is kept.
 */
let replyScanTrigger: ((clanId: number) => void) | null = null;
const REPLY_SCAN_MIN_GAP_MS = 10 * 60_000;
const lastReplyScan = new Map<number, number>();

export function setChatReplyScanTrigger(fn: ((clanId: number) => void) | null): void {
  replyScanTrigger = fn;
}

export function maybeScanForChatReplies(clanId: number, now = Date.now()): void {
  if (!replyScanTrigger || keptSessionClans().includes(clanId)) return;
  const what = hasWaitingInviteRequests(clanId, now) ? 'a code request' : hasWaitingChatCommands(clanId, now) ? 'a chat command' : null;
  if (!what) return;
  if (now - (lastReplyScan.get(clanId) ?? 0) < REPLY_SCAN_MIN_GAP_MS) return;
  lastReplyScan.set(clanId, now);
  log.info(`Clan #${clanId}: ${what} is waiting and no game session is kept (restarted since the last scan) — scanning the clan now to answer it`);
  replyScanTrigger(clanId);
}

/**
 * Battle reports shared in the clan's chats, opened on the last login's
 * journal token. Its own failures stay here: they never pause chat polling.
 */
async function readSharedReports(clanId: number, chat: ClanChat): Promise<void> {
  if (!chat.journalToken) return;
  try {
    const r = await fetchSharedReports(clanId, chat.journalToken);
    if (r.tokenBad) chat.journalToken = null; // until the next scan's login brings a fresh one
    if (r.note) log.info(`Clan #${clanId} ${r.note}`);
  } catch (err) {
    log.warn({ noAlert: true }, `Clan #${clanId}: battle reports not read this time: ${String(err)}`);
  }
}

async function pollOnce(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    for (const [clanId, chat] of sessions) {
      try {
        const r = await sync(clanId, chat);
        if (r.added) log.debug(`Clan #${clanId} chat: ${r.added} new messages`);
        // Account invites (chat-invites.ts): a keyword DM is answered within a
        // minute when the clan's last scan left a game session for a chat
        // token, else by the clan's next scan. Never throws.
        const note = await processInviteRequests(clanId, {
          scannerChatId: chat.session.userId,
          chatSession: chat.session,
          chatToken: async () => (await withKeptGameSession(clanId, (client) => client.chatToken())) ?? null,
        });
        if (note) log.info(`Clan #${clanId} ${note}`);
        // Chat commands (chat-commands.ts): "me", "top", … answered the same
        // way, within a minute on a kept game session. Never throws.
        const commands = await processChatCommands(clanId, {
          scannerChatId: chat.session.userId,
          chatSession: chat.session,
          chatToken: async () => (await withKeptGameSession(clanId, (client) => client.chatToken())) ?? null,
        });
        if (commands) log.info(`Clan #${clanId} ${commands}`);
        // No session kept (a restart): scan the clan to answer what waits.
        maybeScanForChatReplies(clanId);
        // Welcome codes trickle out between scans too (one a run, 10 min
        // apart — chat-invites.ts), on the game session the last scan kept.
        if (keptSessionClans().includes(clanId)) {
          const welcome = await sendWelcomeCodes(clanId, {
            scannerChatId: chat.session.userId,
            chatSession: chat.session,
            chatToken: async () => (await withKeptGameSession(clanId, (client) => client.chatToken())) ?? null,
            betweenScans: true,
          });
          if (welcome) log.info(`Clan #${clanId} ${welcome}`);
        }
        await readSharedReports(clanId, chat);
      } catch (err) {
        // A rejected key (or any failure) waits for the next scan's fresh session.
        dropSession(clanId);
        pollWarner.warn(`poll:${clanId}`, `Chat polling paused for clan #${clanId} until its next scan: ${String(err)}`);
      }
    }
  } finally {
    polling = false;
  }
}
