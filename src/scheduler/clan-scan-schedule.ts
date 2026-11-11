/**
 * Where ONE clan stands in the scan schedule — what the public share page
 * shows as "Next scan in …" / "Scanning…".
 *
 * The admin header can read the loop's global timer straight, because it only
 * ever answers for the cycle as a whole. A share page answers for one clan
 * while a cycle walks the active clans one at a time, and mid-cycle the global
 * timer is the cycle's own start — already in the past. Read raw, every clan
 * would say "due now" for the whole cycle, including a clan that was scanned
 * ten minutes ago and won't be touched again for a full interval.
 */
export interface ClanScanScheduleInput {
  clanId: number;
  now: number;
  /** The global timer for this clan: null when it isn't in the rotation or nothing is scheduled. */
  nextScanAt: number | null;
  intervalMs: number;
  /** Clans the running cycle walks, in order; empty between cycles. */
  cycleOrder: readonly number[];
  /** Index into cycleOrder of the clan the cycle is on. */
  cycleCursor: number;
  /**
   * The clan whose chest scan is running right now, or null. The might and
   * resource phases that follow a scan don't count: the chests are already
   * written and the session is finalised by then.
   */
  scanningClanId: number | null;
}

export interface ClanScanSchedule {
  scanning: boolean;
  /** Epoch ms; at or before `now` means due (the clan is waiting its turn). Null = no scan scheduled. */
  nextScanAt: number | null;
}

export function resolveClanScanSchedule(input: ClanScanScheduleInput): ClanScanSchedule {
  const { clanId, now } = input;
  if (input.scanningClanId === clanId) return { scanning: true, nextScanAt: null };
  const pos = input.cycleOrder.indexOf(clanId);
  if (pos !== -1) {
    // Still ahead in this cycle: due now, it's just waiting for the clans
    // before it.
    if (pos > input.cycleCursor) return { scanning: false, nextScanAt: now };
    // Done this cycle (or in its post-scan phases). The real timer is armed
    // from the cycle's END, so a full interval from now is a lower bound that
    // corrects itself the moment the cycle finishes.
    return { scanning: false, nextScanAt: now + input.intervalMs };
  }
  return { scanning: false, nextScanAt: input.nextScanAt };
}
