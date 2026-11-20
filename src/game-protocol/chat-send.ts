/**
 * Posting ONE message into an in-game GROUP chat, the way the game client
 * posts: over the chat socket (Sendbird), signed in with a fresh chat token
 * from the game session (message 414), a `MESG` frame carrying a request id;
 * the server echoes the message back with its id, or answers `EROR`.
 *
 * Used by the daily chat digest (scheduler/chat-digest.ts) and, through their
 * own narrower paths below, by the only exceptions to "never a private chat",
 * each into the 1:1 chat between the scanner account and one player: an
 * account-invite code (sendInviteMessage — the answer to that player's
 * request, or the one welcome code when they join; scheduler/chat-invites.ts)
 * and the answer to that player's chat command (sendCommandReply;
 * scheduler/chat-commands.ts).
 * Hard rules for the digest
 * (user, Nov 2026 — clans mute anyone who spams):
 *   - only a NAMED group chat an admin picked (`publicGroup` / `privateGroup`)
 *     — never the clan chat (`clanGroup`, triumph_clan_channel_*), the kingdom
 *     chat (`realmGroup`, triumph_realm_channel_*), private 1:1 messages
 *     (`whisper`), or any other kind: assertPostableChannel throws;
 *   - one message, never split, never longer than MAX_POST_CHARS;
 *   - CHAT_SEND_DISABLED=1 (env) stops every send;
 *   - the outcome is three-way: `sent` (the server returned a message id),
 *     `refused` (it said no — nothing went out) or `unknown` (no answer —
 *     it may have gone out, so the caller must NOT resend).
 */
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { SENDBIRD_APP_ID, type ChatChannel } from './chat.js';

/** Group-chat kinds a digest may go to: the clan's own named chats. */
export const POSTABLE_TYPES = ['publicGroup', 'privateGroup'] as const;

/**
 * The size of the digest the clan posts by hand (2 header lines + 20 entries,
 * user's screenshot of 15 November 2026): 898 characters, 1114 UTF-8 bytes.
 * Every channel reports `max_length_message: 1000`; the screenshot is the
 * tighter of the two, and the one the user set as the ceiling.
 */
export const MAX_POST_CHARS = 898;
export const MAX_POST_BYTES = 1114;
/** The channels' own limit (Sendbird `max_length_message`, Nov 2026). */
export const CHANNEL_MAX_LENGTH = 1000;

const SDK_VERSION = '4.2.1';
const TIMEOUT_MS = 20_000;

export class ChatSendRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatSendRefused';
  }
}

/** The global kill switch (docker-compose.yml: CHAT_SEND_DISABLED). */
export function chatSendingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.CHAT_SEND_DISABLED ?? '').trim());
}

/**
 * Throws ChatSendRefused unless `channel` is a named group chat of a postable
 * kind. The clan chat, the kingdom chat and private messages are refused by
 * type AND by URL, so a channel stored with a wrong type still can't slip by.
 */
export function assertPostableChannel(channel: Pick<ChatChannel, 'url' | 'customType' | 'name'>): void {
  const url = channel.url ?? '';
  if (!url) throw new ChatSendRefused('no channel');
  if (/^triumph_clan_channel_/i.test(url) || channel.customType === 'clanGroup') {
    throw new ChatSendRefused('refusing to post into the main clan chat');
  }
  if (/^triumph_realm_channel_/i.test(url) || channel.customType === 'realmGroup') {
    throw new ChatSendRefused('refusing to post into the kingdom chat');
  }
  if (channel.customType === 'whisper') throw new ChatSendRefused('refusing to post into a private chat');
  if (!(POSTABLE_TYPES as readonly string[]).includes(channel.customType)) {
    throw new ChatSendRefused(`refusing to post into a "${channel.customType || 'unknown'}" channel`);
  }
  if (!channel.name.trim()) throw new ChatSendRefused('refusing to post into an unnamed channel');
}

/** Throws ChatSendRefused when the text is empty or past the ceiling. */
export function assertPostableText(text: string): void {
  if (!text.trim()) throw new ChatSendRefused('empty message');
  if (text.length > MAX_POST_CHARS || Buffer.byteLength(text, 'utf8') > MAX_POST_BYTES) {
    throw new ChatSendRefused(`message too long (${text.length} chars, ${Buffer.byteLength(text, 'utf8')} bytes)`);
  }
}

