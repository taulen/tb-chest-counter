import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from '../helpers/test-db.js';
import { insertSnapshot, setConfigValue } from '../../src/data/repositories/external-repo.js';
import { readClanSettings } from '../../src/scheduler/external-loop.js';
import type { Clan } from '../../src/data/repositories/clan-repo.js';

// The initial backfill used to write its "done" marker even when every week
// had failed. When chesttracker.com changed its payload shape, VRG (clan 6)
// was added, all 52 weeks failed, and the marker said done — so the history
// was never fetched. A marker with no snapshot behind it must not count.

const CODE = 'QXL77TEST1';

function clan(): Clan {
  return { id: 6, ctShareCode: CODE, ctPollIntervalHours: 0.15, ctBackfillWeeks: 52 } as Clan;
}

describe('initial backfill marker', () => {
  let cleanup: () => void;

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
  });

  afterEach(() => {
    cleanup();
  });

  it('is not done without a marker', () => {
    expect(readClanSettings(clan()).initialBackfillDone).toBe(false);
  });

  it('is not done when the marker is set but nothing was ever stored', () => {
    setConfigValue(`initial_backfill_done:${CODE}`, 'true');
    expect(readClanSettings(clan()).initialBackfillDone).toBe(false);
  });

  it('is done once a snapshot exists for the code', () => {
    setConfigValue(`initial_backfill_done:${CODE}`, 'true');
    insertSnapshot({
      clanId: 6,
      fetchedAt: '2026-11-17T22:30:00.000Z',
      shareCode: CODE,
      windowStart: '2026-11-08T17:00:00.000Z',
      windowEnd: '2026-11-15T17:00:00.000Z',
      durationDays: 7,
      trigger: 'backfill',
      etag: null,
      settingsJson: null,
      players: [],
      definitions: [],
    });
    expect(readClanSettings(clan()).initialBackfillDone).toBe(true);
  });

  it('does not borrow another clan\'s snapshot under the same code', () => {
    setConfigValue(`initial_backfill_done:${CODE}`, 'true');
    insertSnapshot({
      clanId: 1,
      fetchedAt: '2026-11-17T22:30:00.000Z',
      shareCode: CODE,
      windowStart: '2026-11-08T17:00:00.000Z',
      windowEnd: '2026-11-15T17:00:00.000Z',
      durationDays: 7,
      trigger: 'backfill',
      etag: null,
      settingsJson: null,
      players: [],
      definitions: [],
    });
    expect(readClanSettings(clan()).initialBackfillDone).toBe(false);
  });
});
