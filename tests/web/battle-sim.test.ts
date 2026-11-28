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
import { simulateArmies, optimizeArmy, damageVs, makeStack, BLOCKED } from '../../src/web/public/lib/battle-sim.js';
import { DEFENDERS, troopById } from '../../src/web/public/lib/citadel-sim.js';

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
