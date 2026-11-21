import { describe, expect, it } from 'vitest';
import { clanIntervalMs, dueAt, dueClanIds, joinEarlyMs, soonestDue } from '../../src/scheduler/scan-due.js';

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const MIN = 60_000;

describe('scan-due', () => {
  it("uses the clan's own interval, else the global one", () => {
    expect(clanIntervalMs(15, 90 * MIN)).toBe(15 * MIN);
    expect(clanIntervalMs(null, 90 * MIN)).toBe(90 * MIN);
  });

  it('is due a full interval after the last scan, and now with none on record', () => {
    expect(dueAt({ id: 2, intervalMs: 10 * MIN, lastScanAt: NOW - 4 * MIN }, NOW)).toBe(NOW + 6 * MIN);
    expect(dueAt({ id: 2, intervalMs: 10 * MIN, lastScanAt: null }, NOW)).toBe(NOW);
  });

  it('scans only the clans that are due, each on its own interval', () => {
    const clans = [
      { id: 2, intervalMs: 10 * MIN, lastScanAt: NOW - 11 * MIN }, // overdue
      { id: 5, intervalMs: 90 * MIN, lastScanAt: NOW - 11 * MIN }, // 79 min to go
      { id: 6, intervalMs: 90 * MIN, lastScanAt: null }, // never scanned
    ];
    expect(dueClanIds(clans, NOW)).toEqual([2, 6]);
    expect(soonestDue(clans, NOW)).toBe(NOW - MIN);
  });

  it('lets a clan join a cycle a little early, never more than a tenth of its interval', () => {
    expect(joinEarlyMs(90 * MIN)).toBe(MIN);
    expect(joinEarlyMs(5 * MIN)).toBe(30_000);
    const clans = [
      { id: 2, intervalMs: 90 * MIN, lastScanAt: NOW - 90 * MIN + 50_000 }, // due in 50 s: rides along
      { id: 5, intervalMs: 10 * MIN, lastScanAt: NOW - 10 * MIN + 61_000 }, // due in 61 s: waits
    ];
    expect(dueClanIds(clans, NOW)).toEqual([2]);
  });

  it('has no soonest scan without clans', () => {
    expect(soonestDue([], NOW)).toBeNull();
  });
});
