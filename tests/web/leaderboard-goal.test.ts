import { describe, expect, it } from 'vitest';
import {
  formatMightCompact,
  goalRowClassFor,
  goalStatusClassFor,
  goalWarnThreshold,
  scaleGoalForPeriod,
  sortLeaderboardEntries,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - plain browser module, imported directly so the shared math is testable here
} from '../../src/web/public/lib/leaderboard-render.js';

/**
 * The leaderboard's goal colouring and its might/level columns are rendered by
 * ONE module shared by the authenticated page and the public share page, so a
 * bug in this arithmetic is a bug on both surfaces at once. These are the parts
 * with no DOM in them, which is all of the parts that can be wrong quietly.
 *
 * The scaling rule under test: a clan stores a single WEEKLY target, and every
 * other timeframe is a flat daily rate (weekly / 7) times the length of the
 * period. That is the whole reason only one number is stored — four independent
 * targets could be set to values that contradict each other, and no colouring
 * could then be honest about whether someone is on pace.
 */
describe('scaleGoalForPeriod', () => {
  it('passes the weekly goal through unscaled', () => {
    expect(scaleGoalForPeriod(25_000, 'weekly')).toBe(25_000);
  });

  it('derives the day from the week (goal / 7)', () => {
    expect(scaleGoalForPeriod(25_000, 'daily')).toBe(3571); // 25000/7 = 3571.43
  });

  it('derives the month as 30 daily rates, not a calendar month', () => {
    // Deliberately 30 and not 28/29/31: the target must not move because
    // February is short, and the leaderboard's own monthly window is a
    // calendar month either way. A fixed 30 keeps the goal comparable
    // month to month.
    expect(scaleGoalForPeriod(25_000, 'monthly')).toBe(107_143); // (25000/7)*30
  });

  it('derives the year as 365 daily rates', () => {
    expect(scaleGoalForPeriod(25_000, 'yearly')).toBe(1_303_571);
  });

  it('has no goal for the all-time view', () => {
    // An all-time window has no length to scale by, so any number painted
    // against it would be arbitrary — better no colouring than a made-up bar.
    expect(scaleGoalForPeriod(25_000, 'all')).toBeNull();
  });

  it('treats a missing, zero or negative weekly goal as no goal', () => {
    for (const bad of [null, undefined, 0, -1, Number.NaN]) {
      expect(scaleGoalForPeriod(bad as never, 'weekly')).toBeNull();
    }
  });
});

describe('goalStatusClassFor', () => {
  it('is green at the goal and above', () => {
    expect(goalStatusClassFor(1000, 1000)).toBe('goal-cell-ok');
    expect(goalStatusClassFor(9999, 1000)).toBe('goal-cell-ok');
  });

  it('is amber from 66% of the goal up to it', () => {
    expect(goalStatusClassFor(660, 1000)).toBe('goal-cell-warn');
    expect(goalStatusClassFor(999, 1000)).toBe('goal-cell-warn');
  });

  it('is red below 66%', () => {
    expect(goalStatusClassFor(659, 1000)).toBe('goal-cell-low');
    expect(goalStatusClassFor(0, 1000)).toBe('goal-cell-low');
  });

  it('returns no class at all when there is no goal', () => {
    // Empty string, not a class that happens to paint nothing — an
    // unconfigured clan's cells must carry no status marker for the
    // stylesheet to key on.
    expect(goalStatusClassFor(500, null)).toBe('');
    expect(goalStatusClassFor(500, 0)).toBe('');
  });
});

/**
 * The threshold the UI PRINTS has to be the threshold the cells actually use.
 * This started out as Math.round(goal * 0.66), which rounds down for roughly
 * half of all goals — so the caption named a points total that rendered red on
 * the row directly beneath it. Math.ceil is the first integer that earns amber.
 */
describe('goalWarnThreshold', () => {
  it('names a value that is actually amber, never the red one below it', () => {
    // The reported case: weekly 7,511 -> daily goal 1,073. Rounding gives 708,
    // and 708/1073 = 0.6598 which is RED.
    const daily = scaleGoalForPeriod(7511, 'daily');
    expect(daily).toBe(1073);
    expect(goalWarnThreshold(daily)).toBe(709);
    expect(goalStatusClassFor(709, daily)).toBe('goal-cell-warn');
    expect(goalStatusClassFor(708, daily)).toBe('goal-cell-low');
  });

  it('holds for the monthly scaling of a round weekly goal', () => {
    // Weekly 25,000 -> monthly 107,143. Rounding gives 70,714 (red at
    // 0.659996); the true cutoff is 70,715.
    const monthly = scaleGoalForPeriod(25_000, 'monthly');
    expect(goalWarnThreshold(monthly)).toBe(70_715);
    expect(goalStatusClassFor(goalWarnThreshold(monthly), monthly)).toBe('goal-cell-warn');
  });

  it('is the smallest amber value across a wide sweep of goals', () => {
    // Property check rather than more examples: for every goal, the threshold
    // must be amber and one point less must be red.
    for (let goal = 1; goal <= 3000; goal++) {
      const n = goalWarnThreshold(goal);
      expect(goalStatusClassFor(n, goal), `goal=${goal} n=${n}`).not.toBe('goal-cell-low');
      if (n > 0) {
        expect(goalStatusClassFor(n - 1, goal), `goal=${goal} n-1=${n - 1}`).toBe('goal-cell-low');
      }
    }
  });

  it('has no threshold without a goal', () => {
    expect(goalWarnThreshold(null)).toBeNull();
    expect(goalWarnThreshold(0)).toBeNull();
  });
});

