"use strict";
// Post-scan finalization helpers — the success-path "update the
// scan_sessions row + clean up state" sequence, plus the three error
// branches (MaintenanceModeError, SessionKickedError, generic catch-all)
// that decide whether to keep already-inserted chests or roll them
// back.
//
// These were previously the bulkiest non-orchestration block inside
// runSingleScan. Pulling them out leaves runSingleScan as a readable
// outline of the scan phases instead of 130 LOC of catch-block
// bookkeeping.
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
exports.MAINTENANCE_BUFFER_MS = void 0;
exports.finalizeScanSuccess = finalizeScanSuccess;
exports.finalizeScanFailure = finalizeScanFailure;
const enums_js_1 = require("../models/enums.js");
const navigator_js_1 = require("../browser/navigator.js");
const chestRepo = __importStar(require("../data/repositories/chest-repo.js"));
const triumphalChestRepo = __importStar(require("../data/repositories/triumphal-chest-repo.js"));
const sessionRepo = __importStar(require("../data/repositories/session-repo.js"));
const logger_js_1 = require("../utils/logger.js");
const scan_pipeline_js_1 = require("./scan-pipeline.js");
const log = (0, logger_js_1.childLogger)('scanner');
/**
 * Add a small buffer to the parsed maintenance duration so we don't
 * try to scan the moment maintenance ends (game often takes a few
 * minutes to come back online and be fully responsive).
 */
exports.MAINTENANCE_BUFFER_MS = 5 * 60_000;
/**
 * Update the scan_sessions row, transition to IDLE, clear the
 * maintenance marker, run screenshot cleanup, and fire onScanComplete.
 * Returns the same result object the caller passed in (mutated:
 * success=true).
 *
 * Surfaces a "manual review needed" errorMessage when OCR missed any
 * player names, plus a triumphal-sweep warning when applicable. These
 * appear as the session's errorMessage even though the session is
 * COMPLETED — the Scan History UI uses errorPhase to render the right
 * banner.
 */
async function finalizeScanSuccess(ctx, result, scanSessionId, giftsResult, triumphalWarning) {
    const unknownMsg = giftsResult.unknownNames > 0
        ? `OCR failed to read the player name for ${giftsResult.unknownNames} chest(s). ` +
            `They were saved under "${scan_pipeline_js_1.UNKNOWN_PLAYER_NAME}" and need manual review. ` +
            `Debug crops: data/screenshots/ocr_missing_name/`
        : null;
    // An abandoned sweep is still a successful one — the chests it opened were
    // claimed in-game and belong in the DB — but it did NOT reach the end of the
    // list, and the row has to say so. Without this a scan that gave up after
    // three minutes on a wedged browser reads exactly like one that found the
    // Gifts tab nearly empty, which is how five hours of OOM-driven crawling on
    // 2026-08-04 was recorded as an unremarkable COMPLETED / 232 chests.
    const stallMsg = giftsResult.stallReason
        ? `The Gifts sweep gave up before the end of the list: ${giftsResult.stallReason}. ` +
            'Chests opened before that point were kept; the rest are still on the Gifts tab and the ' +
            'next scan will take them.'
        : null;
    const errorMessage = [stallMsg, unknownMsg, triumphalWarning].filter(Boolean).join('\n') || null;
    // Most-actionable phase wins the badge. A stall outranks the other two: they
    // describe rows that need review, it describes a scan that did not finish.
    const errorPhase = stallMsg
        ? 'Capture stalled'
        : unknownMsg
            ? 'Manual review needed'
            : (triumphalWarning ? 'Triumphal sweep warning' : null);
    sessionRepo.updateSession(scanSessionId, ctx.clanId, {
        status: enums_js_1.ScanStatus.COMPLETED,
        chestsFound: result.newChests,
        screenshotsTaken: giftsResult.screenshots,
        errorsEncountered: result.errors,
        completedAt: new Date().toISOString(),
        errorMessage,
        errorPhase,
    });
    result.success = true;
    ctx.stateMachine.transition(enums_js_1.AppState.IDLE);
    // Successful scan means we're no longer in maintenance — clear any
    // stale block marker so future redeploys don't defer unnecessarily.
    ctx.clearMaintenanceBlock();
    ctx.clearLastScanError();
    // Clean old screenshots
    const { cleanOldScreenshots } = await import('../browser/screenshotter.js');
    await cleanOldScreenshots('./data/screenshots', ctx.config.screenshotRetentionDays);
    log.info(`Scan complete: ${result.chestsFound} chests found, ${result.newChests} new`);
    ctx.reportProgress('scan', `First scan complete: ${result.chestsFound} chests found (${result.newChests} new).`);
    if (ctx.onScanComplete) {
        ctx.onScanComplete(result, ctx.clanId);
    }
    return result;
}
/**
 * How many chests this session actually landed, asked of the database rather
 * than of `result.newChests`.
 *
 * This distinction is the whole ballgame. The sweeps are pipelined: clicking a
 * card CLAIMS that chest in-game and the row is written immediately, so by the
 * time anything throws there can be dozens of rows on disk. But
 * `result.newChests` is only assigned when a sweep RETURNS
 * (`result.newChests += giftsResult.newChests` in loop.ts) — a browser crash
 * mid-sweep unwinds the stack with the tally still inside it, leaving
 * `result.newChests` at 0 while the rows exist.
 *
 * The catch-all below then read that 0 as "nothing to keep" and called
 * deleteChestsBySession, destroying exactly the chests that are gone from the
 * Gifts tab and can never be scanned again. Counting the rows is the only
 * source of truth that survives the throw.
 *
 * Both tables, because the triumphal sweep writes to its own.
 *
 * Returns -1 if the count itself fails, which callers must treat as "rows may
 * exist" — guessing wrong in that direction leaves a stale row, guessing wrong
 * in the other direction is unrecoverable.
 */
