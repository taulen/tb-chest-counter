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
exports.ScanLoop = void 0;
const fs_1 = __importDefault(require("fs"));
const clan_paths_js_1 = require("../config/clan-paths.js");
const enums_js_1 = require("../models/enums.js");
const state_machine_js_1 = require("./state-machine.js");
const sessionRepo = __importStar(require("../data/repositories/session-repo.js"));
const clan_repo_js_1 = require("../data/repositories/clan-repo.js");
const logger_js_1 = require("../utils/logger.js");
const scan_finalize_js_1 = require("./scan-finalize.js");
const clan_scan_schedule_js_1 = require("./clan-scan-schedule.js");
const log = (0, logger_js_1.childLogger)('scanner');
/**
 * The scan scheduler. Every cycle walks the active clans one at a time and
 * scans each straight from the game's own servers (runProtocolClanScan →
 * game-protocol-phase.ts → protocol-scan.ts → chat-capture.ts). See
 * docs/game-protocol.md.
 */
class ScanLoop {
    config;
    onScanComplete;
    stateMachine = new state_machine_js_1.StateMachine();
    running = false;
    scanInProgress = false;
    timer = null;
    /** Browser-free login check of every active clan, every 30 min (session-check.ts). */
    sessionCheckTimer = null;
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
     * The clans the running cycle walks, in order, and how many at the front it
     * is finished with. Empty from the moment the next timer is armed. Only read
     * by getClanScanSchedule: mid-cycle the global timer is the cycle's own
     * start, which says nothing about whether one clan is still waiting its turn
     * or was scanned ten minutes ago.
     */
    cycleOrder = [];
    cycleDoneCount = 0;
    /**
     * When the running clan scan started; null between scans. Only feeds the
     * dashboard's elapsed timer — see getScanActivity.
     */
    scanStartedAt = null;
    progressMessage = ''; // Latest human-readable progress for the admin UI header
    /** Last scan failure surfaced to the UI header + /api/status. Set in the
     *  catch blocks below, cleared when a scan completes successfully. The
     *  `phase` is whatever progressMessage was mid-flight when the error hit
     *  — it gives the user concrete "during X" context instead of a bare
     *  exception string. */
    lastScanError = null;
    lastCapturedAtMs = 0; // Monotonic clock backing for nextCapturedAt(); see comment there.
    /**
     * Clan currently being scanned. Set by runProtocolClanScan, so all the
     * per-scan persistence (sessions, members, chests) stamps the right
     * clan_id and the status routes can tell whose scan is running.
     */
    clanId = 1;
    constructor(config, onScanComplete) {
        this.config = config;
        this.onScanComplete = onScanComplete;
    }
    /** Switch which clan the next scan targets (and the status routes report). */
    setActiveClan(clanId) {
        this.clanId = clanId;
    }
    getActiveClanId() {
        return this.clanId;
    }
    reportProgress(message) {
        this.progressMessage = message;
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
     * the chest_records UNIQUE constraint and silently dropped real chests.
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
    async start() {
        this.running = true;
        log.info(`Scan loop started (interval: ${this.config.scanIntervalMs / 1000}s)`);
        this.armSessionChecks();
        // New chat messages every minute between scans, on the chat session key
        // each scan refreshes (never touches the game or website login).
        void import('./chat-capture.js').then((m) => m.startChatPoller()).catch(() => { });
        // If a recent successful scan exists, defer the first cycle instead of
        // running immediately on startup. Avoids redundant scans on container
        // redeploys when the previous scan completed within one interval.
        //
        // The loop runs one global cycle over every active clan per tick, so
        // the relevant "last scan" is the newest completion across all of them.
        // Keying off clan #1 alone made a redeploy scan immediately whenever
        // another clan was scanned most recently — e.g. a manual scan of clan #2
        // — even though the global countdown still had time left.
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
        // cycle starts. Without this seed `getNextScanAt()` returns null for the
        // whole first cycle and the dashboard header shows a blank countdown
        // until scheduleNextCycle() writes the precise timestamp.
        this.nextScanAt = Date.now() + this.config.scanIntervalMs;
        await this.runCycle();
    }
    stop() {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.sessionCheckTimer) {
            clearInterval(this.sessionCheckTimer);
            this.sessionCheckTimer = null;
        }
        // A deliberate stop is not a pause — don't let the watchdog silently
        // resume a loop the operator (or shutdown) explicitly halted.
        this.clearPauseWatchdog();
        this.nextScanAt = null;
        log.info('Scan loop stopped');
    }
    /**
     * Check every active clan's saved login without the game client, every
     * 30 min and once shortly after start, so "Authenticated" on the Clans page
     * is true even while scans are paused (session-check.ts). It is only a page
     * load with the stored cookies and never presents a token.
     * Never throws, never blocks.
     */
    armSessionChecks() {
        if (this.sessionCheckTimer)
            return;
        const run = () => {
            void import('./session-check.js')
                .then(({ checkClanSessions }) => checkClanSessions())
                .catch((err) => log.warn({ noAlert: true }, `Session check failed: ${String(err)}`));
        };
        setTimeout(run, 60_000).unref();
        this.sessionCheckTimer = setInterval(run, 30 * 60_000);
        this.sessionCheckTimer.unref();
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
     * the admin login bridge is open: a scan signs in to the game directly,
     * which takes over the account's game session — the very session the admin
     * is signing in on. resume() re-arms the next cycle.
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
     * Whether a redeploy right now would cut into scanning, for
     * scripts/deploy-when-idle.mjs (via /api/health).
     *
     * `scanInProgress` alone is not enough: a cycle walks every active clan
     * back to back, and between two clans it is false for a moment before the
     * next clan starts. A deploy on Nov 13 2026 watched one clan's session
     * complete, fired, and killed the next clan's scan 10 s in. The cycle's
     * clan list stays set until the whole cycle is done, so "busy" holds
     * across that gap.
     */
    getDeployState() {
        return {
            busy: this.scanInProgress || this.cycleOrder.length > 0,
            nextScanAt: this.nextScanAt,
        };
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
     * One clan's place in the schedule, for the public share page — right for
     * every clan while a cycle walks them one at a time, where the global timer
     * is only right for the cycle as a whole. See clan-scan-schedule.ts.
     */
    getClanScanSchedule(clanId) {
        return (0, clan_scan_schedule_js_1.resolveClanScanSchedule)({
            clanId,
            now: Date.now(),
            nextScanAt: this.getNextScanAtForClan(clanId),
            intervalMs: this.config.scanIntervalMs,
            cycleOrder: this.cycleOrder,
            cycleDoneCount: this.cycleDoneCount,
            scanningClanId: this.scanInProgress ? this.clanId : null,
        });
    }
    /**
     * What the scanner is doing right now, for the dashboard's scan card; null
     * when there is nothing to show.
     *
     * Mid-cycle there is a gap between two clans where scanInProgress is false
     * but the cycle is still running. It reports as 'starting' on the clan
     * about to be scanned, so the card doesn't blink out and back between
     * clans.
     */
    getScanActivity() {
        const cycleMidway = this.cycleOrder.length > 0 && this.cycleDoneCount < this.cycleOrder.length;
        if (!this.scanInProgress && !cycleMidway)
            return null;
        return {
            clanId: cycleMidway && !this.scanInProgress ? this.cycleOrder[this.cycleDoneCount] : this.clanId,
            phase: this.scanInProgress ? 'scan' : 'starting',
            elapsedMs: this.scanInProgress && this.scanStartedAt !== null ? Date.now() - this.scanStartedAt : null,
            cyclePosition: cycleMidway ? this.cycleDoneCount + 1 : null,
            cycleTotal: cycleMidway ? this.cycleOrder.length : null,
        };
    }
    /** The next timer is armed (or won't be): the cycle no longer speaks for any clan. */
    endCycleTracking() {
        this.cycleOrder = [];
        this.cycleDoneCount = 0;
    }
    scheduleNextCycle(delayMs) {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.nextScanAt = Date.now() + delayMs;
        this.timer = setTimeout(() => this.runCycle(), delayMs);
    }
    /**
     * Trigger a one-off scan of one clan outside the normal schedule — the
     * superadmin "Trigger Manual Scan" button. The operator picks a clan in
     * the dropdown and expects the scan to target only that clan regardless
     * of where the scheduled rotation happens to be.
     */
    async triggerManualScan(targetClanId) {
        if (this.scanInProgress) {
            log.info('Manual scan requested but a scan is already in progress - rejecting');
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
        let result;
        try {
            result = await this.runProtocolClanScan(targetClanId ?? this.clanId, 'manual');
        }
        catch (err) {
            if (!this.lastScanError || this.lastScanError.at < new Date(Date.now() - 5_000).toISOString()) {
                this.recordScanError(err);
            }
            result = { success: false, chestsFound: 0, newChests: 0, errors: 1, giftsData: [], triumphalData: [] };
        }
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
     * outside the normal interval. runCycle reschedules the next cycle
     * when it finishes, so this is just the cancel-pending-timer + invoke
     * pattern.
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
    getState() {
        return this.stateMachine.getState();
    }
    /**
     * One full sweep across every active clan. Called from the timer for
     * scheduled cycles and from `triggerManualScanAllClans` when a
     * superadmin clicks "Scan all clans". The trigger source is threaded
     * down so the resulting scan_sessions row carries the correct
     * `trigger_source`.
     */
    async runCycle(triggerSource = 'scheduled') {
        if (!this.running)
            return;
        // If a scan (e.g. manual) is already running, defer this scheduled cycle
        // by 60 seconds and try again.
        if (this.scanInProgress) {
            log.info('Scheduled scan deferred - another scan is in progress, retrying in 60s');
            if (this.running)
                this.scheduleNextCycle(60_000);
            return;
        }
        // Iterate every active clan in sequence. Serial, because each direct
        // login takes over that account's game session.
        const activeClans = (0, clan_repo_js_1.listClans)({ activeOnly: true });
        const clansToScan = activeClans.length > 0 ? activeClans : [{ id: 1 }];
        this.cycleOrder = clansToScan.map((c) => c.id);
        for (let i = 0; i < clansToScan.length; i++) {
            const clan = clansToScan[i];
            if (!this.running)
                break;
            this.cycleDoneCount = i;
            // A clan that has never been signed in has no session to scan with;
            // it enters the rotation once the login bridge has saved one.
            if (!fs_1.default.existsSync((0, clan_paths_js_1.clanStorageStatePath)(clan.id))) {
                log.info(`Clan #${clan.id}: skipping scan — no saved login yet (sign in via Clans → Log in to Total Battle).`);
                continue;
            }
            try {
                await this.runProtocolClanScan(clan.id, triggerSource);
            }
            catch (err) {
                if (!this.lastScanError || this.lastScanError.at < new Date(Date.now() - 5_000).toISOString()) {
                    this.recordScanError(err);
                }
            }
        }
        this.cycleDoneCount = this.cycleOrder.length;
        if (this.running) {
            // Always retry at the normal scan interval. Most failures are
            // transient (a game server hiccup, a brief network blip) and the
            // configured interval (typically 60-120 min) is already a gentle
            // retry cadence. The state machine still tracks consecutive failures
            // for visibility.
            const errorCount = this.stateMachine.getErrorCount();
            if (errorCount > 0) {
                log.info(`Next scan in ${Math.round(this.config.scanIntervalMs / 60_000)} min (consecutive failures: ${errorCount})`);
            }
            this.scheduleNextCycle(this.config.scanIntervalMs);
        }
        this.endCycleTracking();
    }
    /**
     * One clan's scan, straight from the game (docs/game-protocol.md):
     * capture (members, gifts, ledger, cities…) → record every gift → claim →
     * ledger rows → chat. Owns the single-flight flags. No session row when
     * the capture cannot even sign in; once one exists, a throw keeps whatever
     * was recorded (finalizeScanFailure decides from the DB row count).
     */
    async runProtocolClanScan(clanId, triggerSource) {
        const result = { success: false, chestsFound: 0, newChests: 0, errors: 0, giftsData: [], triumphalData: [] };
        if (this.scanInProgress)
            return { ...result, alreadyRunning: true };
        this.setActiveClan(clanId);
        this.scanInProgress = true;
        this.scanStartedAt = Date.now();
        this.liveChestCount = 0;
        this.progressMessage = '';
        try {
            this.stateMachine.transition(enums_js_1.AppState.SCANNING);
            this.reportProgress('Reading clan data from the game server…');
            const { runGameProtocolCapture } = await import('./game-protocol-phase.js');
            const capture = await runGameProtocolCapture(clanId, { rolloverUtcHour: this.config.gameDayRolloverUtcHour });
            if (!capture.ok || !capture.data) {
                // Nothing was recorded or claimed. A logged-out session has already been
                // flagged for re-authentication by the capture.
                this.recordScanError(new Error(capture.loggedOut
                    ? 'The saved Total Battle login has expired — refresh it under Clans → Log in to Total Battle.'
                    : `Could not read the clan from the game: ${capture.error ?? 'unknown error'}`));
                this.stateMachine.transition(enums_js_1.AppState.ERROR);
                return result;
            }
            const scanSession = sessionRepo.createSession(triggerSource, clanId);
            result.sessionId = scanSession.id;
            try {
                const { recordAndClaim } = await import('./protocol-scan.js');
                const tally = await recordAndClaim({
                    clanId,
                    sessionId: scanSession.id,
                    rolloverUtcHour: this.config.gameDayRolloverUtcHour,
                    nextCapturedAt: () => this.nextCapturedAt(),
                    reportProgress: (message) => this.reportProgress(message),
                    incrementLiveChestCount: () => { this.liveChestCount++; },
                }, capture.data);
                result.giftsData = tally.gifts;
                result.triumphalData = tally.triumphal;
                result.chestsFound = tally.gifts.length;
                result.newChests = tally.gifts.length;
                result.errors = tally.claimFailures;
                const done = (0, scan_finalize_js_1.finalizeScanSuccess)(this.buildScanFinalizeContext(), result, scanSession.id, tally.warnings.length ? tally.warnings.join('\n') : null);
                // Chat (clan chat + the account's private messages), on the same game
                // session, after the scan is final. Never throws.
                this.reportProgress('Reading chat…');
                const { refreshChatSession } = await import('./chat-capture.js');
                log.info(`Clan #${clanId} ${await refreshChatSession(clanId, capture.data.client, capture.data.record.clanId)}`);
                return done;
            }
            catch (err) {
                const outcome = (0, scan_finalize_js_1.finalizeScanFailure)(err, this.buildScanFinalizeContext(), result, scanSession.id);
                if (outcome.action === 'rethrow')
                    throw err;
                return result;
            }
        }
        finally {
            this.scanInProgress = false;
            this.scanStartedAt = null;
            this.liveChestCount = 0;
            this.progressMessage = '';
        }
    }
    /** The context object handed to the finalize helpers. */
    buildScanFinalizeContext() {
        return {
            clanId: this.clanId,
            stateMachine: this.stateMachine,
            recordScanError: (err) => this.recordScanError(err),
            getLastScanError: () => this.lastScanError,
            clearLastScanError: () => { this.lastScanError = null; },
            reportProgress: (message) => this.reportProgress(message),
            onScanComplete: this.onScanComplete,
        };
    }
}
exports.ScanLoop = ScanLoop;
//# sourceMappingURL=loop.js.map