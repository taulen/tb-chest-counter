// Citadel simulator — the battle rules and data behind Tools → Citadel.
//
// Every rule here was measured from real battle reports (Elven 10, 15, 20, 25
// and 30) and replays them strike for strike; tests/web/citadel-sim.test.ts
// holds those reports, so a changed rule fails the suite. The evidence and the
// open questions are in docs/citadel-simulator.md.
//
// The fight, in game terms:
//  - SIEGE (only while the walls stand): siege engines strike first (initiative
//    +5), then the walls, then everything else hits the walls. Rounds repeat
//    until the walls are down. Wounds taken from the walls heal before the
//    battle; units the walls kill stay dead.
//  - BATTLE in rounds. A coin flip decides who opens round 1; after that the
//    side that did NOT act last opens the next round. Within a round the sides
//    alternate, each using its strongest stack that has not acted yet (stack
//    strength = units × strength × (1 + bonus); features play no part). When
//    one side runs out, the other side's remaining stacks act back to back.
//  - TARGETING: a stack hits the enemy it would deal the most damage to —
//    features ("vs mounted +667 %") are added to the bonus, and damage is
//    capped at what the target has left. Ties go to the target that would hit
//    back hardest.
//  - DAMAGE: units × strength × (1 + bonus + matching features); siege engines
//    deal ×20 against fortifications. A stack's health is a pool: units alive =
//    ceil(pool ÷ unit health), and a damaged stack strikes with those units.
//    Wounds stay through the whole battle, for every troop kind.
//  - LUCK (double damage, striking two squads) is not simulated; the
//    tests replay it through `luck` to match the reports exactly.
//
// The engine itself is lib/battle-sim.js, shared with Tools → Monsters; this
// file is Citadel's troops, defenders, citadels and game01master's sizing.
//
// Plain ESM, no DOM access — imported by pages/citadel-tool.js and the tests.

import { simulateArmies, optimizeArmy } from './battle-sim.js';
import { TROOPS, DEFENDERS, CITADELS } from './citadel-troops.js';

export { TROOPS, DEFENDERS, CITADELS };

export const TROOP_GROUPS = ['guardsmen', 'specialists', 'monsters', 'mercenaries', 'siege'];

/**
 * Troops that read the same strength and health bonus off their cards: the
 * same captain, artifact and research lines apply to every tier. These are
 * game01master's groups (its getBonusGroup, which links the strength fields),
 * with one change: Fire Phoenix and Royal Lion share a family. game01master
 * keeps them apart, but the user's cards read the same strength AND health
 * for Phoenix I and Royal Lion I twice (Nov 2026). The page links strength and
 * health within a family only while the boxes agree, so a pair that does differ
 * just stops following once typed apart. A troop in no family shares with nothing.
 */
export const BONUS_FAMILIES = {
  corax: ['corax-1', 'corax-2'],
  'phoenix-lion': ['fire-phoenix-1', 'fire-phoenix-2', 'royal-lion-1', 'royal-lion-2', 'jago'],
  vulture: ['vulture-5', 'vulture-6', 'vulture-7'],
  griffin: ['griffin-5', 'griffin-6', 'griffin-7', 'warregal'],
  // A line's renamed tiers stay in its family, as game01master's melee ones do
  // (Spearman → Heavy Halberdier → Punisher). The ranged and mounted lines
  // follow the same pattern; they're not in game01master, so that is by analogy.
  'melee-guardsmen': ['spearmen-1', 'spearmen-2', 'spearmen-3', 'spearmen-4', 'spearmen-5', 'heavy-halberdier-6', 'heavy-halberdier-7', 'punisher-1', 'punisher-2'],
  'melee-specialists': ['swordsmen-1', 'swordsmen-2', 'swordsmen-3', 'swordsmen-4', 'swordsmen-5', 'heavy-knight-6', 'heavy-knight-7', 'duelist-1', 'duelist-2'],
  'ranged-guardsmen': ['archer-1', 'archer-2', 'archer-3', 'archer-4', 'archer-5', 'heavy-arbalester-6', 'heavy-arbalester-7', 'purifier-1', 'purifier-2'],
  'mounted-guardsmen': ['rider-1', 'rider-2', 'rider-3', 'rider-4', 'rider-5', 'mounted-knight-6', 'mounted-knight-7', 'smiter-1', 'smiter-2'],
  'ranged-specialists': ['deadshot-5', 'deadshot-6', 'deadshot-7', 'legitimist-1', 'legitimist-2'],
  'mounted-specialists': ['lion-rider-5', 'lion-rider-6', 'lion-rider-7', 'whitemane-1', 'whitemane-2'],
};
/**
 * The order the game lists troops when a march is set up (game01master's
 * RESULT_ORDER): the march list follows it, so a player goes straight down
 * the screen typing counts instead of hunting for each troop. Fixes from the
 * game itself (Nov 2026 march screens), where game01master has the pair the
 * other way round: Jago comes before Warregal, and Royal Lion I before Corax I.
 * The two have the same strength at tier II as well, so Royal Lion II goes
 * before Corax II by the same rule (not yet seen in game).
 */
