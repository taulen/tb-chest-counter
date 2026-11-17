"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendOverSocket = exports.ChatSendRefused = exports.CHANNEL_MAX_LENGTH = exports.MAX_POST_BYTES = exports.MAX_POST_CHARS = exports.POSTABLE_TYPES = void 0;
exports.chatSendingDisabled = chatSendingDisabled;
exports.assertPostableChannel = assertPostableChannel;
exports.assertPostableText = assertPostableText;
exports.postToGroupChat = postToGroupChat;
/**
 * Posting ONE message into an in-game GROUP chat, the way the game client
 * posts: over the chat socket (Sendbird), signed in with a fresh chat token
 * from the game session (message 414), a `MESG` frame carrying a request id;
 * the server echoes the message back with its id, or answers `EROR`.
 *
 * Used only by the daily chat digest (scheduler/chat-digest.ts). Hard rules
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
const crypto_1 = require("crypto");
const ws_1 = __importDefault(require("ws"));
const chat_js_1 = require("./chat.js");
/** Group-chat kinds a digest may go to: the clan's own named chats. */
exports.POSTABLE_TYPES = ['publicGroup', 'privateGroup'];
/**
 * The size of the digest the clan posts by hand (2 header lines + 20 entries,
 * user's screenshot of 15 November 2026): 898 characters, 1114 UTF-8 bytes.
 * Every channel reports `max_length_message: 1000`; the screenshot is the
 * tighter of the two, and the one the user set as the ceiling.
 */
exports.MAX_POST_CHARS = 898;
exports.MAX_POST_BYTES = 1114;
/** The channels' own limit (Sendbird `max_length_message`, Nov 2026). */
exports.CHANNEL_MAX_LENGTH = 1000;
const SDK_VERSION = '4.2.1';
const TIMEOUT_MS = 20_000;
class ChatSendRefused extends Error {
    constructor(message) {
        super(message);
        this.name = 'ChatSendRefused';
    }
}
exports.ChatSendRefused = ChatSendRefused;
/** The global kill switch (docker-compose.yml: CHAT_SEND_DISABLED). */
function chatSendingDisabled(env = process.env) {
    return /^(1|true|yes|on)$/i.test(String(env.CHAT_SEND_DISABLED ?? '').trim());
}
/**
 * Throws ChatSendRefused unless `channel` is a named group chat of a postable
 * kind. The clan chat, the kingdom chat and private messages are refused by
 * type AND by URL, so a channel stored with a wrong type still can't slip by.
 */
function assertPostableChannel(channel) {
    const url = channel.url ?? '';
    if (!url)
        throw new ChatSendRefused('no channel');
    if (/^triumph_clan_channel_/i.test(url) || channel.customType === 'clanGroup') {
        throw new ChatSendRefused('refusing to post into the main clan chat');
    }
    if (/^triumph_realm_channel_/i.test(url) || channel.customType === 'realmGroup') {
        throw new ChatSendRefused('refusing to post into the kingdom chat');
    }
    if (channel.customType === 'whisper')
        throw new ChatSendRefused('refusing to post into a private chat');
    if (!exports.POSTABLE_TYPES.includes(channel.customType)) {
        throw new ChatSendRefused(`refusing to post into a "${channel.customType || 'unknown'}" channel`);
    }
    if (!channel.name.trim())
        throw new ChatSendRefused('refusing to post into an unnamed channel');
}
/** Throws ChatSendRefused when the text is empty or past the ceiling. */
function assertPostableText(text) {
    if (!text.trim())
        throw new ChatSendRefused('empty message');
    if (text.length > exports.MAX_POST_CHARS || Buffer.byteLength(text, 'utf8') > exports.MAX_POST_BYTES) {
        throw new ChatSendRefused(`message too long (${text.length} chars, ${Buffer.byteLength(text, 'utf8')} bytes)`);
    }
}
/**
 * Post `text` into `channel` as the chat user. Every guard runs first; nothing
 * is sent when one fails (refused, with the reason). `send` is the transport
 * (the real chat socket by default).
 */
async function postToGroupChat(args, send = exports.sendOverSocket) {
    if (chatSendingDisabled())
        return { status: 'refused', error: 'chat sending is disabled (CHAT_SEND_DISABLED)' };
    try {
        assertPostableChannel(args.channel);
        assertPostableText(args.text);
    }
    catch (err) {
        return { status: 'refused', error: err.message };
    }
    return send({ userId: args.userId, token: args.token, channelUrl: args.channel.url, text: args.text });
}
/**
 * The chat socket, as chat.ts's chatLogin opens it, kept open for one `MESG`:
 * LOGI → MESG{…req_id} → the echoed MESG (its msg_id) or EROR → close.
 */
const sendOverSocket = ({ userId, token, channelUrl, text }) => {
    const appId = chat_js_1.SENDBIRD_APP_ID;
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
    const reqId = (0, crypto_1.randomUUID)().toUpperCase();
    return new Promise((resolve) => {
        let sent = false;
        let settled = false;
        const ws = new ws_1.default(`wss://ws-${lower}.sendbird.com/?${params}`, [protocol], { origin: 'https://totalbattle.com' });
        const finish = (outcome) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            ws.removeAllListeners();
            ws.on('error', () => { });
            ws.close();
            resolve(outcome);
        };
        // Before the MESG went out nothing was posted (refused); after, silence
        // means it may have been (unknown — never resend).
        const fail = (error) => finish(sent ? { status: 'unknown', error } : { status: 'refused', error });
        const timer = setTimeout(() => fail('chat socket timed out'), TIMEOUT_MS);
        ws.on('message', (raw) => {
            const frame = raw.toString();
            const cmd = frame.slice(0, 4);
            let body = {};
            try {
                body = JSON.parse(frame.slice(4));
            }
            catch { /* not JSON */ }
            if (cmd === 'LOGI') {
                if (!body.key)
                    return finish({ status: 'refused', error: `chat login refused: ${String(body.message ?? 'no session key')}` });
                const mesg = {
                    channel_url: channelUrl, message: text, data: '', custom_type: 'user', mention_type: 'users',
                    mentioned_user_ids: [], req_id: reqId, request_id: reqId,
                };
                // From the moment the frame is handed to the socket, the message may
                // be out: every later failure is `unknown`, never a resend.
                try {
                    sent = true;
                    ws.send(`MESG${JSON.stringify(mesg)}\n`, (err) => {
                        if (err)
                            finish({ status: 'unknown', error: `chat socket send: ${err.message}` });
                    });
                }
                catch (err) {
                    sent = false;
                    finish({ status: 'refused', error: `chat socket send: ${err.message}` });
                }
                return;
            }
            const echoed = body.req_id === reqId || body.request_id === reqId;
            if (cmd === 'EROR' && (echoed || !body.req_id)) {
                return finish({ status: 'refused', error: `chat refused the message: ${String(body.message ?? body.code ?? 'error')}` });
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
exports.sendOverSocket = sendOverSocket;
//# sourceMappingURL=chat-send.js.map