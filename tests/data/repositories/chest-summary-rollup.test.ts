import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import {
  getSingleDayRecords,
  getTopContributors,
  notifyChestDataChanged,
  verifyClanSummary,
} from '../../../src/data/repositories/chest-summary-repo.js';
import { reassignChestsToMember } from '../../../src/data/repositories/chest-repo.js';
import { loadConfig } from '../../../src/config/index.js';
import { makeTestDb, seedTwoClans, seedManyChests } from '../../helpers/test-db.js';

// The chest_daily_summary rollup is a *derived* table; the whole point of
// these tests is that it can never disagree with a raw recomputation from
// chest_records. We compute the "old" raw queries inline here as the oracle
// and assert the rollup-backed repo returns the same thing — locking in the
// equivalence that was validated by hand against the production data.

const rolloverModifier = `-${loadConfig().gameDayRolloverUtcHour} hours`;

// The rollup reads earned_* — i.e. with end-of-event clan rewards removed — for
// both podiums and the top-contributor boards, because those rank members
// against each other. The oracles below must do the same or they'd be asserting
// the pre-v70 behaviour. Written as raw SQL, deliberately NOT by calling
// clanRewardExclusionSql, so a bug in the resolver can't cancel itself out.
const REWARD_NAMES = ['Olympus Chest', 'Olympus Elite Chest', 'Dark Omens ranking chest'];
function rewardExclusion(alias: string): string {
  const ids = (getDb()
    .prepare(`SELECT id FROM chests WHERE name IN (${REWARD_NAMES.map(() => '?').join(',')})`)
    .all(...REWARD_NAMES) as Array<{ id: number }>).map((r) => r.id);
  return ids.length ? ` AND ${alias}chest_id NOT IN (${ids.join(',')})` : '';
}

/**
 * The pre-rollup raw single-day query (best day per member, top 3).
 *
 * Buckets on effective_at, matching rebuild(). It used to say captured_at and
 * stayed green only because the seed helper never writes earned_at — i.e. the
 * oracle had quietly stopped mirroring the repo it exists to check.
 */
function rawSingleDay(clanId: number, metric: 'chests' | 'points'): string {
  const perDay = `
    SELECT c.member_id memberId, m.name memberName,
           DATE(c.effective_at/1000,'unixepoch',?) day,
           COUNT(*) chests, SUM(c.point_value) points
    FROM chest_records c JOIN members m ON m.id=c.member_id AND m.clan_id=c.clan_id
    WHERE c.clan_id=?${rewardExclusion('c.')}
    GROUP BY c.member_id, m.name, DATE(c.effective_at/1000,'unixepoch',?)`;
  const rows = getDb().prepare(`
    WITH per_day AS (${perDay}),
    best AS (SELECT memberId, memberName, MAX(${metric}) value FROM per_day GROUP BY memberId, memberName)
    SELECT b.memberId, b.value,
      (SELECT day FROM per_day pd WHERE pd.memberId IS b.memberId AND pd.memberName=b.memberName
        AND pd.${metric}=b.value ORDER BY pd.day DESC LIMIT 1) date
    FROM best b WHERE b.value>0 ORDER BY b.value DESC, LOWER(b.memberName) ASC LIMIT 3
  `).all(rolloverModifier, clanId, rolloverModifier) as Array<{ memberId: number; value: number; date: string }>;
  return rows.map((r) => `${r.memberId}:${r.value}:${r.date}`).join('|');
}

/** The pre-rollup raw top-contributors query. Compared as a set (ties in the
 *  ORDER BY are non-deterministic) sorted by value then member id. */
function rawTop(clanId: number, agg: string, limit: number): string {
  const rows = getDb().prepare(`
    SELECT c.member_id memberId, ${agg} value
    FROM chest_records c JOIN members m ON c.member_id=m.id
    WHERE c.clan_id=?${rewardExclusion('c.')}
    GROUP BY c.member_id ORDER BY value DESC LIMIT ?
  `).all(clanId, limit) as Array<{ memberId: number; value: number }>;
  return rows.map((r) => `${r.memberId}:${r.value}`).sort().join('|');
}

let cleanup: () => void;
beforeEach(() => {
  ({ cleanup } = makeTestDb());
  seedTwoClans();
});
afterEach(() => cleanup());

