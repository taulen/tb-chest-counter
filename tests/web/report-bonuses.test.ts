/**
 * Card bonuses from a player's own battle report (lib/report-bonuses.js,
 * data/report-armies.ts, docs/battle-reports.md). The strikes are the Nov 7
 * 2026 Elven 30 report (citadel opens; the army and the card bonuses the user
 * typed that day are pinned in citadel-sim.test.ts): every bonus the report
 * can show must come back exactly as the cards said.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bonusesFromReport, troopForUnit } from '../../src/web/public/lib/report-bonuses.js';
import { reportArmiesFor } from '../../src/data/report-armies.js';
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
    attackers: [{ playerId: PLAYER, armyId: ME, units: ARMY.map(([unit, count]) => ({ unit, count })), killed: { 206: 140 } }],
    defenders: [{ playerId: 1116691496961, armyId: CIT, units: [{ unit: 51, count: 135000 }], killed: {} }],
  };
}

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); seedTwoClans(); });
afterEach(() => cleanup());

async function armies() {
  recordReportShares(1, [{ channelUrl: 'whisper_1_2', messageId: 1, createdAt: 1, senderName: '', senderInfo: '',
    data: JSON.stringify({ subs: { '/%0%/': { type: 'journal', entryType: 'attack', staticId: 1817, journalV2EntryId: 'dddddddd-0000-4000-8000-000000000001' } } }) }]);
  saveFetchedReport('dddddddd-0000-4000-8000-000000000001', { at: 1_794_085_235, type: 'battle', report: report(), raw: Buffer.from([0x90]), strikeLog: null, strikes: STRIKES });
  return reportArmiesFor([PLAYER], 8, { units: () => UNITS, objects: async () => ({ 1817: 'Elven Citadel' }) });
}

describe('report armies', () => {
  it('sends each troop’s health per unit from its first hit, and the base damage of strikes that weren’t capped', async () => {
    const [a] = await armies();
    expect(a).toMatchObject({ at: '2026-11-07T21:00:35.000Z', target: { staticId: 1817, name: 'Elven Citadel' }, won: true });
    const corax = a.troops.find((t) => t.unit === 206)!;
    expect(corax.unitHealth).toBeCloseTo(4_454_295_273 / 601, 6);
    // Doubled (extraB = the damage before the luck); a capped strike without one is left out.
    expect(corax.strikes).toEqual([{ count: 527, base: 1_717_924_086, target: { unit: 6035, ...UNITS.get(6035) } }]);
    expect(a.troops.find((t) => t.unit === 32)!.strikes[0].base).toBe(369_110_530);
    expect(a.troops.find((t) => t.unit === 214)!.strikes).toEqual([]);
    expect(a.troops.find((t) => t.unit === 191)!.unitHealth).toBeNull();
  });

  it('only for the players asked about', async () => {
    await armies();
    expect(await reportArmiesFor([PLAYER + 1], 8, { units: () => UNITS, objects: async () => ({}) })).toEqual([]);
  });
});

describe('card bonuses from a report', () => {
  it('gives back the bonuses the user typed from the cards that day', async () => {
    const [a] = await armies();
    const found = bonusesFromReport(a);
    expect(found.get('corax-1')).toEqual({ strengthPct: 5226.5, healthPct: 3936.8 });
    expect(found.get('fire-phoenix-1')).toEqual({ strengthPct: 3736.5, healthPct: null });
    expect(found.get('vulture-6')?.strengthPct).toBe(3636.5);
    expect(found.get('griffin-6')?.strengthPct).toBe(5326.5);
    expect(found.get('griffin-7')?.strengthPct).toBe(5326.5);
  });

  it('leaves out what the report can’t show: capped strikes, hits on the walls, troops never hit', async () => {
    const [a] = await armies();
    const found = bonusesFromReport(a);
    expect(found.has('royal-lion-1')).toBe(false);
    expect(found.has('vulture-7')).toBe(false);
    expect(found.has('siege-ballistae-7')).toBe(false);
  });

  it('matches a unit to the calculator’s troop by game name and base stats', () => {
    expect(troopForUnit({ name: 'Corax I', strength: 61200, health: 183600 })?.id).toBe('corax-1');
    expect(troopForUnit({ name: 'Battle griffin VII', strength: 34000, health: 102000 })?.id).toBe('griffin-7');
    expect(troopForUnit({ name: 'Mechanical Griffin', strength: 70000, health: 210000 })).toBeNull();
  });
});
