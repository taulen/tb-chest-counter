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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApiRouter = createApiRouter;
const express_1 = require("express");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crop_dirs_js_1 = require("../../utils/crop-dirs.js");
const zlib_1 = __importDefault(require("zlib"));
const chestRepo = __importStar(require("../../data/repositories/chest-repo.js"));
const triumphalChestRepo = __importStar(require("../../data/repositories/triumphal-chest-repo.js"));
const eventRepo = __importStar(require("../../data/repositories/event-repo.js"));
const event_catalog_js_1 = require("../../config/event-catalog.js");
const event_calendar_js_1 = require("../../external/event-calendar.js");
const memberRepo = __importStar(require("../../data/repositories/member-repo.js"));
const sessionRepo = __importStar(require("../../data/repositories/session-repo.js"));
const mergeRepo = __importStar(require("../../data/repositories/merge-repo.js"));
const sourcePointsRepo = __importStar(require("../../data/repositories/source-points-repo.js"));
const triumphalPointsRepo = __importStar(require("../../data/repositories/triumphal-points-repo.js"));
const reviewQueueRepo = __importStar(require("../../data/repositories/review-queue-repo.js"));
const user_repo_js_1 = require("../../data/repositories/user-repo.js");
const auth_js_1 = require("../middleware/auth.js");
const login_bridge_js_1 = require("../login-bridge.js");
const enums_js_1 = require("../../models/enums.js");
const catalog_export_js_1 = require("../../output/catalog-export.js");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const database_js_1 = require("../../data/database.js");
const index_js_1 = require("../../config/index.js");
const calibration_js_1 = require("../../config/calibration.js");
const member_capture_js_1 = require("../../browser/member-capture.js");
const clan_repo_js_1 = require("../../data/repositories/clan-repo.js");
const resourceRepo = __importStar(require("../../data/repositories/resource-repo.js"));
const persistent_env_js_1 = require("../../config/persistent-env.js");
const parse_int_js_1 = require("../../utils/parse-int.js");
const ttl_cache_js_1 = require("../../utils/ttl-cache.js");
const chest_repo_js_1 = require("../../data/repositories/chest-repo.js");
const chestSummaryRepo = __importStar(require("../../data/repositories/chest-summary-repo.js"));
const game_day_js_1 = require("../../utils/game-day.js");
const session_repo_js_1 = require("../../data/repositories/session-repo.js");
const db_backup_js_1 = require("../../utils/db-backup.js");
const clan_restore_js_1 = require("../../data/clan-restore.js");
const log_buffer_js_1 = require("../../utils/log-buffer.js");
const leaderboard_handler_js_1 = require("./leaderboard-handler.js");
function createPreImportBackup() {
    const dbPath = path_1.default.resolve(process.env.DB_PATH || './data/tb-chests.db');
    const backupDir = path_1.default.resolve('data', 'backups');
    fs_1.default.mkdirSync(backupDir, { recursive: true });
    (0, database_js_1.getDb)().pragma('wal_checkpoint(TRUNCATE)');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `pre-import-${timestamp}.db`;
    const backupPath = path_1.default.join(backupDir, backupFilename);
    fs_1.default.copyFileSync(dbPath, backupPath);
    return backupFilename;
}
function parseDbBackupPayload(body) {
    const fileName = String(body?.fileName ?? '').trim();
    const contentBase64 = String(body?.contentBase64 ?? '').trim();
    if (!fileName)
        throw new Error('fileName is required');
    if (!contentBase64)
        throw new Error('contentBase64 is required');
    return { fileName, contentBase64 };
}
let calibrationJob = null;
const VALID_STAGES = new Set([
    'main', 'sidebars', 'gifts', 'members', 'worldmap', 'capital',
]);
function parseStage(value, fallback = 'gifts') {
    return typeof value === 'string' && VALID_STAGES.has(value)
        ? value
        : fallback;
}
function calibrationImagePath(stage) {
    return path_1.default.resolve('data', 'screenshots', `calibration_${stage}.png`);
}
function calibrationMetaPath(stage) {
    return path_1.default.resolve('data', 'screenshots', `calibration_${stage}.meta.json`);
}
/**
 * Which AppConfig fields belong to which wizard stage.
 *
 * Module scope because three handlers need the same answer — the stage save (to
 * reject cross-stage writes), the stage reset (to know what to zero), and the
 * env mapping below. It lived inside the save handler while the reset route
 * didn't exist; a second copy would be the kind of duplication that let the
 * CalibrationStage union drift out of sync with the scheduler's.
 *
 * Stage 2 ("sidebars") and Stage 3 ("gifts") used to be one stage but were split
 * because the sidebars are visible from any My Clan sub-section while the
 * panel-specific targets (Open button, card crop, top tabs) need the Gifts
 * sub-section open.
 */
