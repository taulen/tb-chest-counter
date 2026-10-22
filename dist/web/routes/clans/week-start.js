"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWeekStartRouter = createWeekStartRouter;
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const user_repo_js_1 = require("../../../data/repositories/user-repo.js");
const game_day_js_1 = require("../../../utils/game-day.js");
const auth_js_1 = require("../../middleware/auth.js");
const _shared_js_1 = require("./_shared.js");
function createWeekStartRouter() {
    const router = (0, _shared_js_1.createClanSubRouter)();
    /**
     * Set how this clan cuts its week: 'sunday' (Sunday → Sunday) or 'ancients'
     * (Tinman to Tinman, 6 days). Every Weekly view the clan sees follows it.
     * Clan-admin only, per the same ownership rule every /api/clans config route
     * follows.
     */
    router.put('/:clanId/week-start', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const weekStart = req.body?.weekStart;
        if (!(0, game_day_js_1.isWeekStart)(weekStart)) {
            res.status(400).json({ error: `weekStart must be one of: ${game_day_js_1.WEEK_STARTS.join(', ')}` });
            return;
        }
        (0, clan_repo_js_1.setClanWeekStart)(id, weekStart);
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.week_start.update', { clanId: id, weekStart });
        res.json({ ok: true, weekStart });
    });
    return router;
}
//# sourceMappingURL=week-start.js.map