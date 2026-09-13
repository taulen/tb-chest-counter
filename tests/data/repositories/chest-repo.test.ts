import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteChestsBySession,
  getChestsBySession,
  getLeaderboard,
  getRecentChests,
  getTotalChestCount,
  insertChest,
} from '../../../src/data/repositories/chest-repo.js';
import { upsertMember } from '../../../src/data/repositories/member-repo.js';
import { createSession } from '../../../src/data/repositories/session-repo.js';
import { ChestType } from '../../../src/models/enums.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

interface SeedResult {
  clanA: number;
  clanB: number;
  sessionA: number;
  sessionB: number;
  aliceA: number;
  aliceB: number;
  bobA: number;
}

function seed(): SeedResult {
  const { clanIdA, clanIdB } = seedTwoClans();

  const sessionA = createSession('manual', clanIdA).id;
  const sessionB = createSession('manual', clanIdB).id;

  // Same name in two clans → two distinct member rows.
  const aliceA = upsertMember('Alice', clanIdA).id;
  const aliceB = upsertMember('Alice', clanIdB).id;
  const bobA = upsertMember('Bob', clanIdA).id;

  return { clanA: clanIdA, clanB: clanIdB, sessionA, sessionB, aliceA, aliceB, bobA };
}

function makeChest(overrides: {
  sessionId: number;
  clanId: number;
  playerName: string;
  memberId: number | null;
  chestName?: string;
  pointValue?: number;
  capturedAt?: string;
}) {
  return {
    sessionId: overrides.sessionId,
    clanId: overrides.clanId,
    playerName: overrides.playerName,
    memberId: overrides.memberId,
    chestName: overrides.chestName ?? 'Common Chest',
    chestType: ChestType.COMMON,
    chestSource: 'clan_gift',
    pointValue: overrides.pointValue ?? 1,
    capturedAt: overrides.capturedAt ?? '2026-04-27T12:00:00.000Z',
    confidence: 1,
  };
}

