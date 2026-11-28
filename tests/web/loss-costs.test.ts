// What a battle's losses cost (lib/loss-costs.js): Silver to train normal troops
// again after the player's discount for their kind, Gold to revive mercenaries
// and monsters divided by the Temple's factor.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/web/public/lib/api.js', () => ({ api: vi.fn(async () => ({ players: [] })) }));
vi.mock('../../src/web/public/lib/ui.js', () => ({ esc: (s: unknown) => String(s) }));

const { trainPrice, revivePrice, templeFactor, lossCosts, lossCostsHtml } = await import('../../src/web/public/lib/loss-costs.js');

describe('loss costs', () => {
  it('prices training as the game does: list price less the discount for the kind, rounded down', () => {
    // The user's training window, Nov 28 2026: Heavy Halberdier VII 1,500 at −78 % = 330 Silver.
    expect(trainPrice(1500, 'guardsmen', { guardsmen: -78 })).toBe(330);
    expect(trainPrice(300, 'guardsmen', { guardsmen: -78 })).toBe(66);
    // Another kind's discount doesn't apply; no discount is the list price.
    expect(trainPrice(1500, 'siege', { guardsmen: -78 })).toBe(1500);
    expect(trainPrice(undefined, 'guardsmen', null)).toBeNull();
  });

  it('divides a revival by the Temple\'s factor for the level', () => {
    const temple = { type: 9, times: { 1: 1.04, 45: 5.91 } };
    expect(templeFactor(temple, 45)).toBe(5.91);
    expect(templeFactor(temple, 30)).toBeNull();
    expect(revivePrice(500, 5.91)).toBeCloseTo(84.6, 1);
    expect(revivePrice(500, null)).toBe(500);
  });

  it('adds up an outcome: normal troops in Silver, mercenaries and monsters (and troops not sold for Silver) in Gold', () => {
    const c = lossCosts([
      { lost: 15, protected: false, kind: 'guardsmen', train: 34000, revive: 80 },
      { lost: 2, protected: true, kind: 'mercenaries', revive: 500 },
      { lost: 3, protected: false, kind: 'guardsmen', revive: 8 },
      { lost: 0, protected: false, kind: 'specialists', train: 1500 },
    ], { discounts: { guardsmen: -78 }, temple: 5.91 });
    expect(c.silver).toBe(15 * 7480);
    expect(c.gold).toBe(Math.round((2 * 500 + 3 * 8) / 5.91));
    expect(lossCostsHtml(c)).toContain((112200).toLocaleString());
    expect(lossCostsHtml({ silver: 0, gold: 0, unpriced: 0 })).toBe('');
  });
});
