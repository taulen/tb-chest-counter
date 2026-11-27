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
exports.createTinmanRouter = createTinmanRouter;
/**
 * An event's own scores, read from the game (data/event-scores.ts): Rise of
 * the Ancients (Tinman) per summon on Events → Ancients, and Trials of Olympus,
 * Ragnarok and Dark Omens' Spoils of Dread damage per day on their tabs — the
 * same table Tools → Rewards splits by. Runs pasted by hand before the game
 * read them stay readable; nothing is pasted any more (Nov 25 2026).
 *
 * Ancients also has per-tier targets (pasted from the Ancient planner — a plan,
 * not a score) and answers GET /vaults: who raised a Vault of the Ancients,
 * and GET /hits: the Tin Man hits members shared as battle reports, with the
 * Tin Man's stacks at each (docs/battle-reports.md).
 *
 * Mounted at /api/tinman (Ancients) and /api/event-scores/<event> behind
 * requireAuth + requireClanContext. Reading is open to every member; targets
 * are admin-only, and every query is scoped to the caller's active clan.
 */
const express_1 = require("express");
const tinmanRepo = __importStar(require("../../data/repositories/tinman-repo.js"));
const tinman_parse_js_1 = require("../../data/tinman-parse.js");
const event_scores_js_1 = require("../../data/event-scores.js");
const guards_repo_js_1 = require("../../data/repositories/guards-repo.js");
const user_repo_js_1 = require("../../data/repositories/user-repo.js");
const auth_js_1 = require("../middleware/auth.js");
const index_js_1 = require("../../config/index.js");
const game_day_js_1 = require("../../utils/game-day.js");
const clan_repo_js_1 = require("../../data/repositories/clan-repo.js");
const event_calendar_js_1 = require("../../external/event-calendar.js");
const game_protocol_repo_js_1 = require("../../data/repositories/game-protocol-repo.js");
const battle_report_repo_js_1 = require("../../data/repositories/battle-report-repo.js");
const MAX_TEXT_LENGTH = 200_000;
/** A query bound as ISO: null when absent, undefined when not a date. */
function bound(raw) {
    if (raw === undefined || raw === '')
        return null;
    const ms = typeof raw === 'string' ? Date.parse(raw) : NaN;
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}
/** A real YYYY-MM-DD day, or null. */
function parseDate(raw) {
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw))
        return null;
    const ms = Date.parse(`${raw}T00:00:00Z`);
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== raw)
        return null;
    return raw;
}
/**
 * A day a run's targets can be saved for: up to one Ancients cycle ahead.
 * Targets are a plan, set before or during a run, and a run is filed under its
 * Tinman day — its LAST day — so a live run's date is still ahead until then
 * (game day Nov 21 at 07:00 UTC, run Nov 21–22 filed under Nov 22).
 */
