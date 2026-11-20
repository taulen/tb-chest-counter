/**
 * In-game chat (Sendbird), read the way the game client reads it.
 *
 *   1. The game hands out a chat token: message 414 on the signed-in game
 *      session (GameClient.chatToken()).
 *   2. A Sendbird WebSocket opened with that token as its subprotocol answers
 *      with a LOGI frame carrying a session key; we close the socket at once.
 *   3. Sendbird's REST API, authorised by that session key, lists the account's
 *      channels and pages through their history.
 *
 * Chat users are website accounts (`tb:<n>`), so two clans scanned through one
 * website account see the same private messages. Channels by custom_type:
 * `clanGroup` (triumph_clan_channel_<clanId>), `realmGroup`, `whisper`
 * (1:1 private messages), `publicGroup`. Messages carry custom_type `user`
 * (player) or `service` (game system post). See docs/game-protocol.md.
 */
import WebSocket from 'ws';
import { GameProtocolError } from './client.js';

/** Total Battle's Sendbird application (one for the whole game). */
export const SENDBIRD_APP_ID = '1CA99C8C-22B2-4DE6-9507-052C59BBB504';
const SDK_VERSION = '4.2.1';
const TIMEOUT_MS = 20_000;

export interface ChatSession {
  appId: string;
  userId: string;
  key: string;
}

export interface ChatChannel {
  url: string;
  customType: string;
  name: string;
  memberCount: number;
  /** Other side of a 1:1 channel (whisper), when the API names it. */
  members: Array<{ userId: string; nickname: string }>;
  lastMessageAt: number | null;
  /** The channel's own longest message (`max_length_message`), when the listing says; null/absent = unknown. */
  maxLength?: number | null;
}

export interface ChatMessage {
  messageId: number;
  channelUrl: string;
  createdAt: number;
  /** `user` (a player) or `service` (a game system post). */
  customType: string;
  senderId: string;
  senderName: string;
  /** Sender's metadata.memberInfo: realmHex,playerHex,clanHex,0,rank,tag. */
  senderInfo: string;
  message: string;
  data: string;
  /** When the chat service last changed the message (an edit), 0 when never. */
  updatedAt: number;
  /**
   * The message's `translations` map as JSON (language → text), '' when empty.
   * The game translates on demand through its own endpoint and stores nothing,
   * so every message seen so far carries `{}` — kept should one ever arrive.
   */
  translations: string;
}

const lower = (appId: string) => appId.toLowerCase();

/** Open the chat socket with the game's token, take the session key from LOGI, close. */
export function chatLogin(userId: string, token: string, appId = SENDBIRD_APP_ID): Promise<ChatSession> {
  const params = new URLSearchParams({
    p: 'Unity', user_id: userId, pv: 'Unity', sv: SDK_VERSION, ai: appId, av: '', o: 'WebGLPlayer',
    include_extra_data: 'premium_feature_list,file_upload_size_limit,application_attributes,emoji_hash',
    'SB-User-Agent': `unity/c${SDK_VERSION}/owebglplayer`,
    'SB-SDK-User-Agent': `main_sdk_info=chat/unity/${SDK_VERSION}`,
    device_os_platform: 'webglplayer',
    'Request-Sent-Timestamp': String(Date.now()),
  });
  // The game passes `{"token": "<hex>"}` URL-encoded (spaces as '+') as the subprotocol.
  const protocol = new URLSearchParams({ x: JSON.stringify({ token }).replace(':"', ': "') }).toString().slice(2);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://ws-${lower(appId)}.sendbird.com/?${params}`, [protocol], { origin: 'https://totalbattle.com' });
    const timer = setTimeout(() => { ws.terminate(); reject(new GameProtocolError('chat login timed out')); }, TIMEOUT_MS);
    const done = (err: Error | null, s?: ChatSession) => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.close();
      if (err) reject(err); else resolve(s as ChatSession);
    };
    ws.on('message', (raw) => {
      const text = raw.toString();
      if (!text.startsWith('LOGI')) return;
      try {
        const body = JSON.parse(text.slice(4)) as { key?: string; error?: boolean; message?: string };
        if (!body.key) return done(new GameProtocolError(`chat login refused: ${body.message ?? 'no session key'}`));
        done(null, { appId, userId, key: body.key });
      } catch (err) {
        done(err as Error);
      }
    });
    ws.on('error', (err) => done(new GameProtocolError(`chat socket: ${err.message}`)));
    ws.on('unexpected-response', (_req, res) => done(new GameProtocolError(`chat socket refused: HTTP ${res.statusCode}`)));
  });
}

