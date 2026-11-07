/**
 * The citadel simulator must reproduce real battle reports.
 *
 * Every rule in lib/citadel-sim.js was measured from these reports (Nov 2026,
 * docs/citadel-simulator.md). Each case is one attack as the game logged it:
 * the army and the bonuses from the troop cards, who opened the battle, any
 * luck the report showed (double damage, a second squad hit), and either the
 * full strike list or the start of it, plus the troops lost. Change a rule and
 * a fight that really happened stops adding up.
 *
 * `luck` is keyed by ACTION number: every stack's strike counts one, siege
 * included; a second-squad hit belongs to the action that made it.
 */
import { describe, expect, it } from 'vitest';
// Plain ESM with no DOM access at import time.
import {
  simulate,
  simulateBoth,
  optimizeCounts,
  SAFETY,
  gmCounts,
  gmRoles,
  TROOPS,
  CITADELS,
  DEFENDERS,
  MARCH_ORDER,
  marchList,
  BONUS_FAMILIES,
  bonusFamily,
  troopTier,
  troopUnlocked,
  troopInWindow,
} from '../../src/web/public/lib/citadel-sim.js';

type Row = { troopId: string; count: number; strengthPct: number; healthPct: number };
interface Fight {
  name: string;
  citadelId: string;
  opener: 'you' | 'citadel';
  army: Row[];
  luck?: Record<number, { double?: boolean; second?: boolean }>;
  /** Every strike in order (siege first), or the first ones when only those were captured. */
  strikes: number[];
  complete: boolean;
  lost: Record<string, number>;
}

const row = (troopId: string, count: number, strengthPct: number, healthPct: number): Row => ({ troopId, count, strengthPct, healthPct });
// Bonuses read from the user's troop cards (Corax I, Royal Lion I / Fire Phoenix I, Siege Ballistae VII).
const GM_ARMY_E30 = [
  row('corax-1', 621, 4982.5, 3687.3),
  row('fire-phoenix-1', 26, 3658.5, 2671.3),
  row('royal-lion-1', 166, 3658.5, 2671.3),
  row('siege-ballistae-7', 779, 2229, 1462.3),
];

