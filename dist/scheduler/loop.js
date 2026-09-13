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
exports.ScanLoop = void 0;
const resource_upload_lock_js_1 = require("../utils/resource-upload-lock.js");
const launcher_js_1 = require("../browser/launcher.js");
const clan_paths_js_1 = require("../config/clan-paths.js");
const enums_js_1 = require("../models/enums.js");
const state_machine_js_1 = require("./state-machine.js");
const navigator_js_1 = require("../browser/navigator.js");
const chestRepo = __importStar(require("../data/repositories/chest-repo.js"));
const sessionRepo = __importStar(require("../data/repositories/session-repo.js"));
const clan_repo_js_1 = require("../data/repositories/clan-repo.js");
const logger_js_1 = require("../utils/logger.js");
const persistent_env_js_1 = require("../config/persistent-env.js");
const calibration_js_1 = require("../config/calibration.js");
const member_capture_js_1 = require("../browser/member-capture.js");
const input_js_1 = require("../browser/input.js");
const calibration_js_2 = require("./calibration.js");
const scan_pipeline_js_1 = require("./scan-pipeline.js");
const auth_check_js_1 = require("./auth-check.js");
const member_capture_phase_js_1 = require("./member-capture-phase.js");
const scan_finalize_js_1 = require("./scan-finalize.js");
const log = (0, logger_js_1.childLogger)('scanner');
const MAINTENANCE_UNTIL_KEY = 'MAINTENANCE_BLOCKED_UNTIL';
/**
 * How long a calibration capture leaves the game loaded before parking the page.
 *
 * Sized to a human working through the wizard: reading a stage's instructions,
 * marking two or three targets and saving takes a minute or two, and the two-pass
 * stages need a second capture straight after that. Five minutes covers a normal
 * step-to-step gap without holding a WebGL context for an operator who has closed
 * the tab and walked away.
 */
const CALIBRATION_KEEP_WARM_MS = 5 * 60_000;
/** Which screen the operator wants captured for a calibration stage.
 *
 *   - main     : Stage 1, world map. Mark CLAN button.
 *   - sidebars : Stage 2, My Clan dialog on its default sub-section.
 *                Mark Gifts + Members sidebar items (visible from any
 *                sub-section, so this stage doesn't need Gifts open).
 *   - gifts    : Stage 3, Gifts panel with at least one gift visible.
 *                Mark top tabs, Open button, and the card crop rect.
 *   - members  : Stage 4, Members list. Mark the names rectangle.
 */
