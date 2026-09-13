import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

// Mock module bindings BEFORE importing the SUT. Vitest hoists vi.mock
// calls so this is safe to write at the top of the file.
vi.mock('../../src/external/chesttracker-client.js', () => ({
  fetchCounts: vi.fn(),
  fetchSettings: vi.fn(),
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

import { ingestSnapshot } from '../../src/external/ingest.js';
import {
  insertSnapshot,
  recordPollOutcome,
} from '../../src/data/repositories/external-repo.js';
import { fetchCounts, fetchSettings } from '../../src/external/chesttracker-client.js';

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
    });
    vi.mocked(fetchSettings).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.mocked(insertSnapshot).mockClear();
    vi.mocked(recordPollOutcome).mockClear();
    vi.mocked(fetchCounts).mockClear();
    vi.mocked(fetchSettings).mockClear();
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
