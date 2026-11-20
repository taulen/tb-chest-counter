"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPerformanceRouter = createPerformanceRouter;
/**
 * The Performance page (admins only): every active member scored against the
 * clan's weekly goal, their Tin Man target and event participation, over a
 * timeframe. See data/performance.ts; the scoring tunables are in
 * config/performance-scoring.ts.
 *
 * Mounted at /api/performance behind requireAuth + requireClanContext, so
 * `req.clanId` is the caller's active clan — and admin of THAT clan is what
 * requireAdmin checks, since req.user.role is the active clan's role.
 */
const express_1 = require("express");
const clan_repo_js_1 = require("../../data/repositories/clan-repo.js");
const performance_js_1 = require("../../data/performance.js");
const performance_scoring_js_1 = require("../../config/performance-scoring.js");
const index_js_1 = require("../../config/index.js");
const auth_js_1 = require("../middleware/auth.js");
const leaderboard_handler_js_1 = require("./leaderboard-handler.js");
function createPerformanceRouter() {
    const router = (0, express_1.Router)();
    router.get('/', auth_js_1.requireAdmin, async (req, res, next) => {
        try {
            const clanId = req.clanId;
            const clan = (0, clan_repo_js_1.getClanById)(clanId);
            if (!clan) {
                res.status(404).json({ error: 'Clan not found' });
                return;
            }
            const config = (0, performance_scoring_js_1.resolvePerformanceConfig)(clanId);
            const raw = typeof req.query.timeframe === 'string' ? req.query.timeframe : '';
            const timeframe = config.timeframes.some((t) => t.key === raw) ? raw : config.defaultTimeframe;
            const report = await (0, performance_js_1.getPerformanceReport)({
                clanId,
                timeframe,
                weeklyGoal: (0, leaderboard_handler_js_1.resolveWeeklyGoalPoints)(clan),
                weekStart: clan.weekStart,
                rolloverUtcHour: (0, index_js_1.loadConfig)().gameDayRolloverUtcHour,
            });
            res.json(report);
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=performance.js.map