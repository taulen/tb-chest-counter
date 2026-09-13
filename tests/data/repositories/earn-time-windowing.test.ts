import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import { getLeaderboard } from '../../../src/data/repositories/chest-repo.js';
import { getSingleDayRecords, notifyChestDataChanged } from '../../../src/data/repositories/chest-summary-repo.js';
import { makeTestDb } from '../../helpers/test-db.js';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

// The game day rolls over at 17:00 UTC (default). A chest earned at 16:00 UTC
// on Jul 16 belongs to game-day Jul 15; if it's only claimed by a scan at
// 18:00 UTC (game-day Jul 16), scan-time attribution would misfile it. These
// tests prove leaderboard windowing AND the daily-summary rollup now key on
// earn time (effective_at), not scan time.
function seed(): { member: number } {
  const db = getDb();
  const member = (
    db
      .prepare(
        `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
         VALUES (1, 'Fira', 'fira', ?, ?, 1) RETURNING id`,
      )
      .get('2026-07-15T00:00:00.000Z', '2026-07-16T00:00:00.000Z') as { id: number }
  ).id;
  const chestId = (
    db
      .prepare(
        `INSERT INTO chests (name, chest_type) VALUES ('Runic Chest', 'common')
         ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
      )
      .get() as { id: number }
  ).id;
  const session = (
    db
      .prepare(
        `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
         VALUES (1, ?, ?, 'completed', 'manual') RETURNING id`,
      )
      .get('2026-07-16T18:00:00.000Z', '2026-07-16T18:00:00.000Z') as { id: number }
  ).id;

  const rec = (capturedIso: string, earnedIso: string | null): void => {
    db.prepare(
      `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at, earned_at, confidence)
       VALUES (1, ?, ?, ?, 25, ?, ?, 0.95)`,
    ).run(session, member, chestId, Date.parse(capturedIso), earnedIso ? Date.parse(earnedIso) : null);
  };

  // Earned Jul 16 16:00 (game-day Jul 15) but scanned Jul 16 18:00 (game-day Jul 16).
  rec('2026-07-16T18:00:00.000Z', '2026-07-16T16:00:00.000Z');
  // A control chest genuinely in game-day Jul 16 (earned + scanned after
  // rollover). Distinct captured_at so it doesn't collide on the UNIQUE key
  // (production's monotonic scan clock guarantees this).
  rec('2026-07-16T18:30:00.000Z', '2026-07-16T18:30:00.000Z');
  return { member };
}

describe('earn-time windowing (phase 2c)', () => {
  it('leaderboard counts a chest in the game-day it was EARNED, not scanned', () => {
    ({ cleanup } = makeTestDb());
    const { member } = seed();

    // Game-day Jul 15 window: [Jul 15 17:00, Jul 16 17:00).
    const jul15 = getLeaderboard(1, '2026-07-15T17:00:00.000Z', '2026-07-16T17:00:00.000Z');
    expect(jul15.find((e) => e.memberId === member)?.totalChests).toBe(1);

    // Game-day Jul 16 window: [Jul 16 17:00, Jul 17 17:00) — the control chest.
    const jul16 = getLeaderboard(1, '2026-07-16T17:00:00.000Z', '2026-07-17T17:00:00.000Z');
    expect(jul16.find((e) => e.memberId === member)?.totalChests).toBe(1);
  });

  it('daily-summary rollup buckets by earn day', () => {
    ({ cleanup } = makeTestDb());
    const { member } = seed();

    notifyChestDataChanged(1);
    getSingleDayRecords(1); // forces a rebuild with the effective_at bucket

    const rows = getDb()
      .prepare('SELECT game_day, chests FROM chest_daily_summary WHERE clan_id = 1 AND member_id = ? ORDER BY game_day')
      .all(member) as Array<{ game_day: string; chests: number }>;

    // One chest each on Jul 15 (earned-before) and Jul 16 (control) — NOT two on Jul 16.
    expect(rows).toEqual([
      { game_day: '2026-07-15', chests: 1 },
      { game_day: '2026-07-16', chests: 1 },
    ]);
  });
});
