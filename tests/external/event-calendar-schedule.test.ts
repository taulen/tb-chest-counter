import { afterEach, describe, expect, it, vi } from 'vitest';

// The feed is not the last word on an event's dates (Oct 2026): the game moved
// its 24-day rotation, tbclanportal only fixed Dark Omens after it had run
// (Oct 21 → Oct 15) and still listed the next Olympus on Oct 30 when it opened
// Oct 24. These tests pin the three things that answer that — the backfill
// surviving a moved run, the archive of runs the feed has forgotten, and
// superadmin corrections.
//
// The parsed feed is cached in module scope for 6h, so each test loads a fresh
// module graph (vi.resetModules) instead of sharing one fixture per file.

vi.mock('../../src/data/repositories/session-repo.js', () => ({
  getFirstCompletedAtOrAfter: vi.fn(() => null),
}));
vi.mock('../../src/data/repositories/event-repo.js', () => ({
  getEventDataStart: vi.fn(() => null),
}));
vi.mock('../../src/data/repositories/event-schedule-repo.js', () => ({
  listArchivedRuns: vi.fn(() => []),
  listCorrections: vi.fn(() => []),
  setCorrection: vi.fn(),
  syncArchivedRuns: vi.fn(),
}));
vi.mock('../../src/utils/log-buffer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/log-buffer.js')>()),
  resolveEntries: vi.fn(() => 0),
}));
// Clan SK_CLAN plays a Seasonal Kingdom; every other clan the normal one.
const SK_CLAN = 5;
vi.mock('../../src/data/repositories/clan-repo.js', () => ({
  clanCalendarRealm: vi.fn((id: number) => (id === 5 ? 'season' : 'default')),
}));

const DAY = 24 * 60 * 60 * 1000;
const at = (d: string) => Date.parse(`${d}T17:00:00.000Z`);
const ics = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** One run as the feed writes it: a "(Day i/n)" VEVENT per day. */
function run(summary: string, startDay: string, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const s = at(startDay) + i * DAY;
    const label = days > 1 ? ` (Day ${i + 1}/${days})` : '';
    out.push(
      ['BEGIN:VEVENT', `DTSTART:${ics(s)}`, `DTEND:${ics(s + DAY)}`, `SUMMARY:${summary}${label}`, 'END:VEVENT'].join('\r\n'),
    );
  }
  return out;
}

const feed = (...runs: string[][]) => ['BEGIN:VCALENDAR', ...runs.flat(), 'END:VCALENDAR'].join('\r\n');

const OMENS = '👹 Dark Omens';
const OLYMPUS = '🏛️ Trials of Olympus - Chimera';

// The feed as fetched on 2026-10-21: its window opens Sep 21 (an untracked
// event), Dark Omens carries the moved Oct 15 run, Olympus still says Oct 30.
const FEED_OCT21 = feed(
  run("🕷️ Arachne's Swarm", '2026-09-21', 1),
  run(OMENS, '2026-09-27', 2),
  run(OMENS, '2026-10-15', 2),
  run(OMENS, '2026-11-14', 2),
  run(OMENS, '2026-12-08', 2),
  run(OMENS, '2027-01-01', 2),
  run(OLYMPUS, '2026-10-06', 5),
  run(OLYMPUS, '2026-10-30', 5),
  run(OLYMPUS, '2026-11-23', 5),
  run(OLYMPUS, '2026-12-17', 5),
);

interface Setup {
  now: string;
  ics: string;
  /** The Seasonal Kingdom feed (feed.ics?realm=season); defaults to `ics`. */
  skIcs?: string;
  archived?: Record<string, Array<{ start: number; end: number }>>;
  corrections?: Array<{ eventKey: string; feed: string; actual: string; id?: number }>;
  dataStart?: string | null;
}

