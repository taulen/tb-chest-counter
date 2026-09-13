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

import { describe, it, expect } from 'vitest';
import { gameWindow } from '../../src/utils/game-day.js';
// The frontend module is plain ESM with no DOM access at import time.
import { computeGameWindow } from '../../src/web/public/lib/period.js';

const PERIODS = ['daily', 'weekly', 'monthly', 'yearly'];
const ROLLOVERS = [17, 0, 5, 23];

describe('server game windows match the client', () => {
  it('agrees on every period, offset and rollover hour', () => {
    const mismatches: string[] = [];
    for (const rollover of ROLLOVERS) {
      for (const period of PERIODS) {
        for (const offset of [0, 1, 2, 5]) {
          const server = gameWindow(period, offset, rollover);
          const client = computeGameWindow(period, offset, rollover);
          if (server?.from !== client?.from || server?.to !== client?.to) {
            mismatches.push(
              `${period}/+${offset}/rollover ${rollover}: `
              + `server ${server?.from}..${server?.to} vs client ${client?.from}..${client?.to}`,
            );
          }
        }
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('returns null for all time on both sides', () => {
    expect(gameWindow('all', 0, 17)).toBeNull();
    expect(computeGameWindow('all', 0, 17)).toBeNull();
  });

  it('produces half-open windows that abut exactly', () => {
    // The property every per-period total depends on: adjacent slots share an
    // instant, and it belongs to the later one.
    for (const period of PERIODS) {
      const cur = gameWindow(period, 0, 17)!;
      const prev = gameWindow(period, 1, 17)!;
      expect(prev.to, period).toBe(cur.from);
    }
  });

  it('puts now inside the current slot for every period', () => {
    for (const period of PERIODS) {
      const w = gameWindow(period, 0, 17)!;
      expect(Date.parse(w.from), period).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(w.to), period).toBeGreaterThan(Date.now());
    }
  });
});