const FIGHTS: Fight[] = [
  {
    name: 'Elven 30, game01master army, citadel opens',
    citadelId: 'elven-30',
    opener: 'citadel',
    army: GM_ARMY_E30,
    luck: { 13: { second: true } },
    strikes: [4_050_000_000, 552_000_000, 1_656_000_000, 313_900_000, 765_250_200, 172_200_000, 382_200_000, 13_398_000,
      154_214_735, 262_508_000, 787_485_265, 172_200_000, 516_600_000, 26_749_800],
    complete: true,
    lost: { 'corax-1': 211 },
  },
  {
    name: 'Elven 30, game01master army, you open (Royal Lion I hits a second squad)',
    citadelId: 'elven-30',
    opener: 'you',
    army: GM_ARMY_E30,
    luck: { 6: { second: true } },
    strikes: [4_050_000_000, 1_656_000_000, 313_900_000, 765_250_200, 172_200_000, 382_200_000, 381_833_532, 13_398_000,
      154_214_735, 172_200_000, 516_600_000, 135_269_000, 405_651_733, 13_398_000, 26_749_800],
    complete: true,
    lost: { 'corax-1': 114 },
  },
  {
    name: 'Elven 10, one of each, citadel opens',
    citadelId: 'elven-10',
    opener: 'citadel',
    army: GM_ARMY_E30.map((r) => ({ ...r, count: 1 })),
    strikes: [2_700_000, 297_000, 594_000, 155_800, 467_400, 120_000, 360_000, 90_000, 197_965, 61_600, 184_800, 24_300, 72_035],
    complete: true,
    lost: {},
  },
  {
    name: 'Elven 10, one Wyvern, citadel opens (walls hit flyers)',
    citadelId: 'elven-10',
    opener: 'citadel',
    army: [row('wyvern', 1, 2175.5, 1501.3)],
    luck: { 4: { double: true } },
    strikes: [900_000, 2_700_000, 198_000, 594_000, 155_800, 120_000, 90_000, 61_600, 467_400, 120_000, 90_000, 61_600,
      360_000, 90_000, 61_600, 270_000, 61_600, 184_800],
    complete: true,
    lost: {},
  },
  {
    name: 'Elven 20, 13 Wyverns, you open',
    citadelId: 'elven-20',
    opener: 'you',
    army: [row('wyvern', 13, 3611.5, 2669.8)],
    strikes: [36_500_000, 109_500_000, 29_520_000, 8_030_000, 6_500_000, 5_060_000, 3_240_000, 24_090_000, 6_500_000,
      5_060_000, 3_240_000, 19_500_000, 5_060_000, 3_240_000, 15_180_000, 3_240_000, 9_720_000],
    complete: true,
    lost: {},
  },
  {
    // Battle damage 59.0M against 57.33M per Wyvern: wounds stay through the battle.
    name: 'Elven 20, 13 Wyverns, citadel opens',
    citadelId: 'elven-20',
    opener: 'citadel',
    army: [row('wyvern', 13, 3611.5, 2669.8)],
    strikes: [36_500_000, 109_500_000, 9_840_000, 29_520_000, 8_030_000],
    complete: false,
    lost: { wyvern: 1 },
  },
  {
    name: 'Elven 20, 5 Fire Phoenix I, you open (the Bear hits elementals +50%)',
    citadelId: 'elven-20',
    opener: 'you',
    army: [row('fire-phoenix-1', 5, 3711.5, 2769.8)],
    strikes: [36_500_000, 109_500_000, 29_520_000, 8_030_000, 6_500_000, 7_590_000, 3_240_000, 24_090_000, 6_500_000,
      7_590_000, 3_240_000, 19_500_000, 7_590_000, 3_240_000, 15_180_000, 3_240_000, 9_720_000],
    complete: true,
    lost: {},
  },
  {
    // Two siege rounds; the damaged walls strike with the units they have left.
    // 104.6M in total but 0 lost: wall wounds heal before the battle.
    name: 'Elven 20, 3 Fire Phoenix I, you open',
    citadelId: 'elven-20',
    opener: 'you',
    army: [row('fire-phoenix-1', 3, 3711.5, 2769.8)],
    strikes: [36_500_000, 75_467_700, 11_350_000, 34_032_300, 29_520_000, 8_030_000, 6_500_000, 7_590_000, 3_240_000,
      24_090_000, 6_500_000, 7_590_000, 3_240_000, 19_500_000, 7_590_000, 3_240_000, 15_180_000, 3_240_000, 9_720_000],
    complete: true,
    lost: {},
  },
  {
    // Battle damage 66.6M against 56.82M per Phoenix: monsters keep wounds too.
    name: 'Elven 20, 3 Fire Phoenix I, citadel opens (double damage on the walls)',
    citadelId: 'elven-20',
    opener: 'citadel',
    army: [row('fire-phoenix-1', 3, 3711.5, 2769.8)],
    luck: { 2: { double: true } },
    strikes: [36_500_000, 109_500_000, 9_840_000, 29_520_000, 8_030_000],
    complete: false,
    lost: { 'fire-phoenix-1': 1 },
  },
  {
    // The simulator's own suggestion: a second stack shortens the battle.
    name: 'Elven 20, 12 Wyverns + 1 Fire Phoenix I, citadel opens',
    citadelId: 'elven-20',
    opener: 'citadel',
    army: [row('wyvern', 12, 3611.5, 2669.8), row('fire-phoenix-1', 1, 3711.5, 2769.8)],
    luck: { 2: { double: true } },
    strikes: [36_500_000, 109_500_000, 9_840_000, 29_520_000, 8_030_000, 24_090_000],
    complete: false,
    lost: {},
  },
  {
    // Specialists: one lost to the walls' 7M hit, one in the battle (7.5M vs 5.27M each).
    name: 'Elven 15, 12 Royal Lion I, you open',
    citadelId: 'elven-15',
    opener: 'you',
    army: [row('royal-lion-1', 12, 3711.5, 2769.8)],
    luck: { 2: { double: true } },
    strikes: [7_000_000, 21_000_000, 4_599_000, 1_269_000, 990_000],
    complete: false,
    lost: { 'royal-lion-1': 2 },
  },
  {
    // Siege engines: the first catapult dies to the Archer's 120k after the Pegasus's 155.8k.
    name: 'Elven 10, 12 Catapult V, you open',
    citadelId: 'elven-10',
    opener: 'you',
    army: [row('catapult-5', 12, 2252.1, 1462.3)],
    strikes: [2_700_000, 594_000, 155_800, 120_000, 90_000],
    complete: false,
    lost: { 'catapult-5': 3 },
  },
];