export type SendOutcome =
  | { status: 'sent'; messageId: number }
  | { status: 'refused'; error: string; detail?: string }
  | { status: 'unknown'; error: string };

/**
 * The game refused the message because OUR account is muted ("You are
 * muted." — its anti-spam, after too many messages): every recipient gets
 * the same answer until it runs out, so sending pauses (chat-send-state-repo).
 */
export function isMutedRefusal(outcome: SendOutcome): boolean {
  return outcome.status === 'refused' && /\bmuted\b/i.test(outcome.error);
}

/** What actually talks to the chat service — swapped out in tests. */
export type SocketSender = (args: { userId: string; token: string; channelUrl: string; text: string }) => Promise<SendOutcome>;

/**
 * Post `text` into `channel` as the chat user. Every guard runs first; nothing
 * is sent when one fails (refused, with the reason). `send` is the transport
 * (the real chat socket by default).
 */
export async function postToGroupChat(
  args: { userId: string; token: string; channel: Pick<ChatChannel, 'url' | 'customType' | 'name'>; text: string },
  send: SocketSender = sendOverSocket,
): Promise<SendOutcome> {
  if (chatSendingDisabled()) return { status: 'refused', error: 'chat sending is disabled (CHAT_SEND_DISABLED)' };
  try {
    assertPostableChannel(args.channel);
    assertPostableText(args.text);
  } catch (err) {
    return { status: 'refused', error: (err as Error).message };
  }
  return send({ userId: args.userId, token: args.token, channelUrl: args.channel.url, text: args.text });
}

// ── The one private-chat exception: account invite replies ─────────────────

/**
 * An invite message is one line with a code and where to use it — never a
 * post. (The chat takes 1000; 300 became 400 on Nov 18 2026 to name the
 * tracker's maker in every wording.)
 */
export const MAX_INVITE_REPLY_CHARS = 400;

/**
 * Throws ChatSendRefused unless `channel` is the 1:1 private chat between the
 * scanner account and the one player the message is for: a `whisper` channel
 * (never a clan/kingdom URL) whose members are exactly those two chat
 * accounts. These are the ONLY private chats anything may be sent into, and
 * only an account-invite code (scheduler/chat-invites.ts: the answer to that
 * player's own request, or the one welcome code for a player who just joined)
 * or the answer to that player's own chat command (scheduler/chat-commands.ts).
 */
export function assertInviteChannel(
  channel: { url: string; customType: string; members: Array<{ userId: string }> },
  scannerUserId: string,
  recipientUserId: string,
): void {
  const url = channel.url ?? '';
  if (!url) throw new ChatSendRefused('no channel');
  if (/^triumph_(clan|realm)_channel_/i.test(url)) throw new ChatSendRefused('refusing to send outside a private chat');
  if (channel.customType !== 'whisper') throw new ChatSendRefused(`refusing to send in a "${channel.customType || 'unknown'}" channel`);
  if (!scannerUserId || !recipientUserId || scannerUserId === recipientUserId) throw new ChatSendRefused('no recipient');
  const ids = new Set((channel.members ?? []).map((m) => m.userId));
  if ((channel.members ?? []).length !== 2 || ids.size !== 2 || !ids.has(scannerUserId) || !ids.has(recipientUserId)) {
    throw new ChatSendRefused('refusing to send: the chat is not between the scanner and that one player');
  }
}

export function assertInviteText(text: string, channelMax?: number | null): void {
  if (!text.trim()) throw new ChatSendRefused('empty message');
  const limit = channelMax && channelMax > 0 ? Math.min(MAX_INVITE_REPLY_CHARS, channelMax) : MAX_INVITE_REPLY_CHARS;
  if (text.length > limit) throw new ChatSendRefused(`invite message too long (${text.length} chars; limit ${limit})`);
}

/**
 * Send an account-invite code into the private chat between the scanner
 * account and that player. Every guard runs first (the kill switch, the
 * channel, the text); nothing is sent when one fails. Same three-way outcome
 * as postToGroupChat — an `unknown` is never resent.
 */
