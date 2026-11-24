/**
 * Event standings from the game (v120): the event list (24001), an event's
 * "Clan members" tab (38003), T44 titles, the mapping onto the site's events,
 * and storage — the first read of a run is its baseline, history only when
 * points move, a finished run keeps its standings.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Frame, Wire } from '../../src/game-protocol/codec.js';
import {
  isEventRunning, parseEventList, parseEventProgress, parseEventStandings,
  parseOlympusClanRanking, parseOlympusGroup, parseOlympusMembers, parseOlympusRewardMinimum,
} from '../../src/game-protocol/messages.js';
import { figurineSummons } from '../../src/game-protocol/ancients.js';
import { asIdRecord, buildEvents } from '../../src/game-protocol/static-data.js';
import { catalogKeyForEventTitle, olympusStageDay } from '../../src/game-protocol/event-mapping.js';
import {
  eventGroupKey, getEventStandings, getMatchup, groupEventRuns, isShortRun, listEventRuns, matchupClansWithoutName, saveEventRun,
  saveEventStandings, saveMatchup, summarizeEventRuns,
} from '../../src/data/repositories/game-event-repo.js';
import { buildGameOlympus, olympusGameRunDates } from '../../src/data/olympus-game.js';
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

  it('knows Olympus\' five stages as its days, and maps them onto olympus', () => {
    expect(['Trial of the Chimera', 'Trial of the Basilisk', 'Lava Fountain Trial', 'Trial of Tartaros', 'Trial of Briareus']
      .map(olympusStageDay)).toEqual([1, 2, 3, 4, 5]);
    expect(catalogKeyForEventTitle('Trial of the Chimera')).toBe('olympus');
    // Same code, not a day: the catch-up and the PvP sub-event, and the umbrella itself.
    expect(olympusStageDay('Pursuit of Lava Oil')).toBeNull();
    expect(olympusStageDay('Sealed in Flame')).toBeNull();
    expect(olympusStageDay('TRIALS OF OLYMPUS')).toBeNull();
  });
});

describe('Olympus messages (recorded Nov 24 2026, CWB)', () => {
  it('reads the Clan members tab (82003): rank, player, Olympus points', () => {
    const body: Wire[] = [[[[45, [390842355323], 0], [1, [1297080248731], 33000], [2, [1297080262943], 22500], [3, [1297080372208], 22500]]]];
    expect(parseOlympusMembers(frame(82003, body))).toEqual([
      { playerId: 390842355323, points: 0, rank: 45 },
      { playerId: 1297080248731, points: 33000, rank: 1 },
      { playerId: 1297080262943, points: 22500, rank: 2 },
      { playerId: 1297080372208, points: 22500, rank: 3 },
    ]);
    expect(parseOlympusMembers(frame(82003, [[[]]]))).toEqual([]);
  });

  it('reads the matchup group (82001), the clan ranking (82000) and the reward minimum (82002)', () => {
    expect(parseOlympusGroup(frame(82001, [[[590], null, null, null]]))).toBe(590);
    expect(parseOlympusClanRanking(frame(82000, [[[[1, [1297080123906], 393845], [2, [674309866701], 173519], [3, [1172526071839], 142295]]]]))).toEqual([
      { rank: 1, clanId: 1297080123906, points: 393845 },
      { rank: 2, clanId: 674309866701, points: 173519 },
      { rank: 3, clanId: 1172526071839, points: 142295 },
    ]);
    expect(parseOlympusRewardMinimum(frame(82002, [[[600000, [[1, [3000110, 3000606]], [1, [3000616]], [1, [3000626]]]]]]))).toBe(600000);
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

  it('keeps a finished run when the event comes round again, and folds the runs into one entry per event', () => {
    saveEventRun(CLAN, entry, { code: 'clandoom_epic', title: 'Rise of the Ancients' }, '2026-11-17T12:00:00Z');
    saveEventStandings(CLAN, RUN, [{ playerId: 1, points: 100, rank: 1 }], '2026-11-17T12:00:00Z');
    const next = { ...entry, occurrence: 243, startsAt: 1795366800, endsAt: 1795453200 };
    saveEventRun(CLAN, next, { code: 'clandoom_epic', title: 'Rise of the Ancients' }, '2026-11-23T18:00:00Z');
    saveEventStandings(CLAN, { ...RUN, occurrence: 243 }, [{ playerId: 1, points: 7, rank: 1 }], '2026-11-23T18:00:00Z');
    // A run with no standings is not listed.
    saveEventRun(CLAN, { ...entry, type: 1006, occurrence: 462 }, { code: 'traderoutes', title: 'Trade Routes' }, '2026-11-17T12:00:00Z');

    expect(listEventRuns(CLAN).map((r) => r.occurrence)).toEqual([243, 242]);
    expect(groupEventRuns(listEventRuns(CLAN))).toEqual([{ key: 'clandoom_epic', title: 'Rise of the Ancients', eventType: 1024, short: false, runs: 2 }]);
    expect(getEventStandings(CLAN, RUN)[0].points).toBe(100); // the finished run's standings stay
  });

  it("summarises each run: who the game lists, who has points, and the best rank's player", () => {
    saveEventRun(CLAN, entry, { code: 'clandoom_epic', title: 'Rise of the Ancients' }, '2026-11-17T12:00:00Z');
    saveEventStandings(CLAN, RUN, [
      { playerId: 2, points: 500, rank: 1 }, { playerId: 1, points: 100, rank: 2 }, { playerId: 3, points: 0, rank: 3 },
    ], '2026-11-17T12:00:00Z');
    // A run nobody scored in yet has no leader.
    const quiet = { ...entry, occurrence: 243 };
    saveEventRun(CLAN, quiet, { code: 'clandoom_epic', title: 'Rise of the Ancients' }, '2026-11-23T18:00:00Z');
    saveEventStandings(CLAN, { ...RUN, occurrence: 243 }, [{ playerId: 1, points: 0, rank: 1 }], '2026-11-23T18:00:00Z');
    expect(summarizeEventRuns(CLAN, listEventRuns(CLAN)).map((r) => [r.occurrence, r.members, r.withPoints, r.leader])).toEqual([
      [243, 1, 0, null],
      [242, 3, 2, { playerId: 2, points: 500 }],
    ]);
  });

  it('keys an event by its code, a code-less one by its type, and tells the short tournaments apart by length', () => {
    expect(eventGroupKey({ eventType: 1015, code: 'resource_collection_tournament', title: 'War Tools' })).toBe('resource_collection_tournament');
    expect(eventGroupKey({ eventType: 1029, code: '', title: '' })).toBe('type-1029');
    expect(eventGroupKey({ eventType: 1032, code: 'multistage', title: 'TRIALS OF OLYMPUS' })).toBe('multistage');
    expect(eventGroupKey({ eventType: 1025, code: 'multistage', title: 'Trial of the Chimera' })).toBe('multistage.trial-of-the-chimera');
    const h = 3600;
    expect(isShortRun({ startsAt: 0, endsAt: 3.5 * h })).toBe(true); // War Tools
    expect(isShortRun({ startsAt: 0, endsAt: 24 * h })).toBe(false); // Hellforge's day
    expect(isShortRun({ startsAt: 0, endsAt: 48 * h })).toBe(false); // Summon Mastery, a "_tournament" code
    expect(isShortRun({ startsAt: 0, endsAt: null })).toBe(false); // open-ended
  });
});

describe('Olympus from the game', () => {
  let cleanup: () => void;
  beforeEach(() => { ({ cleanup } = makeTestDb()); });
  afterEach(() => cleanup());

  const CLAN = 1;
  const ROLLOVER = 17;
  const s = (iso: string) => Date.parse(iso) / 1000;
  const UMBRELLA = { eventType: 1032, run: 1, occurrence: 23 };
  const STAGE1 = { eventType: 1025, run: 8, occurrence: 23 };
  const STAGE2 = { eventType: 1025, run: 9, occurrence: 23 };

  /** The Nov 23 2026 run, as the scans would have stored it, read on day 2. */
  function seed(): void {
    // The overall ranking opens an hour before day 1 (game day Nov 22) and closes an hour after day 5.
    saveEventRun(CLAN, { type: 1032, run: 1, occurrence: 23, state: 1, startsAt: s('2026-11-23T16:05:07Z'), endsAt: s('2026-11-28T18:00:00Z') },
      { code: 'multistage', title: 'TRIALS OF OLYMPUS' }, '2026-11-23T19:23:38Z');
    // 38003's zeros first (before Nov 24), then 82003: 33,000 by 15:01 on day 1, more after its 17:00 end.
    saveEventStandings(CLAN, UMBRELLA, [{ playerId: 1, points: 0, rank: 1 }, { playerId: 2, points: 0, rank: 2 }], '2026-11-23T19:23:38Z');
    saveEventStandings(CLAN, UMBRELLA, [{ playerId: 1, points: 33000, rank: 1 }, { playerId: 2, points: 22500, rank: 2 }], '2026-11-24T15:01:00Z');
    saveEventStandings(CLAN, UMBRELLA, [{ playerId: 1, points: 40000, rank: 1 }, { playerId: 2, points: 22500, rank: 2 }], '2026-11-24T17:31:00Z');
    saveEventStandings(CLAN, UMBRELLA, [{ playerId: 1, points: 50000, rank: 1 }, { playerId: 2, points: 30000, rank: 2 }], '2026-11-25T12:00:00Z');
    // Day 1's and day 2's stages, each its own ranking from zero; player 3 only in stage 1.
    saveEventRun(CLAN, { type: 1025, run: 8, occurrence: 23, state: 1, startsAt: s('2026-11-23T17:00:51Z'), endsAt: s('2026-11-24T17:00:00Z') },
      { code: 'multistage', title: 'Trial of the Chimera' }, '2026-11-24T15:01:00Z');
    saveEventStandings(CLAN, STAGE1, [{ playerId: 1, points: 2422955, rank: 1 }, { playerId: 2, points: 746974, rank: 2 }, { playerId: 3, points: 100, rank: 3 }], '2026-11-24T15:01:00Z');
    saveEventRun(CLAN, { type: 1025, run: 9, occurrence: 23, state: 1, startsAt: s('2026-11-24T17:00:51Z'), endsAt: s('2026-11-25T17:00:00Z') },
      { code: 'multistage', title: 'Trial of the Basilisk' }, '2026-11-25T12:00:00Z');
    saveEventStandings(CLAN, STAGE2, [{ playerId: 1, points: 500, rank: 1 }, { playerId: 2, points: 0, rank: 2 }], '2026-11-25T12:00:00Z');
  }

  it('splits the Olympus points into days at the 17:00 UTC resets, beside each day\'s stage points', () => {
    seed();
    expect(olympusGameRunDates(CLAN, ROLLOVER)).toEqual(['2026-11-23']);
    const g = buildGameOlympus(CLAN, '2026-11-23', ROLLOVER, Date.parse('2026-11-25T13:00:00Z'))!;
    expect(g.olympusPoints).toBe(true);
    expect(g.days).toEqual([1, 2]);
    expect(g.columns.map((c) => [c.first, c.live, c.title])).toEqual([[1, false, 'Trial of the Chimera'], [2, true, 'Trial of the Basilisk']]);
    expect(g.stages.map((x) => x.state)).toEqual(['read', 'read', 'upcoming', 'upcoming', 'upcoming']);
    expect(g.players.map((p) => [p.rawName, p.cumulative, p.perSummon, p.total, p.stagePoints, p.stageTotal, p.played])).toEqual([
      // Points read after day 1's end (17:31) count on day 2.
      ['#1', { 1: 33000, 2: 50000 }, { 1: 33000, 2: 17000 }, 50000, { 1: 2422955, 2: 500 }, 2423455, 2],
      ['#2', { 1: 22500, 2: 30000 }, { 1: 22500, 2: 7500 }, 30000, { 1: 746974, 2: 0 }, 746974, 2],
      ['#3', { 1: 0, 2: 0 }, { 1: 0, 2: 0 }, 0, { 1: 100 }, 100, 0],
    ]);
    // Another run's day: nothing.
    expect(buildGameOlympus(CLAN, '2026-11-01', ROLLOVER, Date.parse('2026-11-25T13:00:00Z'))).toBeNull();
  });

  it('keeps everything read after day 5\'s 17:00 end on day 5 — there is no day 6 — so it adds up to the final total', () => {
    seed();
    // Day 4 ends Nov 27 17:00; day 5's last read before its end, then one in the closing hour.
    saveEventStandings(CLAN, UMBRELLA, [{ playerId: 1, points: 80000, rank: 1 }, { playerId: 2, points: 40000, rank: 2 }], '2026-11-27T12:00:00Z');
    saveEventStandings(CLAN, UMBRELLA, [{ playerId: 1, points: 90000, rank: 1 }, { playerId: 2, points: 45000, rank: 2 }], '2026-11-28T16:31:00Z');
    saveEventStandings(CLAN, UMBRELLA, [{ playerId: 1, points: 97000, rank: 1 }, { playerId: 2, points: 45000, rank: 2 }], '2026-11-28T17:40:00Z');
    const g = buildGameOlympus(CLAN, '2026-11-23', ROLLOVER, Date.parse('2026-11-29T10:00:00Z'))!;
    expect(g.days).toEqual([1, 2, 3, 4, 5]);
    const p1 = g.players.find((p) => p.rawName === '#1')!;
    expect(p1.cumulative[5]).toBe(97000); // the closing-hour read, not the 16:31 one
    expect(p1.total).toBe(97000);
    expect(Object.values(p1.perSummon).reduce((a, b) => a + b, 0)).toBe(p1.total);
    expect(p1.perSummon[5]).toBe(17000); // 97,000 − day 4's 80,000
  });

  it('falls back to the stage points when the run has no Olympus points (read before 82003)', () => {
    saveEventRun(CLAN, { type: 1025, run: 8, occurrence: 23, state: 1, startsAt: s('2026-11-23T17:00:51Z'), endsAt: s('2026-11-24T17:00:00Z') },
      { code: 'multistage', title: 'Trial of the Chimera' }, '2026-11-24T10:01:56Z');
    saveEventStandings(CLAN, STAGE1, [{ playerId: 1, points: 2422955, rank: 2 }, { playerId: 9, points: 4225110, rank: 1 }], '2026-11-24T10:01:56Z');
    const g = buildGameOlympus(CLAN, '2026-11-23', ROLLOVER, Date.parse('2026-11-24T11:00:00Z'))!;
    expect([g.olympusPoints, g.days]).toEqual([false, []]);
    expect(g.players.map((p) => [p.rawName, p.perSummon, p.total, p.rank])).toEqual([
      ['#9', { 1: 4225110 }, 4225110, 1],
      ['#1', { 1: 2422955 }, 2422955, 2],
    ]);
  });

  it('keeps the matchup, rivals\' headlines once read, and lists the overall ranking beside the latest stage', () => {
    seed();
    const clans = [
      { gameClanId: 1297080123906, rank: 1, points: 393845 },
      { gameClanId: 674309866701, rank: 2, points: 173519 },
      { gameClanId: 1172526071839, rank: 3, points: 142295 },
    ];
    saveMatchup(CLAN, UMBRELLA, { groupId: 590, rewardMinPoints: 600000, clans }, '2026-11-24T15:01:00Z');
    expect(matchupClansWithoutName(CLAN, UMBRELLA)).toHaveLength(3);
    saveMatchup(CLAN, UMBRELLA, {
      groupId: 590, rewardMinPoints: 600000,
      clans: [{ ...clans[1], kingdom: 157, tag: 'GOF', name: 'Godfather 3 new', members: 72, memberLimit: 100, might: 14220448468 }],
    }, '2026-11-24T15:01:00Z');
    // A later read of the scores alone keeps the headline.
    saveMatchup(CLAN, UMBRELLA, { groupId: null, rewardMinPoints: null, clans: clans.map((c) => ({ ...c, points: c.points + 1 })) }, '2026-11-24T16:31:00Z');
    const m = getMatchup(CLAN, UMBRELLA)!;
    expect([m.groupId, m.rewardMinPoints, m.readAt]).toEqual([590, 600000, '2026-11-24T16:31:00Z']);
    expect(m.clans.map((c) => [c.rank, c.points, c.kingdom, c.tag, c.members])).toEqual([
      [1, 393846, null, null, null],
      [2, 173520, 157, 'GOF', 72],
      [3, 142296, null, null, null],
    ]);
    // Only the two still unnamed are read again.
    expect(matchupClansWithoutName(CLAN, UMBRELLA).sort((a, b) => a - b)).toEqual([1172526071839, 1297080123906]);
    expect(buildGameOlympus(CLAN, '2026-11-23', ROLLOVER, Date.parse('2026-11-25T13:00:00Z'))!.matchup?.clans).toHaveLength(3);
    // In-game rankings: TRIALS OF OLYMPUS and each stage its own event, not one hiding the other.
    expect(groupEventRuns(listEventRuns(CLAN)).map((g) => [g.key, g.runs])).toEqual([
      ['multistage.trial-of-the-basilisk', 1], ['multistage.trial-of-the-chimera', 1], ['multistage', 1],
    ]);
  });
});