const CALIBRATION_STAGE_FIELDS = {
    main: [
        'uiClanButtonXPct', 'uiClanButtonYPct',
        'uiWorldMapButtonXPct', 'uiWorldMapButtonYPct',
    ],
    sidebars: [
        'uiGiftsSidebarXPct', 'uiGiftsSidebarYPct',
        'uiMembersSidebarXPct', 'uiMembersSidebarYPct',
    ],
    gifts: [
        'uiGiftsTabXPct', 'uiGiftsTabYPct',
        'uiTriumphalTabXPct', 'uiTriumphalTabYPct',
        'scanOpenButtonXPct', 'scanOpenButtonYPct',
        'scanCropLeftPct', 'scanCropTopPct', 'scanCropRightPct', 'scanCropBottomPct',
    ],
    members: [
        'memberListCropLeftPct', 'memberListCropTopPct',
        'memberListCropRightPct', 'memberListCropBottomPct',
    ],
    worldmap: [
        'uiClanCapitalButtonXPct', 'uiClanCapitalButtonYPct',
        'uiClanCapitalMarkerXPct', 'uiClanCapitalMarkerYPct',
    ],
    capital: [
        'uiCapitalHistorySidebarXPct', 'uiCapitalHistorySidebarYPct',
        'resourceHistoryCropLeftPct', 'resourceHistoryCropTopPct',
        'resourceHistoryCropRightPct', 'resourceHistoryCropBottomPct',
    ],
};
/** Field name → the app.env key it persists to. */
const CALIBRATION_FIELD_ENV = {
    uiClanButtonXPct: 'UI_CLAN_BUTTON_X_PCT',
    uiClanButtonYPct: 'UI_CLAN_BUTTON_Y_PCT',
    uiGiftsSidebarXPct: 'UI_GIFTS_SIDEBAR_X_PCT',
    uiGiftsSidebarYPct: 'UI_GIFTS_SIDEBAR_Y_PCT',
    uiGiftsTabXPct: 'UI_GIFTS_TAB_X_PCT',
    uiGiftsTabYPct: 'UI_GIFTS_TAB_Y_PCT',
    uiTriumphalTabXPct: 'UI_TRIUMPHAL_TAB_X_PCT',
    uiTriumphalTabYPct: 'UI_TRIUMPHAL_TAB_Y_PCT',
    uiMembersSidebarXPct: 'UI_MEMBERS_SIDEBAR_X_PCT',
    uiMembersSidebarYPct: 'UI_MEMBERS_SIDEBAR_Y_PCT',
    scanOpenButtonXPct: 'SCAN_OPEN_BUTTON_X_PCT',
    scanOpenButtonYPct: 'SCAN_OPEN_BUTTON_Y_PCT',
    scanCropLeftPct: 'SCAN_CROP_LEFT_PCT',
    scanCropTopPct: 'SCAN_CROP_TOP_PCT',
    scanCropRightPct: 'SCAN_CROP_RIGHT_PCT',
    scanCropBottomPct: 'SCAN_CROP_BOTTOM_PCT',
    memberListCropLeftPct: 'MEMBER_LIST_CROP_LEFT_PCT',
    memberListCropTopPct: 'MEMBER_LIST_CROP_TOP_PCT',
    memberListCropRightPct: 'MEMBER_LIST_CROP_RIGHT_PCT',
    memberListCropBottomPct: 'MEMBER_LIST_CROP_BOTTOM_PCT',
    uiWorldMapButtonXPct: 'UI_WORLD_MAP_BUTTON_X_PCT',
    uiWorldMapButtonYPct: 'UI_WORLD_MAP_BUTTON_Y_PCT',
    uiClanCapitalButtonXPct: 'UI_CLAN_CAPITAL_BUTTON_X_PCT',
    uiClanCapitalButtonYPct: 'UI_CLAN_CAPITAL_BUTTON_Y_PCT',
    uiClanCapitalMarkerXPct: 'UI_CLAN_CAPITAL_MARKER_X_PCT',
    uiClanCapitalMarkerYPct: 'UI_CLAN_CAPITAL_MARKER_Y_PCT',
    uiCapitalHistorySidebarXPct: 'UI_CAPITAL_HISTORY_SIDEBAR_X_PCT',
    uiCapitalHistorySidebarYPct: 'UI_CAPITAL_HISTORY_SIDEBAR_Y_PCT',
    resourceHistoryCropLeftPct: 'RESOURCE_HISTORY_CROP_LEFT_PCT',
    resourceHistoryCropTopPct: 'RESOURCE_HISTORY_CROP_TOP_PCT',
    resourceHistoryCropRightPct: 'RESOURCE_HISTORY_CROP_RIGHT_PCT',
    resourceHistoryCropBottomPct: 'RESOURCE_HISTORY_CROP_BOTTOM_PCT',
};
function createApiRouter(scanLoop) {
    const router = (0, express_1.Router)();
    // Note: all routes here already require auth (applied in server.ts)
    // GET /api/stats
    router.get('/stats', (req, res) => {
        const stats = sessionRepo.getScanStats(req.clanId ?? 1);
        res.json(stats);
    });
    // GET /api/status
    // The next-scan countdown is scoped by role so admins of inactive
    // clans don't see a misleading timer for a cycle that won't touch
    // their clan:
    //   - Superadmins always see the global cycle timer regardless of
    //     which clan is selected in the dropdown — that timer reflects
    //     the next sweep across every active clan.
    //   - Regular admins see the timer only when their own clan is in
    //     the active rotation. If their clan is inactive (or no scan is
    //     scheduled at all), nextScanAt is null and `clanInactive` flags
    //     it so the frontend can render a clear message instead of an
    //     empty header.
    router.get('/status', (req, res) => {
        let nextScanAt;
        let clanInactive = false;
        const isSuperadmin = req.user?.role === 'superadmin';
        // Scan-error details are operator information — non-admins (regular
        // clan members) should not see "error · Preparing Gifts tab…" in
        // their header. Filter the error out of the /status payload for
        // anyone below admin, and downgrade the state dot to 'idle' so
        // there's no error-styled UI either.
        const isAdminish = req.user?.role === 'admin' || isSuperadmin;
        if (isSuperadmin) {
            nextScanAt = scanLoop?.getNextScanAt() ?? null;
        }
        else if (req.clanId) {
            nextScanAt = scanLoop?.getNextScanAtForClan(req.clanId) ?? null;
            // If the global timer is set but this clan's view returned null,
            // it's because the clan isn't in the active rotation — surface
            // that distinction so the UI doesn't conflate it with "scanner
            // stopped".
            if (nextScanAt === null && (scanLoop?.getNextScanAt() ?? null) !== null) {
                clanInactive = true;
            }
        }
        else {
            nextScanAt = null;
        }
        // Progress fields below describe the active scan, which targets one
        // clan at a time. Regular admins must only see them when their own
        // clan is the one being scanned — otherwise the header leaks "scan
        // in progress · 47 chests" from a different clan's session.
        // Superadmins see the global view since they manage the rotation.
        const rawState = scanLoop?.getState() ?? 'unknown';
        const rawScanInProgress = scanLoop?.isScanInProgress() ?? false;
        const rawError = scanLoop?.getLastScanError() ?? null;
        const activeClanId = scanLoop?.getActiveClanId() ?? null;
        const isMyScan = isSuperadmin
            || (req.clanId !== undefined && activeClanId !== null && activeClanId === req.clanId);
        const isMyError = isAdminish && (isSuperadmin
            || (rawError !== null && req.clanId !== undefined && rawError.clanId === req.clanId));
        // When another clan is mid-scan or recently errored, downgrade
        // 'scanning'/'processing'/'error' to 'idle' for this admin so the
        // status dot/text don't imply something is happening for them.
        let state = rawState;
        if (!isMyScan && (rawState === 'scanning' || rawState === 'processing'))
            state = 'idle';
        if (!isMyError && rawState === 'error')
            state = 'idle';
        // Onboarding banner data: the dashboard renders a "do X next"
        // strip when the instance / current clan isn't fully provisioned.
        // Calibration is global; member capture is per-clan. We return the
        // first unmet precondition so the client UI is just `nextStep ===
        // 'calibrate'` / `'capture-members'` / `'ready'` — no logic on the
        // browser side.
        const calibrated = (0, calibration_js_1.isFullyCalibrated)();
        const clanScopedForBanner = req.clanId ?? null;
        const captureNeeded = clanScopedForBanner !== null
            && (0, member_capture_js_1.needsMemberCapture)(clanScopedForBanner);
        const onboardingNextStep = !calibrated
            ? 'calibrate'
            : captureNeeded
                ? 'capture-members'
                : 'ready';
        res.json({
            state,
            scanInProgress: isMyScan ? rawScanInProgress : false,
            liveChestCount: isMyScan ? (scanLoop?.getLiveChestCount() ?? 0) : 0,
            progressMessage: isMyScan ? (scanLoop?.getProgressMessage() ?? '') : '',
            // The might snapshot runs after the scan is finalised, so `state` has
            // already gone back to 'idle' while the browser is still working. Without
            // this the header would show "idle" and discard the progress messages.
            mightInProgress: isMyScan ? (scanLoop?.isMightCaptureInProgress() ?? false) : false,
            // Same reasoning as mightInProgress, and it matters more here: a resource
            // capture can run for half an hour on a full backfill, so a header claiming
            // "idle" that whole time is the difference between an operator watching
            // progress and an operator wondering whether anything is happening at all.
            resourceInProgress: isMyScan ? (scanLoop?.isResourceCaptureInProgress() ?? false) : false,
            lastScanError: isMyError ? rawError : null,
            nextScanAt: nextScanAt ? new Date(nextScanAt).toISOString() : null,
            clanInactive,
            onboarding: {
                calibrated,
                memberCaptureDone: clanScopedForBanner !== null ? !captureNeeded : null,
                nextStep: onboardingNextStep,
                clanId: clanScopedForBanner,
                // "2 of 4 stages done" beats "not calibrated": the banner is the only
                // thing most operators read, and a bare blocker gives them no sense of
                // how much is left or which stage to open.
                calibrationProgress: (0, calibration_js_1.requiredCalibrationProgress)(),
            },
            timestamp: new Date().toISOString(),
        });
    });
    // GET /api/admin/settings - superadmin settings snapshot
    router.get('/admin/settings', auth_js_1.requireSuperAdmin, (_req, res) => {
        (0, index_js_1.resetConfig)();
        const config = (0, index_js_1.loadConfig)();
        const intervalMs = scanLoop?.getScanIntervalMs() ?? config.scanIntervalMs;
        res.json({
            scanIntervalMs: intervalMs,
            scanIntervalMinutes: Math.round(intervalMs / 60_000),
            liveApplied: Boolean(scanLoop),
        });
    });
    // The legacy POST /api/admin/upload-storage-state was removed in the
    // multi-clan refactor. Per-clan auth is now captured by the in-app
    // login bridge (POST /api/admin/login-session/start) which writes
    // straight to data/clans/<id>/storage-state.json. The bridge is the
    // single sign-in path; there is no manual JSON upload anymore.
    // GET /api/admin/login-session/status - is a remote-login bridge active?
    router.get('/admin/login-session/status', auth_js_1.requireSuperAdmin, (_req, res) => {
        const status = login_bridge_js_1.loginBridge.status();
        res.json({
            ...status,
            scanInProgress: scanLoop?.isScanInProgress() ?? false,
            schedulerPaused: scanLoop?.isPaused() ?? false,
        });
    });
    // POST /api/admin/login-session/start - launch headless browser + open WS bridge
    // Body: { clanId? } — superadmin can pass any clan; clan admins are
    // forced to their own clan regardless of payload (we ignore the body
    // clanId for non-superadmin callers and use req.clanId instead).
    // Required so the bridge launches against the right clan's profile
    // and writes the captured cookies into that clan's storage state
    // without clobbering another clan's auth.
    router.post('/admin/login-session/start', auth_js_1.requireAdmin, async (req, res) => {
        // If a stale bridge is lingering (e.g. user navigated away or switched tabs
        // without saving/cancelling), tear it down so this click always opens a
        // fresh session. The teardown hook calls scanLoop.resume(); the explicit
        // resume() below is idempotent insurance in case the hook isn't wired yet.
        if (login_bridge_js_1.loginBridge.isActive()) {
            try {
                await login_bridge_js_1.loginBridge.cancel();
            }
            catch { }
            scanLoop?.resume();
        }
        if (scanLoop?.isScanInProgress()) {
            return res.status(409).json({
                error: 'A scan is currently running. Wait for it to finish, then try again.',
            });
        }
        if (scanLoop && !scanLoop.pause()) {
            return res.status(409).json({
                error: 'Scanner could not be paused; it is still running a scan.',
            });
        }
        // Resolve target clan: superadmin can target any (body.clanId);
        // anyone else is pinned to their own clan and the body is ignored.
        let clanId;
        if (req.user.role === 'superadmin') {
            const requested = Number.parseInt(String(req.body?.clanId ?? ''), 10);
            clanId = Number.isFinite(requested) ? requested : (req.clanId ?? 1);
        }
        else {
            clanId = req.user.clanId ?? 1;
        }
        try {
            const dims = await login_bridge_js_1.loginBridge.start(clanId);
            (0, user_repo_js_1.logAction)(req.user.id, 'login_session_start', { clanId });
            return res.json({ ok: true, clanId, ...dims });
        }
        catch (err) {
            // If start failed, resume the scanner so we don't leave it paused.
            scanLoop?.resume();
            return res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // POST /api/admin/login-session/save - capture storage state, persist, tear down
    router.post('/admin/login-session/save', auth_js_1.requireAdmin, async (req, res) => {
        if (!login_bridge_js_1.loginBridge.isActive()) {
            return res.status(409).json({ error: 'No active login session.' });
        }
        // Cross-clan guard: a clan admin can only save the session their
        // own clan owns. Superadmins can save any active session.
        if (req.user.role !== 'superadmin') {
            const bridgeClan = login_bridge_js_1.loginBridge.getActiveClanId();
            if (bridgeClan !== null && bridgeClan !== req.user.clanId) {
                return res.status(403).json({ error: 'This login session belongs to a different clan.' });
            }
        }
        try {
            const result = await login_bridge_js_1.loginBridge.save(req.user.id);
            scanLoop?.resume();
            return res.json({
                ok: true,
                cookies: result.cookies,
                hasTbAuth: result.hasTbAuth,
                hasSessionCookie: result.hasSessionCookie,
                // The scanner only needs the PTBHSSID session cookie; saving
                // already cleared the needs-reauth flag and resumed the loop, so
                // there's nothing to "restart". Report readiness off the session
                // cookie, not the raw cookie count.
                message: result.hasSessionCookie
                    ? `Login saved (${result.cookies} cookies). Scans will use it automatically — no restart needed.`
                    : `Saved ${result.cookies} cookies, but no Total Battle session cookie was captured. Make sure you're fully in-game, then Refresh login again.`,
            });
        }
        catch (err) {
            scanLoop?.resume();
            return res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // POST /api/admin/login-session/cancel - tear down without saving
    router.post('/admin/login-session/cancel', auth_js_1.requireAdmin, async (req, res) => {
        if (!login_bridge_js_1.loginBridge.isActive()) {
            scanLoop?.resume();
            return res.json({ ok: true, alreadyClosed: true });
        }
        if (req.user.role !== 'superadmin') {
            const bridgeClan = login_bridge_js_1.loginBridge.getActiveClanId();
            if (bridgeClan !== null && bridgeClan !== req.user.clanId) {
                return res.status(403).json({ error: 'This login session belongs to a different clan.' });
            }
        }
        try {
            await login_bridge_js_1.loginBridge.cancel();
            (0, user_repo_js_1.logAction)(req.user.id, 'login_session_cancel', {});
            scanLoop?.resume();
            return res.json({ ok: true });
        }
        catch (err) {
            scanLoop?.resume();
            return res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // POST /api/admin/restart - graceful process exit so Docker restarts the container
    router.post('/admin/restart', auth_js_1.requireSuperAdmin, (req, res) => {
        (0, user_repo_js_1.logAction)(req.user.id, 'restart_container', {});
        res.json({ ok: true, message: 'Container restarting… page will reload automatically.' });
        // Give the response time to flush before exiting
        setTimeout(() => process.exit(0), 500);
    });
    // PUT /api/admin/settings/scan-interval { scanIntervalMinutes }
    router.put('/admin/settings/scan-interval', auth_js_1.requireSuperAdmin, (req, res) => {
        const minutes = (0, parse_int_js_1.parseBoundedInt)(req.body?.scanIntervalMinutes, 5, { min: 1, max: 1440 });
        const intervalMs = minutes * 60_000;
        (0, persistent_env_js_1.updateEnvValue)('SCAN_INTERVAL_MS', String(intervalMs));
        if (scanLoop) {
            scanLoop.setScanIntervalMs(intervalMs);
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'update_scan_interval', { minutes, intervalMs });
        res.json({
            ok: true,
            scanIntervalMs: intervalMs,
            scanIntervalMinutes: minutes,
            liveApplied: Boolean(scanLoop),
        });
    });
    // GET /api/chests?from=&to=&member=&type=&limit=&offset=
    router.get('/chests', (req, res) => {
        const chests = chestRepo.getChests({
            from: req.query.from,
            to: req.query.to,
            memberId: req.query.member ? (0, parse_int_js_1.parseBoundedInt)(req.query.member, 0, { min: 1 }) : undefined,
            chestType: req.query.type,
            limit: (0, parse_int_js_1.parseBoundedInt)(req.query.limit, 100, { min: 1, max: 1000 }),
            offset: req.query.offset ? (0, parse_int_js_1.parseBoundedInt)(req.query.offset, 0, { min: 0, max: 1000000 }) : undefined,
            clanId: req.clanId ?? 1,
        });
        res.json(chests);
    });
    // GET /api/chests/by-name/:name/members?period=daily|weekly|monthly|all
    // Drill-down: for the given chest name, return per-member tallies plus
    // headline stats (total, unique collectors, avg, first/last seen). Used
    // by the chest detail page reachable from the Analytics "All Chest
    // Types" table.
    router.get('/chests/by-name/:name/members', (req, res) => {
        const input = decodeURIComponent(String(req.params.name || '')).trim();
        if (!input) {
            return res.status(400).json({ error: 'Chest name is required' });
        }
        // Accept either the canonical chest_name or a URL-safe slug so links
        // like /#chest/rare-dragon-chest resolve without %20-encoded spaces.
        const clanId = req.clanId ?? 1;
        const name = chestRepo.resolveChestName(input, clanId);
        // Same period semantics as /api/leaderboard so the UX is consistent.
        const period = req.query.period || 'all';
        let from;
        const now = new Date();
        if (period === 'daily') {
            from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        }
        else if (period === 'weekly') {
            from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        }
        else if (period === 'monthly') {
            from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        }
        const result = chestRepo.getMembersByChestName(name, clanId, from, undefined);
        res.json({ period, ...result });
    });
    // GET /api/chests/by-name/:name/history?memberId=&playerName=&period=
    // Per-member history for the chest-detail expand row. Either memberId
    // (preferred) or playerName (for unassigned rows) identifies the
    // collector; the period matches the parent page's filter so the
    // expansion stays consistent with the table above it.
    router.get('/chests/by-name/:name/history', (req, res) => {
        const input = decodeURIComponent(String(req.params.name || '')).trim();
        if (!input) {
            return res.status(400).json({ error: 'Chest name is required' });
        }
        const clanId = req.clanId ?? 1;
        const name = chestRepo.resolveChestName(input, clanId);
        const memberIdRaw = req.query.memberId;
        const memberId = memberIdRaw !== undefined && memberIdRaw !== '' && memberIdRaw !== 'null'
            ? (0, parse_int_js_1.parseBoundedInt)(memberIdRaw, 0, { min: 1 })
            : null;
        const playerName = memberId === null
            ? (req.query.playerName ? String(req.query.playerName) : '')
            : null;
        const period = req.query.period || 'all';
        let from;
        const now = new Date();
        if (period === 'daily') {
            from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        }
        else if (period === 'weekly') {
            from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        }
        else if (period === 'monthly') {
            from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        }
        const records = chestRepo.getChestHistoryForChestAndMember(name, memberId, playerName, clanId, from, undefined);
        res.json({ period, records });
    });
    // GET /api/members
    //
    // Defaults to active members only — soft-deleted (is_active = 0)
    // rows are excluded so the public Members list, member-picker
    // dropdowns, and leaderboard derivatives don't render a player who
    // was removed. The Admin → Edit Members card passes
    // ?include=inactive so it can still surface removed rows behind
    // its "Show removed members" toggle.
    router.get('/members', (req, res) => {
        const includeInactive = req.query.include === 'inactive';
        const members = memberRepo.getAllMembers(!includeInactive, req.clanId ?? 1);
        members.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        res.json(members);
    });
    // GET /api/members/:idOrName
    router.get('/members/:idOrName', (req, res) => {
        const clanId = req.clanId ?? 1;
        const param = String(req.params.idOrName);
        const member = /^\d+$/.test(param)
            ? memberRepo.getMemberById(parseInt(param), clanId)
            : memberRepo.findMemberByName(decodeURIComponent(param), clanId);
        if (!member)
            return res.status(404).json({ error: 'Member not found' });
        // Cross-clan access guard: if the member resolved by id belongs to a
        // different clan than the caller, refuse. Superadmins viewing clan X
        // get clanId=X from req, so this check still applies — they can't
        // peek at another clan's data without switching the active clan.
        const memberClanId = memberRepo.getMemberClanId(member.id);
        if (memberClanId !== null && memberClanId !== clanId) {
            return res.status(404).json({ error: 'Member not found' });
        }
        // Optional window, so the profile can be read for the same timeframe the
        // rest of the site uses. Omitted means all time, which is the default the
        // page lands on. An unparseable date degrades to all time rather than
        // erroring, matching /analytics/window and the leaderboard.
        const isValidIso = (v) => typeof v === 'string' && !Number.isNaN(new Date(v).getTime());
        const from = isValidIso(req.query.from) ? req.query.from : undefined;
        const to = isValidIso(req.query.to) ? req.query.to : undefined;
        const stats = chestRepo.getMemberStats(member.id, clanId, from, to);
        // Rank by points within the SAME window as the stats above — a rank drawn
        // from all time next to a week's chest count is two different questions
        // sharing a card. Returned with the total so the UI can show "3 / 47".
        const leaderboard = chestRepo.getLeaderboard(clanId, from, to, { includeAllMembers: true });
        const idx = leaderboard.findIndex((e) => e.memberId === member.id);
        const rank = idx >= 0 ? idx + 1 : null;
        const totalRanked = leaderboard.length;
        // The gap to the neighbours either side. "Rank 9 of 47" changes nobody's
        // behaviour; "340 points behind #8" is a knowable number of chests, and it
        // is the question a member actually opens this page with.
        //
        // Read straight off the array already in hand — no extra query, and it
        // usually hits the same 15s cache entry the leaderboard page just filled.
        // `tiedWith` exists for the tail: on a short window most of the roster sits
        // on zero, where "1,120 ahead of #40" is noise and "tied with 23 others on
        // 0" is the honest description.
        const meRow = idx >= 0 ? leaderboard[idx] : null;
        const neighbours = meRow ? {
            points: meRow.totalPoints,
            above: idx > 0 ? {
                rank: idx,
                name: leaderboard[idx - 1].memberName,
                gap: leaderboard[idx - 1].totalPoints - meRow.totalPoints,
            } : null,
            below: idx < leaderboard.length - 1 ? {
                rank: idx + 2,
                name: leaderboard[idx + 1].memberName,
                gap: meRow.totalPoints - leaderboard[idx + 1].totalPoints,
            } : null,
            tiedWith: leaderboard.filter((e) => e.totalPoints === meRow.totalPoints).length - 1,
        } : null;
        // Weekly progress is always the GAME WEEK, whatever window the page is
        // showing — the same treatment the Analytics page gives its might chart.
        // It answers "how am I doing right now", which a yearly view would bury.
        // GAME weeks (Sunday 17:00 UTC → Sunday 17:00 UTC), not a rolling 168
        // hours. The rolling form snapped to nothing, so a member's "this week"
        // here and their row on the weekly leaderboard were different windows and,
        // for most of any given week, different numbers.
        const thisWeekWindow = (0, game_day_js_1.gameWeekWindow)(0, (0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
        const lastWeekWindow = (0, game_day_js_1.gameWeekWindow)(1, (0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
        const thisWeek = chestRepo.getMemberAggregateInRange(member.id, clanId, thisWeekWindow.from, thisWeekWindow.to);
        const lastWeek = chestRepo.getMemberAggregateInRange(member.id, clanId, lastWeekWindow.from, lastWeekWindow.to);
        const progress = {
            thisWeek,
            lastWeek,
            chestsDelta: thisWeek.chests - lastWeek.chests,
            pointsDelta: thisWeek.points - lastWeek.points,
        };
        // Single-day records: if this member is in the top 3 for either the
        // chest-count or points podium, include their rank + record so the
        // profile page can show a celebratory badge. Bundled into this
        // endpoint (rather than fetched separately) so the profile page
        // stays one round trip.
        const records = chestRepo.getSingleDayRecords((0, index_js_1.loadConfig)().gameDayRolloverUtcHour, clanId);
        const chestRankIdx = records.byChests.findIndex((r) => r.memberId === member.id);
        const pointRankIdx = records.byPoints.findIndex((r) => r.memberId === member.id);
        const singleDayBadges = {
            bestChestDay: chestRankIdx >= 0 ? {
                rank: chestRankIdx + 1,
                value: records.byChests[chestRankIdx].value,
                date: records.byChests[chestRankIdx].date,
            } : null,
            bestPointDay: pointRankIdx >= 0 ? {
                rank: pointRankIdx + 1,
                value: records.byPoints[pointRankIdx].value,
                date: records.byPoints[pointRankIdx].date,
            } : null,
        };
        // Triumphal totals. Bundled into the member-detail response so
        // the page can render a Triumphal-points headline next to the
        // regular Points one without a second round trip. Matches the
        // same per-chest points math as the global Triumphals page so
        // the two views can never disagree.
        const triumphalStats = triumphalChestRepo.getMemberStats(member.id, clanId);
        // Ninety game days of the member's own daily figures, for the consistency
        // card. Always this span regardless of the page's timeframe: the question
        // it answers is "am I improving against MYSELF", which needs a fixed
        // baseline rather than one that moves with the selector.
        const seriesTo = (0, game_day_js_1.currentGameDate)((0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
        const seriesFromDate = new Date(`${seriesTo}T00:00:00Z`);
        seriesFromDate.setUTCDate(seriesFromDate.getUTCDate() - 89);
        const seriesFrom = seriesFromDate.toISOString().slice(0, 10);
        const dailySeries = chestSummaryRepo.getMemberDailySeries(clanId, member.id, seriesFrom, seriesTo);
        const sourceMix = chestRepo.getMemberSourceMix(member.id, clanId, from ? new Date(from).getTime() : undefined, to ? new Date(to).getTime() : undefined);
        res.json({
            ...member, stats, rank, totalRanked, neighbours, progress,
            singleDayBadges, triumphalStats,
            dailySeries, seriesFrom, seriesTo, sourceMix,
        });
    });
    // GET /api/members/:id/chests?limit=&offset=&from=&to=
    router.get('/members/:id/chests', (req, res) => {
        const memberId = (0, parse_int_js_1.parseBoundedInt)(req.params.id, 0, { min: 1 });
        const limit = (0, parse_int_js_1.parseBoundedInt)(req.query.limit, 25, { min: 1, max: 500 });
        const offset = (0, parse_int_js_1.parseBoundedInt)(req.query.offset, 0, { min: 0 });
        const from = req.query.from;
        const to = req.query.to;
        // Cross-clan access guard. Member-id-scoped queries don't need a
        // clan_id WHERE clause (member already implies a clan), but we must
        // refuse to expose another clan's member to this caller.
        const memberClanId = memberRepo.getMemberClanId(memberId);
        if (memberClanId !== null && memberClanId !== (req.clanId ?? 1)) {
            return res.status(404).json({ error: 'Member not found' });
        }
        const clanId = req.clanId ?? 1;
        const chests = chestRepo.getChestsByMember(memberId, clanId, from, to, limit, offset);
        const total = chestRepo.countChestsByMember(memberId, clanId, from, to);
        res.json({ chests, total, limit, offset });
    });
    // GET /api/members/:id/triumphal-chests?limit=&offset=&from=&to=
    //
    // Triumphal twin of /chests above — drives the "Triumphal Chests"
    // tab on the member detail page. Same cross-clan guard. Triumphals
    // never carry points so the response is just the rows.
    router.get('/members/:id/triumphal-chests', (req, res) => {
        const memberId = (0, parse_int_js_1.parseBoundedInt)(req.params.id, 0, { min: 1 });
        const limit = (0, parse_int_js_1.parseBoundedInt)(req.query.limit, 25, { min: 1, max: 500 });
        const offset = (0, parse_int_js_1.parseBoundedInt)(req.query.offset, 0, { min: 0 });
        const from = req.query.from;
        const to = req.query.to;
        const memberClanId = memberRepo.getMemberClanId(memberId);
        if (memberClanId !== null && memberClanId !== (req.clanId ?? 1)) {
            return res.status(404).json({ error: 'Member not found' });
        }
        const clanId = req.clanId ?? 1;
        const chests = triumphalChestRepo.getChestsByMember(memberId, clanId, from, to, limit, offset);
        const total = triumphalChestRepo.countChestsByMember(memberId, clanId, from, to);
        res.json({ chests, total, limit, offset });
    });
    // GET /api/leaderboard?from=ISO&to=ISO
    //
    // The frontend computes the exact UTC bounds from its period+anchor
    // state (so shareable URLs stay absolute — an April 2026 link still
    // points to April 2026 next year) and passes them here. The backend
    // is pure window filtering: either an explicit [from, to) or no
    // filter for the all-time view.
    router.get('/leaderboard', (req, res) => {
        const params = (0, leaderboard_handler_js_1.parseLeaderboardQuery)(req);
        const rows = (0, leaderboard_handler_js_1.queryLeaderboard)(req.clanId ?? 1, params);
        // ?format=csv — the honest escape hatch for every one-off analysis this app
        // will never build. Same query, same window, same exclusions as the board on
        // screen, so a spreadsheet and the page can never disagree.
        //
        // Deliberately NOT on the public share route: that endpoint answers to an
        // unauthenticated token, and a whole-roster download is a different thing
        // from a leaderboard someone can read.
        if (req.query.format === 'csv') {
            const escape = (v) => {
                if (v == null)
                    return '';
                const str = String(v);
                return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
            };
            // Frozen header: something out there will be parsing this by column.
            const header = 'rank,member,chests,points,might,hero_level\n';
            const body = rows.map((r) => [
                r.rank, r.memberName, r.totalChests, r.totalPoints,
                r.might ?? '', r.heroLevel ?? '',
            ].map(escape).join(',')).join('\n');
            // Name the window in the filename, so three downloads in a folder are
            // still tellable apart a week later.
            const stamp = params.from ? `${params.from.slice(0, 10)}_${(params.to ?? '').slice(0, 10)}` : 'all-time';
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="leaderboard_${stamp}.csv"`);
            res.send(header + body + '\n');
            return;
        }
        res.json(rows);
    });
    // GET /api/leaderboard/goal
    //
    // Deliberately a second call rather than a field on /api/leaderboard: that
    // route answers with a bare ARRAY and the Dashboard's "Weekly Top Contributors"
    // card consumes it as one. Wrapping it in an object to make room for the goal
    // would break that caller silently, for a value that changes about once a
    // quarter — so the goal gets its own tiny endpoint and the page fetches both in
    // parallel.
    //
    // Twin of the `leaderboardWeeklyGoalPoints` field on the public-share /clan
    // response; both go through resolveWeeklyGoalPoints so an unconfigured or
    // switched-off goal reads as null on either surface.
    router.get('/leaderboard/goal', (req, res) => {
        const clan = (0, clan_repo_js_1.getClanById)(req.clanId ?? 1);
        res.json({ weeklyPoints: (0, leaderboard_handler_js_1.resolveWeeklyGoalPoints)(clan) });
    });
    // ── Triumphal Gifts ────────────────────────────────────────────────
    // Bookkeeping-only endpoints. Triumphal chests live in their own
    // table, never count toward points, and don't appear in any normal
    // leaderboard / stats / export. Three GETs power the dedicated page.
    const isValidIso = (s) => !!s && !Number.isNaN(new Date(s).getTime());
    router.get('/triumphal/leaderboard', (req, res) => {
        const fromParam = typeof req.query.from === 'string' ? req.query.from : undefined;
        const toParam = typeof req.query.to === 'string' ? req.query.to : undefined;
        const from = isValidIso(fromParam) ? fromParam : undefined;
        const to = isValidIso(toParam) ? toParam : undefined;
        res.json(triumphalChestRepo.getLeaderboardForClan(req.clanId ?? 1, from, to));
    });
    router.get('/triumphal/chests', (req, res) => {
        const fromParam = typeof req.query.from === 'string' ? req.query.from : undefined;
        const toParam = typeof req.query.to === 'string' ? req.query.to : undefined;
        const from = isValidIso(fromParam) ? fromParam : undefined;
        const to = isValidIso(toParam) ? toParam : undefined;
        const limit = (0, parse_int_js_1.parseBoundedInt)(req.query.limit, 100, { min: 1, max: 1000 });
        const memberIdParam = req.query.memberId !== undefined
            ? (0, parse_int_js_1.parseBoundedInt)(req.query.memberId, 0, { min: 1 })
            : 0;
        const memberId = memberIdParam > 0 ? memberIdParam : undefined;
        res.json(triumphalChestRepo.getRecent(req.clanId ?? 1, limit, from, to, memberId));
    });
    router.get('/triumphal/stats', (req, res) => {
        const fromParam = typeof req.query.from === 'string' ? req.query.from : undefined;
        const toParam = typeof req.query.to === 'string' ? req.query.to : undefined;
        const from = isValidIso(fromParam) ? fromParam : undefined;
        const to = isValidIso(toParam) ? toParam : undefined;
        res.json(triumphalChestRepo.getStats(req.clanId ?? 1, from, to));
    });
    // ── Events ─────────────────────────────────────────────────────────
    // Read-only, all-roles, per-clan. The catalog (chest → event mapping)
    // is static; per-event data is aggregated from chest_records over the
    // ISO [from, to] game window (omit both for all-time).
    // GET /api/events — the event catalog for the sub-tab bar, each enriched
    // with a "next occurrence" schedule tag from the calendar feed (null for
    // events with no schedule, e.g. Citadels and Heroics, or when the feed is down).
    // A rolling-cycle event (Triumphal) is never "next" and never flagged live —
    // it always is — so it carries endsAt: when the current cycle resets.
    router.get('/events', async (_req, res) => {
        const summary = (0, event_catalog_js_1.getEventCatalogSummary)();
        const events = await Promise.all(summary.map(async (e) => {
            try {
                const { next, live, cycleEndsAt } = await (0, event_calendar_js_1.getEventSchedule)(e.key);
                return {
                    ...e,
                    nextFrom: next?.from ?? null,
                    nextLabel: next?.label ?? null,
                    live,
                    endsAt: cycleEndsAt,
                };
            }
            catch {
                return { ...e, nextFrom: null, nextLabel: null, live: false, endsAt: null };
            }
        }));
        res.json({ events });
    });
    // GET /api/events/:key/occurrences — per-occurrence timeframe windows for
    // the event's selector, newest first. Events with a calendar mapping
    // (Ancients, Ragnarok, Olympus, Dark Omens, Runics) return mode:'occurrences';
    // a rolling-cycle event (Triumphal) returns mode:'cycle' — same windows, but
    // the page skips the per-window "live" marker since the newest cycle always
    // is. Anything else (Citadels, Heroics) returns mode:'fixed' so the page keeps
    // the classic Weekly/Monthly selector. A feed outage returns an empty list
    // (unavailable:true) which the page also treats as the fixed fallback.
    router.get('/events/:key/occurrences', async (req, res) => {
        const key = String(req.params.key || '').trim();
        const def = (0, event_catalog_js_1.getEventDef)(key);
        if (!def)
            return res.status(404).json({ error: 'Unknown event' });
        const mode = def.cycle ? 'cycle' : 'occurrences';
        if (!def.cycle && !def.calendarNames?.length) {
            return res.json({ mode: 'fixed', occurrences: [] });
        }
        try {
            const occurrences = await (0, event_calendar_js_1.getEventOccurrences)(key, req.clanId ?? 1);
            res.json({ mode, occurrences });
        }
        catch {
            res.json({ mode, occurrences: [], unavailable: true });
        }
    });
    // GET /api/events/:key/series?limit=8 — the same event, run over run.
    //
    // "How does this cycle compare to the last one" is the question a leader
    // actually has about an event, and every calendar-window delta answers it
    // with noise: a week containing Ragnarok against a week that doesn't is not a
    // comparison, it is a coincidence of the calendar. Only occurrence-to-
    // occurrence is honest.
    //
    // Server-side and capped. Done on the client this would be N round trips and
    // N cache entries; here it is one of each, and the cap stops a clan with a
    // year of history asking for fifty aggregations to draw eight bars.
    router.get('/events/:key/series', async (req, res) => {
        const key = String(req.params.key || '').trim();
        const def = (0, event_catalog_js_1.getEventDef)(key);
        if (!def)
            return res.status(404).json({ error: 'Unknown event' });
        const limit = (0, parse_int_js_1.parseBoundedInt)(req.query.limit, 8, { min: 2, max: 20 });
        const clanId = req.clanId ?? 1;
        // A schedule-less event (Citadels, Heroics) has no occurrences to compare,
        // and neither does a clan whose calendar feed is down. Both answer with an
        // empty series rather than an error — the card simply doesn't draw.
        if (!def.cycle && !def.calendarNames?.length) {
            return res.json({ mode: 'fixed', runs: [] });
        }
        let occurrences;
        try {
            occurrences = await (0, event_calendar_js_1.getEventOccurrences)(key, clanId);
        }
        catch {
            return res.json({ mode: def.cycle ? 'cycle' : 'occurrences', runs: [], unavailable: true });
        }
        const recent = occurrences.slice(0, limit);
        const runs = recent.map((occ) => {
            const breakdown = eventRepo.getEventBreakdown(key, clanId, occ.from, occ.to);
            return {
                label: occ.label,
                from: occ.from,
                to: occ.to,
                isCurrent: !!occ.isCurrent,
                // Null rather than 0 for a run with no data at all: the event may
                // predate this clan's history, and drawing that as a zero says the
                // clan turned up and scored nothing.
                chests: breakdown ? breakdown.totalChests : null,
                points: breakdown ? breakdown.totalPoints : null,
                participants: breakdown ? breakdown.uniqueParticipants : null,
            };
        }).reverse();
        res.json({ mode: def.cycle ? 'cycle' : 'occurrences', runs });
    });
    // GET /api/events/:key?from=&to= — one event's per-player breakdown.
    router.get('/events/:key', (req, res) => {
        const fromParam = typeof req.query.from === 'string' ? req.query.from : undefined;
        const toParam = typeof req.query.to === 'string' ? req.query.to : undefined;
        const from = isValidIso(fromParam) ? fromParam : undefined;
        const to = isValidIso(toParam) ? toParam : undefined;
        const result = eventRepo.getEventBreakdown(String(req.params.key || '').trim(), req.clanId ?? 1, from, to);
        if (!result)
            return res.status(404).json({ error: 'Unknown event' });
        res.json(result);
    });
    // GET /api/events/:key/member/:memberId?from=&to= — one member's chest
    // breakdown within an event (for the expandable participant row).
    router.get('/events/:key/member/:memberId', (req, res) => {
        const memberId = (0, parse_int_js_1.parseBoundedInt)(req.params.memberId, 0, { min: 1 });
        if (!memberId)
            return res.status(400).json({ error: 'Invalid member id' });
        const fromParam = typeof req.query.from === 'string' ? req.query.from : undefined;
        const toParam = typeof req.query.to === 'string' ? req.query.to : undefined;
        const from = isValidIso(fromParam) ? fromParam : undefined;
        const to = isValidIso(toParam) ? toParam : undefined;
        const rows = eventRepo.getEventMemberDetail(String(req.params.key || '').trim(), req.clanId ?? 1, memberId, from, to);
        res.json({ rows });
    });
    // Scan-error text/phase are operator information: GET /status already
    // strips lastScanError from non-admins (see the isAdminish gate there).
    // The session rows carry the same errorMessage/errorPhase, so redact
    // them for non-admins here too, keeping the two surfaces consistent.
    // (Counts, timestamps and status stay visible so members still see
    // scan history.)
    const redactSessionErrors = (session, isAdminish) => (isAdminish ? session : { ...session, errorMessage: null, errorPhase: null });
    // GET /api/sessions
    router.get('/sessions', (req, res) => {
        const limit = (0, parse_int_js_1.parseBoundedInt)(req.query.limit, 20, { min: 1, max: 500 });
        const isAdminish = req.user?.role === 'admin' || req.user?.role === 'superadmin';
        const sessions = sessionRepo.getRecentSessions(limit, req.clanId ?? 1);
        res.json(sessions.map((s) => redactSessionErrors(s, isAdminish)));
    });
    // GET /api/sessions/:id - return one session along with the chest records
    // captured during it. Used by the Scan History detail view.
    router.get('/sessions/:id', (req, res) => {
        const id = (0, parse_int_js_1.parseBoundedInt)(req.params.id, 0, { min: 1 });
        if (!id) {
            return res.status(400).json({ error: 'Invalid session id' });
        }
        const session = sessionRepo.getSessionById(id, req.clanId ?? 1);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }
        const isAdminish = req.user?.role === 'admin' || req.user?.role === 'superadmin';
        const chests = chestRepo.getChestsBySession(id, req.clanId ?? 1);
        const triumphalChests = triumphalChestRepo.getBySession(id, req.clanId ?? 1);
        res.json({ session: redactSessionErrors(session, isAdminish), chests, triumphalChests });
    });
    // DELETE /api/sessions/:id - remove a scan session and all chests it produced
    // (superadmin only). Used when a scan recorded chests that were never
    // actually claimed (e.g. another browser kicked the game session mid-scan,
    // so the claim step silently failed but the rows were still inserted).
    router.delete('/sessions/:id', auth_js_1.requireSuperAdmin, (req, res) => {
        const id = (0, parse_int_js_1.parseBoundedInt)(req.params.id, 0, { min: 1 });
        if (!id) {
            return res.status(400).json({ error: 'Invalid session id' });
        }
        const session = sessionRepo.getSessionById(id, req.clanId ?? 1);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }
        const deletedChests = chestRepo.deleteChestsBySession(id, req.clanId ?? 1);
        const deletedTriumphals = triumphalChestRepo.deleteBySession(id, req.clanId ?? 1);
        const deletedSessions = sessionRepo.deleteSessionById(id, req.clanId ?? 1);
        (0, user_repo_js_1.logAction)(req.user.id, 'delete_scan_session', {
            sessionId: id,
            startedAt: session.startedAt,
            deletedChests,
            deletedTriumphals,
            deletedSessions,
        });
        res.json({ ok: true, deletedChests, deletedTriumphals, deletedSessions });
    });
    // POST /api/scan - trigger manual scan (superadmin only)
    // Returns immediately with { started: true } and lets the scan run in
    // the background. A scan takes several minutes, longer than most browsers
    // and reverse proxies will hold an idle HTTP connection. The frontend
    // polls /api/status to know when it's done.
    router.post('/scan', auth_js_1.requireSuperAdmin, (req, res) => {
        if (!scanLoop) {
            return res.status(503).json({ error: 'Scanner not available' });
        }
        if (scanLoop.isScanInProgress()) {
            return res.status(409).json({ error: 'A scan is already in progress', alreadyRunning: true });
        }
        // Two manual-scan modes:
        //   - default: scope to the clan the superadmin currently has selected
        //     in the dropdown (req.clanId resolves via the session's active
        //     clan). Hot-swaps the browser to that clan if needed.
        //   - { allClans: true }: iterate every active clan, same path the
        //     scheduled cycle uses. Useful when the operator wants to refresh
        //     every clan outside the normal interval.
        const allClans = req.body?.allClans === true;
        const targetClanId = req.clanId ?? undefined;
        // Onboarding gate: refuse to start a chest scan until calibration
        // is done AND the target clan(s) have a captured member list. Both
        // checks are also enforced inside the scan loop itself, but failing
        // here gives the client a clear, actionable JSON error instead of
        // a generic "scan failed" toast after several seconds of browser
        // launch overhead.
        if (!(0, calibration_js_1.isFullyCalibrated)()) {
            return res.status(409).json({
                error: 'Calibrate the scanner before running any scan. Open Admin → Scanner Mode → Calibrate and complete every stage.',
                nextStep: 'calibrate',
            });
        }
        if (allClans) {
            const pending = (0, clan_repo_js_1.listClans)({ activeOnly: true }).filter((c) => (0, member_capture_js_1.needsMemberCapture)(c.id));
            if (pending.length > 0) {
                return res.status(409).json({
                    error: `Capture the member list for clan${pending.length > 1 ? 's' : ''} ${pending.map((c) => `"${c.name}"`).join(', ')} before running a scan.`,
                    nextStep: 'capture-members',
                    clanIds: pending.map((c) => c.id),
                });
            }
        }
        else if (targetClanId && (0, member_capture_js_1.needsMemberCapture)(targetClanId)) {
            return res.status(409).json({
                error: 'Capture the clan member list before running a scan. Open Clans → Capture members.',
                nextStep: 'capture-members',
                clanId: targetClanId,
            });
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'trigger_manual_scan', {
            username: req.user.username,
            mode: allClans ? 'all-clans' : 'single-clan',
            clanId: allClans ? null : targetClanId ?? null,
        });
        if (allClans) {
            scanLoop.triggerManualScanAllClans().catch((err) => {
                console.error('Manual scan-all failed in background:', err);
            });
            res.json({ started: true, mode: 'all-clans' });
            return;
        }
        scanLoop.triggerManualScan(targetClanId).catch((err) => {
            console.error('Manual scan failed in background:', err);
        });
        res.json({ started: true, mode: 'single-clan', clanId: targetClanId ?? null });
    });
    // POST /api/admin/clear-last-scan-error — dismiss the header error badge
    // without waiting for the next successful scan to wipe it.
    //
    // Superadmin-only to match the System page (the sole caller, gated
    // superadmin client-side). A clan admin curl'ing this would only
    // clear a cosmetic flag — no data exposure — but the inconsistent
    // gate is the kind of thing security audits flag, so keep it tight.
    router.post('/admin/clear-last-scan-error', auth_js_1.requireSuperAdmin, (req, res) => {
        if (!scanLoop) {
            return res.status(503).json({ error: 'Scanner not available' });
        }
        const prev = scanLoop.getLastScanError();
        scanLoop.clearLastScanError();
        if (prev) {
            (0, user_repo_js_1.logAction)(req.user.id, 'clear_last_scan_error', {
                phase: prev.phase,
                message: prev.message,
                clanId: prev.clanId,
            });
        }
        res.json({ ok: true, cleared: prev !== null });
    });
    // ─── Scanner calibration (one-by-one pipelined scanner) ───
    // The scanner refuses to run until the operator has completed the
    // Calibrate flow (Open-button click target + OCR crop rectangle).
    // GET /api/admin/scanner-settings - debug N + whether calibration is done.
    router.get('/admin/scanner-settings', auth_js_1.requireSuperAdmin, (_req, res) => {
        (0, index_js_1.resetConfig)();
        const config = (0, index_js_1.loadConfig)();
        const clickCalibrated = config.scanOpenButtonXPct > 0 && config.scanOpenButtonYPct > 0;
        const cropCalibrated = config.scanCropLeftPct > 0
            && config.scanCropTopPct > 0
            && config.scanCropRightPct > config.scanCropLeftPct
            && config.scanCropBottomPct > config.scanCropTopPct;
        res.json({
            scanDebugFirstN: config.scanDebugFirstN,
            scanMaxChests: config.scanMaxChests,
            calibrated: clickCalibrated && cropCalibrated,
            clickCalibrated,
            cropCalibrated,
            openButtonXPct: config.scanOpenButtonXPct,
            openButtonYPct: config.scanOpenButtonYPct,
            cropLeftPct: config.scanCropLeftPct,
            cropTopPct: config.scanCropTopPct,
            cropRightPct: config.scanCropRightPct,
            cropBottomPct: config.scanCropBottomPct,
        });
    });
    // PUT /api/admin/scanner-settings { scanDebugFirstN, scanMaxChests? }
    //
    // scanMaxChests is the runaway-loop ceiling on one sweep, not a target: a
    // healthy sweep ends when the tab runs dry well below it. The bounds mirror
    // configSchema.scanMaxChests, and the page sends the field only when it has
    // a value, so an older cached bundle can't reset the cap to the default.
    router.put('/admin/scanner-settings', auth_js_1.requireSuperAdmin, (req, res) => {
        try {
            const scanDebugFirstN = (0, parse_int_js_1.parseBoundedInt)(req.body?.scanDebugFirstN, 10, { min: 0, max: 100 });
            const scanMaxChests = req.body?.scanMaxChests === undefined
                ? undefined
                : (0, parse_int_js_1.parseBoundedInt)(req.body.scanMaxChests, 2000, { min: 100, max: 10_000 });
            (0, persistent_env_js_1.updateEnvValue)('SCAN_DEBUG_FIRST_N', String(scanDebugFirstN));
            if (scanMaxChests !== undefined) {
                (0, persistent_env_js_1.updateEnvValue)('SCAN_MAX_CHESTS', String(scanMaxChests));
            }
            (0, index_js_1.resetConfig)();
            if (scanLoop) {
                scanLoop.setScannerSettings({ scanDebugFirstN, scanMaxChests });
            }
            (0, user_repo_js_1.logAction)(req.user.id, 'update_scanner_settings', { scanDebugFirstN, scanMaxChests });
            res.json({ ok: true, scanDebugFirstN, scanMaxChests: scanMaxChests ?? (0, index_js_1.loadConfig)().scanMaxChests });
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // PUT /api/admin/settings/raw-ocr-capture { enabled }
    //
    // Toggle the forensic "persist raw OCR'd player name on every chest
    // record" feature. When disabled, also purges any previously-captured
    // values so the column doesn't sit there eating space after the
    // operator is done investigating.
    router.put('/admin/settings/raw-ocr-capture', auth_js_1.requireSuperAdmin, (req, res) => {
        const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
        (0, persistent_env_js_1.updateEnvValue)('ENABLE_RAW_OCR_CAPTURE', enabled ? 'true' : 'false');
        (0, index_js_1.resetConfig)();
        let purged = { chestRecords: 0, triumphalChestRecords: 0 };
        if (!enabled) {
            purged = chestRepo.purgeRawPlayerOcr();
        }
        if (scanLoop) {
            scanLoop.setScannerSettings({ enableRawOcrCapture: enabled });
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'update_raw_ocr_capture', { enabled, purged });
        res.json({ ok: true, enabled, purged });
    });
    // GET /api/admin/settings/raw-ocr-capture
    //
    // Returns the current toggle state and a quick count of how many
    // captured rows exist (used by the System page to decide whether to
    // surface a "captured X rows" hint next to the toggle).
    router.get('/admin/settings/raw-ocr-capture', auth_js_1.requireSuperAdmin, (_req, res) => {
        const cfg = (0, index_js_1.loadConfig)();
        const counts = chestRepo.getRawPlayerOcrCounts();
        res.json({
            enabled: cfg.enableRawOcrCapture,
            capturedCounts: counts,
        });
    });
    // GET /api/members/:id/raw-ocr?limit=&source=chests|triumphals
    //
    // Recent raw OCR strings that resolved to this member. Superadmin
    // only — mirrors the System-page toggle that controls capture.
    // Returns empty when the capture toggle has never been on (or was
    // on then disabled+purged).
    //
    // `source` selects which scan path's captures to return:
    //   - 'chests'     → normal gift chests (default)
    //   - 'triumphals' → triumphal chests
    // The member detail page passes whichever tab the operator is
    // viewing so the captures it shows match the rows above.
    router.get('/members/:id/raw-ocr', auth_js_1.requireSuperAdmin, (req, res) => {
        const memberId = (0, parse_int_js_1.parseBoundedInt)(req.params.id, 0, { min: 1 });
        if (!memberId)
            return res.status(400).json({ error: 'Invalid member id' });
        const limit = (0, parse_int_js_1.parseBoundedInt)(req.query.limit, 50, { min: 1, max: 500 });
        const source = req.query.source === 'triumphals' ? 'triumphals' : 'chests';
        const clanId = req.clanId ?? 1;
        const memberClanId = memberRepo.getMemberClanId(memberId);
        if (memberClanId !== null && memberClanId !== clanId) {
            return res.status(404).json({ error: 'Member not found' });
        }
        const rows = source === 'triumphals'
            ? triumphalChestRepo.getRawPlayerOcrForMember(memberId, clanId, limit)
            : chestRepo.getRawPlayerOcrForMember(memberId, clanId, limit);
        res.json({ source, rows });
    });
    /**
     * Automated resource-history capture: an INSTANCE-WIDE feature switch.
     *
     * Lives here, next to the other global scanner settings, rather than on the
     * clan-scoped /api/resources router where it started. That was a genuine design
     * error: a switch affecting every clan was reachable from one clan's page, so a
     * superadmin looking at clan #2 could silently change behaviour for all of them.
     * Per-clan opt-in is a different setting — clans.resources_enabled — and this
     * phase honours both.
     */
    router.get('/admin/resource-capture', auth_js_1.requireSuperAdmin, (_req, res) => {
        (0, index_js_1.resetConfig)();
        res.json({
            enabled: (0, index_js_1.loadConfig)().resourceCaptureEnabled,
            calibrated: (0, calibration_js_1.isResourceHistoryCalibrated)(),
            missingTargets: (0, calibration_js_1.missingResourceHistoryTargets)(),
        });
    });
    /**
     * Turn the daily capture on or off for the whole instance.
     *
     * Persists to data/app.env (survives a container recreate, unlike .env) and pushes
     * the value into the running ScanLoop so it applies on the next cycle without a
     * restart — same pattern as might tracking. Turning it off only stops further
     * capture; nothing recorded is removed, because resource history is the entire
     * point of the feature and a toggle must not be able to destroy it.
     */
    router.put('/admin/resource-capture', auth_js_1.requireSuperAdmin, (req, res) => {
        const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
        if (enabled && !(0, calibration_js_1.isResourceHistoryCalibrated)()) {
            return res.status(400).json({
                error: 'Cannot enable automated collection before it is calibrated. Outstanding: '
                    + `${(0, calibration_js_1.missingResourceHistoryTargets)().join('; ')}.`,
            });
        }
        (0, persistent_env_js_1.updateEnvValue)('RESOURCE_CAPTURE_ENABLED', enabled ? 'true' : 'false');
        (0, index_js_1.resetConfig)();
        scanLoop?.setScannerSettings({ resourceCaptureEnabled: enabled });
        (0, user_repo_js_1.logAction)(req.user.id, 'update_resource_capture', { enabled });
        res.json({ ok: true, enabled, calibrated: (0, calibration_js_1.isResourceHistoryCalibrated)() });
    });
    // ─── Multi-stage calibration wizard endpoints ───
    // The wizard walks the operator through three stages (main map, gifts
    // panel, members list). Each stage captures its own screenshot and
    // saves a slice of the calibration fields without disturbing the
    // others. Operator-driven navigation between stages avoids the
    // chicken-and-egg problem of needing calibrated positions to navigate
    // to the screen where they get calibrated.
    /** GET /api/admin/calibration
     *  Returns the full calibration state for the wizard:
     *  every field's current value plus a per-stage `complete` flag
     *  computed from the same predicate the runtime uses to refuse. */
    router.get('/admin/calibration', auth_js_1.requireSuperAdmin, (_req, res) => {
        (0, index_js_1.resetConfig)();
        const cfg = (0, index_js_1.loadConfig)();
        const isPosSet = (x, y) => x > 0 && y > 0;
        // One definition of stage completeness, shared with the /status banner —
        // see calibrationStageStatus(). This route used to carry its own copy of
        // the rules, which is two places to update when a stage gains a target.
        const stageStatus = (0, calibration_js_1.calibrationStageStatus)();
        const byKey = Object.fromEntries(stageStatus.map((s) => [s.key, s]));
        res.json({
            stages: {
                main: { complete: byKey.main.complete },
                sidebars: { complete: byKey.sidebars.complete },
                gifts: { complete: byKey.gifts.complete },
                members: { complete: byKey.members.complete },
                worldmap: { complete: byKey.worldmap.complete },
                capital: { complete: byKey.capital.complete },
                // The ordered list the UI renders its checklist from: key, number,
                // label, whether a scan needs it, whether it's done.
                list: stageStatus,
                requiredProgress: (0, calibration_js_1.requiredCalibrationProgress)(),
                // Triumphal is optional — surface its calibration state separately
                // so the UI can show a "skipped" badge.
                triumphalSet: isPosSet(cfg.uiTriumphalTabXPct, cfg.uiTriumphalTabYPct),
                // The MAP button is Stage 1's optional target, needed only by the
                // resource-history chain. Reported separately for the same reason.
                worldMapSet: isPosSet(cfg.uiWorldMapButtonXPct, cfg.uiWorldMapButtonYPct),
                // One flag the Resources page can consult without re-deriving the chain.
                resourceHistoryReady: (0, calibration_js_1.isResourceHistoryCalibrated)(),
            },
            fields: {
                uiClanButtonXPct: cfg.uiClanButtonXPct,
                uiClanButtonYPct: cfg.uiClanButtonYPct,
                uiGiftsSidebarXPct: cfg.uiGiftsSidebarXPct,
                uiGiftsSidebarYPct: cfg.uiGiftsSidebarYPct,
                uiGiftsTabXPct: cfg.uiGiftsTabXPct,
                uiGiftsTabYPct: cfg.uiGiftsTabYPct,
                uiTriumphalTabXPct: cfg.uiTriumphalTabXPct,
                uiTriumphalTabYPct: cfg.uiTriumphalTabYPct,
                uiMembersSidebarXPct: cfg.uiMembersSidebarXPct,
                uiMembersSidebarYPct: cfg.uiMembersSidebarYPct,
                scanOpenButtonXPct: cfg.scanOpenButtonXPct,
                scanOpenButtonYPct: cfg.scanOpenButtonYPct,
                scanCropLeftPct: cfg.scanCropLeftPct,
                scanCropTopPct: cfg.scanCropTopPct,
                scanCropRightPct: cfg.scanCropRightPct,
                scanCropBottomPct: cfg.scanCropBottomPct,
                memberListCropLeftPct: cfg.memberListCropLeftPct,
                memberListCropTopPct: cfg.memberListCropTopPct,
                memberListCropRightPct: cfg.memberListCropRightPct,
                memberListCropBottomPct: cfg.memberListCropBottomPct,
                uiWorldMapButtonXPct: cfg.uiWorldMapButtonXPct,
                uiWorldMapButtonYPct: cfg.uiWorldMapButtonYPct,
                uiClanCapitalButtonXPct: cfg.uiClanCapitalButtonXPct,
                uiClanCapitalButtonYPct: cfg.uiClanCapitalButtonYPct,
                uiClanCapitalMarkerXPct: cfg.uiClanCapitalMarkerXPct,
                uiClanCapitalMarkerYPct: cfg.uiClanCapitalMarkerYPct,
                uiCapitalHistorySidebarXPct: cfg.uiCapitalHistorySidebarXPct,
                uiCapitalHistorySidebarYPct: cfg.uiCapitalHistorySidebarYPct,
                resourceHistoryCropLeftPct: cfg.resourceHistoryCropLeftPct,
                resourceHistoryCropTopPct: cfg.resourceHistoryCropTopPct,
                resourceHistoryCropRightPct: cfg.resourceHistoryCropRightPct,
                resourceHistoryCropBottomPct: cfg.resourceHistoryCropBottomPct,
            },
        });
    });
    /** POST /api/admin/calibration/screenshot?stage=main|gifts|members
     *  Kicks off a background screenshot capture for the requested stage.
     *  Operator must have manually navigated to the right screen first —
     *  we do not auto-navigate (the navigation chain itself depends on
     *  calibration that may not yet exist). Polled via the status route. */
    router.post('/admin/calibration/screenshot', auth_js_1.requireSuperAdmin, (req, res) => {
        if (!scanLoop) {
            return res.status(503).json({ error: 'Scanner not available' });
        }
        if (calibrationJob && calibrationJob.status === 'running') {
            return res.status(409).json({
                error: 'A calibration capture is already in progress. Wait for it to finish or refresh.',
            });
        }
        const stage = parseStage(req.query.stage ?? req.body?.stage);
        // Optional in-flight nav overrides — the wizard sends marks the
        // operator has clicked in the browser but hasn't saved yet. Only
        // accept a known shape; anything else is ignored, so a malformed
        // body can't make us click random pixels.
        const rawOverrides = (req.body?.overrides ?? {});
        const isPctPair = (v) => {
            if (!v || typeof v !== 'object')
                return false;
            const o = v;
            return typeof o.xPct === 'number' && typeof o.yPct === 'number'
                && o.xPct >= 0 && o.xPct <= 1 && o.yPct >= 0 && o.yPct <= 1;
        };
        const overrides = {};
        for (const name of [
            'clanButton', 'giftsSidebar', 'membersSidebar',
            'worldMapButton', 'clanCapitalButton', 'clanCapitalMarker', 'capitalHistorySidebar',
        ]) {
            const value = rawOverrides[name];
            if (isPctPair(value))
                overrides[name] = value;
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'capture_calibration_screenshot', {
            stage,
            overrides: Object.keys(overrides),
        });
        calibrationJob = {
            status: 'running',
            startedAt: Date.now(),
            finishedAt: null,
            error: null,
            warning: null,
            canvasBounds: null,
            stage,
        };
        scanLoop.captureCalibrationScreenshot(stage, overrides)
            .then((result) => {
            calibrationJob = result.ok
                ? {
                    status: 'done',
                    startedAt: calibrationJob?.startedAt ?? Date.now(),
                    finishedAt: Date.now(),
                    error: null,
                    warning: result.warning ?? null,
                    canvasBounds: result.canvasBounds ?? null,
                    stage,
                }
                : {
                    status: 'error',
                    startedAt: calibrationJob?.startedAt ?? Date.now(),
                    finishedAt: Date.now(),
                    error: result.error || 'Calibration capture failed',
                    warning: null,
                    canvasBounds: null,
                    stage,
                };
        })
            .catch((err) => {
            calibrationJob = {
                status: 'error',
                startedAt: calibrationJob?.startedAt ?? Date.now(),
                finishedAt: Date.now(),
                error: String(err instanceof Error ? err.message : err),
                warning: null,
                canvasBounds: null,
                stage,
            };
        });
        res.json({ started: true, stage });
    });
    /** GET /api/admin/calibration/screenshot/status
     *  Polled by the wizard after kicking off a capture. Reports current
     *  job state and (on done) the canvas bounds + image URL for the
     *  stage that was just captured. Recovery path: if no job is in
     *  flight but a stage screenshot + sidecar exist on disk, surface
     *  them as a `done` result so the operator can resume across
     *  process restarts without re-running the slow capture. */
    router.get('/admin/calibration/screenshot/status', auth_js_1.requireSuperAdmin, (req, res) => {
        if (calibrationJob) {
            const elapsedMs = (calibrationJob.finishedAt ?? Date.now()) - calibrationJob.startedAt;
            if (calibrationJob.status === 'running') {
                return res.json({ status: 'running', elapsedMs, stage: calibrationJob.stage });
            }
            if (calibrationJob.status === 'error') {
                return res.json({
                    status: 'error',
                    elapsedMs,
                    stage: calibrationJob.stage,
                    error: calibrationJob.error,
                });
            }
            return res.json({
                status: 'done',
                elapsedMs,
                stage: calibrationJob.stage,
                warning: calibrationJob.warning,
                canvasBounds: calibrationJob.canvasBounds,
                imageUrl: `/api/admin/calibration/image?stage=${calibrationJob.stage}&t=${calibrationJob.finishedAt}`,
            });
        }
        // Recovery: if the operator passed a stage but no in-memory job exists,
        // try the on-disk sidecar for that stage.
        const requestedStage = parseStage(req.query.stage, 'gifts');
        const imagePath = calibrationImagePath(requestedStage);
        const metaPath = calibrationMetaPath(requestedStage);
        if (fs_1.default.existsSync(imagePath) && fs_1.default.existsSync(metaPath)) {
            try {
                const meta = JSON.parse(fs_1.default.readFileSync(metaPath, 'utf8'));
                if (meta && typeof meta === 'object' && meta.canvasBounds) {
                    const stat = fs_1.default.statSync(imagePath);
                    return res.json({
                        status: 'done',
                        elapsedMs: 0,
                        stage: requestedStage,
                        canvasBounds: meta.canvasBounds,
                        imageUrl: `/api/admin/calibration/image?stage=${requestedStage}&t=${stat.mtimeMs}`,
                        recovered: true,
                    });
                }
            }
            catch {
                // Sidecar corrupt — fall through to idle
            }
        }
        res.json({ status: 'idle' });
    });
    /** GET /api/admin/calibration/image?stage=... — serves the saved PNG. */
    router.get('/admin/calibration/image', auth_js_1.requireSuperAdmin, (req, res) => {
        const stage = parseStage(req.query.stage, 'gifts');
        const imagePath = calibrationImagePath(stage);
        if (!fs_1.default.existsSync(imagePath)) {
            return res.status(404).json({
                error: `No calibration screenshot saved for stage '${stage}' yet. Click Capture first.`,
            });
        }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        fs_1.default.createReadStream(imagePath).pipe(res);
    });
    /** POST /api/admin/calibration/reset
     *  Body: { stage }
     *
     *  Zero every field belonging to one stage, putting it back to uncalibrated.
     *
     *  Needed because a saved mark can be *corrected* by re-marking and saving, but
     *  never *removed* — and some marks need removing rather than moving: a
     *  Triumphal tab marked on a clan that has none, or an optional
     *  resource-collection target set by mistake, both leave a non-zero value that
     *  makes the runtime think a target exists where it doesn't. Re-saving can't
     *  express "nothing here"; the save route deliberately rejects zeros so a
     *  half-built payload can't silently wipe calibration.
     *
     *  Scoped to one stage on purpose: an all-stages reset would be one misclick
     *  away from taking chest scanning down. */
    router.post('/admin/calibration/reset', auth_js_1.requireSuperAdmin, (req, res) => {
        const stage = parseStage(req.body?.stage, 'main');
        if (req.body?.stage !== stage) {
            return res.status(400).json({ error: `Unknown calibration stage: ${String(req.body?.stage)}` });
        }
        try {
            for (const field of CALIBRATION_STAGE_FIELDS[stage]) {
                (0, persistent_env_js_1.updateEnvValue)(CALIBRATION_FIELD_ENV[field], '0');
            }
            (0, index_js_1.resetConfig)();
            if (scanLoop) {
                const zeroed = Object.fromEntries(CALIBRATION_STAGE_FIELDS[stage].map((f) => [f, 0]));
                scanLoop.setCalibration(zeroed);
            }
            (0, user_repo_js_1.logAction)(req.user.id, 'reset_calibration', { stage });
            res.json({ ok: true, stage, cleared: CALIBRATION_STAGE_FIELDS[stage] });
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    /** PUT /api/admin/calibration
     *  Body: { stage: 'main'|'gifts'|'members', fields: { ... } }
     *  Validates that all fields belong to the named stage (refuses
     *  cross-stage writes), then persists each via updateEnvValue and
     *  live-updates the running ScanLoop. Validation is per-stage so
     *  callers can save partial calibrations without first satisfying
     *  every requirement of every stage. */
    router.put('/admin/calibration', auth_js_1.requireSuperAdmin, (req, res) => {
        const stage = parseStage(req.body?.stage);
        const fields = (req.body?.fields ?? {});
        const inUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1;
        const inUnitOrZero = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 1;
        // Field whitelist per stage. Anything not on the list is rejected
        // so a buggy client can't sneak a cross-stage write past validation.
        // Stage 2 ("sidebars") and Stage 3 ("gifts") used to be one stage
        // but were split because the sidebars are visible from any My Clan
        // sub-section while the panel-specific targets (Open button, card
        // crop, top tabs) need the Gifts sub-section open.
        const allowedKeys = CALIBRATION_STAGE_FIELDS;
        // Triumphal is optional — 0 means "this clan has no Triumphal tab".
        // Crop rectangles must satisfy right > left and bottom > top.
        const optionalZeroKeys = new Set(['uiTriumphalTabXPct', 'uiTriumphalTabYPct']);
        for (const [key, value] of Object.entries(fields)) {
            if (!allowedKeys[stage].includes(key)) {
                return res.status(400).json({ error: `Field '${key}' is not part of stage '${stage}'` });
            }
            const isValid = optionalZeroKeys.has(key) ? inUnitOrZero(value) : inUnit(value);
            if (!isValid) {
                return res.status(400).json({
                    error: `Field '${key}' must be a number ${optionalZeroKeys.has(key) ? '0..1' : 'strictly between 0 and 1'}`,
                });
            }
        }
        // Stage-specific cross-field validation: rectangles must be valid.
        if (stage === 'gifts') {
            const l = fields.scanCropLeftPct;
            const t = fields.scanCropTopPct;
            const r = fields.scanCropRightPct;
            const b = fields.scanCropBottomPct;
            if (l !== undefined && r !== undefined && r <= l) {
                return res.status(400).json({ error: 'scanCropRightPct must be > scanCropLeftPct' });
            }
            if (t !== undefined && b !== undefined && b <= t) {
                return res.status(400).json({ error: 'scanCropBottomPct must be > scanCropTopPct' });
            }
        }
        if (stage === 'members') {
            const l = fields.memberListCropLeftPct;
            const t = fields.memberListCropTopPct;
            const r = fields.memberListCropRightPct;
            const b = fields.memberListCropBottomPct;
            if (r <= l)
                return res.status(400).json({ error: 'memberListCropRightPct must be > memberListCropLeftPct' });
            if (b <= t)
                return res.status(400).json({ error: 'memberListCropBottomPct must be > memberListCropTopPct' });
        }
        // Stage 6 saves in two passes (History first, then the rectangle once History
        // is open), so the rectangle fields can legitimately be absent — validate the
        // ordering only when they're actually present.
        if (stage === 'capital') {
            const l = fields.resourceHistoryCropLeftPct;
            const t = fields.resourceHistoryCropTopPct;
            const r = fields.resourceHistoryCropRightPct;
            const b = fields.resourceHistoryCropBottomPct;
            if (l !== undefined && r !== undefined && r <= l) {
                return res.status(400).json({ error: 'resourceHistoryCropRightPct must be > resourceHistoryCropLeftPct' });
            }
            if (t !== undefined && b !== undefined && b <= t) {
                return res.status(400).json({ error: 'resourceHistoryCropBottomPct must be > resourceHistoryCropTopPct' });
            }
        }
        // Persist each field. The env var name is the field name converted
        // to UPPER_SNAKE_CASE (e.g. uiClanButtonXPct → UI_CLAN_BUTTON_X_PCT).
        const fieldToEnv = CALIBRATION_FIELD_ENV;
        try {
            for (const [key, value] of Object.entries(fields)) {
                (0, persistent_env_js_1.updateEnvValue)(fieldToEnv[key], String(value));
            }
            // Saving Stage 4 stamps the member-list crop revision.
            //
            // Might tracking reads its numbers from this same rectangle, and every
            // instance calibrated before might tracking existed has a rectangle drawn
            // around the names column only — the power number sits to its right and
            // never enters the crop. Rather than let those instances run a daily
            // capture that can only ever come back empty, might capture refuses to
            // start until this revision is at least 1, which can only happen when an
            // operator has re-saved Stage 4 against the current instructions (which
            // now tell them to include the might column).
            if (stage === 'members') {
                const next = ((0, index_js_1.loadConfig)().memberListCropRevision || 0) + 1;
                (0, persistent_env_js_1.updateEnvValue)('MEMBER_LIST_CROP_REVISION', String(next));
            }
            (0, index_js_1.resetConfig)();
            if (scanLoop) {
                scanLoop.setCalibration(fields);
            }
            (0, user_repo_js_1.logAction)(req.user.id, 'save_calibration', { stage, fields });
            res.json({ ok: true, stage, fields });
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // GET /api/export/catalog - chest names, source keys, and admin corrections
    // as a single JSON file intended to be committed into the repo so new
    // deployments can seed KNOWN_CHESTS / SOURCE_POINTS without re-discovering
    // every OCR fix. Returned uncompressed so it diffs cleanly in source control.
    router.get('/export/catalog', auth_js_1.requireAdmin, (req, res) => {
        const data = (0, catalog_export_js_1.exportCatalog)(req.clanId ?? 1);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=chest-catalog-${timestamp}.json`);
        res.send(JSON.stringify(data, null, 2));
    });
    // GET /api/export/backup - full sqlite backup (superadmin only)
    // The .db file compresses very well (5-10x typical) because of zero-padded
    // pages and repeated text. Stream gzip the file rather than buffering the
    // entire thing in memory.
    router.get('/export/backup', auth_js_1.requireSuperAdmin, (_req, res) => {
        const dbPath = path_1.default.resolve(process.env.DB_PATH || './data/tb-chests.db');
        if (!fs_1.default.existsSync(dbPath)) {
            return res.status(404).json({ error: 'Database file not found' });
        }
        // Force a checkpoint for cleaner backup file in WAL mode.
        (0, database_js_1.getDb)().pragma('wal_checkpoint(TRUNCATE)');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Disposition', `attachment; filename=tb-chests-backup-${timestamp}.db.gz`);
        const fileStream = fs_1.default.createReadStream(dbPath);
        const gzipStream = zlib_1.default.createGzip({ level: 6 });
        fileStream.on('error', (err) => {
            res.status(500).end(`Backup failed: ${err.message}`);
        });
        fileStream.pipe(gzipStream).pipe(res);
    });
    // POST /api/import/backup-db { fileName, contentBase64 } - restore full sqlite backup (superadmin only)
    router.post('/import/backup-db', auth_js_1.requireSuperAdmin, (req, res) => {
        let tempPath = '';
        const dbPath = path_1.default.resolve(process.env.DB_PATH || './data/tb-chests.db');
        try {
            if (!scanLoop) {
                // In dashboard-only mode this is always safe. Keep check here for clarity.
            }
            else {
                const state = scanLoop.getState();
                if (state === enums_js_1.AppState.SCANNING || state === enums_js_1.AppState.PROCESSING || state === enums_js_1.AppState.NAVIGATING || state === enums_js_1.AppState.CHECKING_AUTH) {
                    return res.status(409).json({ error: `Cannot restore backup while scanner is active (${state}).` });
                }
            }
            const { fileName, contentBase64 } = parseDbBackupPayload(req.body);
            const lowerName = fileName.toLowerCase();
            if (!lowerName.endsWith('.db') && !lowerName.endsWith('.db.gz') && !lowerName.endsWith('.gz')) {
                return res.status(400).json({ error: 'Backup file must be a .db or .db.gz file' });
            }
            let buffer = Buffer.from(contentBase64, 'base64');
            if (buffer.length < 16) {
                return res.status(400).json({ error: 'Backup file is too small or invalid' });
            }
            if (buffer.length > 100 * 1024 * 1024) {
                return res.status(400).json({ error: 'Backup file too large (max 100MB)' });
            }
            // Auto-detect gzip and decompress. gzip files always start with 0x1f 0x8b.
            if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
                try {
                    buffer = zlib_1.default.gunzipSync(buffer);
                }
                catch (gzErr) {
                    return res.status(400).json({ error: `Failed to decompress gzip backup: ${String(gzErr)}` });
                }
                if (buffer.length > 200 * 1024 * 1024) {
                    return res.status(400).json({ error: 'Decompressed backup too large (max 200MB)' });
                }
            }
            const sqliteHeader = buffer.subarray(0, 16).toString('utf8');
            if (!sqliteHeader.startsWith('SQLite format 3')) {
                return res.status(400).json({ error: 'File does not appear to be a valid SQLite backup' });
            }
            const tempDir = path_1.default.resolve('data', 'backups', 'uploads');
            fs_1.default.mkdirSync(tempDir, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            tempPath = path_1.default.join(tempDir, `restore-${timestamp}-${path_1.default.basename(fileName)}`);
            fs_1.default.writeFileSync(tempPath, buffer);
            const validationDb = new better_sqlite3_1.default(tempPath, { readonly: true, fileMustExist: true });
            try {
                validationDb.prepare('PRAGMA schema_version').get();
            }
            finally {
                validationDb.close();
            }
            const preRestoreBackup = createPreImportBackup();
            (0, database_js_1.getDb)().pragma('wal_checkpoint(TRUNCATE)');
            (0, database_js_1.closeDb)();
            fs_1.default.copyFileSync(tempPath, dbPath);
            (0, database_js_1.initDatabase)(dbPath);
            (0, user_repo_js_1.logAction)(req.user.id, 'import_backup_db', {
                fileName,
                bytes: buffer.length,
                preRestoreBackup,
            });
            return res.json({
                ok: true,
                restoredFrom: fileName,
                bytes: buffer.length,
                preRestoreBackup,
            });
        }
        catch (err) {
            try {
                (0, database_js_1.initDatabase)(dbPath);
            }
            catch {
                // Best effort: if DB is already initialized this may throw, safe to ignore here.
            }
            return res.status(400).json({ error: `DB backup restore failed: ${String(err)}` });
        }
        finally {
            if (tempPath && fs_1.default.existsSync(tempPath)) {
                fs_1.default.unlinkSync(tempPath);
            }
        }
    });
    // GET /api/admin/backups - list server-side DB backup files (superadmin)
    // Powers the "Backups" card on the system page. Sorted newest-first
    // so the dashboard table can render directly.
    router.get('/admin/backups', auth_js_1.requireSuperAdmin, (_req, res) => {
        res.json({ backups: (0, db_backup_js_1.listBackups)() });
    });
    // POST /api/admin/backups - take an on-demand snapshot right now.
    // Same gzipped format as the daily/pre-action rotation; retained under
    // the per-kind `manual` policy (see db-backup.ts RETENTION).
    router.post('/admin/backups', auth_js_1.requireSuperAdmin, async (req, res, next) => {
        try {
            const fullPath = await (0, db_backup_js_1.createPreActionBackup)('manual');
            const fileName = path_1.default.basename(fullPath);
            const bytes = fs_1.default.statSync(fullPath).size;
            (0, user_repo_js_1.logAction)(req.user.id, 'create_manual_backup', { fileName, bytes });
            res.json({ ok: true, fileName, bytes });
        }
        catch (err) {
            next(err);
        }
    });
    // GET /api/admin/backups/download?file=<basename>
    // Download a single backup off the server's disk. Same path-safety
    // checks as the restore route (resolveBackupPath refuses anything
    // outside the backups directory).
    router.get('/admin/backups/download', auth_js_1.requireSuperAdmin, (req, res) => {
        const fileName = String(req.query.file ?? '').trim();
        if (!fileName)
            return res.status(400).json({ error: 'file query param is required' });
        const sourcePath = (0, db_backup_js_1.resolveBackupPath)(fileName);
        if (!sourcePath)
            return res.status(404).json({ error: 'Backup file not found' });
        const isGz = fileName.endsWith('.gz');
        res.setHeader('Content-Type', isGz ? 'application/gzip' : 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename=${path_1.default.basename(fileName)}`);
        fs_1.default.createReadStream(sourcePath).pipe(res);
    });
    // DELETE /api/admin/backups?file=<basename>
    // Remove a single backup off the server's disk. Same
    // resolveBackupPath guard as the other backup routes.
    router.delete('/admin/backups', auth_js_1.requireSuperAdmin, (req, res) => {
        const fileName = String(req.query.file ?? '').trim();
        if (!fileName)
            return res.status(400).json({ error: 'file query param is required' });
        const sourcePath = (0, db_backup_js_1.resolveBackupPath)(fileName);
        if (!sourcePath)
            return res.status(404).json({ error: 'Backup file not found' });
        fs_1.default.unlinkSync(sourcePath);
        (0, user_repo_js_1.logAction)(req.user.id, 'delete_backup', { fileName });
        res.json({ ok: true, fileName });
    });
    // POST /api/admin/backups/restore { fileName }
    // Restore from a backup that's already on the server's disk (i.e.
    // one created by the daily rotation or a pre-action snapshot). The
    // existing /api/import/backup-db handles uploaded files; this is the
    // one-click path so the operator doesn't have to download then
    // re-upload. Reuses the same validation/swap logic by reading the
    // file off disk into a buffer and routing through that flow.
    router.post('/admin/backups/restore', auth_js_1.requireSuperAdmin, (req, res) => {
        let tempPath = '';
        const dbPath = path_1.default.resolve(process.env.DB_PATH || './data/tb-chests.db');
        try {
            if (scanLoop) {
                const state = scanLoop.getState();
                if (state === enums_js_1.AppState.SCANNING || state === enums_js_1.AppState.PROCESSING || state === enums_js_1.AppState.NAVIGATING || state === enums_js_1.AppState.CHECKING_AUTH) {
                    return res.status(409).json({ error: `Cannot restore backup while scanner is active (${state}).` });
                }
            }
            const fileName = String(req.body?.fileName ?? '').trim();
            if (!fileName)
                return res.status(400).json({ error: 'fileName is required' });
            const sourcePath = (0, db_backup_js_1.resolveBackupPath)(fileName);
            if (!sourcePath) {
                return res.status(404).json({ error: 'Backup file not found' });
            }
            let buffer = fs_1.default.readFileSync(sourcePath);
            if (buffer.length < 16) {
                return res.status(400).json({ error: 'Backup file is too small or invalid' });
            }
            // Same gzip auto-detect as /api/import/backup-db.
            if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
                try {
                    buffer = zlib_1.default.gunzipSync(buffer);
                }
                catch (gzErr) {
                    return res.status(400).json({ error: `Failed to decompress gzip backup: ${String(gzErr)}` });
                }
            }
            const sqliteHeader = buffer.subarray(0, 16).toString('utf8');
            if (!sqliteHeader.startsWith('SQLite format 3')) {
                return res.status(400).json({ error: 'File does not appear to be a valid SQLite backup' });
            }
            const tempDir = path_1.default.resolve('data', 'backups', 'uploads');
            fs_1.default.mkdirSync(tempDir, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            tempPath = path_1.default.join(tempDir, `restore-${timestamp}-${path_1.default.basename(fileName)}`);
            fs_1.default.writeFileSync(tempPath, buffer);
            const validationDb = new better_sqlite3_1.default(tempPath, { readonly: true, fileMustExist: true });
            try {
                validationDb.prepare('PRAGMA schema_version').get();
            }
            finally {
                validationDb.close();
            }
            const preRestoreBackup = createPreImportBackup();
            (0, database_js_1.getDb)().pragma('wal_checkpoint(TRUNCATE)');
            (0, database_js_1.closeDb)();
            fs_1.default.copyFileSync(tempPath, dbPath);
            (0, database_js_1.initDatabase)(dbPath);
            (0, user_repo_js_1.logAction)(req.user.id, 'restore_server_backup', {
                fileName,
                bytes: buffer.length,
                preRestoreBackup,
            });
            return res.json({
                ok: true,
                restoredFrom: fileName,
                bytes: buffer.length,
                preRestoreBackup,
            });
        }
        catch (err) {
            try {
                (0, database_js_1.initDatabase)(dbPath);
            }
            catch {
                // Best effort; safe if already initialized.
            }
            return res.status(400).json({ error: `Restore failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        finally {
            if (tempPath && fs_1.default.existsSync(tempPath)) {
                fs_1.default.unlinkSync(tempPath);
            }
        }
    });
    // GET /api/admin/backups/clans?file=<basename>
    // What clans does this backup hold, and how much data does each carry?
    // Read-only — the operator sees the row counts before committing.
    router.get('/admin/backups/clans', auth_js_1.requireSuperAdmin, (req, res) => {
        const fileName = String(req.query.file ?? '').trim();
        if (!fileName)
            return res.status(400).json({ error: 'file query param is required' });
        const sourcePath = (0, db_backup_js_1.resolveBackupPath)(fileName);
        if (!sourcePath)
            return res.status(404).json({ error: 'Backup file not found' });
        try {
            return res.json({ fileName, ...(0, clan_restore_js_1.inspectBackupClans)(sourcePath) });
        }
        catch (err) {
            return res.status(400).json({ error: `Could not read backup: ${err instanceof Error ? err.message : String(err)}` });
        }
    });
    // POST /api/admin/backups/restore-clan { fileName, clanId }
    // Pull ONE clan out of a backup and add it to the live database, leaving
    // every other clan untouched. This is the counterpart to DELETE /api/clans/:id
    // — the whole-file restore next to it cannot undo a clan deletion without
    // also rewinding every clan that has been scanning ever since.
    router.post('/admin/backups/restore-clan', auth_js_1.requireSuperAdmin, async (req, res) => {
        if (scanLoop) {
            const state = scanLoop.getState();
            if (state === enums_js_1.AppState.SCANNING || state === enums_js_1.AppState.PROCESSING || state === enums_js_1.AppState.NAVIGATING || state === enums_js_1.AppState.CHECKING_AUTH) {
                return res.status(409).json({ error: `Cannot restore a clan while the scanner is active (${state}).` });
            }
        }
        const body = (req.body ?? {});
        const fileName = String(body.fileName ?? '').trim();
        const clanId = Number.parseInt(String(body.clanId ?? ''), 10);
        if (!fileName)
            return res.status(400).json({ error: 'fileName is required' });
        if (!Number.isFinite(clanId) || clanId <= 0) {
            return res.status(400).json({ error: 'clanId must be a positive integer' });
        }
        const sourcePath = (0, db_backup_js_1.resolveBackupPath)(fileName);
        if (!sourcePath)
            return res.status(404).json({ error: 'Backup file not found' });
        try {
            // Same contract as the clan delete: snapshot first, and if the snapshot
            // fails nothing is written. Adding a clan is far less destructive than
            // removing one, but it is still tens of thousands of rows landing in
            // shared tables, and reversing it by hand is not a thing anyone wants.
            //
            // `protect` is load-bearing, not defensive: this snapshot is itself a
            // pre-action file, so writing it makes a 4th under a keep-3 policy and
            // the prune takes the OLDEST — which is exactly the `pre-delete-clan-*`
            // snapshot being restored from. Without this the restore deletes its own
            // source before reading it.
            const preRestoreBackup = path_1.default.basename(await (0, db_backup_js_1.createPreActionBackup)(`pre-action-restore-clan-${clanId}`, { protect: path_1.default.basename(sourcePath) }));
            const result = (0, clan_restore_js_1.restoreClanFromBackup)(sourcePath, clanId);
            (0, user_repo_js_1.logAction)(req.user.id, 'clan.restore', {
                fileName,
                sourceClanId: result.sourceClanId,
                clanId: result.clanId,
                rows: result.totalRows,
                preRestoreBackup,
            });
            return res.json({ ok: true, ...result, restoredFrom: fileName, preRestoreBackup });
        }
        catch (err) {
            return res.status(400).json({ error: `Clan restore failed: ${err instanceof Error ? err.message : String(err)}` });
        }
    });
    // --- Analytics ---
    // GET /api/analytics/summary - breakdowns by source/type/name.
    // Headline totals (chests / points / members / sessions) are NOT in this
    // response — clients should read those from /api/stats so all surfaces
    // share a single source of truth for the aggregates.
    router.get('/analytics/summary', (req, res) => {
        const clanId = req.clanId ?? 1;
        // Cached per clan: three full-clan aggregates that a page-open fires
        // together. Collapses the burst from multiple viewers into one pass;
        // dropped on scan completion. Each aggregate GROUPs BY the indexed FK
        // (chest_id / chest_source_id), not the joined string, so the v41
        // covering indexes (idx_cr_clan_chest_pts / idx_cr_clan_source_pts)
        // satisfy the SUM index-only and only the ~75 group-keys hit the JOIN.
        const result = (0, ttl_cache_js_1.cached)(`analyticsSummary:${clanId}`, chest_repo_js_1.ANALYTICS_CACHE_TTL_MS, () => {
            const database = (0, database_js_1.getDb)();
            const bySource = database.prepare(`
        SELECT COALESCE(cs.source, '') AS chest_source,
               COUNT(*) AS count,
               SUM(cr.point_value) AS points
        FROM chest_records cr
        LEFT JOIN chest_sources cs ON cs.id = cr.chest_source_id
        WHERE cr.clan_id = ?
        GROUP BY cr.chest_source_id
        ORDER BY count DESC
      `).all(clanId);
            const byType = database.prepare(`
        SELECT ch.chest_type AS chest_type,
               COUNT(*) AS count,
               SUM(cr.point_value) AS points
        FROM chest_records cr
        JOIN chests ch ON ch.id = cr.chest_id
        WHERE cr.clan_id = ?
        GROUP BY ch.chest_type
        ORDER BY count DESC
      `).all(clanId);
            const byName = database.prepare(`
        SELECT ch.name AS chest_name,
               ch.chest_type AS chest_type,
               COUNT(*) AS count,
               SUM(cr.point_value) AS points
        FROM chest_records cr
        JOIN chests ch ON ch.id = cr.chest_id
        WHERE cr.clan_id = ?
        GROUP BY cr.chest_id
        ORDER BY count DESC
      `).all(clanId);
            return { bySource, byType, byName };
        });
        res.json(result);
    });
    // GET /api/analytics/single-day-records - clan's top 3 best single days
    // by chest count and by points, one entry per member so three different
    // players always show up on the podium. Used by the Clan Records card
    // on the Analytics page.
    router.get('/analytics/single-day-records', (req, res) => {
        const rollover = (0, index_js_1.loadConfig)().gameDayRolloverUtcHour;
        res.json(chestRepo.getSingleDayRecords(rollover, req.clanId ?? 1));
    });
    // GET /api/analytics/daily?days=14
    // Buckets chest activity by GAME day (UTC timestamp shifted back by the
    // configured rollover hour), not UTC calendar day. That way an evening
    // chest that came in at 18:30 UTC under a 17:00 UTC rollover counts
    // toward game-day-of-the-rollover, matching the in-game day boundary.
    router.get('/analytics/daily', (req, res) => {
        const clanId = req.clanId ?? 1;
        const days = (0, parse_int_js_1.parseBoundedInt)(req.query.days, 14, { min: 1, max: 365 });
        const rollover = (0, index_js_1.loadConfig)().gameDayRolloverUtcHour;
        // Cached per (clan, days, rollover); dropped on scan completion.
        const result = (0, ttl_cache_js_1.cached)(`analyticsDaily:${clanId}:${days}:${rollover}`, chest_repo_js_1.ANALYTICS_CACHE_TTL_MS, () => {
            const database = (0, database_js_1.getDb)();
            const rolloverModifier = `-${rollover} hours`;
            // Post-v30: captured_at is INTEGER ms. DATE() needs Unix seconds
            // + the 'unixepoch' modifier; the cutoff for "last N days" is
            // computed via strftime('%s', 'now', '-N days') * 1000 to stay
            // comparable to the column.
            const daily = database.prepare(`
        SELECT DATE(effective_at / 1000, 'unixepoch', ?) as day,
               COUNT(*) as chests,
               SUM(point_value) as points,
               COUNT(DISTINCT member_id) as activeMembers
        FROM chest_records
        WHERE clan_id = ?
          AND effective_at > strftime('%s', 'now', '-' || ? || ' days') * 1000
        GROUP BY DATE(effective_at / 1000, 'unixepoch', ?) ORDER BY day
      `).all(rolloverModifier, clanId, days, rolloverModifier);
            // Include the rollover hour in the response so the frontend can
            // build its 7-day skeleton using the same game-day convention and
            // correctly match rows back to buckets. Returning plain arrays
            // previously worked because both sides used UTC days; now the
            // consumer needs to know the offset.
            return { rolloverUtcHour: rollover, days: daily };
        });
        res.json(result);
    });
    // GET /api/analytics/top-contributors?limit=10
    router.get('/analytics/top-contributors', (req, res) => {
        const clanId = req.clanId ?? 1;
        const limit = (0, parse_int_js_1.parseBoundedInt)(req.query.limit, 10, { min: 1, max: 200 });
        // Served from the chest_daily_summary rollup (all-time member totals),
        // cached per (clan, limit); dropped on scan completion.
        const result = (0, ttl_cache_js_1.cached)(`topContributors:${clanId}:${limit}`, chest_repo_js_1.ANALYTICS_CACHE_TTL_MS, () => chestSummaryRepo.getTopContributors(clanId, limit));
        res.json(result);
    });
    // GET /api/analytics/window?from=ISO&to=ISO&compare=1&limit=15
    //
    // The Analytics page's whole payload for one earn-time window, plus the
    // equal-length window immediately before it when compare=1.
    //
    // This exists because /analytics/summary and /analytics/top-contributors have
    // no window at all — they answer "what has this clan ever collected", on a
    // dataset with 185k records going back months. Every card on the page wanted
    // its own current-vs-previous fetch; doing it once here means they are all
    // rendering jobs against a single payload and a single cache entry.
    //
    // Omit from/to for all time. Bounds are half-open [from, to), matching
    // computeGameWindow on the client and getMemberAggregateInRange on the
    // server; an invalid ISO string degrades to all-time rather than erroring, so
    // a typo in a shared link still loads the page.
    //
    // `previous` deliberately carries ONLY totals + days. The deltas on the KPI
    // strip and the ghost series on the activity chart are the only things that
    // read it, and computing breakdowns and contributor podiums for a window
    // nothing renders would double the cost of the whole endpoint for nothing.
    // The Movers card will need per-member figures for both windows, but it needs
    // the full roster rather than a top-N, which is a different query — it gets
    // its own primitive when it is built.
    router.get('/analytics/window', (req, res) => {
        const clanId = req.clanId ?? 1;
        const rollover = (0, index_js_1.loadConfig)().gameDayRolloverUtcHour;
        const limit = (0, parse_int_js_1.parseBoundedInt)(req.query.limit, 15, { min: 1, max: 200 });
        const compare = req.query.compare === '1' || req.query.compare === 'true';
        const isValidIso = (v) => typeof v === 'string' && !Number.isNaN(new Date(v).getTime());
        const fromIso = isValidIso(req.query.from) ? req.query.from : undefined;
        const toIso = isValidIso(req.query.to) ? req.query.to : undefined;
        const windowed = !!(fromIso && toIso);
        const fromMs = windowed ? new Date(fromIso).getTime() : undefined;
        const toMs = windowed ? new Date(toIso).getTime() : undefined;
        const key = `analyticsWindow:${clanId}:${fromIso ?? ''}:${toIso ?? ''}:${compare ? 1 : 0}:${limit}`;
        const result = (0, ttl_cache_js_1.cached)(key, chest_repo_js_1.ANALYTICS_CACHE_TTL_MS, () => {
            // The rollup is keyed on game_day, so translate the instant bounds once
            // here. `to` is EXCLUSIVE, so the last included game day is the one
            // holding the final millisecond before it — deriving it from `to` itself
            // would pull in the day after the window whenever `to` lands exactly on a
            // rollover boundary, which is precisely what computeGameWindow produces.
            const fromDay = windowed ? (0, game_day_js_1.gameDateFor)(fromMs, rollover) : undefined;
            const toDay = windowed ? (0, game_day_js_1.gameDateFor)(toMs - 1, rollover) : undefined;
            // `ms` is the instant window the breakdowns need, and is null for the
            // summary-only form. It is a parameter rather than a closure read of
            // fromMs/toMs so the previous window can never accidentally be described
            // by the current window's bounds.
            const summaryOnly = (f, t) => ({
                fromDay: f ?? null,
                toDay: t ?? null,
                totals: chestSummaryRepo.getWindowTotals(clanId, f, t),
                days: chestSummaryRepo.getWindowDailySeries(clanId, f, t),
            });
            const buildWindow = (f, t, ms) => {
                return {
                    ...summaryOnly(f, t),
                    ...chestRepo.getChestBreakdowns(clanId, ms?.from, ms?.to),
                    // ONE ranked list, not two top-N lists. The page renders a single
                    // contributor table, and merging two independent podiums on the
                    // client leaves rows whose other figure is unknown.
                    contributors: chestSummaryRepo.getWindowContributors(clanId, limit, f, t),
                    concentration: chestSummaryRepo.getConcentration(clanId, f, t),
                    activityClock: chestRepo.getActivityClock(clanId, ms?.from, ms?.to),
                };
            };
            let previous = null;
            let movers = [];
            let coverage = null;
            if (compare && windowed) {
                // Equal-length, immediately preceding, in game days rather than
                // milliseconds: the rollup is what answers it, and day arithmetic can't
                // drift the way subtracting a duration from a rollover-aligned instant
                // can across a config change to the rollover hour.
                const span = (0, game_day_js_1.daysBetweenGameDates)(fromDay, toDay);
                if (span !== null) {
                    const shift = (day, by) => {
                        const d = new Date(`${day}T00:00:00Z`);
                        d.setUTCDate(d.getUTCDate() + by);
                        return d.toISOString().slice(0, 10);
                    };
                    const prevFromDay = shift(fromDay, -(span + 1));
                    const prevToDay = shift(fromDay, -1);
                    previous = summaryOnly(prevFromDay, prevToDay);
                    movers = chestSummaryRepo.getMemberWindowComparison(clanId, prevFromDay, prevToDay, fromDay, toDay);
                    // Coverage is reported for the CURRENT window only. A gap in the
                    // previous one understates the baseline, which flatters every delta
                    // rather than inventing one, and saying so about a window nobody is
                    // looking at is noise.
                    coverage = (0, session_repo_js_1.getScanCoverage)(clanId, fromIso, toIso);
                }
            }
            // Days in the window, so an active-day count can be stated as a share.
            // Null for all time, where "active days out of every day since install"
            // is not a number anyone wants.
            const windowDays = fromDay && toDay
                ? ((0, game_day_js_1.daysBetweenGameDates)(fromDay, toDay) ?? 0) + 1
                : null;
            return {
                from: fromIso ?? null,
                to: toIso ?? null,
                rolloverUtcHour: rollover,
                windowDays,
                current: buildWindow(fromDay, toDay, windowed ? { from: fromMs, to: toMs } : null),
                previous,
                movers,
                coverage,
            };
        });
        res.json(result);
    });
    // --- Admin: Member Management ---
    // PUT /api/members/:id - rename member
    router.put('/members/:id', auth_js_1.requireAdmin, (req, res) => {
        const { name } = req.body;
        if (!name)
            return res.status(400).json({ error: 'name required' });
        const memberId = parseInt(String(req.params.id));
        const memberClanId = memberRepo.getMemberClanId(memberId);
        if (memberClanId !== null && memberClanId !== (req.clanId ?? 1)) {
            return res.status(404).json({ error: 'Member not found' });
        }
        memberRepo.renameMember(memberId, name, req.clanId ?? 1);
        (0, user_repo_js_1.logAction)(req.user.id, 'rename_member', { id: String(req.params.id), newName: name });
        res.json({ ok: true });
    });
    // DELETE /api/members/:id - remove member
    //
    // Always soft-deletes (sets is_active = 0) so the scan-pipeline's
    // fuzzy matcher stops seeing the member while the row stays
    // recoverable from Admin → "Show removed members". A subsequent
    // scan that OCRs the same name (or an existing alias) auto-
    // reactivates the row via upsertMember.
    router.delete('/members/:id', auth_js_1.requireAdmin, (req, res) => {
        const memberId = parseInt(String(req.params.id));
        const memberClanId = memberRepo.getMemberClanId(memberId);
        if (memberClanId !== null && memberClanId !== (req.clanId ?? 1)) {
            return res.status(404).json({ error: 'Member not found' });
        }
        const member = memberRepo.getMemberById(memberId, req.clanId ?? 1);
        memberRepo.removeMember(memberId, req.clanId ?? 1);
        (0, user_repo_js_1.logAction)(req.user.id, 'delete_member', { name: member?.name });
        res.json({ ok: true });
    });
    // POST /api/members/:id/restore - reactivate a soft-deleted member
    router.post('/members/:id/restore', auth_js_1.requireAdmin, (req, res) => {
        const memberId = parseInt(String(req.params.id));
        const memberClanId = memberRepo.getMemberClanId(memberId);
        if (memberClanId !== null && memberClanId !== (req.clanId ?? 1)) {
            return res.status(404).json({ error: 'Member not found' });
        }
        const member = memberRepo.getMemberById(memberId, req.clanId ?? 1);
        if (!member)
            return res.status(404).json({ error: 'Member not found' });
        memberRepo.restoreMember(memberId, req.clanId ?? 1);
        (0, user_repo_js_1.logAction)(req.user.id, 'restore_member', { name: member.name });
        res.json({ ok: true });
    });
    // --- Admin: Merge Rules (require admin role) ---
    // GET /api/admin/merge-rules?type=player|chest|source
    router.get('/admin/merge-rules', auth_js_1.requireAdmin, (req, res) => {
        const type = req.query.type;
        res.json(mergeRepo.getMergeRules(req.clanId ?? 1, type));
    });
    // POST /api/admin/merge-rules { type, fromValue, toValue }
    router.post('/admin/merge-rules', auth_js_1.requireAdmin, (req, res) => {
        const { type, fromValue, toValue } = req.body;
        if (!type || !fromValue || !toValue) {
            return res.status(400).json({ error: 'type, fromValue, toValue required' });
        }
        try {
            const rule = mergeRepo.addMergeRule(type, fromValue, toValue, req.clanId ?? 1);
            (0, user_repo_js_1.logAction)(req.user.id, `merge_${type}`, { from: fromValue, to: toValue, clanId: req.clanId ?? 1 });
            res.json(rule);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // A rejected (too-generic) rule is a client error, not a server fault.
            if (err instanceof mergeRepo.InvalidMergeRuleError) {
                return res.status(400).json({ error: message });
            }
            res.status(500).json({ error: `Merge failed: ${message}` });
        }
    });
    // DELETE /api/admin/merge-rules/:id
    router.delete('/admin/merge-rules/:id', auth_js_1.requireAdmin, (req, res) => {
        (0, user_repo_js_1.logAction)(req.user.id, 'delete_merge_rule', { id: String(req.params.id) });
        mergeRepo.deleteMergeRule((0, parse_int_js_1.parseBoundedInt)(req.params.id, 0, { min: 1 }), req.clanId ?? 1);
        res.json({ ok: true });
    });
    // POST /api/admin/merge-players { fromName, toName }
    router.post('/admin/merge-players', auth_js_1.requireAdmin, (req, res) => {
        const { fromName, toName } = req.body;
        if (!fromName || !toName) {
            return res.status(400).json({ error: 'fromName, toName required' });
        }
        // Mirror the /admin/merge-rules handler: a rejected (too-generic) rule
        // is a client error, and anything else must still come back as JSON
        // rather than an unhandled 500 the admin page can't render.
        let note;
        try {
            note = mergeRepo.addMergeRule('player', fromName, toName, req.clanId ?? 1).note;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (err instanceof mergeRepo.InvalidMergeRuleError) {
                return res.status(400).json({ error: message });
            }
            return res.status(500).json({ error: `Merge failed: ${message}` });
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'merge_player', { from: fromName, to: toName, clanId: req.clanId ?? 1 });
        res.json({ ok: true, message: `Merged "${fromName}" → "${toName}"`, note });
    });
    // --- Admin: Chest Type Overrides ---
    // GET /api/admin/chest-types
    router.get('/admin/chest-types', auth_js_1.requireAdmin, (req, res) => {
        res.json(mergeRepo.getChestTypeOverrides(req.clanId ?? 1));
    });
    // POST /api/admin/chest-types { chestName, chestType }
    router.post('/admin/chest-types', auth_js_1.requireAdmin, (req, res) => {
        const { chestName, chestType } = req.body;
        if (!chestName || !chestType) {
            return res.status(400).json({ error: 'chestName, chestType required' });
        }
        mergeRepo.setChestTypeOverride(chestName, chestType, req.clanId ?? 1);
        (0, user_repo_js_1.logAction)(req.user.id, 'set_chest_type', { chestName, chestType, clanId: req.clanId ?? 1 });
        res.json({ ok: true });
    });
    // DELETE /api/admin/chest-types/:id
    router.delete('/admin/chest-types/:id', auth_js_1.requireAdmin, (req, res) => {
        (0, user_repo_js_1.logAction)(req.user.id, 'delete_chest_type_override', { id: String(req.params.id) });
        mergeRepo.deleteChestTypeOverride((0, parse_int_js_1.parseBoundedInt)(req.params.id, 0, { min: 1 }), req.clanId ?? 1);
        res.json({ ok: true });
    });
    // GET /api/admin/unique-chests
    router.get('/admin/unique-chests', auth_js_1.requireAdmin, (req, res) => {
        const clanId = req.clanId ?? 1;
        const distinct = chestRepo.getDistinctChestNames(clanId);
        const withTypes = distinct.map((d) => ({
            name: d.name,
            currentType: d.currentType || 'unknown',
            override: mergeRepo.getChestTypeOverride(d.name, clanId),
            // Record count travels with the name so the merge dropdowns can show
            // how much data sits behind each one — a 3-record name next to a
            // 4,000-record one is the tell that the first is an OCR misread.
            count: d.count,
        }));
        res.json(withTypes);
    });
    // GET /api/admin/unique-sources
    router.get('/admin/unique-sources', auth_js_1.requireAdmin, (req, res) => {
        res.json(chestRepo.getDistinctChestSources(req.clanId ?? 1));
    });
    // GET /api/admin/member-chest-counts
    // { memberId: recordCount } for the active clan. Same purpose as the count
    // on unique-chests/unique-sources, but members come from /members, which is
    // shared with non-admin pages — so the counts ride on their own admin route
    // rather than fattening that payload for everyone.
    router.get('/admin/member-chest-counts', auth_js_1.requireAdmin, (req, res) => {
        res.json(chestRepo.getChestCountsByMember(req.clanId ?? 1));
    });
    // GET /api/admin/source-points
    // The scoring table is global (same for every clan). Any admin may READ
    // it; only superadmins may change it (the mutating routes below).
    router.get('/admin/source-points', auth_js_1.requireAdmin, (_req, res) => {
        res.json(sourcePointsRepo.getSourceKeySummary());
    });
    // PUT /api/admin/source-points { sourceKey, chestName, pointValue }
    // chestName = '' is the wildcard row (applies to any chest under this
    // source that has no more-specific override). Global + superadmin-only.
    router.put('/admin/source-points', auth_js_1.requireSuperAdmin, (req, res) => {
        const sourceKey = String(req.body?.sourceKey ?? '').trim();
        const chestName = String(req.body?.chestName ?? '');
        const pointValue = Number.parseInt(String(req.body?.pointValue ?? ''), 10);
        if (!sourceKey) {
            return res.status(400).json({ error: 'sourceKey is required' });
        }
        if (!Number.isFinite(pointValue) || pointValue < 0) {
            return res.status(400).json({ error: 'pointValue must be a non-negative integer' });
        }
        try {
            const backfilled = sourcePointsRepo.setOverride(sourceKey, chestName, pointValue);
            (0, user_repo_js_1.logAction)(req.user.id, 'set_source_points', { sourceKey, chestName, pointValue, backfilled });
            res.json({ ok: true, backfilled });
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // DELETE /api/admin/source-points?sourceKey=...&chestName=...
    // Query params instead of path segments because chestName can be the
    // empty string (wildcard) and URL-encoding an empty path segment is
    // awkward. Global + superadmin-only.
    router.delete('/admin/source-points', auth_js_1.requireSuperAdmin, (req, res) => {
        const sourceKey = String(req.query.sourceKey ?? '').trim();
        const chestName = String(req.query.chestName ?? '');
        if (!sourceKey) {
            return res.status(400).json({ error: 'sourceKey is required' });
        }
        try {
            const backfilled = sourcePointsRepo.deleteOverride(sourceKey, chestName);
            (0, user_repo_js_1.logAction)(req.user.id, 'delete_source_points', { sourceKey, chestName, backfilled });
            res.json({ ok: true, backfilled });
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // POST /api/admin/source-points/recalculate — global + superadmin-only.
    // Recomputes point_value across every clan's chest_records.
    router.post('/admin/source-points/recalculate', auth_js_1.requireSuperAdmin, (req, res) => {
        try {
            const updated = sourcePointsRepo.recalculateAllPoints();
            (0, user_repo_js_1.logAction)(req.user.id, 'recalculate_source_points', { updated });
            res.json({ ok: true, updated });
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // ── Triumphal Chest Points ─────────────────────────────────────────
    // Global, superadmin-managed scoring for the Bank Gifts tab, mirroring
    // source-points: any admin may READ the list; only superadmins may
    // change values. `packagePoints` is the 3-of-a-kind value; the per-chest
    // score is packagePoints / 3 (rounded once per member at query time).
    // GET /api/admin/triumphal-points — configured chests + observed-but-
    // unconfigured ("new") chests, the latter flagged for review.
    router.get('/admin/triumphal-points', auth_js_1.requireAdmin, (_req, res) => {
        res.json(triumphalPointsRepo.getManagementList());
    });
    // PUT /api/admin/triumphal-points { chestName, packagePoints }
    router.put('/admin/triumphal-points', auth_js_1.requireSuperAdmin, (req, res) => {
        const chestName = String(req.body?.chestName ?? '').trim();
        const packagePoints = Number.parseInt(String(req.body?.packagePoints ?? ''), 10);
        if (!chestName) {
            return res.status(400).json({ error: 'chestName is required' });
        }
        if (!Number.isFinite(packagePoints) || packagePoints < 0) {
            return res.status(400).json({ error: 'packagePoints must be a non-negative integer' });
        }
        try {
            triumphalPointsRepo.setPoints(chestName, packagePoints);
            // A previously-"new" chest may now be configured — drop the cached
            // review-queue badge count for every clan so it clears promptly.
            reviewQueueRepo.invalidateReviewQueueCount();
            (0, user_repo_js_1.logAction)(req.user.id, 'set_triumphal_points', { chestName, packagePoints });
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // DELETE /api/admin/triumphal-points?chestName=...
    // Reverts the chest to "new" (scores 0, re-flagged for review).
    router.delete('/admin/triumphal-points', auth_js_1.requireSuperAdmin, (req, res) => {
        const chestName = String(req.query.chestName ?? '').trim();
        if (!chestName) {
            return res.status(400).json({ error: 'chestName is required' });
        }
        try {
            const removed = triumphalPointsRepo.deletePoints(chestName);
            reviewQueueRepo.invalidateReviewQueueCount();
            (0, user_repo_js_1.logAction)(req.user.id, 'delete_triumphal_points', { chestName, removed });
            res.json({ ok: true, removed });
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // GET /api/admin/review-queue
    router.get('/admin/review-queue', auth_js_1.requireAdmin, (req, res) => {
        try {
            res.json(reviewQueueRepo.getReviewQueue(req.clanId ?? 1));
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // POST /api/admin/review-queue/acknowledge { category }
    router.post('/admin/review-queue/acknowledge', auth_js_1.requireAdmin, (req, res) => {
        const category = String(req.body?.category ?? '');
        if (category !== 'chest_name' && category !== 'chest_source' && category !== 'member') {
            return res.status(400).json({ error: 'invalid category' });
        }
        try {
            reviewQueueRepo.acknowledge(category, req.clanId ?? 1);
            (0, user_repo_js_1.logAction)(req.user.id, 'acknowledge_review_queue', { category, clanId: req.clanId ?? 1 });
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // GET /api/admin/unknown-chests — rows where OCR failed to read the
    // player name. See chestRepo.getUnknownChests for the predicate.
    // Also self-heals any stale "Manual review needed" banners on sessions
    // whose unknown rows were already reassigned before the auto-clear
    // behavior existed — one UPDATE, safe to run every load.
    router.get('/admin/unknown-chests', auth_js_1.requireAdmin, (req, res) => {
        try {
            const clanId = req.clanId ?? 1;
            chestRepo.clearResolvedManualReviewErrors(clanId);
            res.json(chestRepo.getUnknownChests(clanId));
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // GET /api/admin/unknown-chests/:chestId/crop
    // Streams the saved debug batch-crop PNG for a row that OCR failed on.
    // Used by the admin UI hover preview. Path is resolved against the
    // on-disk value, but we ONLY serve files inside the allowed screenshot
    // directory to prevent path traversal via a maliciously stored path.
    router.get('/admin/unknown-chests/:chestId/crop', auth_js_1.requireAdmin, (req, res) => {
        const chestId = (0, parse_int_js_1.parseBoundedInt)(req.params.chestId, 0, { min: 1 });
        const storedPath = chestRepo.getDebugCropPathForChest(chestId, req.clanId ?? 1);
        if (!storedPath) {
            return res.status(404).json({ error: 'No debug crop recorded for this chest' });
        }
        const resolved = (0, crop_dirs_js_1.resolveAllowedCropPath)(storedPath);
        if (!resolved) {
            return res.status(403).json({ error: 'Crop path is outside the allowed directory' });
        }
        if (!fs_1.default.existsSync(resolved)) {
            return res.status(404).json({ error: 'Debug crop file missing on disk' });
        }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        fs_1.default.createReadStream(resolved).pipe(res);
    });
    // GET /api/admin/members/:memberId/crop
    // Streams a screenshot crop showing where a member came from, for the "New
    // Members" review-queue hover. Evidence can sit on a might-capture member-list
    // row, a resource-import row or a scanned chest row —
    // memberRepo.getMemberEvidenceCropPath picks the tightest one and scopes the
    // lookup to this clan.
    router.get('/admin/members/:memberId/crop', auth_js_1.requireAdmin, (req, res) => {
        const memberId = (0, parse_int_js_1.parseBoundedInt)(req.params.memberId, 0, { min: 1 });
        if (!memberId) {
            return res.status(400).json({ error: 'Invalid memberId' });
        }
        const storedPath = memberRepo.getMemberEvidenceCropPath(memberId, req.clanId ?? 1);
        if (!storedPath) {
            return res.status(404).json({ error: 'No crop recorded for this member' });
        }
        const resolved = (0, crop_dirs_js_1.resolveAllowedCropPath)(storedPath);
        if (!resolved) {
            return res.status(403).json({ error: 'Crop path is outside the allowed directory' });
        }
        if (!fs_1.default.existsSync(resolved)) {
            return res.status(404).json({ error: 'Crop file missing on disk' });
        }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        fs_1.default.createReadStream(resolved).pipe(res);
    });
    // POST /api/admin/unknown-chests/reassign { chestIds: number[], memberName: string }
    // Reassigns specific chest rows to the given member. Never uses a merge
    // rule because "[Unknown]" is a generic sentinel — next OCR failure may
    // belong to a different player, so forward-applied rules would be wrong.
    router.post('/admin/unknown-chests/reassign', auth_js_1.requireAdmin, (req, res) => {
        const { chestIds, memberName } = req.body ?? {};
        const ids = Array.isArray(chestIds)
            ? chestIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
            : [];
        const name = typeof memberName === 'string' ? memberName.trim() : '';
        if (ids.length === 0) {
            return res.status(400).json({ error: 'chestIds required' });
        }
        if (!name) {
            return res.status(400).json({ error: 'memberName required' });
        }
        if (name === '[Unknown]') {
            return res.status(400).json({ error: 'cannot reassign to "[Unknown]" sentinel' });
        }
        try {
            const clanId = req.clanId ?? 1;
            const member = memberRepo.upsertMember(name, clanId);
            const changes = chestRepo.reassignChestsToMember(ids, member.id, member.name, clanId);
            const orphansRemoved = chestRepo.deleteOrphanedEmptyMembers(clanId);
            const errorsCleared = chestRepo.clearResolvedManualReviewErrors(clanId);
            (0, user_repo_js_1.logAction)(req.user.id, 'reassign_unknown_chests', {
                chestIds: ids,
                toMemberId: member.id,
                toMemberName: member.name,
                changes,
                orphansRemoved,
                errorsCleared,
            });
            res.json({ ok: true, changes, memberId: member.id, memberName: member.name, orphansRemoved, errorsCleared });
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // GET /api/admin/nav-status — drives the "needs attention" dots on the
    // top nav. Cheap: counts only, no row payloads. Polled by app.js on
    // page load + after each navigation. Superadmins also get the latest
    // warning timestamp so the System dot can light up when warnings are
    // newer than the user's stored "last seen" time (computed client-side
    // from localStorage so no per-user persistence is needed).
    router.get('/admin/nav-status', auth_js_1.requireAdmin, (req, res) => {
        try {
            const clanId = req.clanId ?? 1;
            // Count-only paths: getReviewQueueCount / countUnknownChests return just
            // the badge numbers instead of materializing (and discarding) the full
            // entry/row arrays. Both are memoized per clan; the badge tolerates
            // short staleness and is invalidated on every relevant mutation.
            const counts = reviewQueueRepo.getReviewQueueCount(clanId);
            const reviewQueueCount = counts.chestNames + counts.chestSources + counts.members + counts.triumphalChests;
            const unknownChestsCount = chestRepo.countUnknownChests(clanId);
            // Resource rows the reader couldn't identify a resource for. Only relevant
            // when the clan actually tracks resources, and the count is served from the
            // partial index added in v59 so it stays cheap on this hot path.
            const unresolvedResourceCount = (0, clan_repo_js_1.getClanById)(clanId)?.resourcesEnabled
                ? resourceRepo.countUnresolvedTransactions(clanId)
                : 0;
            const payload = {
                admin: {
                    reviewQueueCount,
                    unknownChestsCount,
                },
                resources: { unresolvedCount: unresolvedResourceCount },
            };
            if (req.user?.role === 'superadmin') {
                payload.system = { latestWarningAt: (0, log_buffer_js_1.latestEntryAt)() };
            }
            res.json(payload);
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // GET /api/admin/log-buffer — recent warn/error log entries captured
    // in-process (see src/utils/log-buffer.ts). Newest first. Persisted
    // to data/warnings.jsonl so this survives container restarts.
    // GET /api/admin/scan-health?limit=60 — recent scans as a series, for the
    // capture-health strip on System. Superadmin: this is about the scanner, not
    // about the clan's numbers.
    router.get('/admin/scan-health', auth_js_1.requireSuperAdmin, (req, res) => {
        const limit = (0, parse_int_js_1.parseBoundedInt)(req.query.limit, 60, { min: 5, max: 500 });
        res.json({ scans: sessionRepo.getScanHealthSeries(req.clanId ?? 1, limit) });
    });
    router.get('/admin/log-buffer', auth_js_1.requireSuperAdmin, (_req, res) => {
        try {
            res.json({ entries: (0, log_buffer_js_1.getEntries)() });
        }
        catch (err) {
            res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    return router;
}
//# sourceMappingURL=api.js.map