export async function sendInviteMessage(
  args: {
    userId: string;
    token: string;
    channel: { url: string; customType: string; members: Array<{ userId: string }>; maxLength?: number | null };
    recipientUserId: string;
    text: string;
  },
  send: SocketSender = sendOverSocket,
): Promise<SendOutcome> {
  if (chatSendingDisabled()) return { status: 'refused', error: 'chat sending is disabled (CHAT_SEND_DISABLED)' };
  try {
    assertInviteChannel(args.channel, args.userId, args.recipientUserId);
    assertInviteText(args.text, args.channel.maxLength);
  } catch (err) {
    return { status: 'refused', error: (err as Error).message };
  }
  return send({ userId: args.userId, token: args.token, channelUrl: args.channel.url, text: args.text });
}

// ── The other private-chat exception: chat command replies ─────────────────

/**
 * A command reply (scheduler/chat-commands.ts) answers the player's own
 * message, so it may be as long as a digest post (a top-10 list) — never
 * longer: the size the clan already posts by hand.
 */
export const MAX_COMMAND_REPLY_CHARS = MAX_POST_CHARS;
export const MAX_COMMAND_REPLY_BYTES = MAX_POST_BYTES;

/**
 * The longest reply a channel takes, in characters: our ceiling, or the
 * channel's own `max_length_message` when it reports a smaller one.
 */
export function replyCharLimit(channelMax?: number | null): number {
  return channelMax && channelMax > 0 ? Math.min(MAX_COMMAND_REPLY_CHARS, channelMax) : MAX_COMMAND_REPLY_CHARS;
}

/** Whether `text` fits one reply in a channel whose own limit is `channelMax` (null = not known). */
export function fitsCommandReply(text: string, channelMax?: number | null): boolean {
  return text.length <= replyCharLimit(channelMax) && Buffer.byteLength(text, 'utf8') <= MAX_COMMAND_REPLY_BYTES;
}

export function assertCommandReplyText(text: string, channelMax?: number | null): void {
  if (!text.trim()) throw new ChatSendRefused('empty message');
  if (!fitsCommandReply(text, channelMax)) {
    throw new ChatSendRefused(`command reply too long (${text.length} chars, ${Buffer.byteLength(text, 'utf8')} bytes; limit ${replyCharLimit(channelMax)} chars)`);
  }
}

type CommandChannel = { url: string; customType: string; name?: string; members: Array<{ userId: string }>; maxLength?: number | null };

/**
 * Answer a chat command in the private chat the player wrote it in: the same
 * 1:1 check as an invite code (assertInviteChannel — a `whisper` holding
 * exactly the scanner account and that player), the kill switch, the size.
 * Nothing is sent when one fails. Same three-way outcome — an `unknown` is
 * never resent.
 */
export async function sendCommandReply(
  args: { userId: string; token: string; channel: CommandChannel; recipientUserId: string; text: string },
  send: SocketSender = sendOverSocket,
): Promise<SendOutcome> {
  if (chatSendingDisabled()) return { status: 'refused', error: 'chat sending is disabled (CHAT_SEND_DISABLED)' };
  try {
    assertInviteChannel(args.channel, args.userId, args.recipientUserId);
    assertCommandReplyText(args.text, args.channel.maxLength);
  } catch (err) {
    return { status: 'refused', error: (err as Error).message };
  }
  return send({ userId: args.userId, token: args.token, channelUrl: args.channel.url, text: args.text });
}

/**
 * The one group chat a command may be answered in: the clan's chat digest
 * chat (the named group chat its admins picked — `allowedUrl`), when the clan
 * switched group commands on. Everything assertPostableChannel refuses (the
 * clan chat, the kingdom chat, private chats, unnamed chats) is refused, and
 * any other group chat too.
 */
export function assertCommandGroupChannel(channel: Pick<CommandChannel, 'url' | 'customType'> & { name: string }, allowedUrl: string | null): void {
  assertPostableChannel(channel);
  if (!allowedUrl || channel.url !== allowedUrl) throw new ChatSendRefused('refusing to post into a group chat other than the digest’s');
}

