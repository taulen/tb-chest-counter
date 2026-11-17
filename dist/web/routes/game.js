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
const member_tiers_js_1 = require("../../data/member-tiers.js");
const tech_trees_js_1 = require("../../game-protocol/tech-trees.js");
const index_js_1 = require("../../game-art/index.js");
/**
 * The trees with each tree's and node's sprite as a URL (the game's own icon
 * from the art pipeline), memoised per trees + art version.
 */
let withIconsMemo = null;
function treesWithIcons(trees) {
    const art = (0, index_js_1.currentGameArt)();
    const key = `${trees.version}|${art?.version ?? ''}`;
    if (withIconsMemo?.key === key)
        return withIconsMemo.value;
    const techIcons = art?.mappings?.techs ?? {};
    const value = {
        ...trees,
        trees: trees.trees.map((tr) => ({
            ...tr,
            iconUrl: tr.icon ? (0, index_js_1.gameArtUrl)(tr.icon) : null,
            nodes: tr.nodes.map((n) => {
                const name = techIcons[String(n.techId)] ?? n.icon;
                return { ...n, iconUrl: name ? (0, index_js_1.gameArtUrl)(name) : null };
            }),
        })),
    };
    withIconsMemo = { key, value };
    return value;
}
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
            // G/S/E/M tiers and crypt level from the member's research (null until read).
            tiers: (0, member_tiers_js_1.getMemberTiers)(clanId).get(memberId) ?? null,
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
        const tiers = (0, member_tiers_js_1.getMemberTiers)(clanId);
        const out = {};
        for (const [memberId, p] of (0, game_profile_repo_js_1.getGamePlayersByMember)(clanId)) {
            out[memberId] = {
                heroAvatar: p.heroAvatar, avatarUrl: p.avatarUrl, heroLevel: p.heroLevel, role: p.role, goldPass: p.goldPass, vip: p.vip, cityLevel: p.cityLevel,
                tiers: tiers.get(memberId)?.tiers ?? null,
            };
        }
        res.json({ members: out });
    });
    /**
     * The game's research and talent trees (names, layout, prerequisites), for
     * drawing a member's levels. The same for every clan; the client caches it by
     * `version`.
     */
    router.get('/tech-trees', async (_req, res) => {
        try {
            res.json(treesWithIcons(await (0, tech_trees_js_1.loadTechTrees)()));
        }
        catch {
            res.status(503).json({ error: 'Research trees are not available yet' });
        }
    });
    return router;
}
//# sourceMappingURL=game.js.map