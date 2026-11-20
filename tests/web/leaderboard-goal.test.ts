import { describe, expect, it } from 'vitest';
import {
  formatMightCompact,
  goalKeyText,
  goalRowClassFor,
  goalStatusClassFor,
  goalStatusFor,
  leaderboardCopyText,
  paceFractionForWindow,
  pacePointsFor,
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

  it('prices a Tinman-to-Tinman week at 6 days', () => {
    // Same weekly goal, shorter week: the daily rate is goal / 6, and every
    // other timeframe scales from that rate.
    expect(scaleGoalForPeriod(24_000, 'weekly', 'ancients')).toBe(24_000);
    expect(scaleGoalForPeriod(24_000, 'daily', 'ancients')).toBe(4_000);
    expect(scaleGoalForPeriod(24_000, 'monthly', 'ancients')).toBe(120_000);
    expect(scaleGoalForPeriod(24_000, 'daily', 'sunday')).toBe(3_429);
  });
});

// A ratio judge: Tin Man's per-summon targets, which have no clock.
describe('goalStatusClassFor against a fixed target', () => {
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
 * The points goal (Nov 20 2026): amber means ON PACE — at or past the share of
 * the goal the time gone so far asks for — not a fixed percent of it. The
 * Members board, the share board, Analytics and the profile all judge through
 * these, so the pace mark here is the tick on the board's bars.
 */
describe('the pace judge', () => {
  it('puts the pace mark at the goal times the share of the window gone', () => {
    expect(pacePointsFor(35_000, 0.5)).toBe(17_500);
    expect(pacePointsFor(35_000, 0)).toBe(0);
    expect(pacePointsFor(1073, 1 / 3)).toBe(358); // rounded like every board figure
  });

  it('has no pace mark once the window has ended, or without a goal', () => {
    expect(pacePointsFor(35_000, 1)).toBeNull();
    expect(pacePointsFor(35_000, null)).toBeNull();
    expect(pacePointsFor(null, 0.5)).toBeNull();
    expect(pacePointsFor(0, 0.5)).toBeNull();
  });

  it('measures the share of a window on the window itself', () => {
    const win = { from: '2026-11-15T17:00:00.000Z', to: '2026-11-22T17:00:00.000Z' };
    const from = Date.parse(win.from);
    expect(paceFractionForWindow(win, from)).toBe(0);
    expect(paceFractionForWindow(win, from + 3.5 * 86_400_000)).toBeCloseTo(0.5);
    // Ended, not started, or no window (All Time): no pace.
    expect(paceFractionForWindow(win, Date.parse(win.to))).toBeNull();
    expect(paceFractionForWindow(win, from - 1)).toBeNull();
    expect(paceFractionForWindow(null)).toBeNull();
  });

  it('is green at the goal, amber on pace, red behind it while the window runs', () => {
    const judge = { pace: 17_500 };
    expect(goalStatusFor(35_000, 35_000, judge)).toBe('ok');
    expect(goalStatusFor(17_500, 35_000, judge)).toBe('pace');
    expect(goalStatusFor(34_999, 35_000, judge)).toBe('pace');
    expect(goalStatusFor(17_499, 35_000, judge)).toBe('behind');
    expect(goalStatusClassFor(20_000, 35_000, judge)).toBe('goal-cell-warn');
    expect(goalRowClassFor(1_000, 35_000, judge)).toBe('goal-row-low');
  });

  it('is only green or red once the window has ended', () => {
    const judge = { pace: null };
    expect(goalStatusFor(35_000, 35_000, judge)).toBe('ok');
    // 99% of the goal used to be amber ("close to goal"); a finished week has no pace left.
    expect(goalStatusFor(34_650, 35_000, judge)).toBe('low');
    expect(goalStatusClassFor(34_650, 35_000, judge)).toBe('goal-cell-low');
  });

  it('keys the colours for the window on screen', () => {
    expect(goalKeyText(null)).toBe('✓ green at the goal · ↓ red below');
    expect(goalKeyText(17_500)).toBe(`✓ green at the goal · ◐ amber on pace (${(17_500).toLocaleString()} by now) · ↓ red behind`);
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

describe('leaderboardCopyText', () => {
  const entries = [
    { rank: 1, memberName: 'Alice', totalChests: 1200, totalPoints: 30000, might: 5e8, heroLevel: 90, guardsLevel: 7 },
    { rank: 2, memberName: 'Bob', totalChests: 80, totalPoints: 18000, might: null, heroLevel: null, guardsLevel: null },
    { rank: 3, memberName: 'Cara', totalChests: 5, totalPoints: 900, might: null, heroLevel: null, guardsLevel: null },
  ];
  // Numbers go through toLocaleString like the page's, so the grouping
  // separator is the machine's ("1,200" or "1 200") — same width either way.
  const n = (x: number) => x.toLocaleString();

  it('lists every player with rank, chests, points and goal status, no padding', () => {
    // An ended window: reached or below, no pace left.
    const lines = leaderboardCopyText({ entries, period: 'weekly', offset: 0, rolloverHr: 17, goalWeeklyPoints: 25_000 }).split('\n');
    expect(lines[0]).toMatch(/^Leaderboard · Weekly · \d{4}-\d{2}-\d{2} - \d{4}-\d{2}-\d{2}$/);
    expect(lines[1]).toBe(`Weekly goal: ${n(25_000)} points`);
    expect(lines.slice(2)).toEqual([
      'Rank Player - Chests - Points - Status',
      `#1 Alice - ${n(1200)} - ${n(30000)} - ● Goal reached`,
      `#2 Bob - 80 - ${n(18000)} - ○ Below goal`,
      '#3 Cara - 5 - 900 - ○ Below goal',
    ]);
  });

  it('says on pace / behind pace while the window runs', () => {
    // Half the week gone: the pace mark is 12,500.
    const lines = leaderboardCopyText({ entries, period: 'weekly', offset: 0, rolloverHr: 17, goalWeeklyPoints: 25_000, paceFraction: 0.5 }).split('\n');
    expect(lines.slice(4)).toEqual([
      `#2 Bob - 80 - ${n(18000)} - ◐ On pace`,
      '#3 Cara - 5 - 900 - ○ Behind pace',
    ]);
  });

  it('uses only marks the in-game chat font can draw (no ✓ or ↓)', () => {
    const text = leaderboardCopyText({ entries, period: 'weekly', offset: 0, rolloverHr: 17, goalWeeklyPoints: 25_000 });
    expect(text).not.toMatch(/[✓↓→]/);
  });

  it('leaves out level, might and guards', () => {
    const text = leaderboardCopyText({ entries, period: 'weekly', offset: 0, rolloverHr: 17, goalWeeklyPoints: 25_000 });
    expect(text).not.toMatch(/Might|Level|Guards/);
    expect(text).not.toContain(n(5e8));
  });

  it('drops the goal line and status column when there is no goal', () => {
    const lines = leaderboardCopyText({ entries, period: 'all', offset: 0, rolloverHr: 17, goalWeeklyPoints: null }).split('\n');
    expect(lines[0]).toBe('Leaderboard · All Time');
    expect(lines[1]).toBe('Rank Player - Chests - Points');
    expect(lines[2]).toBe(`#1 Alice - ${n(1200)} - ${n(30000)}`);
  });
});
