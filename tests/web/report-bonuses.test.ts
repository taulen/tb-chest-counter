/**
 * Card bonuses from a player's own battle report (lib/report-bonuses.js,
 * data/report-armies.ts, docs/battle-reports.md). The strikes are the Nov 7
 * 2026 Elven 30 report (citadel opens; the army and the card bonuses the user
 * typed that day are pinned in citadel-sim.test.ts): every bonus the report
 * can show must come back exactly as the cards said.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bonusesFromReport, reportGaps, strikeBonus, troopForUnit, withGapsFilled } from '../../src/web/public/lib/report-bonuses.js';
import { troopById } from '../../src/web/public/lib/citadel-sim.js';
import { reportArmiesFor, reportPlayers } from '../../src/data/report-armies.js';
import { getDb } from '../../src/data/database.js';
import { saveFetchedReport, recordReportShares } from '../../src/data/repositories/battle-report-repo.js';
import type { BattleReport, Strike } from '../../src/game-protocol/battle-report.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

// The game's T9 rows for the units in that battle.
const UNITS = new Map([
  [32, { name: 'Battle griffin VI', strength: 19000, health: 57000 }],
  [33, { name: 'Battle griffin VII', strength: 34000, health: 102000 }],
  [35, { name: 'Vulture VI', strength: 940, health: 2820 }],
  [36, { name: 'Vulture VII', strength: 1700, health: 5100 }],
  [51, { name: 'Citadel Walls', strength: 10000, health: 30000 }],
  [87, { name: 'Siege ballistae VII', strength: 8500, health: 51000 }],
  [191, { name: 'Fire Phoenix I', strength: 660000, health: 1980000 }],
  [206, { name: 'Corax I', strength: 61200, health: 183600 }],
  [214, { name: 'Royal Lion I', strength: 61200, health: 183600 }],
  [6032, { name: 'Centaur', strength: 2600, health: 7800 }],
  [6033, { name: 'Bear', strength: 22000, health: 66000 }],
  [6034, { name: 'Ent', strength: 73000, health: 219000 }],
  [6035, { name: 'Life Dragon', strength: 240000, health: 720000 }],
  [6070, { name: 'Pegasus Rider', strength: 8200, health: 24600 }],
  [6031, { name: 'Druid', strength: 900, health: 2700 }],
]);
const ME = 1001;
const CIT = 2002;
const s = (byAttacker: boolean, unit: number, count: number, damage: number, extraA: number, extraB: number, targetUnit: number, targetCount: number, poolBefore: number, countAfter: number): Strike => ({
  byAttacker, armyId: byAttacker ? ME : CIT, unit, count, damage, extraA, extraB, targetArmyId: byAttacker ? CIT : ME, targetUnit, targetCount, poolBefore, countAfter, poolAfter: 0,
});
// The report's 11 strikes, as the game logged them.
const STRIKES: Strike[] = [
  s(true, 87, 789, 4_050_000_000, 3_895_575_072, 0, 51, 135000, 4_050_000_000, 0),
  s(false, 6035, 2300, 552_000_000, 0, 0, 206, 601, 4_454_295_273, 527),
  s(true, 206, 527, 1_656_000_000, 0, 1_717_924_086, 6035, 2300, 1_656_000_000, 0),
  s(false, 6034, 4300, 313_900_000, 0, 0, 206, 527, 3_902_295_273, 485),
  s(true, 191, 26, 792_000_000, 122_356_363, 778_635_000, 6033, 12000, 792_000_000, 0),
  s(false, 6070, 21000, 172_200_000, 0, 0, 206, 485, 3_588_395_273, 461),
  s(true, 36, 5812, 382_200_000, 46_218_280, 0, 6032, 49000, 382_200_000, 0),
  s(true, 35, 10510, 738_287_562, 0, 369_143_781, 6034, 4300, 941_700_000, 929),
  s(true, 32, 358, 369_110_530, 0, 0, 6070, 21000, 516_600_000, 5996),
  s(true, 33, 199, 203_412_438, 0, 367_156_990, 6034, 929, 203_412_438, 0),
  s(true, 214, 98, 147_489_470, 0, 0, 6070, 5996, 147_489_470, 0),
];
const ARMY: Array<[number, number]> = [[32, 358], [33, 199], [35, 10510], [36, 5812], [87, 789], [191, 26], [206, 601], [214, 98]];
const PLAYER = 1241245577338;

function report(): BattleReport {
  return {
    kind: 'battle', won: true, rounds: 10, targetStaticId: 1817, strikeLogId: 'x',
    attackers: [{ playerId: PLAYER, armyId: ME, units: ARMY.map(([unit, count]) => ({ unit, count })), killed: { 206: 140 }, effects: [] }],
    defenders: [{ playerId: 1116691496961, armyId: CIT, units: [{ unit: 51, count: 135000 }], killed: {}, effects: [] }],
  };
}

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); seedTwoClans(); });
afterEach(() => cleanup());

const LOOKUPS = { units: () => UNITS, objects: async () => ({ 1817: 'Elven Citadel' }) };
const ENTRY = 'dddddddd-0000-4000-8000-000000000001';
const POSTER = 1241245599999;

/** The Nov 7 battle, shared in `clanId`'s chat by `sender` (player id, name). */
function share(clanId = 1, sender: [number, string] = [PLAYER, 'taulen'], entryId = ENTRY) {
  recordReportShares(clanId, [{ channelUrl: 'triumph_clan_channel_1', messageId: 1, createdAt: 1, senderName: sender[1],
    senderInfo: `121,${sender[0].toString(16)},12c00000202,0,4,CWB`,
    data: JSON.stringify({ subs: { '/%0%/': { type: 'journal', entryType: 'attack', staticId: 1817, journalV2EntryId: entryId } } }) }]);
  saveFetchedReport(entryId, { at: 1_794_085_235, type: 'battle', report: report(), raw: Buffer.from([0x90]), strikeLog: null, strikes: STRIKES });
}

