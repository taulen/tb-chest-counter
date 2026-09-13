import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from '../helpers/test-db.js';
import {
  insertSnapshot,
  listClanShareCodes,
  listSnapshots,
  listSnapshotWeeks,
  getSnapshot,
  getLatestSnapshot,
  type NewSnapshotInput,
} from '../../src/data/repositories/external-repo.js';

// A clan's ChestTracker share code is mutable — clans merge, re-form, or
// move to a fresh tracker. Repointing one used to make every snapshot
// captured under the previous code vanish from the UI: reads filtered on
// the clan's CURRENT code, so 22 weeks of history read as data loss even
// though every row was still on disk.
//
// These tests pin the archive contract that replaced it: history is keyed
// on clan_id (which never changes), the old code stays enumerable and
// readable, and one clan still can't see another's rows.

function makePlayers(n: number): NewSnapshotInput['players'] {
  return Array.from({ length: n }, (_, i) => ({
    name: `Player${i}`,
    guardsLevel: 0,
    points: 10,
    chests: 1,
    categories: {},
  }));
}

function insert(opts: {
  clanId?: number;
  shareCode: string;
  windowStart: string;
  windowEnd: string;
  fetchedAt: string;
  players: number;
}): number {
  return insertSnapshot({
    clanId: opts.clanId ?? 1,
    fetchedAt: opts.fetchedAt,
    shareCode: opts.shareCode,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    durationDays: 7,
    trigger: 'scheduled',
    etag: null,
    settingsJson: null,
    players: makePlayers(opts.players),
    definitions: [],
  });
}

const WEEK1_START = '2026-06-07T17:00:00.000Z';
const WEEK1_END = '2026-06-14T17:00:00.000Z';
const WEEK2_START = '2026-06-14T17:00:00.000Z';
const WEEK2_END = '2026-06-21T17:00:00.000Z';

const OLD = 'OLDCODE111';
const NEW = 'NEWCODE222';

describe('share-code archive', () => {
  let cleanup: () => void;

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
  });

  afterEach(() => {
    cleanup();
  });

  /** Clan 1 ran OLD for two weeks, then switched to NEW. */
  function seedSwitchedClan() {
    insert({ shareCode: OLD, windowStart: WEEK1_START, windowEnd: WEEK1_END, fetchedAt: '2026-06-08T00:00:00.000Z', players: 3 });
    const oldLast = insert({ shareCode: OLD, windowStart: WEEK2_START, windowEnd: WEEK2_END, fetchedAt: '2026-06-20T00:00:00.000Z', players: 9 });
    const newFirst = insert({ shareCode: NEW, windowStart: WEEK2_START, windowEnd: WEEK2_END, fetchedAt: '2026-06-25T00:00:00.000Z', players: 5 });
    return { oldLast, newFirst };
  }

  it('lists every code the clan has history under, most recently active first', () => {
    seedSwitchedClan();

    const codes = listClanShareCodes(1);

    expect(codes.map((c) => c.shareCode)).toEqual([NEW, OLD]);
    expect(codes[1]).toMatchObject({ shareCode: OLD, snapshots: 2, weeks: 2 });
    expect(codes[0]).toMatchObject({ shareCode: NEW, snapshots: 1, weeks: 1 });
  });

  it('keeps the previous code fully readable after a switch', () => {
    const { oldLast } = seedSwitchedClan();

    // The regression: these three reads are what the ChestTracker tab
    // issues, and every one of them used to come back empty for OLD once
    // the clan's current code became NEW.
    expect(listSnapshots({ clanId: 1, shareCode: OLD }).total).toBe(2);
    expect(listSnapshotWeeks({ clanId: 1, shareCode: OLD })).toHaveLength(2);
    expect(getLatestSnapshot({ clanId: 1, shareCode: OLD })?.id).toBe(oldLast);
  });

  it('exposes clanId on snapshots so access checks can key on ownership, not the code', () => {
    const { oldLast } = seedSwitchedClan();

    const detail = getSnapshot(oldLast);

    expect(detail).not.toBeNull();
    expect(detail!.clanId).toBe(1);
    expect(detail!.shareCode).toBe(OLD);
  });

  it('does not borrow a previous-week delta across a tracker switch', () => {
    const { newFirst } = seedSwitchedClan();

    // NEW's week-2 snapshot must NOT pick up OLD's week-1 row as its
    // "previous week" — the two trackers measure different things, so a
    // cross-code delta would be nonsense.
    const detail = getSnapshot(newFirst);

    expect(detail!.previousWeek).toBeNull();
  });

  it('still computes previous-week deltas within a single code', () => {
    insert({ shareCode: OLD, windowStart: WEEK1_START, windowEnd: WEEK1_END, fetchedAt: '2026-06-08T00:00:00.000Z', players: 3 });
    const week2 = insert({ shareCode: OLD, windowStart: WEEK2_START, windowEnd: WEEK2_END, fetchedAt: '2026-06-20T00:00:00.000Z', players: 9 });

    const detail = getSnapshot(week2);

    expect(detail!.previousWeek).not.toBeNull();
    expect(detail!.previousWeek!.playerCount).toBe(3);
  });

  it('never surfaces another clan\'s history, even under an identical code', () => {
    // Two clans legitimately sharing a code string must stay separate —
    // the archive allow-list is derived from clan_id for exactly this.
    insert({ clanId: 1, shareCode: OLD, windowStart: WEEK1_START, windowEnd: WEEK1_END, fetchedAt: '2026-06-08T00:00:00.000Z', players: 3 });
    insert({ clanId: 2, shareCode: OLD, windowStart: WEEK1_START, windowEnd: WEEK1_END, fetchedAt: '2026-06-09T00:00:00.000Z', players: 99 });

    expect(listClanShareCodes(2).map((c) => c.shareCode)).toEqual([OLD]);
    expect(listSnapshots({ clanId: 1, shareCode: OLD }).total).toBe(1);

    const weeks = listSnapshotWeeks({ clanId: 1, shareCode: OLD });
    expect(weeks).toHaveLength(1);
    // Clan 2's row is newer, so an unscoped "canonical snapshot per week"
    // subquery would select it and then drop the week entirely.
    expect(weeks[0].playerCount).toBe(3);
  });

  it('reports no codes for a clan that has never ingested', () => {
    expect(listClanShareCodes(99)).toEqual([]);
  });
});
