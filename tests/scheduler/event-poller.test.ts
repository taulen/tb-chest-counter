/**
 * Rise of the Ancients between scans (scheduler/event-poller.ts): reads are
 * never further apart than 10 minutes while the event runs (5 while a summon
 * scores), each is two requests on the session the last scan left, and the
 * poller never reads while the clan's lane is busy or scanning is paused; a
 * failing or empty read drops the session until the next scan.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Frame, Wire } from '../../src/game-protocol/codec.js';
import type { GameClient } from '../../src/game-protocol/client.js';
import {
  POLL_ACTIVE_MS, POLL_IDLE_MS, POLL_TICK_MS, dropAllGameSessions, keepGameSession, keptSessionClans,
  pollDue, pollTick, setPollGateForTest, type PollGate,
} from '../../src/scheduler/event-poller.js';
import { listEventReads, saveEventRun } from '../../src/data/repositories/game-event-repo.js';
import { makeTestDb } from '../helpers/test-db.js';

describe('poll scheduling', () => {
  it('is due at once with no read, then at the interval (shorter while a summon scores)', () => {
    const t = Date.parse('2026-11-22T18:00:00Z');
    expect(pollDue(t, null, false)).toBe(true);
    expect(pollDue(t, t - 8 * 60_000, false)).toBe(false);
    expect(pollDue(t, t - 9.5 * 60_000, false)).toBe(true); // the last tick before 10 min
    expect(pollDue(t, t - 3 * 60_000, true)).toBe(false);
    expect(pollDue(t, t - 4.5 * 60_000, true)).toBe(true);
  });

  it('never leaves more than 10 minutes between reads while the event runs, 5 while a summon scores', () => {
    // A day of ticks once a minute; summons score 60–110 and 300–312 minutes in.
    const start = Date.parse('2026-11-22T17:00:00Z');
    const live = (t: number) => {
      const m = (t - start) / 60_000;
      return (m >= 60 && m < 110) || (m >= 300 && m < 312);
    };
    let last: number | null = null;
    const gaps: Array<{ gap: number; live: boolean }> = [];
    for (let t = start; t <= start + 24 * 60 * 60_000; t += POLL_TICK_MS) {
      if (pollDue(t, last, live(t))) {
        if (last !== null) gaps.push({ gap: t - last, live: live(t) && live(last) });
        last = t;
      }
    }
    expect(Math.max(...gaps.map((g) => g.gap))).toBeLessThanOrEqual(POLL_IDLE_MS);
    expect(Math.max(...gaps.filter((g) => g.live).map((g) => g.gap))).toBeLessThanOrEqual(POLL_ACTIVE_MS);
    // Cheap: about six reads an hour outside summons.
    expect(gaps.length).toBeLessThan(24 * 7 + 20);
  });
});

const frame = (type: number, body: Wire[]): Frame => ({ type, seq: 1, head: [type, 1], body, children: [], events: [] });

/** A stand-in for the game client: the window header and the standings, from `state`. */
function fakeClient(state: { left: number; points: number[]; fail?: boolean; empty?: boolean }) {
  const calls: number[] = [];
  const client = {
    async eventProgress(): Promise<Frame> {
      calls.push(38000);
      if (state.fail) throw new Error('no 38000 reply');
      return frame(38000, [[[242, 6053, state.left, 0, [0], [0, 0, 0]], { 1: [17, 80015], 2: [2, 6156], 3: [12, 40235] }]]);
    },
    async eventStandings(): Promise<Frame> {
      calls.push(38003);
      if (state.fail) throw new Error('no 38003 reply');
      return frame(38003, [[state.empty ? [] : state.points.map((p, i) => [[100 + i], p, i + 1])]]);
    },
  } as unknown as GameClient;
  return { client, calls };
}

describe('pollTick', () => {
  let cleanup: () => void;
  const CLAN = 1;
  let paused = false;
  let busy = false;
  const gate: PollGate = {
    paused: () => paused,
    laneBusy: () => busy,
    runOnLane: (_clanId, job) => job(),
    rolloverUtcHour: () => 17,
  };
  const nowSec = () => Math.floor(Date.now() / 1000);
  const RUN = { eventType: 1024, run: 1, occurrence: 242 };
  const liveRun = (endsInSec = 5 * 3600) => saveEventRun(CLAN, {
    type: 1024, run: 1, occurrence: 242, state: 1, startsAt: nowSec() - 3600, endsAt: nowSec() + endsInSec,
  }, { code: 'clandoom_epic', title: 'Rise of the Ancients' });

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    paused = false;
    busy = false;
    dropAllGameSessions();
    setPollGateForTest(gate);
  });
  afterEach(() => {
    setPollGateForTest(null);
    dropAllGameSessions();
    cleanup();
  });

  it('reads a running Rise of the Ancients with two requests and tags the read with its summon', async () => {
    liveRun();
    const { client, calls } = fakeClient({ left: 1, points: [5000, 3000] });
    keepGameSession(CLAN, client);
    expect(await pollTick()).toBe(1);
    expect(calls).toEqual([38000, 38003]);
    const reads = listEventReads(CLAN, RUN);
    expect(reads.map((r) => [r.source, r.summonsLeft, r.summonsMax, r.summonsUsed, r.members, r.totalPoints])).toEqual([
      ['poll', 1, 2, 1, 2, 8000],
    ]);
    // Not due again a minute later; due once the interval has passed.
    expect(await pollTick(Date.now() + 60_000)).toBe(0);
    expect(calls).toHaveLength(2);
    expect(await pollTick(Date.now() + POLL_IDLE_MS)).toBe(1);
    expect(calls).toHaveLength(4);
  });

  it('leaves a clan alone while its lane is busy, and when no Rise of the Ancients runs', async () => {
    const { client, calls } = fakeClient({ left: 2, points: [0] });
    keepGameSession(CLAN, client);
    expect(await pollTick()).toBe(0); // no run on record
    liveRun(-60); // ended a minute ago
    expect(await pollTick()).toBe(0);
    liveRun();
    busy = true;
    expect(await pollTick()).toBe(0);
    expect(calls).toEqual([]);
    expect(keptSessionClans()).toEqual([CLAN]); // still kept for later
  });

  it('reads nothing and forgets every session while scanning is paused (the login bridge)', async () => {
    liveRun();
    const { client, calls } = fakeClient({ left: 2, points: [0] });
    keepGameSession(CLAN, client);
    paused = true;
    expect(await pollTick()).toBe(0);
    expect(calls).toEqual([]);
    expect(keptSessionClans()).toEqual([]);
  });

  it('drops the session when a read fails or comes back empty, until the next scan keeps a new one', async () => {
    liveRun();
    const failing = fakeClient({ left: 2, points: [0], fail: true });
    keepGameSession(CLAN, failing.client);
    expect(await pollTick()).toBe(0);
    expect(keptSessionClans()).toEqual([]);

    const empty = fakeClient({ left: 2, points: [], empty: true });
    keepGameSession(CLAN, empty.client);
    expect(await pollTick()).toBe(0);
    expect(empty.calls).toEqual([38000, 38003]);
    expect(keptSessionClans()).toEqual([]);
    expect(listEventReads(CLAN, RUN)).toEqual([]);
  });
});