async function armies() {
  share();
  return reportArmiesFor(PLAYER, { clanId: null, namesClanId: 1 }, LOOKUPS);
}

describe('report armies', () => {
  it('sends each troop’s health per unit from its first hit, and every strike it made as the log has it', async () => {
    const [a] = await armies();
    expect(a).toMatchObject({ at: '2026-11-07T21:00:35.000Z', target: { staticId: 1817, name: 'Elven Citadel' }, won: true });
    const corax = a.troops.find((t) => t.unit === 206)!;
    expect(corax.unitHealth).toBeCloseTo(4_454_295_273 / 601, 6);
    expect(corax.strikes).toEqual([{
      count: 527, damage: 1_656_000_000, extraA: 0, extraB: 1_717_924_086, capped: true, target: { unit: 6035, ...UNITS.get(6035) },
    }]);
    expect(a.troops.find((t) => t.unit === 32)!.strikes[0]).toMatchObject({ damage: 369_110_530, capped: false });
    expect(a.troops.find((t) => t.unit === 214)!.strikes[0]).toMatchObject({ capped: true, extraB: 0 });
    expect(a.troops.find((t) => t.unit === 191)!.unitHealth).toBeNull();
  });

  it('only for the player asked about', async () => {
    await armies();
    expect(await reportArmiesFor(PLAYER + 1, { clanId: null, namesClanId: 1 }, LOOKUPS)).toEqual([]);
  });

  it('lists a battle the player posted too, saying whose army it is', async () => {
    share(1, [POSTER, 'Poster']);
    const [a] = await reportArmiesFor(POSTER, { clanId: 1, namesClanId: 1 }, LOOKUPS);
    expect(a).toMatchObject({ attacker: { playerId: PLAYER }, sharedBy: 'Poster' });
  });

  it('shows another player’s battles only as shared in the clan being viewed', async () => {
    share(2, [PLAYER, 'taulen']);
    expect(await reportArmiesFor(PLAYER, { clanId: 1, namesClanId: 1 }, LOOKUPS)).toEqual([]);
    expect(await reportArmiesFor(PLAYER, { clanId: 2, namesClanId: 2 }, LOOKUPS)).toHaveLength(1);
    // The viewer's own player: every clan's shares.
    expect(await reportArmiesFor(PLAYER, { clanId: null, namesClanId: 1 }, LOOKUPS)).toHaveLength(1);
  });
});

