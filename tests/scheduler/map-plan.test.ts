// The map pass's tile plan: what a scan reads, in which order, and what it
// skips — a member's vault tiles once their vault is found, and everything
// vault-related when no vaults are being raised.

import { describe, expect, it } from 'vitest';
import { TilePlan } from '../../src/scheduler/map-plan.js';

/** Read the whole plan the way the map pass does: batch by batch, calling `onBatch` after each. */
function drain(plan: TilePlan, size: number, onBatch: (batch: number[]) => void = () => {}): number[][] {
  const batches: number[][] = [];
  for (let batch = plan.next(size); batch.length; batch = plan.next(size)) {
    batches.push(batch);
    plan.markRead(batch);
    onBatch(batch);
  }
  return batches;
}

describe('TilePlan', () => {
  it('reads own tiles, then standing vaults, each tile once', () => {
    const plan = new TilePlan({
      own: [10, 11, -1], track: [11, 12], reach: new Map([[1, [10, 20, 21]]]), found: [], search: false,
    });
    expect(drain(plan, 9)).toEqual([[10, 11, 12]]);
    expect(plan.readCount).toBe(3);
  });

  it('reads no vault reach while vaults are not being raised', () => {
    const plan = new TilePlan({ own: [1], track: [], reach: new Map([[7, [1, 2, 3, 4]]]), found: [], search: false });
    expect(drain(plan, 9)).toEqual([[1]]);
    expect(plan.stillSearching).toBe(0);
  });

  it('skips the reach of members whose vault was found on an earlier scan', () => {
    const plan = new TilePlan({
      own: [], track: [], reach: new Map([[7, [1, 2]], [8, [3, 4]]]), found: [7], search: true,
    });
    expect(drain(plan, 9)).toEqual([[3, 4]]);
  });

  it('drops a member\'s remaining tiles once a batch turns up their vault', () => {
    const plan = new TilePlan({
      own: [], track: [], reach: new Map([[7, [1, 2, 3, 4]], [8, [5, 6]]]), found: [], search: true,
    });
    const batches = drain(plan, 2, (batch) => {
      if (batch.includes(1)) plan.markFound(7);  // member 7's vault stands on tile 1
    });
    expect(batches).toEqual([[1, 2], [5, 6]]);
    expect(plan.stillSearching).toBe(1);
  });

  it('starts searching mid-pass when a new vault turns up on an own tile', () => {
    const plan = new TilePlan({
      own: [1, 2], track: [], reach: new Map([[7, [1, 9]], [8, [2, 8]]]), found: [], search: false,
    });
    const batches = drain(plan, 2, (batch) => {
      if (batch.includes(1)) {
        plan.markFound(7);
        plan.startSearch();
      }
    });
    // Member 7's vault was on its own tile; only member 8's other tile is left to search.
    expect(batches).toEqual([[1, 2], [8]]);
    expect(plan.isSearching).toBe(true);
  });
});