describe('chest-repo', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
  });

  afterEach(() => cleanup());

  describe('insertChest', () => {
    it('inserts and returns the row with an id', () => {
      const s = seed();
      const inserted = insertChest(makeChest({
        sessionId: s.sessionA,
        clanId: s.clanA,
        playerName: 'Alice',
        memberId: s.aliceA,
      }));
      expect(inserted).not.toBeNull();
      expect(inserted!.id).toBeGreaterThan(0);
      expect(inserted!.sessionId).toBe(s.sessionA);
    });

    it('returns null on UNIQUE constraint duplicate (no throw)', () => {
      const s = seed();
      const first = insertChest(makeChest({
        sessionId: s.sessionA,
        clanId: s.clanA,
        playerName: 'Alice',
        memberId: s.aliceA,
      }));
      const dup = insertChest(makeChest({
        sessionId: s.sessionA,
        clanId: s.clanA,
        playerName: 'Alice',
        memberId: s.aliceA,
      }));
      expect(first).not.toBeNull();
      expect(dup).toBeNull();
    });
  });

  describe('reads scope by clan_id', () => {
    it('getChestsBySession only returns rows for the requesting clan', () => {
      const s = seed();
      insertChest(makeChest({ sessionId: s.sessionA, clanId: s.clanA, playerName: 'Alice', memberId: s.aliceA }));
      insertChest(makeChest({ sessionId: s.sessionB, clanId: s.clanB, playerName: 'Alice', memberId: s.aliceB }));

      expect(getChestsBySession(s.sessionA, s.clanA).length).toBe(1);
      // Asking clan B for clan A's session id → no rows.
      expect(getChestsBySession(s.sessionA, s.clanB).length).toBe(0);
    });

    it('getTotalChestCount counts only the requesting clan', () => {
      const s = seed();
      // 3 rows in clan A — the count is row-based post-D4 (was
      // SUM(quantity) pre-D4; quantity column dropped, every row
      // counts as one).
      insertChest(makeChest({ sessionId: s.sessionA, clanId: s.clanA, playerName: 'Alice', memberId: s.aliceA }));
      insertChest(makeChest({
        sessionId: s.sessionA, clanId: s.clanA, playerName: 'Bob', memberId: s.bobA,
        chestName: 'Rare Chest', capturedAt: '2026-04-27T13:00:00.000Z',
      }));
      insertChest(makeChest({
        sessionId: s.sessionA, clanId: s.clanA, playerName: 'Bob', memberId: s.bobA,
        chestName: 'Epic Chest', capturedAt: '2026-04-27T13:00:01.000Z',
      }));
      // 1 row in clan B.
      insertChest(makeChest({
        sessionId: s.sessionB, clanId: s.clanB, playerName: 'Alice', memberId: s.aliceB,
      }));

      expect(getTotalChestCount(s.clanA)).toBe(3);
      expect(getTotalChestCount(s.clanB)).toBe(1);
    });

    it('getLeaderboard returns only the requesting clan and ranks correctly', () => {
      const s = seed();
      // Clan A: Alice 10 points, Bob 25 points.
      insertChest(makeChest({
        sessionId: s.sessionA, clanId: s.clanA, playerName: 'Alice', memberId: s.aliceA,
        pointValue: 10,
      }));
      insertChest(makeChest({
        sessionId: s.sessionA, clanId: s.clanA, playerName: 'Bob', memberId: s.bobA,
        chestName: 'Rare Chest', pointValue: 25,
        capturedAt: '2026-04-27T13:00:00.000Z',
      }));
      // Clan B: Alice 1000 points (must NOT appear in clan A's leaderboard).
      insertChest(makeChest({
        sessionId: s.sessionB, clanId: s.clanB, playerName: 'Alice', memberId: s.aliceB,
        pointValue: 1000,
      }));

      const lbA = getLeaderboard(s.clanA);
      expect(lbA.map((r) => r.memberName)).toEqual(['Bob', 'Alice']);
      expect(lbA[0].rank).toBe(1);
      expect(lbA[0].totalPoints).toBe(25);

      // Crucial: clan A's leaderboard must not include the high-scoring
      // Alice from clan B. If this fails, the multi-clan scoping is broken.
      expect(lbA.find((r) => r.totalPoints === 1000)).toBeUndefined();
    });

    it('getRecentChests respects clan scope and limit', () => {
      const s = seed();
      insertChest(makeChest({ sessionId: s.sessionA, clanId: s.clanA, playerName: 'Alice', memberId: s.aliceA }));
      insertChest(makeChest({
        sessionId: s.sessionA, clanId: s.clanA, playerName: 'Bob', memberId: s.bobA,
        chestName: 'Rare Chest', capturedAt: '2026-04-27T14:00:00.000Z',
      }));
      insertChest(makeChest({ sessionId: s.sessionB, clanId: s.clanB, playerName: 'Alice', memberId: s.aliceB }));

      const recentA = getRecentChests(s.clanA, 5);
      expect(recentA.length).toBe(2);
      // Most recent first.
      expect(recentA[0].playerName).toBe('Bob');
    });
  });

  describe('deleteChestsBySession', () => {
    it('only deletes rows scoped to the requesting clan', () => {
      const s = seed();
      insertChest(makeChest({ sessionId: s.sessionA, clanId: s.clanA, playerName: 'Alice', memberId: s.aliceA }));
      insertChest(makeChest({ sessionId: s.sessionB, clanId: s.clanB, playerName: 'Alice', memberId: s.aliceB }));

      const removed = deleteChestsBySession(s.sessionA, s.clanA);
      expect(removed).toBe(1);

      // Clan B's row is untouched.
      expect(getTotalChestCount(s.clanB)).toBe(1);
    });

    it('does nothing when called with the wrong clan id', () => {
      const s = seed();
      insertChest(makeChest({ sessionId: s.sessionA, clanId: s.clanA, playerName: 'Alice', memberId: s.aliceA }));
      const removed = deleteChestsBySession(s.sessionA, s.clanB);
      expect(removed).toBe(0);
      expect(getTotalChestCount(s.clanA)).toBe(1);
    });
  });
});
