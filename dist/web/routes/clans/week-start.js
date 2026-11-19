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
     * Set how this clan cuts its week: 'sunday' (Sunday → Sunday), 'ancients'
     * (Tinman to Tinman, 6 days), in a Seasonal Kingdom 'ancients-sk' (Tinman to
     * Tinman on the SK cadence), or its own 'custom:<YYYY-MM-DD>:<days>' — the
     * first day of any one of its weeks and how long each lasts. Every Weekly
     * view the clan sees follows it. A custom week identical to a preset is
     * stored as the preset; the response carries what was stored. Clan-admin
     * only, per the same ownership rule every /api/clans config route follows.
     */
    router.put('/:clanId/week-start', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        const clan = (0, clan_repo_js_1.getClanById)(id);
        if (!clan) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const requested = req.body?.weekStart;
        if (!(0, game_day_js_1.isWeekStart)(requested)) {
            res.status(400).json({
                error: `weekStart must be one of: ${game_day_js_1.WEEK_PRESETS.join(', ')}, or custom:<YYYY-MM-DD>:<days> `
                    + `(a day a week starts on, and ${game_day_js_1.CUSTOM_WEEK_MIN_DAYS}–${game_day_js_1.CUSTOM_WEEK_MAX_DAYS} days)`,
            });
            return;
        }
        const weekStart = (0, game_day_js_1.canonicalWeekStart)(requested, clan.seasonalKingdom);
        // Each kingdom cuts Tinman weeks on its own Ancients cadence.
        if (!(0, clan_repo_js_1.weekStartAllowed)(clan, weekStart)) {
            res.status(400).json({
                error: clan.seasonalKingdom
                    ? 'This clan plays a Seasonal Kingdom: its Tinman weeks are ancients-sk.'
                    : 'ancients-sk is for Seasonal Kingdom clans: use ancients for Tinman weeks.',
            });
            return;
        }
        (0, clan_repo_js_1.setClanWeekStart)(id, weekStart);
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.week_start.update', { clanId: id, weekStart });
        res.json({ ok: true, weekStart });
    });
    return router;
}
//# sourceMappingURL=week-start.js.map