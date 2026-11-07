/**
 * The stack calculator must size stacks exactly as Kaiculator does.
 *
 * lib/stack-calc.js is a port of kaiculator.kaikaiju.com's sizing (v0.71.5,
 * Nov 2026; docs/stack-calculator.md). Each case below is one army entered on
 * that page (driven headlessly, its own settings format) with the counts it
 * rendered. Health bonuses there are per attribute (Flying, Melee, Guardsman…);
 * here they are each troop's sum of them, as its card shows. Change a rule and
 * a count stops matching.
 */
import { describe, expect, it } from 'vitest';
import {
  planStacks,
  fitBaseToLeadership,
  stackUnit,
  STACK_TROOPS,
  TEMPLE_REVIVAL_REDUCTION,
} from '../../src/web/public/lib/stack-calc.js';
import { TROOPS } from '../../src/web/public/lib/citadel-sim.js';

type MonsterMode = 'reference' | 'whole-stacks' | 'scaled';
interface Army {
  name: string;
  input: {
    rows: ([string] | [string, number])[];
    baseCount: number;
    tierMultiplier?: number;
    siegeMultiplier?: number;
    limits?: { leadership?: number; authority?: number; dominance?: number };
    monsterMode?: MonsterMode;
    epicHunterLast?: boolean;
  };
  /** "Find it for me" with this leadership gave this base count. */
  fitLeadership?: number;
  fitBase?: number;
  counts: Record<string, number>;
}

