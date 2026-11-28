/**
 * The shared battle engine (lib/battle-sim.js) on the game's own unit data:
 * real shared battle reports (Nov 2026) replayed strike for strike — a
 * Common, a Rare and an Epic squad, Briareus, Basilisk, Arachne's Swarm,
 * Vineweaver, two event fights (Epic Fenrir, Baron Candlemourn, where the
 * player's army carries an extra bonus against the event's monsters) and two
 * Tin Man hits. Monsters fight at their base numbers; the player's bonuses
 * were measured from each report; luck comes from the log. Citadel's own
 * replays are in citadel-sim.test.ts (same engine).
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { simulateArmies, simulateBothArmies, optimizeArmy, optimizeArmySteps, damageVs, makeStack, BLOCKED, SAFETY } from '../../src/web/public/lib/battle-sim.js';
import { DEFENDERS, CITADELS, troopById, optimizeCounts, gmCounts } from '../../src/web/public/lib/citadel-sim.js';

type Unit = { name: string; tier: number; str: number; hp: number; tags: string[]; vs: Array<[string[], number, number]> };
type Battle = {
  report: string; target: string; opener: 'you' | 'enemy'; epicPct?: number;
  army: Array<[number, number, number, number | null]>; enemy: Array<[number, number]>;
  luck: Record<string, { double?: boolean; second?: boolean; blocked?: boolean }>;
  strikes: Array<['you' | 'enemy', number, number, number]>;
};
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/monster-battles.json'), 'utf8')) as { units: Record<string, Unit>; battles: Battle[] };
const def = (id: number) => ({ id, ...fx.units[id] });

function play(b: Battle, epicPct = b.epicPct ?? 0) {
  const withEpic = (d: ReturnType<typeof def>) => (epicPct ? { ...d, vs: [...d.vs, [['epicmonster'], epicPct, 1]] } : d);
  return simulateArmies({
    mine: b.army.map(([u, count, strengthPct, healthPct]) => ({ def: withEpic(def(u)), count, strengthPct, healthPct })),
    theirs: b.enemy.map(([u, count]) => ({ def: def(u), count })),
    opener: b.opener,
    luck: b.luck,
  });
}
/**
 * The log's strikes against the engine's: the same striker, side and target
 * every time, and the same damage to one part in a million. The game logs
 * whole points and the player's bonuses were measured back from a strike's
 * whole points, so a bonus read off a small strike is exact to about that.
 */
function firstDifference(b: Battle, res: ReturnType<typeof play>): string | null {
  for (let i = 0; i < Math.max(b.strikes.length, res.strikes.length); i++) {
    const want = b.strikes[i];
    const got = res.strikes[i] as { side: string; actor: number; target: number; damage: number } | undefined;
    if (!want || !got) return `strike ${i}: ${want ? 'missing' : 'extra'}`;
    const [side, actor, target, damage] = want;
    if (got.side !== side || got.actor !== actor || got.target !== target || Math.abs(got.damage - damage) > Math.max(1.5, damage * 1e-6)) {
      return `strike ${i}: game ${side} ${actor} → ${target} ${damage}, engine ${got.side} ${got.actor} → ${got.target} ${Math.round(got.damage)}`;
    }
  }
  return null;
}

describe('real battles, replayed strike for strike on the game data', () => {
  for (const b of fx.battles) {
    it(`${b.target} (${b.report}, ${b.strikes.length} strikes)`, () => {
      expect(firstDifference(b, play(b))).toBeNull();
    });
  }

  it('an event fight only replays with the army\'s extra bonus against the event\'s monsters', () => {
    const fenrir = fx.battles.find((b) => b.target === 'Epic Fenrir squad')!;
    expect(fenrir.epicPct).toBe(450);
    expect(firstDifference(fenrir, play(fenrir, 0))).not.toBeNull();
  });
});

