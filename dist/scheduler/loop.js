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
const scan_account_repo_js_1 = require("../data/repositories/scan-account-repo.js");
const logger_js_1 = require("../utils/logger.js");
const scan_finalize_js_1 = require("./scan-finalize.js");
const clan_scan_schedule_js_1 = require("./clan-scan-schedule.js");
const scan_lanes_js_1 = require("./scan-lanes.js");
const scan_due_js_1 = require("./scan-due.js");
const log = (0, logger_js_1.childLogger)('scanner');
/**
 * The scan scheduler. Scans read each clan straight from the game's own
 * servers (runProtocolClanScan → game-protocol-phase.ts → protocol-scan.ts →
 * chat-capture.ts). See docs/game-protocol.md.
 *
 * Every active clan is on its own schedule (scan-due.ts): its own interval
 * from the Clans page, else the global one. The timer fires when the soonest
 * clan is due, and that cycle scans every clan due by then.
 *
 * Clans on DIFFERENT Total Battle accounts scan at the same time; clans on
 * the same account one after another, in one lane (scan-lanes.ts), because a
 * game login takes over that account's session. A clan whose account is not
 * known yet runs alone. SCAN_PARALLEL=0 puts every clan in one lane.
 */
class ScanLoop {
    config;
    onScanComplete;
    hooks;
    stateMachine = new state_machine_js_1.StateMachine();
    running = false;
    timer = null;
    /** Browser-free login check of every active clan, every 30 min (session-check.ts). */
    sessionCheckTimer = null;
    /**
     * Epoch ms the timer fires next: the soonest clan's due time. null before
     * start() and after stop(); kept through a pause (see pause()).
     */
    nextScanAt = null;
    /**
     * Each clan's last scan, epoch ms: the end of the cycle that scanned it, or
     * of its manual scan. Seeded from the DB on start(). Drives scan-due.ts.
     */
    lastScanAt = new Map();
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
    /** Scans running right now, by clan, in start order. */
    runs = new Map();
    /** Clans queued on a lane (a cycle's or a manual scan) and not started yet. */
    queued = new Set();
    lanes = new scan_lanes_js_1.LaneQueue();
    /**
     * The running cycle: its clans in order and which of them are finished
     * (scanned or skipped). null from the moment the next timer is armed. With
     * lanes, clans finish out of order — hence a set, not a count.
     */
    cycle = null;
    /** Last scan failure surfaced to the UI header + /api/status. Set in the
     *  catch blocks below, cleared when a scan completes successfully. The
     *  `phase` is whatever progress message was mid-flight when the error hit
     *  — it gives the user concrete "during X" context instead of a bare
     *  exception string. */
    lastScanError = null;
    lastCapturedAtMs = 0; // Monotonic clock backing for nextCapturedAt(); see comment there.
    /** The clan of the most recent scan — what getActiveClanId reports between scans. */
    lastClanId = 1;
    constructor(config, onScanComplete, hooks = {}) {
        this.config = config;
        this.onScanComplete = onScanComplete;
        this.hooks = hooks;
    }
    /** The clan the status routes report when nothing runs (the last one scanned). */
    setActiveClan(clanId) {
        this.lastClanId = clanId;
    }
    /** A clan scanning now (the oldest), else the last one scanned. */
    getActiveClanId() {
        return this.runs.keys().next().value ?? this.lastClanId;
    }
    /** Clans scanning right now, oldest first. */
    getRunningClanIds() {
        return [...this.runs.keys()];
    }
    /** The progress line of one clan's scan, or of the oldest running scan. */
    getProgressMessage(clanId) {
        const run = clanId === undefined ? this.runs.values().next().value : this.runs.get(clanId);
        return run?.progressMessage ?? '';
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
    recordScanError(err, clanId, phaseHint) {
        const message = err instanceof Error ? err.message : String(err);
        const phase = phaseHint || this.runs.get(clanId)?.progressMessage || 'Scan failed';
        this.lastScanError = { message, phase, at: new Date().toISOString(), clanId };
        // Pass the Error object so pino's built-in err serializer renders
        // the stack trace into docker stdout. Bare strings would just print
        // the message and drop the trace we actually need for debugging.
        if (err instanceof Error) {
            log.error({ err, phase, clanId }, `Clan #${clanId} scan failed during: ${phase}`);
        }
        else {
            log.error({ err: String(err), phase, clanId }, `Clan #${clanId} scan failed during: ${phase}`);
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
     * Shared by every lane, so two clans scanning at once never get the same
     * timestamp either.
     */
    nextCapturedAt() {
        const now = Date.now();
        const next = Math.max(now, this.lastCapturedAtMs + 1);
        this.lastCapturedAtMs = next;
        return new Date(next).toISOString();
    }
    async start() {
        this.running = true;
        log.info(`Scan loop started (interval: ${this.config.scanIntervalMs / 1000}s, ${this.parallel() ? 'clans on different accounts in parallel' : 'serial (SCAN_PARALLEL=0)'})`);
        this.armSessionChecks();
        // New chat messages every minute between scans, on the chat session key
        // each scan refreshes (never touches the game or website login).
        void import('./chat-capture.js').then((m) => {
            m.startChatPoller();
            m.setChatReplyScanTrigger((clanId) => this.scanForChatReply(clanId));
        }).catch(() => { });
        // A running Rise of the Ancients is read again every ~10 min between scans,
        // on the game session each clan's scan leaves (never a login of its own).
        void import('./event-poller.js').then((m) => m.startEventPoller(this.pollGate())).catch(() => { });
        // Research/talent trees (names, layout, troop-tier unlocks): built once per
        // game patch, cached on disk; every scan re-checks the version.
        void import('../game-protocol/tech-trees.js').then((m) => m.loadTechTrees()).catch((err) => {
            log.warn({ noAlert: true }, `Tech trees not available yet: ${String(err)}`);
        });
        // Each clan's last completed scan anchors its schedule, so a redeploy
        // waits out every clan's own interval instead of scanning at once; a clan
        // whose interval has run out (or that never completed a scan) is due now.
        for (const [clanId, at] of sessionRepo.getLastCompletedAtByClan()) {
            if (at <= Date.now())
                this.lastScanAt.set(clanId, at);
        }
        const now = Date.now();
        const soonest = (0, scan_due_js_1.soonestDue)(this.schedule(), now) ?? now;
        if (soonest > now) {
            log.info(`No clan is due yet - first scan in ${Math.round((soonest - now) / 60_000)} min`);
            this.scheduleNextCycle(soonest - now);
            return;
        }
        this.nextScanAt = now;
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
        void import('./event-poller.js').then((m) => m.stopEventPoller()).catch(() => { });
        log.info('Scan loop stopped');
    }
    parallel() {
        return this.hooks.parallel ? this.hooks.parallel() : (0, scan_lanes_js_1.scanParallelEnabled)();
    }
    /**
     * What the between-scans event poller (event-poller.ts) may do: nothing while
     * paused (the login bridge) or stopped; never on a clan whose lane has a scan
     * queued or running (an unknown-account scan might be anyone's); its reads go
     * through the lane like a scan.
     */
    pollGate() {
        return {
            paused: () => !this.running,
            laneBusy: (clanId) => {
                const lane = this.laneOf(clanId);
                return this.isClanScanQueuedOrRunning(clanId)
                    || this.lanes.pending(lane) > 0
                    || this.lanes.pending(scan_lanes_js_1.EXCLUSIVE) > 0
                    || (lane === scan_lanes_js_1.EXCLUSIVE && !this.lanes.idle());
            },
            runOnLane: (clanId, job) => this.lanes.run(this.laneOf(clanId), job),
            rolloverUtcHour: () => this.config.gameDayRolloverUtcHour,
        };
    }
    /**
     * A scan signs in to the game, which takes over its account's game session:
     * the sessions kept for between-scans reads of every clan on that account
     * (or on an account not known yet) are dead from here on.
     */
    async dropSessionsSharing(clanId) {
        const { dropGameSession, keptSessionClans } = await import('./event-poller.js');
        const others = keptSessionClans();
        if (!others.length)
            return;
        const mine = (0, scan_account_repo_js_1.getClanScanAccount)(clanId);
        for (const other of others) {
            const theirs = (0, scan_account_repo_js_1.getClanScanAccount)(other);
            if (other === clanId || !mine || !theirs || mine === theirs)
                dropGameSession(other);
        }
    }
    /**
     * Check every active clan's saved login without the game client, every
     * 30 min and once shortly after start, so "Authenticated" on the Clans page
     * is true even while scans are paused (session-check.ts). It is only a page
     * load with the stored cookies and never presents a token. It also learns
     * which account each login is, for the scan lanes.
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
            if (this.running || this.runs.size > 0)
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
     * is signing in on. Global on purpose (any lane might be that account).
     * resume() re-arms the next cycle. Clans a running cycle has queued but not
     * started are skipped.
     * Returns false if a scan is already mid-flight (caller should refuse).
     */
    pause() {
        if (this.runs.size > 0)
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
        // The bridge signs in on an account: every session kept for
        // between-scans reads is superseded (and the poller reads nothing while paused).
        void import('./event-poller.js').then((m) => m.dropAllGameSessions()).catch(() => { });
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
        // Clans skipped by the pause were never marked scanned, so they are due.
        const now = Date.now();
        const soonest = (0, scan_due_js_1.soonestDue)(this.schedule(), now);
        // Already-overdue scans get a short grace window so any post-login
        // cookie/storage settling completes before we scan.
        const delay = soonest === null ? this.config.scanIntervalMs : soonest > now ? soonest - now : 5_000;
        log.info(`Scan loop resumed (next scan in ${Math.round(delay / 60_000)} min)`);
        this.scheduleNextCycle(delay);
    }
    isPaused() {
        return !this.running;
    }
    /** Any clan scanning right now. */
    isScanInProgress() {
        return this.runs.size > 0;
    }
    /** This clan is scanning, or queued to (a cycle's or a manual scan). */
    isClanScanQueuedOrRunning(clanId) {
        return this.runs.has(clanId) || this.queued.has(clanId);
    }
    /** A whole cycle is running (scheduled or "Scan All Clans"). */
    isCycleRunning() {
        return this.cycle !== null;
    }
    /**
     * Whether a redeploy right now would cut into scanning, for
     * scripts/deploy-when-idle.mjs (via /api/health).
     *
     * A running scan alone is not enough: a cycle walks the clans of each lane
     * back to back, and between two clans nothing is running for a moment
     * before the next one starts. A deploy on Nov 13 2026 watched one clan's
     * session complete, fired, and killed the next clan's scan 10 s in. The
     * cycle stays set until every lane is done, and a manual scan queued on a
     * busy lane counts too — so "busy" holds across every gap.
     */
    getDeployState() {
        return {
            busy: this.runs.size > 0 || this.cycle !== null || this.queued.size > 0 || !this.lanes.idle(),
            nextScanAt: this.nextScanAt,
        };
    }
    /**
     * Chests found so far by one clan's running scan, or by every running scan
     * together. Zero when nothing runs.
     */
    getLiveChestCount(clanId) {
        if (clanId !== undefined)
            return this.runs.get(clanId)?.liveChestCount ?? 0;
        let n = 0;
        for (const r of this.runs.values())
            n += r.liveChestCount;
        return n;
    }
    /**
     * Epoch ms the timer fires next — the soonest clan's scan — or null when
     * the loop isn't scheduling. For "is any scan coming up" (the deploy gate);
     * one clan's next scan is getNextScanAtForClan.
     */
    getNextScanAt() {
        return this.nextScanAt;
    }
    /**
     * The rotation — every active clan, or clan #1 alone when none is active
     * (the boot-time fallback) — with each clan's interval and last scan.
     */
    schedule() {
        const active = (0, clan_repo_js_1.listClans)({ activeOnly: true });
        const rotation = active.length > 0
            ? active.map((c) => ({ id: c.id, minutes: c.scanIntervalMinutes }))
            : [{ id: 1, minutes: null }];
        return rotation.map((c) => ({
            id: c.id,
            intervalMs: (0, scan_due_js_1.clanIntervalMs)(c.minutes, this.config.scanIntervalMs),
            lastScanAt: this.lastScanAt.get(c.id) ?? null,
        }));
    }
    /**
     * When one clan's next scheduled scan is due (its own interval after its
     * last scan; in the past while it waits its turn), or null when it isn't in
     * the active rotation or the loop isn't scheduling.
     */
    getNextScanAtForClan(clanId) {
        if (this.nextScanAt === null)
            return null;
        const clan = this.schedule().find((c) => c.id === clanId);
        if (!clan)
            return null;
        const now = Date.now();
        // Scanned by a cycle still running on other lanes: it counts as scanned
        // when the cycle ends, so a full interval from now is the lower bound.
        if (this.cycle?.attempted.has(clanId) && this.cycle.done.has(clanId))
            return now + clan.intervalMs;
        return (0, scan_due_js_1.dueAt)(clan, now);
    }
    /**
     * One clan's place in the schedule, for the public share page — right for
     * every clan while a cycle runs, where its due time is only right between
     * cycles. See clan-scan-schedule.ts.
     */
    getClanScanSchedule(clanId) {
        const clan = this.schedule().find((c) => c.id === clanId);
        return (0, clan_scan_schedule_js_1.resolveClanScanSchedule)({
            clanId,
            now: Date.now(),
            nextScanAt: this.getNextScanAtForClan(clanId),
            intervalMs: clan?.intervalMs ?? this.config.scanIntervalMs,
            cycleOrder: this.cycle?.order ?? [],
            cycleDoneCount: 0,
            doneClanIds: this.cycle ? [...this.cycle.done] : [],
            scanningClanId: null,
            scanningClanIds: [...this.runs.keys()],
        });
    }
    /**
     * Everything the scanner is doing right now, for the dashboard's scan card;
     * null when there is nothing to show.
     *
     * Mid-cycle there can be a moment where no clan is scanning but the cycle
     * is still running (between two clans of a lane). It reports the clan up
     * next as 'starting', so the card doesn't blink out and back.
     */
    getScanOverview() {
        const now = Date.now();
        const clans = [...this.runs.values()].map((r) => ({
            clanId: r.clanId,
            phase: 'scan',
            elapsedMs: now - r.startedAt,
            progressMessage: r.progressMessage,
            liveChestCount: r.liveChestCount,
        }));
        const cycle = this.cycle;
        const midway = cycle !== null && cycle.done.size < cycle.order.length;
        if (clans.length === 0 && midway) {
            const next = cycle.order.find((id) => !cycle.done.has(id));
            if (next !== undefined)
                clans.push({ clanId: next, phase: 'starting', elapsedMs: null, progressMessage: '', liveChestCount: 0 });
        }
        if (clans.length === 0)
            return null;
        return {
            clans,
            cycleDone: midway ? cycle.done.size : null,
            cycleTotal: midway ? cycle.order.length : null,
        };
    }
    /**
     * The oldest entry of getScanOverview as one activity — what callers that
     * show a single clan read. cyclePosition is the first clan not finished yet.
     */
    getScanActivity() {
        const o = this.getScanOverview();
        if (!o)
            return null;
        const first = o.clans[0];
        return {
            clanId: first.clanId,
            phase: first.phase,
            elapsedMs: first.elapsedMs,
            cyclePosition: o.cycleDone !== null ? o.cycleDone + 1 : null,
            cycleTotal: o.cycleTotal,
        };
    }
    scheduleNextCycle(delayMs) {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.nextScanAt = Date.now() + delayMs;
        this.timer = setTimeout(() => { void this.runCycle(); }, delayMs);
    }
    /**
     * Arm the timer for the soonest clan due. Clans scanning or queued right
     * now are left out: the end of that scan re-arms. Never under a second, so
     * a clan that somehow stays due can't spin the loop.
     */
    armNext() {
        const now = Date.now();
        const waiting = this.schedule().filter((c) => !this.isClanScanQueuedOrRunning(c.id));
        const soonest = (0, scan_due_js_1.soonestDue)(waiting, now);
        if (soonest === null)
            return;
        this.scheduleNextCycle(Math.max(1_000, soonest - now));
    }
    /** Re-arm between cycles (a running cycle re-arms when it ends; a paused loop on resume). */
    rearmIfIdle() {
        if (this.running && !this.cycle)
            this.armNext();
    }
    /**
     * A clan's interval or active flag changed (Clans page): re-arm so the
     * change applies now, not after the scan the timer was armed for.
     */
    scheduleChanged() {
        this.rearmIfIdle();
    }
    /** The lane a clan scans in right now. */
    laneOf(clanId) {
        return (0, scan_lanes_js_1.laneKeyFor)((0, scan_account_repo_js_1.getClanScanAccount)(clanId), this.parallel());
    }
    /**
     * Trigger a one-off scan of one clan outside the normal schedule — the
     * superadmin "Scan This Clan" button. It queues on the clan's lane: when a
     * clan on the same account is scanning, it starts right after; clans on
     * other accounts are not waited for.
     */
    /**
     * Scan one clan to answer a waiting code request or chat command when no
     * game session is kept (chat-capture.ts maybeScanForChatReplies). Unlike the Scan This Clan
     * button it never touches the scheduled cycle: it just takes the clan's
     * turn on its lane. Skipped while paused or when the clan is already
     * scanning or queued.
     */
    scanForChatReply(clanId) {
        if (!this.running || this.isClanScanQueuedOrRunning(clanId))
            return;
        const lane = this.laneOf(clanId);
        this.queued.add(clanId);
        void this.lanes.run(lane, () => {
            this.queued.delete(clanId);
            return this.scanClan(clanId, 'manual', lane);
        }).catch((err) => {
            log.warn({ noAlert: true }, `Clan #${clanId}: the scan to answer a chat request failed (the next scan answers it): ${String(err)}`);
        }).finally(() => {
            this.queued.delete(clanId);
            // The timer left this clan out while it scanned (armNext).
            this.rearmIfIdle();
        });
    }
    async triggerManualScan(targetClanId) {
        const clanId = targetClanId ?? this.lastClanId;
        if (this.isClanScanQueuedOrRunning(clanId)) {
            log.info(`Manual scan of clan #${clanId} requested but it is already scanning or queued - rejecting`);
            return { success: false, chestsFound: 0, newChests: 0, errors: 0, giftsData: [], triumphalData: [], alreadyRunning: true };
        }
        // Other clans keep their own schedule; this clan's next scheduled scan
        // moves to a full interval after this one (below).
        const lane = this.laneOf(clanId);
        this.queued.add(clanId);
        let result;
        try {
            result = await this.lanes.run(lane, () => {
                this.queued.delete(clanId);
                return this.scanClan(clanId, 'manual', lane);
            });
        }
        catch (err) {
            if (!this.lastScanError || this.lastScanError.at < new Date(Date.now() - 5_000).toISOString()) {
                this.recordScanError(err, clanId);
            }
            result = { success: false, chestsFound: 0, newChests: 0, errors: 1, giftsData: [], triumphalData: [] };
        }
        finally {
            this.queued.delete(clanId);
        }
        this.lastScanAt.set(clanId, Date.now());
        this.rearmIfIdle();
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
        if (this.cycle) {
            log.info('Manual scan-all requested but a cycle is already running - rejecting');
            return;
        }
        if (!this.running) {
            log.info('Manual scan-all requested but the scan loop is not running');
            return;
        }
        // runCycle scans every active clan (not only the due ones), clears the
        // pending timer and re-arms at its tail. Pass 'manual' so each per-clan
        // scan_sessions row records the correct trigger_source — otherwise this
        // path looked indistinguishable from a scheduled cycle in scan history.
        await this.runCycle('manual', 'all');
    }
    getScanIntervalMs() {
        return this.config.scanIntervalMs;
    }
    /** The global interval: every clan without one of its own. Applies at once. */
    setScanIntervalMs(nextIntervalMs) {
        this.config.scanIntervalMs = nextIntervalMs;
        log.info(`Scan interval updated to ${Math.round(nextIntervalMs / 1000)}s`);
        this.rearmIfIdle();
    }
    /** Scanning while any clan scans; otherwise what the last scan left behind. */
    getState() {
        return this.runs.size > 0 ? enums_js_1.AppState.SCANNING : this.stateMachine.getState();
    }
    /**
     * One sweep: from the timer, every clan that is due (scan-due.ts); from
     * `triggerManualScanAllClans` ("Scan all clans"), every active clan. The
     * trigger source is threaded down so the resulting scan_sessions row
     * carries the correct `trigger_source`. A clan already scanning or queued
     * (a manual scan) is left out.
     *
     * Every lane walks its clans in cycle order while the lanes run side by
     * side; clans whose account is unknown run alone, after them. A manual scan
     * already queued on a lane goes first there.
     *
     * At the end every clan the cycle got to counts as scanned at that moment,
     * and the timer is re-armed for the soonest clan due.
     */
    async runCycle(triggerSource = 'scheduled', scope = 'due') {
        if (!this.running)
            return;
        // A cycle is already running (e.g. "Scan All Clans" when the timer fired):
        // try again in 60 seconds.
        if (this.cycle) {
            log.info('Scheduled scan deferred - a cycle is in progress, retrying in 60s');
            if (this.running)
                this.scheduleNextCycle(60_000);
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const now = Date.now();
        const schedule = this.schedule();
        const order = (scope === 'all' ? schedule.map((c) => c.id) : (0, scan_due_js_1.dueClanIds)(schedule, now))
            .filter((id) => !this.isClanScanQueuedOrRunning(id));
        if (order.length === 0) {
            // Nothing due after all (an interval was raised, a clan deactivated,
            // or its manual scan is running): wait for the soonest clan.
            this.armNext();
            return;
        }
        const cycle = { order, done: new Set(), attempted: new Set() };
        this.cycle = cycle;
        const accounts = (0, scan_account_repo_js_1.getClanScanAccounts)();
        const plan = (0, scan_lanes_js_1.planLanes)(order, (id) => accounts.get(id) ?? null, this.parallel());
        if (plan.lanes.length > 1 || plan.exclusive.length > 0) {
            log.info(`Scan cycle: ${plan.lanes.length} lane(s) in parallel` +
                `${plan.lanes.map((l) => ` [${l.clanIds.map((id) => `#${id}`).join(' → ')}]`).join('')}` +
                `${plan.exclusive.length ? `, then alone (account not known yet): ${plan.exclusive.map((id) => `#${id}`).join(', ')}` : ''}`);
        }
        const jobs = [];
        const enqueue = (lane, clanId) => {
            this.queued.add(clanId);
            jobs.push(this.lanes.run(lane, () => this.cycleScan(clanId, triggerSource, lane, cycle)).catch(() => { }));
        };
        for (const lane of plan.lanes)
            for (const id of lane.clanIds)
                enqueue(lane.key, id);
        for (const id of plan.exclusive)
            enqueue(scan_lanes_js_1.EXCLUSIVE, id);
        await Promise.all(jobs);
        // Every clan the cycle got to, scanned, failed or skipped for having no
        // login, waits a full interval of its own from here, so clans on one
        // interval stay in step. A failure retries at the normal interval too:
        // most are transient, and the state machine still counts them. Clans a
        // pause skipped stay due, for resume().
        const end = Date.now();
        for (const id of cycle.attempted)
            this.lastScanAt.set(id, end);
        if (this.cycle === cycle)
            this.cycle = null;
        if (this.running) {
            const errorCount = this.stateMachine.getErrorCount();
            this.armNext();
            if (errorCount > 0 && this.nextScanAt !== null) {
                log.info(`Next scan in ${Math.round((this.nextScanAt - end) / 60_000)} min (consecutive failures: ${errorCount})`);
            }
        }
    }
    /** One clan's turn in a cycle, on its lane. */
    async cycleScan(clanId, triggerSource, lane, cycle) {
        this.queued.delete(clanId);
        try {
            // Paused (the login bridge) or stopped meanwhile: the rest of the cycle is skipped.
            if (!this.running)
                return;
            cycle.attempted.add(clanId);
            // A clan that has never been signed in has no session to scan with;
            // it enters the rotation once the login bridge has saved one.
            const hasLogin = this.hooks.hasLogin ? this.hooks.hasLogin(clanId) : fs_1.default.existsSync((0, clan_paths_js_1.clanStorageStatePath)(clanId));
            if (!hasLogin) {
                log.info(`Clan #${clanId}: skipping scan — no saved login yet (sign in via Clans → Log in to Total Battle).`);
                return;
            }
            try {
                await this.scanClan(clanId, triggerSource, lane);
            }
            catch (err) {
                if (!this.lastScanError || this.lastScanError.at < new Date(Date.now() - 5_000).toISOString()) {
                    this.recordScanError(err, clanId);
                }
            }
        }
        finally {
            cycle.done.add(clanId);
        }
    }
    /** Run one clan's scan with its own per-scan state (several run at once, one per lane). */
    async scanClan(clanId, triggerSource, lane) {
        if (this.runs.has(clanId)) {
            return { success: false, chestsFound: 0, newChests: 0, errors: 0, giftsData: [], triumphalData: [], alreadyRunning: true };
        }
        const run = { clanId, lane, startedAt: Date.now(), liveChestCount: 0, progressMessage: '' };
        this.runs.set(clanId, run);
        this.lastClanId = clanId;
        try {
            if (this.hooks.scanClan) {
                return await this.hooks.scanClan(clanId, triggerSource, (m) => { run.progressMessage = m; });
            }
            return await this.runProtocolClanScan(run, triggerSource);
        }
        finally {
            this.runs.delete(clanId);
        }
    }
    /**
     * One clan's scan, straight from the game (docs/game-protocol.md):
     * capture (members, gifts, ledger) → record every gift → claim → ledger
     * rows → finalize → cities, map tiles, raw archive → chat. No session row when
     * the capture cannot even sign in; once one exists, a throw keeps whatever
     * was recorded (finalizeScanFailure decides from the DB row count).
     */
    async runProtocolClanScan(run, triggerSource) {
        const { clanId } = run;
        const result = { success: false, chestsFound: 0, newChests: 0, errors: 0, giftsData: [], triumphalData: [] };
        const report = (message) => { run.progressMessage = message; };
        this.stateMachine.transition(enums_js_1.AppState.SCANNING);
        report('Reading clan data from the game server…');
        await this.dropSessionsSharing(clanId);
        const { runGameProtocolCapture, collectCaptureExtras } = await import('./game-protocol-phase.js');
        const capture = await runGameProtocolCapture(clanId, { rolloverUtcHour: this.config.gameDayRolloverUtcHour });
        if (!capture.ok || !capture.data) {
            // Nothing was recorded or claimed. A logged-out session has already been
            // flagged for re-authentication by the capture.
            this.recordScanError(new Error(capture.loggedOut
                ? 'The saved Total Battle login has expired — refresh it under Clans → Log in to Total Battle.'
                : `Could not read the clan from the game: ${capture.error ?? 'unknown error'}`), clanId);
            this.stateMachine.transition(enums_js_1.AppState.ERROR);
            return result;
        }
        // The account this login is: keys the clan's scan lane from now on.
        const client = capture.data.client;
        if (client.suid && (0, scan_account_repo_js_1.setClanScanAccount)(clanId, client.suid, client.playerId ?? null, 'scan')) {
            log.info(`Clan #${clanId}: scanner account learned from its scan (scan lanes updated)`);
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
                reportProgress: report,
                incrementLiveChestCount: () => { run.liveChestCount++; },
            }, capture.data);
            result.giftsData = tally.gifts;
            result.triumphalData = tally.triumphal;
            result.chestsFound = tally.gifts.length;
            result.newChests = tally.gifts.length;
            result.errors = tally.claimFailures;
            const done = (0, scan_finalize_js_1.finalizeScanSuccess)(this.buildScanFinalizeContext(run), result, scanSession.id, tally.warnings.length ? tally.warnings.join('\n') : null);
            // After the scan is final, on the same game session: the slower
            // collection (member cities, map tiles, raw archive) — kept out of
            // the way of opening chests — then chat (clan chat + the account's
            // private messages). Neither throws. The run stays registered, so a
            // deploy still waits for them.
            if (capture.clanFrame) {
                report('Reading member cities…');
                await collectCaptureExtras(clanId, capture.data, capture.clanFrame);
            }
            report('Reading chat…');
            const { refreshChatSession } = await import('./chat-capture.js');
            log.info(`Clan #${clanId} ${await refreshChatSession(clanId, capture.data.client, capture.data.record.clanId)}`);
            // The daily digest into the clan's chosen group chat (opt-in; at most
            // one message a day — see chat-digest.ts). Never throws.
            const { runChatDigest } = await import('./chat-digest.js');
            const digestNote = await runChatDigest(clanId, { client: capture.data.client, rolloverUtcHour: this.config.gameDayRolloverUtcHour });
            if (digestNote)
                log.info(`Clan #${clanId} ${digestNote}`);
            // Account invites: answer keyword DMs to the scanner account with a
            // join code, on this scan's game session (opt-in per clan; replies only
            // to the player who asked, in their private chat — chat-invites.ts).
            if (capture.data.client.suid) {
                const { processInviteRequests } = await import('./chat-invites.js');
                const { chatSessionFor } = await import('./chat-capture.js');
                const client = capture.data.client;
                const inviteNote = await processInviteRequests(clanId, {
                    scannerChatId: client.suid, chatToken: () => client.chatToken(), chatSession: chatSessionFor(clanId),
                });
                if (inviteNote)
                    log.info(`Clan #${clanId} ${inviteNote}`);
                // Chat commands ("me", "top", …): answered in the asker's private
                // chat, within the limits (opt-in per clan — chat-commands.ts).
                const { processChatCommands } = await import('./chat-commands.js');
                const commandNote = await processChatCommands(clanId, {
                    scannerChatId: client.suid, chatToken: () => client.chatToken(), chatSession: chatSessionFor(clanId),
                });
                if (commandNote)
                    log.info(`Clan #${clanId} ${commandNote}`);
                // Welcome codes for players who joined since (its own setting, off by
                // default; one code a run, 10 min apart; once per player ever).
                const { sendWelcomeCodes } = await import('./chat-invites.js');
                const welcomeNote = await sendWelcomeCodes(clanId, {
                    scannerChatId: client.suid, chatSession: chatSessionFor(clanId), chatToken: () => client.chatToken(),
                });
                if (welcomeNote)
                    log.info(`Clan #${clanId} ${welcomeNote}`);
            }
            // Kept for between-scans reads of a running Rise of the Ancients (event-poller.ts).
            const { keepGameSession } = await import('./event-poller.js');
            keepGameSession(clanId, capture.data.client);
            return done;
        }
        catch (err) {
            const outcome = (0, scan_finalize_js_1.finalizeScanFailure)(err, this.buildScanFinalizeContext(run), result, scanSession.id);
            if (outcome.action === 'rethrow')
                throw err;
            return result;
        }
    }
    /** The context object handed to the finalize helpers, for one clan's run. */
    buildScanFinalizeContext(run) {
        return {
            clanId: run.clanId,
            stateMachine: this.stateMachine,
            recordScanError: (err) => this.recordScanError(err, run.clanId),
            getLastScanError: () => this.lastScanError,
            // Only this clan's own failure: with lanes another clan's error may be
            // the one on display, and this clan's success says nothing about it.
            clearLastScanError: () => { if (this.lastScanError?.clanId === run.clanId)
                this.lastScanError = null; },
            reportProgress: (message) => { run.progressMessage = message; },
            onScanComplete: this.onScanComplete,
        };
    }
}
exports.ScanLoop = ScanLoop;
//# sourceMappingURL=loop.js.map