// Kaiculator's output, Nov 7 2026. A count of 0 = it dropped the stack.
const ARMIES: Army[] = [
  {"name":"corax-guardsmen","input":{"rows":[["corax-1"],["heavy-halberdier-7"],["mounted-knight-7"],["heavy-arbalester-7"],["spearmen-5"],["archer-5"],["rider-5"]],"baseCount":100},"counts":{"corax-1":100,"heavy-halberdier-7":3800,"mounted-knight-7":1900,"heavy-arbalester-7":3800,"spearmen-5":13717,"archer-5":13717,"rider-5":6858}},
  {"name":"mixed-specialists","input":{"rows":[["corax-1"],["royal-lion-1"],["duelist-1"],["punisher-1"],["vulture-7"],["heavy-knight-7"],["heavy-halberdier-7"],["swordsmen-5"]],"baseCount":150},"counts":{"corax-1":150,"royal-lion-1":152,"duelist-1":3031,"punisher-1":3000,"vulture-7":5758,"heavy-knight-7":5758,"heavy-halberdier-7":5700,"swordsmen-5":20576}},
  {"name":"health-bonuses","input":{"rows":[["corax-1",120],["heavy-halberdier-7",70],["mounted-knight-7",20],["spearmen-5",70],["vulture-7",100]],"baseCount":120},"counts":{"corax-1":120,"heavy-halberdier-7":5901,"mounted-knight-7":4180,"spearmen-5":21303,"vulture-7":5067}},
  {"name":"monsters-mercs","input":{"rows":[["corax-1"],["heavy-halberdier-7"],["fire-phoenix-1"],["black-dragon"],["ruby-golem"],["wyvern"],["warregal"]],"baseCount":200},"counts":{"corax-1":200,"heavy-halberdier-7":7600,"fire-phoenix-1":17,"black-dragon":38,"ruby-golem":91,"wyvern":16,"warregal":53}},
  {"name":"siege","input":{"rows":[["corax-1"],["heavy-halberdier-7"],["spearmen-5"],["siege-ballistae-7"],["catapult-5"]],"baseCount":150,"siegeMultiplier":1.3},"counts":{"corax-1":150,"heavy-halberdier-7":5700,"spearmen-5":20576,"siege-ballistae-7":1123,"catapult-5":3625}},
  {"name":"dominance-scaled","input":{"rows":[["corax-1"],["heavy-halberdier-7"],["fire-phoenix-1"],["black-dragon"],["ruby-golem"],["wyvern"],["warregal"]],"baseCount":200,"limits":{"authority":2000,"dominance":500},"monsterMode":"scaled"},"counts":{"corax-1":200,"heavy-halberdier-7":7600,"fire-phoenix-1":1,"black-dragon":3,"ruby-golem":7,"wyvern":16,"warregal":53}},
  {"name":"dominance-whole","input":{"rows":[["corax-1"],["heavy-halberdier-7"],["fire-phoenix-1"],["black-dragon"],["ruby-golem"],["wyvern"],["warregal"]],"baseCount":200,"limits":{"authority":2000,"dominance":500},"monsterMode":"whole-stacks"},"counts":{"corax-1":200,"heavy-halberdier-7":7600,"fire-phoenix-1":0,"black-dragon":0,"ruby-golem":0,"wyvern":16,"warregal":53}},
  {"name":"find-leadership","input":{"rows":[["corax-1"],["heavy-halberdier-7"],["mounted-knight-7"],["heavy-arbalester-7"],["spearmen-5"],["siege-ballistae-7"]],"baseCount":50,"limits":{"leadership":250000}},"fitLeadership":250000,"fitBase":760,"counts":{"corax-1":760,"heavy-halberdier-7":28880,"mounted-knight-7":14440,"heavy-arbalester-7":28880,"spearmen-5":104256,"siege-ballistae-7":4377}},
  {"name":"smiter-tier2","input":{"rows":[["smiter-1"],["punisher-1"],["purifier-1"],["heavy-halberdier-7"],["rider-5"]],"baseCount":37,"tierMultiplier":2},"counts":{"smiter-1":37,"punisher-1":74,"purifier-1":74,"heavy-halberdier-7":148,"rider-5":296}},
  {"name":"epic-hunter","input":{"rows":[["corax-1"],["heavy-halberdier-7"],["epic-monster-hunter"],["wyvern"]],"baseCount":300,"epicHunterLast":true},"counts":{"corax-1":300,"heavy-halberdier-7":11400,"epic-monster-hunter":690,"wyvern":25}},
  {"name":"ariel-only-siege","input":{"rows":[["griffin-7"],["heavy-halberdier-6"],["ariel"]],"baseCount":80},"counts":{"griffin-7":80,"heavy-halberdier-6":3040,"ariel":20}},
  {"name":"mercs-grow","input":{"rows":[["corax-1"],["heavy-halberdier-7"],["fire-phoenix-1"],["black-dragon"],["ruby-golem"],["wyvern"],["warregal"]],"baseCount":200,"limits":{"authority":5000,"dominance":500},"monsterMode":"scaled"},"counts":{"corax-1":200,"heavy-halberdier-7":7600,"fire-phoenix-1":1,"black-dragon":3,"ruby-golem":7,"wyvern":17,"warregal":53}},
  {"name":"specialists-only","input":{"rows":[["royal-lion-1",35],["vulture-7",35],["heavy-knight-7",35],["lion-rider-7",35],["deadshot-6",35],["swordsmen-5",35]],"baseCount":90},"counts":{"royal-lion-1":90,"vulture-7":3434,"heavy-knight-7":3434,"lion-rider-7":1717,"deadshot-6":6524,"swordsmen-5":12397}},
  // The mercenaries added from totalbattlewiki.com (Nov 7 2026): tiers 5-9, siege mercs as the only decoys, the tiered hunters.
  {"name":"merc-mix","input":{"rows":[["corax-1"],["heavy-halberdier-7"],["cursed-dragon"],["archdemon"],["bear"],["legionary"],["galloper"],["epic-monster-hunter-6"],["fire-phoenix-1"]],"baseCount":150},"counts":{"corax-1":150,"heavy-halberdier-7":5700,"cursed-dragon":27,"archdemon":49,"bear":404,"legionary":4686,"galloper":404,"epic-monster-hunter-6":4385,"fire-phoenix-1":13}},
  {"name":"merc-siege-epic","input":{"rows":[["griffin-7"],["heavy-halberdier-6"],["trebuchet"],["palintone"],["epic-monster-hunter-7"],["epic-monster-hunter"],["wyvern"],["sea-lord"]],"baseCount":120,"epicHunterLast":true},"counts":{"griffin-7":120,"heavy-halberdier-6":4560,"trebuchet":260,"palintone":145,"epic-monster-hunter-7":922,"epic-monster-hunter":137,"wyvern":5,"sea-lord":28}},
  {"name":"trebuchet-only","input":{"rows":[["corax-1"],["spearmen-5"],["trebuchet"],["scorpion-rider",40],["unicorn-rider",40]],"baseCount":100},"counts":{"corax-1":100,"spearmen-5":13717,"trebuchet":599,"scorpion-rider":113,"unicorn-rider":156}},
  {"name":"monster-bonus","input":{"rows":[["royal-lion-2",290],["whitemane-2",40],["fire-phoenix-2",330],["kraken-1",80],["wyvern",250]],"baseCount":60},"counts":{"royal-lion-2":60,"whitemane-2":1671,"fire-phoenix-2":4,"kraken-1":20,"wyvern":9}},
];

