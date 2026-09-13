"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateClaim = void 0;
/**
 * Tiny single-claim mutex for "only one of X may run at a time" gates.
 *
 * Replaces the pattern of a bare `let bootstrapRunning = false` boolean
 * checked-and-set in two places: the check happens in the route
 * handler, the set happens inside the async function it calls. That
 * pattern only works if no `await` ever lands between the check and
 * the set; one stray `await` and two concurrent requests can both
 * claim the same gate.
 *
 * `tryClaim()` does the check-and-set atomically (synchronous JS) and
 * returns whether the caller is now the owner. The owner must call
 * `release()` when finished — typically in a `finally` block.
 */
class StateClaim {
    claimed = false;
    /**
     * Attempt to take the claim. Returns true exactly once until
     * `release()` is called; further calls return false. Synchronous so
     * concurrent callers in the same JS tick can never both win.
     */
    tryClaim() {
        if (this.claimed)
            return false;
        this.claimed = true;
        return true;
    }
    /** Release the claim so the next caller can take it. */
    release() {
        this.claimed = false;
    }
    /** Inspect without claiming. Useful for status endpoints. */
    isClaimed() {
        return this.claimed;
    }
}
exports.StateClaim = StateClaim;
//# sourceMappingURL=state-claim.js.map