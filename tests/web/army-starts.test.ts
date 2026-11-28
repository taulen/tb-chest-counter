/**
 * Learned starting points for the count search (lib/army-starts.js): a known
 * answer kept as roles (the share of an enemy stack's health a row's strike
 * takes, the hits it can absorb, a plain count) and carried over to another
 * army — its own bonuses, caps and troops — and the data file the pages load.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { rolesOf, startsFrom, exemplarsFor, citadelExemplars, ARMY_STARTS_FORMAT, encodeRole, decodeRole, decodeArmyStarts } from '../../src/web/public/lib/army-starts.js';
import { citadelSearch, troopById, lossPrice } from '../../src/web/public/lib/citadel-sim.js';
import { optimizeArmy, simulateBothArmies } from '../../src/web/public/lib/battle-sim.js';

const cards: Array<[string, number, number]> = [
  ['siege-ballistae-7', 2277, 1616.75], ['corax-1', 5226.5, 3936.75], ['fire-phoenix-1', 3736.5, 2794.75],
  ['royal-lion-1', 3736.5, 2794.75], ['griffin-7', 5326.5, 4036.75], ['vulture-7', 3636.5, 2694.75],
];
const rowsOf = (list: Array<[string, number, number]>) => list.map(([troopId, strengthPct, healthPct]) => ({ troopId, count: 0, strengthPct, healthPct }));
// Citadel's own answer for the user's Elven 25 cards (15 / 31 Corax I lost).
const answer = [365, 124, 4, 30, 31, 1169];
const e25 = (list = cards) => citadelSearch({ citadelId: 'elven-25', army: rowsOf(list), starts: [] })!;

describe('learned starts', () => {
  it('give an army its own answer back', () => {
    const p = e25();
    const roles = rolesOf({ army: p.army, enemy: p.enemy, counts: answer, enemySide: 'citadel' });
    expect(roles.map((r) => r[0])).toEqual(cards.map(([id]) => id));
    expect(startsFrom({ exemplars: [{ r: roles }], army: p.army, enemy: p.enemy, enemySide: 'citadel' })).toEqual([answer]);
  });

  it('carry over to other bonuses: a stronger killer needs fewer units', () => {
    const p = e25();
    const roles = rolesOf({ army: p.army, enemy: p.enemy, counts: answer, enemySide: 'citadel' });
    const stronger = e25(cards.map(([id, s, h]) => [id, (1 + s / 100) * 1.1 * 100 - 100, h]));
    const [counts] = startsFrom({ exemplars: [{ r: roles }], army: stronger.army, enemy: stronger.enemy, enemySide: 'citadel' });
    // The Vultures (a killer, 'k') shrink by about the bonus; nothing grows.
    expect(counts[5]).toBeLessThan(answer[5]);
    expect(counts[5]).toBeGreaterThan(answer[5] * 0.85);
    counts.forEach((c, i) => expect(c).toBeLessThanOrEqual(answer[i] + 1));
  });

  it('stand in for a missing troop with one of the same kind and way of fighting', () => {
    const p = e25();
    const roles = rolesOf({ army: p.army, enemy: p.enemy, counts: answer, enemySide: 'citadel' });
    const swapped = e25(cards.map(([id, s, h]) => [id === 'vulture-7' ? 'vulture-6' : id, s, h]));
    const [without] = startsFrom({ exemplars: [{ r: roles }], army: swapped.army, enemy: swapped.enemy, enemySide: 'citadel' });
    expect(without[5]).toBe(0);
    const [withStandIn] = startsFrom({ exemplars: [{ r: roles }], army: swapped.army, enemy: swapped.enemy, enemySide: 'citadel', defOf: (k: string) => troopById(k) });
    expect(withStandIn[5]).toBeGreaterThan(answer[5]);
  });

  it('degrade to nothing: no answers, an enemy stack that is gone, a troop it can’t place', () => {
    const p = e25();
    expect(startsFrom({ exemplars: [], army: p.army, enemy: p.enemy })).toEqual([]);
    expect(startsFrom({ exemplars: [{ r: [['corax-1', 'k', 42, 1.02]] }], army: p.army, enemy: p.enemy })).toEqual([]);
    expect(startsFrom({ exemplars: [{ r: [['no-such-troop', 'k', 0, 1.02]] }], army: p.army, enemy: p.enemy })).toEqual([]);
    expect(exemplarsFor(null, '1', 'x', 3).exemplars).toEqual([]);
    expect(citadelExemplars(null, 'elven-25').exemplars).toEqual([]);
  });

  it('borrow the same family’s nearest level when a target has no answers', () => {
    const lib = { v: 1, targets: { 10: { e: [1], x: [{ r: [['a', 'n', 0, 1]] }] }, 30: { e: [1], x: [{ r: [['b', 'n', 0, 2]] }] } }, families: { Fam: [[10, 10], [30, 30]] } };
    expect(exemplarsFor(lib, '30').exemplars).toEqual(lib.targets[30].x);
    expect(exemplarsFor(lib, '25', 'Fam', 25).exemplars).toEqual(lib.targets[30].x);
    expect(exemplarsFor(lib, '25', 'Other', 25).exemplars).toEqual([]);
  });

  it('survive the file’s short form within a unit or two', () => {
    const p = e25();
    const roles = rolesOf({ army: p.army, enemy: p.enemy, counts: answer, enemySide: 'citadel' });
    const back = roles.map((r) => decodeRole(encodeRole(r)));
    const [counts] = startsFrom({ exemplars: [{ r: back }], army: p.army, enemy: p.enemy, enemySide: 'citadel' });
    counts.forEach((c, i) => expect(Math.abs(c - answer[i])).toBeLessThanOrEqual(Math.max(1, answer[i] * 0.001)));
    expect(decodeArmyStarts({ v: 0 })).toBeNull();
  });

  it('follow an enemy stack a patch moved, and drop roles on a unit that is gone', () => {
    const p = e25();
    const roles = rolesOf({ army: p.army, enemy: p.enemy, counts: answer, enemySide: 'citadel' });
    const ids = p.enemy.map((x: { def: { id: string } }) => x.def.id);
    const moved = [...p.enemy].reverse();
    const [back] = startsFrom({ exemplars: [{ r: roles }], enemyIds: ids, army: p.army, enemy: moved, enemySide: 'citadel' });
    expect(back).toEqual(answer);
    const gone = p.enemy.filter((x: { def: { id: string } }) => x.def.id !== ids[4]);
    const [partial] = startsFrom({ exemplars: [{ r: roles }], enemyIds: ids, army: p.army, enemy: gone, enemySide: 'citadel' });
    expect(partial[5]).toBe(0);
  });
});

describe('the learned starts file', () => {
  const file = path.join(__dirname, '../../src/web/public/data/army-starts.json');
  it.runIf(fs.existsSync(file))('is the format the pages read and stays under 200 KB gzipped', () => {
    const raw = fs.readFileSync(file);
    const lib = JSON.parse(raw.toString('utf8'));
    expect(lib.v).toBe(ARMY_STARTS_FORMAT);
    expect(decodeArmyStarts(lib)).not.toBeNull();
    expect(zlib.gzipSync(raw).length).toBeLessThan(200 * 1024);
  });

  // The user's own cards were never learned from (held out); game01master's starts are not given.
  it.runIf(fs.existsSync(file))('takes the user’s Elven 25 / 30 cards to Citadel’s own 15 / 31 and 80 / 154 — or better — without game01master', () => {
    const lib = decodeArmyStarts(JSON.parse(fs.readFileSync(file, 'utf8')));
    for (const [citadelId, want] of [['elven-25', [15, 31]], ['elven-30', [80, 154]]] as const) {
      const p = citadelSearch({ citadelId, army: rowsOf(cards), starts: [cards.map(() => 0)] })!;
      p.starts.push(...startsFrom({ ...citadelExemplars(lib, citadelId), army: p.army, enemy: p.enemy, enemySide: 'citadel', defOf: (k: string) => troopById(k) }));
      const res = optimizeArmy({ ...(p as unknown as Parameters<typeof optimizeArmy>[0]), explore: true });
      const both = simulateBothArmies({ mine: p.army.map((r, i) => ({ ...r, count: res.counts[i] })), theirs: p.enemy, enemySide: 'citadel' }) as unknown as Record<'you' | 'citadel', { won: boolean; army: Array<{ lost: number }> }>;
      const lost = [both.you, both.citadel].map((r) => r.army.reduce((a, x) => a + x.lost, 0));
      expect(both.you.won && both.citadel.won).toBe(true);
      expect(lost[0]).toBeLessThanOrEqual(want[0]);
      expect(lost[1]).toBeLessThanOrEqual(want[1]);
    }
  }, 120_000);
});

describe('what a lost troop costs (the user’s rule)', () => {
  const corax = troopById('corax-1')!;
  it('a normal troop: the Silver to train it, else its Silver revival price (10× the gold), else its health', () => {
    expect(lossPrice(corax, false, { train: 34000, revive: 80 })).toBe(34000);
    expect(lossPrice(corax, false, { revive: 80 })).toBe(800);
    expect(lossPrice(corax, false, null)).toBe(corax.hp);
  });
  it('a player’s training discount per kind changes the price (and so which loss is cheaper)', () => {
    const d = { guardsmen: -66, specialists: -56, siege: -25 };
    expect(lossPrice(corax, false, { train: 34000 }, d)).toBeCloseTo(34000 * 0.34, 6);
    const ballista = troopById('siege-ballistae-7')!;
    expect(lossPrice(ballista, false, { train: 15000 }, d)).toBeCloseTo(15000 * 0.75, 6);
    // Untrainable troops (silver revival price) and monsters take no training discount.
    expect(lossPrice(corax, false, { revive: 80 }, d)).toBe(800);
    expect(lossPrice(troopById('fire-phoenix-1')!, true, { revive: 864 }, d)).toBe(864);
  });

  it('a monster or mercenary: its revival Gold', () => {
    expect(lossPrice(troopById('fire-phoenix-1')!, true, { train: 1, revive: 864 })).toBe(864);
  });
  it('Citadel’s rows carry those prices', () => {
    const p = citadelSearch({ citadelId: 'elven-25', army: rowsOf(cards), starts: [], prices: { 'corax-1': { train: 34000, revive: 80 }, 'fire-phoenix-1': { revive: 864 } } })!;
    expect(p.army.map((r) => r.weight).slice(1, 3)).toEqual([34000, 864]);
  });
});