describe('chest_daily_summary rollup', () => {
  it('single-day records match a raw recomputation (both clans)', () => {
    seedManyChests({ clanId: 1, members: 8, days: 6, perMemberPerDay: 2 });
    seedManyChests({ clanId: 2, members: 6, days: 5, perMemberPerDay: 2 });
    notifyChestDataChanged(1);
    notifyChestDataChanged(2);

    for (const clanId of [1, 2]) {
      const repo = getSingleDayRecords(clanId);
      const repoChests = repo.byChests.map((r) => `${r.memberId}:${r.value}:${r.date}`).join('|');
      const repoPoints = repo.byPoints.map((r) => `${r.memberId}:${r.value}:${r.date}`).join('|');
      expect(repoChests).toBe(rawSingleDay(clanId, 'chests'));
      expect(repoPoints).toBe(rawSingleDay(clanId, 'points'));
    }
  });

  it('top-contributors match a raw recomputation', () => {
    seedManyChests({ clanId: 1, members: 12, days: 5, perMemberPerDay: 3 });
    notifyChestDataChanged(1);

    const repo = getTopContributors(1, 10);
    const repoChests = repo.topChests.map((r) => `${r.memberId}:${r.chests}`).sort().join('|');
    const repoPoints = repo.topPoints.map((r) => `${r.memberId}:${r.points}`).sort().join('|');
    expect(repoChests).toBe(rawTop(1, 'COUNT(*)', 10));
    expect(repoPoints).toBe(rawTop(1, 'SUM(c.point_value)', 10));
  });

  it('rollup totals equal raw member-scoped totals', () => {
    seedManyChests({ clanId: 1, members: 10, days: 7, perMemberPerDay: 3 });
    notifyChestDataChanged(1);
    const v = verifyClanSummary(1);
    expect(v.ok).toBe(true);
    expect(v.summary).toEqual(v.raw);
    // No clan rewards seeded, so the earned columns match the unfiltered ones.
    expect(v.summaryEarned).toEqual(v.raw);
  });
});

/**
 * End-of-event clan rewards (v70).
 *
 * The game hands a clan's whole placement prize to ONE account in one drop —
 * 1006 Olympus Elite Chests inside a minute on the 2026-08-24 run — so the
 * recipient owned the "most chests in a day" podium and the all-time top-chest
 * board for chests nobody farmed. These tests seed exactly that shape, which is
 * the only reason the oracles above have anything to disagree about.
 */
