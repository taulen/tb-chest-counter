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
exports.createMightRouter = createMightRouter;
/**
 * Read API for member might (power level) tracking, plus the superadmin toggle.
 *
 * Everything might-related lives in this one router rather than being threaded
 * into api.ts: the feature is new, can only be validated against the live game,
 * and must be removable or disableable without touching the routes that serve
 * chest data.
 *
 * Deliberately unrelated to the ChestTracker import routes (/api/external) —
 * different source, different tables, no shared queries. Do not join these
 * datasets here.
 *
 * Mounted at /api/might behind requireAuth + requireClanContext, so `req.clanId`
 * is the caller's active clan and every query below is scoped to it.
 */
const express_1 = require("express");
const mightRepo = __importStar(require("../../data/repositories/might-repo.js"));
const member_repo_js_1 = require("../../data/repositories/member-repo.js");
const clan_repo_js_1 = require("../../data/repositories/clan-repo.js");
const user_repo_js_1 = require("../../data/repositories/user-repo.js");
const auth_js_1 = require("../middleware/auth.js");
const index_js_1 = require("../../config/index.js");
const persistent_env_js_1 = require("../../config/persistent-env.js");
const calibration_js_1 = require("../../config/calibration.js");
const game_day_js_1 = require("../../utils/game-day.js");
const logger_js_1 = require("../../utils/logger.js");
const log = (0, logger_js_1.childLogger)('might-route');
/** Chart windows the UI offers. Bounded so a crafted `days` can't ask for a
 *  scan of the whole table via a huge date arithmetic window. */
const MAX_DAYS = 400;
const DEFAULT_DAYS = 90;
/** Series the comparison chart will return at once — beyond this the lines stop
 *  being distinguishable anyway, and it bounds the SQL IN list. */
