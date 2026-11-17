// Capture Health on System plots the last N scans. A session that is running
// right now and one a crash abandoned look identical in scan_sessions —
// pending, no completed_at — so the chart drew the live scan as a red
// "never completed" bar for its whole run. The scheduler's in-progress flag is
// what tells them apart; these tests pin how getScanHealthSeries uses it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession, getScanHealthSeries, updateSession } from '../../../src/data/repositories/session-repo.js';
import { ScanStatus } from '../../../src/models/enums.js';
import { getDb } from '../../../src/data/database.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

describe('getScanHealthSeries — the scan in progress', () => {
  let cleanup: () => void;
  let clanId: number;

  /** A session started at `startIso`, optionally finished `minutes` later. */
  function session(startIso: string, minutes: number | null, status?: ScanStatus): number {
    const id = createSession('scheduled', clanId).id;
    getDb().prepare('UPDATE scan_sessions SET started_at = ? WHERE id = ?').run(startIso, id);
    if (minutes !== null) {
      updateSession(id, clanId, {
        status: status ?? ScanStatus.COMPLETED,
        completedAt: new Date(Date.parse(startIso) + minutes * 60_000).toISOString(),
      });
    } else if (status) {
      updateSession(id, clanId, { status });
    }
    return id;
  }

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
    clanId = seedTwoClans().clanIdA;
  });

  afterEach(() => cleanup());

  it('flags only the newest open session as running, with its time so far', () => {
    const abandoned = session('2026-11-13T08:00:00.000Z', null);
    session('2026-11-13T09:00:00.000Z', 10);
    const live = session('2026-11-13T10:00:00.000Z', null);

    const now = Date.parse('2026-11-13T10:12:00.000Z');
    const series = getScanHealthSeries(clanId, 10, { scanRunning: true, now });

    const byId = new Map(series.map((s) => [s.id, s]));
    expect(byId.get(live)).toMatchObject({ running: true, durationMs: null, elapsedMs: 12 * 60_000 });
    // An older open row is a crash leftover, not a second live scan.
    expect(byId.get(abandoned)).toMatchObject({ running: false, durationMs: null, elapsedMs: null });
    expect(series.filter((s) => s.running)).toHaveLength(1);
  });

  it('marks nothing running when the scheduler is not scanning this clan', () => {
    session('2026-11-13T09:00:00.000Z', 10);
    session('2026-11-13T10:00:00.000Z', null);

    const series = getScanHealthSeries(clanId, 10, { scanRunning: false });
    expect(series.some((s) => s.running)).toBe(false);
    expect(series.at(-1)).toMatchObject({ durationMs: null, elapsedMs: null });
  });

  it('never reaches past a finalised newest row to an older open one', () => {
    // The newest row already failed (finalised without completed_at), so the
    // in-progress flag belongs to nothing on the chart — e.g. the post-scan
    // might/resource phases. The open row behind it is a leftover.
    session('2026-11-13T08:00:00.000Z', null);
    session('2026-11-13T09:00:00.000Z', 10);
    session('2026-11-13T10:00:00.000Z', null, ScanStatus.FAILED);

    const series = getScanHealthSeries(clanId, 10, { scanRunning: true });
    expect(series.some((s) => s.running)).toBe(false);
  });
});

describe('getScanHealthSeries — every clan (System is instance-wide)', () => {
  let cleanup: () => void;
  beforeEach(() => { cleanup = makeTestDb().cleanup; });
  afterEach(() => cleanup());

  it('lists every clan’s scans oldest first, each with its clan, and marks the live one of the running clan', () => {
    const { clanIdA, clanIdB } = seedTwoClans();
    const make = (clan: number, startIso: string, minutes: number | null) => {
      const id = createSession('scheduled', clan).id;
      getDb().prepare('UPDATE scan_sessions SET started_at = ? WHERE id = ?').run(startIso, id);
      if (minutes !== null) {
        updateSession(id, clan, { status: ScanStatus.COMPLETED, completedAt: new Date(Date.parse(startIso) + minutes * 60_000).toISOString() });
      }
      return id;
    };
    make(clanIdA, '2026-11-17T01:00:00.000Z', 1);
    make(clanIdB, '2026-11-17T01:01:00.000Z', 1);
    const live = make(clanIdB, '2026-11-17T02:00:00.000Z', null);

    const series = getScanHealthSeries(null, 10, { runningClanId: clanIdB, now: Date.parse('2026-11-17T02:00:30.000Z') });
    expect(series.map((s) => s.clanId)).toEqual([clanIdA, clanIdB, clanIdB]);
    expect(series.every((s) => typeof s.clanName === 'string' && s.clanName.length > 0)).toBe(true);
    expect(series.find((s) => s.running)?.id).toBe(live);
  });

  it('marks every clan scanning at once as running (parallel lanes)', () => {
    const { clanIdA, clanIdB } = seedTwoClans();
    const open = (clan: number, startIso: string) => {
      const id = createSession('scheduled', clan).id;
      getDb().prepare('UPDATE scan_sessions SET started_at = ? WHERE id = ?').run(startIso, id);
      return id;
    };
    const a = open(clanIdA, '2026-11-17T02:00:00.000Z');
    const b = open(clanIdB, '2026-11-17T02:00:05.000Z');
    const series = getScanHealthSeries(null, 10, { runningClanIds: [clanIdA, clanIdB], now: Date.parse('2026-11-17T02:01:00.000Z') });
    expect(series.filter((s) => s.running).map((s) => s.id).sort()).toEqual([a, b].sort());
  });
});