async function api<T>(s: ChatSession, pathAndQuery: string): Promise<T> {
  const res = await fetch(`https://api-${lower(s.appId)}.sendbird.com/v3${pathAndQuery}`, {
    headers: { 'Session-Key': s.key, Accept: 'application/json', 'SB-User-Agent': `unity/c${SDK_VERSION}/owebglplayer` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new GameProtocolError(`chat API ${pathAndQuery.split('?')[0]} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

type RawUser = { user_id?: string; guest_id?: string; nickname?: string; name?: string; metadata?: Record<string, string> };

/** A chat member as a channel's member list gives it: its chat account, name and memberInfo metadata. */
export interface ChatMember {
  userId: string;
  nickname: string;
  /** metadata.memberInfo: realmHex,playerHex,clanHex,0,rank,tag ('' when absent). */
  memberInfo: string;
}

/**
 * Every member of a channel (the clan chat: the clan's players, with the
 * memberInfo that names their player id). Pages through the member list.
 * Account invites use it to find a new member's chat account — whether the
 * member list carries metadata was not confirmed live (Nov 2026); a member
 * without it is simply not matched.
 */
export async function listChannelMembers(s: ChatSession, channelUrl: string, max = 500): Promise<ChatMember[]> {
  const out: ChatMember[] = [];
  let token = '';
  for (let page = 0; page < 10 && out.length < max; page++) {
    const q = new URLSearchParams({ limit: '100', ...(token ? { token } : {}) });
    const r = await api<{ members?: RawUser[]; next?: string }>(s, `/group_channels/${encodeURIComponent(channelUrl)}/members?${q}`);
    for (const m of r.members ?? []) {
      out.push({ userId: m.user_id ?? m.guest_id ?? '', nickname: m.nickname ?? m.name ?? '', memberInfo: m.metadata?.memberInfo ?? '' });
    }
    if (!r.next) break;
    token = r.next;
  }
  return out;
}

/**
 * Open (or find — Sendbird returns the existing one for a distinct pair) the
 * 1:1 private chat between the session's user and `otherUserId`, in the shape
 * the game's own private chats have: custom_type `whisper`, is_distinct, the
 * two chat accounts as members, named `tb:<a>_tb:<b>` (docs/game-protocol.md).
 * UNCONFIRMED LIVE (Nov 2026): no capture of the game client creating one —
 * the caller verifies the returned channel before anything is sent into it.
 */
export async function openPrivateChat(s: ChatSession, otherUserId: string): Promise<ChatChannel> {
  const res = await fetch(`https://api-${lower(s.appId)}.sendbird.com/v3/group_channels`, {
    method: 'POST',
    headers: {
      'Session-Key': s.key, Accept: 'application/json', 'Content-Type': 'application/json',
      'SB-User-Agent': `unity/c${SDK_VERSION}/owebglplayer`,
    },
    body: JSON.stringify({
      user_ids: [s.userId, otherUserId], is_distinct: true, custom_type: 'whisper', name: `${s.userId}_${otherUserId}`,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new GameProtocolError(`chat API create channel → HTTP ${res.status}`);
  const c = (await res.json()) as RawChannel;
  return {
    url: c.channel_url,
    customType: c.custom_type ?? '',
    name: c.name ?? '',
    memberCount: c.member_count ?? 0,
    members: (c.members ?? []).map((m) => ({ userId: m.user_id ?? m.guest_id ?? '', nickname: m.nickname ?? m.name ?? '' })),
    lastMessageAt: c.last_message?.created_at ?? null,
  };
}
/** Our own mute in a chat, as the chat service reports it. */
export interface MuteInfo {
  muted: boolean;
  /** Epoch ms the mute ends; null when it gave none (or it has no end). */
  endAt: number | null;
  /** The raw answer, for the log (an error-sized object: no keys or tokens in it). */
  raw: string;
}

/**
 * The session user's own mute in `channelUrl` — the chat service's "my muted
 * info" (`GET /group_channels/<url>/mute/<user>`: is_muted, end_at,
 * remaining_duration). Read after a send is refused "You are muted." to learn
 * when the mute ends. UNCONFIRMED LIVE (Nov 18 2026): the game may mute
 * outside the chat service's own channel mutes, in which case this says
 * `muted: false` and the caller falls back to its own pause.
 */
export async function myMuteInfo(s: ChatSession, channelUrl: string): Promise<MuteInfo> {
  const r = await api<{ is_muted?: boolean; end_at?: number; remaining_duration?: number; start_at?: number; description?: string }>(
    s, `/group_channels/${encodeURIComponent(channelUrl)}/mute/${encodeURIComponent(s.userId)}`,
  );
  const now = Date.now();
  const endAt = typeof r.end_at === 'number' && r.end_at > 0 ? r.end_at
    : typeof r.remaining_duration === 'number' && r.remaining_duration > 0 ? now + r.remaining_duration : null;
  return { muted: r.is_muted === true, endAt, raw: JSON.stringify(r).slice(0, 300) };
}

type RawChannel = {
  channel_url: string; custom_type?: string; name?: string; member_count?: number;
  members?: RawUser[]; last_message?: { created_at?: number } | null;
  /** The longest message the channel takes (1000 in every channel, Nov 2026). */
  max_length_message?: number;
};
type RawMessage = {
  message_id?: number; msg_id?: number; created_at?: number; ts?: number; custom_type?: string;
  message?: string; data?: string; user?: RawUser; channel_url?: string;
  updated_at?: number; translations?: Record<string, string> | null;
};

/**
 * The query the game client itself sends to list a user's channels (recorded
 * Nov 2026). `custom_types` MUST keep literal commas: URLSearchParams writes
 * them as %2C, which the chat service reads as ONE type named
 * "clanGroup,whisper" — that matched nothing, so private messages and every
 * named group chat ("CWB • Carter") were never listed. Each type name is
 * encoded on its own, the separators stay commas.
 */
export function channelListQuery(customTypes: string[], token = ''): string {
  const q = new URLSearchParams({
    limit: '100', show_member: 'true', show_empty: 'true', show_frozen: 'true', show_metadata: 'true',
    distinct_mode: 'all', order: 'latest_last_message', member_state_filter: 'all',
    super_mode: 'all', public_mode: 'all', hidden_mode: 'unhidden_only',
    ...(token ? { token } : {}),
  });
  return `${q}&custom_types=${customTypes.map((t) => encodeURIComponent(t)).join(',')}`;
}

/** Every channel of the given custom types the chat user belongs to. */
export async function listChannels(s: ChatSession, customTypes: string[]): Promise<ChatChannel[]> {
  const out: ChatChannel[] = [];
  let token = '';
  for (let page = 0; page < 20; page++) {
    const r = await api<{ channels: RawChannel[]; next?: string }>(s, `/users/${encodeURIComponent(s.userId)}/my_group_channels?${channelListQuery(customTypes, token)}`);
    for (const c of r.channels ?? []) {
      out.push({
        url: c.channel_url,
        customType: c.custom_type ?? '',
        name: c.name ?? '',
        memberCount: c.member_count ?? 0,
        members: (c.members ?? []).map((m) => ({ userId: m.user_id ?? m.guest_id ?? '', nickname: m.nickname ?? m.name ?? '' })),
        lastMessageAt: c.last_message?.created_at ?? null,
        maxLength: typeof c.max_length_message === 'number' && c.max_length_message > 0 ? c.max_length_message : null,
      });
    }
    if (!r.next) break;
    token = r.next;
  }
  return out;
}

function toMessage(channelUrl: string, m: RawMessage): ChatMessage | null {
  const id = m.message_id ?? m.msg_id;
  const at = m.created_at ?? m.ts;
  if (typeof id !== 'number' || typeof at !== 'number') return null;
  return {
    messageId: id,
    channelUrl,
    createdAt: at,
    customType: m.custom_type ?? '',
    senderId: m.user?.user_id ?? m.user?.guest_id ?? '',
    senderName: m.user?.nickname ?? m.user?.name ?? '',
    senderInfo: m.user?.metadata?.memberInfo ?? '',
    message: m.message ?? '',
    data: m.data ?? '',
    updatedAt: typeof m.updated_at === 'number' ? m.updated_at : 0,
    translations: m.translations && typeof m.translations === 'object' && Object.keys(m.translations).length
      ? JSON.stringify(m.translations) : '',
  };
}

/**
 * Messages of one channel from `afterMs` on (oldest first), paging forward
 * until caught up or `max` reached. The boundary millisecond is included —
 * a message sharing it with the newest stored one would otherwise be skipped
 * for good; the store ignores the ones it already holds. `afterMs = 0` reads
 * backwards from now instead, as far as `max` messages (a channel's first read).
 */
export async function readMessages(s: ChatSession, channelUrl: string, afterMs: number, max = 2000): Promise<ChatMessage[]> {
  const url = `/group_channels/${encodeURIComponent(channelUrl)}/messages`;
  const PAGE = 200;
  const seen = new Map<number, ChatMessage>();
  if (afterMs <= 0) {
    return (await readMessagesBefore(s, channelUrl, Date.now(), max)).messages;
  } else {
    let after = afterMs;
    while (seen.size < max) {
      const q = new URLSearchParams({ message_ts: String(after), prev_limit: '0', next_limit: String(PAGE), include: 'true' });
      const r = await api<{ messages: RawMessage[] }>(s, `${url}?${q}`);
      const batch = (r.messages ?? []).map((m) => toMessage(channelUrl, m)).filter((m): m is ChatMessage => m !== null && m.createdAt >= afterMs);
      const before = seen.size;
      for (const m of batch) seen.set(m.messageId, m);
      if (batch.length < PAGE - 1 || seen.size === before) break;
      after = Math.max(...batch.map((m) => m.createdAt));
    }
  }
  return [...seen.values()].sort((a, b) => a.createdAt - b.createdAt || a.messageId - b.messageId);
}

/**
 * Messages of one channel up to `beforeMs` (paging back, oldest first in the
 * result), at most about `max`. `reachedStart` is true when the service
 * returned less than a full page — the channel's history goes no further
 * back — so the backfill can stop asking. The boundary millisecond is
 * included and de-duplicated by id, so ties on it are never skipped.
 */
export async function readMessagesBefore(
  s: ChatSession, channelUrl: string, beforeMs: number, max = 2000,
): Promise<{ messages: ChatMessage[]; reachedStart: boolean }> {
  const url = `/group_channels/${encodeURIComponent(channelUrl)}/messages`;
  const PAGE = 200;
  const seen = new Map<number, ChatMessage>();
  let before = beforeMs;
  let reachedStart = false;
  while (seen.size < max) {
    const q = new URLSearchParams({ message_ts: String(before), prev_limit: String(PAGE), next_limit: '0', reverse: 'true', include: 'true' });
    const r = await api<{ messages: RawMessage[] }>(s, `${url}?${q}`);
    const batch = (r.messages ?? []).map((m) => toMessage(channelUrl, m)).filter((m): m is ChatMessage => m !== null && m.createdAt <= beforeMs);
    const had = seen.size;
    for (const m of batch) seen.set(m.messageId, m);
    if (batch.length < PAGE) { reachedStart = true; break; }
    // A full page that added nothing: a whole page on one millisecond. Stop
    // rather than loop; the next backfill resumes from the oldest stored.
    if (seen.size === had) break;
    before = Math.min(...batch.map((m) => m.createdAt));
  }
  return { messages: [...seen.values()].sort((a, b) => a.createdAt - b.createdAt || a.messageId - b.messageId), reachedStart };
}