async function load(s: Setup) {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(s.now));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => (String(url).includes('realm=season') ? s.skIcs ?? s.ics : s.ics),
    })),
  );
  const repo = await import('../../src/data/repositories/event-schedule-repo.js');
  vi.mocked(repo.listArchivedRuns).mockImplementation(
    (k: string, realm = 'default') => (realm === 'default' ? s.archived?.[k] : undefined) ?? [],
  );
  vi.mocked(repo.listCorrections).mockReturnValue(
    (s.corrections ?? []).map((c, i) => ({
      id: c.id ?? i + 1,
      eventKey: c.eventKey,
      feedStartAt: new Date(at(c.feed)).toISOString(),
      actualStartAt: new Date(at(c.actual)).toISOString(),
      createdAt: s.now,
    })),
  );
  const events = await import('../../src/data/repositories/event-repo.js');
  vi.mocked(events.getEventDataStart).mockReturnValue(s.dataStart ?? null);
  const cal = await import('../../src/external/event-calendar.js');
  return { cal, repo };
}

const iso = (d: string) => new Date(at(d)).toISOString();

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a moved run', () => {
  it('no longer wipes the reconstructed history', async () => {
    // Gaps 18, 30, 24, 24: the old all-gaps-identical rule proved no period
    // and dropped Sep 3 and everything older from the page.
    const { cal } = await load({ now: '2026-10-21T19:00:00Z', ics: FEED_OCT21, dataStart: '2026-08-01T12:00:00Z' });
    const occ = await cal.getEventOccurrences('dark-omens', 1);
    expect(occ.map((o) => [o.from, o.estimated])).toEqual([
      [iso('2026-10-15'), false],
      [iso('2026-09-27'), false],
      [iso('2026-09-03'), true],
      [iso('2026-08-10'), true],
      [iso('2026-07-17'), true], // the window Aug 1 falls in
    ]);
  });

  it('as the earliest run, does not drag the projection with it', async () => {
    // Nov 1: Sep 27 has aged out and nothing archived it. Stepping back from
    // Oct 15 would invent Sep 21; the cadence anchors on Nov 14 instead, and
    // its Oct 21 projection is skipped because a real run already sits there.
    const ics = feed(
      run("🕷️ Arachne's Swarm", '2026-10-02', 1),
      run(OMENS, '2026-10-15', 2),
      run(OMENS, '2026-11-14', 2),
      run(OMENS, '2026-12-08', 2),
      run(OMENS, '2027-01-01', 2),
    );
    const { cal } = await load({ now: '2026-11-01T12:00:00Z', ics, dataStart: '2026-09-04T12:00:00Z' });
    const occ = await cal.getEventOccurrences('dark-omens', 1);
    expect(occ.map((o) => o.from)).toEqual([iso('2026-10-15'), iso('2026-09-27'), iso('2026-09-03')]);
  });
});

describe('the run archive', () => {
  it('supplies runs from before the feed window and ignores its copy inside it', async () => {
    // Nov 20: the feed opens Oct 21. Sep 27 and Oct 15 exist only in the
    // archive. Oct 25 is an archived row INSIDE the feed window that the feed
    // no longer lists — a run the portal moved — so it must not resurface.
    const ics = feed(
      run("🕷️ Arachne's Swarm", '2026-10-21', 1),
      run(OMENS, '2026-11-14', 2),
      run(OMENS, '2026-12-08', 2),
    );
    const span = (d: string) => ({ start: at(d), end: at(d) + 2 * DAY });
    const { cal } = await load({
      now: '2026-11-20T12:00:00Z',
      ics,
      archived: { 'dark-omens': [span('2026-09-27'), span('2026-10-15'), span('2026-10-25')] },
    });
    const occ = await cal.getEventOccurrences('dark-omens');
    expect(occ.map((o) => [o.from, o.estimated])).toEqual([
      [iso('2026-11-14'), false],
      [iso('2026-10-15'), false],
      [iso('2026-09-27'), false],
    ]);
  });

  it('is synced from each fetch with the feed horizon', async () => {
    const { cal, repo } = await load({ now: '2026-10-21T19:00:00Z', ics: FEED_OCT21 });
    await cal.getEventOccurrences('dark-omens');
    expect(repo.syncArchivedRuns).toHaveBeenCalledTimes(1);
    const [horizon, now, runs] = vi.mocked(repo.syncArchivedRuns).mock.calls[0];
    expect(horizon).toBe(at('2026-09-21'));
    expect(now).toBe(Date.parse('2026-10-21T19:00:00Z'));
    // Fused runs, not per-day rows: one entry per Olympus run, five days long.
    expect(runs).toContainEqual({ eventKey: 'olympus', start: at('2026-10-06'), end: at('2026-10-11') });
    expect(runs).toContainEqual({ eventKey: 'dark-omens', start: at('2026-10-15'), end: at('2026-10-17') });
  });
});

