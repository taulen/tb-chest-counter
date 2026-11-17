"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGuardsRouter = createGuardsRouter;
/**
 * Guards (guardsmen) levels and Gold Pass holders, both as the game reports
 * them: the level is the Guardsmen tier from each member's research
 * (guards-repo.ts), the pass the flag on their game record (gold-pass-repo.ts).
 * Read-only — nothing here is entered by hand any more.
 *
 * Mounted at /api/guards behind requireAuth + requireClanContext, so `req.clanId`
 * is the caller's active clan and every query below is scoped to it.
 */
const express_1 = require("express");
const guardsRepo = __importStar(require("../../data/repositories/guards-repo.js"));
const goldPassRepo = __importStar(require("../../data/repositories/gold-pass-repo.js"));
const member_repo_js_1 = require("../../data/repositories/member-repo.js");
const member_levels_repo_js_1 = require("../../data/repositories/member-levels-repo.js");
const index_js_1 = require("../../config/index.js");
const guards_levels_js_1 = require("../../config/guards-levels.js");
const game_day_js_1 = require("../../utils/game-day.js");
const parse_int_js_1 = require("../../utils/parse-int.js");
function createGuardsRouter() {
    const router = (0, express_1.Router)();
    /**
     * Everything the roster tables and the Analytics overview need in one call:
     * each member's level and Gold Pass status, plus the clan's make-up. Members
     * with neither are still listed, with nulls, so a table can show the whole
     * roster and mark the gaps.
     */
    router.get('/overview', (req, res) => {
        const clanId = req.clanId;
        const rolloverHr = (0, index_js_1.loadConfig)().gameDayRolloverUtcHour;
        const nowMs = Date.now();
        const today = (0, game_day_js_1.currentGameDate)(rolloverHr);
        const summaries = guardsRepo.getGuardsSummaries(clanId, today);
        const goldPass = goldPassRepo.getGoldPassStatuses(clanId, nowMs, rolloverHr);
        const active = (0, member_repo_js_1.getAllMembers)(true, clanId);
        const activeIds = new Set(active.map((m) => m.id));
        const countActive = (ids) => {
            let n = 0;
            for (const id of ids)
                if (activeIds.has(id))
                    n++;
            return n;
        };
        // Last cycle only when the game history covers all of it: a part-covered
        // cycle would undercount and read as a real drop.
        const prevCycle = goldPassRepo.triumphalCycle(nowMs, rolloverHr, 1);
        const prevWindow = prevCycle ? goldPassRepo.goldPassForWindow(clanId, prevCycle.from, prevCycle.to) : null;
        const curCycle = goldPassRepo.triumphalCycle(nowMs, rolloverHr, 0);
        res.json({
            rows: active.map((m) => ({
                memberId: m.id,
                name: m.name,
                guards: summaries.get(m.id) ?? null,
                goldPass: goldPass.get(m.id) ?? null,
            })),
            today,
            staleDays: guards_levels_js_1.GUARDS_STALE_DAYS,
            clan: {
                activeMembers: active.length,
                guards: guardsRepo.getClanGuardsOverview(clanId, today),
                goldPass: {
                    // Active members only, so the share is "of the clan as it is now".
                    current: {
                        firstDay: curCycle?.firstDay ?? null,
                        lastDay: curCycle?.lastDay ?? null,
                        holders: countActive(goldPassRepo.goldPassHoldersNow(clanId)),
                    },
                    previous: prevCycle && prevWindow?.basis === 'game'
                        ? { firstDay: prevCycle.firstDay, lastDay: prevCycle.lastDay, holders: countActive(prevWindow.memberIds) }
                        : null,
                },
            },
        });
    });
    /** One member: their level with its level-ups, and what they last posted in chat. */
    router.get('/member/:memberId', (req, res) => {
        const clanId = req.clanId;
        const memberId = (0, parse_int_js_1.parseBoundedInt)(req.params.memberId, 0, { min: 1 });
        const member = memberId ? (0, member_repo_js_1.getMemberById)(memberId, clanId) : null;
        if (!member) {
            res.status(404).json({ error: 'Member not found' });
            return;
        }
        const today = (0, game_day_js_1.currentGameDate)((0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
        const guards = guardsRepo.getGuardsLevels(clanId).get(memberId) ?? null;
        res.json({
            memberId,
            name: member.name,
            today,
            staleDays: guards_levels_js_1.GUARDS_STALE_DAYS,
            guards,
            summary: guards ? guardsRepo.summarizeGuards(guards, today) : null,
            // What the member last posted in chat (Admin → Levels from chat), every
            // letter; the profile keeps only what research can't tell (Dragon).
            reportedLevels: (0, member_levels_repo_js_1.getLatestLevelsForMember)(clanId, memberId),
        });
    });
    return router;
}
//# sourceMappingURL=guards.js.map