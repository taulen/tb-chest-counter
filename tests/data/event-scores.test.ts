/**
 * Event scores come from the game (data/event-scores.ts): Ragnarök and Dark
 * Omens' per-day tables (day-event-game.ts), and which source a run's table is
 * taken from when a run was pasted before the game read it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { saveEventRun, saveEventStandings } from '../../src/data/repositories/game-event-repo.js';
import { buildGameDayEvent, dayEventGameRunDates } from '../../src/data/day-event-game.js';
import { eventScoreDates, getEventScores } from '../../src/data/event-scores.js';
import { catalogKeyForEventTitle } from '../../src/game-protocol/event-mapping.js';
import { makeTestDb } from '../helpers/test-db.js';
import { insertPastedRound } from '../helpers/pasted-scores.js';

const CLAN = 1;
const ROLLOVER = 17;
const s = (iso: string) => Date.parse(iso) / 1000;
const RAGNAROK = { eventType: 1026, run: 2, occurrence: 109 };

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** A two-day Ragnarök (Nov 5 17:00 → Nov 7 17:00), read three times. */
function seedTwoDayRagnarok(): void {
  saveEventRun(CLAN, { type: 1026, run: 2, occurrence: 109, state: 1, startsAt: s('2026-11-05T17:00:30Z'), endsAt: s('2026-11-07T17:00:00Z') },
    { code: 'ragnarok', title: 'Ragnarök' }, '2026-11-06T10:00:00Z');
  saveEventStandings(CLAN, RAGNAROK, [{ playerId: 1, points: 100, rank: 1 }, { playerId: 2, points: 50, rank: 2 }], '2026-11-06T10:00:00Z');
  // Read after day 1's 17:00 end: counts on day 2.
  saveEventStandings(CLAN, RAGNAROK, [{ playerId: 1, points: 150, rank: 1 }, { playerId: 2, points: 50, rank: 2 }], '2026-11-06T18:00:00Z');
  saveEventStandings(CLAN, RAGNAROK, [{ playerId: 1, points: 300, rank: 1 }, { playerId: 2, points: 80, rank: 2 }], '2026-11-07T12:00:00Z');
}

describe('Ragnarök and Dark Omens from the game', () => {
  it('maps both events\' game titles onto their tabs', () => {
    expect(catalogKeyForEventTitle('Ragnarök')).toBe('ragnarok');
    expect(catalogKeyForEventTitle('Dark Omens')).toBe('dark-omens');
  });

  it('splits a two-day run into days at the 17:00 UTC reset; the last day keeps the final standing', () => {
    seedTwoDayRagnarok();
    expect(dayEventGameRunDates(CLAN, 'ragnarok', ROLLOVER)).toEqual(['2026-11-05']);
    const g = buildGameDayEvent(CLAN, 'ragnarok', '2026-11-05', ROLLOVER, Date.parse('2026-11-08T10:00:00Z'))!;
    expect(g.live).toBe(false);
    expect(g.days).toEqual([1, 2]);
    expect(g.players.map((p) => [p.rawName, p.cumulative, p.perSummon, p.total, p.played, p.rank])).toEqual([
      ['#1', { 1: 100, 2: 300 }, { 1: 100, 2: 200 }, 300, 2, 1],
      ['#2', { 1: 50, 2: 80 }, { 1: 50, 2: 30 }, 80, 2, 2],
    ]);
    expect(buildGameDayEvent(CLAN, 'ragnarok', '2026-11-06', ROLLOVER)).toBeNull();
    expect(buildGameDayEvent(CLAN, 'dark-omens', '2026-11-05', ROLLOVER)).toBeNull();
  });

  it('shows a live run\'s days begun so far, the current one marked live', () => {
    seedTwoDayRagnarok();
    const g = buildGameDayEvent(CLAN, 'ragnarok', '2026-11-05', ROLLOVER, Date.parse('2026-11-06T12:00:00Z'))!;
    expect(g.live).toBe(true);
    expect(g.columns).toEqual([{ first: 1, last: 1, live: true }]);
  });

  it('is one column for a one-day run (Seasonal Kingdom Ragnarök)', () => {
    saveEventRun(CLAN, { type: 1026, run: 2, occurrence: 110, state: 1, startsAt: s('2026-11-24T17:01:18Z'), endsAt: s('2026-11-25T17:00:00Z') },
      { code: 'ragnarok', title: 'Ragnarök' }, '2026-11-25T11:06:18Z');
    saveEventStandings(CLAN, { eventType: 1026, run: 2, occurrence: 110 }, [{ playerId: 7, points: 4_134_287, rank: 1 }], '2026-11-25T11:06:18Z');
    const g = buildGameDayEvent(CLAN, 'ragnarok', '2026-11-24', ROLLOVER, Date.parse('2026-11-26T10:00:00Z'))!;
    expect(g.days).toEqual([1]);
    expect(g.players[0]).toMatchObject({ perSummon: { 1: 4_134_287 }, cumulative: { 1: 4_134_287 }, total: 4_134_287 });
  });
});

describe('event scores: which source a run comes from', () => {
  it('takes a run the game read from the game, and lists it among the run dates', () => {
    seedTwoDayRagnarok();
    vi.useFakeTimers({ now: Date.parse('2026-11-08T10:00:00Z'), toFake: ['Date'] });
    const r = getEventScores(CLAN, 'ragnarok', '2026-11-05');
    expect(r.game).not.toBeNull();
    expect(r.summons).toEqual([]);
    expect(r.players.map((p) => p.total)).toEqual([300, 80]);
    expect(eventScoreDates(CLAN, 'ragnarok')).toEqual(['2026-11-05']);
  });

  it('keeps a run pasted before the game read it, beside the game\'s runs', () => {
    seedTwoDayRagnarok();
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO members (clan_id, name, normalized_name, despaced_name, first_seen, last_seen, is_active)
       VALUES (?, 'Ace', 'ace', 'ace', ?, ?, 1)`,
    ).run(CLAN, now, now);
    insertPastedRound({ clanId: CLAN, date: '2026-10-28', summon: 1, eventKey: 'ragnarok', rows: [['Ace', 120], ['Nobody', 3]] });
    insertPastedRound({ clanId: CLAN, date: '2026-10-28', summon: 2, eventKey: 'ragnarok', rows: [['Ace', 200], ['Nobody', 3]] });

    expect(eventScoreDates(CLAN, 'ragnarok')).toEqual(['2026-11-05', '2026-10-28']);
    const pasted = getEventScores(CLAN, 'ragnarok', '2026-10-28');
    expect(pasted.game).toBeNull();
    expect(pasted.summons.map((u) => u.summon)).toEqual([1, 2]);
    expect(pasted.players.map((p) => [p.rawName, p.perSummon, p.total])).toEqual([['Ace', { 1: 120, 2: 80 }, 200], ['Nobody', { 1: 3, 2: 0 }, 3]]);
  });

  it('has nothing for a run neither the game nor a paste covers', () => {
    const r = getEventScores(CLAN, 'dark-omens', '2026-11-05');
    expect(r).toEqual({ date: '2026-11-05', summons: [], players: [], game: null });
    expect(eventScoreDates(CLAN, 'dark-omens')).toEqual([]);
  });
});
