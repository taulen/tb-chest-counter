"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSeasonalKingdomRouter = createSeasonalKingdomRouter;
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const user_repo_js_1 = require("../../../data/repositories/user-repo.js");
const auth_js_1 = require("../../middleware/auth.js");
const _shared_js_1 = require("./_shared.js");
function createSeasonalKingdomRouter() {
    const router = (0, _shared_js_1.createClanSubRouter)();
    /**
     * Mark the clan as playing a Seasonal Kingdom (or not). An SK clan's event
     * windows come from the SK calendar (docs/seasonal-kingdoms.md); turning it
     * on also moves the clan off Tinman weeks, and the response carries the week
     * shape it ended up with so the page can follow. Clan-admin only, like every
     * /api/clans config route.
     */
    router.put('/:clanId/seasonal-kingdom', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        const clan = (0, clan_repo_js_1.getClanById)(id);
        if (!clan) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const enabled = req.body?.enabled;
        if (typeof enabled !== 'boolean') {
            res.status(400).json({ error: 'enabled must be true or false' });
            return;
        }
        const weekStart = (0, clan_repo_js_1.setClanSeasonalKingdom)(id, enabled);
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.seasonal_kingdom.update', {
            clanId: id,
            enabled,
            ...(weekStart !== clan.weekStart ? { weekStart } : {}),
        });
        res.json({ ok: true, seasonalKingdom: enabled, weekStart });
    });
    return router;
}
//# sourceMappingURL=seasonal-kingdom.js.map