describe('the engine', () => {
  const bear = { id: 'bear', str: 22000, hp: 66000, tags: ['melee', 'beast'], vs: [[['mounted'], 70, 1]] };
  const corax = { id: 'corax', str: 61200, hp: 183600, tags: ['flying', 'guardsmen', 'human'], vs: [[['mounted'], 1333, 1], [['citywalls'], 701, 1]] };

  it('a blocked strike deals 67%', () => {
    const res = simulateArmies({ mine: [{ def: corax, count: 10, strengthPct: 0, healthPct: 0 }], theirs: [{ def: bear, count: 1000 }], opener: 'you', luck: { 1: { blocked: true } } });
    expect(res.strikes[0].damage).toBeCloseTo(10 * 61200 * BLOCKED, 6);
  });

  it('the game data\'s ×20 on walls equals Citadel\'s siege rule', () => {
    const gameBallista = { id: 'b', str: 8500, hp: 51000, tags: ['siege', 'engine', 'human'], vs: [[['citywalls'], 740, 20]] };
    const gameWalls = { id: 'w', str: 10000, hp: 30000, tags: ['citywalls', 'engine'], vs: [[['melee'], 100, 1]] };
    const game = damageVs(makeStack('you', gameBallista, 100, 2277), makeStack('enemy', gameWalls, 1));
    const citadel = damageVs(makeStack('you', troopById('siege-ballistae-7'), 100, 2277), makeStack('citadel', DEFENDERS.walls, 1));
    expect(game).toBeCloseTo(citadel, 6);
    expect(game).toBeCloseTo(100 * 8500 * (1 + 22.77 + 7.4) * 20, 3);
  });

  it('the count search keeps every row within what the player has', () => {
    const enemy = [{ def: bear, count: 2000 }];
    const free = optimizeArmy({ army: [{ def: corax, strengthPct: 1000, healthPct: 800 }], enemy });
    expect(free.ok).toBe(true);
    expect(free.counts[0]).toBeGreaterThan(150);
    const capped = optimizeArmy({ army: [{ def: corax, strengthPct: 1000, healthPct: 800, cap: 150 }], enemy });
    expect(capped.ok).toBe(true);
    expect(capped.counts[0]).toBeLessThanOrEqual(150);
    expect(capped.both.you.won && capped.both.enemy.won).toBe(true);
  });

  it('says so when what the player has can\'t win', () => {
    const res = optimizeArmy({ army: [{ def: corax, strengthPct: 0, healthPct: 0, cap: 1 }], enemy: [{ def: bear, count: 200000 }] });
    expect(res.ok).toBe(false);
    expect(res.counts[0]).toBeLessThanOrEqual(1);
  });

  it('with worstCase, the worse coin flip loses no more mercenaries than the averaging search would', () => {
    const merc = { id: 'merc', str: 220000, hp: 660000, tags: ['flying', 'beast'], vs: [] };
    const decoy = { id: 'decoy', str: 520, hp: 1560, tags: ['melee', 'human'], vs: [] };
    const army = [
      { def: merc, strengthPct: 1600, healthPct: 1000, protected: true, cap: 20, weight: 160 },
      { def: corax, strengthPct: 1000, healthPct: 800, cap: 400, weight: 80 },
      { def: decoy, strengthPct: 1000, healthPct: 800, cap: 5000, weight: 4 },
    ];
    const enemy = [{ def: bear, count: 3000 }];
    const worst = (res: ReturnType<typeof optimizeArmy>) => Math.max(...[res.both.you, res.both.enemy]
      .map((r: { army: Array<{ troopId: string; lost: number }> }) => r.army.filter((s) => s.troopId === 'merc').reduce((a, s) => a + s.lost, 0)));
    const mean = optimizeArmy({ army, enemy });
    const safe = optimizeArmy({ army, enemy, worstCase: true });
    expect(safe.ok).toBe(true);
    expect(worst(safe)).toBeLessThanOrEqual(worst(mean));
  });

  it('leaves a troop at home when it only adds losses', () => {
    const decoy = { id: 'decoy', str: 10, hp: 30, tags: ['melee', 'human'], vs: [] };
    const res = optimizeArmy({
      army: [{ def: corax, strengthPct: 1000, healthPct: 800 }, { def: decoy, strengthPct: 0, healthPct: 0, cap: 5000 }],
      enemy: [{ def: bear, count: 500 }],
    });
    expect(res.ok).toBe(true);
    expect(res.counts[1]).toBe(0);
  });
});

