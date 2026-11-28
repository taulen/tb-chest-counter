// "Suggest troops for my levels" (lib/troop-suggest.js): which troops a player
// of given levels is offered, and where each bonus starts from.
import { describe, it, expect } from 'vitest';
import { suggestRows, keepSized, levelsSet, levelsLabel, setupStarts } from '../../src/web/public/lib/troop-suggest.js';
import { troopById } from '../../src/web/public/lib/citadel-sim.js';
import { BASELINE_BONUSES } from '../../src/web/public/lib/baseline-bonuses.js';

const G6 = { g: 6, s: 5, m: 5, e: 6, span: null };

describe('suggest troops for my levels', () => {
  it('needs every level set', () => {
    expect(levelsSet({ g: 6, s: 5, m: null, e: 6 })).toBe(false);
    expect(suggestRows({ g: 6, s: 5, m: null, e: 6 })).toBeNull();
    expect(levelsLabel(G6)).toBe('G6 · S5 · M5 · E6');
  });

  it('offers the best siege engine first, the top two flying tiers, each ground line\'s best and two monsters — nothing above the levels', () => {
    const rows = suggestRows(G6)!;
    const ids = rows.map((r) => r.troopId);
    expect(ids[0]).toBe('siege-ballistae-6');
    expect(ids).toEqual(expect.arrayContaining(['griffin-6', 'griffin-5', 'vulture-5', 'heavy-halberdier-6', 'swordsmen-5']));
    expect(ids).not.toContain('griffin-7');
    expect(ids).not.toContain('vulture-6');
    const monsters = ids.filter((id) => troopById(id)!.group === 'monsters');
    expect(monsters).toHaveLength(2);
    for (const id of ids) {
      const t = troopById(id)!;
      const cap = { guardsmen: 6, specialists: 5, monsters: 5, siege: 6 }[t.group as string];
      if (cap !== undefined && t.tier) expect(t.tier).toBeLessThanOrEqual(cap);
    }
    // No mercenaries unless the player has them on the page.
    expect(rows.some((r) => troopById(r.troopId)!.group === 'mercenaries')).toBe(false);
  });

  it('starts bonuses from the player\'s own rows (the same troop or its family), else the baseline for their level, marked', () => {
    const keep = [
      { troopId: 'griffin-6', count: 0, strengthPct: 1500, healthPct: 900 },
      { troopId: 'vulture-7', count: 0, strengthPct: 1700, healthPct: null },
      { troopId: 'wyvern', count: 3, strengthPct: 3600, healthPct: 2600 },
    ];
    const rows = suggestRows(G6, keep)!;
    const at = (id: string) => rows.find((r) => r.troopId === id)!;
    expect(at('griffin-6')).toMatchObject({ strengthPct: 1500, healthPct: 900, baseline: [] });
    // Griffin V: Griffin VI's family carries over.
    expect(at('griffin-5')).toMatchObject({ strengthPct: 1500, healthPct: 900, baseline: [] });
    // Vulture V: strength from Vulture VII's family, health from the baseline (S5), marked.
    expect(at('vulture-5')).toMatchObject({ strengthPct: 1700, healthPct: BASELINE_BONUSES.specialists['5'][1], baseline: ['healthPct'] });
    // A troop of no family the player has: the baseline for its kind and level.
    expect(at('heavy-halberdier-6')).toMatchObject({ strengthPct: BASELINE_BONUSES.guardsmen['6'][0], healthPct: BASELINE_BONUSES.guardsmen['6'][1] });
    // The player's own mercenary is offered, with their bonuses.
    expect(at('wyvern')).toMatchObject({ strengthPct: 3600, healthPct: 2600, baseline: [] });
  });

  it('offers a proven setup\'s troops too, and starts from game01master\'s sizing of it on Elven 25/30 only', () => {
    const G9 = { g: 9, s: 9, m: 9, e: 9, span: null };
    const setup = ['siege-ballistae-7', 'corax-2', 'fire-phoenix-1', 'royal-lion-1', 'griffin-7', 'vulture-7', 'griffin-6', 'vulture-6'];
    const rows = suggestRows(G9, [], setup)!;
    const ids = rows.map((r) => r.troopId);
    // Its troops join (Fire Phoenix I isn't among a G9's two strongest monsters); its siege engine doesn't —
    // the suggestion's best unlocked one stands in for it.
    expect(ids).toEqual(expect.arrayContaining(['corax-2', 'fire-phoenix-1', 'griffin-6', 'vulture-6']));
    expect(ids).not.toContain('siege-ballistae-7');
    const siege = rows.find((r) => troopById(r.troopId)!.siegeEngine)!.troopId;
    const mine = setup.map((id) => (troopById(id)!.siegeEngine ? siege : id));
    const [start] = setupStarts('elven-30', rows, [mine]);
    expect(start).toHaveLength(rows.length);
    // game01master sizes every troop of the setup; the rest start at 0.
    for (const [k, r] of rows.entries()) {
      if (mine.includes(r.troopId)) expect(start[k]).toBeGreaterThan(0);
      else expect(start[k]).toBe(0);
    }
    expect(setupStarts('cursed-25', rows, [mine])).toEqual([]);
  });

  it('drops the rows the search sized to 0', () => {
    const rows = suggestRows(G6)!.slice(0, 3);
    const k = keepSized(rows, [120, 0, 5]);
    expect(k.rows.map((r) => r.troopId)).toEqual([rows[0].troopId, rows[2].troopId]);
    expect(k.counts).toEqual([120, 5]);
  });
});