function inputOf(a: Army, baseCount = a.input.baseCount) {
  return {
    ...a.input,
    baseCount,
    rows: a.input.rows.map(([troopId, healthPct]) => ({ troopId, healthPct: healthPct ?? null })),
  };
}

function countsOf(res: ReturnType<typeof planStacks>) {
  if (!res.ok) throw new Error(`no plan: ${res.reason}`);
  return Object.fromEntries(res.squads.map((s) => [s.troopId, s.count]));
}

describe('planStacks matches Kaiculator', () => {
  for (const army of ARMIES) {
    it(army.name, () => {
      const base = army.fitLeadership ? fitBaseToLeadership(inputOf(army), army.fitLeadership) : army.input.baseCount;
      if (army.fitBase) expect(base).toBe(army.fitBase);
      const got = countsOf(planStacks(inputOf(army, base ?? army.input.baseCount)));
      const want = Object.fromEntries(Object.entries(army.counts).filter(([, n]) => n > 0));
      expect(got).toEqual(want);
    });
  }
});

describe('loss order', () => {
  const army = ARMIES.find((a) => a.name === 'siege')!;
  const res = planStacks(inputOf(army));
  if (!res.ok) throw new Error('no plan');

  it('puts the siege decoys first and the base stack last among trained troops', () => {
    expect(res.squads.map((s) => s.troopId)).toEqual(['catapult-5', 'siege-ballistae-7', 'spearmen-5', 'heavy-halberdier-7', 'corax-1']);
    // The two engines aim at the same health but round up separately, so they don't tie.
    expect(res.squads.map((s) => s.lossFrom)).toEqual([1, 2, 3, 4, 5]);
  });

  it('groups stacks with the same health and measures the gap to the group before', () => {
    const r = planStacks(inputOf(ARMIES.find((a) => a.name === 'corax-guardsmen')!));
    if (!r.ok) throw new Error('no plan');
    // Tier VII: 3800 Halberdiers, 3800 Arbalesters and 1900 Mounted Knights all hold 19.38M.
    const seven = r.squads.filter((s) => ['heavy-halberdier-7', 'heavy-arbalester-7', 'mounted-knight-7'].includes(s.troopId));
    // Ahead of them: Rider V alone (6858 × 3150 rounds a little higher), then Spearman + Archer V.
    expect(new Set(seven.map((s) => `${s.lossFrom}-${s.lossTo}`))).toEqual(new Set(['4-6']));
    expect(r.squads[0].troopId).toBe('rider-5');
    expect(r.squads[0].gap).toBeNull();
    const corax = r.squads.at(-1)!;
    expect(corax.lossFrom).toBe(7);
    expect(corax.gap?.health).toBeCloseTo(seven[0].stackHealth - corax.stackHealth, 6);
    expect(corax.gap?.units).toBe(Math.ceil((seven[0].stackHealth - corax.stackHealth) / 183_600));
  });

  it('keeps monsters and mercenaries just under the base stack, strongest last', () => {
    const r = planStacks(inputOf(ARMIES.find((a) => a.name === 'monsters-mercs')!));
    if (!r.ok) throw new Error('no plan');
    const order = r.squads.map((s) => s.troopId);
    expect(order.slice(0, 2)).toEqual(['heavy-halberdier-7', 'corax-1']);
    expect(order.at(-1)).toBe('wyvern');
    const base = r.squads.find((s) => s.troopId === 'corax-1')!.stackHealth;
    for (const s of r.squads.filter((x) => x.kind !== 'troop')) expect(s.stackHealth).toBeLessThanOrEqual(base * 0.97);
  });
});

