import { describe, expect, it } from 'vitest';
import { closedWeekAt, daysBetweenGameDates, gameDateFor } from '../../src/utils/game-day.js';

/**
 * The game day is what keys a might snapshot, so getting the boundary wrong
 * doesn't just mislabel a row — it decides whether the once-a-day gate thinks
 * today has already been captured. These cases pin the 17:00 UTC reset.
 */
describe('gameDateFor', () => {
  const at = (iso: string) => gameDateFor(Date.parse(iso), 17);

  it('treats the hour before the reset as the previous game day', () => {
    expect(at('2026-07-30T16:59:59Z')).toBe('2026-07-29');
  });

  it('rolls over exactly at the reset hour', () => {
    expect(at('2026-07-30T17:00:00Z')).toBe('2026-07-30');
  });

  it('keeps the same game day through to the next reset', () => {
    expect(at('2026-07-30T23:59:59Z')).toBe('2026-07-30');
    expect(at('2026-07-31T00:00:00Z')).toBe('2026-07-30');
    expect(at('2026-07-31T16:59:59Z')).toBe('2026-07-30');
    expect(at('2026-07-31T17:00:00Z')).toBe('2026-07-31');
  });

  it('crosses month and year boundaries correctly', () => {
    expect(at('2026-08-01T16:00:00Z')).toBe('2026-07-31');
    expect(at('2027-01-01T10:00:00Z')).toBe('2026-12-31');
  });

  it('honours a different rollover hour', () => {
    expect(gameDateFor(Date.parse('2026-07-30T04:00:00Z'), 0)).toBe('2026-07-30');
    expect(gameDateFor(Date.parse('2026-07-30T04:00:00Z'), 6)).toBe('2026-07-29');
  });
});

/**
 * Sizes the resource capture's date backstop, so a wrong answer either lets a lost
 * cursor sweep the whole fortnight again or cuts a sweep off with rows still to read.
 */
describe('daysBetweenGameDates', () => {
  it('counts whole days forwards', () => {
    expect(daysBetweenGameDates('2026-08-03', '2026-08-04')).toBe(1);
    expect(daysBetweenGameDates('2026-08-04', '2026-08-04')).toBe(0);
    expect(daysBetweenGameDates('2026-07-25', '2026-08-04')).toBe(10);
  });

  it('crosses month and year boundaries', () => {
    expect(daysBetweenGameDates('2026-07-31', '2026-08-01')).toBe(1);
    expect(daysBetweenGameDates('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('goes negative when the stored date is in the future', () => {
    // The caller refuses to build a backstop from this rather than clamping it: a
    // cursor dated ahead of today means the clock or the rollover setting moved.
    expect(daysBetweenGameDates('2026-08-05', '2026-08-04')).toBe(-1);
  });

  it('returns null for anything that is not a date', () => {
    expect(daysBetweenGameDates('', '2026-08-04')).toBeNull();
    expect(daysBetweenGameDates('2026-08-04', '')).toBeNull();
    expect(daysBetweenGameDates('not-a-date', '2026-08-04')).toBeNull();
  });
});

/**
 * The Discord weekly digest fires on the rollover this says ends a week, and
 * reports the window it returns — so a Tinman clan must get its 6-day week on
 * the Tinman day, and nothing on a Sunday.
 */
describe('closedWeekAt', () => {
  const at = (iso: string, weekStart: 'sunday' | 'ancients') => closedWeekAt(Date.parse(iso), 17, weekStart);

  it('ends a Sunday week at the Sunday rollover', () => {
    expect(at('2026-10-25T17:00:00Z', 'sunday')).toEqual({
      from: '2026-10-18T17:00:00.000Z',
      to: '2026-10-25T17:00:00.000Z',
      firstDay: '2026-10-18',
      lastDay: '2026-10-24',
    });
  });

  it('ends nothing at a mid-week rollover', () => {
    expect(at('2026-10-24T17:00:00Z', 'sunday')).toBeNull();
    expect(at('2026-10-25T17:00:00Z', 'ancients')).toBeNull();
  });

  it('ends a 6-day Tinman week at each Tinman rollover', () => {
    expect(at('2026-10-23T17:00:00Z', 'ancients')).toEqual({
      from: '2026-10-17T17:00:00.000Z',
      to: '2026-10-23T17:00:00.000Z',
      firstDay: '2026-10-17',
      lastDay: '2026-10-22',
    });
    expect(at('2026-10-29T17:00:00Z', 'ancients')?.firstDay).toBe('2026-10-23');
    expect(at('2026-10-29T17:00:00Z', 'ancients')?.lastDay).toBe('2026-10-28');
  });

  it('needs the exact rollover instant, not a moment either side', () => {
    expect(at('2026-10-25T17:00:01Z', 'sunday')).toBeNull();
    expect(at('2026-10-25T16:59:59Z', 'sunday')).toBeNull();
  });
});