/** Answer a chat command in the clan's digest group chat, where it was asked. Same guards and outcome as above. */
export async function sendGroupCommandReply(
  args: { userId: string; token: string; channel: CommandChannel & { name: string }; allowedUrl: string | null; text: string },
  send: SocketSender = sendOverSocket,
): Promise<SendOutcome> {
  if (chatSendingDisabled()) return { status: 'refused', error: 'chat sending is disabled (CHAT_SEND_DISABLED)' };
  try {
    assertCommandGroupChannel(args.channel, args.allowedUrl);
    assertCommandReplyText(args.text, args.channel.maxLength);
  } catch (err) {
    return { status: 'refused', error: (err as Error).message };
  }
  return send({ userId: args.userId, token: args.token, channelUrl: args.channel.url, text: args.text });
}

/**
 * The chat socket, as chat.ts's chatLogin opens it, kept open for one `MESG`:
 * LOGI → MESG{…req_id} → the echoed MESG (its msg_id) or EROR → close.
 */
export const sendOverSocket: SocketSender = ({ userId, token, channelUrl, text }) => {
  const appId = SENDBIRD_APP_ID;
  const lower = appId.toLowerCase();
  const params = new URLSearchParams({
    p: 'Unity', user_id: userId, pv: 'Unity', sv: SDK_VERSION, ai: appId, av: '', o: 'WebGLPlayer',
    include_extra_data: 'premium_feature_list,file_upload_size_limit,application_attributes,emoji_hash',
    'SB-User-Agent': `unity/c${SDK_VERSION}/owebglplayer`,
    'SB-SDK-User-Agent': `main_sdk_info=chat/unity/${SDK_VERSION}`,
    device_os_platform: 'webglplayer',
    'Request-Sent-Timestamp': String(Date.now()),
  });
  const protocol = new URLSearchParams({ x: JSON.stringify({ token }).replace(':"', ': "') }).toString().slice(2);
  const reqId = randomUUID().toUpperCase();
  return new Promise<SendOutcome>((resolve) => {
    let sent = false;
    let settled = false;
    const ws = new WebSocket(`wss://ws-${lower}.sendbird.com/?${params}`, [protocol], { origin: 'https://totalbattle.com' });
    const finish = (outcome: SendOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.close();
      resolve(outcome);
    };
    // Before the MESG went out nothing was posted (refused); after, silence
    // means it may have been (unknown — never resend).
    const fail = (error: string) => finish(sent ? { status: 'unknown', error } : { status: 'refused', error });
    const timer = setTimeout(() => fail('chat socket timed out'), TIMEOUT_MS);
    ws.on('message', (raw) => {
      const frame = raw.toString();
      const cmd = frame.slice(0, 4);
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(frame.slice(4)) as Record<string, unknown>; } catch { /* not JSON */ }
      if (cmd === 'LOGI') {
        if (!body.key) return finish({ status: 'refused', error: `chat login refused: ${String(body.message ?? 'no session key')}` });
        const mesg = {
          channel_url: channelUrl, message: text, data: '', custom_type: 'user', mention_type: 'users',
          mentioned_user_ids: [], req_id: reqId, request_id: reqId,
        };
        // From the moment the frame is handed to the socket, the message may
        // be out: every later failure is `unknown`, never a resend.
        try {
          sent = true;
          ws.send(`MESG${JSON.stringify(mesg)}\n`, (err) => {
            if (err) finish({ status: 'unknown', error: `chat socket send: ${err.message}` });
          });
        } catch (err) {
          sent = false;
          finish({ status: 'refused', error: `chat socket send: ${(err as Error).message}` });
        }
        return;
      }
      const echoed = body.req_id === reqId || body.request_id === reqId;
      if (cmd === 'EROR' && (echoed || !body.req_id)) {
        // The whole error frame rides along (code and anything else it says,
        // e.g. how long a mute lasts) — an error object, nothing secret in it.
        return finish({ status: 'refused', error: `chat refused the message: ${String(body.message ?? body.code ?? 'error')}`, detail: frame.slice(4, 400) });
      }
      if (cmd === 'MESG' && echoed) {
        const id = Number(body.msg_id ?? body.message_id);
        return finish(Number.isFinite(id) && id > 0 ? { status: 'sent', messageId: id } : { status: 'unknown', error: 'echo without a message id' });
      }
    });
    ws.on('error', (err) => fail(`chat socket: ${err.message}`));
    ws.on('close', () => fail('chat socket closed'));
    ws.on('unexpected-response', (_req, res) => finish({ status: 'refused', error: `chat socket refused: HTTP ${res.statusCode}` }));
  });
};
