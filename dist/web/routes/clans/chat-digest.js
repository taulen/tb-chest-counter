"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createChatDigestRouter = createChatDigestRouter;
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const chat_digest_repo_js_1 = require("../../../data/repositories/chat-digest-repo.js");
const user_repo_js_1 = require("../../../data/repositories/user-repo.js");
const chat_send_js_1 = require("../../../game-protocol/chat-send.js");
const chat_digest_js_1 = require("../../../scheduler/chat-digest.js");
const index_js_1 = require("../../../config/index.js");
const auth_js_1 = require("../../middleware/auth.js");
const _shared_js_1 = require("./_shared.js");
/** Only named group chats the scanner account is in — never the clan, kingdom or private chats. */
function pickableChannels(clanId) {
    return (0, chat_digest_repo_js_1.getPostableChannels)(clanId).filter((c) => {
        try {
            (0, chat_send_js_1.assertPostableChannel)(c);
            return true;
        }
        catch {
            return false;
        }
    });
}
/**
 * The in-game chat digest (scheduler/chat-digest.ts): the daily digest posted
 * into one of the clan's group chats by its scanner account. Clan admins only
 * (requireClanAdmin — a plain member must not be able to make the account post).
 * Saving never posts; the test post is queued for the clan's next scan and
 * shares the one-message-a-day allowance with the scheduled post.
 */
function createChatDigestRouter() {
    const router = (0, _shared_js_1.createClanSubRouter)();
    router.get('/:clanId/chat-digest', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const settings = (0, chat_digest_repo_js_1.getChatDigestSettings)(id);
        const channels = pickableChannels(id);
        const target = (0, chat_digest_js_1.resolveTargetChannel)(settings, channels);
        res.json({
            settings,
            channels: channels.map((c) => ({ url: c.url, name: c.name, memberCount: c.memberCount })),
            // The chosen chat is one the account is in (null: not yet checked, or not a member).
            targetFound: target !== null,
            sendingDisabled: (0, chat_send_js_1.chatSendingDisabled)(),
            limits: { entriesMin: chat_digest_repo_js_1.DIGEST_ENTRIES_MIN, entriesMax: chat_digest_repo_js_1.DIGEST_ENTRIES_MAX },
            preview: (0, chat_digest_js_1.previewChatDigest)(id, (0, index_js_1.loadConfig)().gameDayRolloverUtcHour),
            recent: (0, chat_digest_repo_js_1.recentDigestPosts)(id, 7).map((p) => ({
                gameDate: p.gameDate, channelName: p.channelName, status: p.status, attempts: p.attempts,
                trigger: p.trigger, error: p.error, updatedAt: p.updatedAt,
            })),
        });
    });
    router.put('/:clanId/chat-digest', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const body = req.body ?? {};
        const current = (0, chat_digest_repo_js_1.getChatDigestSettings)(id);
        const entries = Number(body.entries ?? current.entries);
        const postUtcMinute = Number(body.postUtcMinute ?? current.postUtcMinute);
        if (!Number.isInteger(entries) || entries < chat_digest_repo_js_1.DIGEST_ENTRIES_MIN || entries > chat_digest_repo_js_1.DIGEST_ENTRIES_MAX) {
            res.status(400).json({ error: `entries must be ${chat_digest_repo_js_1.DIGEST_ENTRIES_MIN}–${chat_digest_repo_js_1.DIGEST_ENTRIES_MAX}` });
            return;
        }
        if (!Number.isInteger(postUtcMinute) || postUtcMinute < 0 || postUtcMinute > 1439) {
            res.status(400).json({ error: 'postUtcMinute must be 0–1439' });
            return;
        }
        // The chat must be one of the account's named group chats; the clan,
        // kingdom and private chats are never offered and never accepted.
        let channelUrl = current.channelUrl;
        let channelName = current.channelName;
        if (body.channelUrl !== undefined) {
            if (body.channelUrl === null || body.channelUrl === '') {
                channelUrl = null;
                channelName = '';
            }
            else {
                const chosen = pickableChannels(id).find((c) => c.url === body.channelUrl);
                if (!chosen) {
                    res.status(400).json({ error: 'Pick one of the group chats the scanner account is in' });
                    return;
                }
                channelUrl = chosen.url;
                channelName = chosen.name;
            }
        }
        const saved = (0, chat_digest_repo_js_1.saveChatDigestSettings)(id, { enabled: !!(body.enabled ?? current.enabled), channelUrl, channelName, entries, postUtcMinute });
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.chat_digest.update', { clanId: id, enabled: saved.enabled, channel: saved.channelName, entries, postUtcMinute });
        res.json({ ok: true, settings: saved });
    });
    /** Queue a test post of the latest closed day — it goes out with the clan's next scan. */
    router.post('/:clanId/chat-digest/test', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        if ((0, chat_send_js_1.chatSendingDisabled)()) {
            res.status(409).json({ error: 'Chat sending is switched off on this server (CHAT_SEND_DISABLED)' });
            return;
        }
        const settings = (0, chat_digest_repo_js_1.getChatDigestSettings)(id);
        if (!(0, chat_digest_js_1.resolveTargetChannel)(settings, pickableChannels(id))) {
            res.status(409).json({ error: 'Pick a group chat the scanner account is in first' });
            return;
        }
        const preview = (0, chat_digest_js_1.previewChatDigest)(id, (0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
        if (preview.blocked) {
            res.status(409).json({ error: `Today's message is used up: ${preview.blocked.message}`, code: preview.blocked.code });
            return;
        }
        (0, chat_digest_repo_js_1.requestTestPost)(id, req.user.id);
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.chat_digest.test', { clanId: id, gameDate: preview.gameDate });
        res.status(202).json({ ok: true, queued: true, gameDate: preview.gameDate });
    });
    return router;
}
//# sourceMappingURL=chat-digest.js.map