function persistedChestCount(sessionId, clanId) {
    try {
        const gifts = chestRepo.countChestsBySession(sessionId, clanId);
        const triumphal = triumphalChestRepo.countBySession(sessionId, clanId);
        return { gifts, total: gifts + triumphal };
    }
    catch (err) {
        log.warn(`Could not count persisted chests for session ${sessionId}; keeping rows: ${String(err)}`);
        return { gifts: -1, total: -1 };
    }
}
/**
 * Decide what to do with a scan that threw during the run-phase.
 *
 * Three branches share one rule: chests already inserted before the
 * abort were claimed in-game, so dropping them just hides real loot
 * from the leaderboard. Only the catch-all rolls back DB rows, and
 * even then only when the session provably landed none — measured by
 * counting rows (persistedChestCount), never by an in-memory tally.
 *
 * - MaintenanceModeError: game is in a scheduled maintenance window.
 *   Persist a "blocked until" marker and override the next-cycle
 *   scheduling so a redeploy during the window doesn't immediately
 *   try again. Returns 'return'.
 * - SessionKickedError: another login forced us out. Mark the session
 *   COMPLETED (with newChests > 0) or FAILED, with the kick message
 *   surfaced. Returns 'return'.
 * - Catch-all: log + recordScanError. Keep partial inserts;
 *   otherwise roll back via deleteChestsBySession + mark FAILED.
 *   Returns 'rethrow' so runCycle can apply its retry cadence.
 */