describe('citadel simulator replays real battle reports', () => {
  for (const f of FIGHTS) {
    it(f.name, () => {
      const r = simulate({ citadelId: f.citadelId, army: f.army, opener: f.opener, luck: f.luck });
      const got = r.strikes.map((s) => Math.round(s.damage));
      if (f.complete) expect(got).toEqual(f.strikes);
      else expect(got.slice(0, f.strikes.length)).toEqual(f.strikes);
      expect(r.won).toBe(true);
      const lost = Object.fromEntries(r.army.filter((a) => a.lost > 0).map((a) => [a.troopId, a.lost]));
      expect(lost).toEqual(f.lost);
    });
  }

  it('the first Catapult V dies exactly where the report shows it', () => {
    const r = simulate({ citadelId: 'elven-10', army: [row('catapult-5', 12, 2252.1, 1462.3)], opener: 'you' });
    // Pegasus 155.8k alone is under one catapult (246.8k); the Archer's 120k on top finishes one.
    const unit = r.army[0].unitHealth;
    expect(155_800).toBeLessThan(unit);
    expect(155_800 + 120_000).toBeGreaterThan(unit);
  });
});

describe('game01master sizing', () => {
  it("reproduces game01master's counts for the user's Elven 30 and 25 armies", () => {
    const army = GM_ARMY_E30.map((r) => ({ ...r, count: 0 }));
    expect(gmCounts('elven-30', army)).toEqual([621, 26, 166, 779]);
    expect(gmCounts('elven-25', army)).toEqual([137, 5, 33, 186]);
    expect(gmRoles('elven-30', army)).toEqual(['first', 'second', 'third', 'walls']);
  });

  it('only sizes the two citadels game01master covers', () => {
    expect(gmCounts('elven-20', GM_ARMY_E30)).toEqual([null, null, null, null]);
  });

  it('fills the cleanup slots game01master offers', () => {
    const army = [...GM_ARMY_E30.slice(0, 3), row('griffin-7', 0, 4982.5, 3687.3), row('vulture-7', 0, 3658.5, 2671.3), GM_ARMY_E30[3]];
    const counts = gmCounts('elven-30', army);
    expect(gmRoles('elven-30', army)).toEqual(['first', 'second', 'third', 'cleanup', 'cleanup', 'walls']);
    expect(counts).toEqual([621, 26, 166, 220, 5959, 779]);
  });
});