function validTargetDate(raw, today) {
    const date = parseDate(raw);
    if (!date)
        return null;
    const limit = new Date(Date.parse(`${today}T00:00:00Z`) + game_day_js_1.ANCIENTS_CYCLE_DAYS * 86_400_000).toISOString().slice(0, 10);
    return date <= limit ? date : null;
}
/** The newest Tinman day at or before today on the cadence — the default run. */
function latestTinmanDay(today) {
    for (let back = 0; back < game_day_js_1.ANCIENTS_CYCLE_DAYS; back++) {
        const d = new Date(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
        if ((0, game_day_js_1.isTinmanDay)(d))
            return d;
    }
    return today;
}
/**
 * A Seasonal Kingdom clan's Tinman days, newest first, or null for a
 * normal-kingdom clan (whose fixed 6-day cadence answers instead).
 *
 * SK runs Ancients on its own rotation (every 5 days in SK 2026, and its first
 * run was a day off even that), so the only reliable list is the clan's own
 * calendar: each started Ancients run ends on its Tinman day. A feed outage
 * gives [] — the checks below then stay silent rather than guess.
 */
async function seasonalTinmanDays(clanId) {
    if ((0, clan_repo_js_1.clanCalendarRealm)(clanId) !== 'season')
        return null;
    const rollover = (0, index_js_1.loadConfig)().gameDayRolloverUtcHour;
    try {
        const runs = await (0, event_calendar_js_1.getEventOccurrences)('ancients', clanId);
        return runs.map((o) => (0, game_day_js_1.gameDateFor)(Date.parse(o.resetAt) - 1, rollover));
    }
    catch {
        return [];
    }
}
function createTinmanRouter(eventKey = 'ancients') {
    const router = (0, express_1.Router)();
    const today = () => (0, game_day_js_1.currentGameDate)((0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
    const ancients = eventKey === 'ancients';
    const maxRounds = tinmanRepo.SCORE_EVENTS[eventKey].maxRounds;
    /**
     * Standings for one run (`?date=` its day; default: the newest). The per-day
     * events have no cadence to fall back on, so their default is the newest
     * run with scores.
     *
     * A future day reads as a run with no scores yet, not an error: a live
     * Ancients run files its scores under its last (Tinman) day, which is still
     * ahead until that day, and the Events page opens on Participants only when
     * this read says the run is empty.
     */
    router.get('/', async (req, res) => {
        const clanId = req.clanId;
        const t = today();
        const skDays = ancients ? await seasonalTinmanDays(clanId) : null;
        const dates = (0, event_scores_js_1.eventScoreDates)(clanId, eventKey);
        const newest = () => dates.find((d) => d <= t) ?? t;
        const date = req.query.date !== undefined
            ? parseDate(req.query.date)
            : skDays ? skDays.find((d) => d <= t) ?? newest()
                : ancients ? latestTinmanDay(t) : newest();
        if (!date) {
            res.status(400).json({ error: 'date must be a game day, YYYY-MM-DD' });
            return;
        }
        // Each matched player's guards level (from research), so the page can hold their
        // total against their tier's target. Null = unknown (the page assumes G7).
        const standings = (0, event_scores_js_1.getEventScores)(clanId, eventKey, date);
        const guards = ancients ? (0, guards_repo_js_1.getGuardsSummaries)(clanId, t) : null;
        res.json({
            ...standings,
            players: standings.players.map((p) => ({
                ...p,
                guardsLevel: p.memberId ? guards?.get(p.memberId)?.level ?? null : null,
            })),
            targets: ancients ? tinmanRepo.getTinmanTargets(clanId, date) : null,
            isTinmanDay: !ancients ? null
                : skDays ? (skDays.length ? skDays.includes(date) : null)
                    : (0, game_day_js_1.isTinmanDay)(date),
            // Which schedule isTinmanDay was judged by, so the card words its warning.
            seasonalKingdom: skDays !== null,
            dates,
            maxSummons: maxRounds,
        });
    });
    /**
     * Vaults of the Ancients raised by the clan's players, first seen in
     * [from, to) (ISO; either may be left out — all time). Read from the map
     * around members' cities every scan (scheduler/game-protocol-phase.ts);
     * vaults exist only on an Ancients run's first day. Vaults other players
     * raised near our cities are counted, not listed. Each vault says whether
     * it still stood at the newest map pass (`standing`, as of `lastScanAt`).
     * Ancients only.
     */
    if (ancients)
        router.get('/vaults', (req, res) => {
            const from = bound(req.query.from);
            const to = bound(req.query.to);
            if (from === undefined || to === undefined) {
                res.status(400).json({ error: 'from and to must be dates' });
                return;
            }
            const vaults = (0, game_protocol_repo_js_1.listRaisedVaults)(req.clanId, from, to);
            const raised = vaults.filter((v) => v.inClan);
            // Standing = seen by the newest map pass. The pass stamps the vaults it
            // sees and the cities it reads with the same `now`, and keeps reading a
            // standing member vault's tile until it is gone or expired — so a vault
            // missing from it was taken down (or ran out) since its last_seen.
            const lastScanAt = (0, game_protocol_repo_js_1.lastMapPassAt)(req.clanId);
            res.json({
                raised: raised.map(({ ownerId: _ownerId, inClan: _inClan, ...v }) => ({
                    ...v,
                    standing: lastScanAt !== null && v.lastSeen >= lastScanAt,
                })),
                outsiders: vaults.length - raised.length,
                since: (0, game_protocol_repo_js_1.mapReadSince)(req.clanId),
                lastScanAt,
            });
        });
    /**
     * Tin Man hits shared as battle reports (in the clan chat, a private message
     * to the scanner account or a picked report chat), fought in [from, to):
     * who, the Tin Man's level and how many stacks it still had. With the clan's
     * rule (hit it at N stacks) and how the shared reports stand.
     */
    if (ancients)
        router.get('/hits', (req, res) => {
            const from = bound(req.query.from);
            const to = bound(req.query.to);
            if (from === undefined || to === undefined) {
                res.status(400).json({ error: 'from and to must be dates' });
                return;
            }
            const clanId = req.clanId;
            res.json({
                hits: (0, battle_report_repo_js_1.listTinmanHits)(clanId, from, to),
                requiredStacks: (0, battle_report_repo_js_1.getTinmanRequiredStacks)(clanId),
                reports: (0, battle_report_repo_js_1.reportCounts)(clanId),
            });
        });
    /**
     * The run's per-tier targets, pasted from the Ancient planner's "Points per
     * member" table or typed as "G7 1.3M" lines. Re-sending replaces them.
     * Ancients only. The live run's day is still ahead (validTargetDate).
     */
    if (ancients)
        router.put('/:date/targets', auth_js_1.requireAdmin, (req, res) => {
            const clanId = req.clanId;
            const date = validTargetDate(req.params.date, today());
            if (!date) {
                res.status(400).json({ error: 'Targets can be set for a past run, the live one or the next one.' });
                return;
            }
            const text = typeof req.body?.text === 'string' ? req.body.text : '';
            if (!text.trim() || text.length > MAX_TEXT_LENGTH) {
                res.status(400).json({ error: 'Paste the Points per member table first.' });
                return;
            }
            const parsed = (0, tinman_parse_js_1.parseTierTargets)(text);
            if (Object.keys(parsed.tiers).length === 0) {
                res.status(400).json({
                    error: 'No tier targets found. Expected lines like "G7 1.3M", or the Points per member table.',
                    skipped: parsed.skipped.slice(0, 5),
                });
                return;
            }
            tinmanRepo.saveTinmanTargets({ clanId, date, tiers: parsed.tiers, kills: parsed.kills, savedBy: req.user.username });
            (0, user_repo_js_1.logAction)(req.user.id, 'tinman_targets', { clanId, date, kills: parsed.kills, tiers: parsed.tiers });
            res.json({ ok: true, targets: tinmanRepo.getTinmanTargets(clanId, date), skipped: parsed.skipped });
        });
    if (ancients)
        router.delete('/:date/targets', auth_js_1.requireAdmin, (req, res) => {
            const clanId = req.clanId;
            const date = validTargetDate(req.params.date, today());
            if (!date || !tinmanRepo.deleteTinmanTargets(clanId, date)) {
                res.status(404).json({ error: 'No targets for that run.' });
                return;
            }
            (0, user_repo_js_1.logAction)(req.user.id, 'tinman_targets_delete', { clanId, date });
            res.json({ ok: true });
        });
    return router;
}
//# sourceMappingURL=tinman.js.map