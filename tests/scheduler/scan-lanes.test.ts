/**
 * Scan lanes (scheduler/scan-lanes.ts): clans on different Total Battle
 * accounts scan at the same time, clans on one account one after another, and
 * a clan whose account is unknown runs alone.
 */
import { describe, expect, it } from 'vitest';
import { EXCLUSIVE, LaneQueue, SERIAL, laneKeyFor, planLanes, scanParallelEnabled } from '../../src/scheduler/scan-lanes.js';

/** A promise the test resolves by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('planLanes', () => {
  const accounts: Record<number, string | null> = { 2: 'tb:1', 3: 'tb:2', 5: 'tb:2', 7: null };
  const accountOf = (id: number) => accounts[id] ?? null;

  it('puts clans on one account in one lane, in cycle order, and unknown ones apart', () => {
    expect(planLanes([2, 3, 5, 7], accountOf, true)).toEqual({
      lanes: [{ key: 'acct:tb:1', clanIds: [2] }, { key: 'acct:tb:2', clanIds: [3, 5] }],
      exclusive: [7],
    });
  });

  it('is one serial lane with parallel scanning off', () => {
    expect(planLanes([2, 3, 5, 7], accountOf, false)).toEqual({ lanes: [{ key: SERIAL, clanIds: [2, 3, 5, 7] }], exclusive: [] });
  });

  it('keys lanes by account', () => {
    expect(laneKeyFor('tb:9', true)).toBe('acct:tb:9');
    expect(laneKeyFor(null, true)).toBe(EXCLUSIVE);
    expect(laneKeyFor('tb:9', false)).toBe(SERIAL);
  });

  it('reads the SCAN_PARALLEL switch (on unless 0/false/off)', () => {
    expect(scanParallelEnabled({})).toBe(true);
    expect(scanParallelEnabled({ SCAN_PARALLEL: '1' })).toBe(true);
    expect(scanParallelEnabled({ SCAN_PARALLEL: '0' })).toBe(false);
    expect(scanParallelEnabled({ SCAN_PARALLEL: 'false' })).toBe(false);
    expect(scanParallelEnabled({ SCAN_PARALLEL: 'off' })).toBe(false);
  });
});

describe('LaneQueue', () => {
  it('runs one lane in order and different lanes at the same time', async () => {
    const q = new LaneQueue();
    const log: string[] = [];
    const a1 = gate();
    const b1 = gate();
    const job = (name: string, g?: { promise: Promise<void> }) => async () => { log.push(`${name}+`); if (g) await g.promise; log.push(`${name}-`); };
    const p = [
      q.run('A', job('a1', a1)),
      q.run('A', job('a2')),
      q.run('B', job('b1', b1)),
    ];
    await tick();
    // a1 and b1 both started; a2 waits for a1.
    expect(log).toEqual(['a1+', 'b1+']);
    expect(q.pending('A')).toBe(2);
    b1.open();
    await tick();
    expect(log).toEqual(['a1+', 'b1+', 'b1-']);
    a1.open();
    await Promise.all(p);
    expect(log).toEqual(['a1+', 'b1+', 'b1-', 'a1-', 'a2+', 'a2-']);
    expect(q.idle()).toBe(true);
  });

  it('runs an exclusive job alone: after everything before it, before everything after it', async () => {
    const q = new LaneQueue();
    const log: string[] = [];
    const a = gate();
    const x = gate();
    const job = (name: string, g?: { promise: Promise<void> }) => async () => { log.push(`${name}+`); if (g) await g.promise; log.push(`${name}-`); };
    const p = [
      q.run('A', job('a', a)),
      q.run(EXCLUSIVE, job('x', x)),
      q.run('B', job('b')),
    ];
    await tick();
    expect(log).toEqual(['a+']); // x waits for A; B waits for x
    a.open();
    await tick();
    await tick();
    expect(log).toEqual(['a+', 'a-', 'x+']);
    x.open();
    await Promise.all(p);
    expect(log).toEqual(['a+', 'a-', 'x+', 'x-', 'b+', 'b-']);
  });

  it('keeps going after a failed job', async () => {
    const q = new LaneQueue();
    await expect(q.run('A', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(q.run('A', async () => 7)).resolves.toBe(7);
    expect(q.idle()).toBe(true);
  });
});