const MAX_COMPARE_MEMBERS = 12;
function clampDays(raw, fallback = DEFAULT_DAYS) {
    const n = Number.parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(n) || n <= 0)
        return fallback;
    return Math.min(MAX_DAYS, n);
}
function createMightRouter(scanLoop) {
    const router = (0, express_1.Router)();
    /**
     * Everything the Members page needs in one call: latest might per active
     * member with its delta, plus enough status for the UI to explain itself when
     * there's no data yet (feature off? not calibrated? just never run?).
     *
     * Members with no snapshot are included with `might: null` rather than
     * omitted, so the table shows the whole roster and marks the gaps instead of
     * quietly shrinking.
     */
    router.get('/overview', (req, res) => {
        const clanId = req.clanId;
        const deltaDays = clampDays(req.query.deltaDays, 7);
        const cfg = (0, index_js_1.loadConfig)();
        const withMight = mightRepo.getMightWithDelta(clanId, deltaDays);
        const byId = new Map(withMight.map((r) => [r.memberId, r]));
        const rows = (0, member_repo_js_1.getAllMembers)(true, clanId).map((m) => {
            const hit = byId.get(m.id);
            return {
                memberId: m.id,
                name: m.name,
                might: hit?.might ?? null,
                heroLevel: hit?.heroLevel ?? null,
                gameDate: hit?.gameDate ?? null,
                // The member's own sighting timestamp, so the ranking table's "Last Seen"
                // is the same fact (and the same value) the Members page shows. `gameDate`
                // above is a different thing — the game day this might READING came from —
                // and stays available to qualify the number itself.
                lastSeen: m.lastSeen,
                delta: hit?.delta ?? null,
                baselineDate: hit?.baselineDate ?? null,
            };
        });
        res.json({
            rows,
            deltaDays,
            enabled: cfg.mightTrackingEnabled,
            calibrated: (0, calibration_js_1.isMemberListCropSet)(),
            // False when the Stage 4 rectangle predates might tracking. Capture is
            // hard-gated on this, so the UI must be able to say so.
            cropIncludesMight: (0, calibration_js_1.isMemberListCropRecalibrated)(),
            lastCapture: mightRepo.getLastCaptureAt(clanId),
            daysCollected: mightRepo.getSnapshotDates(clanId).length,
            rolloverUtcHour: cfg.gameDayRolloverUtcHour,
        });
    });
    /** One member's might history. 404s for an id outside the caller's clan. */
    router.get('/member/:memberId', (req, res) => {
        const clanId = req.clanId;
        const memberId = Number.parseInt(req.params.memberId, 10);
        if (!Number.isFinite(memberId)) {
            res.status(400).json({ error: 'Invalid member id' });
            return;
        }
        const member = (0, member_repo_js_1.getMemberById)(memberId, clanId);
        if (!member) {
            res.status(404).json({ error: 'Member not found' });
            return;
        }
        // 0 (or an absent//invalid `days`) means the member's whole history — the
        // chart's "All". Every other value is a real window, INCLUDING 90: this
        // used to read `days === DEFAULT_DAYS ? 0 : days`, which aliased exactly
        // one window to "everything". Harmless while the member chart had no
        // selector and always asked for everything; a silent lie the moment it
        // offered 90d as an option.
        const days = clampDays(req.query.days, 0);
        res.json({
            memberId,
            name: member.name,
            // Current values separately from the series: the member page shows might and
            // hero level as headline stats, which is worth doing from the very first
            // capture even though a single point can't be charted.
            latest: mightRepo.getLatestForMember(memberId, clanId),
            points: mightRepo.getMemberHistory(memberId, clanId, days),
        });
    });
    /** Clan-wide might per game day, with the headcount behind each total. */
    router.get('/totals', (req, res) => {
        const clanId = req.clanId;
        const days = clampDays(req.query.days);
        res.json({ days, totals: mightRepo.getClanTotals(clanId, days) });
    });
    /**
     * Parallel series for the comparison chart.
     * `memberIds` is a comma-separated list; order is preserved so the frontend's
     * colour assignment stays put as the user toggles members on and off.
     */
    router.get('/compare', (req, res) => {
        const clanId = req.clanId;
        const days = clampDays(req.query.days);
        const ids = String(req.query.memberIds ?? '')
            .split(',')
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0)
            .slice(0, MAX_COMPARE_MEMBERS);
        if (ids.length === 0) {
            res.json({ days, series: [], truncated: false });
            return;
        }
        // De-dupe while keeping first-seen order.
        const unique = [...new Set(ids)];
        res.json({
            days,
            series: mightRepo.getSeriesForMembers(clanId, unique, days),
            truncated: unique.length >= MAX_COMPARE_MEMBERS,
        });
    });
    /**
     * Event windows to annotate the might charts with — the "key moments" that
     * explain a jump in the curve.
     *
     * Only feed-backed events (those with calendarNames in the catalog) have real
     * dates, so events on their own internal clock are omitted rather than
     * guessed at. Best-effort: the ICS feed is a third-party dependency, and a
     * chart that renders without annotations is far better than one that 500s
     * because an external host is down.
     *
     * Each window carries `fromDay`/`toDay` — the game days it actually covers —
     * alongside the raw timestamps. The chart's x axis is a list of game days
     * (`member_snapshots.game_date`), so resolving the instants to days is
     * rollover-aware work that belongs here next to the config, not in the
     * browser: `from`/`to` sit at the 17:00 reset, and reading a calendar date
     * straight off them lands a day late. `toDay` is derived from `resetAt`, not
     * `to`, so the scan-tail extension can't stretch a band past the event.
     */
    router.get('/events', async (req, res) => {
        const clanId = req.clanId;
        const days = clampDays(req.query.days);
        const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
        try {
            const { EVENT_CATALOG } = await import('../../config/event-catalog.js');
            const { getEventOccurrences } = await import('../../external/event-calendar.js');
            const feedBacked = EVENT_CATALOG.filter((e) => Array.isArray(e.calendarNames) && e.calendarNames.length > 0);
            const rolloverHr = (0, index_js_1.loadConfig)().gameDayRolloverUtcHour;
            const windows = [];
            for (const def of feedBacked) {
                const occurrences = await getEventOccurrences(def.key, clanId);
                for (const occ of occurrences) {
                    if (Date.parse(occ.to) < cutoffMs)
                        continue;
                    const startMs = Date.parse(occ.from);
                    const resetMs = Date.parse(occ.resetAt);
                    if (!Number.isFinite(startMs) || !Number.isFinite(resetMs))
                        continue;
                    windows.push({
                        key: def.key,
                        name: def.name,
                        from: occ.from,
                        to: occ.to,
                        fromDay: (0, game_day_js_1.gameDateFor)(startMs, rolloverHr),
                        // resetAt is the exclusive closing reset, so the last game day the
                        // event was live is the one an instant before it — same rule as the
                        // occurrence label ("Jul 2–6" for a Jul 2 → Jul 7 run).
                        toDay: (0, game_day_js_1.gameDateFor)(resetMs - 1, rolloverHr),
                        label: occ.label,
                    });
                }
            }
            windows.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
            res.json({ days, windows });
        }
        catch (err) {
            log.warn({ noAlert: true }, `Could not build might chart event annotations (chart still renders): ${String(err instanceof Error ? err.message : err)}`);
            res.json({ days, windows: [], unavailable: true });
        }
    });
    /**
     * Arm a one-shot re-capture, overwriting today's readings on the next scan.
     *
     * Deliberately does NOT start a scan itself — driving the browser is the
     * scheduler's job and a manual scan is already a button. This only clears the
     * once-a-day gate, so "Re-capture now" then "Trigger Manual Scan" gives a
     * complete test loop without waiting for the 17:00 UTC rollover.
     */
    router.post('/recapture', auth_js_1.requireSuperAdmin, (req, res) => {
        if (!scanLoop) {
            res.status(503).json({ error: 'Scanner is not running in this process.' });
            return;
        }
        // Every active clan, not just the caller's. This button is on the instance-wide
        // System page, a cycle sweeps all clans anyway, and getting a clean first day for
        // one clan while the others sit on yesterday's data is never what's wanted.
        const clanIds = (0, clan_repo_js_1.listClans)({ activeOnly: true }).map((c) => c.id);
        const armed = scanLoop.requestMightRecapture(clanIds);
        if (armed === 0) {
            res.status(400).json({
                error: clanIds.length === 0
                    ? 'No active clans to re-capture.'
                    : 'Might tracking is disabled — enable it first.',
            });
            return;
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'might_recapture_requested', { clanIds });
        res.json({ ok: true, armed, clanIds });
    });
    /** Current toggle state + why it might not be doing anything. */
    router.get('/settings', auth_js_1.requireSuperAdmin, (req, res) => {
        const cfg = (0, index_js_1.loadConfig)();
        res.json({
            enabled: cfg.mightTrackingEnabled,
            calibrated: (0, calibration_js_1.isMemberListCropSet)(),
            cropIncludesMight: (0, calibration_js_1.isMemberListCropRecalibrated)(),
            cropRevision: (0, calibration_js_1.getMemberListCropRevision)(),
            lastCapture: mightRepo.getLastCaptureAt(req.clanId),
        });
    });
    /**
     * Flip might tracking on or off.
     *
     * Persists to data/app.env (survives a container recreate, unlike .env) and
     * pushes the value into the running ScanLoop so it takes effect on the next
     * cycle without a restart — same pattern as the raw-OCR-capture toggle.
     *
     * Turning it off is purely a stop to further capture; existing snapshots are
     * kept, because the whole value of this data is its history and a toggle
     * should not be able to destroy months of it.
     */
    router.put('/settings', auth_js_1.requireSuperAdmin, (req, res) => {
        const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
        (0, persistent_env_js_1.updateEnvValue)('MIGHT_TRACKING_ENABLED', enabled ? 'true' : 'false');
        (0, index_js_1.resetConfig)();
        scanLoop?.setScannerSettings({ mightTrackingEnabled: enabled });
        (0, user_repo_js_1.logAction)(req.user.id, 'update_might_tracking', { enabled });
        // Report the calibration gate back so the UI can immediately say "on, but
        // waiting for a Stage 4 re-calibration" instead of implying it's collecting.
        const cfg = (0, index_js_1.loadConfig)();
        res.json({
            ok: true,
            enabled,
            calibrated: (0, calibration_js_1.isMemberListCropSet)(),
            cropIncludesMight: (0, calibration_js_1.isMemberListCropRecalibrated)(),
        });
    });
    return router;
}
//# sourceMappingURL=might.js.map