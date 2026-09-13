import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import * as mightRepo from '../../../src/data/repositories/might-repo.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

let cleanup: () => void;

function addMember(clanId: number, name: string): number {
  const now = new Date().toISOString();
  const row = getDb().prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (?, ?, ?, ?, ?, 1) RETURNING id`,
  ).get(clanId, name, name.toLowerCase(), now, now) as { id: number };
  return row.id;
}

beforeEach(() => {
  ({ cleanup } = makeTestDb());
  seedTwoClans();
});

afterEach(() => cleanup());

describe('saveSnapshots', () => {
  it('is idempotent per (member, game day) — a re-capture overwrites', () => {
    const alice = addMember(1, 'Alice');

    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:00:00.000Z', [
      { memberId: alice, might: 100_000_000 },
    ]);
    // Same game day again — e.g. a manual re-scan, or a second cycle after the
    // first was interrupted. Must correct the value in place, not add a row.
    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T21:00:00.000Z', [
      { memberId: alice, might: 100_500_000 },
    ]);

    const rows = getDb().prepare(
      'SELECT power, captured_at FROM member_snapshots WHERE member_id = ? AND game_date = ?',
    ).all(alice, '2026-07-30') as Array<{ power: number; captured_at: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].power).toBe(100_500_000);
    expect(rows[0].captured_at).toBe('2026-07-30T21:00:00.000Z');
  });

  it('keeps separate rows for separate game days', () => {
    const alice = addMember(1, 'Alice');
    mightRepo.saveSnapshots(1, '2026-07-29', '2026-07-29T18:00:00.000Z', [{ memberId: alice, might: 1_000_000 }]);
    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:00:00.000Z', [{ memberId: alice, might: 1_200_000 }]);

    expect(mightRepo.getMemberHistory(alice, 1)).toEqual([
      { gameDate: '2026-07-29', might: 1_000_000, heroLevel: null },
      { gameDate: '2026-07-30', might: 1_200_000, heroLevel: null },
    ]);
  });

  it('snapshots hero level per game day alongside might, for analytics over time', () => {
    // Both live on the same row, so the two series are always aligned on the same day.
    const alice = addMember(1, 'Alice');
    mightRepo.saveSnapshots(1, '2026-07-29', '2026-07-29T18:00:00.000Z', [
      { memberId: alice, might: 1_000_000, level: 218 },
    ]);
    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:00:00.000Z', [
      { memberId: alice, might: 1_200_000, level: 219 },
    ]);
    // A day the crop clipped the avatars: level unread, might fine.
    mightRepo.saveSnapshots(1, '2026-07-31', '2026-07-31T18:00:00.000Z', [
      { memberId: alice, might: 1_300_000 },
    ]);

    expect(mightRepo.getMemberHistory(alice, 1)).toEqual([
      { gameDate: '2026-07-29', might: 1_000_000, heroLevel: 218 },
      { gameDate: '2026-07-30', might: 1_200_000, heroLevel: 219 },
      // null, NOT 0 — a literal zero would chart as the level collapsing.
      { gameDate: '2026-07-31', might: 1_300_000, heroLevel: null },
    ]);
  });

  it('does not let a re-capture that missed the badge erase a level already read', () => {
    // Same game day, second read with the avatars clipped. MAX keeps the real value;
    // without it the day's level would drop to the 0 placeholder.
    const alice = addMember(1, 'Alice');
    mightRepo.saveSnapshots(1, '2026-07-31', '2026-07-31T18:00:00.000Z', [
      { memberId: alice, might: 500, level: 220 },
    ]);
    mightRepo.saveSnapshots(1, '2026-07-31', '2026-07-31T21:00:00.000Z', [
      { memberId: alice, might: 600 },
    ]);

    expect(mightRepo.getMemberHistory(alice, 1)).toEqual([
      { gameDate: '2026-07-31', might: 600, heroLevel: 220 },
    ]);
  });

  it('never reports a hero level going down, and keeps the raw rows saying it did', () => {
    // A hero level cannot fall in the game, so a downward step is measurement error
    // by definition. Fifteen days of production had 174 of them across 108 of 237
    // members, which is what made the member chart's level line saw-tooth: a badge
    // matched against the EDGE of a row band went to the member above on any page
    // where it drifted a pixel, so each member intermittently wore their neighbour's
    // level. The capture side is fixed; these are the days already in the database,
    // plus whatever residue OCR leaves behind.
    const alice = addMember(1, 'Alice');
    const days: Array<[string, number]> = [
      ['2026-07-29', 220],
      ['2026-07-30', 220],
      // The neighbour's badge — one day of somebody else's level, in both directions.
      ['2026-07-31', 247],
      ['2026-08-01', 220],
      ['2026-08-02', 205],
      ['2026-08-03', 221],
    ];
    for (const [date, level] of days) {
      mightRepo.saveSnapshots(1, date, `${date}T18:00:00.000Z`, [
        { memberId: alice, might: 1_000_000, level },
      ]);
    }

    // Suppressed, not clamped: the day reads as "no level read", which is a state the
    // charts already span and the honest description of a reading we don't believe.
    expect(mightRepo.getMemberHistory(alice, 1).map((p) => p.heroLevel))
      .toEqual([220, 220, null, 220, null, 221]);
    // The headline stat is the level the member HOLDS — the newest trusted reading.
    expect(mightRepo.getLatestForMember(alice, 1)?.heroLevel).toBe(221);
    expect(mightRepo.getSeriesForMembers(1, [alice], 90)[0].points.map((p) => p.heroLevel))
      .toEqual([220, 220, null, 220, null, 221]);
    expect(mightRepo.getMightWithDelta(1).find((r) => r.memberId === alice)?.heroLevel).toBe(221);

    // The table still says exactly what the scanner saw. Filtering is a read-side
    // judgement that one more day of evidence can overturn; a write-side clamp would
    // bake a single bad HIGH read in forever and then reject every correct one after.
    const raw = getDb().prepare(
      'SELECT level FROM member_snapshots WHERE member_id = ? ORDER BY game_date',
    ).all(alice) as Array<{ level: number }>;
    expect(raw.map((r) => r.level)).toEqual([220, 220, 247, 220, 205, 221]);
  });

  it('drops the lone spike rather than the run it interrupts', () => {
    // Which reading to disbelieve is decided by keeping the LONGEST chain a level is
    // physically allowed to take, so a stable stretch outvotes a one-day excursion.
    // Deliberately no cap on how fast a level may rise: monotonicity is a fact about
    // the game, a growth rate would be a guess, and a genuine jump after a gap in
    // coverage has to survive.
    const bob = addMember(1, 'Bob');
    for (const [date, level] of [
      ['2026-07-29', 179], ['2026-07-30', 367], ['2026-07-31', 179],
      ['2026-08-01', 179], ['2026-08-02', 180],
    ] as Array<[string, number]>) {
      mightRepo.saveSnapshots(1, date, `${date}T18:00:00.000Z`, [
        { memberId: bob, might: 1, level },
      ]);
    }
    expect(mightRepo.getMemberHistory(bob, 1).map((p) => p.heroLevel))
      .toEqual([179, null, 179, 179, 180]);
    expect(mightRepo.getLatestForMember(bob, 1)?.heroLevel).toBe(180);
  });

  it('leaves a clean rising series completely untouched', () => {
    const cara = addMember(1, 'Cara');
    for (const [date, level] of [
      ['2026-07-29', 100], ['2026-07-30', 100], ['2026-07-31', 103],
    ] as Array<[string, number]>) {
      mightRepo.saveSnapshots(1, date, `${date}T18:00:00.000Z`, [
        { memberId: cara, might: 1, level },
      ]);
    }
    expect(mightRepo.getMemberHistory(cara, 1).map((p) => p.heroLevel)).toEqual([100, 100, 103]);
  });

  it('judges a windowed history against everything before it, not just the window', () => {
    // A reading near the left edge of a 2-day view is only judgeable against what came
    // before it. Reconstructing inside the window would let the window boundary decide
    // whether a level "went down".
    const dan = addMember(1, 'Dan');
    for (const [date, level] of [
      ['2026-07-29', 300], ['2026-07-30', 300], ['2026-07-31', 250], ['2026-08-01', 301],
    ] as Array<[string, number]>) {
      mightRepo.saveSnapshots(1, date, `${date}T18:00:00.000Z`, [
        { memberId: dan, might: 1, level },
      ]);
    }
    // This window holds only 250 and 301, which on their own are a perfectly legal
    // rise — the two 300s outside it are what prove 250 is the bad reading.
    expect(mightRepo.getMemberHistory(dan, 1, 1).map((p) => p.heroLevel)).toEqual([null, 301]);
  });

  it('writes nothing for an empty batch', () => {
    expect(mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:00:00.000Z', [])).toBe(0);
    expect(mightRepo.hasSnapshotForGameDate(1, '2026-07-30')).toBe(false);
  });
});

describe('hasSnapshotForGameDate', () => {
  it('is the per-clan once-a-day gate', () => {
    const alice = addMember(1, 'Alice');
    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:00:00.000Z', [{ memberId: alice, might: 5_000 }]);

    expect(mightRepo.hasSnapshotForGameDate(1, '2026-07-30')).toBe(true);
    expect(mightRepo.hasSnapshotForGameDate(1, '2026-07-31')).toBe(false);
    // Clan #2 has its own schedule — clan #1 capturing must not gate it out.
    expect(mightRepo.hasSnapshotForGameDate(2, '2026-07-30')).toBe(false);
  });
});

describe('getMightWithDelta', () => {
  it('measures against the newest snapshot at or before the cutoff', () => {
    const alice = addMember(1, 'Alice');
    // A gap on the 24th/25th, as happens when the container is down over a
    // rollover. A strict "exactly 7 days ago" lookup would find nothing here and
    // blank the delta; the baseline must fall back to the nearest older day.
    mightRepo.saveSnapshots(1, '2026-07-20', '2026-07-20T18:00:00.000Z', [{ memberId: alice, might: 90_000_000 }]);
    mightRepo.saveSnapshots(1, '2026-07-23', '2026-07-23T18:00:00.000Z', [{ memberId: alice, might: 95_000_000 }]);
    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:00:00.000Z', [{ memberId: alice, might: 99_000_000 }]);

    const [row] = mightRepo.getMightWithDelta(1, 7);
    expect(row.might).toBe(99_000_000);
    expect(row.gameDate).toBe('2026-07-30');
    expect(row.baselineDate).toBe('2026-07-23');
    expect(row.delta).toBe(4_000_000);
  });

  it('reports a null delta when there is only one reading', () => {
    const alice = addMember(1, 'Alice');
    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:00:00.000Z', [{ memberId: alice, might: 12_345_678 }]);

    const [row] = mightRepo.getMightWithDelta(1, 7);
    expect(row.might).toBe(12_345_678);
    expect(row.delta).toBeNull();
    expect(row.baselineMight).toBeNull();
  });

  it('omits members that have no snapshot, and never leaks another clan', () => {
    const alice = addMember(1, 'Alice');
    addMember(1, 'NoData');
    const other = addMember(2, 'OtherClan');
    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:00:00.000Z', [{ memberId: alice, might: 7_000_000 }]);
    mightRepo.saveSnapshots(2, '2026-07-30', '2026-07-30T18:00:00.000Z', [{ memberId: other, might: 8_000_000 }]);

    const names = mightRepo.getMightWithDelta(1, 7).map((r) => r.name);
    expect(names).toEqual(['Alice']);
  });

  it('excludes soft-removed members', () => {
    const alice = addMember(1, 'Alice');
    const gone = addMember(1, 'Departed');
    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:00:00.000Z', [
      { memberId: alice, might: 1_000_000 },
      { memberId: gone, might: 2_000_000 },
    ]);
    getDb().prepare('UPDATE members SET is_active = 0 WHERE id = ?').run(gone);

    expect(mightRepo.getMightWithDelta(1, 7).map((r) => r.name)).toEqual(['Alice']);
  });
});

describe('getClanTotals', () => {
  it('sums per game day and reports the headcount behind each total', () => {
    const alice = addMember(1, 'Alice');
    const bob = addMember(1, 'Bob');
    mightRepo.saveSnapshots(1, '2026-07-29', '2026-07-29T18:00:00.000Z', [{ memberId: alice, might: 10 }]);
    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:00:00.000Z', [
      { memberId: alice, might: 20 },
      { memberId: bob, might: 5 },
    ]);

    expect(mightRepo.getClanTotals(1, 90)).toEqual([
      { gameDate: '2026-07-29', totalMight: 10, memberCount: 1 },
      { gameDate: '2026-07-30', totalMight: 25, memberCount: 2 },
    ]);
  });

  it('keeps a historical point intact after a member goes inactive', () => {
    // A past total must describe the clan as it was, not be retroactively
    // rewritten by today's roster.
    const alice = addMember(1, 'Alice');
    const gone = addMember(1, 'Departed');
    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:00:00.000Z', [
      { memberId: alice, might: 100 },
      { memberId: gone, might: 400 },
    ]);
    getDb().prepare('UPDATE members SET is_active = 0 WHERE id = ?').run(gone);

    expect(mightRepo.getClanTotals(1, 90)).toEqual([
      { gameDate: '2026-07-30', totalMight: 500, memberCount: 2 },
    ]);
  });
});

describe('getSeriesForMembers', () => {
  it('returns series in the requested order', () => {
    const alice = addMember(1, 'Alice');
    const bob = addMember(1, 'Bob');
    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:00:00.000Z', [
      { memberId: alice, might: 1 },
      { memberId: bob, might: 2 },
    ]);

    expect(mightRepo.getSeriesForMembers(1, [bob, alice], 90).map((s) => s.name)).toEqual(['Bob', 'Alice']);
  });

  it('includes a requested member with no snapshots as an empty series', () => {
    const alice = addMember(1, 'Alice');
    const empty = addMember(1, 'Empty');
    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:00:00.000Z', [{ memberId: alice, might: 1 }]);

    const series = mightRepo.getSeriesForMembers(1, [alice, empty], 90);
    expect(series).toHaveLength(2);
    expect(series[1]).toEqual({ memberId: empty, name: 'Empty', points: [] });
  });

  it('refuses member ids belonging to another clan', () => {
    const other = addMember(2, 'OtherClan');
    mightRepo.saveSnapshots(2, '2026-07-30', '2026-07-30T18:00:00.000Z', [{ memberId: other, might: 999 }]);

    expect(mightRepo.getSeriesForMembers(1, [other], 90)).toEqual([]);
  });

  it('returns nothing for an empty id list', () => {
    expect(mightRepo.getSeriesForMembers(1, [], 90)).toEqual([]);
  });
});

describe('getLastCaptureAt / getSnapshotDates', () => {
  it('reports the newest capture and every distinct day', () => {
    const alice = addMember(1, 'Alice');
    mightRepo.saveSnapshots(1, '2026-07-29', '2026-07-29T18:00:00.000Z', [{ memberId: alice, might: 1 }]);
    mightRepo.saveSnapshots(1, '2026-07-30', '2026-07-30T18:30:00.000Z', [{ memberId: alice, might: 2 }]);

    expect(mightRepo.getLastCaptureAt(1)).toEqual({
      capturedAt: '2026-07-30T18:30:00.000Z',
      gameDate: '2026-07-30',
    });
    expect(mightRepo.getSnapshotDates(1)).toEqual(['2026-07-29', '2026-07-30']);
    expect(mightRepo.getLastCaptureAt(2)).toBeNull();
  });
});
