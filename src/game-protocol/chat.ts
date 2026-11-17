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
type RawChannel = {
  channel_url: string; custom_type?: string; name?: string; member_count?: number;
  members?: RawUser[]; last_message?: { created_at?: number } | null;
};
type RawMessage = {
  message_id?: number; msg_id?: number; created_at?: number; ts?: number; custom_type?: string;
  message?: string; data?: string; user?: RawUser; channel_url?: string;
};

/** Every channel of the given custom types the chat user belongs to. */
export async function listChannels(s: ChatSession, customTypes: string[]): Promise<ChatChannel[]> {
  const out: ChatChannel[] = [];
  let token = '';
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({
      limit: '100', custom_types: customTypes.join(','), show_member: 'true', show_empty: 'false',
      order: 'latest_last_message', ...(token ? { token } : {}),
    });
    const r = await api<{ channels: RawChannel[]; next?: string }>(s, `/users/${encodeURIComponent(s.userId)}/my_group_channels?${q}`);
    for (const c of r.channels ?? []) {
      out.push({
        url: c.channel_url,
        customType: c.custom_type ?? '',
        name: c.name ?? '',
        memberCount: c.member_count ?? 0,
        members: (c.members ?? []).map((m) => ({ userId: m.user_id ?? m.guest_id ?? '', nickname: m.nickname ?? m.name ?? '' })),
        lastMessageAt: c.last_message?.created_at ?? null,
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
  };
}

/**
 * Messages of one channel strictly after `afterMs` (oldest first), paging
 * forward until caught up or `max` reached. `afterMs = 0` reads backwards from
 * now instead, as far as `max` messages (the first read of a channel).
 */
export async function readMessages(s: ChatSession, channelUrl: string, afterMs: number, max = 2000): Promise<ChatMessage[]> {
  const url = `/group_channels/${encodeURIComponent(channelUrl)}/messages`;
  const PAGE = 200;
  const seen = new Map<number, ChatMessage>();
  if (afterMs <= 0) {
    let before = Date.now();
    while (seen.size < max) {
      const q = new URLSearchParams({ message_ts: String(before), prev_limit: String(PAGE), next_limit: '0', reverse: 'true', include: 'false' });
      const r = await api<{ messages: RawMessage[] }>(s, `${url}?${q}`);
      const batch = (r.messages ?? []).map((m) => toMessage(channelUrl, m)).filter((m): m is ChatMessage => m !== null);
      for (const m of batch) seen.set(m.messageId, m);
      if (batch.length < PAGE) break;
      const oldest = Math.min(...batch.map((m) => m.createdAt));
      if (oldest >= before) break;
      before = oldest;
    }
  } else {
    let after = afterMs;
    while (seen.size < max) {
      const q = new URLSearchParams({ message_ts: String(after), prev_limit: '0', next_limit: String(PAGE), include: 'false' });
      const r = await api<{ messages: RawMessage[] }>(s, `${url}?${q}`);
      const batch = (r.messages ?? []).map((m) => toMessage(channelUrl, m)).filter((m): m is ChatMessage => m !== null && m.createdAt > afterMs);
      const before = seen.size;
      for (const m of batch) seen.set(m.messageId, m);
      if (batch.length < PAGE - 1 || seen.size === before) break;
      after = Math.max(...batch.map((m) => m.createdAt));
    }
  }
  return [...seen.values()].sort((a, b) => a.createdAt - b.createdAt || a.messageId - b.messageId);
}
