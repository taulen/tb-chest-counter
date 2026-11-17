import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

// Mock module bindings BEFORE importing the SUT. Vitest hoists vi.mock
// calls so this is safe to write at the top of the file.
vi.mock('../../src/external/chesttracker-client.js', () => ({
  fetchCounts: vi.fn(),
  computeCurrentWeekWindow: () => ({
    start: '2026-04-21',
    end: '2026-04-28',
    durationDays: 7,
  }),
}));

vi.mock('../../src/data/repositories/external-repo.js', () => ({
  insertSnapshot: vi.fn(() => 999),
  recordPollOutcome: vi.fn(),
  getSnapshotEtagForWindow: vi.fn(() => null),
}));

// loadConfig() is invoked to read gameDayRolloverUtcHour. Stub it so the
// test doesn't have to bootstrap a config file.
vi.mock('../../src/config/index.js', () => ({
  loadConfig: () => ({ gameDayRolloverUtcHour: 17 }),
}));

import { ingestSnapshot, overridePointsOf } from '../../src/external/ingest.js';
import {
  insertSnapshot,
  recordPollOutcome,
} from '../../src/data/repositories/external-repo.js';
import { fetchCounts } from '../../src/external/chesttracker-client.js';

describe('ingestSnapshot — clanId propagation', () => {
  beforeEach(() => {
    vi.mocked(fetchCounts).mockResolvedValue({
      status: 200,
      etag: 'etag-1',
      body: [
        [
          { name: 'Alice', guardsLevel: 0, points: 10, chests: 1 },
        ],
        [],
        {},
      ],
      clan: null,
    });
  });

  afterEach(() => {
    vi.mocked(insertSnapshot).mockClear();
    vi.mocked(recordPollOutcome).mockClear();
    vi.mocked(fetchCounts).mockClear();
  });

  it('threads the supplied clanId through to insertSnapshot', async () => {
    await ingestSnapshot({
      clanId: 7,
      shareCode: 'abc123',
      trigger: 'manual',
      start: '2026-04-21',
      end: '2026-04-28',
      durationDays: 7,
    });

    expect(vi.mocked(insertSnapshot)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(insertSnapshot).mock.calls[0][0];
    expect(arg.clanId).toBe(7);
  });

  it('threads the supplied clanId through to recordPollOutcome on success', async () => {
    await ingestSnapshot({
      clanId: 12,
      shareCode: 'abc123',
      trigger: 'scheduled',
      start: '2026-04-21',
      end: '2026-04-28',
      durationDays: 7,
    });

    expect(vi.mocked(recordPollOutcome)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(recordPollOutcome).mock.calls[0][0];
    expect(arg.clanId).toBe(12);
  });

  it('threads the supplied clanId through to recordPollOutcome on fetch failure', async () => {
    vi.mocked(fetchCounts).mockRejectedValueOnce(new Error('boom'));

    await expect(
      ingestSnapshot({
        clanId: 42,
        shareCode: 'abc123',
        trigger: 'scheduled',
        start: '2026-04-21',
        end: '2026-04-28',
        durationDays: 7,
      }),
    ).rejects.toThrow('boom');

    expect(vi.mocked(recordPollOutcome)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(recordPollOutcome).mock.calls[0][0];
    expect(arg.clanId).toBe(42);
  });

  // Phase A1 made clanId required at the type level. Calling
  // ingestSnapshot without it is now a TS compile error, so a
  // runtime test for the old "defaults to clan #1" behaviour no
  // longer applies. The compile-time check IS the regression test.
});

// The Nov 2026 API change: the clan settings now ride in the counts
// response (the /settings endpoint is gone) and a definition's override is
// `{ points }` instead of a number.
describe('ingestSnapshot — current API payload', () => {
  afterEach(() => {
    vi.mocked(insertSnapshot).mockClear();
  });

  it('stores the clan block as the snapshot settings and reads { points } overrides', async () => {
    const clan = {
      id: 'c1',
      status: 'active',
      lastScannedAt: '2026-11-17T21:26:14.000Z',
      settings: { requirement: [{ points: 6700 }], general: { scoring: { metric: 'points' } } },
    };
    vi.mocked(fetchCounts).mockResolvedValueOnce({
      status: 200,
      etag: 'etag-2',
      body: [
        [{ name: 'Alice', guardsLevel: 8, points: 120, chests: 2, 'epic crypt': { chests: 2 } }],
        [
          { type: 'Epic Crypt', name: 'Cobalt Chest', source: 'Level 35 Epic Crypt', points: 1000, override: { points: 120 } },
          { type: 'Ancients', name: 'Guardian Chest', source: 'Epic Ancient Squad', points: 0, override: null },
        ],
        {},
        [],
      ],
      clan,
    });

    await ingestSnapshot({ clanId: 6, shareCode: 'abc123', trigger: 'backfill' });

    const arg = vi.mocked(insertSnapshot).mock.calls[0][0];
    expect(JSON.parse(arg.settingsJson!)).toEqual(clan);
    expect(arg.definitions.map((d) => d.overridePoints)).toEqual([120, null]);
    expect(arg.players[0].categories).toEqual({ 'epic crypt': 2 });
  });
});

describe('overridePointsOf', () => {
  it('reads the { points } object, a bare number, and nothing', () => {
    expect(overridePointsOf({ points: 40 })).toBe(40);
    expect(overridePointsOf({ points: '25' })).toBe(25);
    expect(overridePointsOf({ points: null })).toBeNull();
    expect(overridePointsOf({})).toBeNull();
    expect(overridePointsOf(15)).toBe(15);
    expect(overridePointsOf(0)).toBe(0);
    expect(overridePointsOf(null)).toBeNull();
    expect(overridePointsOf(undefined)).toBeNull();
  });
});
