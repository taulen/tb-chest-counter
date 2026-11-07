/**
 * Tools → Rewards arithmetic (lib/rewards-split.js).
 *
 * The REFERENCE cases are totalcalculator.org/rewards.php responses, probed
 * 2026-11-07 (it computes server-side and publishes no source). Every Dragon
 * Coins split it made is reproduced exactly. Its fragment splits are not
 * pinned: who gets a leftover fragment there shifts with the coin pot, and the
 * header of rewards-split.js says why that is deliberately not copied.
 */
import { describe, it, expect } from 'vitest';
// Plain ESM with no DOM access at import time.
import { splitPot, scoreAfterDay, distributeRewards, parsePot } from '../../src/web/public/lib/rewards-split.js';

const REFERENCE: Array<{ scores: number[]; pot: number; want: number[] }> = [
  // Dragon Coins
  { scores: [100, 50, 25], pot: 1000, want: [571, 286, 143] },
  { scores: [100, 50, 25], pot: 1, want: [1, 0, 0] },
  { scores: [100, 50, 25], pot: 2, want: [1, 1, 0] },
  { scores: [100, 50, 25], pot: 7, want: [4, 2, 1] },
  { scores: [100, 50, 25], pot: 10, want: [6, 3, 1] },
  { scores: [100, 50, 25], pot: 100, want: [57, 29, 14] },
  { scores: [100, 50, 25], pot: 300, want: [171, 86, 43] },
  { scores: [100, 50, 25], pot: 500, want: [286, 143, 71] },
  { scores: [100, 50, 25], pot: 501, want: [286, 143, 72] },
  { scores: [100, 50, 25], pot: 520, want: [297, 149, 74] },
  { scores: [100, 50, 25], pot: 550, want: [314, 157, 79] },
  { scores: [100, 50, 25], pot: 600, want: [343, 171, 86] },
  { scores: [100, 50, 25], pot: 650, want: [371, 186, 93] },
  { scores: [100, 50, 25], pot: 699, want: [399, 200, 100] },
  { scores: [100, 50, 25], pot: 700, want: [400, 200, 100] },
  { scores: [100, 50, 25], pot: 999, want: [571, 285, 143] },
  { scores: [100, 50, 25], pot: 1001, want: [572, 286, 143] },
  { scores: [100, 50, 25], pot: 2000, want: [1143, 571, 286] },
  { scores: [100, 50, 25], pot: 5000, want: [2857, 1429, 714] },
  { scores: [1, 1, 1], pot: 100, want: [34, 33, 33] },
  { scores: [25, 50, 100], pot: 100, want: [14, 29, 57] },
  { scores: [1, 0, 3], pot: 10, want: [3, 0, 7] },
  { scores: [2, 1], pot: 500, want: [333, 167] },
  { scores: [2, 1], pot: 3, want: [2, 1] },
];

describe('splitPot', () => {
  it.each(REFERENCE)('matches the reference: $scores over $pot', ({ scores, pot, want }) => {
    expect(splitPot(scores, pot)).toEqual(want);
  });

  it('always adds up to the pot and lands everyone on their share rounded down or up', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rand() * 40);
      const scores = Array.from({ length: n }, () => (rand() < 0.15 ? 0 : Math.floor(rand() * 5e9)));
      const pot = Math.floor(rand() * 2e7);
      const out = splitPot(scores, pot);
      const total = scores.reduce((a, b) => a + b, 0);
      if (total === 0) {
        expect(out.every((v) => v === 0)).toBe(true);
        continue;
      }
      expect(out.reduce((a, b) => a + b, 0)).toBe(pot);
      out.forEach((v, i) => {
        const exact = (BigInt(pot) * BigInt(scores[i])) / BigInt(total);
        expect(BigInt(v) - exact).toBeGreaterThanOrEqual(0n);
        expect(BigInt(v) - exact).toBeLessThanOrEqual(1n);
        if (scores[i] === 0) expect(v).toBe(0);
      });
    }
  });

  it('stays exact where a float product would not', () => {
    // 9,999,999 × 8,999,999,999 is past 2^53; the shares must still sum exactly.
    const out = splitPot([8_999_999_999, 1, 1], 9_999_999);
    expect(out.reduce((a, b) => a + b, 0)).toBe(9_999_999);
    expect(out).toEqual([9_999_999, 0, 0]);
  });

  it('gives nothing when the pot or the scores are empty', () => {
    expect(splitPot([0, 0], 100)).toEqual([0, 0]);
    expect(splitPot([5, 3], 0)).toEqual([0, 0]);
    expect(splitPot([], 100)).toEqual([]);
    expect(splitPot([Number.NaN, -4, 2], 9)).toEqual([0, 0, 9]);
  });

  it('breaks a tie on the fraction toward the earlier player, as the reference does', () => {
    // 2 over 1:3 is 0.5 and 1.5 — both .5, one unit left: the first line's.
    expect(splitPot([1, 3], 2)).toEqual([1, 1]);
    // 1 unit over 1:1 → the first.
    expect(splitPot([1, 1], 1)).toEqual([1, 0]);
    // 4 over 1:2:1 is 1, 2, 1 exactly — nothing to break.
    expect(splitPot([1, 2, 1], 4)).toEqual([1, 2, 1]);
  });
});

describe('scoreAfterDay', () => {
  it('reads the newest pasted snapshot at or before the day, carrying a missed day forward', () => {
    const cumulative = { 1: 100, 3: 250 };
    expect(scoreAfterDay(cumulative, 1)).toBe(100);
    expect(scoreAfterDay(cumulative, 2)).toBe(100);
    expect(scoreAfterDay(cumulative, 3)).toBe(250);
    expect(scoreAfterDay(cumulative, 5)).toBe(250);
    expect(scoreAfterDay({ 2: 40 }, 1)).toBe(0);
    expect(scoreAfterDay({}, 3)).toBe(0);
  });
});

describe('distributeRewards', () => {
  it("spreads an excluded player's share over the rest by score", () => {
    const players = [
      { name: 'A', score: 100, included: true },
      { name: 'B', score: 50, included: false },
      { name: 'C', score: 25, included: true },
    ];
    const res = distributeRewards(players, { coins: 1000, fragments: 500 });
    expect(res.rows.map((r) => [r.coins, r.fragments])).toEqual([[800, 400], [0, 0], [200, 100]]);
    expect(res.scoreTotal).toBe(125);
    expect(res.recipients).toBe(2);
    expect(res.rows[0].share).toBeCloseTo(0.8);
    expect(res.rows[1].share).toBe(0);
  });

  it('pays nobody when everyone is excluded', () => {
    const res = distributeRewards([{ score: 9, included: false }], { coins: 10, fragments: 0 });
    expect(res.rows[0].coins).toBe(0);
    expect(res.recipients).toBe(0);
  });
});

describe('parsePot', () => {
  it.each([
    ['7000000', 7_000_000],
    ['7,000,000', 7_000_000],
    ['7 000 000', 7_000_000],
    ['7.000.000', 7_000_000],
    ['7.5m', 7_500_000],
    ['7,5M', 7_500_000],
    ['250k', 250_000],
    ['2b', 2_000_000_000],
    ['', 0],
    ['abc', 0],
  ])('%s → %d', (raw, want) => {
    expect(parsePot(raw)).toBe(want);
  });
});
