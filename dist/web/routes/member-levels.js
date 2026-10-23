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
exports.createMemberLevelsRouter = createMemberLevelsRouter;
/**
 * Player levels posted in the in-game chat (Admin → Levels from chat). See
 * data/repositories/member-levels-repo.ts.
 *
 * Mounted at /api/member-levels behind requireAuth + requireClanContext.
 * Reading the latest levels is open to every member; previewing and importing
 * a paste are admin-only, and everything is scoped to the caller's clan.
 */
const express_1 = require("express");
const member_levels_parse_js_1 = require("../../data/member-levels-parse.js");
const levelsRepo = __importStar(require("../../data/repositories/member-levels-repo.js"));
const guards_repo_js_1 = require("../../data/repositories/guards-repo.js");
const user_repo_js_1 = require("../../data/repositories/user-repo.js");
const auth_js_1 = require("../middleware/auth.js");
const index_js_1 = require("../../config/index.js");
const game_day_js_1 = require("../../utils/game-day.js");
const MAX_TEXT_LENGTH = 200_000;
const MAX_ENTRIES = 300;
function createMemberLevelsRouter() {
    const router = (0, express_1.Router)();
    const today = () => (0, game_day_js_1.currentGameDate)((0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
    /** Each member's latest reported levels, next to the guards estimate. */
    router.get('/', (req, res) => {
        const clanId = req.clanId;
        const guards = (0, guards_repo_js_1.getGuardsSummaries)(clanId, today());
        res.json({
            today: today(),
            rows: levelsRepo.getLatestLevels(clanId).map((r) => ({
                ...r,
                guardsEstimate: guards.get(r.memberId)?.level ?? null,
            })),
        });
    });
    /** Parse a chat paste and match its names — nothing is saved. */
    router.post('/preview', auth_js_1.requireAdmin, (req, res) => {
        const text = typeof req.body?.text === 'string' ? req.body.text : '';
        if (!text.trim() || text.length > MAX_TEXT_LENGTH) {
            res.status(400).json({ error: 'Paste the chat lines first.' });
            return;
        }
        const parsed = (0, member_levels_parse_js_1.parseLevelReports)(text);
        if (parsed.players.length === 0) {
            res.status(400).json({
                error: 'No levels found. Expected lines like "taulen: G8/M8/S7/E8/C35/D284".',
                skipped: parsed.skipped.slice(0, 5),
            });
            return;
        }
        res.json({ rows: levelsRepo.previewLevelReports(req.clanId, parsed.players), skipped: parsed.skipped });
    });
    /**
     * Save reviewed rows: { entries: [{ memberId, levels, raw }] }. Dated the
     * game day it is saved — a chat post is what the player said today.
     */
    router.post('/import', auth_js_1.requireAdmin, (req, res) => {
        const clanId = req.clanId;
        const date = today();
        const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
        if (!entries || entries.length === 0 || entries.length > MAX_ENTRIES) {
            res.status(400).json({ error: 'Pick at least one player to save.' });
            return;
        }
        const result = levelsRepo.importLevelReports({
            clanId,
            date,
            entries: entries.map((e) => ({
                memberId: Number(e?.memberId),
                levels: levelsRepo.cleanLevels(e?.levels),
                raw: typeof e?.raw === 'string' ? e.raw : '',
            })),
            createdBy: req.user.username,
            createdByUserId: req.user.id,
        });
        (0, user_repo_js_1.logAction)(req.user.id, 'member_levels_import', { clanId, date, ...result });
        res.json({ ok: true, result });
    });
    return router;
}
//# sourceMappingURL=member-levels.js.map