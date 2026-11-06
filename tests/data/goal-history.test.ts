import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { backfillGoalHistory, readGoalHistory, weekFirstDay, writeGoalStep } from '../../src/data/goal-history.js';
import { makeTestDb } from '../helpers/test-db.js';

const ROLLOVER = 17;
let cleanup: () => void;

beforeEach(() => {
  cleanup = makeTestDb().cleanup;
});
afterEach(() => cleanup());

const steps = (clanId = 1) => readGoalHistory(getDb(), clanId).map(({ from, weeklyPoints }) => ({ from, weeklyPoints }));

function addClan(id: number, weekStart: string, points: number | null): void {
  getDb().prepare(
    `INSERT INTO clans (id, name, slug, game_url, is_active, created_at, week_start, leaderboard_goal_enabled, leaderboard_weekly_goal_points)
     VALUES (?, ?, ?, 'https://totalbattle.com', 1, '2026-01-01T00:00:00Z', ?, 1, ?)`,
  ).run(id, `Clan ${id}`, `clan-${id}`, weekStart, points);
}

function auditGoalSave(at: string, details: object, viewingClanId = 1): void {
  getDb().prepare(
    `INSERT INTO audit_log (user_id, clan_id, action, details, created_at) VALUES (NULL, ?, 'clan.leaderboard_goal.update', ?, ?)`,
  ).run(viewingClanId, JSON.stringify(details), at);
}

describe('weekFirstDay', () => {
  it('is the first game day of the clan week holding the instant', () => {
    // Thu Nov 5 2026, 18:00 UTC: game day Nov 5; the Sunday week began Nov 1.
    expect(weekFirstDay(Date.parse('2026-11-05T18:00:00Z'), ROLLOVER, 'sunday')).toBe('2026-11-01');
    // Sun Nov 1 before the rollover is still game day Oct 31, in the week of Oct 25.
    expect(weekFirstDay(Date.parse('2026-11-01T16:59:00Z'), ROLLOVER, 'sunday')).toBe('2026-10-25');
    // Tinman to Tinman: Nov 4 is a Tinman day.
    expect(weekFirstDay(Date.parse('2026-11-04T19:23:55Z'), ROLLOVER, 'ancients')).toBe('2026-11-04');
  });
});

describe('writeGoalStep', () => {
  it('replaces a second change in the same week and drops a repeat of the step before', () => {
    writeGoalStep(getDb(), 1, '2026-10-04', 30_000, 'a');
    writeGoalStep(getDb(), 1, '2026-10-11', 35_000, 'b');
    writeGoalStep(getDb(), 1, '2026-10-11', 32_000, 'c');
    expect(steps()).toEqual([
      { from: '2026-10-04', weeklyPoints: 30_000 },
      { from: '2026-10-11', weeklyPoints: 32_000 },
    ]);
    // Set back to what it was: the week needs no step of its own.
    writeGoalStep(getDb(), 1, '2026-10-11', 30_000, 'd');
    expect(steps()).toEqual([{ from: '2026-10-04', weeklyPoints: 30_000 }]);
    // Switching the colours off and on again re-saves the same number.
    writeGoalStep(getDb(), 1, '2026-10-18', 30_000, 'e');
    expect(steps()).toEqual([{ from: '2026-10-04', weeklyPoints: 30_000 }]);
  });

  it('records a change to the amber percent alone as a step of its own', () => {
    writeGoalStep(getDb(), 1, '2026-10-04', 30_000, 'a');
    writeGoalStep(getDb(), 1, '2026-10-11', 30_000, 'b', 80);
    writeGoalStep(getDb(), 1, '2026-10-18', 30_000, 'c', 80);
    expect(readGoalHistory(getDb(), 1).map(({ from, amberPct }) => ({ from, amberPct }))).toEqual([
      { from: '2026-10-04', amberPct: null },
      { from: '2026-10-11', amberPct: 80 },
    ]);
  });
});

describe('backfillGoalHistory (migration v93)', () => {
  it('rebuilds each clan’s goal from the audit log, by the clan in the details', () => {
    getDb().prepare('DELETE FROM clan_goal_history').run();
    getDb().prepare('UPDATE clans SET leaderboard_goal_enabled = 1, leaderboard_weekly_goal_points = 35000 WHERE id = 1').run();
    addClan(3, 'ancients', 35_000);
    auditGoalSave('2026-08-20T19:24:03Z', { clanId: 1, enabled: true, weeklyPoints: 25_000 });
    auditGoalSave('2026-09-13T21:11:01Z', { clanId: 1, enabled: true, weeklyPoints: 30_000 });
    auditGoalSave('2026-10-06T00:29:05Z', { clanId: 1, enabled: true, weeklyPoints: 35_000 });
    // A superadmin viewing clan 1 while editing clan 3.
    auditGoalSave('2026-10-21T00:13:42Z', { clanId: 3, enabled: true, weeklyPoints: 30_000 }, 1);
    auditGoalSave('2026-11-04T19:23:55Z', { clanId: 3, enabled: true, weeklyPoints: 35_000 }, 1);

    backfillGoalHistory(getDb(), ROLLOVER, Date.parse('2026-11-06T12:00:00Z'));

    expect(steps(1)).toEqual([
      { from: '2026-08-16', weeklyPoints: 25_000 },
      { from: '2026-09-13', weeklyPoints: 30_000 },
      // Oct 6 00:29 UTC is still game day Oct 5, in the week of Oct 4.
      { from: '2026-10-04', weeklyPoints: 35_000 },
    ]);
    expect(steps(3)).toEqual([
      { from: '2026-10-17', weeklyPoints: 30_000 },
      { from: '2026-11-04', weeklyPoints: 35_000 },
    ]);
  });

  it('gives a goal the audit log never saw one step for the week in progress', () => {
    getDb().prepare('DELETE FROM clan_goal_history').run();
    addClan(2, 'sunday', 12_000);
    backfillGoalHistory(getDb(), ROLLOVER, Date.parse('2026-11-06T12:00:00Z'));
    expect(steps(2)).toEqual([{ from: '2026-11-01', weeklyPoints: 12_000 }]);
  });
});
