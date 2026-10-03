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
 * Guards (guardsmen) levels and Gold Pass holders.
 *
 * Both are inferred from data the scanner already collects — see
 * src/data/repositories/guards-repo.ts and gold-pass-repo.ts for how — so every
 * read here is a derivation, and the only thing written is an admin's own entry
 * of a member's level.
 *
 * Mounted at /api/guards behind requireAuth + requireClanContext, so `req.clanId`
 * is the caller's active clan and every query below is scoped to it.
 */
const express_1 = require("express");
const guardsRepo = __importStar(require("../../data/repositories/guards-repo.js"));
const goldPassRepo = __importStar(require("../../data/repositories/gold-pass-repo.js"));
const member_repo_js_1 = require("../../data/repositories/member-repo.js");
const user_repo_js_1 = require("../../data/repositories/user-repo.js");
const auth_js_1 = require("../middleware/auth.js");
const index_js_1 = require("../../config/index.js");
const guards_ladder_js_1 = require("../../config/guards-ladder.js");
const game_day_js_1 = require("../../utils/game-day.js");
const parse_int_js_1 = require("../../utils/parse-int.js");
/** Cycles of gold-pass history on a member's profile. */
const MEMBER_GOLD_PASS_CYCLES = 6;
const MAX_NOTE_LENGTH = 200;
function cycleSummary(clanId, cycle, nowMs, rolloverHr, activeIds) {
    if (!cycle)
        return null;
    const window = goldPassRepo.goldPassForCycle(clanId, cycle, nowMs, rolloverHr);
    let holders = 0;
    for (const [id, e] of window.members)
        if (e.goldPass && activeIds.has(id))
            holders++;
    return {
        from: cycle.from,
        to: cycle.to,
        firstDay: cycle.firstDay,
        lastDay: cycle.lastDay,
        basis: window.basis,
        // Active members only, so the share is "of the clan as it is now".
        holders,
    };
}
function createGuardsRouter() {
    const router = (0, express_1.Router)();
    /**
     * Everything the roster tables and the Analytics overview need in one call:
     * each member's estimated level and gold-pass status, plus the clan's make-up.
     * Members with neither are still listed, with nulls, so a table can show the
     * whole roster and mark the gaps.
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
        const rows = active.map((m) => ({
            memberId: m.id,
            name: m.name,
            guards: summaries.get(m.id) ?? null,
            goldPass: goldPass.get(m.id) ?? null,
        }));
        res.json({
            rows,
            today,
            staleDays: guards_ladder_js_1.GUARDS_STALE_DAYS,
            clan: {
                activeMembers: active.length,
                guards: guardsRepo.getClanGuardsOverview(clanId, today),
                goldPass: {
                    current: cycleSummary(clanId, goldPassRepo.triumphalCycle(nowMs, rolloverHr, 0), nowMs, rolloverHr, activeIds),
                    previous: cycleSummary(clanId, goldPassRepo.triumphalCycle(nowMs, rolloverHr, 1), nowMs, rolloverHr, activeIds),
                },
            },
        });
    });
    /** One member: the full estimate with its evidence, admin entries, gold-pass history. */
    router.get('/member/:memberId', (req, res) => {
        const clanId = req.clanId;
        const memberId = (0, parse_int_js_1.parseBoundedInt)(req.params.memberId, 0, { min: 1 });
        const member = memberId ? (0, member_repo_js_1.getMemberById)(memberId, clanId) : null;
        if (!member) {
            res.status(404).json({ error: 'Member not found' });
            return;
        }
        const rolloverHr = (0, index_js_1.loadConfig)().gameDayRolloverUtcHour;
        const nowMs = Date.now();
        const today = (0, game_day_js_1.currentGameDate)(rolloverHr);
        const estimate = guardsRepo.getGuardsEstimates(clanId).get(memberId) ?? null;
        const goldPass = [];
        for (let offset = 0; offset < MEMBER_GOLD_PASS_CYCLES; offset++) {
            const cycle = goldPassRepo.triumphalCycle(nowMs, rolloverHr, offset);
            if (!cycle)
                break;
            const window = goldPassRepo.goldPassForCycle(clanId, cycle, nowMs, rolloverHr);
            const entry = window.members.get(memberId);
            goldPass.push({
                from: cycle.from,
                to: cycle.to,
                firstDay: cycle.firstDay,
                lastDay: cycle.lastDay,
                isCurrent: offset === 0,
                basis: window.basis,
                unionChests: entry?.unionChests ?? 0,
                passDonations: entry?.passDonations ?? 0,
                goldPass: entry?.goldPass ?? false,
            });
        }
        res.json({
            memberId,
            name: member.name,
            today,
            staleDays: guards_ladder_js_1.GUARDS_STALE_DAYS,
            estimate,
            summary: estimate ? guardsRepo.summarizeEstimate(estimate, today) : null,
            reports: guardsRepo.listGuardsReports(memberId, clanId),
            goldPass,
        });
    });
    /**
     * Record a member's level as an admin knows it (the member said so, or it was
     * seen in game). Dated, and weighed by the estimator like any other evidence —
     * so it pins the level on that day without stopping later donations from
     * carrying the member higher.
     */
    router.post('/member/:memberId/reports', auth_js_1.requireAdmin, (req, res) => {
        const clanId = req.clanId;
        const memberId = (0, parse_int_js_1.parseBoundedInt)(req.params.memberId, 0, { min: 1 });
        const member = memberId ? (0, member_repo_js_1.getMemberById)(memberId, clanId) : null;
        if (!member) {
            res.status(404).json({ error: 'Member not found' });
            return;
        }
        const level = Number(req.body?.level);
        if (!Number.isInteger(level) || level < guards_ladder_js_1.GUARDS_MIN_LEVEL || level > guards_ladder_js_1.GUARDS_MAX_LEVEL) {
            res.status(400).json({ error: `Level must be a whole number from ${guards_ladder_js_1.GUARDS_MIN_LEVEL} to ${guards_ladder_js_1.GUARDS_MAX_LEVEL}.` });
            return;
        }
        const today = (0, game_day_js_1.currentGameDate)((0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
        const rawDate = typeof req.body?.observedDate === 'string' && req.body.observedDate.trim()
            ? req.body.observedDate.trim()
            : today;
        const parsed = Date.parse(`${rawDate}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || Number.isNaN(parsed)
            || new Date(parsed).toISOString().slice(0, 10) !== rawDate) {
            res.status(400).json({ error: 'Date must be a real date, YYYY-MM-DD.' });
            return;
        }
        if (rawDate > today) {
            res.status(400).json({ error: 'Date cannot be in the future.' });
            return;
        }
        const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, MAX_NOTE_LENGTH) : '';
        const id = guardsRepo.addGuardsReport({
            clanId, memberId, level, observedDate: rawDate, note, createdBy: req.user.id,
        });
        (0, user_repo_js_1.logAction)(req.user.id, 'guards_report_add', { memberId, name: member.name, level, observedDate: rawDate });
        res.json({ ok: true, id });
    });
    router.delete('/reports/:id', auth_js_1.requireAdmin, (req, res) => {
        const clanId = req.clanId;
        const id = (0, parse_int_js_1.parseBoundedInt)(req.params.id, 0, { min: 1 });
        const removed = id ? guardsRepo.deleteGuardsReport(id, clanId) : null;
        if (!removed) {
            res.status(404).json({ error: 'Entry not found' });
            return;
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'guards_report_delete', { id, memberId: removed.memberId, level: removed.level });
        res.json({ ok: true });
    });
    return router;
}
//# sourceMappingURL=guards.js.map