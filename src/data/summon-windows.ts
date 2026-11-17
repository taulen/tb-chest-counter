/**
 * Splitting a Rise of the Ancients run into summons, from the reads of its
 * standings (game_event_reads, v124: every scan and every between-scans poll).
 *
 * The in-game ranking is cumulative and only grows while a summon is running
 * (1–50 minutes); between summons it stays flat. So a summon is a window:
 *
 *   - it STARTS when "Summons left" drops between two reads (or, with no
 *     summons-left to go by, when points move after a flat read);
 *   - it ENDS when points stop moving (a flat read after its start), at the
 *     latest 50 minutes after it started, or when the next summon starts;
 *   - its points per member = their points at its end − at its start (the read
 *     before the drop).
 *
 * Back-to-back summons are only split when the reads clearly separate them: a
 * flat read (or 50 minutes) between the first one's start and the read before
 * the second one's drop. Otherwise they are ONE group ("Summons 2–3"), the
 * total of both, which is what the leaders did by hand. Two drops between the
 * same two reads are always one group. Never invent a split. Pure; tested in
 * tests/data/summon-windows.test.ts.
 */

/** The longest a summon runs (user, Nov 2026: "each summon lasts 1 to 50 minutes"). */
export const MAX_SUMMON_MS = 50 * 60_000;

export interface SummonRead {
  /** Epoch ms of the read. */
  at: number;
  /** "Summons left" at the read (38000); null when it wasn't read. */
  left: number | null;
  /** The Enchanted Figurine's summons at the read; null when not read. */
  max: number | null;
  /** Members whose points moved since the previous read; 0 = a flat read. */
  changed: number;
  /** Every member's points added up, at the read. */
  total: number;
}

export interface SummonGroup {
  /** Summon numbers in the group: equal, unless back-to-back summons can't be told apart. */
  first: number;
  last: number;
  /** Index of the read its points count from; null = the run's start (everyone at 0). */
  from: number | null;
  /** Index of the read its points count to. */
  to: number;
  /** Still scoring, or not yet: the run runs, no flat read since it started and under 50 minutes. */
  live: boolean;
  /** When its (latest) summon started: after `startedAfter` (null = before the run's first read), by `startedBy` (epoch ms). */
  startedAfter: number | null;
  startedBy: number;
}

export interface SummonSplit {
  groups: SummonGroup[];
  /** Summons used so far. */
  used: number;
  /** "Summons left" at the newest read that had it. */
  left: number | null;
  /** The run's summons in all: the Figurine's, or used + left when that is more. */
  max: number | null;
}

export function splitSummons(
  reads: readonly SummonRead[],
  opts: { now: number; running: boolean; maxSummonMs?: number },
): SummonSplit {
  const cap = opts.maxSummonMs ?? MAX_SUMMON_MS;
  const r = [...reads].sort((a, b) => a.at - b.at);
  if (!r.length) return { groups: [], used: 0, left: null, max: null };
  const groups: Array<SummonGroup & { startIdx: number }> = [];

  // Before the first read: what it says was used already. Points without a
  // used summon still mean one happened (a reply without summons-left).
  const r0 = r[0];
  let used = r0.left !== null ? Math.max(r0.max ?? 0, r0.left) - r0.left : 0;
  if (used === 0 && r0.total > 0) used = 1;
  if (used > 0) groups.push({ first: 1, last: used, from: null, to: 0, live: false, startedAfter: null, startedBy: r0.at, startIdx: 0 });

  // A group's points are final by read k: a flat read after its latest start,
  // or the longest a summon runs has passed since that start.
  const finalBy = (g: { startIdx: number; startedBy: number }, k: number): boolean =>
    (k > g.startIdx && r[k].changed === 0) || r[k].at >= g.startedBy + cap;

  let lastLeft = r0.left;
  /** Summons inferred from movement while summons-left was unknown, since `lastLeft`. */
  let inferred = 0;
  for (let j = 1; j < r.length; j++) {
    const cur = r[j];
    const g = groups[groups.length - 1];
    let started = 0;
    if (cur.left !== null && lastLeft !== null) {
      // A rise (more summons granted) starts nothing.
      started = Math.max(0, lastLeft - cur.left - inferred);
    } else if (cur.changed > 0 && (!g || finalBy(g, j - 1))) {
      // No summons-left to go by: points moving after a flat stretch.
      started = 1;
    }
    // Points moving with no summon on record at all: one happened.
    if (!started && !g && cur.changed > 0) started = 1;
    if (cur.left !== null) {
      lastLeft = cur.left;
      inferred = 0;
    } else {
      inferred += started;
    }

    if (started > 0) {
      if (!g || finalBy(g, j - 1)) {
        if (g) g.to = j - 1;
        groups.push({
          first: used + 1, last: used + started, from: j - 1, to: j, live: false,
          startedAfter: r[j - 1].at, startedBy: cur.at, startIdx: j,
        });
      } else {
        // Back to back: the previous summon may still have been scoring when
        // this one began. One column for both, as the leaders paste it.
        g.last = used + started;
        g.startIdx = j;
        g.startedBy = cur.at;
      }
      used += started;
    }
    groups[groups.length - 1] && (groups[groups.length - 1].to = j);
  }

  const lastGroup = groups[groups.length - 1];
  if (lastGroup && opts.running) {
    lastGroup.live = !finalBy(lastGroup, r.length - 1) && opts.now < lastGroup.startedBy + cap;
  }

  let left: number | null = null;
  let figurine: number | null = null;
  for (const x of r) {
    if (x.left !== null) left = x.left;
    if (x.max !== null) figurine = x.max;
  }
  const max = left === null && figurine === null ? null : Math.max(figurine ?? 0, used + (left ?? 0));
  return {
    groups: groups.map(({ startIdx: _s, ...g }) => g),
    used,
    left,
    max,
  };
}

/**
 * Each player's points per group: their points at the group's end read minus
 * at its start read. `pointsAt(playerId, readIndex)` is the player's points as
 * of that read (0 before their first). Returns group index → points.
 */
export function pointsPerGroup(
  groups: readonly SummonGroup[],
  pointsAt: (readIndex: number) => number,
): number[] {
  return groups.map((g) => pointsAt(g.to) - (g.from === null ? 0 : pointsAt(g.from)));
}