describe('the Tinman cadence check', () => {
  // Tinman days fall on 2026-10-23 + 6k. An Ancients run is Treasure the day
  // before, then Rise of the Ancients on the Tinman day itself.
  const ancients = (treasureDay: string, withRise = true) => [
    ...run("💎 Ancients' Treasure", treasureDay, 1),
    ...(withRise ? run('🛕 Rise of the Ancients', new Date(at(treasureDay) + DAY).toISOString().slice(0, 10), 1) : []),
  ];

  async function cadenceClean(ics: string, corrections?: Setup['corrections']): Promise<boolean> {
    const { cal } = await load({ now: '2026-10-26T08:00:00Z', ics, corrections });
    await cal.getEventOccurrences('ancients');
    const buffer = await import('../../src/utils/log-buffer.js');
    return vi.mocked(buffer.resolveEntries).mock.calls.some(([k]) => k === 'event-calendar:tinman-cadence');
  }

  it('ignores a last run the feed cut off before its Tinman day', async () => {
    // Feed fetched 2026-10-26: its window stopped after Treasure on 2027-01-26,
    // so that run seemed to end a day early and the warning fired.
    expect(await cadenceClean(feed(ancients('2026-10-22'), ancients('2026-10-28'), ancients('2026-11-03', false)))).toBe(true);
  });

  it('ignores the cut-off run even when a long event outlasts it', async () => {
    // Feed fetched 2026-11-07: the window's last starts were Treasure 2027-02-07
    // and a 28-day "Season's Legacy" (untracked) opening that same day, whose
    // DTEND a month later hid the cut-off from the old latest-DTEND rule.
    const legacy = [
      ['BEGIN:VEVENT', `DTSTART:${ics(at('2026-11-03') - 8 * 3600_000)}`, `DTEND:${ics(at('2026-11-30'))}`,
        "SUMMARY:🌇 Season's Legacy", 'END:VEVENT'].join('\r\n'),
    ];
    expect(await cadenceClean(feed(ancients('2026-10-22'), ancients('2026-10-28'), ancients('2026-11-03', false), legacy))).toBe(true);
  });

  it('judges a run whose Treasure day fell before the feed window', async () => {
    const riseOnly = run('🛕 Rise of the Ancients', '2026-10-17', 1);
    expect(await cadenceClean(feed(riseOnly, ancients('2026-10-22'), ancients('2026-10-28')))).toBe(true);
  });

  it('still catches a run that really moved', async () => {
    expect(await cadenceClean(feed(ancients('2026-10-22'), ancients('2026-10-27'), ancients('2026-11-03', false)))).toBe(false);
  });

  it('judges a corrected run where the correction put it', async () => {
    // The feed lists 10-27/10-28, a day early; the game ran it on 10-28/10-29.
    const shifted = feed(ancients('2026-10-22'), ancients('2026-10-27'), ancients('2026-11-03'));
    expect(await cadenceClean(shifted, [{ eventKey: 'ancients', feed: '2026-10-27', actual: '2026-10-28' }])).toBe(true);
  });
});

