"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInactivityRouter = createInactivityRouter;
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const user_repo_js_1 = require("../../../data/repositories/user-repo.js");
const auth_js_1 = require("../../middleware/auth.js");
const _shared_js_1 = require("./_shared.js");
function createInactivityRouter() {
    const router = (0, _shared_js_1.createClanSubRouter)();
    /** Set this clan's member-inactivity-sweep settings. `enabled` toggles the
     *  sweep on/off; `inactivityDays` is the threshold (days a member can go
     *  unseen before being soft-removed) — null/'' inherits the global
     *  MEMBER_INACTIVITY_DAYS default, a positive integer is a custom cutoff.
     *  Clan-admin only. */
    router.put('/:clanId/inactivity', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const enabled = !!req.body?.enabled;
        const raw = req.body?.inactivityDays;
        const days = raw === null || raw === undefined || raw === '' ? null : Number(raw);
        if (days !== null && (!Number.isInteger(days) || days < 1)) {
            res.status(400).json({ error: 'inactivityDays must be blank or a positive whole number' });
            return;
        }
        (0, clan_repo_js_1.setClanInactivitySettings)(id, { enabled, days });
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.inactivity.update', { clanId: id, enabled, inactivityDays: days });
        res.json({ ok: true, enabled, inactivityDays: days });
    });
    return router;
}
//# sourceMappingURL=inactivity.js.map