describe('a battle stopped by onLoss (the count search drops a candidate mid-battle)', () => {
  const bear = { id: 'bear', str: 22000, hp: 66000, tags: ['melee', 'beast'], vs: [[['mounted'], 70, 1]] };
  const corax = { id: 'corax', str: 61200, hp: 183600, tags: ['flying', 'guardsmen', 'human'], vs: [[['mounted'], 1333, 1]] };
  const fight = { mine: [{ def: corax, count: 60, strengthPct: 500, healthPct: 300 }], theirs: [{ def: bear, count: 1500 }], opener: 'enemy', keepStrikes: false };

  it('stops at the first loss it refuses, and plays the same battle to the end without it', () => {
    const full = simulateArmies(fight);
    expect(full.aborted).toBe(false);
    const lostFirst = full.army[0].lost;
    expect(lostFirst).toBeGreaterThan(0);
    const seen: Array<[number, number]> = [];
    const stopped = simulateArmies({ ...fight, onLoss: (index: number, units: number) => { seen.push([index, units]); return true; } });
    expect(stopped.aborted).toBe(true);
    expect(stopped.reason).toBe('aborted');
    expect(stopped.won).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe(0);
    // A callback that never refuses changes nothing.
    const watched = simulateArmies({ ...fight, onLoss: () => false });
    expect({ ...watched, aborted: false }).toEqual(full);
  });
});