describe('every troop’s card from one report: its effects + the army-wide part, measured', () => {
  // The Nov 7 Elven 10 one-of-each fight: each troop's effects sum (troop-effects.ts on the
  // march, checked in the game data) and what the battle shows exactly — Battle Griffin VII's
  // doubled strike, Fire Phoenix I's first hit, the Ballistae on the walls. Every other strike
  // killed its target.
  const T = (unit: number, card: [number, number], extra: object = {}) => ({
    unit, ...UNITS.get(unit)!, count: 1, card: { strength: card[0], health: card[1] }, unitHealth: null, strikes: [], ...extra,
  });
  const e10 = {
    entryId: 'e10', at: '2026-11-07T20:51:45.000Z', attacker: { playerId: PLAYER, name: '' }, target: { name: '' }, won: true, sharedBy: '',
    troops: [
      T(33, [5226.5, 3921.75], { strikes: [{ count: 1, damage: 270_000, extraA: 0, extraB: 1_845_010, capped: true, target: { unit: 6031, ...UNITS.get(6031)! } }] }),
      T(191, [3636.5, 2679.75], { unitHealth: 57_316_050 }),
      T(87, [2177, 1501.75], { strikes: [{ count: 1, damage: 2_700_000, extraA: 2_597_050, extraB: 0, capped: true, target: { unit: 51, ...UNITS.get(51)! } }] }),
      T(206, [5126.5, 3821.75]),
      T(214, [3636.5, 2679.75]),
      T(32, [5226.5, 3921.75]),
      T(35, [3536.5, 2579.75]),
    ],
  };

  it('measures the army-wide part from what the battle shows', () => {
    const g = reportGaps(e10);
    expect(g.strength).toBeCloseTo(100, 2);
    expect(g.health).toBeCloseTo(115, 6);
  });

  it('gives every troop its card at full precision — those it can’t show too', () => {
    const found = bonusesFromReport(e10);
    // The cards read 5226.5 / 3936.8 …: the game's own numbers end in .75.
    expect(found.get('corax-1')).toEqual({ strengthPct: 5226.5, healthPct: 3936.75 });
    expect(found.get('royal-lion-1')).toEqual({ strengthPct: 3736.5, healthPct: 2794.75 });
    expect(found.get('griffin-6')).toEqual({ strengthPct: 5326.5, healthPct: 4036.75 });
    expect(found.get('griffin-7')).toEqual({ strengthPct: 5326.5, healthPct: 4036.75 });
    expect(found.get('siege-ballistae-7')).toEqual({ strengthPct: 2277, healthPct: 1616.75 });
    expect(found.get('fire-phoenix-1')).toEqual({ strengthPct: 3736.5, healthPct: 2794.75 });
    expect(found.get('vulture-6')).toEqual({ strengthPct: 3636.5, healthPct: 2694.75 });
  });

  it('takes the army-wide part from the same army’s nearest battle when this one shows nothing', () => {
    const blind = { ...e10, entryId: 'blind', at: '2026-11-07T21:30:00.000Z', troops: [T(206, [5126.5, 3821.75]), T(214, [3636.5, 2679.75])] };
    expect(bonusesFromReport(blind).size).toBe(0);
    const { found, gapsFrom } = withGapsFilled(blind, [blind, e10]);
    expect(gapsFrom?.entryId).toBe('e10');
    expect(found.get('corax-1')).toEqual({ strengthPct: 5226.5, healthPct: 3936.75 });
  });
});

describe('the players to pick from', () => {
  it('the viewer’s own players first, then whoever fought or posted a battle shared in the clan', () => {
    share(1, [POSTER, 'Poster']);
    const own = 4599909976661;
    const players = reportPlayers(1, [own]);
    // Named before unnamed (the army's owner here has no game data and never posted).
    expect(players.map((p) => [p.playerId, p.own, p.battles])).toEqual([[own, true, 0], [POSTER, false, 1], [PLAYER, false, 1]]);
    expect(players.find((p) => p.playerId === POSTER)?.name).toBe('Poster');
  });

  it('leaves out a clan’s battles for another clan', () => {
    share(2, [PLAYER, 'taulen']);
    expect(reportPlayers(1, [])).toEqual([]);
    expect(reportPlayers(2, []).map((p) => p.playerId)).toEqual([PLAYER]);
  });
});

