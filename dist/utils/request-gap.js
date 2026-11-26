"use strict";
/**
 * Pauses between game requests that vary like a person's clicks instead of
 * ticking at one fixed interval (user, Nov 2026: "don't wait exactly 100 ms,
 * make it variable, but also lower it — I can click faster than 100 ms").
 *
 * A player opening chests clicks well under 100 ms apart, so these ranges sit
 * at or below that. No rate limit has ever been seen from the game server.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TREASURY_SEND_GAP = exports.READ_GAP = exports.CLAIM_GAP = void 0;
exports.gapMs = gapMs;
exports.requestGap = requestGap;
/** A whole number of milliseconds, uniformly in [minMs, maxMs]. */
function gapMs(minMs, maxMs, random = Math.random) {
    const lo = Math.max(0, Math.min(minMs, maxMs));
    const hi = Math.max(minMs, maxMs);
    return Math.round(lo + random() * (hi - lo));
}
/** Wait a varied gap. */
function requestGap(minMs, maxMs) {
    return new Promise((resolve) => setTimeout(resolve, gapMs(minMs, maxMs)));
}
/** Between chest claims: faster than the 100 ms a player manages by hand. */
exports.CLAIM_GAP = [25, 75];
/** Between batched reads (cities, map tiles, clan objects). */
exports.READ_GAP = [30, 90];
/**
 * Between Dragon Coins sends from the clan treasury: one member at a time, as
 * the treasury's own send works; unhurried, since each one pays out.
 */
exports.TREASURY_SEND_GAP = [1500, 3500];
//# sourceMappingURL=request-gap.js.map