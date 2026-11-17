/**
 * A level's XP window and the Stats screen, from names.json's `heroLevels`
 * (T10). Pinned to what the game showed for Carter (epic) at level 200 ★6:
 * Leadership 40,000 · Authority 20,000 · Dominance 10,000 · Might 2,770,000.
 */
import { describe, expect, it } from 'vitest';
import { heroLevelView } from '../../src/game-protocol/hero-levels.js';
import type { HeroLevels } from '../../src/game-protocol/static-data.js';

// Three levels standing in for 199 / 200 / 201; Might per level sums to 2,500,000 at "200".
const levels: HeroLevels = {
  series: [
    [608_929_682_960, 626_929_682_960, 646_229_682_960], // 0 xp
    [39_700, 40_000, 40_400], // 1 leadership
    [19_800, 20_000, 20_200], // 2 authority
    [9_920, 10_000, 10_100], // 3 dominance
    [2_470_000, 30_000, 30_000], // 4 might per level
  ],
  heroes: { 8: { xp: 0, leadership: 1, authority: 2, dominance: 3, might: 4 } },
};
const names = { heroLevels: levels, captains: { 8: { name: 'Carter', rarity: 2, rarityName: '', icon: '', art: '', stars: {}, starMight: { 6: 270_000 } } } };

describe('hero levels', () => {
  it("gives a level's XP window and the Stats screen's values, Might = the levels' plus the star's", () => {
    expect(heroLevelView(names, 8, 2, 6)).toEqual({
      xpFloor: 626_929_682_960,
      xpNext: 646_229_682_960,
      stats: { leadership: 40_000, authority: 20_000, dominance: 10_000, might: 2_770_000 },
    });
  });

  it('has no next level at the last one, and no Stats for the hero', () => {
    expect(heroLevelView(names, 8, 3, 6)?.xpNext).toBeNull();
    expect(heroLevelView(names, 8, 1, 0, false)).toEqual({ xpFloor: 608_929_682_960, xpNext: 626_929_682_960, stats: null });
  });

  it('is null for an unknown id, a level outside the table, or names without levels', () => {
    expect(heroLevelView(names, 99, 2)).toBeNull();
    expect(heroLevelView(names, 8, 0)).toBeNull();
    expect(heroLevelView(names, 8, 4)).toBeNull();
    expect(heroLevelView({ captains: {} }, 8, 2)).toBeNull();
    expect(heroLevelView(null, 8, 2)).toBeNull();
  });
});
