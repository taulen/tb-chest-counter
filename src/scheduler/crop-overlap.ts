/**
 * Crop-boundary de-duplication for the pipelined gift sweep.
 *
 * A batch screenshots four cards and then clicks Open four times, assuming
 * each click consumes the top card. Measured against a real database (205,677
 * rows), that assumption fails on about one click in ten: the card at the
 * BOTTOM of one crop turns up again at the TOP of the next, and both readings
 * were being written. 11% of every chest ever recorded was one gift counted
 * twice — which is why an Ancients run, capped at 12 per member in-game,
 * regularly showed 13 or 14, and a round finish reward never read round.
 * Whether the click missed or the compositor hadn't finished sliding the list
 * up by screenshot time doesn't change the arithmetic: the card was already
 * recorded from the crop it first appeared in.
 *
 * The re-read is provable rather than guessed at, because the countdown pins
 * it. A gift's "time left" is displayed to the MINUTE, so for one physical
 * card read in two crops `screenshotMs + timeLeft` — which is what earned_at
 * is derived from — moves by exactly the gap between the two screenshots, or
 * by that gap minus 60s if the minute happened to tick between them. Nothing
 * else lands on those two values. (Confirmation that this is physics and not
 * pattern-matching: across the measured database the minute-ticked variant
 * accounts for 964 of 23,658 overlaps = 4.1%, against the 2.5s/60s = 4.2%
 * predicted by the observed screenshot interval.)
 *
 * So a drop needs BOTH: the same card identity (member + chest + source, after
 * every correction the insert path applies) and an earn-time shift on one of
 * those two exact values. A member who genuinely received two identical gifts
 * in the same minute keeps both unless they also straddle a boundary in that
 * exact alignment.
 *
 * Validated against the caps the game itself enforces: over 390 member-runs of
 * Ancients (max 12 per member), 34 were over the cap before and 0 after, with
 * the maximum landing exactly ON 12 rather than under it; Quick March (max 1)
 * went 1 → 0. Under-dropping shows up as a cap still exceeded; over-dropping
 * would have pushed those maxima below the cap.
 */

/** A gift's countdown is displayed to the minute, so a re-read can tick once. */
const MINUTE_MS = 60_000;
/** Two screenshots further apart than this aren't an adjacent pair. */
const MAX_GAP_MS = 30_000;

/** One card as seen on screen: what it was, and when its gift was received. */
export interface SeenCard {
  /** Member + chest + source, after every correction the insert path applies. */
  identity: string;
  /** Earn estimate from THIS reading, or null when the countdown didn't parse. */
  earnedAt: number | null;
}

/** One crop's full reading, and the moment its screenshot was taken. */
export interface SeenCrop {
  cards: SeenCard[];
  cropMs: number;
}

/**
 * True when `b`, read `gapMs` after `a`, is the same physical gift. Without a
 * countdown on both readings there is no evidence either way, and the card is
 * kept — an extra row is recoverable, a dropped chest is not.
 */
export function isSameGift(a: SeenCard, b: SeenCard, gapMs: number): boolean {
  if (a.identity !== b.identity || a.earnedAt === null || b.earnedAt === null) return false;
  const drift = b.earnedAt - a.earnedAt - gapMs;
  return drift === 0 || drift === -MINUTE_MS;
}

/**
 * How many leading cards of `cur` are trailing cards of `prev` read again.
 *
 * Matched as a contiguous run anchored at both ends — the list slides as a
 * unit, so an unconsumed card carries its neighbours with it — and the longest
 * run wins, since every click in a batch can miss. Returns 0 when the two
 * screenshots aren't an adjacent pair.
 */
export function repeatedLeadingCards(prev: SeenCrop, cur: SeenCard[], curCropMs: number): number {
  const gapMs = curCropMs - prev.cropMs;
  if (!(gapMs > 0 && gapMs <= MAX_GAP_MS)) return 0;
  let longest = 0;
  for (let k = 1; k <= Math.min(prev.cards.length, cur.length); k++) {
    let all = true;
    for (let j = 0; j < k; j++) {
      if (!isSameGift(prev.cards[prev.cards.length - k + j], cur[j], gapMs)) {
        all = false;
        break;
      }
    }
    if (all) longest = k;
  }
  return longest;
}
