"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLeaderboardGoalRouter = createLeaderboardGoalRouter;
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const user_repo_js_1 = require("../../../data/repositories/user-repo.js");
const auth_js_1 = require("../../middleware/auth.js");
const _shared_js_1 = require("./_shared.js");
/**
 * Upper bound on the weekly target. Not a game rule — a guard so a mistyped
 * figure can't be stored as something no member could ever approach, which
 * would paint every row red and look like the feature is broken rather than
 * like a typo. Well clear of any real clan's weekly total.
 */
const MAX_WEEKLY_GOAL_POINTS = 100_000_000;
function createLeaderboardGoalRouter() {
    const router = (0, _shared_js_1.createClanSubRouter)();
    /**
     * Set this clan's leaderboard points goal. `enabled` turns the per-row
     * green/amber/red colouring on; `weeklyPoints` is the WEEKLY target — the one
     * number every other timeframe is derived from (daily = /7, monthly = /7*30,
     * yearly = /7*365, done client-side in lib/leaderboard-render.js).
     *
     * Blank/null clears the target while leaving the flag alone, so an admin can
     * switch the colouring off and back on without retyping it. Clan-admin only,
     * per the same ownership rule every /api/clans config route follows.
     */
    router.put('/:clanId/leaderboard-goal', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const enabled = !!req.body?.enabled;
        const raw = req.body?.weeklyPoints;
        const weeklyPoints = raw === null || raw === undefined || raw === '' ? null : Number(raw);
        if (weeklyPoints !== null
            && (!Number.isInteger(weeklyPoints) || weeklyPoints < 1 || weeklyPoints > MAX_WEEKLY_GOAL_POINTS)) {
            res.status(400).json({
                error: `weeklyPoints must be blank or a whole number between 1 and ${MAX_WEEKLY_GOAL_POINTS.toLocaleString('en-US')}`,
            });
            return;
        }
        (0, clan_repo_js_1.setClanLeaderboardGoal)(id, { enabled, weeklyPoints });
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.leaderboard_goal.update', { clanId: id, enabled, weeklyPoints });
        res.json({ ok: true, enabled, weeklyPoints });
    });
    return router;
}
//# sourceMappingURL=leaderboard-goal.js.map