/**
 * The row wash and the Points cell read the SAME bucket. They are two classes
 * because they paint different things at different strengths, but if they could
 * ever disagree a row would be washed green with a red number in it — so the
 * bucketing lives in one private helper and both of these are thin wrappers.
 */
describe('goalRowClassFor', () => {
  it('agrees with the cell class on every boundary', () => {
    const cases: Array<[number, number, string]> = [
      [1000, 1000, 'ok'],
      [999, 1000, 'warn'],
      [660, 1000, 'warn'],
      [659, 1000, 'low'],
      [0, 1000, 'low'],
    ];
    for (const [points, goal, bucket] of cases) {
      expect(goalRowClassFor(points, goal), `${points}/${goal}`).toBe(`goal-row-${bucket}`);
      expect(goalStatusClassFor(points, goal), `${points}/${goal}`).toBe(`goal-cell-${bucket}`);
    }
  });

  it('marks nothing when the clan has no goal', () => {
    // An unconfigured clan's rows must carry no class at all — the <tr> falls
    // back to the plain table styling with no status wash.
    expect(goalRowClassFor(500, null)).toBe('');
    expect(goalRowClassFor(500, 0)).toBe('');
  });
});

describe('sortLeaderboardEntries', () => {
  // Canonical server order: points DESC, chests DESC, name ASC. Rows carry
  // `rank` pinned to that, and the sort must never renumber them.
  const rows = [
    { rank: 1, memberId: 1, memberName: 'Alice', totalChests: 30, totalPoints: 300, might: 900, heroLevel: 55 },
    { rank: 2, memberId: 2, memberName: 'Bob', totalChests: 20, totalPoints: 200, might: null, heroLevel: null },
    { rank: 3, memberId: 3, memberName: 'Cara', totalChests: 10, totalPoints: 100, might: 1500, heroLevel: 40 },
  ];

  it('sorts by might descending with real readings first', () => {
    const out = sortLeaderboardEntries(rows, 'might', 'desc');
    expect(out.map((e: { memberName: string }) => e.memberName)).toEqual(['Cara', 'Alice', 'Bob']);
  });

  it('keeps never-captured members last even when sorting ascending', () => {
    // The regression this guards: treating null as -Infinity would open the
    // "lowest might first" view with a block of members who have no reading at
    // all, burying the smallest REAL number the sort was asked for.
    const out = sortLeaderboardEntries(rows, 'might', 'asc');
    expect(out.map((e: { memberName: string }) => e.memberName)).toEqual(['Alice', 'Cara', 'Bob']);
  });

  it('applies the same null-last rule to hero level', () => {
    expect(sortLeaderboardEntries(rows, 'level', 'asc')
      .map((e: { memberName: string }) => e.memberName)).toEqual(['Cara', 'Alice', 'Bob']);
    expect(sortLeaderboardEntries(rows, 'level', 'desc')
      .map((e: { memberName: string }) => e.memberName)).toEqual(['Alice', 'Cara', 'Bob']);
  });

  it('leaves rank untouched — it stays the server-side true rank', () => {
    const out = sortLeaderboardEntries(rows, 'might', 'desc');
    expect(out.map((e: { rank: number }) => e.rank)).toEqual([3, 1, 2]);
  });

  it('still sorts points and names as before', () => {
    expect(sortLeaderboardEntries(rows, 'points', 'asc')
      .map((e: { memberName: string }) => e.memberName)).toEqual(['Cara', 'Bob', 'Alice']);
    expect(sortLeaderboardEntries(rows, 'name', 'desc')
      .map((e: { memberName: string }) => e.memberName)).toEqual(['Cara', 'Bob', 'Alice']);
  });

  it('does not mutate the input array', () => {
    const before = rows.map((r) => r.memberName);
    sortLeaderboardEntries(rows, 'might', 'asc');
    expect(rows.map((r) => r.memberName)).toEqual(before);
  });
});

describe('formatMightCompact', () => {
  it('prints an em-dash for a member with no reading', () => {
    expect(formatMightCompact(null)).toBe('—');
    expect(formatMightCompact(undefined)).toBe('—');
  });

  it('is monotonic across the unit boundaries', () => {
    expect(formatMightCompact(850)).toBe('850');
    expect(formatMightCompact(12_400)).toBe('12k');
    expect(formatMightCompact(1_240_000)).toBe('1.2M');
    expect(formatMightCompact(12_400_000)).toBe('12M');
    expect(formatMightCompact(1_240_000_000)).toBe('1.2B');
  });
});
