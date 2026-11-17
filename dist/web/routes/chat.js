"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetChatNamesCache = resetChatNamesCache;
exports.createChatRouter = createChatRouter;
/**
 * /api/chat — the stored in-game chat for the Chats page.
 *
 * Only the CLAN chat (the clan's `clanGroup` channel) is served, to any
 * signed-in member of the active clan. Private messages (whisper channels) are
 * collected too but are never reachable through this router: every query is
 * pinned to clanChatChannels(clanId), which only ever lists clanGroup channels
 * of the caller's own clan.
 *
 * The history is what we stored, not what the game still serves — see
 * chat-repo.ts: lines the game no longer returns stay readable here.
 */
const express_1 = require("express");
const database_js_1 = require("../../data/database.js");
const chat_repo_js_1 = require("../../data/repositories/chat-repo.js");
const game_profile_repo_js_1 = require("../../data/repositories/game-profile-repo.js");
const chat_text_js_1 = require("../../game-protocol/chat-text.js");
const static_data_js_1 = require("../../game-protocol/static-data.js");
const translate_js_1 = require("../../external/translate.js");
const logger_js_1 = require("../../utils/logger.js");
const log_throttle_js_1 = require("../../utils/log-throttle.js");
const log = (0, logger_js_1.childLogger)('chat');
/** A refused or failed translation: informational, at most once an hour. */
const translateWarner = (0, log_throttle_js_1.createCoalescedWarner)((m) => log.warn({ noAlert: true }, m), 60 * 60_000);
/** The site's languages: what a Translate click may ask for. */
const SITE_LANGUAGES = new Set(['en', 'es', 'fr', 'ru', 'de']);
/** The game's map-object and terrain names, refreshed at most every 10 minutes (the page polls). */
let namesCache = { at: 0, names: null };
async function chatNames() {
    if (Date.now() - namesCache.at > 10 * 60_000) {
        namesCache = { at: Date.now(), names: await (0, static_data_js_1.loadGameNames)().catch(() => namesCache.names) };
    }
    return { objects: namesCache.names?.objects ?? {}, terrains: namesCache.names?.terrains ?? {} };
}
/** Test seam. */
function resetChatNamesCache(names = null) {
    namesCache = { at: names ? Date.now() : 0, names };
}
function cursor(v) {
    const m = /^(\d{1,15}):(\d{1,20})$/.exec(String(v ?? ''));
    return m ? { at: Number(m[1]), id: Number(m[2]) } : null;
}
function positiveInt(v) {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}
/** staticIds a sub refers to (a map object, a raid target, a sabotage squad), for name lookup. */
function subStaticIds(sub) {
    const ids = [];
    for (const k of ['staticId', 'targetStaticId', 'staticAtomId']) {
        const v = sub[k];
        if (typeof v === 'number' && v > 0)
            ids.push(v);
    }
    return ids;
}
function parseTranslations(json) {
    if (!json)
        return null;
    try {
        const t = JSON.parse(json);
        return t && typeof t === 'object' && !Array.isArray(t) ? t : null;
    }
    catch {
        return null;
    }
}
function toApi(m) {
    return {
        key: `${m.createdAt}:${m.messageId}`,
        at: m.createdAt,
        kind: m.customType === 'service' ? 'service' : 'user',
        sender: {
            name: m.senderName,
            playerId: m.senderPlayerId,
            // The game's clan rank and tag when the message was sent.
            rank: (0, chat_text_js_1.chatSenderRank)(m.senderInfo),
            tag: (0, chat_text_js_1.chatSenderTag)(m.senderInfo),
        },
        text: m.message,
        subs: (0, chat_text_js_1.parseChatSubs)(m.data),
        translations: parseTranslations(m.translations),
        edited: m.previousMessage !== null,
        previousText: m.previousMessage,
    };
}
function people(clanId, playerIds) {
    const out = {};
    const ids = [...new Set(playerIds)];
    if (!ids.length)
        return out;
    const db = (0, database_js_1.getDb)();
    const ph = ids.map(() => '?').join(',');
    for (const id of ids)
        out[id] = { memberId: null, avatarUrl: null, frameUrl: null, heroLevel: null, role: null };
    const players = db.prepare(`SELECT player_id, hero_avatar, avatar_frame, hero_level, role FROM game_players WHERE clan_id = ? AND player_id IN (${ph})`)
        .all(clanId, ...ids);
    for (const p of players)
        Object.assign(out[p.player_id], {
            // The portrait the game draws: hero art in the player's own frame, with the hero level.
            avatarUrl: (0, game_profile_repo_js_1.heroAvatarUrl)(p.hero_avatar), frameUrl: (0, game_profile_repo_js_1.avatarFrameUrl)(p.avatar_frame), heroLevel: p.hero_level, role: p.role,
        });
    const members = db.prepare(`SELECT id, game_player_id FROM members WHERE clan_id = ? AND game_player_id IN (${ph})`)
        .all(clanId, ...ids);
    for (const m of members)
        out[m.game_player_id].memberId = m.id;
    return out;
}
function createChatRouter() {
    const router = (0, express_1.Router)();
    /**
     * One page of the clan chat. Newest first; `before=<at>:<messageId>` pages
     * back, `after=<at>:<messageId>` reads the newer side (oldest first — the
     * live poll and "load newer"). `q` searches (every word, prefix), `sender`
     * is a game player id, `from` / `to` bound the time (ms, to exclusive).
     */
    router.get('/clan', async (req, res) => {
        const clanId = req.clanId;
        const channels = (0, chat_repo_js_1.clanChatChannels)(clanId);
        const limit = Math.min(positiveInt(req.query.limit) ?? 100, 200);
        const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
        const senderPlayerId = positiveInt(req.query.sender);
        const before = cursor(req.query.before);
        const after = cursor(req.query.after);
        const rows = (0, chat_repo_js_1.readChatPage)(clanId, channels, {
            before, after, q, senderPlayerId,
            fromMs: positiveInt(req.query.from),
            toMs: positiveInt(req.query.to),
            limit,
        });
        const messages = rows.map(toApi);
        res.json({
            ...(await pageExtras(clanId, channels, messages)),
            messages,
            hasMore: rows.length === limit,
            // A search / writer filter's size over the WHOLE stored history, on its first page.
            matches: (q || senderPlayerId) && !before && !after ? (0, chat_repo_js_1.countChatMatches)(clanId, channels, q, senderPlayerId) : null,
        });
    });
    /**
     * The conversation at one message (`around=<at>:<messageId>`, a search hit)
     * or at a time (`at=<ms>`: the first message at or after it — a date jump):
     * up to 50 messages either side, oldest first, unfiltered. `focus` is the
     * message it opened at.
     */
    router.get('/clan/context', async (req, res) => {
        const clanId = req.clanId;
        const channels = (0, chat_repo_js_1.clanChatChannels)(clanId);
        const atMs = positiveInt(req.query.at);
        const anchor = cursor(req.query.around) ?? (atMs ? (0, chat_repo_js_1.chatAnchorAt)(clanId, channels, atMs) : null);
        if (!anchor) {
            res.json({ ...(await pageExtras(clanId, channels, [])), messages: [], hasOlder: false, hasNewer: false, focus: null });
            return;
        }
        const around = (0, chat_repo_js_1.readChatAround)(clanId, channels, anchor, 50);
        const messages = around.messages.map(toApi);
        const focus = messages.find((m) => m.at === anchor.at && m.key.endsWith(`:${anchor.id}`))?.key ?? null;
        res.json({
            ...(await pageExtras(clanId, channels, messages)),
            messages,
            hasOlder: around.hasOlder,
            hasNewer: around.hasNewer,
            focus,
        });
    });
    /** What every page of messages carries: senders, object and terrain names, the history's extent. */
    async function pageExtras(clanId, channels, messages) {
        const objects = {};
        // A shared map TILE's staticId is a terrain type (T4: "Dense forest"), not a
        // map object — the two id spaces overlap (2 = Grasslands / Player's City).
        const terrains = {};
        const names = await chatNames();
        for (const m of messages) {
            for (const sub of Object.values(m.subs)) {
                if (sub.type === 'coord' && sub.entryType === 'tile') {
                    const id = sub.staticId;
                    if (typeof id === 'number' && names.terrains[id])
                        terrains[id] = names.terrains[id];
                    continue;
                }
                for (const id of subStaticIds(sub))
                    if (names.objects[id])
                        objects[id] = names.objects[id];
            }
        }
        return {
            available: channels.length > 0,
            history: (0, chat_repo_js_1.chatHistoryInfo)(clanId, channels),
            people: people(clanId, messages.map((m) => m.sender.playerId).filter((p) => p !== null)),
            objects,
            terrains,
        };
    }
    /**
     * One message translated into the viewer's site language — the Translate
     * button, on request only. `key` is the message's `<at>:<messageId>`; the
     * text is read from the store (clan-scoped), never taken from the request.
     * `same: true` when the message is already in that language.
     */
    router.post('/clan/translate', async (req, res) => {
        const clanId = req.clanId;
        const at = cursor(req.body?.key);
        const lang = String(req.body?.lang ?? '');
        if (!at || !SITE_LANGUAGES.has(lang)) {
            res.status(400).json({ error: 'key and a site language are required' });
            return;
        }
        const m = (0, chat_repo_js_1.readChatMessage)(clanId, (0, chat_repo_js_1.clanChatChannels)(clanId), at);
        if (!m) {
            res.status(404).json({ error: 'No such message' });
            return;
        }
        if (!/\p{L}/u.test(m.message)) {
            res.json({ from: null, text: m.message, same: true });
            return;
        }
        // The game's own translation when it stored one (free, and the game's wording).
        const game = parseTranslations(m.translations)?.[lang];
        if (game) {
            res.json({ from: null, text: game, same: game === m.message });
            return;
        }
        try {
            const tr = await (0, translate_js_1.translateChatLine)(`${m.id}:${m.updatedAt}`, m.message, lang);
            const same = tr.from === lang || tr.text.trim() === m.message.trim();
            res.json({ from: tr.from, text: tr.text, same });
        }
        catch (err) {
            if (!(err instanceof translate_js_1.TranslateUnavailableError))
                throw err;
            if (err.message.startsWith('Translation failed'))
                translateWarner.warn('translate', `Chat translation: ${err.message} — pausing translations for 5 minutes.`);
            res.status(503).json({ error: 'Translation is not available right now. Try again later.' });
        }
    });
    /** Everyone who has written in the clan chat, busiest first (the sender filter). */
    router.get('/clan/senders', (req, res) => {
        const clanId = req.clanId;
        const senders = (0, chat_repo_js_1.chatSenders)(clanId, (0, chat_repo_js_1.clanChatChannels)(clanId));
        const who = people(clanId, senders.map((s) => s.playerId));
        res.json({
            senders: senders.map((s) => ({ ...s, memberId: who[s.playerId]?.memberId ?? null })),
        });
    });
    return router;
}
//# sourceMappingURL=chat.js.map