// CalibrationStage and CalibrationNavOverrides moved to ./calibration.ts
// alongside the capture function that uses them. They're re-exported
// at the top of this file so existing call sites that imported them
// from './loop.js' keep working.
class ScanLoop {
    config;
    session;
    vision;
    onScanComplete;
    stateMachine = new state_machine_js_1.StateMachine();
    running = false;
    scanInProgress = false;
    timer = null;
    nextScanAt = null; // epoch ms when the next scheduled scan fires
    /**
     * Safety timer armed whenever the loop is paused. A pause is only ever
     * meant to be temporary (the login bridge pauses us while it's open),
     * but if a pause is never matched by a resume — e.g. a login bridge that
     * tears down via its idle/max-session timer without the route resuming
     * us — the scanner would sit paused forever, showing a stuck "Next scan:
     * now" and never scanning again. This fires after a window longer than
     * any legitimate pause and auto-resumes. Cleared by resume() and stop().
     */
    pauseWatchdog = null;
    // Comfortably longer than the login bridge's 30-min absolute session cap
    // (+3-min idle teardown) — the only thing that pauses the scanner — so a
    // real login session always ends and resumes on its own well first.
    static PAUSE_WATCHDOG_MS = 35 * 60_000;
    liveChestCount = 0; // Chests found during the in-progress scan
    /**
     * True while the daily might snapshot is reading the member list.
     *
     * Needed because the might phase runs AFTER the scan has been finalised, and
     * finalizing transitions the state machine to IDLE — so `state` alone says
     * "idle" for the 20–40 s the browser is still scrolling the Members panel, and
     * the header would drop the progress messages on the floor. This flag is what
     * lets the UI keep reporting instead, without the might phase having to touch
     * the state machine (which must stay clean so a might failure can never look
     * like a scan failure).
     */
    mightCaptureInProgress = false;
    /**
     * True while the daily resource-history capture is reading the capital history.
     *
     * Same purpose as mightCaptureInProgress: the phase runs after the scan has been
     * finalised, so the state machine is already back to IDLE and the UI would
     * otherwise show "idle" while the browser is visibly busy. Kept off the state
     * machine deliberately, so a resource failure can never look like a scan
     * failure.
     */
    resourceCaptureInProgress = false;
    /** Pending idle teardown of a warm calibration page. See
     *  scheduleCalibrationTeardown. */
    calibrationIdleTimer = null;
    /**
     * Clans whose next might capture should ignore the once-a-day gate.
     *
     * Set by the superadmin "Re-capture now" action so a change can be verified without
     * waiting for the next 17:00 UTC rollover.
     *
     * A SET, not a boolean. A cycle scans every active clan in turn and each one calls
     * captureMightBestEffort, so a single flag was consumed by whichever clan happened
     * to be scanned first and the rest silently kept their existing snapshot — the
     * override could never do what "re-capture" implies on a multi-clan instance.
     *
     * In memory only: a restart forgets it, which is the right failure mode for a manual
     * override.
     */
    forceMightRecaptureClans = new Set();
    progressMessage = ''; // Latest human-readable progress for the admin UI header
    /** Last scan failure surfaced to the UI header + /api/status. Set in the
     *  catch blocks below, cleared when a scan completes successfully. The
     *  `phase` is whatever progressMessage was mid-flight when the error hit
     *  — it gives the user concrete "during X" context instead of a bare
     *  exception string. */
    lastScanError = null;
    skipNextScheduling = false; // Set when a special-case handler has already scheduled the next cycle
    lastCapturedAtMs = 0; // Monotonic clock backing for nextCapturedAt(); see comment there.
    pauseAfterMemberCapture;
    skipMemberCapture;
    stopAfterMemberCapture;
    onProgress;
    /**
     * Clan currently being scanned. Single-clan deployments stay on 1.
     * Multi-clan rotation is driven by the outer scheduler (a future
     * commit) which calls setActiveClan() between sequential scans so all
     * the per-scan persistence (sessionRepo.createSession,
     * memberRepo.upsertMember, chestRepo.insertChest, merge/source caches)
     * stamps the right clan_id.
     */
    clanId = 1;
    /**
     * Number of scheduled scan cycles that have actually run a scan since
     * the last periodic teardown. When this hits ~24h worth of cycles
     * (see getCyclesBeforeRelaunch), runCycle calls
     * performPeriodicRelaunch to tear down both the browser AND the
     * Tesseract workers and rebuild them fresh. Reason: the browser
     * relaunch handles Chromium native allocations for single-clan
     * deployments (multi-clan already relaunches per clan), and the
     * vision teardown reclaims tesseract.js WASM heap that fragments
     * over thousands of recognize() calls — the dominant source of the
     * 400 MB → 1.5 GB drift observed over multi-day uptime.
     * Skipped cycles (uncalibrated, maintenance block) don't count
     * because they never hit the workers.
     */
    cyclesSinceRelaunch = 0;
    static MS_PER_DAY = 24 * 60 * 60 * 1000;
    constructor(config, session, vision, onScanComplete, options = {}) {
        this.config = config;
        this.session = session;
        this.vision = vision;
        this.onScanComplete = onScanComplete;
        this.pauseAfterMemberCapture = options.pauseAfterMemberCapture ?? true;
        this.skipMemberCapture = options.skipMemberCapture ?? false;
        this.stopAfterMemberCapture = options.stopAfterMemberCapture ?? false;
        this.onProgress = options.onProgress;
    }
    /**
     * Switch which clan subsequent scan operations target. Called by the
     * outer multi-clan scheduler between iterations. Doesn't relaunch the
     * browser — caller is responsible for handing in a fresh session
     * hydrated from the new clan's storage state if needed.
     */
    setActiveClan(clanId) {
        this.clanId = clanId;
    }
    getActiveClanId() {
        return this.clanId;
    }
    reportProgress(phase, message) {
        this.progressMessage = message;
        this.onProgress?.({ phase, message });
    }
    getProgressMessage() {
        return this.progressMessage;
    }
    getLastScanError() {
        return this.lastScanError;
    }
    /**
     * Manually clear the last-scan-error banner. Normally `lastScanError` is
     * wiped by the next successful scan (see scan-finalize.ts), but if the
     * operator has already investigated a failure and doesn't want to wait
     * for the next cycle, the admin "Dismiss" button in the header calls
     * this to remove the badge immediately.
     */
    clearLastScanError() {
        this.lastScanError = null;
    }
    recordScanError(err) {
        const message = err instanceof Error ? err.message : String(err);
        const phase = this.progressMessage || 'Scan failed';
        this.lastScanError = { message, phase, at: new Date().toISOString(), clanId: this.clanId };
        // Pass the Error object so pino's built-in err serializer renders
        // the stack trace into docker stdout. Bare strings would just print
        // the message and drop the trace we actually need for debugging.
        if (err instanceof Error) {
            log.error({ err, phase }, `Scan failed during: ${phase}`);
        }
        else {
            log.error({ err: String(err), phase }, `Scan failed during: ${phase}`);
        }
    }
    /**
     * Generate a strictly-monotonic ISO captured_at timestamp.
     *
     * better-sqlite3 inserts are synchronous and often complete in well under
     * one millisecond, so back-to-back calls to `new Date().toISOString()`
     * in the gift insert loop produced identical strings. That collided with
     * the chest_records UNIQUE constraint and silently dropped 4-6 real
     * chests per scan — the difference users saw between `chestsFound` and
     * `newChests`.
     *
     * This helper forces each call to return a timestamp at least 1ms newer
     * than the previous one by bumping off the max of (wall clock, last+1).
     * The drift is capped at one scan's worth of inserts (~hundreds of ms)
     * and is indistinguishable from normal "row created at" jitter.
     */
    nextCapturedAt() {
        const now = Date.now();
        const next = Math.max(now, this.lastCapturedAtMs + 1);
        this.lastCapturedAtMs = next;
        return new Date(next).toISOString();
    }
    // relaunchBrowserSession moved to ./auth-check.ts and is imported
    // above. Kept as a thin wrapper for the in-class call site (no other
    // module reaches in) so the existing assignment back to `this.session`
    // stays at the call site rather than getting hidden inside the helper.
    async start() {
        this.running = true;
        log.info(`Scan loop started (interval: ${this.config.scanIntervalMs / 1000}s)`);
        // If we previously detected maintenance and stored a "blocked until"
        // timestamp, defer the first cycle until that time. Survives redeploys
        // because the value lives on the mounted data volume.
        const blockedUntil = this.getMaintenanceBlockedUntil();
        if (blockedUntil !== null) {
            const remainingMs = blockedUntil - Date.now();
            if (remainingMs > 0) {
                const remainingMin = Math.round(remainingMs / 60_000);
                log.warn(`Maintenance block active until ${new Date(blockedUntil).toISOString()} - deferring first scan by ${remainingMin} min`);
                this.scheduleNextCycle(remainingMs);
                return;
            }
            // Block expired, clear the marker
            this.clearMaintenanceBlock();
        }
        // If a recent successful scan exists, defer the first cycle instead of
        // running immediately on startup. Avoids redundant scans on container
        // redeploys when the previous scan completed within one interval.
        //
        // The loop runs one global cycle over every active clan per tick, so
        // the relevant "last scan" is the newest completion across all of them.
        // Keying off clan #1 alone (this.clanId before the rotation starts)
        // made a redeploy scan immediately whenever another clan was scanned
        // most recently — e.g. a manual scan of clan #2 — even though the
        // global countdown still had time left.
        const activeClanIds = (0, clan_repo_js_1.listClans)({ activeOnly: true }).map((c) => c.id);
        const clanIdsToCheck = activeClanIds.length > 0 ? activeClanIds : [this.clanId];
        const lastCompletedAt = sessionRepo.getLatestCompletedAt(clanIdsToCheck);
        if (lastCompletedAt) {
            const elapsedMs = Date.now() - new Date(lastCompletedAt).getTime();
            if (elapsedMs >= 0 && elapsedMs < this.config.scanIntervalMs) {
                const remainingMs = this.config.scanIntervalMs - elapsedMs;
                const remainingMin = Math.round(remainingMs / 60_000);
                log.info(`Last scan across active clans completed ${Math.round(elapsedMs / 60_000)} min ago - deferring first scan by ${remainingMin} min`);
                this.scheduleNextCycle(remainingMs);
                return;
            }
        }
        // Seed the timer with an estimated next-scan time before the first
        // cycle starts. The cycle itself can take several minutes (auth,
        // member capture, gift OCR), and without this seed `getNextScanAt()`
        // returns null for that whole window — the dashboard header shows
        // a blank countdown until the first cycle finishes and
        // scheduleNextCycle() finally writes the precise timestamp. Seeding
        // means the countdown is populated from the moment the loop starts.
        this.nextScanAt = Date.now() + this.config.scanIntervalMs;
        await this.runCycle();
    }
    getMaintenanceBlockedUntil() {
        const raw = (0, persistent_env_js_1.readEnvValue)(MAINTENANCE_UNTIL_KEY);
        if (!raw)
            return null;
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }
    setMaintenanceBlock(durationMs) {
        const until = Date.now() + durationMs + scan_finalize_js_1.MAINTENANCE_BUFFER_MS;
        (0, persistent_env_js_1.updateEnvValue)(MAINTENANCE_UNTIL_KEY, String(until));
        log.info(`Persisted maintenance block until ${new Date(until).toISOString()}`);
    }
    clearMaintenanceBlock() {
        (0, persistent_env_js_1.deleteEnvValue)(MAINTENANCE_UNTIL_KEY);
    }
    getCardCropPcts() {
        const l = this.config.scanCropLeftPct;
        const t = this.config.scanCropTopPct;
        const r = this.config.scanCropRightPct;
        const b = this.config.scanCropBottomPct;
        if (l > 0 && t > 0 && r > l && b > t)
            return { left: l, top: t, right: r, bottom: b };
        return undefined;
    }
    stop() {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        // A deliberate stop is not a pause — don't let the watchdog silently
        // resume a loop the operator (or shutdown) explicitly halted.
        this.clearPauseWatchdog();
        this.nextScanAt = null;
        log.info('Scan loop stopped');
    }
    /** (Re)arm the pause safety timer — see pauseWatchdog. */
    armPauseWatchdog() {
        if (this.pauseWatchdog)
            clearTimeout(this.pauseWatchdog);
        this.pauseWatchdog = setTimeout(() => {
            this.pauseWatchdog = null;
            // Only self-heal a genuinely stuck pause: if we've since resumed or a
            // scan is somehow running, there's nothing to recover.
            if (this.running || this.scanInProgress)
                return;
            log.warn('Scanner has been paused longer than the safety window — auto-resuming. ' +
                'A login session likely ended without resuming the scanner.');
            this.resume();
        }, ScanLoop.PAUSE_WATCHDOG_MS);
    }
    clearPauseWatchdog() {
        if (this.pauseWatchdog) {
            clearTimeout(this.pauseWatchdog);
            this.pauseWatchdog = null;
        }
    }
    /**
     * Pauses scheduled scans without tearing down the scanner state. Used while
     * the admin login bridge is open so a second Playwright browser doesn't
     * compete with us for memory. resume() re-arms the next cycle.
     * Returns false if a scan is already mid-flight (caller should refuse).
     */
    pause() {
        if (this.scanInProgress)
            return false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        // Deliberately leave nextScanAt populated — the dashboard countdown
        // keeps ticking through the pause so the operator sees real time
        // elapse during a login refresh. resume() reads it back to schedule
        // a delay relative to the original anchor instead of restarting the
        // interval from scratch.
        this.running = false;
        // Belt-and-suspenders: even with the login bridge's teardown hook
        // resuming us, arm a watchdog so no future pause path can strand the
        // scanner the way an abandoned login session used to.
        this.armPauseWatchdog();
        log.info('Scan loop paused');
        return true;
    }
    resume() {
        // Clear the safety timer even if we're already running — a resume from
        // any source (route, bridge teardown hook, or the watchdog itself)
        // means the pause is over and the watchdog has nothing left to recover.
        this.clearPauseWatchdog();
        if (this.running)
            return;
        this.running = true;
        let delay;
        if (this.nextScanAt !== null) {
            const remaining = this.nextScanAt - Date.now();
            // Already-overdue cycles get a short grace window so any post-
            // login cookie/storage settling completes before we scan.
            delay = remaining > 0 ? remaining : 5_000;
        }
        else {
            delay = this.config.scanIntervalMs;
        }
        log.info(`Scan loop resumed (next scan in ${Math.round(delay / 60_000)} min)`);
        this.scheduleNextCycle(delay);
    }
    isPaused() {
        return !this.running;
    }
    isScanInProgress() {
        return this.scanInProgress;
    }
    /**
     * Returns the number of chests found in the current in-progress scan.
     * Zero when no scan is running.
     */
    getLiveChestCount() {
        return this.liveChestCount;
    }
    /**
     * Returns the epoch ms when the next scheduled scan will fire,
     * or null if no scan is scheduled. Global timer — every active clan
     * gets scanned in the same cycle, so this is the same wall-clock time
     * for every clan that's in the rotation.
     */
    getNextScanAt() {
        return this.nextScanAt;
    }
    /**
     * Per-clan view of the next-scan timer. Returns the global timer when
     * `clanId` is in the active rotation, otherwise null. Used by
     * `/api/status` so a regular admin whose clan has been deactivated
     * doesn't see a misleading countdown for a scan that won't touch their
     * clan. Superadmins should call `getNextScanAt()` directly to see the
     * global cycle regardless of the dropdown.
     */
    getNextScanAtForClan(clanId) {
        if (this.nextScanAt === null)
            return null;
        const active = (0, clan_repo_js_1.listClans)({ activeOnly: true });
        if (active.length === 0) {
            // Boot-time fallback: runCycle defaults to clan #1 when no active
            // clans exist. Mirror that here so the very first run still shows
            // a countdown for the seed clan.
            return clanId === 1 ? this.nextScanAt : null;
        }
        return active.some((c) => c.id === clanId) ? this.nextScanAt : null;
    }
    /**
     * Cycles to run before tearing down + rebuilding the browser and
     * Tesseract workers. Derived from the current scan interval so the
     * cadence is ~24h regardless of how the operator has the interval
     * set: at 120 min → 12 cycles, at 60 min → 24, at 30 min → 48.
     * Min of 1 guards against absurd configurations.
     */
    getCyclesBeforeRelaunch() {
        return Math.max(1, Math.round(ScanLoop.MS_PER_DAY / this.config.scanIntervalMs));
    }
    /**
     * Close the browser at the end of a cycle instead of leaving it idling
     * until the next one.
     *
     * A scan takes minutes; the interval between scans is hours. Parking the
     * page on about:blank (finishScan) frees the renderer's document, but the
     * browser process tree — including the GPU process — survives navigation,
     * and with SCANNER_GPU on that process is holding the Unity texture,
     * shader and transfer-buffer pools it built up while rendering the game.
     * On an iGPU those live in system RAM and are charged to this container's
     * cgroup, so about:blank cannot reach them: only the process exiting frees
     * them. Keeping a full Chromium parked for ~115 of every 120 minutes was
     * paying that bill continuously for nothing.
     *
     * Safe because every entry point that needs a page already copes with a
     * closed session: runCycle's fast path, triggerManualScan and
     * captureCalibrationScreenshot all call ensureLiveSession, and the
     * clan-switch branch launches its own. Relaunching costs a few seconds
     * against an interval measured in hours.
     */
    async releaseBrowserBetweenCycles() {
        if (this.session.page.isClosed())
            return;
        try {
            await (0, launcher_js_1.closeBrowser)(this.session);
            log.info('Closed the browser until the next cycle — a parked Chromium keeps its GPU-side memory.');
        }
        catch (err) {
            log.warn('Could not close the browser between cycles (continuing): ' + String(err));
        }
    }
    /**
     * Periodic vision-provider recycle. Currently close to a no-op, and
     * deliberately kept that way rather than deleted.
     *
     * This existed to reclaim tesseract.js WASM heap, which fragmented across
     * thousands of recognize() calls and was the dominant source of the
     * 400 MB → 1.5 GB multi-day drift. Tesseract is gone (4c9c9bc), and
     * PaddleOcrProvider.teardown() is an explicit no-op: the ONNX models load
     * once into a module-level singleton with no worker pool behind them, so
     * there is no per-call heap to recycle.
     *
     * What that means in practice: this no longer reclaims anything, and if
     * idle memory is seen climbing cycle-over-cycle now that the browser exits
     * after every cycle (releaseBrowserBetweenCycles), the cause is inside the
     * Node process — ONNX Runtime arenas and the sharp/libvips cache, neither
     * of which returns memory to the OS — and fixing it means giving the
     * provider a real teardown, not calling this more often.
     *
     * Kept because the hook is the right shape for that fix and the cadence
     * logic (getCyclesBeforeRelaunch) is still what we'd want to drive it.
     * Called from the end of runCycle when the threshold trips, never mid-scan.
     */
    async performPeriodicRelaunch() {
        log.info(`Periodic vision recycle after ${this.cyclesSinceRelaunch} cycle(s)`);
        try {
            if (this.vision.teardown) {
                await this.vision.teardown();
            }
            await this.vision.initialize(this.config);
        }
        catch (err) {
            log.warn('Periodic vision recycle failed (continuing): ' + String(err));
        }
        this.cyclesSinceRelaunch = 0;
    }
    /**
     * Relaunch the browser when the current session is dead — the page is
     * closed because runSingleScan deliberately tore it down (clan blocked
     * on re-auth, see the `!authResult.ok` branch) or because the target
     * crashed and nothing recovered it. A cheap no-op on a healthy session,
     * so every entry point that needs a driveable page can call it
     * unconditionally instead of guessing whether the last cycle left one.
     */
    async ensureLiveSession(clanId = this.clanId) {
        if (!this.session.page.isClosed())
            return;
        log.info(`Browser session was closed; relaunching for clan #${clanId}`);
        try {
            await (0, launcher_js_1.closeBrowser)(this.session);
        }
        catch {
            // ignore — already down, we only want the context handles released
        }
        this.session = await this.launchForClan(clanId);
    }
    /**
     * Launch the scanner browser bound to one clan.
     *
     * Central so the per-clan isolation — profile dir and storage state — cannot
     * drift apart across the four places that relaunch. Sharing either between
     * clans leaks one clan's session into another's scan.
     */
    async launchForClan(clanId) {
        return (0, launcher_js_1.launchBrowser)(this.config, {
            storageStatePath: (0, clan_paths_js_1.clanStorageStatePath)(clanId),
            userDataDir: (0, clan_paths_js_1.clanBrowserProfileDir)(clanId),
        });
    }
    scheduleNextCycle(delayMs) {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.nextScanAt = Date.now() + delayMs;
        this.timer = setTimeout(() => this.runCycle(), delayMs);
    }
    /**
     * Capture a one-off screenshot of the Gifts panel for the operator to
     * use as a calibration target. Acquires the same scan-in-progress
     * lock as a regular scan so we don't conflict with one. Navigates the
     * browser to the game (auth check), opens My Clan → Gifts, takes a
     * screenshot via captureForVision, and writes it to a known path.
     *
     * The operator then opens the admin UI Calibrate flow, clicks the
     * topmost Open button on the displayed screenshot, and the click
     * coordinates get persisted as canvas-relative percentages so the
     * pipelined scanner knows where to click on every subsequent run.
     *
     * Returns the screenshot path + canvas bounds (the operator's UI
     * needs the bounds to convert pixel clicks to percentages) or an
     * error string explaining why the capture failed.
     */
    async captureCalibrationScreenshot(stage = 'gifts', overrides = {}) {
        if (this.scanInProgress) {
            return { ok: false, error: 'A scan is currently running. Wait for it to finish, then try again.' };
        }
        this.scanInProgress = true;
        try {
            // A re-auth failure may have closed the browser on the last cycle;
            // the calibration capture needs a live page to drive.
            await this.ensureLiveSession();
            // Capture flow lives in src/scheduler/calibration.ts. ScanLoop
            // owns the single-flight guard and the about:blank teardown
            // because both touch session lifecycle that the helper doesn't
            // need to know about.
            return await (0, calibration_js_2.captureCalibrationScreenshot)(this.session.page, this.stateMachine, stage, overrides);
        }
        finally {
            this.scanInProgress = false;
            // Leave the game LOADED and arm an idle teardown instead of parking on
            // about:blank straight away.
            //
            // The teardown itself is not optional — a hot Unity WebGL context is one of
            // the biggest single consumers of RAM in this container, and a wizard run
            // that leaves several behind is exactly how idle memory used to balloon. But
            // doing it immediately makes every capture pay a cold start: reloading the
            // game, plus navigateToGame's 24-30s wait for promos to stream in and
            // ~14s of dismissPopups. That is ~45s of a ~60s capture spent re-earning
            // state that was just discarded.
            //
            // Multi-pass stages made that cost land repeatedly: Stages 5 and 6 are each
            // captured at least twice by design, so the operator paid the full cold
            // start for a screenshot that differs from the previous one by a single
            // in-game click. Keeping the page warm for a few minutes turns the second
            // and later captures into seconds, and the timer still frees the context for
            // an operator who wanders off.
            this.scheduleCalibrationTeardown();
        }
    }
    /**
     * Park the calibration page on about:blank once the operator has stopped
     * capturing for a while, freeing the Unity WebGL context.
     *
     * Re-armed by every capture, so a run of wizard steps keeps the page warm and
     * only the trailing idle period pays the teardown.
     */
    scheduleCalibrationTeardown() {
        if (this.calibrationIdleTimer)
            clearTimeout(this.calibrationIdleTimer);
        this.calibrationIdleTimer = setTimeout(() => {
            this.calibrationIdleTimer = null;
            void this.parkCalibrationPage();
        }, CALIBRATION_KEEP_WARM_MS);
        // Deliberately does not keep the process alive: this is a memory-hygiene
        // timer, and a shutdown that's waiting on it would be worse than a context
        // freed a moment later by exit.
        this.calibrationIdleTimer.unref?.();
        log.info(`Calibration capture: leaving the game loaded for ${Math.round(CALIBRATION_KEEP_WARM_MS / 60_000)} `
            + 'minute(s) so the next capture in this wizard session is fast.');
    }
    async parkCalibrationPage() {
        // A scan (or another capture) may have claimed the page since the timer was
        // armed. Navigating away underneath it would break it, and it will do its own
        // teardown when it finishes — so stand down and let it.
        if (this.scanInProgress) {
            log.info('Calibration idle teardown skipped — the page is busy; its own teardown will run.');
            return;
        }
        try {
            if (this.session.page.isClosed()) {
                log.debug('Calibration idle teardown: page already closed, nothing to free.');
                return;
            }
            const url = this.session.page.url();
            if (url.startsWith('about:'))
                return; // already parked
            await this.session.page.goto('about:blank', { timeout: 10_000 });
            log.info('Calibration idle teardown: navigated to about:blank to free the WebGL context.');
        }
        catch (err) {
            log.warn('Calibration idle teardown: about:blank navigation failed (non-fatal): '
                + String(err instanceof Error ? err.message : err));
        }
    }
    /**
     * Trigger a one-off scan outside the normal schedule.
     *
     * When `targetClanId` is provided and differs from the loop's currently
     * active clan, hot-swap the browser session to that clan's storage
     * state + profile dir before scanning. This is the path used by the
     * superadmin "Trigger Manual Scan" button — the operator picks a clan
     * in the dropdown and expects the scan to target only that clan
     * regardless of where the scheduled rotation happens to be.
     *
     * Mirrors the same setActiveClan + closeBrowser + launchBrowser
     * sequence runCycle uses when iterating active clans, so the operator
     * sees identical isolation guarantees: a different clan's cookies /
     * IndexedDB / service workers can't leak in.
     */
    async triggerManualScan(targetClanId) {
        if (this.scanInProgress) {
            log.info('Manual scan requested but a scan is already in progress - rejecting');
            return { success: false, chestsFound: 0, newChests: 0, errors: 0, giftsData: [], triumphalData: [], alreadyRunning: true };
        }
        if ((0, resource_upload_lock_js_1.isResourceUploadActive)()) {
            log.info('Manual scan requested but resource uploads are in progress - rejecting');
            return { success: false, chestsFound: 0, newChests: 0, errors: 0, giftsData: [], triumphalData: [], alreadyRunning: true };
        }
        // Cancel any pending scheduled cycle - the manual scan replaces it,
        // and we'll reschedule the next one for a full interval after this scan.
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
            this.nextScanAt = null;
            log.info('Cleared pending scheduled scan - manual scan will replace it');
        }
        if (targetClanId !== undefined && targetClanId !== this.clanId) {
            log.info(`Manual scan: switching browser to clan #${targetClanId} (was clan #${this.clanId})`);
            this.setActiveClan(targetClanId);
            try {
                await (0, launcher_js_1.closeBrowser)(this.session);
            }
            catch {
                // ignore — about to relaunch
            }
            this.session = await this.launchForClan(targetClanId);
        }
        // No clan switch (or a switch that landed on the same clan) means we
        // keep whatever browser the last cycle left behind — which may have
        // been torn down after a re-auth failure.
        await this.ensureLiveSession();
        const result = await this.runSingleScan('manual');
        // Reschedule the next cycle to run a full interval after this manual scan
        if (this.running) {
            const delay = this.stateMachine.isError()
                ? Math.min(this.config.scanIntervalMs * 3, 1800_000)
                : this.config.scanIntervalMs;
            this.scheduleNextCycle(delay);
            log.info(`Next scheduled scan in ${Math.round(delay / 60000)} minute(s)`);
        }
        return result;
    }
    /**
     * Trigger a one-off scan that iterates every active clan, the same
     * way the scheduled cycle does. Used by the superadmin "Scan all
     * clans" button when the operator wants to refresh every clan
     * outside the normal interval. runCycle handles the per-clan browser
     * hot-swap and reschedules the next cycle when it finishes, so this
     * is just the cancel-pending-timer + invoke pattern.
     */
    async triggerManualScanAllClans() {
        if (this.scanInProgress) {
            log.info('Manual scan-all requested but a scan is already in progress - rejecting');
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
            this.nextScanAt = null;
            log.info('Cleared pending scheduled scan - manual scan-all will replace it');
        }
        if (!this.running) {
            log.info('Manual scan-all requested but the scan loop is not running');
            return;
        }
        // runCycle iterates active clans, scans each, and schedules the next
        // cycle at its tail. Pass 'manual' so each per-clan scan_sessions
        // row records the correct trigger_source — otherwise this path
        // looked indistinguishable from a scheduled cycle in scan history.
        await this.runCycle('manual');
    }
    getScanIntervalMs() {
        return this.config.scanIntervalMs;
    }
    setScanIntervalMs(nextIntervalMs) {
        const prevIntervalMs = this.config.scanIntervalMs;
        this.config.scanIntervalMs = nextIntervalMs;
        log.info(`Scan interval updated to ${Math.round(nextIntervalMs / 1000)}s`);
        // If there's a pending scheduled scan, recompute its fire time so the
        // change takes effect immediately. Use the same "start" anchor (current
        // nextScanAt - prevInterval) and add the new interval on top of that.
        if (this.running && !this.scanInProgress && this.nextScanAt !== null && this.timer) {
            const anchor = this.nextScanAt - prevIntervalMs; // when the last scan finished
            const newNextAt = anchor + nextIntervalMs;
            const remaining = Math.max(0, newNextAt - Date.now());
            log.info(`Rescheduling next scan based on new interval: ${Math.round(remaining / 60000)} min remaining`);
            this.scheduleNextCycle(remaining);
        }
    }
    /**
     * Live-update scanner debug N on the running ScanLoop. Mirrors the
     * setScanIntervalMs pattern: mutate the in-memory config object so
     * the next runSingleScan picks up the new value without restart.
     */
    setScannerSettings(opts) {
        if (opts.scanDebugFirstN !== undefined) {
            this.config.scanDebugFirstN = opts.scanDebugFirstN;
            log.info(`Scanner debug first-N updated to ${opts.scanDebugFirstN}`);
        }
        if (opts.scanMaxChests !== undefined) {
            this.config.scanMaxChests = opts.scanMaxChests;
            log.info(`Max chests per scan updated to ${opts.scanMaxChests}`);
        }
        if (opts.enableRawOcrCapture !== undefined) {
            this.config.enableRawOcrCapture = opts.enableRawOcrCapture;
            log.info(`Raw OCR capture ${opts.enableRawOcrCapture ? 'enabled' : 'disabled'}`);
        }
        if (opts.mightTrackingEnabled !== undefined) {
            this.config.mightTrackingEnabled = opts.mightTrackingEnabled;
            log.info(`Might tracking ${opts.mightTrackingEnabled ? 'enabled' : 'disabled'}`);
        }
        if (opts.resourceCaptureEnabled !== undefined) {
            this.config.resourceCaptureEnabled = opts.resourceCaptureEnabled;
            log.info(`Automated resource capture ${opts.resourceCaptureEnabled ? 'enabled' : 'disabled'}`);
        }
    }
    /**
     * Live-update calibration on the running ScanLoop. Accepts a partial set
     * of fields so each wizard stage can save its own without disturbing the
     * others. The next runSingleScan / member capture picks up the new values
     * without a container restart.
     */
    setCalibration(opts) {
        const updated = [];
        for (const [key, value] of Object.entries(opts)) {
            if (value === undefined)
                continue;
            // Type-checked via the CalibrationFields constraint above.
            this.config[key] = value;
            updated.push(`${key}=${value.toFixed(4)}`);
        }
        if (updated.length > 0) {
            log.info(`Scanner calibration updated: ${updated.join(', ')}`);
        }
    }
    getState() {
        return this.stateMachine.getState();
    }
    /**
     * One full sweep across every active clan. Called from the timer for
     * scheduled cycles and from `triggerManualScanAllClans` when a
     * superadmin clicks "Scan all clans". The trigger source is threaded
     * down to runSingleScan so the resulting scan_sessions row carries
     * the correct `trigger_source` — without this, the manual scan-all
     * path was logging every per-clan scan as 'scheduled'.
     */
    async runCycle(triggerSource = 'scheduled') {
        if (!this.running)
            return;
        // If a scan (e.g. manual) is already running, or resource uploads are
        // active, defer this scheduled cycle by 60 seconds and try again.
        if (this.scanInProgress) {
            log.info('Scheduled scan deferred - another scan is in progress, retrying in 60s');
            if (this.running)
                this.scheduleNextCycle(60_000);
            return;
        }
        if ((0, resource_upload_lock_js_1.isResourceUploadActive)()) {
            log.info('Scheduled scan deferred - resource uploads are in progress, retrying in 60s');
            if (this.running)
                this.scheduleNextCycle(60_000);
            return;
        }
        // Onboarding gate: calibration is global, so an uncalibrated
        // instance has nothing useful to do this cycle. Reschedule and bail
        // instead of marching into the per-clan loop just to hit
        // CalibrationMissingError once per clan. The dashboard banner tells
        // the operator how to clear this.
        if (!(0, calibration_js_1.isFullyCalibrated)()) {
            log.info('Scheduled scan skipped — scanner not yet calibrated. Operator must finish Admin → Scanner Mode → Calibrate.');
            if (this.running) {
                this.scheduleNextCycle(this.config.scanIntervalMs);
            }
            return;
        }
        // Multi-clan: iterate every active clan in sequence, scanning one
        // at a time. The Chromium/WebGL bottleneck means we never run two
        // browsers concurrently; this loop is intentionally serial. Single-
        // clan deployments fall through with one iteration.
        const fs = await import('fs');
        const activeClans = (0, clan_repo_js_1.listClans)({ activeOnly: true });
        const clansToScan = activeClans.length > 0 ? activeClans : [{ id: 1 }];
        // Set to true once a clan in this cycle reaches runSingleScan, so
        // skipped-everything cycles (all clans gated out) don't tick the
        // periodic-relaunch counter. The workers only leak when they
        // actually OCR something.
        let scanRanThisCycle = false;
        for (let i = 0; i < clansToScan.length; i++) {
            const clan = clansToScan[i];
            if (!this.running)
                break;
            // Defense in depth: skip any clan that hasn't been signed in yet.
            // Without a storage-state.json the launched browser would either
            // hit TB's login page (best case, scan fails cleanly) or — if a
            // bug ever leaks another clan's persistent profile — silently
            // scan as that other clan and stamp the rows with the wrong
            // clan_id. Refusing here means a freshly-created clan never
            // enters the rotation until its login bridge has captured a
            // session, even if the operator forgot to deactivate it.
            if (!fs.existsSync((0, clan_paths_js_1.clanStorageStatePath)(clan.id))) {
                log.info(`Clan #${clan.id}: skipping scan — no storage state yet (sign in via Clans → Log in to Total Battle).`);
                continue;
            }
            // Per-clan onboarding gate: refuse to start a chest scan until
            // this clan has a captured member list. The chest pipeline doesn't
            // need the member list per se, but running a chest scan before the
            // operator has signed off on names produces report rows attributed
            // to "<unknown>" or to whatever garbage OCR'd out of the gifts
            // popup. Better to block here and surface the next step.
            if ((0, member_capture_js_1.needsMemberCapture)(clan.id)) {
                log.info(`Clan #${clan.id}: skipping scan — member list not yet captured (operator must run Clans → Capture members).`);
                continue;
            }
            // Hot-swap browser to the clan's storage state AND profile dir.
            // Both are per-clan so cookies / localStorage / IndexedDB /
            // service workers from a different clan never leak in. Skip the
            // teardown + relaunch when the clan is already active AND we're
            // not iterating multiple clans (single-clan deployments hit this
            // fast path).
            if (this.clanId !== clan.id || activeClans.length > 1) {
                this.setActiveClan(clan.id);
                try {
                    await (0, launcher_js_1.closeBrowser)(this.session);
                }
                catch {
                    // ignore — about to relaunch
                }
                this.session = await this.launchForClan(clan.id);
                log.info(`Switched browser to clan #${clan.id} (${i + 1}/${clansToScan.length})`);
            }
            else {
                // Fast path reuses the existing browser — but a previous cycle
                // may have closed it on purpose (clan blocked on re-auth), so
                // make sure there's a live page before driving it.
                await this.ensureLiveSession(clan.id);
            }
            scanRanThisCycle = true;
            try {
                await this.runSingleScan(triggerSource);
            }
            catch (err) {
                if (!this.lastScanError || this.lastScanError.at < new Date(Date.now() - 5_000).toISOString()) {
                    this.recordScanError(err);
                }
            }
        }
        // Scanning is done for this cycle and the next one is a whole interval
        // away, so let the browser go. This is the main lever on steady-state
        // memory: a parked Chromium still holds its GPU process and everything
        // that process cached while rendering the game — see
        // releaseBrowserBetweenCycles. Ahead of the skipNextScheduling return
        // below, because a maintenance block defers the next cycle by even longer
        // than usual and is the last case that should hold a browser open.
        await this.releaseBrowserBetweenCycles();
        // Special-case handlers (e.g. maintenance) may already have scheduled
        // the next cycle with their own delay. Don't override it.
        if (this.skipNextScheduling) {
            this.skipNextScheduling = false;
            return;
        }
        // Periodic OCR-worker teardown. Done after the per-clan loop so it never
        // interrupts an in-flight scan, and before scheduleNextCycle so the next
        // timer fires against fresh workers. Only counts cycles that actually
        // scanned — a maintenance-blocked or uncalibrated cycle didn't hit the
        // workers so it shouldn't count toward the leak.
        if (scanRanThisCycle) {
            this.cyclesSinceRelaunch++;
            if (this.cyclesSinceRelaunch >= this.getCyclesBeforeRelaunch()) {
                // The recycle now frees the OCR models for real, and a resource upload
                // OCRs on the same shared service. Uploads are checked at the top of a
                // cycle, but one can start while the cycle runs — so re-check here
                // rather than pulling the models out from under an in-flight import.
                // Skipping costs nothing: the counter stays over threshold and the
                // next cycle recycles instead.
                if ((0, resource_upload_lock_js_1.isResourceUploadActive)()) {
                    log.info('Deferring the periodic vision recycle — a resource upload is using the OCR models.');
                }
                else {
                    try {
                        await this.performPeriodicRelaunch();
                    }
                    catch (err) {
                        // Non-fatal: a failed teardown leaves the existing models in place
                        // and we'll try again next time the threshold trips. Logged at
                        // warn so the operator sees it in container stdout.
                        log.warn('Periodic vision recycle threw; continuing with the existing models: ' + String(err));
                    }
                }
            }
        }
        if (this.running) {
            // Always retry at the normal scan interval. Most failures are
            // transient (popup, OCR hiccup, brief network blip) and the
            // configured interval (typically 60-120 min) is already a gentle
            // retry cadence. Maintenance is handled separately and doesn't
            // count toward errors. The state machine still tracks consecutive
            // failures for visibility.
            const errorCount = this.stateMachine.getErrorCount();
            if (errorCount > 0) {
                log.info(`Next scan in ${Math.round(this.config.scanIntervalMs / 60_000)} min (consecutive failures: ${errorCount})`);
            }
            this.scheduleNextCycle(this.config.scanIntervalMs);
        }
    }
    async runSingleScan(triggerSource = 'scheduled') {
        if (this.scanInProgress) {
            log.debug('Scan cycle skipped - another scan is already in progress');
            return { success: false, chestsFound: 0, newChests: 0, errors: 0, giftsData: [], triumphalData: [] };
        }
        if ((0, resource_upload_lock_js_1.isResourceUploadActive)()) {
            log.debug('Scan cycle skipped - resource uploads are in progress');
            return { success: false, chestsFound: 0, newChests: 0, errors: 0, giftsData: [], triumphalData: [] };
        }
        this.scanInProgress = true;
        this.liveChestCount = 0;
        this.progressMessage = '';
        const result = {
            success: false,
            chestsFound: 0,
            newChests: 0,
            errors: 0,
            giftsData: [],
            triumphalData: [],
        };
        // The scan body lives in executeScan so this try/finally is the ONE
        // place that owns teardown. It used to sit around the post-auth
        // pipeline only, so the early returns above it (auth failure,
        // member-capture-only runs) skipped the about:blank navigation and
        // left a live Total Battle page — login screen or half-loaded WebGL
        // canvas — idling in the browser for the whole scan interval.
        try {
            const scanResult = await this.executeScan(triggerSource, result);
            // Might snapshot runs here, deliberately outside executeScan: at this
            // point the gifts/triumphal sweeps have committed and the scan_sessions
            // row is written, so nothing this phase does can roll chest data back.
            // See captureMightBestEffort for the rest of the isolation.
            await this.captureMightBestEffort(scanResult);
            // Resource history runs after might for one practical reason: might is the
            // cheaper and older of the two, so if the session is going to die on a
            // post-scan phase it should die on the one whose data can't be re-read.
            // The capital history keeps ~14 days, so a run this loses is picked up
            // tomorrow at no cost.
            await this.captureResourcesBestEffort(scanResult);
            return scanResult;
        }
        finally {
            await this.finishScan();
        }
    }
    /**
     * Run the daily might snapshot, swallowing everything.
     *
     * Might is a nice-to-have; chests are the product. So this is the one call in
     * the scan path that is allowed to fail silently, and it is positioned where
     * failing silently is safe — after the scan result is final. It deliberately
     * does not touch `lastScanError` or the state machine: a might problem must
     * never surface as a scan failure, block the next cycle, or trip the retry
     * cadence. The phase itself logs anything an operator needs to act on.
     *
     * Skipped outright unless a real scan succeeded. A failed scan means the game
     * session is in an unknown state (maintenance, kicked, a stuck popup), and
     * driving it further to read a number nobody is waiting for is pure downside.
     * The sessionId check excludes the onboarding "stop after member capture"
     * path, which reports success without ever running a scan — the operator is
     * mid-review there and the browser should be left where they expect it.
     */
    async captureMightBestEffort(scanResult) {
        // Checked first and silently: when the feature is off there is nothing to
        // report, and a line per clan per cycle would be noise for every deployment
        // not using it. Every skip BELOW this point is logged, because by then the
        // operator has opted in and a silent no-op is indistinguishable from a bug —
        // which is exactly how a routine "already captured today" skip came across as
        // the feature ignoring a clan.
        if (!this.config.mightTrackingEnabled)
            return;
        if (!scanResult.success) {
            log.info(`Might capture skipped for clan #${this.clanId} — the scan did not complete successfully, ` +
                'so the game session is in an unknown state. It will be retried on the next cycle.');
            return;
        }
        if (scanResult.sessionId === undefined) {
            log.info(`Might capture skipped for clan #${this.clanId} — this cycle ran member capture only and ` +
                'never started a scan session.');
            return;
        }
        if (this.session.page.isClosed()) {
            log.info(`Might capture skipped for clan #${this.clanId} — the browser was already closed.`);
            return;
        }
        this.mightCaptureInProgress = true;
        // Consume THIS clan's override up front — delete() reports whether it was armed
        // and removes it in one step, so a throw mid-capture can't leave it set and
        // silently re-force every subsequent cycle, and one clan can't eat another's.
        const force = this.forceMightRecaptureClans.delete(this.clanId);
        try {
            const { runMightCapturePhase } = await import('./might-capture-phase.js');
            await runMightCapturePhase({
                config: this.config,
                clanId: this.clanId,
                force,
                reportProgress: (message) => this.reportProgress('scan', message),
            }, this.session.page);
        }
        catch (err) {
            log.warn(`Might capture threw and was ignored (the chest scan is unaffected): ${String(err instanceof Error ? err.message : err)}`);
        }
        finally {
            this.mightCaptureInProgress = false;
            // finishScan clears progressMessage a moment later, but clear it here too
            // so the header can't sit on a stale "Might: 34 members read" line if the
            // phase exits early.
            this.progressMessage = '';
        }
    }
    /** True while the daily might snapshot is running — see mightCaptureInProgress. */
    isMightCaptureInProgress() {
        return this.mightCaptureInProgress;
    }
    /**
     * Run the daily resource-history capture, swallowing everything.
     *
     * Same isolation contract as captureMightBestEffort — see that method's comment
     * for the reasoning, which applies verbatim. The one difference worth naming is
     * that the data here is persistent: a gift is gone once opened, but the capital
     * history keeps about 14 days, so a skipped or failed run costs a delay rather
     * than a hole. That's why this phase is the LAST thing the scan cycle does.
     */
    async captureResourcesBestEffort(scanResult) {
        // Silent when off, for the same reason might is: a line per clan per cycle on
        // every deployment not using the feature is noise. Every skip below this
        // point is logged by the phase itself.
        if (!this.config.resourceCaptureEnabled)
            return;
        if (!scanResult.success) {
            log.info(`Resource capture skipped for clan #${this.clanId} — the scan did not complete ` +
                'successfully, so the game session is in an unknown state. It will be retried next cycle.');
            return;
        }
        if (scanResult.sessionId === undefined) {
            log.info(`Resource capture skipped for clan #${this.clanId} — this cycle ran member capture only ` +
                'and never started a scan session.');
            return;
        }
        if (this.session.page.isClosed()) {
            log.info(`Resource capture skipped for clan #${this.clanId} — the browser was already closed.`);
            return;
        }
        this.resourceCaptureInProgress = true;
        try {
            const { runResourceCapturePhase } = await import('./resource-capture-phase.js');
            await runResourceCapturePhase({
                config: this.config,
                clanId: this.clanId,
                reportProgress: (message) => this.reportProgress('scan', message),
            }, this.session.page);
        }
        catch (err) {
            log.warn('Resource capture threw and was ignored (the chest scan is unaffected): '
                + String(err instanceof Error ? err.message : err));
        }
        finally {
            this.resourceCaptureInProgress = false;
            this.progressMessage = '';
        }
    }
    /** True while the daily resource-history capture is running. */
    isResourceCaptureInProgress() {
        return this.resourceCaptureInProgress;
    }
    /**
     * Run a resource-history capture right now, outside the scan cycle.
     *
     * This is the debugging entry point behind the admin "Collect now" button, and
     * it deliberately bypasses both the global feature flag and the once-a-day gate:
     * the whole feature can only be exercised against the live game, and waiting for
     * a 17:00 UTC rollover between attempts would make iterating on it impractical.
     * Safe to press repeatedly — the cursor means a second run re-finds its own
     * marker from minutes earlier and inserts nothing.
     *
     * Takes the scan-in-progress lock so it can't run alongside a scan, a might
     * capture or a calibration capture, all of which drive the same page.
     *
     * `targetClanId` hot-swaps the browser session the same way triggerManualScan
     * does. That matters here beyond convenience: the operator debugging this
     * feature picks one clan precisely so a round trip is short, and reading the
     * clan the scheduled rotation happens to be parked on would silently collect
     * the wrong capital's history.
     */
    async collectResourcesNow(opts = {}) {
        if (this.scanInProgress) {
            throw new Error('A scan is already in progress. Wait for it to finish and try again — both drive the same '
                + 'browser page.');
        }
        if ((0, resource_upload_lock_js_1.isResourceUploadActive)()) {
            throw new Error('A resource screenshot upload is in progress. Both would drive PaddleOCR at once; wait for '
                + 'the upload to finish.');
        }
        this.scanInProgress = true;
        this.resourceCaptureInProgress = true;
        try {
            const { targetClanId } = opts;
            if (targetClanId !== undefined && targetClanId !== this.clanId) {
                log.info(`Resource collect: switching browser to clan #${targetClanId} (was clan #${this.clanId})`);
                this.setActiveClan(targetClanId);
                try {
                    await (0, launcher_js_1.closeBrowser)(this.session);
                }
                catch {
                    // ignore — about to relaunch
                }
                this.session = await this.launchForClan(targetClanId);
            }
            await this.ensureLiveSession();
            const { navigateToGame } = await import('../browser/auth.js');
            const { checkLoginStatus } = await import('../browser/auth.js');
            const { TB_GAME_URL } = await import('../config/game-url.js');
            await navigateToGame(this.session.page, TB_GAME_URL);
            if (!(await checkLoginStatus(this.session.page))) {
                throw new Error(`Not logged in to the game for clan #${this.clanId}. Sign the clan in from the Browser `
                    + 'Session card and try again.');
            }
            const { runResourceCapturePhase } = await import('./resource-capture-phase.js');
            return await runResourceCapturePhase({
                config: this.config,
                clanId: this.clanId,
                force: true,
                fullBackfill: opts.fullBackfill,
                dryRun: opts.dryRun,
                maxPages: opts.maxPages,
                // Manual runs are debugging runs by definition — keep every frame.
                debugSavePages: opts.debugSavePages ?? true,
                reportProgress: (message) => this.reportProgress('scan', message),
            }, this.session.page);
        }
        finally {
            this.resourceCaptureInProgress = false;
            this.progressMessage = '';
            await this.finishScan();
        }
    }
    /**
     * Arm a one-shot might re-capture for the given clans: their next scan reads the
     * member list even though today's snapshot already exists, overwriting it.
     *
     * Used by the superadmin "Re-capture now" button so a change can be tested without
     * waiting a day. Takes a list because that button lives on the instance-wide System
     * page and "re-capture" there means every clan — arming only one was the old
     * behaviour and left the others on yesterday's data with no indication why.
     *
     * Returns how many clans were armed; 0 means might tracking is off, so the caller
     * can explain why nothing will happen.
     */
    requestMightRecapture(clanIds) {
        if (!this.config.mightTrackingEnabled)
            return 0;
        for (const id of clanIds)
            this.forceMightRecaptureClans.add(id);
        if (clanIds.length > 0) {
            log.info(`Might re-capture armed for clan(s) ${clanIds.join(', ')} — their next scan will refresh ` +
                'today\'s readings.');
        }
        return clanIds.length;
    }
    /**
     * Park the page on about:blank and clear the in-progress flags. Runs
     * after every scan regardless of how it ended: frees the RAM the Unity
     * WebGL engine accumulated, makes the next scan pick up session changes
     * (e.g. a login from another device), and unloads broken/stuck states
     * (maintenance, popups, errors) so they aren't running idle for the full
     * interval. No-op on the navigation when the session was deliberately
     * closed (clan blocked on re-auth) or crashed — the page is gone and
     * ensureLiveSession will rebuild it.
     */
    async finishScan() {
        try {
            // Read the page off the session rather than caching it: the auth
            // phase may have rotated the browser after a crash-relaunch.
            const page = this.session.page;
            if (!page.isClosed()) {
                await page.goto('about:blank', { timeout: 10_000 }).catch(() => { });
                log.info('Navigated to blank page between scans to free RAM.');
            }
        }
        catch {
            // Non-fatal: next scan will handle navigation
        }
        this.scanInProgress = false;
        this.liveChestCount = 0;
        this.progressMessage = '';
    }
    /**
     * The scan itself: auth → member capture → gifts/triumphal sweep.
     * Called only by runSingleScan, which owns the single-flight guard and
     * the finishScan teardown so every exit path here — including a throw
     * out of the auth or member-capture phase — gets cleaned up.
     */
    async executeScan(triggerSource, result) {
        // 1. Check auth — delegated to scheduler/auth-check.ts. The helper
        // owns the navigate → checkLoginStatus → manual-login fallback ↔
        // crash-relaunch retry loop. We assign the returned session back
        // unconditionally because a crash-recovery may have rotated the
        // browser even when the final ok is false.
        this.stateMachine.transition(enums_js_1.AppState.CHECKING_AUTH);
        const authResult = await (0, auth_check_js_1.performAuthCheck)({
            config: this.config,
            session: this.session,
            clanId: this.clanId,
            reportProgress: (phase, message) => this.reportProgress(phase, message),
        });
        this.session = authResult.session;
        const page = this.session.page;
        if (!authResult.ok) {
            // Headless auth failure means the clan is blocked until an operator
            // refreshes the login — possibly hours or days away. Close the
            // browser outright instead of leaving it parked on TB's login page
            // (or a half-loaded WebGL canvas) burning CPU/RAM for the whole
            // interval; ensureLiveSession rebuilds it on the next cycle, manual
            // scan, or calibration capture.
            this.stateMachine.transition(enums_js_1.AppState.ERROR);
            await (0, launcher_js_1.closeBrowser)(this.session);
            log.info('Closed browser after auth failure — nothing to drive until the clan is re-authenticated.');
            return result;
        }
        // Capture clan members on first run (gives us clean reference names).
        // The phase helper owns the navigate-to-clan-panel + capture +
        // optional stdin-pause flow; if it returns stopAfterCapture we
        // short-circuit the cycle as a successful no-op.
        const memberCapture = await (0, member_capture_phase_js_1.runMemberCapturePhase)({
            config: this.config,
            clanId: this.clanId,
            skipMemberCapture: this.skipMemberCapture,
            pauseAfterMemberCapture: this.pauseAfterMemberCapture,
            stopAfterMemberCapture: this.stopAfterMemberCapture,
            reportProgress: (phase, message) => this.reportProgress(phase, message),
        }, page);
        if (memberCapture.stopAfterCapture) {
            result.success = true;
            this.stateMachine.transition(enums_js_1.AppState.IDLE);
            return result;
        }
        // Create scan session
        const scanSession = sessionRepo.createSession(triggerSource, this.clanId);
        result.sessionId = scanSession.id;
        try {
            // 2. Close any open panel and re-navigate fresh (resets scroll position)
            this.stateMachine.transition(enums_js_1.AppState.NAVIGATING);
            this.reportProgress('scan', 'Preparing Gifts tab for first scan...');
            for (let i = 0; i < 3; i++) {
                await (0, input_js_1.keyPress)(page, 'Escape');
                await new Promise((r) => setTimeout(r, 300));
            }
            await new Promise((r) => setTimeout(r, 1000));
            const onGifts = await (0, navigator_js_1.ensureOnGiftsTab)(page, this.vision, 'gifts', { cardCropPcts: this.getCardCropPcts() });
            if (!onGifts) {
                const navErr = new Error('Could not verify Gifts tab after 3 attempts');
                this.recordScanError(navErr);
                sessionRepo.updateSession(scanSession.id, this.clanId, {
                    status: enums_js_1.ScanStatus.FAILED,
                    errorsEncountered: 1,
                    completedAt: new Date().toISOString(),
                    errorMessage: navErr.message,
                    errorPhase: this.lastScanError?.phase ?? 'Navigating to Gifts tab',
                });
                this.stateMachine.transition(enums_js_1.AppState.ERROR);
                return result;
            }
            // 3. Scan Gifts tab - chests are written to DB in real-time
            this.stateMachine.transition(enums_js_1.AppState.SCANNING);
            this.reportProgress('scan', 'Scanning Gifts list...');
            const giftsResult = await this.scanCardsPipelined(page, scanSession.id, 'gifts');
            result.giftsData = giftsResult.gifts;
            result.chestsFound += giftsResult.chestsFound;
            result.newChests += giftsResult.newChests;
            result.errors += giftsResult.errors;
            // 4. If scan had errors, roll back: delete any chests written during
            //    this session so no partial data remains in the DB
            // If the scanner reported errors AND we got zero chests out, the
            // scan was a wash — roll back so the session row reflects the
            // failure cleanly. But if we have *any* chests, keep them: a
            // mid-scan timeout shouldn't throw away the dozens of chests
            // that successfully OCR'd before it. Mark the session as
            // COMPLETED with the error count surfaced.
            // The DB count, not giftsResult.newChests, decides. The tally is right
            // on this path (the sweep returned), but no delete in this codebase may
            // depend on an in-memory number again — see scan-finalize.ts, where a
            // crash mid-sweep left that tally at 0 and took the claimed chests with it.
            if (giftsResult.errors > 0 && chestRepo.countChestsBySession(scanSession.id, this.clanId) === 0) {
                const deleted = chestRepo.deleteChestsBySession(scanSession.id, this.clanId);
                log.warn(`Scan had ${giftsResult.errors} error(s) and 0 chests - rolled back ${deleted} chests from session ${scanSession.id}`);
                result.chestsFound = 0;
                result.newChests = 0;
                const emptyErr = new Error(`Scan produced 0 chests with ${giftsResult.errors} OCR/click error(s)`);
                this.recordScanError(emptyErr);
                sessionRepo.updateSession(scanSession.id, this.clanId, {
                    status: enums_js_1.ScanStatus.FAILED,
                    chestsFound: 0,
                    screenshotsTaken: giftsResult.screenshots,
                    errorsEncountered: giftsResult.errors,
                    completedAt: new Date().toISOString(),
                    errorMessage: emptyErr.message,
                    errorPhase: this.lastScanError?.phase ?? 'Scanning Gifts list',
                });
                this.stateMachine.transition(enums_js_1.AppState.ERROR);
                return result;
            }
            if (giftsResult.errors > 0) {
                log.info(`Scan had ${giftsResult.errors} error(s) but kept ${giftsResult.newChests} chests that landed before the failure - committing partial session`);
            }
            // 4b. Triumphal sweep — best-effort. Runs only when the operator
            // marked the Triumphal Gifts tab during stage 2 calibration, so
            // clans without a triumphal tab simply skip this. Any failure here
            // is logged and surfaced in errorMessage but never voids the
            // already-successful gifts scan. MaintenanceModeError /
            // SessionKickedError are re-thrown so the outer catch can handle
            // them as it does for the gifts sweep.
            let triumphalWarning = null;
            if ((0, calibration_js_1.isUiPositionSet)('triumphalTab')) {
                try {
                    // The gifts panel is still open from the just-finished sweep —
                    // skip the full ensureOnGiftsTab navigation (clan → sidebar →
                    // gifts) and just click the Triumphal tab in the open panel.
                    // No Escape presses: those would close the gifts panel itself,
                    // forcing a full re-navigation. Saves ~2–4 s per scan that was
                    // being spent on a screen-state OCR + card-crop verify.
                    this.reportProgress('scan', 'Switching to Triumphal Gifts tab...');
                    await (0, navigator_js_1.switchToTriumphalTab)(page, this.vision);
                    this.reportProgress('scan', 'Scanning Triumphal Gifts list...');
                    const triumphalResult = await this.scanCardsPipelined(page, scanSession.id, 'triumphal');
                    result.triumphalData = triumphalResult.gifts;
                    log.info(`Triumphal sweep: ${triumphalResult.newChests} chest(s) inserted, ${triumphalResult.errors} error(s)`);
                    // A stall is reported by name rather than folded into the error count:
                    // "had 1 error(s)" says nothing about a browser that stopped answering.
                    if (triumphalResult.stallReason) {
                        triumphalWarning = `Triumphal sweep gave up before the end of the list (${triumphalResult.stallReason}) ` +
                            `but kept ${triumphalResult.newChests} row(s)`;
                    }
                    else if (triumphalResult.errors > 0) {
                        triumphalWarning = `Triumphal sweep had ${triumphalResult.errors} error(s) but kept ${triumphalResult.newChests} row(s)`;
                    }
                }
                catch (err) {
                    if (err instanceof navigator_js_1.MaintenanceModeError || err instanceof navigator_js_1.SessionKickedError) {
                        throw err;
                    }
                    triumphalWarning = `Triumphal sweep threw: ${err.message}`;
                    log.warn(triumphalWarning);
                }
            }
            // 5. Update the scan_sessions row, transition to IDLE, fire
            // onScanComplete. Helper handles the "manual review needed" /
            // "triumphal sweep warning" errorMessage formatting and
            // screenshot cleanup.
            return (0, scan_finalize_js_1.finalizeScanSuccess)(this.buildScanFinalizeContext(), result, scanSession.id, giftsResult, triumphalWarning);
        }
        catch (err) {
            // All three error branches (MaintenanceModeError,
            // SessionKickedError, generic catch-all) have the same partial-
            // keep rule and live together in scan-finalize.ts. The helper
            // returns 'rethrow' for the catch-all (so runCycle can apply
            // its retry cadence) and 'return' for the expected-abort
            // branches.
            const outcome = (0, scan_finalize_js_1.finalizeScanFailure)(err, this.buildScanFinalizeContext(), result, scanSession.id);
            if (outcome.action === 'rethrow') {
                throw err;
            }
            return result;
        }
    }
    // scanCardsPipelined moved to ./scan-pipeline.ts. The method here
    // is a thin adapter that hands the pipeline a context object built
    // from this ScanLoop's state, so the runSingleScan call sites
    // (gifts + triumphal sweeps) keep their existing shape.
    async scanCardsPipelined(page, sessionId, target = 'gifts') {
        return (0, scan_pipeline_js_1.scanCardsPipelined)({
            config: this.config,
            vision: this.vision,
            clanId: this.clanId,
            reportProgress: (phase, message) => this.reportProgress(phase, message),
            nextCapturedAt: () => this.nextCapturedAt(),
            incrementLiveChestCount: () => { this.liveChestCount++; },
        }, page, sessionId, target);
    }
    /**
     * Build the context object handed to the finalize helpers. Centralised
     * so the success + failure paths inside runSingleScan don't duplicate
     * ~25 lines of bridging callbacks each.
     */
    buildScanFinalizeContext() {
        return {
            clanId: this.clanId,
            isRunning: this.running,
            stateMachine: this.stateMachine,
            progressMessage: this.progressMessage,
            recordScanError: (err) => this.recordScanError(err),
            getLastScanError: () => this.lastScanError,
            clearLastScanError: () => { this.lastScanError = null; },
            setMaintenanceBlock: (durationMs) => this.setMaintenanceBlock(durationMs),
            clearMaintenanceBlock: () => this.clearMaintenanceBlock(),
            scheduleNextCycle: (delayMs) => this.scheduleNextCycle(delayMs),
            flagSkipNextScheduling: () => { this.skipNextScheduling = true; },
            reportProgress: (phase, message) => this.reportProgress(phase, message),
            config: { screenshotRetentionDays: this.config.screenshotRetentionDays },
            onScanComplete: this.onScanComplete,
        };
    }
}
exports.ScanLoop = ScanLoop;
//# sourceMappingURL=loop.js.map