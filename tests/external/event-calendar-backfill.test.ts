import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The calendar feed is a ROLLING window (~a month back), so a 24-day event has
// one or two past runs in it and the Events page's "older" arrow stops dead
// after a step or two — while "All time" keeps showing the clan's full history.
// Runs older than the feed's reach are reconstructed from the event's proven
// cadence. These tests pin the rules that keep that from inventing history.
//
// Its own file rather than a block in event-calendar.test.ts: the parsed feed is
// cached in module scope for 6h, so one fixture per file is the only way to run
// a second one.

vi.mock('../../src/data/repositories/session-repo.js', () => ({
  getFirstCompletedAtOrAfter: vi.fn(() => null),
}));
vi.mock('../../src/data/repositories/event-repo.js', () => ({
  getEventDataStart: vi.fn(() => null),
}));

import { getEventOccurrences, getEventSchedule } from '../../src/external/event-calendar.js';
import { getFirstCompletedAtOrAfter } from '../../src/data/repositories/session-repo.js';
import { getEventDataStart } from '../../src/data/repositories/event-repo.js';

const V = (uid: string, summary: string, start: string, end: string) =>
  [
    'BEGIN:VEVENT',
    `UID:${uid}@tbclanportal.com`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${summary}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
  ].join('\r\n');

// Ragnarök on its real shape: a 2-day run every 24 days. Three runs — Jun 25,
// Jul 19 (in progress at the pinned clock) and the future Aug 12 — which is the
// minimum that proves a period. The Aug 12 run is emitted as ONE unlabelled day
// so the "longest run wins" sizing rule has something to get wrong.
//
// Dark Omens is the irregular control: Jun 20 → Jun 26 → Jul 11 is 6 then 15
// days, so it must get no backfill at all.
const ICS = [
  'BEGIN:VCALENDAR',
  V('rg1a', '⚡ Ragnarök (Day 1/2)', '20260625T170000Z', '20260626T170000Z'),
  V('rg1b', '⚡ Ragnarök (Day 2/2)', '20260626T170000Z', '20260627T170000Z'),
  V('rg2a', '⚡ Ragnarök (Day 1/2)', '20260719T170000Z', '20260720T170000Z'),
  V('rg2b', '⚡ Ragnarök (Day 2/2)', '20260720T170000Z', '20260721T170000Z'),
  V('rg3', '⚡ Ragnarök', '20260812T170000Z', '20260813T170000Z'), // future, 1 day
  V('do1', '👹 Dark Omens', '20260620T170000Z', '20260621T170000Z'),
  V('do2', '👹 Dark Omens', '20260626T170000Z', '20260627T170000Z'),
  V('do3', '👹 Dark Omens', '20260711T170000Z', '20260712T170000Z'),
  'END:VCALENDAR',
].join('\r\n');

// Mid-day Jul 19: inside the second Ragnarök run, before the Aug 12 one.
const NOW = Date.parse('2026-07-19T20:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => ICS,
    })),
  );
  vi.mocked(getFirstCompletedAtOrAfter).mockReturnValue(null);
  vi.mocked(getEventDataStart).mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('getEventOccurrences — runs older than the feed window', () => {
  it('steps the proven cadence back to the clan\'s oldest chest', async () => {
    vi.mocked(getEventDataStart).mockReturnValue('2026-05-10T09:00:00.000Z');
    const occ = await getEventOccurrences('ragnarok', 1);
    expect(occ.map((o) => o.from)).toEqual([
      '2026-07-19T17:00:00.000Z', // feed, in progress
      '2026-06-25T17:00:00.000Z', // feed
      '2026-06-01T17:00:00.000Z', // reconstructed
      '2026-05-08T17:00:00.000Z', // reconstructed — the window May 10 falls in
    ]);
    // One more step back would end (2026-06-01) before the floor, so it stops.
    expect(occ.map((o) => o.estimated)).toEqual([false, false, true, true]);
    expect(occ[0].isCurrent).toBe(true);
  });

  it('sizes a reconstructed window by the LONGEST run seen, not the first', async () => {
    // The Aug 12 row is a single day — a feed that dropped the run's day 2, the
    // shape that already cost a Dark Omens run half its chests. Sizing off it
    // would halve every reconstructed window too.
    vi.mocked(getEventDataStart).mockReturnValue('2026-06-02T09:00:00.000Z');
    const occ = await getEventOccurrences('ragnarok', 1);
    const older = occ[occ.length - 1];
    expect(older.from).toBe('2026-06-01T17:00:00.000Z');
    expect(older.resetAt).toBe('2026-06-03T17:00:00.000Z'); // two game days
    expect(older.label).toBe('Jun 1–2');
  });

  it('reconstructs nothing when the cadence is irregular', async () => {
    // Dark Omens' gaps are 6 then 15 days — no period is proven, so the list
    // stays exactly what the feed carried however old the clan's data is.
    vi.mocked(getEventDataStart).mockReturnValue('2026-01-01T00:00:00.000Z');
    const occ = await getEventOccurrences('dark-omens', 1);
    expect(occ.map((o) => o.from)).toEqual([
      '2026-07-11T17:00:00.000Z',
      '2026-06-26T17:00:00.000Z',
      '2026-06-20T17:00:00.000Z',
    ]);
    expect(occ.every((o) => !o.estimated)).toBe(true);
  });

  it('reconstructs nothing without a clan, or before the clan\'s first chest', async () => {
    expect((await getEventOccurrences('ragnarok')).every((o) => !o.estimated)).toBe(true);
    // A clan whose oldest chest for the event is already inside the feed window
    // has no history to recover.
    vi.mocked(getEventDataStart).mockReturnValue('2026-07-01T00:00:00.000Z');
    const occ = await getEventOccurrences('ragnarok', 1);
    expect(occ.every((o) => !o.estimated)).toBe(true);
    expect(occ).toHaveLength(2);
  });

  it('caps the walk back however old the clan is', async () => {
    vi.mocked(getEventDataStart).mockReturnValue('2010-01-01T00:00:00.000Z');
    const occ = await getEventOccurrences('ragnarok', 1);
    expect(occ.filter((o) => o.estimated)).toHaveLength(60);
  });

  it('keeps reconstructed runs out of the schedule tag', async () => {
    // The tag answers "when is this next on" — a run from before the feed's
    // reach can neither be live nor upcoming.
    vi.mocked(getEventDataStart).mockReturnValue('2026-05-10T09:00:00.000Z');
    const s = await getEventSchedule('ragnarok');
    expect(s.live).toBe(true);
    expect(s.next?.from).toBe('2026-08-12T17:00:00.000Z');
  });

  it('still extends a reconstructed window to the first scan after its reset', async () => {
    // Reconstructed dates don't change what a window is for: chests claimed
    // just after the reset still belong to the run that earned them.
    vi.mocked(getEventDataStart).mockReturnValue('2026-06-02T09:00:00.000Z');
    vi.mocked(getFirstCompletedAtOrAfter).mockReturnValue('2026-06-03T21:00:00.000Z');
    const occ = await getEventOccurrences('ragnarok', 1);
    const older = occ[occ.length - 1];
    expect(older.to).toBe('2026-06-03T21:00:00.000Z');
    expect(older.resetAt).toBe('2026-06-03T17:00:00.000Z');
  });
});
