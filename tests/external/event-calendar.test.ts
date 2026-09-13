import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The occurrence upper-bound extension calls into session-repo (which needs a
// DB). Stub it — most tests want the un-extended window (reset boundary), and
// the extension test drives the mock explicitly.
vi.mock('../../src/data/repositories/session-repo.js', () => ({
  getFirstCompletedAtOrAfter: vi.fn(() => null),
}));
// Same for the rolling-cycle floor (the clan's oldest chest for the event).
vi.mock('../../src/data/repositories/event-repo.js', () => ({
  getEventDataStart: vi.fn(() => null),
}));

import { getEventOccurrences, getEventSchedule } from '../../src/external/event-calendar.js';
import { getFirstCompletedAtOrAfter } from '../../src/data/repositories/session-repo.js';
import { getEventDataStart } from '../../src/data/repositories/event-repo.js';
import { gameDateFor } from '../../src/utils/game-day.js';

// A hand-built feed exercising every grouping case:
//  - Ancients: "Ancients' Treasure" (day 1) + back-to-back "Rise of the
//    Ancients" (day 2) → fused into ONE 2-day occurrence.
//  - Olympus: five contiguous "Day x/5" rows → one 5-day occurrence.
//  - Ragnarök: a run the feed truncated to its "Day 2/2" row → still 2 days,
//    reconstructed from the label (see declaredRunSpan).
//  - Runics (Pursuit of Experience): two 1-day runs with a gap → two
//    occurrences; a third run in the FUTURE (relative to the pinned clock) is
//    dropped.
//  - Dark Omens: a run straddling "now" → isCurrent.
//  - Trade Routes: an untracked event → ignored entirely.
const V = (uid: string, summary: string, start: string, end: string, desc = '') =>
  [
    'BEGIN:VEVENT',
    `UID:${uid}@tbclanportal.com`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${summary}`,
    desc ? `DESCRIPTION:${desc}` : 'STATUS:CONFIRMED',
    'END:VEVENT',
  ].join('\r\n');

const ICS = [
  'BEGIN:VCALENDAR',
  V('tr', '🚚 Trade Routes', '20260705T170000Z', '20260706T170000Z'), // untracked
  V('at', "💎 Ancients' Treasure", '20260706T170000Z', '20260707T170000Z'),
  V('roa', '🛕 Rise of the Ancients', '20260707T170000Z', '20260708T170000Z'), // contiguous → merges
  V('ol1', '🏛️ Trials of Olympus - Chimera (Day 1/5)', '20260702T170000Z', '20260703T170000Z'),
  V('ol2', '🏛️ Trials of Olympus - Basilisk (Day 2/5)', '20260703T170000Z', '20260704T170000Z'),
  V('ol3', '🏛️ Trials of Olympus - Tartaros (Day 3/5)', '20260704T170000Z', '20260705T170000Z'),
  V('ol4', '🏛️ Trials of Olympus - Lava Fountains (Day 4/5)', '20260705T170000Z', '20260706T170000Z'),
  V('ol5', '🏛️ Trials of Olympus - Briareus (Day 5/5)', '20260706T170000Z', '20260707T170000Z'),
  V('px1', '📚 Pursuit of Experience', '20260704T170000Z', '20260705T170000Z'),
  V('px2', '📚 Pursuit of Experience', '20260710T170000Z', '20260711T170000Z'),
  V('px3', '📚 Pursuit of Experience', '20260725T170000Z', '20260726T170000Z'), // future → dropped
  V('do', '👹 Dark Omens (Day 1/2)', '20260718T170000Z', '20260720T170000Z'),
  // Ragnarök: the feed dropped day 1 of a 2-day run and kept only day 2.
  V('rg2', '⚡ Ragnarök (Day 2/2)', '20260713T170000Z', '20260714T170000Z'),
  'END:VCALENDAR',
].join('\r\n');

// Pin the clock: mid-day Jul 19 sits inside the Dark Omens run and before the
// Jul-25 Runics run.
const NOW = Date.parse('2026-07-19T12:00:00.000Z');

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

describe('getEventOccurrences', () => {
  it('merges the two Ancients events into one 2-day occurrence, newest first', async () => {
    const occ = await getEventOccurrences('ancients');
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({
      from: '2026-07-06T17:00:00.000Z',
      to: '2026-07-08T17:00:00.000Z', // Rise's DTEND, i.e. the two fused
      label: 'Jul 6–7',
      isCurrent: false,
    });
  });

  it('fuses contiguous multi-day rows (Olympus) into one span', async () => {
    const occ = await getEventOccurrences('olympus');
    expect(occ).toHaveLength(1);
    expect(occ[0].from).toBe('2026-07-02T17:00:00.000Z');
    expect(occ[0].to).toBe('2026-07-07T17:00:00.000Z');
    expect(occ[0].label).toBe('Jul 2–6');
  });

  it('spans the whole declared run when the feed omitted days of it', async () => {
    // The feed carried only "Ragnarök (Day 2/2)" — the real-world 2026-09-03
    // Dark Omens shape. The label alone has to reconstruct both game days, or
    // day 1's chests fall outside the window and the total reads as a quiet run.
    const occ = await getEventOccurrences('ragnarok');
    expect(occ).toHaveLength(1);
    expect(occ[0].from).toBe('2026-07-12T17:00:00.000Z');
    expect(occ[0].resetAt).toBe('2026-07-14T17:00:00.000Z');
    expect(occ[0].label).toBe('Jul 12–13');
  });

  it('keeps gapped same-event runs separate and drops future runs', async () => {
    const occ = await getEventOccurrences('runics');
    // Jul 4 and Jul 10 are started; Jul 25 is in the future → excluded.
    expect(occ.map((o) => o.label)).toEqual(['Jul 10', 'Jul 4']);
    expect(occ.every((o) => o.to > o.from)).toBe(true);
  });

  it('flags the in-progress run as current', async () => {
    const occ = await getEventOccurrences('dark-omens');
    expect(occ).toHaveLength(1);
    expect(occ[0].isCurrent).toBe(true);
  });

  it('ignores untracked calendar events', async () => {
    // Trade Routes is in the feed but maps to no catalog event.
    const ancients = await getEventOccurrences('ancients');
    expect(ancients.every((o) => o.from !== '2026-07-05T17:00:00.000Z')).toBe(true);
  });

  it('returns nothing for events with neither a calendar mapping nor a cycle', async () => {
    expect(await getEventOccurrences('citadels')).toEqual([]);
  });

  it('extends the upper bound to the first scan after the reset (scan-tail)', async () => {
    // A completed scan 3h after the Olympus reset should push `to` out to it.
    vi.mocked(getFirstCompletedAtOrAfter).mockReturnValue('2026-07-07T20:00:00.000Z');
    const occ = await getEventOccurrences('olympus', 1);
    expect(occ[0].to).toBe('2026-07-07T20:00:00.000Z');
  });

  it('keeps resetAt on the closing reset when the scan-tail extends `to`', async () => {
    // The might chart's bands are derived from resetAt precisely so a trailing
    // scan can't stretch a 5-day run over a 6th game day. Same feed and mock as
    // the test above, so the two bounds are guaranteed to differ here.
    vi.mocked(getFirstCompletedAtOrAfter).mockReturnValue('2026-07-07T20:00:00.000Z');
    const occ = await getEventOccurrences('olympus', 1);
    expect(occ[0].to).toBe('2026-07-07T20:00:00.000Z');
    expect(occ[0].resetAt).toBe('2026-07-07T17:00:00.000Z');
    // resetAt is exclusive, so the last game day it covers is the one before it —
    // which is exactly the span the label already describes.
    expect(occ[0].label).toBe('Jul 2–6');
    expect(gameDateFor(Date.parse(occ[0].from), 17)).toBe('2026-07-02');
    expect(gameDateFor(Date.parse(occ[0].resetAt) - 1, 17)).toBe('2026-07-06');
  });

  it('never lets the scan-tail extension bleed into the next occurrence', async () => {
    // A late scan pushed past the NEXT Runics run must clamp at its start.
    vi.mocked(getFirstCompletedAtOrAfter).mockReturnValue('2026-07-15T00:00:00.000Z');
    const occ = await getEventOccurrences('runics', 1);
    const jul4 = occ.find((o) => o.label === 'Jul 4');
    // Clamped to the Jul-10 run's start, not the far-future scan time.
    expect(jul4?.to).toBe('2026-07-10T17:00:00.000Z');
  });
});

// Triumphal: not in the feed at all — 30-day windows computed from the catalog
// anchor (2026-07-24 17:00 UTC). The pinned clock sits BEFORE that anchor, so
// these also cover the negative-index path (an anchor read off today's in-game
// timer still has to describe every earlier cycle).
describe('getEventOccurrences — rolling cycle (Triumphal)', () => {
  it('derives the current 30-day cycle from the anchor, no feed involved', async () => {
    const occ = await getEventOccurrences('triumphal');
    expect(occ).toHaveLength(1); // no clan → floored at the current cycle
    expect(occ[0]).toMatchObject({
      from: '2026-06-24T17:00:00.000Z', // one cycle back from the anchor
      to: '2026-07-24T17:00:00.000Z', // …which is the anchor itself
      label: 'Jun 24 – Jul 23',
      isCurrent: true,
    });
  });

  it('walks back to the cycle holding the clan\'s oldest chest, newest first', async () => {
    vi.mocked(getEventDataStart).mockReturnValue('2026-05-02T09:00:00.000Z');
    const occ = await getEventOccurrences('triumphal', 1);
    expect(occ.map((o) => o.from)).toEqual([
      '2026-06-24T17:00:00.000Z',
      '2026-05-25T17:00:00.000Z',
      '2026-04-25T17:00:00.000Z', // the cycle May 2 falls in — the floor
    ]);
    // Back-to-back: every window ends exactly where the next one begins.
    expect(occ.map((o) => o.to)).toEqual([
      '2026-07-24T17:00:00.000Z',
      '2026-06-24T17:00:00.000Z',
      '2026-05-25T17:00:00.000Z',
    ]);
    expect(occ.filter((o) => o.isCurrent)).toHaveLength(1);
  });

  it('never extends a cycle past its reset (that would steal the next cycle)', async () => {
    vi.mocked(getEventDataStart).mockReturnValue('2026-05-02T09:00:00.000Z');
    vi.mocked(getFirstCompletedAtOrAfter).mockReturnValue('2026-05-26T04:00:00.000Z');
    const occ = await getEventOccurrences('triumphal', 1);
    const older = occ[occ.length - 1];
    expect(older.to).toBe('2026-05-25T17:00:00.000Z'); // the reset, not the scan
    expect(getFirstCompletedAtOrAfter).not.toHaveBeenCalled();
  });
});

describe('getEventSchedule', () => {
  it('reports a rolling cycle as not-live, with the next reset', async () => {
    // Always running, so a "Live now" badge says nothing — the reset does.
    expect(await getEventSchedule('triumphal')).toEqual({
      next: null,
      live: false,
      cycleEndsAt: '2026-07-24T17:00:00.000Z',
    });
  });

  it('still flags a feed event that is running now, with no cycle end', async () => {
    const s = await getEventSchedule('dark-omens');
    expect(s.live).toBe(true);
    expect(s.cycleEndsAt).toBeNull();
  });

  it('reports the next upcoming run for a feed event', async () => {
    const s = await getEventSchedule('runics');
    expect(s.live).toBe(false);
    expect(s.next?.from).toBe('2026-07-25T17:00:00.000Z');
    expect(s.next?.label).toBe('Jul 25');
  });
});
