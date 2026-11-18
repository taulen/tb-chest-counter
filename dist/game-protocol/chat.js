"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SENDBIRD_APP_ID = void 0;
exports.chatLogin = chatLogin;
exports.listChannelMembers = listChannelMembers;
exports.openPrivateChat = openPrivateChat;
exports.channelListQuery = channelListQuery;
exports.listChannels = listChannels;
exports.readMessages = readMessages;
exports.readMessagesBefore = readMessagesBefore;
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
const ws_1 = __importDefault(require("ws"));
const client_js_1 = require("./client.js");
/** Total Battle's Sendbird application (one for the whole game). */
exports.SENDBIRD_APP_ID = '1CA99C8C-22B2-4DE6-9507-052C59BBB504';
const SDK_VERSION = '4.2.1';
const TIMEOUT_MS = 20_000;
const lower = (appId) => appId.toLowerCase();
/** Open the chat socket with the game's token, take the session key from LOGI, close. */
function chatLogin(userId, token, appId = exports.SENDBIRD_APP_ID) {
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
        const ws = new ws_1.default(`wss://ws-${lower(appId)}.sendbird.com/?${params}`, [protocol], { origin: 'https://totalbattle.com' });
        const timer = setTimeout(() => { ws.terminate(); reject(new client_js_1.GameProtocolError('chat login timed out')); }, TIMEOUT_MS);
        const done = (err, s) => {
            clearTimeout(timer);
            ws.removeAllListeners();
            ws.on('error', () => { });
            ws.close();
            if (err)
                reject(err);
            else
                resolve(s);
        };
        ws.on('message', (raw) => {
            const text = raw.toString();
            if (!text.startsWith('LOGI'))
                return;
            try {
                const body = JSON.parse(text.slice(4));
                if (!body.key)
                    return done(new client_js_1.GameProtocolError(`chat login refused: ${body.message ?? 'no session key'}`));
                done(null, { appId, userId, key: body.key });
            }
            catch (err) {
                done(err);
            }
        });
        ws.on('error', (err) => done(new client_js_1.GameProtocolError(`chat socket: ${err.message}`)));
        ws.on('unexpected-response', (_req, res) => done(new client_js_1.GameProtocolError(`chat socket refused: HTTP ${res.statusCode}`)));
    });
}
async function api(s, pathAndQuery) {
    const res = await fetch(`https://api-${lower(s.appId)}.sendbird.com/v3${pathAndQuery}`, {
        headers: { 'Session-Key': s.key, Accept: 'application/json', 'SB-User-Agent': `unity/c${SDK_VERSION}/owebglplayer` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok)
        throw new client_js_1.GameProtocolError(`chat API ${pathAndQuery.split('?')[0]} → HTTP ${res.status}`);
    return (await res.json());
}
/**
 * Every member of a channel (the clan chat: the clan's players, with the
 * memberInfo that names their player id). Pages through the member list.
 * Account invites use it to find a new member's chat account — whether the
 * member list carries metadata was not confirmed live (Nov 2026); a member
 * without it is simply not matched.
 */
async function listChannelMembers(s, channelUrl, max = 500) {
    const out = [];
    let token = '';
    for (let page = 0; page < 10 && out.length < max; page++) {
        const q = new URLSearchParams({ limit: '100', ...(token ? { token } : {}) });
        const r = await api(s, `/group_channels/${encodeURIComponent(channelUrl)}/members?${q}`);
        for (const m of r.members ?? []) {
            out.push({ userId: m.user_id ?? m.guest_id ?? '', nickname: m.nickname ?? m.name ?? '', memberInfo: m.metadata?.memberInfo ?? '' });
        }
        if (!r.next)
            break;
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
async function openPrivateChat(s, otherUserId) {
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
    if (!res.ok)
        throw new client_js_1.GameProtocolError(`chat API create channel → HTTP ${res.status}`);
    const c = (await res.json());
    return {
        url: c.channel_url,
        customType: c.custom_type ?? '',
        name: c.name ?? '',
        memberCount: c.member_count ?? 0,
        members: (c.members ?? []).map((m) => ({ userId: m.user_id ?? m.guest_id ?? '', nickname: m.nickname ?? m.name ?? '' })),
        lastMessageAt: c.last_message?.created_at ?? null,
    };
}
/**
 * The query the game client itself sends to list a user's channels (recorded
 * Nov 2026). `custom_types` MUST keep literal commas: URLSearchParams writes
 * them as %2C, which the chat service reads as ONE type named
 * "clanGroup,whisper" — that matched nothing, so private messages and every
 * named group chat ("CWB • Carter") were never listed. Each type name is
 * encoded on its own, the separators stay commas.
 */
function channelListQuery(customTypes, token = '') {
    const q = new URLSearchParams({
        limit: '100', show_member: 'true', show_empty: 'true', show_frozen: 'true', show_metadata: 'true',
        distinct_mode: 'all', order: 'latest_last_message', member_state_filter: 'all',
        super_mode: 'all', public_mode: 'all', hidden_mode: 'unhidden_only',
        ...(token ? { token } : {}),
    });
    return `${q}&custom_types=${customTypes.map((t) => encodeURIComponent(t)).join(',')}`;
}
/** Every channel of the given custom types the chat user belongs to. */
async function listChannels(s, customTypes) {
    const out = [];
    let token = '';
    for (let page = 0; page < 20; page++) {
        const r = await api(s, `/users/${encodeURIComponent(s.userId)}/my_group_channels?${channelListQuery(customTypes, token)}`);
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
        if (!r.next)
            break;
        token = r.next;
    }
    return out;
}
function toMessage(channelUrl, m) {
    const id = m.message_id ?? m.msg_id;
    const at = m.created_at ?? m.ts;
    if (typeof id !== 'number' || typeof at !== 'number')
        return null;
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
async function readMessages(s, channelUrl, afterMs, max = 2000) {
    const url = `/group_channels/${encodeURIComponent(channelUrl)}/messages`;
    const PAGE = 200;
    const seen = new Map();
    if (afterMs <= 0) {
        return (await readMessagesBefore(s, channelUrl, Date.now(), max)).messages;
    }
    else {
        let after = afterMs;
        while (seen.size < max) {
            const q = new URLSearchParams({ message_ts: String(after), prev_limit: '0', next_limit: String(PAGE), include: 'true' });
            const r = await api(s, `${url}?${q}`);
            const batch = (r.messages ?? []).map((m) => toMessage(channelUrl, m)).filter((m) => m !== null && m.createdAt >= afterMs);
            const before = seen.size;
            for (const m of batch)
                seen.set(m.messageId, m);
            if (batch.length < PAGE - 1 || seen.size === before)
                break;
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
async function readMessagesBefore(s, channelUrl, beforeMs, max = 2000) {
    const url = `/group_channels/${encodeURIComponent(channelUrl)}/messages`;
    const PAGE = 200;
    const seen = new Map();
    let before = beforeMs;
    let reachedStart = false;
    while (seen.size < max) {
        const q = new URLSearchParams({ message_ts: String(before), prev_limit: String(PAGE), next_limit: '0', reverse: 'true', include: 'true' });
        const r = await api(s, `${url}?${q}`);
        const batch = (r.messages ?? []).map((m) => toMessage(channelUrl, m)).filter((m) => m !== null && m.createdAt <= beforeMs);
        const had = seen.size;
        for (const m of batch)
            seen.set(m.messageId, m);
        if (batch.length < PAGE) {
            reachedStart = true;
            break;
        }
        // A full page that added nothing: a whole page on one millisecond. Stop
        // rather than loop; the next backfill resumes from the oldest stored.
        if (seen.size === had)
            break;
        before = Math.min(...batch.map((m) => m.createdAt));
    }
    return { messages: [...seen.values()].sort((a, b) => a.createdAt - b.createdAt || a.messageId - b.messageId), reachedStart };
}
//# sourceMappingURL=chat.js.map