function finalizeScanFailure(err, ctx, result, scanSessionId) {
    // Ask the DB what this session actually saved. `result.newChests` only sees
    // sweeps that returned, so anything thrown mid-sweep — the browser crashing
    // on a click being the case that prompted this — reports 0 while the rows
    // are already on disk. Every branch below decides from `persisted`.
    const persisted = persistedChestCount(scanSessionId, ctx.clanId);
    // Any row in EITHER table means there is something to protect from rollback.
    const rowsExist = persisted.total !== 0;
    // ...but chestsFound stays gifts-only, matching what the success path reports
    // (loop.ts only folds giftsResult into result.newChests). Triumphal rows are
    // bookkeeping and have their own section in the Scan History detail view.
    const keptCount = Math.max(result.newChests, Math.max(persisted.gifts, 0));
    if (persisted.total > result.newChests) {
        log.info(`Session ${scanSessionId} has ${persisted.gifts} gift + ${persisted.total - persisted.gifts} triumphal ` +
            `row(s) on disk but the in-memory tally stopped at ${result.newChests} — the abort happened ` +
            'mid-sweep. Using the row count.');
    }
    // Keep the returned result honest too: callers and the Scan History UI read
    // it, and it is the same undercount the rollback decision used to trust.
    result.newChests = keptCount;
    if (err instanceof navigator_js_1.MaintenanceModeError) {
        const durationMs = err.durationMs;
        log.warn(`Game is in maintenance mode - scan aborted${durationMs ? ` (~${Math.round(durationMs / 60_000)} min remaining)` : ''}`);
        if (rowsExist) {
            log.info(`Keeping ${keptCount} chests claimed before maintenance abort (session ${scanSessionId})`);
            sessionRepo.updateSession(scanSessionId, ctx.clanId, {
                status: enums_js_1.ScanStatus.COMPLETED,
                chestsFound: keptCount,
                errorsEncountered: 0,
                completedAt: new Date().toISOString(),
            });
        }
        else {
            sessionRepo.updateSession(scanSessionId, ctx.clanId, {
                status: enums_js_1.ScanStatus.FAILED,
                chestsFound: 0,
                errorsEncountered: 0,
                completedAt: new Date().toISOString(),
            });
        }
        ctx.stateMachine.transition(enums_js_1.AppState.IDLE);
        result.success = false;
        // Persist the maintenance block so a redeploy during the window
        // doesn't immediately try to scan again. Override the normal
        // scheduling to wait the full maintenance duration + buffer.
        if (durationMs && durationMs > 0) {
            ctx.setMaintenanceBlock(durationMs);
            if (ctx.isRunning) {
                const waitMs = durationMs + exports.MAINTENANCE_BUFFER_MS;
                log.info(`Deferring next scan by ${Math.round(waitMs / 60_000)} min until maintenance ends`);
                ctx.scheduleNextCycle(waitMs);
                // Skip runCycle's reschedule by setting a flag it reads.
                ctx.flagSkipNextScheduling();
            }
        }
        return { action: 'return' };
    }
    // Session was kicked by another browser logging into the game account.
    // Same partial-keep policy as maintenance: chests opened before the
    // kick were already claimed in-game, so dropping the rows just hides
    // them from the leaderboard.
    if (err instanceof navigator_js_1.SessionKickedError) {
        log.warn(`Scan aborted - ${err.message}`);
        const kickPhase = ctx.progressMessage || 'Scanning Gifts list';
        if (rowsExist) {
            log.info(`Keeping ${keptCount} chests claimed before session-kick (session ${scanSessionId})`);
            sessionRepo.updateSession(scanSessionId, ctx.clanId, {
                status: enums_js_1.ScanStatus.COMPLETED,
                chestsFound: keptCount,
                errorsEncountered: 1,
                completedAt: new Date().toISOString(),
                errorMessage: err.message,
                errorPhase: kickPhase,
            });
        }
        else {
            sessionRepo.updateSession(scanSessionId, ctx.clanId, {
                status: enums_js_1.ScanStatus.FAILED,
                chestsFound: 0,
                errorsEncountered: 1,
                completedAt: new Date().toISOString(),
                errorMessage: err.message,
                errorPhase: kickPhase,
            });
        }
        ctx.stateMachine.transition(enums_js_1.AppState.IDLE);
        result.success = false;
        return { action: 'return' };
    }
    // Catch-all: log the throw, but only roll back if we have nothing
    // to keep. If the scanner already inserted chests before crashing,
    // commit them — every one of those was CLAIMED in-game by the click
    // that produced it, so it is gone from the Gifts tab whether we keep
    // the row or not. Deleting is pure, unrecoverable loss.
    ctx.recordScanError(err);
    const lastErr = ctx.getLastScanError();
    const errMsg = lastErr?.message ?? null;
    const errPhase = lastErr?.phase ?? null;
    if (rowsExist) {
        log.warn(`Keeping ${keptCount} chests already inserted before the crash (session ${scanSessionId})`);
        sessionRepo.updateSession(scanSessionId, ctx.clanId, {
            status: enums_js_1.ScanStatus.COMPLETED,
            chestsFound: keptCount,
            errorsEncountered: (result.errors || 0) + 1,
            completedAt: new Date().toISOString(),
            errorMessage: errMsg,
            errorPhase: errPhase,
        });
        ctx.stateMachine.transition(enums_js_1.AppState.IDLE);
        result.success = false;
        return { action: 'return' };
    }
    // Nothing landed, so this deletes nothing — it stays as a backstop in case a
    // future write path lands a row the count above can't see. If you ever see
    // it report a non-zero number, that is a bug worth chasing, not a rollback
    // working as intended.
    const deleted = chestRepo.deleteChestsBySession(scanSessionId, ctx.clanId);
    if (deleted > 0) {
        log.warn(`Rolled back ${deleted} chest(s) from failed session ${scanSessionId} that the persisted-row ` +
            'count did not see — those chests were claimed in-game and are now unrecoverable.');
    }
    sessionRepo.updateSession(scanSessionId, ctx.clanId, {
        status: enums_js_1.ScanStatus.FAILED,
        errorsEncountered: (result.errors || 0) + 1,
        completedAt: new Date().toISOString(),
        errorMessage: errMsg,
        errorPhase: errPhase,
    });
    ctx.stateMachine.transition(enums_js_1.AppState.ERROR);
    return { action: 'rethrow' };
}
//# sourceMappingURL=scan-finalize.js.map