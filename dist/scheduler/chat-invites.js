"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LINK_LIKE = exports.WELCOME_GAP_MS = exports.JOIN_ENTRY_LABEL = exports.MAX_REQUEST_AGE_MS = exports.INVITE_KEYWORDS = void 0;
exports.isInviteKeyword = isInviteKeyword;
exports.spacedSiteName = spacedSiteName;
exports.siteNameOverride = siteNameOverride;
exports.siteNameFor = siteNameFor;
exports.defaultSiteNameFor = defaultSiteNameFor;
exports.inviteReplyText = inviteReplyText;
exports.chatAccountMismatch = chatAccountMismatch;
exports.inviteRequestBlocker = inviteRequestBlocker;
exports.detectInviteRequests = detectInviteRequests;
exports.answerInviteRequests = answerInviteRequests;
exports.processInviteRequests = processInviteRequests;
exports.welcomeText = welcomeText;
exports.findChatAccount = findChatAccount;
exports.sendWelcomeCodes = sendWelcomeCodes;
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
const database_js_1 = require("../data/database.js");
const account_invite_repo_js_1 = require("../data/repositories/account-invite-repo.js");
const clan_repo_js_1 = require("../data/repositories/clan-repo.js");
const chat_repo_js_1 = require("../data/repositories/chat-repo.js");
const chat_js_1 = require("../game-protocol/chat.js");
const chat_text_js_1 = require("../game-protocol/chat-text.js");
const chat_send_js_1 = require("../game-protocol/chat-send.js");
const index_js_1 = require("../config/index.js");
const persistent_env_js_1 = require("../config/persistent-env.js");
const request_gap_js_1 = require("../utils/request-gap.js");
const logger_js_1 = require("../utils/logger.js");
const log_throttle_js_1 = require("../utils/log-throttle.js");
const log = (0, logger_js_1.childLogger)('chat-invites');
const quietWarner = (0, log_throttle_js_1.createCoalescedWarner)((m) => log.warn({ noAlert: true }, m), 24 * 3600_000);
const alertWarner = (0, log_throttle_js_1.createCoalescedWarner)((m) => log.warn(m), 3600_000);
/** The words a DM must be (alone) to ask for a code. Exact match after trimming. */
exports.INVITE_KEYWORDS = ['code', 'invite', 'tracker', 'код', 'código', 'codigo'];
/** Older keyword DMs are never answered (a stale code helps nobody). */
exports.MAX_REQUEST_AGE_MS = 6 * 3600_000;
/**
 * Whether a DM asks for a code: the whole message, trimmed, lower-cased, with
 * a leading "!" or "/" and trailing punctuation dropped, is one keyword.
 * "code" and "!Code." ask; "send me the code" does not.
 */
