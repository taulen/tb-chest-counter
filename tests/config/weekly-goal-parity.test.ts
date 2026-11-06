/**
 * The weekly goal over time must read the same on the server and in the
 * browser.
 *
 * utils/weekly-goal.ts (Performance page, Discord /me) and
 * web/public/lib/weekly-goal.js (Leaderboard, share page, Analytics, profile)
 * both decide which goal a past window was played under. If they drifted, the
 * Performance page could call a week a miss that the Leaderboard showed green.
 *
 * Pure — reads no database and starts no server — so it runs in npm run guards.
 */
import { describe, it, expect } from 'vitest';
import * as server from '../../src/utils/weekly-goal.js';
// Plain ESM; its only import (lib/period.js) touches no DOM at import time.
import * as client from '../../src/web/public/lib/weekly-goal.js';

const HISTORY: server.WeeklyGoalStep[] = [
  { from: '2026-08-16', weeklyPoints: 25_000 },
  { from: '2026-09-13', weeklyPoints: 30_000 },
  { from: '2026-10-04', weeklyPoints: null },
  { from: '2026-10-11', weeklyPoints: 35_000 },
];

const DAYS = ['2026-01-01', '2026-08-15', '2026-08-16', '2026-09-12', '2026-09-13', '2026-10-04', '2026-10-10', '2026-10-11', '2027-01-01'];
const RANGES: Array<[string, string]> = [
  ['2026-08-16', '2026-08-22'],
  ['2026-09-01', '2026-09-30'],
  ['2026-10-01', '2026-10-31'],
  ['2026-10-04', '2026-10-10'],
  ['2026-01-01', '2026-12-31'],
];

describe('weekly goal history: server and client agree', () => {
  it('on the goal in force on any day', () => {
    for (const day of DAYS) {
      expect(client.weeklyGoalOn(HISTORY, day), day).toBe(server.weeklyGoalOn(HISTORY, day));
    }
  });

  it('on the blended goal of any window', () => {
    for (const [from, to] of RANGES) {
      expect(client.meanWeeklyGoal(HISTORY, from, to), `${from}..${to}`)
        .toBe(server.meanWeeklyGoal(HISTORY, from, to));
      for (const current of [null, 35_000]) {
        expect(client.weeklyGoalForDays(current, HISTORY, from, to))
          .toBe(server.weeklyGoalForDays(current, HISTORY, from, to));
      }
    }
  });
});

describe('weekly goal history', () => {
  it('keeps a finished week on the goal it was played under', () => {
    expect(server.weeklyGoalOn(HISTORY, '2026-09-12')).toBe(25_000);
    expect(server.weeklyGoalOn(HISTORY, '2026-09-13')).toBe(30_000);
    expect(server.weeklyGoalOn(HISTORY, '2026-10-12')).toBe(35_000);
  });

  it('holds weeks before the first recorded change to the first goal', () => {
    expect(server.weeklyGoalOn(HISTORY, '2026-01-01')).toBe(25_000);
  });

  it('has no goal for a week the goal was cleared', () => {
    expect(server.meanWeeklyGoal(HISTORY, '2026-10-04', '2026-10-10')).toBeNull();
  });

  it('blends a window that straddles a raise by its days', () => {
    // Sep 1–12 at 25,000 (12 days), Sep 13–30 at 30,000 (18 days).
    expect(server.meanWeeklyGoal(HISTORY, '2026-09-01', '2026-09-30'))
      .toBe(Math.round((12 * 25_000 + 18 * 30_000) / 30));
  });

  it('is off entirely when the clan has no goal now, and is today’s number without history', () => {
    expect(server.weeklyGoalForDays(null, HISTORY, '2026-09-13', '2026-09-19')).toBeNull();
    expect(server.weeklyGoalForDays(35_000, [], '2026-09-13', '2026-09-19')).toBe(35_000);
  });
});
