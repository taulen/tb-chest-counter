/**
 * Physical sanity bounds on a hero-level reading, judged against the might read off
 * the same row.
 *
 * Shared by the capture (browser/might-capture.ts), so a fresh misread is never
 * stored, and by the read side (might-repo's trustedHeroLevels), so the rows already
 * in the database get the same judgement. The read side's longest-non-decreasing
 * chain cannot do this on its own: it only knows a member's history, and a member
 * with two days of it — every member of a newly added clan — has no history to
 * outvote a bad reading with. Measured on the Oct 23 2026 backup:
 *
 *   - Brooke read 7147 the day after 147, and Red Stilettos 1357 for six days
 *     straight after 356/357. The badge's star ornament came back as a DIGIT, so the
 *     number grew a leading glyph. Every four-digit reading in the table (10 of 10)
 *     is its member's true level with one extra leading digit.
 *   - Nightfrog read 38 at 214M might the day after 184; Misiu 39 at 298M, Mazukinos
 *     3 and 31 at 145M between days of 203/204 — a clipped badge, or a neighbour's.
 */

/**
 * Levels run to roughly 600 in the live game. Three digits is the ceiling a reading
 * can honestly have; anything longer is the ornament glued on.
 */
export const HERO_LEVEL_MAX = 999;

/**
 * The most might a hero level can carry, as might ≤ K × level².
 *
 * Measured across 14.7k readings: established players sit at 6k–10k (level 100 at
 * ~58M, 200 at ~345M, 410 at ~1.5B); the highest ratio held for more than a single
 * day is ~33k. Every reading above 40k is a one-off dip inside a member's own steady
 * series. So 40k keeps every repeated reading and rejects all of those — 38 needs
 * under 58M might, a level 3 under 360k.
 */
const MIGHT_PER_LEVEL_SQ_MAX = 40_000;

/**
 * The level a raw badge reading actually means, or null when it cannot be one for a
 * player of this might. `might` of 0 or less skips the might check (not read).
 */
export function saneHeroLevel(raw: number | null | undefined, might: number): number | null {
  if (raw == null || !Number.isFinite(raw) || raw < 1) return null;
  // A fourth digit is the ornament read as a digit, never a real level: drop the
  // leading glyph rather than the reading — 7147 → 147, 1357 → 357.
  let level = Math.trunc(raw);
  if (level > HERO_LEVEL_MAX) level = Number(String(level).slice(-3));
  if (level < 1) return null;
  if (might > 0 && might > MIGHT_PER_LEVEL_SQ_MAX * level * level) return null;
  return level;
}
