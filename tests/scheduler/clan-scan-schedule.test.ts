import { describe, expect, it } from 'vitest';
import { resolveClanScanSchedule, type ClanScanScheduleInput } from '../../src/scheduler/clan-scan-schedule.js';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const HOUR = 60 * 60_000;

function input(over: Partial<ClanScanScheduleInput>): ClanScanScheduleInput {
  return {
    clanId: 2,
    now: NOW,
    nextScanAt: NOW + HOUR,
    intervalMs: 2 * HOUR,
    cycleOrder: [],
    cycleCursor: -1,
    scanningClanId: null,
    ...over,
  };
}

describe('resolveClanScanSchedule', () => {
  it('between cycles: the global timer, as is', () => {
    expect(resolveClanScanSchedule(input({}))).toEqual({ scanning: false, nextScanAt: NOW + HOUR });
  });

  it('a clan out of the rotation has no next scan', () => {
    expect(resolveClanScanSchedule(input({ nextScanAt: null }))).toEqual({ scanning: false, nextScanAt: null });
  });

  it('the clan being scanned is scanning, whatever the timer says', () => {
    const r = resolveClanScanSchedule(input({
      cycleOrder: [1, 2, 3], cycleCursor: 1, scanningClanId: 2, nextScanAt: NOW - 5 * 60_000,
    }));
    expect(r).toEqual({ scanning: true, nextScanAt: null });
  });

  it('a manual scan of one clan (no cycle) still reads as scanning', () => {
    expect(resolveClanScanSchedule(input({ scanningClanId: 2, nextScanAt: null })).scanning).toBe(true);
  });

  // Mid-cycle the global timer is the cycle's own start — in the past — so
  // read raw it would call every clan "due now".
  it('mid-cycle, a clan still waiting its turn is due now', () => {
    const r = resolveClanScanSchedule(input({
      cycleOrder: [1, 2, 3], cycleCursor: 0, scanningClanId: 1, nextScanAt: NOW - 5 * 60_000,
    }));
    expect(r).toEqual({ scanning: false, nextScanAt: NOW });
  });

  it('mid-cycle, a clan already scanned waits a full interval, not "now"', () => {
    const r = resolveClanScanSchedule(input({
      cycleOrder: [1, 2, 3], cycleCursor: 2, scanningClanId: 3, nextScanAt: NOW - 20 * 60_000,
    }));
    expect(r).toEqual({ scanning: false, nextScanAt: NOW + 2 * HOUR });
  });

  it('its own post-scan phases (cursor on it, not scanning) count as done', () => {
    const r = resolveClanScanSchedule(input({
      cycleOrder: [1, 2], cycleCursor: 1, scanningClanId: null, nextScanAt: NOW - 20 * 60_000,
    }));
    expect(r).toEqual({ scanning: false, nextScanAt: NOW + 2 * HOUR });
  });

  it('a manual scan-all (global timer cleared) still places the clan in the cycle', () => {
    const r = resolveClanScanSchedule(input({
      cycleOrder: [1, 2], cycleCursor: 0, scanningClanId: 1, nextScanAt: null,
    }));
    expect(r).toEqual({ scanning: false, nextScanAt: NOW });
  });
});