describe('the explore search (Tools → Monsters)', () => {
  // The user's Elven 25 card bonuses (Nov 7 2026) and Citadel's own data: a known army, a known enemy.
  const cards: Array<[string, number, number]> = [
    ['siege-ballistae-7', 2277, 1616.75], ['corax-1', 5226.5, 3936.75], ['fire-phoenix-1', 3736.5, 2794.75],
    ['royal-lion-1', 3736.5, 2794.75], ['griffin-7', 5326.5, 4036.75], ['vulture-7', 3636.5, 2694.75],
  ];
  const army = cards.map(([id, strengthPct, healthPct]) => {
    const def = troopById(id)!;
    return { def, strengthPct, healthPct, protected: ['monsters', 'mercenaries'].includes(def.group) };
  });
  const e25 = CITADELS.find((c) => c.id === 'elven-25')!;
  const enemy = [...(e25.units as Array<[string, number]>).map(([id, n]) => ({ def: DEFENDERS[id], count: n })), { def: DEFENDERS.walls, count: e25.walls }];
  type Played = { won: boolean; army: Array<{ index: number; lost: number }> };
  const base = { army, enemy, enemySide: 'citadel', explore: true, work: 4e6 };
  /** optimizeArmy's objective (mean of the flips, base-health weights): protected, then other losses. */
  const losses = (counts: number[]) => {
    const lower = (p: number) => ((1 + p / 100) * (1 - SAFETY) - 1) * 100;
    const play = (rows: typeof army) => simulateBothArmies({ mine: rows.map((r, i) => ({ ...r, count: counts[i] })), theirs: enemy, enemySide: 'citadel' }) as unknown as Record<'you' | 'citadel', Played>;
    const all = [play(army), play(army.map((r) => ({ ...r, strengthPct: lower(r.strengthPct), healthPct: lower(r.healthPct) })))]
      .flatMap((b) => [b.you, b.citadel]);
    let prot = 0;
    let rest = 0;
    for (const res of all) for (const s of res.army) (army[s.index].protected ? (prot += s.lost * army[s.index].def.hp) : (rest += s.lost * army[s.index].def.hp));
    return { won: all.every((r) => r.won), prot: prot / 4, rest: rest / 4 };
  };

  it('reports progress that never goes back and ends at the total', () => {
    const seen: Array<{ done: number; total: number; phase: string }> = [];
    const res = optimizeArmy({ ...base, onProgress: (p: { done: number; total: number; phase: string }) => seen.push(p) });
    expect(res.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(20);
    for (let i = 1; i < seen.length; i++) expect(seen[i].done).toBeGreaterThanOrEqual(seen[i - 1].done);
    expect(seen.every((p) => p.total === 4e6 && p.done <= p.total && ['starts', 'improve'].includes(p.phase))).toBe(true);
    expect(seen.at(-1)!.done).toBe(4e6);
    // 'starts' first; once it says 'improve', it never goes back.
    expect(seen[0].phase).toBe('starts');
    const firstImprove = seen.findIndex((p) => p.phase === 'improve');
    if (firstImprove >= 0) expect(seen.slice(firstImprove).every((p) => p.phase === 'improve')).toBe(true);
  });

  it('is deterministic: the same army every time, called or stepped', () => {
    const a = optimizeArmy(base);
    const b = optimizeArmy(base);
    expect(b.counts).toEqual(a.counts);
    const gen = optimizeArmySteps(base);
    let step = gen.next();
    while (!step.done) step = gen.next();
    expect(step.value.counts).toEqual(a.counts);
  });

  it('wins both coin flips with every bonus 3% lower, and never loses more than the search it replaces', () => {
    const old = optimizeArmy({ army, enemy, enemySide: 'citadel' });
    const ex = optimizeArmy(base);
    const o = losses(old.counts);
    const x = losses(ex.counts);
    expect(x.won).toBe(true);
    expect(x.prot).toBeLessThanOrEqual(o.prot + 1e-6);
    if (Math.abs(x.prot - o.prot) <= 1e-6) expect(x.rest).toBeLessThanOrEqual(o.rest + 1e-6);
  });

  it('keeps every row within what the player has', () => {
    const caps = [400, 150, 10, 40, 60, 2000];
    const res = optimizeArmy({ ...base, army: army.map((r, i) => ({ ...r, cap: caps[i] })) });
    expect(res.ok).toBe(true);
    res.counts.forEach((n: number, i: number) => expect(n).toBeLessThanOrEqual(caps[i]));
  });

  it('for Citadel ranks on the losses at the bonuses as typed, never worse than the old search (the user’s Elven 25 cards: 15 / 31)', () => {
    const rows = cards.map(([troopId, strengthPct, healthPct]) => ({ troopId, count: 0, strengthPct, healthPct }));
    const gm = (gmCounts('elven-25', rows) as Array<number | null>).map((n) => (Number.isFinite(n) ? n as number : 0));
    const starts = [rows.map(() => 0), gm];
    const lostUnits = (res: { both: Record<'you' | 'citadel', Played> }) => [res.both.you, res.both.citadel].map((r) => r.army.reduce((a, x) => a + x.lost, 0));
    const before = optimizeCounts({ citadelId: 'elven-25', army: rows, starts, explore: false });
    const now = optimizeCounts({ citadelId: 'elven-25', army: rows, starts });
    expect(lostUnits(before)).toEqual([15, 31]);
    const [you, them] = lostUnits(now);
    expect(you).toBeLessThanOrEqual(15);
    expect(them).toBeLessThanOrEqual(31);
    expect(now.both.you.won && now.both.citadel.won).toBe(true);
  });

  it("says so when what the player has can't win", () => {
    const res = optimizeArmy({ ...base, army: army.map((r) => ({ ...r, cap: 1 })) });
    expect(res.ok).toBe(false);
  });
});