function isInviteKeyword(text) {
    const t = String(text ?? '').normalize('NFC').trim().toLowerCase()
        .replace(/^[!/#¡¿]+/u, '')
        .replace(/[\s.!?…]+$/u, '');
    return exports.INVITE_KEYWORDS.includes(t);
}
/**
 * The game blocks links in chat, so a message never carries one: the site is
 * written as its host with a space around each dot ("cwb . fyi"), and the
 * player picks "Have a code? Join here" on the sign-in page it opens on.
 */
exports.JOIN_ENTRY_LABEL = 'Have a code? Join here';
/** "https://www.cwb.fyi/x" or "cwb.fyi" → "cwb . fyi". '' when nothing usable is left. */
function spacedSiteName(input) {
    const host = String(input ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '')
        .replace(/^www\s*\.\s*/i, '');
    return host.split('.').map((p) => p.trim().toLowerCase()).filter((p) => /^[a-z0-9-]+$/.test(p)).join(' . ');
}
/**
 * Instance-wide override of the site name in messages, '' when unset. Read
 * from the persistent app.env file each time (the settings save writes it
 * there), never process.env, which keeps a removed value until a restart.
 */
function siteNameOverride() {
    return ((0, persistent_env_js_1.readEnvValue)('INVITE_SITE_NAME') ?? '').trim();
}
/**
 * How messages name the site for this clan: the instance override if set,
 * else the host of the clan's public address (its own domain, or the site's),
 * spaced out. Null when there is neither.
 */
function siteNameFor(clanId) {
    const override = spacedSiteName(siteNameOverride());
    if (override)
        return override;
    return defaultSiteNameFor(clanId);
}
/** The site name with no override: the clan's public address host, spaced out; null when there is none. */
function defaultSiteNameFor(clanId) {
    const base = (0, clan_repo_js_1.clanPublicUrl)((0, clan_repo_js_1.getClanById)(clanId), (0, index_js_1.loadConfig)().webExternalUrl);
    const spaced = base ? spacedSiteName(base) : '';
    return spaced || null;
}
function whereToGo(site) {
    return site ? `Go to ${site} and pick "${exports.JOIN_ENTRY_LABEL}"` : `On the TB Chest Counter site, pick "${exports.JOIN_ENTRY_LABEL}"`;
}
/** The reply: the code, where to enter it and how long it lasts. English, one short line, no link. */
function inviteReplyText(code, site) {
    return `TB Chest Counter code: ${(0, account_invite_repo_js_1.formatCode)(code)}. ${whereToGo(site)} within ${Math.round(account_invite_repo_js_1.CODE_TTL_MS / 3600_000)} hours. It works once.`;
}
function channelFor(clanId, channelUrl) {
    const r = (0, database_js_1.getDb)().prepare('SELECT channel_url, custom_type, members FROM chat_channels WHERE clan_id = ? AND channel_url = ?')
        .get(clanId, channelUrl);
    if (!r)
        return null;
    let members = [];
    try {
        const parsed = JSON.parse(r.members);
        if (Array.isArray(parsed))
            members = parsed.map((m) => ({ userId: String(m?.userId ?? '') }));
    }
    catch { /* none */ }
    return { url: r.channel_url, customType: r.custom_type, members };
}
/**
 * Whether `chatUserId` is NOT the chat account this player writes from: the
 * pinned one once the player is linked, else any stored message showing the
 * player writing from a different chat account. (The player id itself comes
 * from chat metadata, which a modified client could fake.)
 */
function chatAccountMismatch(playerId, chatUserId) {
    const pinned = (0, account_invite_repo_js_1.pinnedChatUserFor)(playerId);
    if (pinned)
        return pinned !== chatUserId;
    return !!(0, database_js_1.getDb)().prepare("SELECT 1 FROM chat_messages WHERE sender_player_id = ? AND custom_type = 'user' AND sender_id <> '' AND sender_id <> ? LIMIT 1").get(playerId, chatUserId);
}
/**
 * Why a request must not be answered, or null when it may be. Checked when the
 * DM is first seen and again right before the reply.
 */
function inviteRequestBlocker(clanId, scannerChatId, req, nowMs = Date.now(), exceptRequestId) {
    if ((0, chat_send_js_1.chatSendingDisabled)())
        return 'sending-disabled';
    if (!req.playerId)
        return 'no-player';
    const db = (0, database_js_1.getDb)();
    const onRoster = db.prepare('SELECT 1 FROM game_players WHERE clan_id = ? AND player_id = ? AND in_clan = 1').get(clanId, req.playerId);
    if (!onRoster)
        return 'not-member';
    const channel = channelFor(clanId, req.channelUrl);
    if (!channel)
        return 'channel';
    try {
        (0, chat_send_js_1.assertInviteChannel)(channel, scannerChatId, req.senderChatId);
    }
    catch {
        return 'channel';
    }
    if (chatAccountMismatch(req.playerId, req.senderChatId))
        return 'chat-account-mismatch';
    if ((0, account_invite_repo_js_1.playerInCooldown)(req.playerId, nowMs))
        return 'cooldown';
    if ((0, account_invite_repo_js_1.playerHasOpenRequest)(req.playerId, exceptRequestId))
        return 'duplicate';
    return null;
}
function noteBlocked(clanId, playerId, senderChatId, reason) {
    if (reason === 'chat-account-mismatch') {
        // A player id claimed from a chat account that player never wrote from:
        // possibly a faked identity. Worth a look — the request is not answered.
        alertWarner.warn(`mismatch:${clanId}:${playerId}`, `Clan #${clanId}: an account-invite request for player ${playerId} came from a chat account that player has not written from before — not answered`);
    }
    else if (reason === 'not-member' || reason === 'no-player') {
        quietWarner.warn(`nonmember:${clanId}:${senderChatId}`, `Clan #${clanId}: an account-invite request from a chat user who is not on the clan's roster — not answered`);
    }
}
/**
 * Record every new keyword DM in the clan's private chats once: `pending`
 * when it may be answered, `ignored` (with the reason) when not. Returns how
 * many were recorded.
 */
function detectInviteRequests(clanId, scannerChatId, nowMs = Date.now()) {
    const settings = (0, account_invite_repo_js_1.getInviteSettings)(clanId);
    if (!settings.enabled || settings.enabledAt === null || !scannerChatId)
        return 0;
    const since = Math.max(settings.enabledAt, nowMs - exports.MAX_REQUEST_AGE_MS);
    const rows = (0, database_js_1.getDb)().prepare(`SELECT m.channel_url, m.message_id, m.created_at, m.sender_id, m.sender_player_id, m.message
       FROM chat_messages m
       JOIN chat_channels c ON c.clan_id = m.clan_id AND c.channel_url = m.channel_url
      WHERE m.clan_id = ? AND c.custom_type = 'whisper' AND m.custom_type = 'user'
        AND m.created_at >= ? AND m.sender_id <> ? AND m.sender_id <> '' AND length(m.message) <= 40
        AND NOT EXISTS (SELECT 1 FROM chat_invite_requests r
                         WHERE r.clan_id = m.clan_id AND r.channel_url = m.channel_url AND r.message_id = m.message_id)
      ORDER BY m.created_at, m.message_id LIMIT 200`).all(clanId, since, scannerChatId);
    let recorded = 0;
    for (const m of rows) {
        if (!isInviteKeyword(m.message))
            continue;
        const req = { channelUrl: m.channel_url, senderChatId: m.sender_id, playerId: m.sender_player_id };
        const blocker = inviteRequestBlocker(clanId, scannerChatId, req, nowMs);
        const ok = (0, account_invite_repo_js_1.recordInviteRequest)({ clanId, channelUrl: m.channel_url, messageId: m.message_id, senderChatId: m.sender_id, playerId: m.sender_player_id, requestedAt: m.created_at }, blocker ? 'ignored' : 'pending', blocker);
        if (!ok)
            continue;
        recorded++;
        if (blocker)
            noteBlocked(clanId, m.sender_player_id, m.sender_id, blocker);
    }
    return recorded;
}
/**
 * Answer the clan's pending requests, oldest first: each is re-checked, then
 * reserved (status `sending` + the code's hash, in one transaction), then the
 * reply goes out and its outcome is recorded. Stops (leaving the rest pending)
 * when no chat token can be had. Returns how many replies went out.
 */
async function answerInviteRequests(clanId, opts) {
    const now = opts.now ?? Date.now;
    const pending = (0, account_invite_repo_js_1.pendingInviteRequests)(clanId);
    if (!pending.length)
        return 0;
    if (!(0, account_invite_repo_js_1.getInviteSettings)(clanId).enabled) {
        for (const r of pending)
            (0, account_invite_repo_js_1.setRequestStatus)(r.id, 'ignored', 'disabled');
        return 0;
    }
    let sent = 0;
    for (const req of pending) {
        const nowMs = now();
        if (nowMs - req.requestedAt > exports.MAX_REQUEST_AGE_MS) {
            (0, account_invite_repo_js_1.setRequestStatus)(req.id, 'ignored', 'too-old');
            continue;
        }
        const blocker = inviteRequestBlocker(clanId, opts.scannerChatId, req, nowMs, req.id);
        if (blocker) {
            (0, account_invite_repo_js_1.setRequestStatus)(req.id, 'ignored', blocker);
            noteBlocked(clanId, req.playerId, req.senderChatId, blocker);
            continue;
        }
        const channel = channelFor(clanId, req.channelUrl);
        let token;
        try {
            token = await opts.chatToken();
        }
        catch (err) {
            quietWarner.warn(`token:${clanId}`, `Clan #${clanId}: no chat token for account-invite replies yet (the next scan answers): ${String(err)}`);
            return sent;
        }
        if (!token)
            return sent;
        const reserved = (0, account_invite_repo_js_1.reserveInviteSend)(req.id, now());
        if (!reserved)
            continue;
        const outcome = await (0, chat_send_js_1.sendInviteMessage)({ userId: opts.scannerChatId, token, channel, recipientUserId: req.senderChatId, text: inviteReplyText(reserved.code, siteNameFor(clanId)) }, opts.send);
        (0, account_invite_repo_js_1.finishInviteSend)(req.id, reserved.codeId, outcome);
        if (outcome.status === 'sent') {
            sent++;
            log.info(`Clan #${clanId}: account-invite code sent to player ${req.playerId} (message ${outcome.messageId})`);
        }
        else if (outcome.status === 'refused') {
            quietWarner.warn(`refused:${clanId}`, `Clan #${clanId}: an account-invite reply was refused (${outcome.error}); it is tried again`);
        }
        else {
            quietWarner.warn(`unknown:${clanId}`, `Clan #${clanId}: an account-invite reply may or may not have gone out (${outcome.error}) — it is not resent`);
        }
    }
    return sent;
}
const inFlight = new Set();
/**
 * Detect new keyword DMs and answer them. Called after every chat read (the
 * minute poller and each scan). Never throws; one run per clan at a time.
 */
async function processInviteRequests(clanId, opts) {
    if (inFlight.has(clanId))
        return '';
    inFlight.add(clanId);
    try {
        const found = detectInviteRequests(clanId, opts.scannerChatId, (opts.now ?? Date.now)());
        const sent = await answerInviteRequests(clanId, opts);
        return found || sent ? `account invites: ${found} new request(s), ${sent} code(s) sent` : '';
    }
    catch (err) {
        log.warn({ noAlert: true }, `Clan #${clanId}: account invites failed (nothing else is affected): ${String(err)}`);
        return '';
    }
    finally {
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
exports.WELCOME_GAP_MS = [2_000, 4_000];
/** Anything a chat filter could read as a link: a scheme, www, or name.tld with no spaces. */
exports.LINK_LIKE = /https?:|www|[a-z0-9-]\.[a-z]{2,}/i;
/**
 * The welcome message: the code, where to enter it, how long it lasts, and
 * how to get a fresh one. No link — and the clan's name is left out if it
 * looks like one.
 */
function welcomeText(code, clanName, site) {
    const tail = `Your TB Chest Counter code: ${(0, account_invite_repo_js_1.formatCode)(code)}. ${whereToGo(site)} within ${Math.round(account_invite_repo_js_1.CODE_TTL_MS / 3600_000)} hours. It works once. Reply "code" any time for a fresh one.`;
    const name = clanName.trim();
    const full = name && !exports.LINK_LIKE.test(name) ? `Welcome to ${name}! ${tail}` : `Welcome! ${tail}`;
    return full.length <= 300 ? full : `Welcome! ${tail}`;
}
/**
 * The new member's chat account: the one their own stored chat lines come
 * from (exactly one), else the clan chat member whose memberInfo names their
 * player id AND whose name is their roster name (exactly one). Null when
 * neither is certain.
 */
function findChatAccount(clanId, playerId, name, members) {
    const own = (0, database_js_1.getDb)().prepare("SELECT DISTINCT sender_id FROM chat_messages WHERE clan_id = ? AND sender_player_id = ? AND custom_type = 'user' AND sender_id <> ''").all(clanId, playerId).map((r) => r.sender_id);
    if (own.length === 1)
        return own[0];
    if (own.length > 1)
        return null;
    const want = name.trim().toLowerCase();
    const matches = (members ?? []).filter((m) => m.userId && (0, chat_text_js_1.chatSenderPlayerId)(m.memberInfo) === playerId && m.nickname.trim().toLowerCase() === want);
    return matches.length === 1 ? matches[0].userId : null;
}
/**
 * After a scan: send (or, in dry-run, note) the welcome codes due. Never
 * throws. Returns a note for the scan log ('' when nothing happened).
 */
async function sendWelcomeCodes(clanId, opts) {
    try {
        return await runWelcome(clanId, opts);
    }
    catch (err) {
        log.warn({ noAlert: true }, `Clan #${clanId}: welcome codes failed (nothing else is affected): ${String(err)}`);
        return '';
    }
}
async function runWelcome(clanId, opts) {
    const now = opts.now ?? Date.now;
    const settings = (0, account_invite_repo_js_1.getInviteSettings)(clanId);
    if (settings.welcomeMode === 'off' || settings.welcomeEnabledAt === null)
        return '';
    const live = settings.welcomeMode === 'on';
    // The backlog (every current member without an account) only once switched
    // on for real; a dry run previews the joins.
    const candidates = (0, account_invite_repo_js_1.welcomeCandidates)(clanId, settings.welcomeEnabledAt, {
        backlog: live && settings.welcomeBacklogAt !== null, live, limit: account_invite_repo_js_1.WELCOME_SENDS_PER_SCAN,
    });
    if (!candidates.length)
        return '';
    if (settings.welcomeMode === 'dry-run') {
        for (const c of candidates) {
            (0, account_invite_repo_js_1.setWelcomeStatus)(clanId, c, 'dry-run', null);
            log.info(`Clan #${clanId}: welcome code DRY RUN — would send one to ${c.name} (player ${c.playerId}, joined ${new Date(c.joinedAt * 1000).toISOString()})`);
        }
        return `welcome codes: ${candidates.length} dry run`;
    }
    if ((0, chat_send_js_1.chatSendingDisabled)() || !opts.chatSession || !opts.scannerChatId)
        return '';
    const session = opts.chatSession;
    const chatApi = opts.chatApi ?? { listMembers: chat_js_1.listChannelMembers, openPrivateChat: chat_js_1.openPrivateChat };
    const clan = (0, clan_repo_js_1.getClanById)(clanId);
    if (!clan)
        return '';
    let members = null;
    let membersRead = false;
    let sent = 0;
    let attempted = false;
    const pause = opts.pause ?? (() => (0, request_gap_js_1.requestGap)(exports.WELCOME_GAP_MS[0], exports.WELCOME_GAP_MS[1]));
    for (const c of candidates) {
        // A pause between sends: the scanner account never bursts messages.
        if (attempted)
            await pause();
        // Switched off meanwhile (a backlog in progress): stop where it is.
        if ((0, account_invite_repo_js_1.getInviteSettings)(clanId).welcomeMode !== 'on')
            break;
        const nowMs = now();
        // A join waits a day for its chat account to show up; a backlog member a
        // day from when the backlog started.
        const waitedOut = nowMs - Math.max(c.joinedAt * 1000, settings.welcomeBacklogAt ?? 0) > account_invite_repo_js_1.WELCOME_WAIT_MS;
        if (!membersRead && !hasOwnChatLines(clanId, c.playerId)) {
            membersRead = true;
            const channel = (0, chat_repo_js_1.clanChatChannels)(clanId)[0];
            try {
                members = channel ? await chatApi.listMembers(session, channel) : null;
            }
            catch (err) {
                quietWarner.warn(`members:${clanId}`, `Clan #${clanId}: could not read the clan chat's members for welcome codes: ${String(err)}`);
            }
        }
        const chatId = findChatAccount(clanId, c.playerId, c.name, members);
        if (!chatId) {
            (0, account_invite_repo_js_1.setWelcomeStatus)(clanId, c, waitedOut ? 'skipped' : 'waiting', 'no-chat-account');
            continue;
        }
        if (chatAccountMismatch(c.playerId, chatId)) {
            (0, account_invite_repo_js_1.setWelcomeStatus)(clanId, c, 'skipped', 'chat-account-mismatch', { chatUserId: chatId });
            noteBlocked(clanId, c.playerId, chatId, 'chat-account-mismatch');
            continue;
        }
        if ((0, account_invite_repo_js_1.playerInCooldown)(c.playerId, nowMs) || (0, account_invite_repo_js_1.playerHasOpenRequest)(c.playerId)) {
            // They asked for a code themselves: that one is theirs.
            (0, account_invite_repo_js_1.setWelcomeStatus)(clanId, c, 'skipped', 'asked-themselves', { chatUserId: chatId });
            continue;
        }
        let channel;
        try {
            channel = await chatApi.openPrivateChat(session, chatId);
        }
        catch (err) {
            (0, account_invite_repo_js_1.setWelcomeStatus)(clanId, c, c.attempts + 1 >= 3 || waitedOut ? 'skipped' : 'waiting', 'open-chat-failed', { chatUserId: chatId, countAttempt: true });
            quietWarner.warn(`open:${clanId}`, `Clan #${clanId}: could not open a private chat for a welcome code: ${String(err)}`);
            continue;
        }
        try {
            (0, chat_send_js_1.assertInviteChannel)(channel, opts.scannerChatId, chatId);
        }
        catch (err) {
            // Never send into a chat that isn't exactly the scanner and that player.
            (0, account_invite_repo_js_1.setWelcomeStatus)(clanId, c, 'skipped', 'channel', { chatUserId: chatId, channelUrl: channel.url });
            alertWarner.warn(`channel:${clanId}`, `Clan #${clanId}: the private chat opened for a welcome code was not a 1:1 chat with that player — nothing sent (${err.message})`);
            continue;
        }
        let token;
        try {
            token = await opts.chatToken();
        }
        catch (err) {
            quietWarner.warn(`token:${clanId}`, `Clan #${clanId}: no chat token for welcome codes (the next scan tries again): ${String(err)}`);
            break;
        }
        if (!token)
            break;
        const reserved = (0, account_invite_repo_js_1.reserveWelcomeSend)(clanId, c, chatId, channel.url, now());
        if (!reserved)
            continue;
        attempted = true;
        const outcome = await (0, chat_send_js_1.sendInviteMessage)({ userId: opts.scannerChatId, token, channel, recipientUserId: chatId, text: welcomeText(reserved.code, clan.name, siteNameFor(clanId)) }, opts.send);
        (0, account_invite_repo_js_1.finishWelcomeSend)(clanId, c, reserved.codeId, outcome);
        if (outcome.status === 'sent') {
            sent++;
            log.info(`Clan #${clanId}: welcome code sent to ${c.name} (player ${c.playerId}, message ${outcome.messageId})`);
        }
        else if (outcome.status === 'unknown') {
            quietWarner.warn(`wunknown:${clanId}`, `Clan #${clanId}: a welcome code may or may not have gone out (${outcome.error}) — it is not resent`);
        }
        else {
            quietWarner.warn(`wrefused:${clanId}`, `Clan #${clanId}: a welcome code was refused (${outcome.error}); it is tried again`);
        }
    }
    return sent ? `welcome codes: ${sent} sent` : '';
}
function hasOwnChatLines(clanId, playerId) {
    return !!(0, database_js_1.getDb)().prepare("SELECT 1 FROM chat_messages WHERE clan_id = ? AND sender_player_id = ? AND custom_type = 'user' AND sender_id <> '' LIMIT 1")
        .get(clanId, playerId);
}
//# sourceMappingURL=chat-invites.js.map