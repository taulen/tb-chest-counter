/**
 * Keeps each clan's chat stored: the clan chat and the scanner account's
 * private (1:1) messages (game-protocol/chat.ts, migration v104).
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
import { keptSessionClans, withKeptGameSession } from './event-poller.js';

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
  const listed = await listChannels(chat.session, KEPT_TYPES);
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
    const chat = { session, gameClanId };
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
 * A code request between scans is answered on the game session the clan's
 * last scan kept. After a server restart there is none until the next scan —
 * up to a whole interval (2 h): a request on Nov 18 2026 sat at "Waiting to
 * send". Then the scan loop is asked to scan just that clan (seconds; it
 * answers the request and keeps a session for the next ones), at most once
 * per clan every INVITE_SCAN_MIN_GAP_MS.
 */
let inviteScanTrigger: ((clanId: number) => void) | null = null;
const INVITE_SCAN_MIN_GAP_MS = 10 * 60_000;
const lastInviteScan = new Map<number, number>();

export function setInviteScanTrigger(fn: ((clanId: number) => void) | null): void {
  inviteScanTrigger = fn;
}

export function maybeScanForInvites(clanId: number, now = Date.now()): void {
  if (!inviteScanTrigger || keptSessionClans().includes(clanId)) return;
  if (!hasWaitingInviteRequests(clanId, now)) return;
  if (now - (lastInviteScan.get(clanId) ?? 0) < INVITE_SCAN_MIN_GAP_MS) return;
  lastInviteScan.set(clanId, now);
  log.info(`Clan #${clanId}: a code request is waiting and no game session is kept (restarted since the last scan) — scanning the clan now to answer it`);
  inviteScanTrigger(clanId);
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
        maybeScanForInvites(clanId);
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
