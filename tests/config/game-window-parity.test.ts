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
  gameWindow, ANCIENTS_TINMAN_ANCHOR, ANCIENTS_CYCLE_DAYS, isTinmanDay, type WeekStart,
} from '../../src/utils/game-day.js';
// The frontend module is plain ESM with no DOM access at import time.
import {
  computeGameWindow, computeGameWindowDates, formatPeriodLabel,
  ANCIENTS_TINMAN_ANCHOR as CLIENT_ANCHOR, ANCIENTS_CYCLE_DAYS as CLIENT_CYCLE,
} from '../../src/web/public/lib/period.js';

const PERIODS = ['daily', 'weekly', 'monthly', 'yearly'];
const ROLLOVERS = [17, 0, 5, 23];
const WEEK_STARTS: WeekStart[] = ['sunday', 'ancients'];

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

  it('shares one Tinman anchor and cycle length', () => {
    expect(CLIENT_ANCHOR).toBe(ANCIENTS_TINMAN_ANCHOR);
    expect(CLIENT_CYCLE).toBe(ANCIENTS_CYCLE_DAYS);
    expect(isTinmanDay(ANCIENTS_TINMAN_ANCHOR)).toBe(true);
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
