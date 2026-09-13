import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import { getLeaderboardForClan, getStats, getChestsByMember } from '../../../src/data/repositories/triumphal-chest-repo.js';
import { makeTestDb } from '../../helpers/test-db.js';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

// Triumphal cards carry the same 20h "time left" countdown as other gifts, so
// triumphal windowing keys on earn time too: three Bronze chests earned at
// 16:00 UTC on Jul 16 (game-day Jul 15) but only scanned at 18:00 (game-day
// Jul 16) belong to Jul 15.
function seed(): { member: number } {
  const db = getDb();
  const member = (
    db
      .prepare(
        `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
         VALUES (1, 'Gus', 'gus', ?, ?, 1) RETURNING id`,
      )
      .get('2026-07-15T00:00:00.000Z', '2026-07-16T00:00:00.000Z') as { id: number }
  ).id;
  const chestId = (
    db
      .prepare(
        `INSERT INTO chests (name, chest_type) VALUES ('Bronze Chest', 'common')
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

  // Three Bronze chests = 3 × (10 / 3), summed then rounded = 10 points.
  for (let i = 0; i < 3; i++) {
    db.prepare(
      `INSERT INTO triumphal_chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at, earned_at, confidence)
       VALUES (1, ?, ?, ?, 0, ?, ?, 95)`,
    ).run(
      session,
      member,
      chestId,
      Date.parse('2026-07-16T18:00:00.000Z') + i, // distinct scan times
      Date.parse('2026-07-16T16:00:00.000Z'), // earned before the Jul 15 rollover
    );
  }
  return { member };
}

const JUL15: [string, string] = ['2026-07-15T17:00:00.000Z', '2026-07-16T17:00:00.000Z'];
const JUL16: [string, string] = ['2026-07-16T17:00:00.000Z', '2026-07-17T17:00:00.000Z'];

describe('triumphal earn-time windowing', () => {
  it('leaderboard attributes chests to the earned game-day', () => {
    ({ cleanup } = makeTestDb());
    const { member } = seed();

    const jul15 = getLeaderboardForClan(1, ...JUL15);
    const row = jul15.find((e) => e.memberId === member);
    expect(row).toMatchObject({ totalChests: 3, totalPoints: 10 });

    // Nothing in Jul 16 by earn time (they were only scanned then).
    expect(getLeaderboardForClan(1, ...JUL16).find((e) => e.memberId === member)).toBeUndefined();
  });

  it('stats and member history window on earn time too', () => {
    ({ cleanup } = makeTestDb());
    const { member } = seed();

    expect(getStats(1, ...JUL15).totalChests).toBe(3);
    expect(getStats(1, ...JUL16).totalChests).toBe(0);
    // getChestsByMember reads the view — confirms it exposes effective_at.
    expect(getChestsByMember(member, 1, ...JUL15)).toHaveLength(3);
    expect(getChestsByMember(member, 1, ...JUL16)).toHaveLength(0);
  });
});
