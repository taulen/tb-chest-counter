/**
 * Splitting a Rise of the Ancients run into summons (data/summon-windows.ts):
 * a summon starts when "Summons left" drops, ends on a flat read, 50 minutes
 * or the next summon; back-to-back summons the reads can't separate are ONE
 * column — never an invented split.
 */
import { describe, expect, it } from 'vitest';
import { MAX_SUMMON_MS, pointsPerGroup, splitSummons, type SummonRead } from '../../src/data/summon-windows.js';

const T0 = Date.parse('2026-11-22T17:30:00Z');
const MIN = 60_000;
/** A read `m` minutes into the run. */
const at = (m: number, left: number | null, changed: number, total = 0, max: number | null = 2): SummonRead =>
  ({ at: T0 + m * MIN, left, max, changed, total });
const shape = (reads: SummonRead[], now = T0 + 24 * 60 * MIN, running = true) =>
  splitSummons(reads, { now, running }).groups.map((g) => [g.first, g.last, g.from, g.to, g.live]);

describe('summon windows', () => {
  it('starts a summon when summons-left drops and ends it on the first flat read', () => {
    const reads = [at(0, 2, 0), at(10, 1, 30), at(20, 1, 25), at(30, 1, 0), at(40, 1, 0)];
    expect(shape(reads)).toEqual([[1, 1, 0, 4, false]]);
    const split = splitSummons(reads, { now: T0 + 45 * MIN, running: true });
    expect([split.used, split.left, split.max]).toEqual([1, 1, 2]);
  });

  it('calls a summon over 50 minutes after it started even without a flat read', () => {
    const reads = [at(0, 2, 0), at(5, 1, 30), at(30, 1, 12)];
    // 30 min in, still moving: live.
    expect(shape(reads, T0 + 31 * MIN)).toEqual([[1, 1, 0, 2, true]]);
    // Past 50 min since the drop was seen (min 5): over, whatever the last read said.
    expect(shape(reads, T0 + 5 * MIN + MAX_SUMMON_MS)).toEqual([[1, 1, 0, 2, false]]);
  });

  it('splits back-to-back summons when a flat read comes between', () => {
    const reads = [at(0, 2, 0), at(10, 1, 30), at(20, 1, 0), at(30, 0, 28), at(40, 0, 0)];
    // Summon 1: reads 0 → 2; summon 2: from read 2 (the flat one before the drop) to the end.
    expect(shape(reads)).toEqual([[1, 1, 0, 2, false], [2, 2, 2, 4, false]]);
  });

  it('keeps back-to-back summons as ONE column when nothing flat separates them', () => {
    // The second drop comes while the first summon is still scoring.
    const reads = [at(0, 3, 0), at(10, 2, 30), at(20, 1, 35), at(30, 1, 0)];
    expect(shape(reads)).toEqual([[1, 2, 0, 3, false]]);
  });

  it('is one column for two summons used between the same two reads', () => {
    const reads = [at(0, 3, 0), at(10, 1, 40), at(20, 1, 0)];
    expect(shape(reads)).toEqual([[1, 2, 0, 2, false]]);
    // A later, clearly separate summon still gets its own column.
    expect(shape([...reads, at(30, 0, 22), at(40, 0, 0)])).toEqual([[1, 2, 0, 2, false], [3, 3, 2, 4, false]]);
  });

  it('separates by the 50-minute limit when the reads have a gap', () => {
    // Summon 1 seen at min 5; no read for an hour (the session was gone); then summon 2.
    const reads = [at(0, 2, 0), at(5, 1, 30), at(70, 1, 40), at(75, 0, 20)];
    expect(shape(reads, T0 + 76 * MIN)).toEqual([[1, 1, 0, 2, false], [2, 2, 2, 3, true]]);
  });

  it('is live while scoring, and from the drop on even before any points move', () => {
    const now = T0 + 12 * MIN;
    expect(shape([at(0, 2, 0), at(10, 1, 0)], now)).toEqual([[1, 1, 0, 1, true]]); // summoned, nobody hit yet
    expect(shape([at(0, 2, 0), at(10, 1, 12)], now)).toEqual([[1, 1, 0, 1, true]]);
    expect(shape([at(0, 2, 0), at(10, 1, 12)], now, false)).toEqual([[1, 1, 0, 1, false]]); // the run is over
  });

  it('keeps a lull inside the same summon when summons-left did not drop', () => {
    const reads = [at(0, 2, 0), at(10, 1, 30), at(15, 1, 0), at(20, 1, 9)];
    expect(shape(reads, T0 + 21 * MIN)).toEqual([[1, 1, 0, 3, true]]);
  });

  it('counts summons used before the first read from the run\'s start', () => {
    // First read mid-run: 1 of 2 left and points already in.
    const reads = [at(0, 1, 50, 9000), at(10, 1, 0, 9000), at(20, 0, 30, 15000), at(30, 0, 0, 15000)];
    expect(shape(reads)).toEqual([[1, 1, null, 1, false], [2, 2, 1, 3, false]]);
  });

  it('falls back to movement after a flat read when summons-left is missing, without double counting', () => {
    const reads = [at(0, 2, 0), at(10, null, 30), at(20, null, 0), at(30, null, 25), at(40, 0, 0)];
    const split = splitSummons(reads, { now: T0 + 41 * MIN, running: true });
    expect(split.groups.map((g) => [g.first, g.last, g.from, g.to])).toEqual([[1, 1, 0, 2], [2, 2, 2, 4]]);
    expect([split.used, split.left, split.max]).toEqual([2, 0, 2]);
  });

  it('takes more summons than the Figurine says when the game shows more left (Seasonal Kingdom)', () => {
    const split = splitSummons([at(0, 5, 0, 0, 2), at(10, 4, 20, 0, 2)], { now: T0 + 11 * MIN, running: true });
    expect([split.used, split.left, split.max]).toEqual([1, 4, 5]);
    expect(split.groups.map((g) => [g.first, g.last])).toEqual([[1, 1]]);
  });

  it('gives each member their points per group: end read minus start read', () => {
    const reads = [at(0, 3, 0), at(10, 2, 2), at(20, 2, 0), at(30, 0, 2), at(40, 0, 0)];
    const { groups } = splitSummons(reads, { now: T0 + 41 * MIN, running: true });
    expect(groups.map((g) => [g.first, g.last])).toEqual([[1, 1], [2, 3]]); // 2 and 3 between the same reads
    const member = [0, 400, 400, 1000, 1000]; // points at each read
    expect(pointsPerGroup(groups, (i) => member[i])).toEqual([400, 600]);
  });

  it('has nothing to split without reads', () => {
    expect(splitSummons([], { now: T0, running: true })).toEqual({ groups: [], used: 0, left: null, max: null });
  });
});