describe('automatic counts (the simulator searches them)', () => {
  const lost = (r: { army: { lost: number }[] }) => r.army.reduce((a, s) => a + s.lost, 0);

  it('finds a lossless Elven 20 army of Wyverns and a Fire Phoenix I', () => {
    const r = optimizeCounts({
      citadelId: 'elven-20',
      army: [row('wyvern', 0, 3611.5, 2669.8), row('fire-phoenix-1', 0, 3711.5, 2769.8)],
    });
    expect(r.ok).toBe(true);
    expect(lost(r.both.you) + lost(r.both.citadel)).toBe(0);
  });

  it("does at least as well as game01master on game01master's own Elven 30 army", () => {
    const army = GM_ARMY_E30.map((r) => ({ ...r, count: 0 }));
    const gm = gmCounts('elven-30', army) as number[];
    const r = optimizeCounts({ citadelId: 'elven-30', army, starts: [gm] });
    const gmBoth = simulateBoth({ citadelId: 'elven-30', army: army.map((x, i) => ({ ...x, count: gm[i] })) });
    expect(r.ok).toBe(true);
    expect(lost(r.both.you) + lost(r.both.citadel)).toBeLessThan(lost(gmBoth.you) + lost(gmBoth.citadel));
  });

  it('every answer still wins with all bonuses 3% lower', () => {
    const army = [row('wyvern', 0, 3611.5, 2669.8), row('fire-phoenix-1', 0, 3711.5, 2769.8)];
    const r = optimizeCounts({ citadelId: 'elven-20', army });
    const lower = (p: number) => ((1 + p / 100) * (1 - SAFETY) - 1) * 100;
    const weak = simulateBoth({ citadelId: 'elven-20', army: army.map((x, i) => ({ ...x, count: r.counts[i], strengthPct: lower(x.strengthPct), healthPct: lower(x.healthPct) })) });
    expect(weak.you.won && weak.citadel.won).toBe(true);
  });

  it('never trades a monster for cheaper losses: the first striker absorbs them instead', () => {
    // The user's Cursed 25 setup (Nov 2026). Weighing every loss by base health
    // alone gave 498/5/6/0/9 and lost a Fire Phoenix I when the citadel struck
    // first, because nine Battle Griffins + one Phoenix "cost" less than more Corax.
    const army = [
      row('siege-ballistae-7', 0, 2000, 2000),
      row('corax-1', 0, 3000, 3000),
      row('fire-phoenix-1', 0, 3000, 3000),
      { ...row('royal-lion-1', 0, 3000, 0), healthPct: null as unknown as number },
      row('griffin-7', 0, 3000, 2000),
    ];
    const r = optimizeCounts({ citadelId: 'cursed-25', army, starts: [[498, 5, 6, 0, 9]] });
    expect(r.ok).toBe(true);
    const protectedLost = (res: { army: { troopId: string; lost: number }[] }) =>
      res.army.filter((s) => /^(fire-phoenix|wyvern)/.test(s.troopId)).reduce((a, s) => a + s.lost, 0);
    expect(protectedLost(r.both.you) + protectedLost(r.both.citadel)).toBe(0);
    // The Phoenix still fights (it isn't simply dropped) and the losses fall on Corax I.
    expect(r.counts[2]).toBeGreaterThan(0);
    const losers = new Set([...r.both.you.army, ...r.both.citadel.army].filter((s) => s.lost > 0).map((s) => s.troopId));
    expect([...losers]).toEqual(['corax-1']);
  });

  it('says so when no count of these troops can win', () => {
    // A troop at -100% strength deals no damage at all; any real troop wins in large enough numbers.
    const r = optimizeCounts({ citadelId: 'elven-30', army: [row('vulture-5', 0, -100, 0)] });
    expect(r.ok).toBe(false);
  });
});

describe('health only where it matters', () => {
  it('troops that are never hit need no health bonus; the result is unchanged', () => {
    const army = GM_ARMY_E30.map((r) => (r.troopId === 'royal-lion-1' || r.troopId === 'siege-ballistae-7' ? { ...r, healthPct: null } : r));
    const both = simulateBoth({ citadelId: 'elven-30', army: army as unknown as Row[] });
    expect(both.you.army[0].lost).toBe(132);
    expect(both.citadel.army[0].lost).toBe(211);
    for (const r of [both.you, both.citadel]) {
      const byId = Object.fromEntries(r.army.map((s) => [s.troopId, s]));
      expect(byId['royal-lion-1']).toMatchObject({ healthUnknown: true, wasHit: false });
      expect(byId['siege-ballistae-7']).toMatchObject({ healthUnknown: true, wasHit: false });
    }
  });

  it('flags a troop with no health bonus that does get hit (the Bear goes for the Phoenix)', () => {
    const army = GM_ARMY_E30.map((r) => (r.troopId === 'fire-phoenix-1' ? { ...r, healthPct: null } : r));
    const r = simulate({ citadelId: 'elven-30', army: army as unknown as Row[], opener: 'citadel' });
    expect(r.army.find((s) => s.troopId === 'fire-phoenix-1')).toMatchObject({ healthUnknown: true, wasHit: true });
  });
});

