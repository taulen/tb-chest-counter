"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createResourcesRouter = createResourcesRouter;
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const user_repo_js_1 = require("../../../data/repositories/user-repo.js");
const auth_js_1 = require("../../middleware/auth.js");
const _shared_js_1 = require("./_shared.js");
/** Per-clan resource routes, keyed on an explicit :clanId. */
function createResourcesRouter() {
    const router = (0, _shared_js_1.createClanSubRouter)();
    /** Toggle the resource tracking feature on/off for this clan.
     *  Admin/superadmin only (a clan-wide feature flag, not a per-member
     *  setting) — requireClanAdmin enforces clan ownership AND admin role. */
    router.put('/:clanId/resources', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const enabled = !!req.body?.enabled;
        (0, clan_repo_js_1.setClanResourcesEnabled)(id, enabled);
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.resources.toggle', { clanId: id, enabled });
        res.json({ ok: true, enabled });
    });
    return router;
}
//# sourceMappingURL=resources.js.map