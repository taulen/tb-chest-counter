/**
 * When each clan's next scheduled scan is due. Every clan keeps its own
 * schedule: a full interval after its last scan, where the interval is the
 * clan's own (Clans page, clans.scan_interval_minutes) or the global one
 * (System page, SCAN_INTERVAL_MS) when it has none.
 *
 * Until Nov 2026 the loop ran ONE global timer and every active clan scanned
 * together; the per-clan interval was stored and editable but nothing read it.
 *
 * A clan's last scan is when the cycle that scanned it ENDED (so clans on the
 * same interval that scan together stay in step), or when its manual scan
 * finished. A clan with no scan on record is due now.
 */
export interface ClanDue {
  id: number;
  intervalMs: number;
  /** Epoch ms of the clan's last scan; null when it has none. */
  lastScanAt: number | null;
}

/** A clan's interval: its own when it has one, else the global one. */
export function clanIntervalMs(clanMinutes: number | null, globalMs: number): number {
  return clanMinutes !== null && clanMinutes > 0 ? clanMinutes * 60_000 : globalMs;
}

export function dueAt(clan: ClanDue, now: number): number {
  return clan.lastScanAt === null ? now : clan.lastScanAt + clan.intervalMs;
}

/**
 * How early a clan may join a cycle that starts for another clan: up to a
 * minute, never more than a tenth of its own interval. Saves a second cycle
 * (and a second game login on a shared account) seconds after the first.
 */
export function joinEarlyMs(intervalMs: number): number {
  return Math.min(60_000, Math.floor(intervalMs / 10));
}

/** The clans a scheduled cycle starting now scans, in the order given. */
export function dueClanIds(clans: readonly ClanDue[], now: number): number[] {
  return clans.filter((c) => dueAt(c, now) <= now + joinEarlyMs(c.intervalMs)).map((c) => c.id);
}

/** When the next scheduled cycle should start; null when there are no clans. */
export function soonestDue(clans: readonly ClanDue[], now: number): number | null {
  let soonest: number | null = null;
  for (const c of clans) {
    const at = dueAt(c, now);
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}
