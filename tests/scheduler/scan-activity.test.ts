import { describe, it, expect, vi } from 'vitest';
import { ScanLoop } from '../../src/scheduler/loop.js';

// getScanActivity / getScanOverview only read in-memory state, so the loop is
// built with inert collaborators and the state is set directly — the states
// they report are the ones runCycle / scanClan leave behind. Several clans
// scan at once when they are on different accounts (scan-lanes.ts).
type Run = { clanId: number; lane: string; startedAt: number; liveChestCount: number; progressMessage: string };
type LoopState = {
  runs: Map<number, Run>;
  cycle: { order: number[]; done: Set<number> } | null;
};

function makeLoop(state: { running?: Array<[number, number]>; order?: number[]; done?: number[] }): ScanLoop {
  const loop = new ScanLoop({ scanIntervalMs: 60_000 } as never);
  const s = loop as unknown as LoopState;
  for (const [clanId, startedAt] of state.running ?? []) {
    s.runs.set(clanId, { clanId, lane: `acct:${clanId}`, startedAt, liveChestCount: clanId, progressMessage: `p${clanId}` });
  }
  if (state.order) s.cycle = { order: state.order, done: new Set(state.done ?? []) };
  return loop;
}

describe('ScanLoop.getScanActivity', () => {
  it('is null when nothing runs', () => {
    expect(makeLoop({}).getScanActivity()).toBeNull();
  });

  it('reports a single-clan manual scan without a cycle position', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const activity = makeLoop({ running: [[3, 40_000]] }).getScanActivity();
    vi.useRealTimers();
    expect(activity).toEqual({
      clanId: 3, phase: 'scan', elapsedMs: 60_000, cyclePosition: null, cycleTotal: null,
    });
  });

  it('places a cycle scan in the cycle', () => {
    const activity = makeLoop({ running: [[5, Date.now()]], order: [1, 5, 7], done: [1] }).getScanActivity();
    expect(activity).toMatchObject({ clanId: 5, phase: 'scan', cyclePosition: 2, cycleTotal: 3 });
  });

  it('keeps reporting across the gap between two clans of a cycle', () => {
    // Clans 1 and 5 are done, nothing runs, clan 7 is up next.
    const activity = makeLoop({ order: [1, 5, 7], done: [1, 5] }).getScanActivity();
    expect(activity).toEqual({
      clanId: 7, phase: 'starting', elapsedMs: null, cyclePosition: 3, cycleTotal: 3,
    });
  });

  it('is idle once every clan of the cycle is done', () => {
    expect(makeLoop({ order: [1, 5], done: [1, 5] }).getScanActivity()).toBeNull();
  });
});

describe('ScanLoop.getScanOverview', () => {
  it('lists every clan scanning at once, oldest first, with the cycle progress', () => {
    const o = makeLoop({ running: [[2, 1_000], [3, 2_000]], order: [2, 3, 5], done: [] }).getScanOverview();
    expect(o?.clans.map((c) => [c.clanId, c.phase, c.progressMessage, c.liveChestCount])).toEqual([[2, 'scan', 'p2', 2], [3, 'scan', 'p3', 3]]);
    expect(o).toMatchObject({ cycleDone: 0, cycleTotal: 3 });
  });

  it('adds up the live chest count across lanes, or gives one clan\'s', () => {
    const loop = makeLoop({ running: [[2, 1_000], [3, 2_000]] });
    expect(loop.getLiveChestCount()).toBe(5);
    expect(loop.getLiveChestCount(3)).toBe(3);
    expect(loop.getProgressMessage(3)).toBe('p3');
    expect(loop.getRunningClanIds()).toEqual([2, 3]);
    expect(loop.getState()).toBe('scanning');
  });
});
