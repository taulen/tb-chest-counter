/**
 * The server's game windows must be the client's game windows.
 *
 * Three definitions of "a week" had grown up in this codebase: lib/period.js
 * for the site, chesttracker-client.ts for the import, and a bare
 * `now - 604800000` in the Discord bot. The last one meant the bot's weekly
 * leaderboard was a rolling 168 hours — a different board from the one the
 * same command linked people to, differing by a bit more every hour, with
 * nothing anywhere to notice.
 *
 * utils/game-day.ts's gameWindow() mirrors web/public/lib/period.js's
 * computeGameWindow() branch for branch. This asserts they agree, so changing
 * one without the other fails the build rather than quietly forking the
 * definition of a week again.
 *
 * Pure — reads no database and starts no server — so it runs in npm run guards.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  gameWindow, ANCIENTS_TINMAN_ANCHOR, ANCIENTS_CYCLE_DAYS, SK_TINMAN_ANCHOR, SK_CYCLE_DAYS,
  CUSTOM_WEEK_MIN_DAYS, CUSTOM_WEEK_MAX_DAYS, SUNDAY_ANCHOR,
  canonicalWeekStart, isTinmanDay, isWeekStart, parseCustomWeek, weekLengthDays,
  WEEK_PRESETS, type WeekStart,
} from '../../src/utils/game-day.js';
// The frontend module is plain ESM with no DOM access at import time.
import {
  computeGameWindow, computeGameWindowDates, formatPeriodLabel, gameWeekStartOf,
  isWeekStart as clientIsWeekStart, weekLengthDays as clientWeekLengthDays,
  parseCustomWeek as clientParseCustomWeek,
  ANCIENTS_TINMAN_ANCHOR as CLIENT_ANCHOR, ANCIENTS_CYCLE_DAYS as CLIENT_CYCLE,
  SK_TINMAN_ANCHOR as CLIENT_SK_ANCHOR, SK_CYCLE_DAYS as CLIENT_SK_CYCLE,
  CUSTOM_WEEK_MIN_DAYS as CLIENT_MIN_DAYS, CUSTOM_WEEK_MAX_DAYS as CLIENT_MAX_DAYS,
} from '../../src/web/public/lib/period.js';
import { SUNDAY_ANCHOR as CLIENT_SUNDAY_ANCHOR } from '../../src/web/public/lib/week-shape.js';

const PERIODS = ['daily', 'weekly', 'monthly', 'yearly'];
const ROLLOVERS = [17, 0, 5, 23];
// The presets, plus custom weeks of every awkward kind: the Tuesday week a
// clan actually asked for, lengths that drift through the weekdays, the
// shortest and longest allowed, and first days in the past and the future.
const WEEK_STARTS: WeekStart[] = [
  'sunday', 'ancients', 'ancients-sk',
  'custom:2026-11-17:7', 'custom:2026-10-01:10', 'custom:2026-12-31:2',
  'custom:2025-01-15:28', 'custom:2026-11-19:14',
];

describe('server game windows match the client', () => {
  afterEach(() => vi.useRealTimers());

  it('agrees on every period, offset, rollover hour and week shape', () => {
    const mismatches: string[] = [];
    // Sweep "now" across two full cycles so every day-of-week and every day of
    // the Tinman cycle is exercised, not just whatever today happens to be.
    for (let day = 0; day < 14; day += 1) {
      vi.useFakeTimers({ now: Date.parse('2026-10-20T12:00:00Z') + day * 86_400_000 });
      for (const weekStart of WEEK_STARTS) {
        for (const rollover of ROLLOVERS) {
          for (const period of PERIODS) {
            for (const offset of [0, 1, 2, 5]) {
              const server = gameWindow(period, offset, rollover, weekStart);
              const client = computeGameWindow(period, offset, rollover, weekStart);
              if (server?.from !== client?.from || server?.to !== client?.to) {
                mismatches.push(
                  `day ${day} ${weekStart} ${period}/+${offset}/rollover ${rollover}: `
                  + `server ${server?.from}..${server?.to} vs client ${client?.from}..${client?.to}`,
                );
              }
            }
          }
        }
      }
    }
    expect(mismatches, mismatches.slice(0, 20).join('\n')).toEqual([]);
  });

  it('shares one Tinman anchor and cycle length per kingdom', () => {
    expect(CLIENT_ANCHOR).toBe(ANCIENTS_TINMAN_ANCHOR);
    expect(CLIENT_CYCLE).toBe(ANCIENTS_CYCLE_DAYS);
    expect(isTinmanDay(ANCIENTS_TINMAN_ANCHOR)).toBe(true);
    expect(CLIENT_SK_ANCHOR).toBe(SK_TINMAN_ANCHOR);
    expect(CLIENT_SK_CYCLE).toBe(SK_CYCLE_DAYS);
    expect(isTinmanDay(SK_TINMAN_ANCHOR, 'ancients-sk')).toBe(true);
  });

  it('knows the same week shapes, of the same lengths', () => {
    // A shape the client didn't know would fall back to the viewed clan's own
    // week and silently cut a different window from the server's.
    for (const weekStart of WEEK_STARTS) {
      expect(isWeekStart(weekStart), weekStart).toBe(true);
      expect(clientIsWeekStart(weekStart), weekStart).toBe(true);
      expect(clientWeekLengthDays(weekStart), weekStart).toBe(weekLengthDays(weekStart));
    }
    expect([...WEEK_PRESETS].sort()).toEqual(WEEK_STARTS.filter((w) => !w.startsWith('custom:')).sort());
    expect(CLIENT_MIN_DAYS).toBe(CUSTOM_WEEK_MIN_DAYS);
    expect(CLIENT_MAX_DAYS).toBe(CUSTOM_WEEK_MAX_DAYS);
    expect(CLIENT_SUNDAY_ANCHOR).toBe(SUNDAY_ANCHOR);
    expect(new Date(`${SUNDAY_ANCHOR}T00:00:00Z`).getUTCDay()).toBe(0);
  });

  it('agrees on which strings are custom weeks, and refuses malformed ones', () => {
    const good = ['custom:2026-11-17:7', `custom:2026-02-28:${CUSTOM_WEEK_MIN_DAYS}`, `custom:2024-02-29:${CUSTOM_WEEK_MAX_DAYS}`];
    const bad = [
      'custom:2026-02-29:7', // not a date (2026 isn't a leap year)
      'custom:2026-11-31:7',
      'custom:2026-11-17:07', // one spelling per week
      `custom:2026-11-17:${CUSTOM_WEEK_MIN_DAYS - 1}`,
      `custom:2026-11-17:${CUSTOM_WEEK_MAX_DAYS + 1}`,
      'custom:2026-11-17:7.5', 'custom:2026-11-17', 'custom:2026-11-17:', 'custom::7',
      'custom:26-11-17:7', ' custom:2026-11-17:7', 'custom:2026-11-17:7 ', 'monday', '', null, 7,
    ];
    for (const v of good) {
      expect(parseCustomWeek(v), String(v)).not.toBeNull();
      expect(clientParseCustomWeek(v), String(v)).toEqual(parseCustomWeek(v));
    }
    for (const v of bad) {
      expect(isWeekStart(v), String(v)).toBe(false);
      expect(clientIsWeekStart(v), String(v)).toBe(false);
    }
  });

  it('cuts a custom Tuesday week from Tuesday evening to Tuesday evening', () => {
    // The week that prompted custom weeks: 7 days from Tuesday at the 17:00
    // UTC reset. 2026-11-20 is a Friday, inside the week that opened on
    // Tuesday 2026-11-17 17:00 UTC.
    const tuesday: WeekStart = 'custom:2026-11-17:7';
    vi.useFakeTimers({ now: Date.parse('2026-11-20T12:00:00Z') });
    expect(gameWindow('weekly', 0, 17, tuesday)).toEqual({
      from: '2026-11-17T17:00:00.000Z', to: '2026-11-24T17:00:00.000Z',
    });
    expect(formatPeriodLabel('weekly', 0, 17, tuesday)).toBe('2026-11-17 → 2026-11-23');
    expect(gameWindow('weekly', 1, 17, tuesday)!.from).toBe('2026-11-10T17:00:00.000Z');
    // A first day picked in the future names the same cadence.
    expect(gameWindow('weekly', 0, 17, 'custom:2027-03-02:7')).toEqual(gameWindow('weekly', 0, 17, tuesday));
    // One second before Tuesday's reset is still the old week; the reset opens the new one.
    vi.setSystemTime(Date.parse('2026-11-24T16:59:59Z'));
    expect(gameWindow('weekly', 0, 17, tuesday)!.from).toBe('2026-11-17T17:00:00.000Z');
    vi.setSystemTime(Date.parse('2026-11-24T17:00:00Z'));
    expect(gameWindow('weekly', 0, 17, tuesday)!.from).toBe('2026-11-24T17:00:00.000Z');
  });

  it('stores a custom week identical to a preset as the preset', () => {
    expect(canonicalWeekStart('custom:2026-11-15:7', false)).toBe('sunday'); // a Sunday
    expect(canonicalWeekStart('custom:1969-12-28:7', true)).toBe('sunday');
    expect(canonicalWeekStart('custom:2026-11-17:7', false)).toBe('custom:2026-11-17:7'); // a Tuesday
    // 6 days from a Tinman day is the Tinman week — in a normal kingdom only.
    expect(canonicalWeekStart('custom:2026-10-29:6', false)).toBe('ancients');
    expect(canonicalWeekStart('custom:2026-10-29:6', true)).toBe('custom:2026-10-29:6');
    expect(canonicalWeekStart('custom:2026-10-30:6', false)).toBe('custom:2026-10-30:6');
    // 5 days from an SK Tinman day is the SK Tinman week — for an SK clan only.
    expect(canonicalWeekStart('custom:2026-11-22:5', true)).toBe('ancients-sk');
    expect(canonicalWeekStart('custom:2026-11-22:5', false)).toBe('custom:2026-11-22:5');
    expect(canonicalWeekStart('ancients', false)).toBe('ancients');
  });

  it('cuts a Seasonal Kingdom Tinman week on the SK cadence', () => {
    // SK 2026: Tinman 2026-11-17, then every 5 days (Nov 22, 27, …).
    vi.useFakeTimers({ now: Date.parse('2026-11-20T12:00:00Z') });
    expect(gameWindow('weekly', 0, 17, 'ancients-sk')).toEqual({
      from: '2026-11-17T17:00:00.000Z', to: '2026-11-22T17:00:00.000Z',
    });
    expect(formatPeriodLabel('weekly', 0, 17, 'ancients-sk')).toBe('2026-11-17 → 2026-11-21');
    expect(gameWindow('weekly', 1, 17, 'ancients-sk')!.from).toBe('2026-11-12T17:00:00.000Z');
    vi.setSystemTime(Date.parse('2026-11-22T17:00:00Z'));
    expect(gameWindow('weekly', 0, 17, 'ancients-sk')!.from).toBe('2026-11-22T17:00:00.000Z');
    expect(isTinmanDay('2026-11-27', 'ancients-sk')).toBe(true);
    expect(isTinmanDay('2027-02-05', 'ancients-sk')).toBe(true); // the season's last
    expect(isTinmanDay('2026-11-23', 'ancients-sk')).toBe(false);
  });

  it('cuts a Tinman week from one Tinman start to the next', () => {
    // 2026-10-22 18:30 UTC: Ancients day 1 (Ancients' Treasure) is in
    // progress, Tinman starts 2026-10-23 17:00 UTC. The week in progress is
    // therefore the one that opened at the previous Tinman, and the next one
    // runs 2026-10-23 17:00 → 2026-10-29 17:00.
    vi.useFakeTimers({ now: Date.parse('2026-10-22T18:30:00Z') });
    expect(gameWindow('weekly', 0, 17, 'ancients')).toEqual({
      from: '2026-10-17T17:00:00.000Z', to: '2026-10-23T17:00:00.000Z',
    });
    vi.setSystemTime(Date.parse('2026-10-23T17:00:00Z'));
    expect(gameWindow('weekly', 0, 17, 'ancients')).toEqual({
      from: '2026-10-23T17:00:00.000Z', to: '2026-10-29T17:00:00.000Z',
    });
    expect(computeGameWindowDates('weekly', 0, 17, 'ancients')).toEqual({
      from: '2026-10-23', to: '2026-10-28',
    });
    expect(formatPeriodLabel('weekly', 0, 17, 'ancients')).toBe('2026-10-23 → 2026-10-28');
    // One second before the next Tinman is still the same week.
    vi.setSystemTime(Date.parse('2026-10-29T16:59:59Z'));
    expect(gameWindow('weekly', 0, 17, 'ancients')!.from).toBe('2026-10-23T17:00:00.000Z');
  });

  it('keeps Sunday weeks unchanged by default', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-22T18:30:00Z') });
    expect(gameWindow('weekly', 0, 17)).toEqual({
      from: '2026-10-18T17:00:00.000Z', to: '2026-10-25T17:00:00.000Z',
    });
  });

  it('buckets a game day into the week the Weekly period puts it in', () => {
    // Weekly bars on Resources and the member sparkline bucket date-only rows
    // with gameWeekStartOf; a bar must cut exactly where the Weekly window does.
    for (let day = 0; day < 14; day += 1) {
      vi.useFakeTimers({ now: Date.parse('2026-10-20T18:00:00Z') + day * 86_400_000 });
      for (const weekStart of WEEK_STARTS) {
        const today = new Date(computeGameWindowDates('daily', 0, 17, weekStart)!.from + 'T00:00:00Z');
        expect(
          gameWeekStartOf(today, weekStart).toISOString().slice(0, 10),
          `day ${day} ${weekStart}`,
        ).toBe(computeGameWindowDates('weekly', 0, 17, weekStart)!.from);
      }
    }
  });

  it('returns null for all time on both sides', () => {
    expect(gameWindow('all', 0, 17)).toBeNull();
    expect(computeGameWindow('all', 0, 17)).toBeNull();
  });

  it('produces half-open windows that abut exactly', () => {
    // The property every per-period total depends on: adjacent slots share an
    // instant, and it belongs to the later one.
    for (const weekStart of WEEK_STARTS) {
      for (const period of PERIODS) {
        const cur = gameWindow(period, 0, 17, weekStart)!;
        const prev = gameWindow(period, 1, 17, weekStart)!;
        expect(prev.to, `${weekStart} ${period}`).toBe(cur.from);
      }
    }
  });

  it('puts now inside the current slot for every period', () => {
    for (const weekStart of WEEK_STARTS) {
      for (const period of PERIODS) {
        const w = gameWindow(period, 0, 17, weekStart)!;
        expect(Date.parse(w.from), `${weekStart} ${period}`).toBeLessThanOrEqual(Date.now());
        expect(Date.parse(w.to), `${weekStart} ${period}`).toBeGreaterThan(Date.now());
      }
    }
  });
});