describe('citadel simulator edge cases', () => {
  it('reports a failed siege when nothing can bring the walls down', () => {
    const r = simulate({ citadelId: 'elven-30', army: [row('vulture-5', 10, 0, 0)], opener: 'you' });
    expect(r.won).toBe(false);
    expect(r.wallsDown).toBe(false);
  });

  it('ignores rows with no troops and unknown troop ids', () => {
    const r = simulate({ citadelId: 'elven-10', army: [row('nope', 5, 0, 0), row('wyvern', 0, 0, 0), row('wyvern', 1, 2175.5, 1501.3)], opener: 'you' });
    expect(r.army).toHaveLength(1);
    expect(r.army[0].index).toBe(2);
    expect(r.won).toBe(true);
  });

  it('an empty army does not win', () => {
    expect(simulate({ citadelId: 'elven-10', army: [], opener: 'you' }).reason).toBe('empty');
  });

  it('runs both coin-flip outcomes', () => {
    const both = simulateBoth({ citadelId: 'elven-30', army: GM_ARMY_E30 });
    expect(both.you.army[0].lost).toBe(132);
    expect(both.citadel.army[0].lost).toBe(211);
  });

  it('the march list reproduces the game order it knows, and places every other troop by strength', () => {
    for (const id of MARCH_ORDER) expect(TROOPS.some((x) => x.id === id), id).toBe(true);
    const every = marchList(TROOPS.map((x) => row(x.id, 1, 0, 0))).map((r: { troopId: string }) => r.troopId);
    expect(every).toHaveLength(TROOPS.length);
    // The 33 checked in game keep exactly their order among everything else.
    expect(every.filter((id: string) => MARCH_ORDER.includes(id))).toEqual(MARCH_ORDER);
    const list = marchList([
      row('siege-ballistae-7', 779, 0, 0), row('corax-1', 621, 0, 0), row('royal-lion-1', 0, 0, 0), row('fire-phoenix-1', 26, 0, 0), row('wyvern', 3, 0, 0),
      row('archer-3', 50, 0, 0), row('battle-boar', 2, 0, 0),
    ]);
    expect(list.map((r: { troopId: string }) => r.troopId)).toEqual(['wyvern', 'fire-phoenix-1', 'battle-boar', 'corax-1', 'siege-ballistae-7', 'archer-3']);
    // Same strength: the game lists Royal Lion I first (Nov 2026 march screen).
    const tied = marchList([row('corax-1', 475, 0, 0), row('royal-lion-1', 465, 0, 0), row('griffin-7', 851, 0, 0)]);
    expect(tied.map((r: { troopId: string }) => r.troopId)).toEqual(['royal-lion-1', 'corax-1', 'griffin-7']);
  });

  it('has every tier I-IX the wiki lists, with sound data', () => {
    const byGroup = (g: string) => TROOPS.filter((x) => x.group === g);
    expect(byGroup('guardsmen')).toHaveLength(32);
    expect(byGroup('specialists')).toHaveLength(24); // scouts (Spy, Swift Jaeger, Panoptic) left out
    expect(byGroup('monsters')).toHaveLength(28);
    expect(byGroup('siege')).toHaveLength(9);
    for (const x of TROOPS) {
      if (x.group === 'mercenaries') continue;
      expect(x.tier >= 1 && x.tier <= 9, x.id).toBe(true);
      // Health is 3x strength, siege 6x (game card) — or within 0.2% of it for game01master's rounded four.
      const want = x.siegeEngine ? 6 : 3;
      expect(Math.abs(x.hp / (x.str * want) - 1) < 0.002, x.id).toBe(true);
      for (const k of Object.keys(x.vs)) expect(['mounted', 'ranged', 'melee', 'flying', 'fortification', 'siege', 'beast', 'human', 'elemental', 'dragon', 'giant'], `${x.id} vs ${k}`).toContain(k);
    }
  });

  it('the picker window is the top levels counted down from your highest', () => {
    // The user's example: G8, M8, S7, top 2 levels -> guardsmen and monsters 8 and 7, specialists only 7.
    const levels = { g: 8, s: 7, m: 8, e: 7, span: 2 };
    expect(troopInWindow('punisher-1', levels)).toBe(true); // G8
    expect(troopInWindow('heavy-halberdier-7', levels)).toBe(true); // G7
    expect(troopInWindow('heavy-halberdier-6', levels)).toBe(false); // G6: below the band
    expect(troopInWindow('fire-phoenix-1', levels)).toBe(true); // M8
    expect(troopInWindow('black-dragon', levels)).toBe(true); // M7
    expect(troopInWindow('ruby-golem', levels)).toBe(false); // M6
    expect(troopInWindow('heavy-knight-7', levels)).toBe(true); // S7
    expect(troopInWindow('heavy-knight-6', levels)).toBe(false); // S6: inside S's own 2, but below the band
    expect(troopInWindow('duelist-1', levels)).toBe(false); // S8: locked
    expect(troopInWindow('siege-ballistae-7', levels)).toBe(true); // E7
    expect(troopInWindow('wyvern', levels)).toBe(true);
    // Top level only, and all levels.
    expect(troopInWindow('heavy-knight-7', { ...levels, span: 1 })).toBe(false);
    expect(troopInWindow('corax-1', { ...levels, span: 1 })).toBe(true);
    expect(troopInWindow('spearmen-1', { ...levels, span: 9 })).toBe(true);
    // No choice yet: 4 levels (8 down to 5); a kind left at "any" shows everything.
    const loose = { g: 8, s: null, m: 5, e: 2, span: null };
    expect(troopInWindow('spearmen-5', loose)).toBe(true); // G5
    expect(troopInWindow('spearmen-4', loose)).toBe(false); // G4: too low
    expect(troopInWindow('corax-2', loose)).toBe(false); // G9: locked
    expect(troopInWindow('swordsmen-1', loose)).toBe(true); // S any
    expect(troopInWindow('flaming-centaur', loose)).toBe(true); // M5
    expect(troopInWindow('ice-phoenix', loose)).toBe(false); // M4: below 8's band
    expect(troopInWindow('catapult-1', loose)).toBe(false); // E1: below the band
  });

  it('troop levels gate every non-mercenary troop, and only those', () => {
    for (const x of TROOPS) {
      const tier = troopTier(x.id);
      if (x.group === 'mercenaries') expect(tier, x.id).toBeNull();
      else expect(tier, x.id).not.toBeNull();
    }
    const levels = { g: 8, s: 8, m: 8, e: 7 };
    expect(troopUnlocked('corax-1', levels)).toBe(true);
    expect(troopUnlocked('corax-2', levels)).toBe(false);
    expect(troopUnlocked('fire-phoenix-2', levels)).toBe(false);
    expect(troopUnlocked('josephine-1', levels)).toBe(false);
    expect(troopUnlocked('siege-ballistae-7', levels)).toBe(true);
    expect(troopUnlocked('wyvern', levels)).toBe(true);
    expect(troopUnlocked('corax-2', { g: null, s: null, m: null, e: null })).toBe(true);
  });

  it('bonus families only name real troops, each in one family', () => {
    const ids = Object.values(BONUS_FAMILIES).flat();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(TROOPS.some((x) => x.id === id), id).toBe(true);
    expect(bonusFamily('corax-1')).toBe(bonusFamily('corax-2'));
    expect(bonusFamily('corax-1')).not.toBe(bonusFamily('griffin-7'));
    // The user's cards: Phoenix I and Royal Lion I read the same bonuses.
    expect(bonusFamily('fire-phoenix-1')).toBe(bonusFamily('royal-lion-1'));
    expect(bonusFamily('wyvern')).toBeNull();
  });

  it('every citadel unit and troop is well-formed', () => {
    for (const c of CITADELS) for (const [id, n] of c.units) expect(!!DEFENDERS[id as string] && Number(n) > 0, `${c.id} ${id}`).toBe(true);
    const ids = new Set(TROOPS.map((t) => t.id));
    expect(ids.size).toBe(TROOPS.length);
    for (const t of TROOPS) expect(t.str > 0 && t.hp > 0, t.id).toBe(true);
  });
});
