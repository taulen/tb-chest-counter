import { describe, it, expect, vi } from 'vitest';
import { ScanLoop } from '../../src/scheduler/loop.js';

// getScanActivity only reads in-memory flags, so the loop is built with inert
// collaborators and the flags are set directly — the states it reports are
// the ones runCycle / runSingleScan / finishScan leave behind.
type LoopState = {
  scanInProgress: boolean;
  scanStartedAt: number | null;
  mightCaptureInProgress: boolean;
  resourceCaptureInProgress: boolean;
  cycleOrder: number[];
  cycleDoneCount: number;
  clanId: number;
};

function makeLoop(state: Partial<LoopState>): ScanLoop {
  const loop = new ScanLoop({ scanIntervalMs: 60_000 } as never, {} as never, {} as never);
  Object.assign(loop as unknown as LoopState, state);
  return loop;
}

describe('ScanLoop.getScanActivity', () => {
  it('is null when nothing runs', () => {
    expect(makeLoop({}).getScanActivity()).toBeNull();
  });

  it('reports a single-clan manual scan without a cycle position', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const activity = makeLoop({ scanInProgress: true, scanStartedAt: 40_000, clanId: 3 }).getScanActivity();
    vi.useRealTimers();
    expect(activity).toEqual({
      clanId: 3, phase: 'scan', elapsedMs: 60_000, cyclePosition: null, cycleTotal: null,
    });
  });

  it('places a cycle scan in the cycle', () => {
    const activity = makeLoop({
      scanInProgress: true, scanStartedAt: Date.now(), clanId: 5, cycleOrder: [1, 5, 7], cycleDoneCount: 1,
    }).getScanActivity();
    expect(activity).toMatchObject({ clanId: 5, phase: 'scan', cyclePosition: 2, cycleTotal: 3 });
  });

  it('keeps reporting across the gap between two clans of a cycle', () => {
    // runCycle has moved on to clan 7 (setActiveClan before the browser launch)
    // while scanInProgress is false.
    const activity = makeLoop({ clanId: 7, cycleOrder: [1, 5, 7], cycleDoneCount: 2 }).getScanActivity();
    expect(activity).toEqual({
      clanId: 7, phase: 'starting', elapsedMs: null, cyclePosition: 3, cycleTotal: 3,
    });
  });

  it('is idle once every clan of the cycle is done', () => {
    expect(makeLoop({ cycleOrder: [1, 5], cycleDoneCount: 2 }).getScanActivity()).toBeNull();
  });

  it('names the post-scan phases', () => {
    const base = { scanInProgress: true, scanStartedAt: Date.now() };
    expect(makeLoop({ ...base, mightCaptureInProgress: true }).getScanActivity()?.phase).toBe('might');
    expect(makeLoop({ ...base, resourceCaptureInProgress: true }).getScanActivity()?.phase).toBe('resources');
  });

  it('tells a calibration capture apart from a scan', () => {
    expect(makeLoop({ scanInProgress: true }).getScanActivity()).toMatchObject({ phase: 'calibration', elapsedMs: null });
  });
});
