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
import type { GameClient } from '../game-protocol/client.js';
import { chatLogin, listChannels, readMessages, readMessagesBefore, type ChatChannel, type ChatSession } from '../game-protocol/chat.js';
import {
  isChatHistoryComplete, markChatHistoryComplete, newestChatMessageAt, oldestChatMessageAt, saveChatMessages, upsertChatChannel,
} from '../data/repositories/chat-repo.js';
import { childLogger } from '../utils/logger.js';
import { createCoalescedWarner } from '../utils/log-throttle.js';

const log = childLogger('chat');
const pollWarner = createCoalescedWarner((m) => log.warn({ noAlert: true }, m), 60 * 60_000);

/** Channel kinds we keep: the clan chat and private messages. */
const KEPT_TYPES = ['clanGroup', 'whisper'];
/** How far back the first sync of a channel reads. */
const BACKFILL = { clanGroup: 20_000, whisper: 2_000 } as Record<string, number>;
/** Older history read per sync after that, until the service has nothing older (5 requests). */
const OLDER_PER_SYNC = 1_000;
const POLL_MS = 60_000;

interface ClanChat {
  session: ChatSession;
  /** The game's clan id, for the clan channel URL. */
  gameClanId: number;
}
const sessions = new Map<number, ClanChat>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;

async function sync(clanId: number, chat: ClanChat): Promise<{ channels: number; added: number }> {
  const listed = await listChannels(chat.session, KEPT_TYPES);
  const clanUrl = `triumph_clan_channel_${chat.gameClanId}`;
  const channels: ChatChannel[] = listed.some((c) => c.url === clanUrl) || !chat.gameClanId
    ? listed
    : [...listed, { url: clanUrl, customType: 'clanGroup', name: '', memberCount: 0, members: [], lastMessageAt: null }];
  let added = 0;
  const now = new Date().toISOString();
  for (const c of channels) {
    upsertChatChannel(clanId, c, now);
    const after = newestChatMessageAt(clanId, c.url);
    if (!after) {
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
    sessions.set(clanId, chat);
    const r = await sync(clanId, chat);
    return `chat: ${r.channels} channels, ${r.added} new messages`;
  } catch (err) {
    sessions.delete(clanId);
    log.warn({ noAlert: true }, `Clan #${clanId} chat sync failed (the scan is unaffected): ${String(err)}`);
    return 'chat failed';
  }
}

/** Start the between-scans poller (idempotent). */
export function startChatPoller(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => { void pollOnce(); }, POLL_MS);
  pollTimer.unref?.();
}

export function stopChatPoller(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function pollOnce(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    for (const [clanId, chat] of sessions) {
      try {
        const r = await sync(clanId, chat);
        if (r.added) log.debug(`Clan #${clanId} chat: ${r.added} new messages`);
      } catch (err) {
        // A rejected key (or any failure) waits for the next scan's fresh session.
        sessions.delete(clanId);
        pollWarner.warn(`poll:${clanId}`, `Chat polling paused for clan #${clanId} until its next scan: ${String(err)}`);
      }
    }
  } finally {
    polling = false;
  }
}
