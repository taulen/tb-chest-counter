"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGameRouter = createGameRouter;
/**
 * Read API for what the game protocol collects about players: the profile
 * header (role, joined, city level, VIP, Gold Pass, hero), research and hero
 * talents with their change history, and per-member hero avatars for lists.
 *
 * Mounted at /api/game behind requireAuth + requireClanContext, so `req.clanId`
 * is the caller's active clan and every query is scoped to it. A member that is
 * not linked to a game player yet answers `{ linked: false }`, not an error.
 */
const express_1 = require("express");
const member_repo_js_1 = require("../../data/repositories/member-repo.js");
const game_profile_repo_js_1 = require("../../data/repositories/game-profile-repo.js");
const CHANGES_DAYS = 90;
function createGameRouter() {
    const router = (0, express_1.Router)();
    /** Profile header data for one member. */
    router.get('/members/:memberId', (req, res) => {
        const clanId = req.clanId;
        const memberId = Number.parseInt(String(req.params.memberId), 10);
        if (!Number.isFinite(memberId) || !(0, member_repo_js_1.getMemberById)(memberId, clanId)) {
            res.status(404).json({ error: 'Member not found' });
            return;
        }
        const playerId = (0, game_profile_repo_js_1.gamePlayerIdForMember)(memberId, clanId);
        if (playerId === null) {
            res.json({ linked: false });
            return;
        }
        res.json({
            linked: true,
            player: (0, game_profile_repo_js_1.getGamePlayer)(clanId, playerId),
            city: (0, game_profile_repo_js_1.getLatestCity)(clanId, playerId),
        });
    });
    /** Research + hero talent levels for one member, and their recent changes. */
    router.get('/members/:memberId/techs', (req, res) => {
        const clanId = req.clanId;
        const memberId = Number.parseInt(String(req.params.memberId), 10);
        if (!Number.isFinite(memberId) || !(0, member_repo_js_1.getMemberById)(memberId, clanId)) {
            res.status(404).json({ error: 'Member not found' });
            return;
        }
        const playerId = (0, game_profile_repo_js_1.gamePlayerIdForMember)(memberId, clanId);
        if (playerId === null) {
            res.json({ linked: false, levels: {}, readAt: null, changes: [] });
            return;
        }
        const { levels, readAt } = (0, game_profile_repo_js_1.getPlayerTechs)(clanId, playerId);
        const since = new Date(Date.now() - CHANGES_DAYS * 86_400_000).toISOString();
        res.json({ linked: true, levels, readAt, changes: (0, game_profile_repo_js_1.getPlayerTechChanges)(clanId, playerId, since) });
    });
    /** memberId → hero avatar id and a few headline game facts, for avatars in lists. */
    router.get('/roster', (req, res) => {
        const clanId = req.clanId;
        const out = {};
        for (const [memberId, p] of (0, game_profile_repo_js_1.getGamePlayersByMember)(clanId)) {
            out[memberId] = { heroAvatar: p.heroAvatar, heroLevel: p.heroLevel, role: p.role, goldPass: p.goldPass, vip: p.vip, cityLevel: p.cityLevel };
        }
        res.json({ members: out });
    });
    return router;
}
//# sourceMappingURL=game.js.map