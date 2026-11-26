/**
 * Pauses between game requests that vary like a person's clicks instead of
 * ticking at one fixed interval (user, Nov 2026: "don't wait exactly 100 ms,
 * make it variable, but also lower it — I can click faster than 100 ms").
 *
 * A player opening chests clicks well under 100 ms apart, so these ranges sit
 * at or below that. No rate limit has ever been seen from the game server.
 */

/** A whole number of milliseconds, uniformly in [minMs, maxMs]. */
export function gapMs(minMs: number, maxMs: number, random: () => number = Math.random): number {
  const lo = Math.max(0, Math.min(minMs, maxMs));
  const hi = Math.max(minMs, maxMs);
  return Math.round(lo + random() * (hi - lo));
}

/** Wait a varied gap. */
export function requestGap(minMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, gapMs(minMs, maxMs)));
}

/** Between chest claims: faster than the 100 ms a player manages by hand. */
export const CLAIM_GAP: readonly [number, number] = [25, 75];
/** Between batched reads (cities, map tiles, clan objects). */
export const READ_GAP: readonly [number, number] = [30, 90];
/**
 * Between Dragon Coins sends from the clan treasury: one member at a time, as
 * the treasury's own send works; unhurried, since each one pays out.
 */
export const TREASURY_SEND_GAP: readonly [number, number] = [1500, 3500];