describe('schedule corrections', () => {
  const OLYMPUS_FIX = { eventKey: 'olympus', feed: '2026-10-30', actual: '2026-10-24' };

  it('move the upcoming run the feed has wrong', async () => {
    const { cal } = await load({ now: '2026-10-21T19:00:00Z', ics: FEED_OCT21, corrections: [OLYMPUS_FIX] });
    const s = await cal.getEventSchedule('olympus');
    expect(s.next?.from).toBe(iso('2026-10-24'));
    expect(s.next?.label).toBe('Oct 24–28'); // keeps its five days
  });

  it('put the corrected run on the page once it starts', async () => {
    const { cal } = await load({ now: '2026-10-25T12:00:00Z', ics: FEED_OCT21, corrections: [OLYMPUS_FIX] });
    const occ = await cal.getEventOccurrences('olympus');
    expect(occ[0]).toMatchObject({ from: iso('2026-10-24'), resetAt: iso('2026-10-29'), isCurrent: true });
    expect(occ).toHaveLength(2);
  });

  it('fall inert once the feed itself is fixed', async () => {
    // The portal now lists Oct 24 itself; there is no Oct 30 run left for the
    // correction to move, so nothing doubles up and the view says so.
    const ics = feed(run("🕷️ Arachne's Swarm", '2026-09-21', 1), run(OLYMPUS, '2026-10-06', 5), run(OLYMPUS, '2026-10-24', 5));
    const { cal } = await load({ now: '2026-10-21T19:00:00Z', ics, corrections: [OLYMPUS_FIX] });
    expect((await cal.getEventSchedule('olympus')).next?.from).toBe(iso('2026-10-24'));
    const view = await cal.getScheduleCorrectionsView();
    expect(view.corrections).toHaveLength(1);
    expect(view.corrections[0].active).toBe(false);
  });

  it('are listed against the feed run they move', async () => {
    const { cal } = await load({ now: '2026-10-21T19:00:00Z', ics: FEED_OCT21, corrections: [OLYMPUS_FIX] });
    const view = await cal.getScheduleCorrectionsView();
    const olympus = view.events.find((e) => e.key === 'olympus')!;
    const moved = olympus.runs.find((r) => r.feedStart === iso('2026-10-30'))!;
    expect(moved.correctedStart).toBe(iso('2026-10-24'));
    expect(moved.correctedLabel).toBe('Oct 24–28');
    expect(view.corrections[0]).toMatchObject({ active: true, feedLabel: 'Oct 30 – Nov 3', actualLabel: 'Oct 24–28' });
    // Triumphal runs on its own cycle, not the feed — nothing to correct.
    expect(view.events.some((e) => e.key === 'triumphal')).toBe(false);
  });

  it('are validated before they are stored', async () => {
    const { cal, repo } = await load({ now: '2026-10-21T19:00:00Z', ics: FEED_OCT21 });
    const feedStart = iso('2026-10-30');
    expect(await cal.saveScheduleCorrection('triumphal', feedStart, '2026-10-24', 1)).toHaveProperty('error');
    expect(await cal.saveScheduleCorrection('olympus', iso('2026-10-29'), '2026-10-24', 1)).toHaveProperty('error');
    expect(await cal.saveScheduleCorrection('olympus', feedStart, '24/10/2026', 1)).toHaveProperty('error');
    expect(await cal.saveScheduleCorrection('olympus', feedStart, '2026-10-30', 1)).toHaveProperty('error');
    expect(await cal.saveScheduleCorrection('olympus', feedStart, '2026-12-15', 1)).toHaveProperty('error');
    expect(repo.setCorrection).not.toHaveBeenCalled();

    expect(await cal.saveScheduleCorrection('olympus', feedStart, '2026-10-24', 7)).toEqual({ ok: true });
    expect(repo.setCorrection).toHaveBeenCalledWith('olympus', at('2026-10-30'), at('2026-10-24'), 7);
  });
});

