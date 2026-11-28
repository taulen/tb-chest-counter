// game01master takes its roles from row positions (1st, 2nd, 3rd striker,
// cleanups). Rows in another order — "Suggest troops for my levels" lists them
// by line — made the Griffin VII the second striker and the Phoenix a cleanup,
// and Auto, started from that sizing alone, missed the answer (the user's Elven
// 30 army, Nov 28 2026: 102 / 178 Corax I against game01master's 66 / 141).
// gmOrder / gmCountsInOrder size the rows in game01master's own role order.
import { describe, it, expect } from 'vitest';
import { gmOrder, gmCounts, gmCountsInOrder, optimizeCounts, simulateBoth, troopById } from '../../src/web/public/lib/citadel-sim.js';

const r = (troopId: string, s: number, h: number) => ({ troopId, count: 0, strengthPct: s, healthPct: h });
// The user's cards, in the order the suggestion listed them (by line).
const BY_LINE = [
  r('siege-ballistae-7', 2315, 1591.75), r('corax-1', 5225.75, 3883.75), r('griffin-7', 5325.75, 3983.75), r('griffin-6', 5325.75, 3983.75),
  r('royal-lion-1', 3719.75, 2747.75), r('vulture-7', 3636.5, 2694.8), r('vulture-6', 3636.5, 2694.8), r('fire-phoenix-1', 3719.75, 2747.75),
];

describe('game01master in its own role order', () => {
  it('orders rows siege, first striker, monster, Royal Lion, then the Griffin and Vulture cleanups', () => {
    expect(gmOrder(BY_LINE).map((i) => BY_LINE[i].troopId)).toEqual([
      'siege-ballistae-7', 'corax-1', 'fire-phoenix-1', 'royal-lion-1', 'griffin-7', 'vulture-7', 'griffin-6', 'vulture-6',
    ]);
  });

  it('sizes the rows as game01master does in its order, handed back in the rows\' own order', () => {
    const order = gmOrder(BY_LINE);
    const inOrder = gmCounts('elven-30', order.map((i) => BY_LINE[i]));
    const back = gmCountsInOrder('elven-30', BY_LINE);
    order.forEach((i, k) => expect(back[i]).toBe(inOrder[k]));
  });

  it('lets Auto find game01master\'s answer whatever the rows\' order (66 / 141 Corax I at Elven 30)', () => {
    const start = (counts: Array<number | null>) => counts.map((n) => (Number.isFinite(n) ? (n as number) : 0));
    const res = optimizeCounts({
      citadelId: 'elven-30', army: BY_LINE,
      starts: [BY_LINE.map(() => 0), start(gmCounts('elven-30', BY_LINE)), start(gmCountsInOrder('elven-30', BY_LINE))],
    });
    const both = simulateBoth({ citadelId: 'elven-30', army: BY_LINE.map((x, i) => ({ ...x, count: res.counts[i] })) });
    const lost = (f: { army: Array<{ troopId: string; lost: number }> }) => f.army.filter((s) => s.lost).map((s) => `${troopById(s.troopId)!.name} ${s.lost}`).join(', ');
    expect(lost(both.you)).toBe('Corax I 66');
    expect(lost(both.citadel)).toBe('Corax I 141');
  }, 30000);
});