describe('chest_daily_summary clan-reward exclusion', () => {
  /** Drop `count` reward chests on `memberId` in one burst, one game day. */
  function seedRewardBurst(clanId: number, memberId: number, chestName: string, count: number): void {
    const db = getDb();
    const chestId = (db.prepare(
      `INSERT INTO chests (name, chest_type) VALUES (?, 'common')
       ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
    ).get(chestName) as { id: number }).id;
    const sourceId = (db.prepare(
      `INSERT INTO chest_sources (source) VALUES ('Event "Trials of Olympus"')
       ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
    ).get() as { id: number }).id;
    const session = (db.prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, status, trigger_source)
       VALUES (?, ?, 'completed', 'manual') RETURNING id`,
    ).get(clanId, new Date().toISOString()) as { id: number }).id;
    // captured_at only, no earned_at: the seed helper does the same, and mixing
    // the two would make these rows land in a different game-day bucket from
    // the farmed ones for reasons unrelated to what is being tested.
    const base = Date.now() - 30_000;
    const ins = db.prepare(
      `INSERT INTO chest_records
         (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
       VALUES (?, ?, ?, ?, ?, 10, ?, 60)`,
    );
    db.transaction(() => {
      for (let i = 0; i < count; i++) ins.run(clanId, session, memberId, chestId, sourceId, base + i);
    })();
  }

  it('keeps a bulk reward off the best-single-day podium and the top boards', () => {
    // seedManyChests is uniform, so every member farms the same amount — give
    // one member a real farming lead, or "the leader is no longer first" would
    // pass on a tie rather than on the exclusion.
    const { memberIds } = seedManyChests({ clanId: 1, members: 6, days: 4, perMemberPerDay: 3 });
    const leader = memberIds[0];
    const topFarmer = memberIds[1];
    seedRewardBurst(1, topFarmer, 'Common Chest', 100);        // earned, must count
    seedRewardBurst(1, leader, 'Olympus Elite Chest', 500);    // clan reward, must not
    notifyChestDataChanged(1);

    // Unfiltered the leader's 500 would own both boards. The real farmer does.
    const records = getSingleDayRecords(1);
    expect(records.byChests.length).toBeGreaterThan(0);
    for (const r of records.byChests) expect(r.value).toBeLessThan(500);
    expect(records.byChests[0].memberId).toBe(topFarmer);

    const top = getTopContributors(1, 10);
    expect(top.topChests[0].memberId).toBe(topFarmer);
    const leaderRow = top.topChests.find((t) => t.memberId === leader);
    // Still on the board for their own farming — the reward is removed, the
    // member is not.
    expect(leaderRow?.chests).toBe(4 * 3);

    // And both oracles agree, which is what pins the SQL rather than the shape.
    expect(records.byChests.map((r) => `${r.memberId}:${r.value}:${r.date}`).join('|'))
      .toBe(rawSingleDay(1, 'chests'));
    expect(top.topChests.map((r) => `${r.memberId}:${r.chests}`).sort().join('|'))
      .toBe(rawTop(1, 'COUNT(*)', 10));
  });

  it('excludes reward POINTS as well as counts', () => {
    const { memberIds } = seedManyChests({ clanId: 1, members: 5, days: 3, perMemberPerDay: 2 });
    seedRewardBurst(1, memberIds[1], 'Common Chest', 100);              // earned
    seedRewardBurst(1, memberIds[0], 'Dark Omens ranking chest', 300);  // 10 pts each
    notifyChestDataChanged(1);

    const records = getSingleDayRecords(1);
    for (const r of records.byPoints) expect(r.value).toBeLessThan(3000);
    expect(getTopContributors(1, 10).topPoints[0].memberId).toBe(memberIds[1]);
    expect(records.byPoints.map((r) => `${r.memberId}:${r.value}:${r.date}`).join('|'))
      .toBe(rawSingleDay(1, 'points'));
  });

  it('still counts rewards in the unfiltered columns, so the drift check stays honest', () => {
    const { memberIds } = seedManyChests({ clanId: 1, members: 4, days: 3, perMemberPerDay: 2 });
    seedRewardBurst(1, memberIds[0], 'Olympus Chest', 200);
    notifyChestDataChanged(1);

    const v = verifyClanSummary(1);
    expect(v.ok).toBe(true);
    expect(v.summary).toEqual(v.raw);                    // rollup still mirrors raw
    expect(v.summaryEarned).toEqual(v.rawEarned);         // and the earned split is right
    expect(v.raw.chests - v.rawEarned.chests).toBe(200);  // exactly the reward
    expect(v.raw.points - v.rawEarned.points).toBe(2000);
  });

  it('excludes every declared reward name, not just the one that was tested', () => {
    const { memberIds } = seedManyChests({ clanId: 1, members: 4, days: 2, perMemberPerDay: 2 });
    for (const name of ['Olympus Chest', 'Olympus Elite Chest', 'Dark Omens ranking chest']) {
      seedRewardBurst(1, memberIds[0], name, 50);
    }
    notifyChestDataChanged(1);

    const v = verifyClanSummary(1);
    expect(v.ok).toBe(true);
    expect(v.raw.chests - v.rawEarned.chests).toBe(150);
  });

  it('does not leak data across clans', () => {
    seedManyChests({ clanId: 1, members: 5, days: 3, perMemberPerDay: 2 });
    // clan 2 has no chests
    notifyChestDataChanged(1);
    notifyChestDataChanged(2);
    expect(getTopContributors(2, 10).topChests).toHaveLength(0);
    expect(getSingleDayRecords(2).byChests).toHaveLength(0);
    expect(getTopContributors(1, 10).topChests.length).toBeGreaterThan(0);
  });

  it('stays consistent after a mutation that notifies (reassign)', () => {
    const { memberIds } = seedManyChests({ clanId: 1, members: 6, days: 4, perMemberPerDay: 2 });
    notifyChestDataChanged(1);
    expect(verifyClanSummary(1).ok).toBe(true);

    // Move all of member[0]'s chests to member[1] via the real repo path,
    // which calls notifyChestDataChanged internally.
    const donorChestIds = getDb()
      .prepare('SELECT id FROM chest_records WHERE clan_id=1 AND member_id=?')
      .all(memberIds[0]).map((r) => (r as { id: number }).id);
    reassignChestsToMember(donorChestIds, memberIds[1], 'unused', 1);

    // Rollup must have rebuilt and still reconcile with raw; the donor is gone.
    expect(verifyClanSummary(1).ok).toBe(true);
    const top = getTopContributors(1, 100).topChests;
    expect(top.find((t) => t.memberId === memberIds[0])).toBeUndefined();
  });
});