describe('card bonuses from a report', () => {
  it('gives back the bonuses the user typed from the cards that day', async () => {
    const [a] = await armies();
    const found = bonusesFromReport(a);
    expect(found.get('corax-1')).toEqual({ strengthPct: 5226.5, healthPct: 3936.75 });
    expect(found.get('fire-phoenix-1')).toEqual({ strengthPct: 3736.5, healthPct: null });
    expect(found.get('vulture-6')?.strengthPct).toBe(3636.5);
    expect(found.get('griffin-6')?.strengthPct).toBe(5326.5);
    expect(found.get('griffin-7')?.strengthPct).toBe(5326.5);
  });

  it('leaves out what the report can’t show: a strike that killed its target without doubling, a troop never hit', async () => {
    const [a] = await armies();
    const found = bonusesFromReport(a);
    expect(found.has('royal-lion-1')).toBe(false);
    expect(found.has('vulture-7')).toBe(false);
  });

  it('takes the features out with the log’s own share (extraA), so no feature table is needed', () => {
    const phoenix = troopById('fire-phoenix-1');
    const bear = { unit: 6033, ...UNITS.get(6033)! };
    // Phoenix I on the Bear, doubled and capped: extraB is the base, extraA the features' share of the damage.
    expect(strikeBonus(phoenix, { count: 26, damage: 792_000_000, extraA: 122_356_363, extraB: 778_635_000, capped: true, target: bear })! * 100)
      .toBeCloseTo(3736.5, 1);
    // The Nov 5 one, with that day's 3658.5% on a Pegasus Rider (no features).
    expect(strikeBonus(phoenix, { count: 26, damage: 516_600_000, extraA: 0, extraB: 644_958_600, capped: true, target: { unit: 6070, ...UNITS.get(6070)! } })! * 100)
      .toBeCloseTo(3658.5, 1);
    // Capped without doubling: only what the kill took — no answer.
    expect(strikeBonus(phoenix, { count: 1, damage: 594_000, extraA: 91_767, extraB: 0, capped: true, target: bear })).toBeNull();
  });

  it('reads a siege engine from its hits on the walls (×20), killed or not', () => {
    const ballistae = troopById('siege-ballistae-7');
    const walls = { unit: 51, ...UNITS.get(51)! };
    // Nov 7: one Ballistae on Elven 10's walls, and 789 on Elven 30's — the card said 2277%.
    expect(strikeBonus(ballistae, { count: 1, damage: 2_700_000, extraA: 2_597_050, extraB: 0, capped: true, target: walls })! * 100).toBeCloseTo(2277, 0);
    expect(strikeBonus(ballistae, { count: 789, damage: 4_050_000_000, extraA: 3_895_575_072, extraB: 0, capped: true, target: walls })! * 100).toBeCloseTo(2277, 0);
    // Nov 5, 779 of them: 2229%.
    expect(strikeBonus(ballistae, { count: 779, damage: 4_050_000_000, extraA: 3_896_326_979, extraB: 0, capped: true, target: walls })! * 100).toBeCloseTo(2229, 0);
  });

  it('fills what the picked battle can’t show from the same army’s battles that day, nearest first', async () => {
    const [a] = await armies();
    // The Elven 10 one-of-each fight two minutes earlier: every strike killed its target; only the Phoenix was hit.
    const e10 = {
      ...a, entryId: 'e10', at: '2026-11-07T20:51:45.000Z',
      troops: [
        { unit: 191, ...UNITS.get(191)!, count: 1, unitHealth: 57_316_050, strikes: [] },
        { unit: 206, ...UNITS.get(206)!, count: 1, unitHealth: null, strikes: [] },
      ],
    };
    const weekLater = { ...a, entryId: 'later', at: '2026-11-14T20:00:00.000Z' };
    const { found, borrowed } = withGapsFilled(e10, [e10, a, weekLater]);
    expect(found.get('fire-phoenix-1')).toEqual({ strengthPct: 3736.5, healthPct: 2794.75 });
    expect(found.get('corax-1')).toEqual({ strengthPct: 5226.5, healthPct: 3936.75 });
    expect(borrowed.map((b) => b.report.entryId)).toEqual([a.entryId]);
    // Another player's army is never mixed in.
    const other = { ...a, entryId: 'other', attacker: { playerId: PLAYER + 1, name: '' } };
    expect(withGapsFilled(e10, [e10, other]).borrowed).toEqual([]);
  });

  it('matches a unit to the calculator’s troop by game name and base stats', () => {
    expect(troopForUnit({ name: 'Corax I', strength: 61200, health: 183600 })?.id).toBe('corax-1');
    expect(troopForUnit({ name: 'Battle griffin VII', strength: 34000, health: 102000 })?.id).toBe('griffin-7');
    expect(troopForUnit({ name: 'Mechanical Griffin', strength: 70000, health: 210000 })).toBeNull();
  });
});
