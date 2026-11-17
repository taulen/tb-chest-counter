/**
 * Scan lanes: clans scan in PARALLEL when they sign in with different Total
 * Battle accounts, and strictly one after another when they share one.
 *
 * A game login takes over the account's session (game-protocol.md), so two
 * scans on one account at once would knock each other out — SIK and SK7 share
 * one website account (Nov 2026). Everything else is independent: the
 * protocol scan is plain HTTPS from the server, and better-sqlite3 serialises
 * the writes.
 *
 * A lane is keyed by the scanner account (the website user id, `tb:<n>`),
 * learned from the stored login by the 30-minute session check and from every
 * scan (scan-account-repo.ts). A clan whose account is not known yet is
 * EXCLUSIVE: it runs alone, after every lane queued before it and before any
 * queued after it — it might share an account with any other clan, so it may
 * overlap none. `SCAN_PARALLEL=0` puts every clan in one lane (the old serial
 * scan).
 */

/** The lane a clan with an unknown account runs in: alone. */
export const EXCLUSIVE = '*';
/** The single lane when parallel scanning is switched off. */
export const SERIAL = 'serial';

/** Parallel scanning unless SCAN_PARALLEL is 0/false/off. */
export function scanParallelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.SCAN_PARALLEL ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** The lane key for a clan. */
export function laneKeyFor(account: string | null, parallel: boolean): string {
  if (!parallel) return SERIAL;
  return account ? `acct:${account}` : EXCLUSIVE;
}

/**
 * The cycle's clans grouped into lanes, each keeping the cycle's order. Clans
 * with an unknown account come back in `exclusive`: the cycle runs them one at
 * a time after the lanes.
 */
export function planLanes(
  clanIds: readonly number[],
  accountOf: (clanId: number) => string | null,
  parallel: boolean,
): { lanes: Array<{ key: string; clanIds: number[] }>; exclusive: number[] } {
  const lanes = new Map<string, number[]>();
  const exclusive: number[] = [];
  for (const id of clanIds) {
    const key = laneKeyFor(accountOf(id), parallel);
    if (key === EXCLUSIVE) {
      exclusive.push(id);
      continue;
    }
    const list = lanes.get(key) ?? [];
    list.push(id);
    lanes.set(key, list);
  }
  return { lanes: [...lanes].map(([key, ids]) => ({ key, clanIds: ids })), exclusive };
}

/**
 * Work queued per lane: jobs on one lane run one at a time, in the order they
 * were queued; jobs on different lanes run at the same time. An EXCLUSIVE job
 * waits for everything queued before it on every lane, and everything queued
 * after it waits for it.
 */
export class LaneQueue {
  private tails = new Map<string, Promise<void>>();
  private exclusiveTail: Promise<void> = Promise.resolve();
  /** Jobs queued or running, per lane. */
  private counts = new Map<string, number>();

  run<T>(lane: string, job: () => Promise<T>): Promise<T> {
    const before = lane === EXCLUSIVE
      ? Promise.allSettled([...this.tails.values(), this.exclusiveTail])
      : Promise.allSettled([this.tails.get(lane) ?? Promise.resolve(), this.exclusiveTail]);
    this.counts.set(lane, (this.counts.get(lane) ?? 0) + 1);
    const done = before.then(job).finally(() => {
      const n = (this.counts.get(lane) ?? 1) - 1;
      if (n > 0) this.counts.set(lane, n);
      else this.counts.delete(lane);
    });
    const settled = done.then(() => undefined, () => undefined);
    if (lane === EXCLUSIVE) this.exclusiveTail = settled;
    else this.tails.set(lane, settled);
    return done;
  }

  /** Jobs queued or running on a lane. */
  pending(lane: string): number {
    return this.counts.get(lane) ?? 0;
  }

  /** Nothing queued or running anywhere. */
  idle(): boolean {
    return this.counts.size === 0;
  }
}
