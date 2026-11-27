"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBattleReportsRouter = createBattleReportsRouter;
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const chat_digest_repo_js_1 = require("../../../data/repositories/chat-digest-repo.js");
const battle_report_repo_js_1 = require("../../../data/repositories/battle-report-repo.js");
const user_repo_js_1 = require("../../../data/repositories/user-repo.js");
const auth_js_1 = require("../../middleware/auth.js");
const _shared_js_1 = require("./_shared.js");
/**
 * Battle reports shared in chat (docs/battle-reports.md): the clan chat and
 * private messages to the scanner account are always read; an admin adds up to
 * MAX_REPORT_CHATS of the account's group chats, each read for battle reports
 * (a "Tin Man hits" or "citadels" chat) or for vaults (where members link the
 * vault they raised — Events → Ancients → Vaults matches them to the map; v144).
 * Clan admins only. Nothing here sends anything in the game.
 */
function createBattleReportsRouter() {
    const router = (0, _shared_js_1.createClanSubRouter)();
    router.get('/:clanId/battle-reports', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const groups = (0, chat_digest_repo_js_1.getPostableChannels)(id);
        const picked = (0, battle_report_repo_js_1.getReportChats)(id);
        const pickedUrls = new Set(picked.map((c) => c.url));
        const purposeOf = new Map(picked.map((p) => [p.url, p.purpose]));
        res.json({
            // The account's group chats, picked (with what for) or not, then picked chats it has left.
            chats: [
                ...groups.map((c) => ({
                    url: c.url, name: c.name, memberCount: c.memberCount, picked: pickedUrls.has(c.url), purpose: purposeOf.get(c.url) ?? null, member: true,
                })),
                ...picked.filter((p) => !groups.some((g) => g.url === p.url))
                    .map((p) => ({ url: p.url, name: p.name, memberCount: 0, picked: true, purpose: p.purpose, member: false })),
            ],
            maxChats: battle_report_repo_js_1.MAX_REPORT_CHATS,
            reports: (0, battle_report_repo_js_1.reportCounts)(id),
        });
    });
    router.put('/:clanId/battle-reports', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const body = req.body ?? {};
        if (body.chats !== undefined) {
            // [{ url, purpose }] — or plain urls, read for battle reports.
            const asked = Array.isArray(body.chats)
                ? body.chats.map((c) => (typeof c === 'string' ? { url: c, purpose: 'reports' }
                    : c && typeof c === 'object' && typeof c.url === 'string'
                        ? { url: c.url, purpose: c.purpose }
                        : null))
                : null;
            if (!asked || asked.some((c) => c === null || !battle_report_repo_js_1.CHAT_PURPOSES.includes(c.purpose))) {
                res.status(400).json({ error: `chats must be a list of { url, purpose: ${battle_report_repo_js_1.CHAT_PURPOSES.join(' | ')} }` });
                return;
            }
            const purposes = new Map(asked.map((c) => [c.url, c.purpose]));
            const urls = [...purposes.keys()];
            if (urls.length > battle_report_repo_js_1.MAX_REPORT_CHATS) {
                res.status(400).json({ error: `At most ${battle_report_repo_js_1.MAX_REPORT_CHATS} chats` });
                return;
            }
            // A chat must be one of the account's group chats — or one already picked
            // (it may have left it; unticking must still work).
            const groups = (0, chat_digest_repo_js_1.getPostableChannels)(id);
            const current = (0, battle_report_repo_js_1.getReportChats)(id);
            const chosen = [];
            for (const url of urls) {
                const c = groups.find((g) => g.url === url) ?? current.find((p) => p.url === url);
                if (!c) {
                    res.status(400).json({ error: 'Pick one of the group chats the scanner account is in' });
                    return;
                }
                chosen.push({ url: c.url, name: c.name, purpose: purposes.get(url) });
            }
            const saved = (0, battle_report_repo_js_1.setReportChats)(id, chosen);
            (0, user_repo_js_1.logAction)(req.user.id, 'clan.battle_report_chats.update', { clanId: id, chats: saved.map((c) => `${c.name} (${c.purpose})`) });
        }
        res.json({ ok: true, chats: (0, battle_report_repo_js_1.getReportChats)(id) });
    });
    return router;
}
//# sourceMappingURL=battle-reports.js.map