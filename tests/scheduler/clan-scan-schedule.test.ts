import { describe, expect, it } from 'vitest';
import { resolveClanScanSchedule, type ClanScanScheduleInput } from '../../src/scheduler/clan-scan-schedule.js';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const HOUR = 60 * 60_000;
const DUE = { scanning: false, due: true, nextScanInMs: null };

function input(over: Partial<ClanScanScheduleInput>): ClanScanScheduleInput {
  return {
    clanId: 2,
    now: NOW,
    nextScanAt: NOW + HOUR,
    intervalMs: 2 * HOUR,
    cycleOrder: [],
    cycleDoneCount: 0,
    scanningClanId: null,
    ...over,
  };
}

describe('resolveClanScanSchedule', () => {
  it('between cycles: time remaining on the global timer', () => {
    expect(resolveClanScanSchedule(input({}))).toEqual({ scanning: false, due: false, nextScanInMs: HOUR });
  });

  it('a clan out of the rotation has no next scan', () => {
    expect(resolveClanScanSchedule(input({ nextScanAt: null })))
      .toEqual({ scanning: false, due: false, nextScanInMs: null });
  });

  // The flicker: "now" sent as a time read as a 1s countdown on a slow device
  // clock, ran out to "soon", re-polled, got "now" again — forever.
  it('a timer at or past now is DUE, never a zero/negative time to count down', () => {
    expect(resolveClanScanSchedule(input({ nextScanAt: NOW }))).toEqual(DUE);
    expect(resolveClanScanSchedule(input({ nextScanAt: NOW - 5_000 }))).toEqual(DUE);
  });

  it('the clan being scanned is scanning, whatever the timer says', () => {
    const r = resolveClanScanSchedule(input({
      cycleOrder: [1, 2, 3], cycleDoneCount: 1, scanningClanId: 2, nextScanAt: NOW - 5 * 60_000,
    }));
    expect(r).toEqual({ scanning: true, due: false, nextScanInMs: null });
  });

  it('a manual scan of one clan (no cycle) still reads as scanning', () => {
    expect(resolveClanScanSchedule(input({ scanningClanId: 2, nextScanAt: null })).scanning).toBe(true);
  });

  // Mid-cycle the global timer is the cycle's own start — in the past — so
  // read raw it would call every clan "due".
  it('mid-cycle, a clan still waiting its turn is due', () => {
    const r = resolveClanScanSchedule(input({
      cycleOrder: [1, 2, 3], cycleDoneCount: 0, scanningClanId: 1, nextScanAt: NOW - 5 * 60_000,
    }));
    expect(r).toEqual(DUE);
  });

  it('up next with its browser still launching (not scanning yet) is due, not "2h"', () => {
    const r = resolveClanScanSchedule(input({
      cycleOrder: [1, 2, 3], cycleDoneCount: 1, scanningClanId: null, nextScanAt: NOW - 5 * 60_000,
    }));
    expect(r).toEqual(DUE);
  });

  it('mid-cycle, a clan already done waits a full interval, not "due"', () => {
    const r = resolveClanScanSchedule(input({
      cycleOrder: [1, 2, 3], cycleDoneCount: 2, scanningClanId: 3, nextScanAt: NOW - 20 * 60_000,
    }));
    expect(r).toEqual({ scanning: false, due: false, nextScanInMs: 2 * HOUR });
  });

  it('after the last clan, until the next timer is armed, every clan is done', () => {
    const r = resolveClanScanSchedule(input({
      cycleOrder: [1, 2], cycleDoneCount: 2, scanningClanId: null, nextScanAt: NOW - 20 * 60_000,
    }));
    expect(r).toEqual({ scanning: false, due: false, nextScanInMs: 2 * HOUR });
  });

  it('a manual scan-all (global timer cleared) still places the clan in the cycle', () => {
    const r = resolveClanScanSchedule(input({
      cycleOrder: [1, 2], cycleDoneCount: 0, scanningClanId: 1, nextScanAt: null,
    }));
    expect(r).toEqual(DUE);
  });
});
