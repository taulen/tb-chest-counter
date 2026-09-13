import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import { getLeaderboardForClan, getMemberStats } from '../../../src/data/repositories/triumphal-chest-repo.js';
import {
  getKnownChestNames,
  getAll,
  getManagementList,
  getNewChestNames,
  countNewChestNames,
  setPoints,
  deletePoints,
} from '../../../src/data/repositories/triumphal-points-repo.js';
import { makeTestDb } from '../../helpers/test-db.js';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

// Insert `count` triumphal chests of `chestName` for a fresh member.
// Returns the member id.
function seed(memberName: string, chestName: string, count: number): number {
  const db = getDb();
  const member = (
    db
      .prepare(
        `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
         VALUES (1, ?, ?, ?, ?, 1) RETURNING id`,
      )
      .get(memberName, memberName.toLowerCase(), '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z') as { id: number }
  ).id;
  const chestId = (
    db
      .prepare(
        `INSERT INTO chests (name, chest_type) VALUES (?, 'epic')
         ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
      )
      .get(chestName) as { id: number }
  ).id;
  const session = (
    db
      .prepare(
        `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
         VALUES (1, ?, ?, 'completed', 'manual') RETURNING id`,
      )
      .get('2026-07-20T18:00:00.000Z', '2026-07-20T18:00:00.000Z') as { id: number }
  ).id;
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO triumphal_chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at, confidence)
       VALUES (1, ?, ?, ?, 0, ?, 95)`,
    ).run(session, member, chestId, Date.parse('2026-07-20T18:00:00.000Z') + i);
  }
  return member;
}

const points = (memberId: number): number | undefined =>
  getLeaderboardForClan(1).find((e) => e.memberId === memberId)?.totalPoints;

describe('triumphal_chest_points migration seed', () => {
  it('seeds the built-in defaults including Conqueror\'s Chest', () => {
    ({ cleanup } = makeTestDb());
    const names = getKnownChestNames();
    expect(names).toContain('Magic Chest');
    expect(names).toContain('Wooden Chest');
    expect(names).toContain("Conqueror's Chest");

    const all = getAll();
    const byName = new Map(all.map((r) => [r.chestName, r.packagePoints]));
    expect(byName.get('Golden Chest')).toBe(50);
    expect(byName.get("Conqueror's Chest")).toBe(10);
  });
});

describe('triumphal scoring reads the DB points table', () => {
  it("scores Conqueror's Chest at its seeded package value (10 / 3, rounded once)", () => {
    ({ cleanup } = makeTestDb());
    const one = seed('One', "Conqueror's Chest", 1);
    const two = seed('Two', "Conqueror's Chest", 2);
    const three = seed('Three', "Conqueror's Chest", 3);

    expect(points(one)).toBe(3); //   round(10 / 3)
    expect(points(two)).toBe(7); //   round(20 / 3)
    expect(points(three)).toBe(10); // round(30 / 3) — exact package value
    expect(getMemberStats(three, 1)).toMatchObject({ totalChests: 3, totalPoints: 10 });
  });

  it('counts a brand-new (unconfigured) chest but scores it 0 until valued', () => {
    ({ cleanup } = makeTestDb());
    const m = seed('Newbie', "Emperor's Chest", 3);

    // Counted, but no package value → 0 points.
    const entry = getLeaderboardForClan(1).find((e) => e.memberId === m);
    expect(entry?.totalChests).toBe(3);
    expect(entry?.totalPoints).toBe(0);

    // Surfaced for review.
    expect(getNewChestNames(1)).toContain("Emperor's Chest");
    expect(countNewChestNames(1)).toBe(1);
    const mgmt = getManagementList().find((r) => r.chestName === "Emperor's Chest");
    expect(mgmt).toMatchObject({ isNew: true, isConfigured: false, packagePoints: null, observedCount: 3 });

    // Superadmin assigns a value → it scores and leaves the review list.
    setPoints("Emperor's Chest", 60);
    expect(points(m)).toBe(60); // 3 * round-at-end(60/3) = 60
    expect(getNewChestNames(1)).not.toContain("Emperor's Chest");
    expect(countNewChestNames(1)).toBe(0);

    // Deleting the value reverts it to "new" (scores 0 again).
    deletePoints("Emperor's Chest");
    expect(points(m)).toBe(0);
    expect(countNewChestNames(1)).toBe(1);
  });
});
