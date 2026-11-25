/**
 * Event standings pasted before the game was read (tinman-repo.ts): read-only
 * now, still shown for the runs the game never read. Plus the Ancients targets,
 * which are still pasted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import * as tinman from '../../../src/data/repositories/tinman-repo.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import { insertPastedRound } from '../../helpers/pasted-scores.js';

let cleanup: () => void;
const DATE = '2026-10-23';

function addMember(clanId: number, name: string): number {
  const now = new Date().toISOString();
  return (getDb().prepare(
    `INSERT INTO members (clan_id, name, normalized_name, despaced_name, first_seen, last_seen, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id`,
  ).get(clanId, name, name.toLowerCase(), name.toLowerCase().replace(/\s+/g, ''), now, now) as { id: number }).id;
}

const paste = (summon: number, rows: Array<[string, number]>, eventKey?: tinman.ScoreEventKey) =>
  insertPastedRound({ clanId: 1, date: DATE, summon, rows, eventKey });
const player = (name: string) => tinman.getTinmanStandings(1, DATE).players.find((p) => p.name === name);

beforeEach(() => {
  ({ cleanup } = makeTestDb());
  seedTwoClans();
});
afterEach(() => cleanup());

describe('pasted tinman standings', () => {
  it('turns cumulative snapshots into points per summon', () => {
    addMember(1, 'Frostbite');
    addMember(1, 'Ace');
    paste(1, [['Frostbite', 20_000_000], ['Ace', 0]]);
    paste(2, [['Frostbite', 45_000_000], ['Ace', 4_000_000]]);
    paste(3, [['Frostbite', 59_878_655], ['Ace', 4_000_000]]);

    expect(player('Frostbite')).toMatchObject({
      perSummon: { 1: 20_000_000, 2: 25_000_000, 3: 14_878_655 }, total: 59_878_655, played: 3,
    });
    // Played summon 2 only.
    expect(player('Ace')).toMatchObject({ perSummon: { 1: 0, 2: 4_000_000, 3: 0 }, total: 4_000_000, played: 1 });
  });

  it('puts a missed summon\'s points on the next summon that was pasted', () => {
    addMember(1, 'Frostbite');
    paste(1, [['Frostbite', 20_000_000]]);
    paste(3, [['Frostbite', 59_000_000]]); // summon 2 never pasted
    const s = tinman.getTinmanStandings(1, DATE);
    expect(s.summons.map((u) => u.summon)).toEqual([1, 3]);
    expect(player('Frostbite')).toMatchObject({ perSummon: { 1: 20_000_000, 3: 39_000_000 }, total: 59_000_000 });
  });

  it('keeps a name nobody was assigned to as its own player, counted in the upload', () => {
    addMember(1, 'Ace');
    paste(1, [['Ace', 10], ['Nobody Known', 5]]);
    paste(2, [['Ace', 30], ['Nobody Known', 9]]);
    const s = tinman.getTinmanStandings(1, DATE);
    expect(s.players.map((p) => [p.rawName, p.memberId === null, p.total])).toEqual([['Ace', false, 30], ['Nobody Known', true, 9]]);
    expect(s.summons.map((u) => u.unmatched)).toEqual([1, 1]);
  });

  it('keeps clans apart', () => {
    addMember(1, 'Ace');
    paste(1, [['Ace', 5]]);
    expect(tinman.getTinmanStandings(2, DATE).players).toEqual([]);
    expect(tinman.listTinmanDates(1)).toEqual([DATE]);
    expect(tinman.listTinmanDates(2)).toEqual([]);
  });

  it('keeps Olympus days apart from an Ancients run on the same day', () => {
    addMember(1, 'Ace');
    paste(1, [['Ace', 5]]);
    paste(1, [['Ace', 900]], 'olympus');
    expect(tinman.getTinmanStandings(1, DATE).players).toMatchObject([{ name: 'Ace', total: 5 }]);
    expect(tinman.getTinmanStandings(1, DATE, 'olympus').players).toMatchObject([{ name: 'Ace', total: 900 }]);
    expect(tinman.listTinmanDates(1, 30, 'olympus')).toEqual([DATE]);
    expect(tinman.listTinmanDates(1, 30, 'ragnarok')).toEqual([]);
  });
});

describe('tinman targets', () => {
  it('saves, replaces and removes a run\'s targets', () => {
    tinman.saveTinmanTargets({ clanId: 1, date: DATE, tiers: { g7: 1_300_000 }, kills: 3, savedBy: 'taulen' });
    expect(tinman.getTinmanTargets(1, DATE)).toMatchObject({ tiers: { g7: 1_300_000 }, kills: 3 });
    tinman.saveTinmanTargets({ clanId: 1, date: DATE, tiers: { g6: 600_000 }, kills: null, savedBy: 'taulen' });
    expect(tinman.getTinmanTargets(1, DATE)?.tiers).toEqual({ g6: 600_000 });
    expect(tinman.getTinmanTargets(2, DATE)).toBeNull();
    expect(tinman.deleteTinmanTargets(1, DATE)).toBe(true);
    expect(tinman.getTinmanTargets(1, DATE)).toBeNull();
  });
});
