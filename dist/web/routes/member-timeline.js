"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMemberTimelineRouter = createMemberTimelineRouter;
/**
 * A member's timeline (profile → Timeline): GET /api/game/members/:memberId/timeline
 * ?before=<cursor>&groups=clan,growth,research,captains,city&limit=60.
 *
 * Clan-scoped like the rest of /api/game (any member of the clan may read).
 * The timeline is built whole from what the member's history tables hold
 * (data/member-timeline.ts) and paged by a cursor (the last entry's time +
 * key), so new entries arriving at the top never shift what "load older"
 * returns.
 */
const express_1 = require("express");
const index_js_1 = require("../../config/index.js");
const member_repo_js_1 = require("../../data/repositories/member-repo.js");
const game_profile_repo_js_1 = require("../../data/repositories/game-profile-repo.js");
const member_timeline_repo_js_1 = require("../../data/repositories/member-timeline-repo.js");
const member_timeline_js_1 = require("../../data/member-timeline.js");
const static_data_js_1 = require("../../game-protocol/static-data.js");
const tech_trees_js_1 = require("../../game-protocol/tech-trees.js");
const artifacts_js_1 = require("../../game-protocol/artifacts.js");
const equipment_js_1 = require("../../game-protocol/equipment.js");
const index_js_2 = require("../../game-art/index.js");
const selection_js_1 = require("../../game-art/selection.js");
const PAGE_DEFAULT = 60;
const PAGE_MAX = 200;
const GROUPS = new Set(Object.values(member_timeline_js_1.TIMELINE_GROUPS));
/** `names`: the game's names (a test seam; the game's CDN by default). */
function createMemberTimelineRouter(opts = {}) {
    const router = (0, express_1.Router)();
    const namesOf = opts.names ?? (() => (0, static_data_js_1.loadGameNames)().catch(() => null));
    router.get('/members/:memberId/timeline', async (req, res) => {
        const clanId = req.clanId;
        const memberId = Number.parseInt(String(req.params.memberId), 10);
        if (!Number.isFinite(memberId) || !(0, member_repo_js_1.getMemberById)(memberId, clanId)) {
            res.status(404).json({ error: 'Member not found' });
            return;
        }
        const playerId = (0, game_profile_repo_js_1.gamePlayerIdForMember)(memberId, clanId);
        const src = (0, member_timeline_repo_js_1.loadTimelineSources)(clanId, memberId, playerId);
        if (!src) {
            res.status(404).json({ error: 'Member not found' });
            return;
        }
        const names = await namesOf();
        const mappings = (0, index_js_2.currentGameArt)()?.mappings;
        const art = (map, id) => {
            const img = map?.[String(id)];
            return img ? (0, index_js_2.gameArtUrl)(img) : null;
        };
        // Hero talents vs research, from the trees (talent trees are kind 'talent').
        const talentIds = new Set();
        for (const tree of (0, tech_trees_js_1.cachedTechTrees)()?.trees ?? []) {
            if (tree.kind === 'talent')
                for (const n of tree.nodes)
                    talentIds.add(n.techId);
        }
        // A faction's level is a tech (800–802) with no tech icon: its crest stands in.
        const factionCrests = new Map(Object.values(names?.factions ?? {}).map((f) => [f.techId, f.art.icon]));
        const look = {
            techName: (id) => names?.techs?.[String(id)]?.name ?? `#${id}`,
            techIconUrl: (id) => art(mappings?.techs, id) ?? (factionCrests.get(id) ? (0, index_js_2.gameArtUrl)((0, selection_js_1.safeArtName)(factionCrests.get(id))) : null),
            techKind: (id) => (talentIds.has(id) ? 'talent' : 'research'),
            captainName: (id) => names?.captains?.[String(id)]?.name ?? `#${id}`,
            captainIconUrl: (id) => art(mappings?.captains, id),
            artifactName: (type) => (0, artifacts_js_1.describeArtifact)(type, 0, 0, [], names?.artifacts).name,
            artifactIconUrl: (type) => art(mappings?.artifacts, type),
            itemName: (type) => (0, equipment_js_1.describeItem)(type, 0, [], names).name,
            itemIconUrl: (type) => art(mappings?.equipment, type),
            heroName: (id) => names?.heroes?.[String(id)]?.name ?? '',
            heroAvatarUrl: (id) => (0, game_profile_repo_js_1.heroAvatarUrl)(id),
        };
        const timeline = (0, member_timeline_js_1.buildTimeline)(src, look, (0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
        const wanted = String(req.query.groups ?? '').split(',').filter((g) => GROUPS.has(g));
        const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? ''), 10) || PAGE_DEFAULT, 1), PAGE_MAX);
        const page = (0, member_timeline_js_1.pageTimeline)(timeline, {
            before: typeof req.query.before === 'string' ? req.query.before.slice(0, 200) : null,
            groups: wanted.length ? new Set(wanted) : null,
            limit,
        });
        res.json({ linked: playerId !== null, ...page });
    });
    return router;
}
//# sourceMappingURL=member-timeline.js.map