describe('costs and limits', () => {
  it('adds leadership, authority and dominance from the per-unit costs', () => {
    const r = planStacks(inputOf(ARMIES.find((a) => a.name === 'monsters-mercs')!));
    if (!r.ok) throw new Error('no plan');
    // 200 Corax × 20 + 7600 Halberdiers × 1
    expect(r.used.leadership).toBe(11_600);
    // 16 Wyverns × 63 + 53 Warregals × 20
    expect(r.used.authority).toBe(2_068);
    // 17 × 54 + 38 × 44 + 91 × 35
    expect(r.used.dominance).toBe(5_775);
  });

  it('flags a limit only when one is entered', () => {
    const army = ARMIES.find((a) => a.name === 'corax-guardsmen')!;
    const limited = planStacks({ ...inputOf(army), limits: { leadership: 50_000 } });
    const open = planStacks(inputOf(army));
    if (!limited.ok || !open.ok) throw new Error('no plan');
    expect(limited.over).toEqual({ leadership: true, authority: false, dominance: false });
    expect(open.over).toEqual({ leadership: false, authority: false, dominance: false });
  });

  it('treats an empty dominance box as no limit (Kaiculator would drop every monster)', () => {
    const army = ARMIES.find((a) => a.name === 'dominance-scaled')!;
    const r = planStacks({ ...inputOf(army), limits: { authority: 2000 } });
    expect(countsOf(r)['fire-phoenix-1']).toBe(17);
  });

  it('fits the base count to the leadership exactly', () => {
    const army = ARMIES.find((a) => a.name === 'find-leadership')!;
    const n = fitBaseToLeadership(inputOf(army), 250_000)!;
    const at = (k: number) => planStacks(inputOf(army, k));
    const fits = at(n);
    const over = at(n + 1);
    if (!fits.ok || !over.ok) throw new Error('no plan');
    expect(fits.used.leadership).toBeLessThanOrEqual(250_000);
    expect(over.used.leadership).toBeGreaterThan(250_000);
  });

  it('divides the revival cost by the Temple reduction, siege engines included', () => {
    const army = ARMIES.find((a) => a.name === 'siege')!;
    const r1 = planStacks({ ...inputOf(army), templeLevel: 1 });
    const r45 = planStacks({ ...inputOf(army), templeLevel: 45 });
    if (!r1.ok || !r45.ok) throw new Error('no plan');
    const gold = r1.squads.reduce((a, s) => a + s.revivalGold, 0);
    expect(r1.revivalGold).toBeCloseTo(gold / TEMPLE_REVIVAL_REDUCTION[0], 6);
    expect(r45.revivalGold).toBeCloseTo(gold / 5.91, 6);
    // 90% of 1123 Ballistae at 40 gold each is part of it.
    expect(r1.squads.find((s) => s.troopId === 'siege-ballistae-7')!.revivalGold).toBe(Math.floor(0.9 * 1123) * 40);
  });
});

describe('inputs', () => {
  it('needs a guardsman or specialist for the base stack', () => {
    expect(planStacks({ rows: [], baseCount: 100 })).toEqual({ ok: false, reason: 'empty' });
    expect(planStacks({ rows: [{ troopId: 'wyvern' }, { troopId: 'fire-phoenix-1' }], baseCount: 100 })).toEqual({ ok: false, reason: 'no-base' });
  });

  it('ignores unknown troops and repeats', () => {
    const r = planStacks({ rows: [{ troopId: 'corax-1' }, { troopId: 'corax-1' }, { troopId: 'nope' }], baseCount: 10 });
    expect(countsOf(r)).toEqual({ 'corax-1': 10 });
  });

  it('knows every troop the citadel tool lists, with a cost', () => {
    expect(STACK_TROOPS.map((x) => x.id)).toEqual(TROOPS.map((x) => x.id));
    for (const x of TROOPS) {
      const u = stackUnit(x.id)!;
      expect(u.leadership + u.authority + u.dominance, x.id).toBeGreaterThan(0);
      expect(u.revivalGold, x.id).toBeGreaterThan(0);
    }
  });
});