describe('a Seasonal Kingdom clan', () => {
  // Both feeds as fetched on 2026-11-13 (SK 2026 opened Nov 11 09:00 UTC). The
  // normal kingdom runs Ancients on its 6-day Tinman cadence (Nov 10, 16, …);
  // the SK one had Tinman on Nov 13 and then every 5 days, and Ragnarök on
  // Nov 12 and 15 — the "Vaults day today, Tinman tomorrow" the user reported.
  const ancientsRun = (treasureDay: string) => [
    ...run("💎 Ancients' Treasure", treasureDay, 1),
    ...run('🛕 Rise of the Ancients', new Date(at(treasureDay) + DAY).toISOString().slice(0, 10), 1),
  ];
  const NORMAL = feed(ancientsRun('2026-11-03'), ancientsRun('2026-11-09'), ancientsRun('2026-11-15'));
  const SK = feed(
    [['BEGIN:VEVENT', 'DTSTART:20261111T090000Z', 'DTEND:20270208T090000Z', 'SUMMARY:⚔️ Pinnacle of Warfare', 'END:VEVENT'].join('\r\n')],
    ancientsRun('2026-11-12'),
    ancientsRun('2026-11-16'),
    run('⚡ Ragnarök', '2026-11-12', 1),
    run('⚡ Ragnarök', '2026-11-15', 1),
  );
  const NOW = '2026-11-13T12:00:00Z';

  it('reads its runs from the SK calendar; other clans keep the normal one', async () => {
    const { cal } = await load({ now: NOW, ics: NORMAL, skIcs: SK });
    const sk = await cal.getEventOccurrences('ancients', SK_CLAN);
    expect(sk.map((o) => [o.from, o.resetAt, o.isCurrent])).toEqual([
      [iso('2026-11-12'), iso('2026-11-14'), true],
    ]);
    const normal = await cal.getEventOccurrences('ancients', 1);
    expect(normal.map((o) => o.from)).toEqual([iso('2026-11-09'), iso('2026-11-03')]);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url).includes('realm=season')).sort())
      .toEqual([false, true]);
  });

  it('gets the next-run hint from the SK calendar too', async () => {
    const { cal } = await load({ now: NOW, ics: NORMAL, skIcs: SK });
    expect((await cal.getEventSchedule('ragnarok', SK_CLAN)).next?.from).toBe(iso('2026-11-15'));
    expect((await cal.getEventSchedule('ancients', SK_CLAN)).live).toBe(true);
    expect((await cal.getEventSchedule('ancients', 1)).next?.from).toBe(iso('2026-11-15'));
  });

  it('archives the SK feed apart from the normal one', async () => {
    const { cal, repo } = await load({ now: NOW, ics: NORMAL, skIcs: SK });
    await cal.getEventOccurrences('ragnarok', SK_CLAN);
    expect(repo.syncArchivedRuns).toHaveBeenCalledTimes(1);
    const [horizon, , runs, realm] = vi.mocked(repo.syncArchivedRuns).mock.calls[0];
    expect(realm).toBe('season');
    expect(horizon).toBe(Date.parse('2026-11-11T09:00:00Z'));
    expect(runs).toContainEqual({ eventKey: 'ragnarok', start: at('2026-11-12'), end: at('2026-11-13') });
    expect(repo.listArchivedRuns).toHaveBeenCalledWith('ragnarok', 'season');
  });

  it('is never moved by a normal-kingdom correction, nor held to the 6-day Tinman cadence', async () => {
    // A correction keyed on a Ragnarök starting Nov 12 must not touch the SK run
    // that starts the same day; and the SK Tinman days (Nov 13, 17) are off the
    // normal cadence by design. Both checks read the corrections, so an SK-only
    // fetch never asks for them.
    const { cal, repo } = await load({
      now: NOW,
      ics: NORMAL,
      skIcs: SK,
      corrections: [{ eventKey: 'ragnarok', feed: '2026-11-12', actual: '2026-11-10' }],
    });
    const ragnarok = await cal.getEventOccurrences('ragnarok', SK_CLAN);
    expect(ragnarok.map((o) => o.from)).toEqual([iso('2026-11-12')]);
    await cal.getEventOccurrences('ancients', SK_CLAN);
    expect(repo.listCorrections).not.toHaveBeenCalled();
  });

  it('has no runs for an event its calendar does not list', async () => {
    const { cal } = await load({ now: NOW, ics: FEED_OCT21, skIcs: SK });
    expect(await cal.getEventOccurrences('dark-omens', SK_CLAN)).toEqual([]);
  });
});
