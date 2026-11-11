import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Two Olympus runs from the "feed"; every other event has no schedule and
// falls back to game weeks, which keeps the test offline.
vi.mock('../../src/external/event-calendar.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/external/event-calendar.js')>()),
  getEventOccurrences: vi.fn(async (key: string) => (key === 'olympus'
    ? [
      {
        from: '2026-11-01T17:00:00Z', to: '2026-11-06T17:00:00Z', resetAt: '2026-11-06T17:00:00Z',
        label: 'Nov 1–5', isCurrent: false, estimated: false,
      },
      {
        from: '2026-10-04T17:00:00Z', to: '2026-10-09T17:00:00Z', resetAt: '2026-10-09T17:00:00Z',
        label: 'Oct 4–8', isCurrent: false, estimated: false,
      },
    ]
    : [])),
}));

import { getDb } from '../../src/data/database.js';
import { getMemberEventsOverview } from '../../src/data/member-events.js';
import { saveTinmanSummon } from '../../src/data/repositories/tinman-repo.js';
import { makeTestDb } from '../helpers/test-db.js';

const CLAN = 1;
const ROLLOVER = 17;

let cleanup: () => void;

function member(name: string): number {
  const now = new Date().toISOString();
  return (getDb().prepare(
    `INSERT INTO members (clan_id, name, normalized_name, despaced_name, first_seen, last_seen, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id`,
  ).get(CLAN, name, name.toLowerCase(), name.toLowerCase(), now, now) as { id: number }).id;
}

function pasteOlympusDay(day: number, rows: Array<[string, number]>): void {
  saveTinmanSummon({
    clanId: CLAN, date: '2026-11-01', summon: day, uploadedBy: 'test', eventKey: 'olympus',
    rows: rows.map(([name, points], i) => ({ rank: i + 1, name, points })),
  });
}

async function olympusRuns(memberId: number) {
  const overview = await getMemberEventsOverview(CLAN, memberId, ROLLOVER);
  return overview.events.find((e) => e.key === 'olympus')!.runs;
}

beforeEach(() => {
  cleanup = makeTestDb().cleanup;
});
afterEach(() => cleanup());

describe('member events overview', () => {
  it('ranks an Olympus run with pasted scores by them, and an unpasted one by chests', async () => {
    const ace = member('Ace');
    const bolt = member('Bolt');
    pasteOlympusDay(1, [['Bolt', 40_000], ['Ace', 30_000], ['Stranger', 10_000]]);
    pasteOlympusDay(2, [['Ace', 120_000], ['Bolt', 90_000], ['Stranger', 15_000]]);

    const [latest, older] = await olympusRuns(ace);
    expect(latest).toMatchObject({
      runDay: '2026-11-01', source: 'scores', points: 120_000, rank: 1, participants: 3, chestPoints: 0,
    });
    // The October run was never pasted: chests decide it, and Ace had none.
    expect(older).toMatchObject({ runDay: '2026-10-04', source: 'chests', points: 0, rank: null });

    const [boltLatest] = await olympusRuns(bolt);
    expect(boltLatest).toMatchObject({ source: 'scores', points: 90_000, rank: 2, participants: 3 });
  });

  it('leaves a member off the pasted ranking unranked in that run', async () => {
    const absent = member('Absent');
    member('Ace');
    pasteOlympusDay(1, [['Ace', 30_000]]);

    const [latest] = await olympusRuns(absent);
    expect(latest).toMatchObject({ source: 'scores', points: 0, rank: null, participants: 1 });
  });
});