export const MARCH_ORDER = [
  'wyvern', 'jago', 'warregal', 'ariel', 'epic-monster-hunter', 'fire-phoenix-2',
  'fire-phoenix-1', 'manticore', 'royal-lion-2', 'corax-2', 'royal-lion-1',
  'corax-1', 'griffin-7', 'josephine-2', 'griffin-6', 'josephine-1',
  'griffin-5', 'siege-ballistae-7', 'siege-ballistae-6', 'punisher-1',
  'duelist-1', 'catapult-5', 'vulture-7', 'heavy-halberdier-7',
  'heavy-knight-7', 'catapult-4', 'vulture-6', 'heavy-halberdier-6',
  'heavy-knight-6', 'catapult-3', 'spearmen-5', 'swordsmen-5', 'vulture-5',
];

/**
 * Rows with troops to send, sorted as the march screen lists them. The screen
 * puts mercenaries first, then monsters, then everything else, each by base
 * strength (highest first); MARCH_ORDER settles ties. That rule reproduces
 * MARCH_ORDER exactly and places every other troop by its strength — checked
 * in game only for the 33 in MARCH_ORDER.
 */
export function marchList(rows) {
  const rank = (def) => (def.group === 'mercenaries' ? 0 : def.group === 'monsters' ? 1 : 2);
  const at = (id) => {
    const k = MARCH_ORDER.indexOf(id);
    return k === -1 ? MARCH_ORDER.length : k;
  };
  const key = (r) => {
    const def = troopById(r.troopId);
    return def ? [rank(def), -def.str, at(r.troopId)] : [3, 0, at(r.troopId)];
  };
  return rows.filter((r) => r.count > 0).sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

/**
 * The level that unlocks each troop: [kind, tier], kind g/s/m/e (Guardsmen,
 * Specialists, Monsters, Engineers — the levels players quote as "8/8/8/7"),
 * from each troop's `tier` (the wiki's tier I-IX). The roman numeral in a name
 * is the tier up to VII; the renamed tiers start again at I = 8 (Punisher I,
 * Corax II = 9…). Mercenaries aren't unlocked by level and are always offered.
 */
const LEVEL_KIND = { guardsmen: 'g', specialists: 's', monsters: 'm', siege: 'e' };
export const TROOP_TIERS = Object.fromEntries(
  TROOPS.filter((x) => x.tier && LEVEL_KIND[x.group]).map((x) => [x.id, [LEVEL_KIND[x.group], x.tier]]),
);

/** [kind, tier] for a troop, or null when no level gates it. */
export function troopTier(troopId) {
  return TROOP_TIERS[troopId] ?? null;
}

/** Whether levels { g, s, m, e } (null = any) unlock this troop. */
export function troopUnlocked(troopId, levels) {
  const tier = TROOP_TIERS[troopId];
  if (!tier || !levels) return true;
  const cap = levels[tier[0]];
  return cap === null || cap === undefined || tier[1] <= cap;
}

/** How many top levels the troop picker shows when the account hasn't chosen (levels.span null). */
export const DEFAULT_LEVEL_SPAN = 4;
/** levels.span for "all levels": 9 tiers reach down to tier 1. */
export const ALL_LEVELS_SPAN = 9;

/**
 * Whether the picker offers this troop at these levels ({ g, s, m, e, span }).
 * The window is the top `span` levels counted down from the account's HIGHEST
 * level, and each kind shows only what it has unlocked inside it (the user's
 * rule): at G8 / M8 / S7 with span 2 the band is tiers 8-7, so guardsmen and
 * monsters show 8 and 7, specialists only 7. Mercenaries and a kind left at
 * "any" show everything.
 */
export function troopInWindow(troopId, levels) {
  const tier = TROOP_TIERS[troopId];
  if (!tier || !levels) return true;
  const cap = levels[tier[0]];
  if (cap === null || cap === undefined) return true;
  if (tier[1] > cap) return false;
  const top = Math.max(...['g', 's', 'm', 'e'].map((k) => levels[k]).filter(Number.isInteger));
  const span = Number.isInteger(levels.span) && levels.span > 0 ? levels.span : DEFAULT_LEVEL_SPAN;
  return tier[1] > top - span;
}

const FAMILY_OF = new Map(Object.entries(BONUS_FAMILIES).flatMap(([fam, ids]) => ids.map((id) => [id, fam])));

/** The bonus family of a troop, or null when it shares its bonuses with none. */
export function bonusFamily(troopId) {
  return FAMILY_OF.get(troopId) ?? null;
}

const TROOP_BY_ID = new Map(TROOPS.map((x) => [x.id, x]));
const CITADEL_BY_ID = new Map(CITADELS.map((c) => [c.id, c]));
export const troopById = (id) => TROOP_BY_ID.get(id) ?? null;
export const citadelById = (id) => CITADEL_BY_ID.get(id) ?? null;

// ─── Engine: lib/battle-sim.js, shared with Tools → Monsters ─────

export { SAFETY } from './battle-sim.js';

/** Monsters and mercenaries are never traded for cheaper losses: a setup that
 *  loses even one of them ranks below every setup that loses only guardsmen,
 *  specialists or siege engines, however many. The first striker is there to
 *  absorb the losses; these are not. */
export const PROTECTED_GROUPS = new Set(['monsters', 'mercenaries']);

/** A citadel's army for the engine: its units, then the walls. */
function citadelArmy(citadel) {
  return [
    ...citadel.units.map(([id, n]) => ({ def: DEFENDERS[id], count: n })),
    ...(citadel.walls > 0 ? [{ def: DEFENDERS.walls, count: citadel.walls }] : []),
  ];
}

/**
 * Simulate one attack.
 * @param {object} p
 * @param {string} p.citadelId   e.g. 'elven-30'
 * @param {{troopId:string,count:number,strengthPct?:number,healthPct?:number|null}[]} p.army
 *        healthPct null = not entered (battle-sim.js UNKNOWN_HEALTH_FACTOR)
 * @param {'you'|'citadel'} p.opener  who opens the first battle round
 * @param {Record<number,{double?:boolean,second?:boolean}>} [p.luck]  1-based action number → luck rolls (tests)
 */
export function simulate({ citadelId, army, opener = 'citadel', luck = {} }) {
  const citadel = citadelById(citadelId);
  if (!citadel) throw new Error(`unknown citadel ${citadelId}`);
  const mine = army.map((row) => ({ ...row, def: troopById(row.troopId) }));
  return { citadelId, ...simulateArmies({ mine, theirs: citadelArmy(citadel), opener, enemySide: 'citadel', luck }) };
}

/** Both coin-flip outcomes for the same army. */
export function simulateBoth(params) {
  return { you: simulate({ ...params, opener: 'you' }), citadel: simulate({ ...params, opener: 'citadel' }) };
}

/**
 * Counts that win in BOTH coin-flip outcomes with the fewest expected losses,
 * for the troop types and bonuses given (any citadel) — battle-sim.js
 * optimizeArmy, with monsters and mercenaries protected (PROTECTED_GROUPS).
 *
 * @param {{ citadelId: string, army: {troopId: string, count?: number, strengthPct?: number|null, healthPct?: number|null}[], budget?: number, starts?: number[][] }} p
 *        starts: extra starting counts (game01master's, the player's own)
 * @returns {{ ok: boolean, counts: number[], both: any, evaluations: number }}
 */
export function optimizeCounts({ citadelId, army, budget = 2500, starts = [] }) {
  const citadel = citadelById(citadelId);
  if (!citadel || !army.length) return { ok: false, counts: army.map(() => 0), both: null, evaluations: 0 };
  const rows = army.map((r) => {
    const def = troopById(r.troopId);
    return { def, strengthPct: r.strengthPct, healthPct: r.healthPct, protected: PROTECTED_GROUPS.has(def.group) };
  });
  const res = optimizeArmy({ army: rows, enemy: citadelArmy(citadel), budget, starts, enemySide: 'citadel' });
  // The search's results carry the engine's shape; the page reads Citadel's (citadelId, both coin flips).
  const both = res.both ? {
    you: { citadelId, ...res.both.you },
    citadel: { citadelId, ...res.both.citadel },
  } : null;
  return { ...res, both };
}

// ─── game01master's sizing (Elven 25 and 30 only) ─────────────────

/** game01master's targets: the first striker kills the Life Dragon and absorbs
 *  its opening strike; the second kills the Pegasus Rider (or, with a Fire
 *  Phoenix, cripples the Bear); the third kills the Centaur; cleanups are sized
 *  just below the third so they act after it. Its Bear target is deliberately
 *  under the real 792M / 158.4M — see docs/citadel-simulator.md. */
const GM = {
  'elven-25': { firstStrike: 115.2e6, wall: 957e6, normal: [345.6e6, 105.78e6, 78e6], withPhoenix: [345.6e6, 158e6, 78e6], cleanup: 77e6 },
  'elven-30': { firstStrike: 552e6, wall: 4.05e9, normal: [1656e6, 516.6e6, 382.2e6], withPhoenix: [1656e6, 788e6, 382.2e6], cleanup: 380.8e6 },
};
/** game01master adds these troops' "vs Beasts" feature wherever they stand. */
const GM_BEAST_EXTRA = new Set(['punisher-1', 'heavy-halberdier-7', 'heavy-halberdier-6', 'duelist-1', 'heavy-knight-7', 'heavy-knight-6', 'spearmen-5', 'swordsmen-5']);
export const GM_CITADELS = new Set(Object.keys(GM));

/** Role of each army row in game01master's template: 'first' | 'second' |
 *  'third' | 'cleanup' | 'extra' | 'walls' (first siege engine) | null. */
export function gmRoles(citadelId, army) {
  if (!GM[citadelId]) return army.map(() => null);
  let fighter = 0;
  let wallTaken = false;
  return army.map((row) => {
    const def = troopById(row.troopId);
    if (!def) return null;
    if (def.siegeEngine) {
      if (wallTaken) return 'extra';
      wallTaken = true;
      return 'walls';
    }
    const i = fighter++;
    return ['first', 'second', 'third'][i] ?? (i < 9 ? 'cleanup' : 'extra');
  });
}

/** game01master's counts for each row (null where it has no rule). Counts are
 *  rounded DOWN on purpose: a bigger stack can change its own target. */
export function gmCounts(citadelId, army) {
  const g = GM[citadelId];
  if (!g) return army.map(() => null);
  const roles = gmRoles(citadelId, army);
  const secondRow = army[roles.indexOf('second')];
  const withPhoenix = !!secondRow && /^fire-phoenix/.test(secondRow.troopId);
  const targets = withPhoenix ? g.withPhoenix : g.normal;
  let fighter = 0;
  return army.map((row, i) => {
    const def = troopById(row.troopId);
    const role = roles[i];
    if (!def || !role || role === 'extra') return null;
    const s = (Number(row.strengthPct) || 0) / 100;
    const h = (Number(row.healthPct) || 0) / 100;
    if (role === 'walls') {
      const perUnit = def.str * (1 + s + (def.vs.fortification || 0) / 100) * 20;
      return Math.ceil(g.wall / perUnit) + 2;
    }
    const slot = fighter++;
    let eff = s;
    if (GM_BEAST_EXTRA.has(def.id)) eff += (def.vs.beast || 0) / 100;
    if (role === 'second' && withPhoenix) eff += (def.vs.melee || 0) / 100;
    const target = targets[slot] ?? g.cleanup;
    let n = Math.floor(target / (def.str * (1 + eff)));
    if (role === 'first') n += Math.floor(g.firstStrike / (def.hp * (1 + h))) + 10;
    if (role === 'cleanup' && def.id === 'epic-monster-hunter') n = Math.max(0, n - 5);
    return n;
  });
}
