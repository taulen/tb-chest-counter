import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from '../helpers/test-db.js';
import {
  insertSnapshot,
  listSnapshotWeeks,
  type NewSnapshotInput,
} from '../../src/data/repositories/external-repo.js';

// listSnapshotWeeks powers the ChestTracker tab's week-stepper arrows. The
// two invariants these tests pin down are exactly what the feature hinges
// on: each game-week collapses to its LAST (most-recently-fetched)
// snapshot — a week accumulates a fresh snapshot row on every upstream
// change — and rows stay scoped to the right week and share code.

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
  shareCode: string;
  windowStart: string;
  windowEnd: string;
  fetchedAt: string;
  players: number;
}): number {
  return insertSnapshot({
    clanId: 1,
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

describe('listSnapshotWeeks', () => {
  let cleanup: () => void;

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
  });

  afterEach(() => {
    cleanup();
  });

  const WEEK1_START = '2026-06-07T17:00:00.000Z';
  const WEEK1_END = '2026-06-14T17:00:00.000Z';
  const WEEK2_START = '2026-06-14T17:00:00.000Z';
  const WEEK2_END = '2026-06-21T17:00:00.000Z';

  it('returns one row per week — the last snapshot of each week — newest week first', () => {
    // Week 1: three snapshots fetched over the course of the week. The
    // LAST one (latest fetched_at) has 9 players and is the canonical row.
    insert({ shareCode: 'CODE1', windowStart: WEEK1_START, windowEnd: WEEK1_END, fetchedAt: '2026-06-08T00:00:00.000Z', players: 3 });
    insert({ shareCode: 'CODE1', windowStart: WEEK1_START, windowEnd: WEEK1_END, fetchedAt: '2026-06-11T00:00:00.000Z', players: 7 });
    const week1Last = insert({ shareCode: 'CODE1', windowStart: WEEK1_START, windowEnd: WEEK1_END, fetchedAt: '2026-06-14T16:00:00.000Z', players: 9 });

    // Week 2 (more recent): two snapshots; last has 5 players.
    insert({ shareCode: 'CODE1', windowStart: WEEK2_START, windowEnd: WEEK2_END, fetchedAt: '2026-06-15T00:00:00.000Z', players: 2 });
    const week2Last = insert({ shareCode: 'CODE1', windowStart: WEEK2_START, windowEnd: WEEK2_END, fetchedAt: '2026-06-20T00:00:00.000Z', players: 5 });

    const weeks = listSnapshotWeeks({ shareCode: 'CODE1' });

    expect(weeks).toHaveLength(2);
    // Newest week first.
    expect(weeks[0].windowStart).toBe(WEEK2_START);
    expect(weeks[1].windowStart).toBe(WEEK1_START);
    // Each row is the LAST snapshot of its week.
    expect(weeks[0].id).toBe(week2Last);
    expect(weeks[0].playerCount).toBe(5);
    expect(weeks[1].id).toBe(week1Last);
    expect(weeks[1].playerCount).toBe(9);
  });

  it('scopes to the requested share code', () => {
    insert({ shareCode: 'CODE1', windowStart: WEEK1_START, windowEnd: WEEK1_END, fetchedAt: '2026-06-08T00:00:00.000Z', players: 3 });
    insert({ shareCode: 'OTHER', windowStart: WEEK1_START, windowEnd: WEEK1_END, fetchedAt: '2026-06-08T00:00:00.000Z', players: 99 });

    const weeks = listSnapshotWeeks({ shareCode: 'CODE1' });

    expect(weeks).toHaveLength(1);
    expect(weeks[0].playerCount).toBe(3);
  });

  it('returns an empty array when the share code has no snapshots', () => {
    expect(listSnapshotWeeks({ shareCode: 'NONE' })).toEqual([]);
  });
});
