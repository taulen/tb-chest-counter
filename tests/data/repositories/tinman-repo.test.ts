import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import * as tinman from '../../../src/data/repositories/tinman-repo.js';
import { addMergeRule } from '../../../src/data/repositories/merge-repo.js';
import { getMemberById } from '../../../src/data/repositories/member-repo.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

let cleanup: () => void;
const DATE = '2026-10-23';

function addMember(clanId: number, name: string, active = 1): number {
  const now = new Date().toISOString();
  const row = getDb().prepare(
    `INSERT INTO members (clan_id, name, normalized_name, despaced_name, first_seen, last_seen, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(clanId, name, name.toLowerCase(), name.toLowerCase().replace(/\s+/g, ''), now, now, active) as { id: number };
  return row.id;
}

const rows = (...r: Array<[string, number]>) => r.map(([name, points], i) => ({ rank: i + 1, name, points }));
const save = (summon: number, r: ReturnType<typeof rows>) =>
  tinman.saveTinmanSummon({ clanId: 1, date: DATE, summon, rows: r, uploadedBy: 'taulen' });
const player = (name: string) => tinman.getTinmanStandings(1, DATE).players.find((p) => p.name === name);

beforeEach(() => {
  ({ cleanup } = makeTestDb());
  seedTwoClans();
});
afterEach(() => cleanup());

describe('tinman standings', () => {
  it('turns cumulative snapshots into points per summon', () => {
    addMember(1, 'Frostbite');
    addMember(1, 'Ace');
    save(1, rows(['Frostbite', 20_000_000], ['Ace', 0]));
    save(2, rows(['Frostbite', 45_000_000], ['Ace', 4_000_000]));
    save(3, rows(['Frostbite', 59_878_655], ['Ace', 4_000_000]));

    expect(player('Frostbite')).toMatchObject({
      perSummon: { 1: 20_000_000, 2: 25_000_000, 3: 14_878_655 }, total: 59_878_655, played: 3,
    });
    // Played summon 2 only.
    expect(player('Ace')).toMatchObject({ perSummon: { 1: 0, 2: 4_000_000, 3: 0 }, total: 4_000_000, played: 1 });
  });

  it('puts a missed summon\'s points on the next summon that was pasted', () => {
    addMember(1, 'Frostbite');
    save(1, rows(['Frostbite', 20_000_000]));
    save(3, rows(['Frostbite', 59_000_000])); // summon 2 never pasted
    const s = tinman.getTinmanStandings(1, DATE);
    expect(s.summons.map((u) => u.summon)).toEqual([1, 3]);
    expect(player('Frostbite')).toMatchObject({ perSummon: { 1: 20_000_000, 3: 39_000_000 }, total: 59_000_000 });
  });

  it('replaces a summon when it is pasted again', () => {
    addMember(1, 'Ace');
    save(1, rows(['Ace', 100]));
    const again = save(1, rows(['Ace', 250]));
    expect(again.replaced).toBe(true);
    expect(tinman.getTinmanStandings(1, DATE).summons).toHaveLength(1);
    expect(player('Ace')?.total).toBe(250);
  });

  it('matches exactly, by alias, and by spelling — including the Cyrillic look-alike from a real paste', () => {
    addMember(1, 'Mikam Chaosraven');
    const lady = addMember(1, 'Lady C');
    getDb().prepare("UPDATE members SET aliases = '[\"LadyC II\"]' WHERE id = ?").run(lady);
    const result = save(1, rows(['MиkaM Chaosraven', 511_824], ['LadyC II', 30_464_799], ['Nobody Known', 5]));
    expect(result).toMatchObject({ rows: 3, matched: 2, fuzzy: 1, unmatched: 1 });

    const s = tinman.getTinmanStandings(1, DATE);
    expect(s.players.find((p) => p.rawName === 'MиkaM Chaosraven')).toMatchObject({ name: 'Mikam Chaosraven', matchKind: 'fuzzy' });
    expect(s.players.find((p) => p.rawName === 'LadyC II')).toMatchObject({ memberId: lady, matchKind: 'exact' });
    expect(s.review.map((r) => r.rawName).sort()).toEqual(['MиkaM Chaosraven', 'Nobody Known']);
  });

  it('never hands one member two rows: an exact claim beats a fuzzy one', () => {
    addMember(1, 'Ironhide');
    save(1, rows(['Ironhyde', 10], ['Ironhide', 20]));
    const s = tinman.getTinmanStandings(1, DATE);
    expect(s.players.find((p) => p.rawName === 'Ironhide')?.matchKind).toBe('exact');
    expect(s.players.find((p) => p.rawName === 'Ironhyde')?.memberId).toBeNull();
  });

  it('honours player merge rules', () => {
    addMember(1, 'Lady C');
    addMember(1, 'Zz Placeholder');
    addMergeRule('player', 'Ladyyy Ceee', 'Lady C', 1);
    save(1, rows(['Ladyyy Ceee', 7]));
    expect(player('Lady C')?.matchKind).toBe('exact');
  });

  it('remembers an admin\'s assignment across the run, and as an alias for future runs', () => {
    const tash = addMember(1, 'TASH II');
    save(1, rows(['T A S H 2!!', 100]));
    expect(tinman.assignTinmanName(1, DATE, 'T A S H 2!!', tash)).toBe(1);
    save(2, rows(['T A S H 2!!', 300]));
    expect(player('TASH II')).toMatchObject({ matchKind: 'manual', perSummon: { 1: 100, 2: 200 } });
    expect(getMemberById(tash, 1)?.aliases).toContain('T A S H 2!!');
  });

  it('keeps a rejected spelling match rejected on the next upload', () => {
    addMember(1, 'Ironhide');
    save(1, rows(['Ironhyde', 10]));
    expect(tinman.assignTinmanName(1, DATE, 'Ironhyde', null)).toBe(1);
    save(2, rows(['Ironhyde', 30]));
    const p = tinman.getTinmanStandings(1, DATE).players.find((x) => x.rawName === 'Ironhyde');
    expect(p).toMatchObject({ memberId: null, matchKind: 'rejected', total: 30 });
  });

  it('follows a player merge instead of dropping the match', () => {
    addMember(1, 'Fiin SK 2');
    const target = addMember(1, 'Fiin SK II');
    save(1, rows(['Fiin SK 2', 63_965_364]));
    addMergeRule('player', 'Fiin SK 2', 'Fiin SK II', 1);
    const p = tinman.getTinmanStandings(1, DATE).players[0];
    expect(p).toMatchObject({ memberId: target, total: 63_965_364 });
  });

  it('keeps clans apart', () => {
    addMember(1, 'Ace');
    save(1, rows(['Ace', 5]));
    expect(tinman.getTinmanStandings(2, DATE).players).toEqual([]);
    expect(tinman.listTinmanDates(1)).toEqual([DATE]);
    expect(tinman.listTinmanDates(2)).toEqual([]);
  });
});
