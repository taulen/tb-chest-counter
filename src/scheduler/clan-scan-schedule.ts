/**
 * Where ONE clan stands in the scan schedule — what the public share page
 * shows as "Next scan in …" / "Next scan: soon" / "Scanning…".
 *
 * The admin header can read the loop's global timer straight, because it only
 * ever answers for the cycle as a whole. A share page answers for one clan
 * while a cycle walks the active clans one at a time, and mid-cycle the global
 * timer is the cycle's own start — already in the past. Read raw, every clan
 * would say "due now" for the whole cycle, including a clan that was scanned
 * ten minutes ago and won't be touched again for a full interval.
 *
 * "Due" is a state of its own, never a timestamp of "now": the page compares
 * a time against the visitor's clock, and a device a second slow read "now"
 * as a one-second countdown — which ran out to "soon", re-polled, got "now"
 * again, and flipped between the two for as long as the clan waited its turn.
 * For the same reason a scheduled scan goes out as time REMAINING, measured on
 * the server's clock, not as an absolute time.
 */
export interface ClanScanScheduleInput {
  clanId: number;
  now: number;
  /** The global timer for this clan: null when it isn't in the rotation or nothing is scheduled. */
  nextScanAt: number | null;
  intervalMs: number;
  /** Clans the running cycle walks, in order; empty between cycles. */
  cycleOrder: readonly number[];
  /**
   * How many clans at the front of cycleOrder the cycle is finished with —
   * scanned, skipped, or into the might/resource phases that follow a scan
   * (the chests are written and the session finalised by then).
   */
  cycleDoneCount: number;
  /** The clan whose chest scan is running right now (post-scan phases excluded), or null. */
  scanningClanId: number | null;
}

export interface ClanScanSchedule {
  scanning: boolean;
  /** The clan's scan is due: waiting its turn in a running cycle, or the timer has run out. */
  due: boolean;
  /** Milliseconds until the next scan, when that's in the future; null otherwise. */
  nextScanInMs: number | null;
}

const SCANNING: ClanScanSchedule = { scanning: true, due: false, nextScanInMs: null };
const DUE: ClanScanSchedule = { scanning: false, due: true, nextScanInMs: null };
const OFF: ClanScanSchedule = { scanning: false, due: false, nextScanInMs: null };

export function resolveClanScanSchedule(input: ClanScanScheduleInput): ClanScanSchedule {
  const { clanId, now } = input;
  if (input.scanningClanId === clanId) return SCANNING;
  const pos = input.cycleOrder.indexOf(clanId);
  if (pos !== -1) {
    // Done this cycle. The real timer is armed from the cycle's END, so a full
    // interval from now is a lower bound that corrects itself the moment the
    // cycle finishes.
    if (pos < input.cycleDoneCount) return { scanning: false, due: false, nextScanInMs: input.intervalMs };
    // Still ahead in this cycle — or up next with its browser still launching.
    return DUE;
  }
  if (input.nextScanAt === null) return OFF;
  const inMs = input.nextScanAt - now;
  return inMs > 0 ? { scanning: false, due: false, nextScanInMs: inMs } : DUE;
}
