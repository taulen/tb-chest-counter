"use strict";
// Post-scan finalization helpers — the success-path "update the
// scan_sessions row + clean up state" sequence, plus the failure path that
// decides whether to keep already-inserted chests or roll them back.
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
exports.finalizeScanSuccess = finalizeScanSuccess;
exports.finalizeScanFailure = finalizeScanFailure;
const enums_js_1 = require("../models/enums.js");
const chestRepo = __importStar(require("../data/repositories/chest-repo.js"));
const triumphalChestRepo = __importStar(require("../data/repositories/triumphal-chest-repo.js"));
const sessionRepo = __importStar(require("../data/repositories/session-repo.js"));
const logger_js_1 = require("../utils/logger.js");
const log = (0, logger_js_1.childLogger)('scanner');
/**
 * Update the scan_sessions row, transition to IDLE and fire onScanComplete.
 * Returns the same result object the caller passed in (mutated:
 * success=true).
 *
 * `scanWarning` carries the protocol scan's notes (chests that could not be
 * opened, gift types the game data has no name for). It becomes the
 * session's errorMessage even though the session is COMPLETED — the Scan
 * History UI uses errorPhase to render the right banner.
 */
function finalizeScanSuccess(ctx, result, scanSessionId, scanWarning = null) {
    sessionRepo.updateSession(scanSessionId, ctx.clanId, {
        status: enums_js_1.ScanStatus.COMPLETED,
        chestsFound: result.newChests,
        screenshotsTaken: 0,
        errorsEncountered: result.errors,
        completedAt: new Date().toISOString(),
        errorMessage: scanWarning,
        errorPhase: scanWarning ? 'Scan warning' : null,
    });
    result.success = true;
    ctx.stateMachine.transition(enums_js_1.AppState.IDLE);
    ctx.clearLastScanError();
    log.info(`Scan complete: ${result.chestsFound} chests found, ${result.newChests} new`);
    ctx.reportProgress(`Scan complete: ${result.chestsFound} chests found (${result.newChests} new).`);
    if (ctx.onScanComplete) {
        ctx.onScanComplete(result, ctx.clanId);
    }
    return result;
}
/**
 * How many chests this session actually landed, asked of the database rather
 * than of `result.newChests`.
 *
 * This distinction is the whole ballgame. Every gift is recorded before it is
 * claimed, and a claim takes the chest out of the game for good, so by the
 * time anything throws there can be dozens of rows on disk. But
 * `result.newChests` is only assigned when the record-and-claim step RETURNS
 * — a throw mid-way unwinds the stack with the tally still inside it,
 * leaving `result.newChests` at 0 while the rows exist.
 *
 * Reading that 0 as "nothing to keep" and calling deleteChestsBySession would
 * destroy exactly the chests that can never be read again. Counting the rows
 * is the only source of truth that survives the throw.
 *
 * Both tables, because triumphal gifts are written to their own.
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
 * Decide what to do with a scan that threw after its session row existed.
 *
 * Chests already inserted before the throw were (or are about to be) claimed
 * in-game, so dropping them just hides real loot from the leaderboard. The
 * session only rolls back when it provably landed none — measured by
 * counting rows (persistedChestCount), never by an in-memory tally.
 *
 * Keeps partial inserts and returns 'return'; otherwise rolls back via
 * deleteChestsBySession, marks the session FAILED and returns 'rethrow' so
 * runCycle can apply its retry cadence.
 */
function finalizeScanFailure(err, ctx, result, scanSessionId) {
    // Ask the DB what this session actually saved. `result.newChests` only sees
    // a record step that returned, so anything thrown mid-way reports 0 while
    // the rows are already on disk.
    const persisted = persistedChestCount(scanSessionId, ctx.clanId);
    // Any row in EITHER table means there is something to protect from rollback.
    const rowsExist = persisted.total !== 0;
    // ...but chestsFound stays gifts-only, matching what the success path
    // reports. Triumphal rows are bookkeeping and have their own section in the
    // Scan History detail view.
    const keptCount = Math.max(result.newChests, Math.max(persisted.gifts, 0));
    if (persisted.total > result.newChests) {
        log.info(`Session ${scanSessionId} has ${persisted.gifts} gift + ${persisted.total - persisted.gifts} triumphal ` +
            `row(s) on disk but the in-memory tally stopped at ${result.newChests} — the scan threw ` +
            'mid-way. Using the row count.');
    }
    // Keep the returned result honest too: callers and the Scan History UI read
    // it, and it is the same undercount the rollback decision used to trust.
    result.newChests = keptCount;
    ctx.recordScanError(err);
    const lastErr = ctx.getLastScanError();
    const errMsg = lastErr?.message ?? null;
    const errPhase = lastErr?.phase ?? null;
    if (rowsExist) {
        log.warn(`Keeping ${keptCount} chests already inserted before the failure (session ${scanSessionId})`);
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
            'count did not see.');
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