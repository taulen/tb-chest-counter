/**
 * Event standings from the game (v120): the event list (24001), an event's
 * "Clan members" tab (38003), T44 titles, the mapping onto the site's events,
 * and storage — the first read of a run is its baseline, history only when
 * points move, a finished run keeps its standings.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Frame, Wire } from '../../src/game-protocol/codec.js';
import { isEventRunning, parseEventList, parseEventProgress, parseEventStandings } from '../../src/game-protocol/messages.js';
import { figurineSummons } from '../../src/game-protocol/ancients.js';
import { asIdRecord, buildEvents } from '../../src/game-protocol/static-data.js';
import { catalogKeyForEventTitle } from '../../src/game-protocol/event-mapping.js';
import {
  getEventStandings, latestEventRuns, listEventRuns, saveEventRun, saveEventStandings,
} from '../../src/data/repositories/game-event-repo.js';
import { getDb } from '../../src/data/database.js';
import { makeTestDb } from '../helpers/test-db.js';

const frame = (type: number, body: Wire[]): Frame => ({ type, seq: 1, head: [type, 1], body, children: [], events: [] });

describe('event messages', () => {
  it('reads the event list (24001) and tells which runs are running', () => {
    const body: Wire[] = [[[
      [[1024, 1], 242, 1, 1794934800, false, 1, 0, 1794848450], // Rise of the Ancients, running
      [[1001, 1], 305, 2, 1795453200, false, 1, 0, 1794502833], // state 2: not running
      [[1018, 1], 50, 1, 4294967295, false, 1, 0, 1792688478], // open-ended
    ], [[1007, 16], [1012, 18]]]];
    const list = parseEventList(frame(24001, body));
    expect(list).toEqual([
      { type: 1024, run: 1, occurrence: 242, state: 1, startsAt: 1794848450, endsAt: 1794934800 },
      { type: 1001, run: 1, occurrence: 305, state: 2, startsAt: 1794502833, endsAt: 1795453200 },
      { type: 1018, run: 1, occurrence: 50, state: 1, startsAt: 1792688478, endsAt: 4294967295 },
    ]);
    const now = 1794900000;
    expect(list.map((e) => isEventRunning(e, now))).toEqual([true, false, true]);
    expect(isEventRunning(list[0], 1794934801)).toBe(false); // ended
  });

  it('reads an event\'s Clan members tab (38003)', () => {
    // SIK's Rise of the Ancients as the game showed it (Nov 17 2026), top three.
    const body: Wire[] = [[[
      [[4522600563069], 52586600, 1],
      [[511101438563], 50047641, 2],
      [[4522600562952], 49899136, 3],
    ]]];
    expect(parseEventStandings(frame(38003, body))).toEqual([
      { playerId: 4522600563069, points: 52586600, rank: 1 },
      { playerId: 511101438563, points: 50047641, rank: 2 },
      { playerId: 4522600562952, points: 49899136, rank: 3 },
    ]);
    expect(parseEventStandings(frame(38003, [[[]]]))).toEqual([]);
  });

  it('reads Rise of the Ancients\' window header (38000): summons left and the Figurine\'s summons', () => {
    // As the game sent them on Nov 17 2026: CWB "2 of 2 left", SIK "1 of 2 left".
    const cwb = parseEventProgress(frame(38000, [[[242, 6053, 2, 0, [0], [0, 0, 0]], { 1: [17, 80015], 2: [2, 6156], 3: [12, 40235] }]]));
    const sik = parseEventProgress(frame(38000, [[[242, 6130, 1, 0, [0], [0, 0, 0]], { 1: [26, 408240], 2: [2, 1800], 3: [16, 73760] }]]));
    expect(cwb).toEqual({
      occurrence: 242, bossId: 6053, summonsLeft: 2,
      artifacts: { 1: { level: 17, points: 80015 }, 2: { level: 2, points: 6156 }, 3: { level: 12, points: 40235 } },
    });
    expect([sik?.summonsLeft, sik?.artifacts[1].level, sik?.artifacts[3].level]).toEqual([1, 26, 16]); // Tome 26, Clock 16 as in game
    // The Figurine's level is the summon count, though CWB's 6,156 points would be ladder level 4.
    expect(figurineSummons(cwb)).toBe(2);
    expect(figurineSummons(sik)).toBe(2);
    // The Seasonal Kingdom run lists the Figurine as artifact 4.
    expect(figurineSummons(parseEventProgress(frame(38000, [[[7, 7039, 5, 0, [0], [0, 0, 0]], { 1: [1, 0], 4: [3, 0], 3: [1, 0] }]])))).toBe(3);
    expect(figurineSummons(null)).toBeNull();
    expect(parseEventProgress(frame(38000, [[]]))).toBeNull();
  });
});

describe('event titles (T44)', () => {
  it('keys a composite-keyed table by its joined numbers and titles each run from info_title', () => {
    const strings = [
      '{"info_title":"global_tournament.client.value.clandoom_epic.info.title","artifact_workshop_title":"global_tournament.client.value.clandoom_bonus.info.title"}',
      '{"info_title":"global_tournament.client.value.multistage.info.title"}',
      'not json',
    ];
    const row = (cfgRef: number): Wire[] => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, cfgRef];
    const table = asIdRecord({ $pairs: [[[[1024, 1], 1], row(0)], [[[1024, 1], 2], row(2)], [[[1032, 1], 1], row(1)], [[[1099, 1], 1], row(2)]] } as unknown as Wire);
    expect(Object.keys(table ?? {})).toEqual(['1024,1,1', '1024,1,2', '1032,1,1', '1099,1,1']);
    const en = new Map([
      ['global_tournament.client.value.clandoom_epic.info.title', 'Rise of the Ancients'],
      ['global_tournament.client.value.multistage.info.title', 'TRIALS OF OLYMPUS'],
    ]);
    const events = buildEvents(table ?? undefined, (ref) => (typeof ref === 'number' ? strings[ref] : undefined), en);
    expect(events).toEqual({
      '1024,1': { code: 'clandoom_epic', titleKey: 'global_tournament.client.value.clandoom_epic.info.title', title: 'Rise of the Ancients' },
      '1032,1': { code: 'multistage', titleKey: 'global_tournament.client.value.multistage.info.title', title: 'TRIALS OF OLYMPUS' },
    });
  });

  it('maps game titles onto the site\'s events by their in-game names, whatever the case or accents', () => {
    expect(catalogKeyForEventTitle('Rise of the Ancients')).toBe('ancients');
    expect(catalogKeyForEventTitle("Ancients' Treasure")).toBe('ancients');
    expect(catalogKeyForEventTitle('TRIALS OF OLYMPUS')).toBe('olympus');
    expect(catalogKeyForEventTitle('DARK OMENS')).toBe('dark-omens');
    expect(catalogKeyForEventTitle('Ragnarök')).toBe('ragnarok');
    expect(catalogKeyForEventTitle('Ragnarok')).toBe('ragnarok');
    expect(catalogKeyForEventTitle('Trade Routes')).toBeNull(); // shown under the game's own title
    expect(catalogKeyForEventTitle('')).toBeNull();
  });
});

describe('event standings storage', () => {
  let cleanup: () => void;
  beforeEach(() => { ({ cleanup } = makeTestDb()); });
  afterEach(() => cleanup());

  const CLAN = 1;
  const RUN = { eventType: 1024, run: 1, occurrence: 242 };
  const entry = { type: 1024, run: 1, occurrence: 242, state: 1, startsAt: 1794848450, endsAt: 1794934800 };

  it('keeps the first read as the baseline and a history row only when points move', () => {
    saveEventRun(CLAN, entry, { code: 'clandoom_epic', title: 'Rise of the Ancients' }, '2026-11-17T12:00:00Z');
    // The baseline: nobody "moved", but a newcomer with points counts as changed
    // (from nothing); one with 0 doesn't.
    expect(saveEventStandings(CLAN, RUN, [
      { playerId: 1, points: 100, rank: 1 }, { playerId: 2, points: 0, rank: 2 },
    ], '2026-11-17T12:00:00Z')).toEqual({ moved: 0, changed: 1 });
    // Unchanged: no history, a flat read.
    expect(saveEventStandings(CLAN, RUN, [
      { playerId: 1, points: 100, rank: 1 }, { playerId: 2, points: 0, rank: 2 },
    ], '2026-11-17T13:00:00Z')).toEqual({ moved: 0, changed: 0 });
    // Player 2 scores and overtakes.
    expect(saveEventStandings(CLAN, RUN, [
      { playerId: 2, points: 500, rank: 1 }, { playerId: 1, points: 100, rank: 2 },
    ], '2026-11-17T14:00:00Z')).toEqual({ moved: 1, changed: 1 });

    const rows = getEventStandings(CLAN, RUN);
    expect(rows.map((r) => [r.playerId, r.rank, r.points, r.previousPoints, r.changedAt])).toEqual([
      [2, 1, 500, 0, '2026-11-17T14:00:00Z'],
      [1, 2, 100, null, null], // never moved since the baseline
    ]);
    const hist = getDb().prepare('SELECT COUNT(*) AS n FROM game_event_standing_history').get() as { n: number };
    expect(hist.n).toBe(3); // two baseline rows + one move
  });

  it('keeps a finished run when the event comes round again, and lists the latest run per event', () => {
    saveEventRun(CLAN, entry, { code: 'clandoom_epic', title: 'Rise of the Ancients' }, '2026-11-17T12:00:00Z');
    saveEventStandings(CLAN, RUN, [{ playerId: 1, points: 100, rank: 1 }], '2026-11-17T12:00:00Z');
    const next = { ...entry, occurrence: 243, startsAt: 1795366800, endsAt: 1795453200 };
    saveEventRun(CLAN, next, { code: 'clandoom_epic', title: 'Rise of the Ancients' }, '2026-11-23T18:00:00Z');
    saveEventStandings(CLAN, { ...RUN, occurrence: 243 }, [{ playerId: 1, points: 7, rank: 1 }], '2026-11-23T18:00:00Z');
    // A run with no standings is not listed.
    saveEventRun(CLAN, { ...entry, type: 1006, occurrence: 462 }, { code: 'traderoutes', title: 'Trade Routes' }, '2026-11-17T12:00:00Z');

    expect(listEventRuns(CLAN).map((r) => r.occurrence)).toEqual([243, 242]);
    expect(latestEventRuns(CLAN).map((r) => [r.code, r.occurrence])).toEqual([['clandoom_epic', 243]]);
    expect(getEventStandings(CLAN, RUN)[0].points).toBe(100); // the finished run's standings stay
  });
});
