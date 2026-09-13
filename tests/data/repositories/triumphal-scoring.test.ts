import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import { getLeaderboardForClan, getMemberStats } from '../../../src/data/repositories/triumphal-chest-repo.js';
import { makeTestDb } from '../../helpers/test-db.js';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

// A triumphal chest is worth one third of its package value. The total
// is summed at full precision and rounded ONCE per member, so a set of
// three identical chests recovers the exact package value while a lone
// chest rounds to a whole number. Golden's package is 50, so:
//   1 Golden → round(50/3)  = 17
//   2 Golden → round(100/3) = 33
//   3 Golden → round(150/3) = 50   (not 3×17 = 51)
function seedGolden(memberName: string, count: number): number {
  const db = getDb();
  const member = (
    db
      .prepare(
        `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
         VALUES (1, ?, ?, ?, ?, 1) RETURNING id`,
      )
      .get(memberName, memberName.toLowerCase(), '2026-07-15T00:00:00.000Z', '2026-07-16T00:00:00.000Z') as { id: number }
  ).id;
  const chestId = (
    db
      .prepare(
        `INSERT INTO chests (name, chest_type) VALUES ('Golden Chest', 'epic')
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
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO triumphal_chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at, earned_at, confidence)
       VALUES (1, ?, ?, ?, 0, ?, ?, 95)`,
    ).run(session, member, chestId, Date.parse('2026-07-16T18:00:00.000Z') + i, Date.parse('2026-07-16T18:00:00.000Z') + i);
  }
  return member;
}

describe('triumphal per-chest scoring (round once after aggregation)', () => {
  it('rounds each member total to a whole number, sets of 3 recover the package value', () => {
    ({ cleanup } = makeTestDb());
    const one = seedGolden('One', 1);
    const two = seedGolden('Two', 2);
    const three = seedGolden('Three', 3);

    const board = getLeaderboardForClan(1);
    const points = (id: number) => board.find((e) => e.memberId === id)?.totalPoints;

    expect(points(one)).toBe(17); // round(50 / 3)
    expect(points(two)).toBe(33); // round(100 / 3)
    expect(points(three)).toBe(50); // exact — not 3 × 17 = 51

    // getMemberStats uses the same SQL fragment, so it must agree.
    expect(getMemberStats(one, 1)).toMatchObject({ totalChests: 1, totalPoints: 17 });
    expect(getMemberStats(three, 1)).toMatchObject({ totalChests: 3, totalPoints: 50 });
  });
});
