"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createChestTrackerRouter = createChestTrackerRouter;
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const user_repo_js_1 = require("../../../data/repositories/user-repo.js");
const auth_js_1 = require("../../middleware/auth.js");
const logger_js_1 = require("../../../utils/logger.js");
const _shared_js_1 = require("./_shared.js");
const log = (0, logger_js_1.childLogger)('clans-route');
/**
 * Per-clan ChestTracker integration. Superadmin/admin via
 * requireClanAdmin (clan ownership AND admin role — a plain member must
 * not be able to repoint or disable the clan's ingestion source). An
 * empty shareCode disables the poller for this
 * clan; switching share codes hot-reloads the per-clan poller via the
 * web server's externalLoop singleton (held in app.locals).
 */
function createChestTrackerRouter() {
    const router = (0, _shared_js_1.createClanSubRouter)();
    router.put('/:clanId/chesttracker', auth_js_1.requireClanAdmin, async (req, res) => {
        const id = req.parsedClanId;
        const existing = (0, clan_repo_js_1.getClanById)(id);
        if (!existing) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const body = req.body ?? {};
        (0, clan_repo_js_1.setClanChestTrackerSettings)(id, {
            shareCode: typeof body.shareCode === 'string' ? body.shareCode.trim() : existing.ctShareCode,
            pollIntervalHours: body.pollIntervalHours === null || body.pollIntervalHours === undefined
                ? existing.ctPollIntervalHours
                : Number(body.pollIntervalHours),
            backfillWeeks: body.backfillWeeks === null || body.backfillWeeks === undefined
                ? existing.ctBackfillWeeks
                : Number(body.backfillWeeks),
        });
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.chesttracker.update', { clanId: id });
        // Hot-reload this clan's poller. The MultiClanExternalLoop singleton
        // is held by the running web server; the easiest hook is via app
        // locals. We re-import lazily so the route module doesn't pull a
        // circular dep on the scheduler.
        try {
            const { MultiClanExternalLoop } = await import('../../../scheduler/external-loop.js');
            const loop = req.app.get('externalLoop');
            loop?.restartClan(id);
        }
        catch (err) {
            log.warn({ err, clanId: id }, 'Could not hot-reload ChestTracker poller for clan');
        }
        res.json({ ok: true });
    });
    return router;
}
//# sourceMappingURL=chesttracker.js.map