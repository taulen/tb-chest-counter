// Stack calculator — the sizing rule behind Tools → Stacks.
//
// A port of Kaiculator's "estimated" mode (kaiculator.kaikaiju.com, v0.71.5,
// read from its published bundle, Nov 2026). It answers: with these troops,
// how big should each stack be so the enemy wears down the cheap stacks first
// and reaches the valuable ones last? The idea, in game terms:
//
//  - An enemy stack hits the stack it can hurt most. Against a stack it can
//    finish off, that is simply the stack with the MOST health, so stack health
//    is the loss order: the biggest stack falls first, the smallest last.
//  - The BASE stack is the strongest guardsman/specialist picked (highest unit
//    health). The player sets its size; it is the smallest stack of trained
//    troops and the last of them to fall.
//  - Every other guardsman/specialist stack is sized from it. Within a tier the
//    stacks hold the same health (TYPE_MULTIPLIERS: one flyer = 10 riders = 20
//    foot soldiers in health). Each tier lower gets `tierMultiplier` (1.9) times
//    the units, a little more health per tier, so lower tiers fall first.
//    Specialists get 1% more health than the guardsmen of their tier, so they
//    fall first within it (Kaiculator's default).
//  - Monsters and mercenaries are capped just below the base stack (97% of its
//    health) and step down from there, weakest first, so the strongest is the
//    last stack standing.
//  - Siege engines are decoys: each gets more health than the biggest stack, so
//    an epic monster's first hits land on them. How much more grows with the gap
//    between your base tier and your best engineer tier; the siege multiplier
//    scales it after a real fight shows the decoys too small or too large.
//
// Health bonuses (percent, from each troop's card) divide the counts: a stack
// with +100% health needs half the units for the same health.
//
// Differences from Kaiculator, on purpose:
//  - No limit entered = no limit. Kaiculator drops every monster when its
//    over-limit handling is on and the dominance box is empty.
//  - Siege engines count towards the revival cost (Kaiculator leaves them out).
//  - Its battle-report calibration, sub-tier stacking, power score and attack
//    assessment are not ported.
//
// Plain ESM, no DOM access — imported by pages/stacks-tool.js and the tests.

import { TROOPS, troopById } from './citadel-sim.js';

/** Units of one type that hold the same health within a tier (Kaiculator's TroopMultipliers). */
export const TYPE_MULTIPLIERS = { flying: 1, mounted: 10, melee: 20, ranged: 20 };
export const DEFAULT_TIER_MULTIPLIER = 1.9;
export const DEFAULT_SIEGE_MULTIPLIER = 1;
/** Monsters and mercenaries stop at this share of the base stack's health. */
export const HEALTH_RISK_TOLERANCE = 0.97;
/** Specialists get this much more health than the guardsmen of their tier
 *  (Kaiculator's safety scale 50, written as it computes it so floats match). */
const SPECIALIST_MARGIN = 0.0025 + (50 / 50) * 0.0075;
/** Revival cost divisor per Temple level 1-45 (Kaiculator's table). */
export const TEMPLE_REVIVAL_REDUCTION = [
  1.04, 1.06, 1.08, 1.11, 1.13, 1.16, 1.19, 1.22, 1.27, 1.33, 1.36, 1.4, 1.44, 1.48, 1.53,
  1.58, 1.63, 1.68, 1.74, 1.81, 1.91, 2.02, 2.15, 2.31, 2.51, 2.68, 2.88, 3.13, 3.44, 3.84,
  3.93, 4.03, 4.13, 4.23, 4.34, 4.46, 4.59, 4.72, 4.87, 5.02, 5.17, 5.34, 5.52, 5.71, 5.91,
];
/** Kaiculator prices a revival at 90% of each stack. */
const REVIVAL_SHARE = 0.9;
export const MONSTER_MODES = ['reference', 'whole-stacks', 'scaled'];

// ─── Per-unit costs (Kaiculator's unit table) ───────────────────────

/** Dominance per monster; its revival costs 16 gold per point of dominance. */
const MONSTER_DOMINANCE = {
  'trickster-2': 52, 'kraken-2': 55, 'devastator-2': 53, 'fire-phoenix-2': 54,
  'trickster-1': 52, 'kraken-1': 55, 'devastator-1': 53, 'fire-phoenix-1': 54,
  'wind-lord': 45, 'black-dragon': 44, 'destructive-colossus': 43, 'ancient-terror': 41,
  'ruby-golem': 35, 'jungle-destroyer': 34, 'crystal-dragon': 33, 'troll-rider': 30,
  ettin: 23, manticore: 22, 'flaming-centaur': 21, 'desert-vanquisher': 20,
  'ice-phoenix': 15, 'many-armed-giant': 11, 'gorgon-medusa': 10, 'magic-dragon': 13,
  'water-elemental': 3, 'battle-boar': 6, 'emerald-dragon': 7, 'stone-gargoyle': 8,
};
/** Flying guardsmen and specialists that take 20 leadership (Vultures take 1). */
const HEAVY_FLYERS = new Set(['griffin-5', 'griffin-6', 'griffin-7', 'corax-1', 'corax-2', 'royal-lion-1', 'royal-lion-2']);

const MOVE_TYPES = ['flying', 'mounted', 'melee', 'ranged'];

/** What a troop costs and how it is sized. Null for a troop this calculator doesn't know. */
export function stackUnit(troopId) {
  const def = troopById(troopId);
  if (!def) return null;
  const move = MOVE_TYPES.find((m) => def.tags.includes(m)) ?? null;
  const base = { id: def.id, def, str: def.str, hp: def.hp, move, tier: def.tier ?? 9, leadership: 0, authority: 0, dominance: 0, revivalGold: 0, epicStrengthPct: 0 };
  if (def.group === 'guardsmen' || def.group === 'specialists') {
    const leadership = HEAVY_FLYERS.has(def.id) ? 20 : move === 'mounted' ? 2 : 1;
    return { ...base, kind: 'troop', leadership, revivalGold: 4 * leadership };
  }
  if (def.group === 'siege') return { ...base, kind: 'siege', leadership: 10, revivalGold: 40 };
  if (def.group === 'monsters') {
    const dominance = MONSTER_DOMINANCE[def.id];
    return dominance ? { ...base, kind: 'monster', dominance, revivalGold: 16 * dominance } : null;
  }
  // Mercenaries carry their exchange tier, authority, revival gold and epic
  // bonus in TROOPS (citadel-sim.js).
  if (def.group !== 'mercenaries' || !def.mercTier || !def.authority) return null;
  return {
    ...base,
    kind: def.siegeEngine ? 'siege' : 'mercenary',
    tier: def.mercTier,
    authority: def.authority,
    revivalGold: def.revivalGold,
    epicStrengthPct: def.epicPct ?? 0,
  };
}

/** Every troop the calculator can size, in TROOPS order (the picker's list). */
export const STACK_TROOPS = TROOPS.filter((x) => stackUnit(x.id));

/**
 * Units per same-health stack for this troop's type. Vultures (flying
 * specialists below tier 8) have foot-soldier health, so they size as melee.
 */
function typeMultiplier(u) {
  if (u.def.group === 'specialists' && u.move === 'flying' && u.tier < 8) return TYPE_MULTIPLIERS.melee;
  return TYPE_MULTIPLIERS[u.move] ?? 1;
}

/**
 * The base stack's troop: the guardsman or specialist with the highest unit
 * health. Ties go to guardsmen, then ranged → melee → mounted → flying — the
 * order Kaiculator lists them in, so the same troop is picked.
 */
function pickReference(units) {
  const order = (u) => [u.def.group === 'guardsmen' ? 0 : 1, ['ranged', 'melee', 'mounted', 'flying'].indexOf(u.move)];
  let best = null;
  for (const u of units) {
    if (u.kind !== 'troop') continue;
    if (!best || u.hp > best.hp) best = u;
    else if (u.hp === best.hp) {
      const [a, b] = [order(u), order(best)];
      if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) best = u;
    }
  }
  return best;
}

/** Health bonus as a fraction; anything at or below −100% can't be a real card and counts as none. */
const bonusOf = (u) => (Number.isFinite(u.healthPct) && u.healthPct > -100 ? u.healthPct / 100 : 0);
/** One unit's health with its bonus. */
const unitHealth = (u) => u.hp * (1 + bonusOf(u));
/** What a count is multiplied by for the bonus. The arithmetic below follows
 *  Kaiculator's exactly (multiply by this, add the bonus as base ÷ it − base),
 *  so a count on a rounding edge comes out the same. */
const healthMult = (u) => 1 / (1 + bonusOf(u));
/** A stack's health with its bonus, computed as Kaiculator does. */
const withBonus = (u, count) => {
  const base = count * u.hp;
  return base + (base / healthMult(u) - base);
};

/**
 * Guardsman/specialist counts for a raw size `r` of the base stack (before its
 * health bonus). Lower tiers grow by tierMultiplier per tier; same-tier stacks
 * match in health; health bonuses divide the count; specialists then top the
 * guardsmen of their tier by SPECIALIST_MARGIN.
 */
function troopCounts(units, ref, r, opts) {
  const counts = new Map();
  for (const u of units) {
    if (u.kind !== 'troop') continue;
    const planned = opts.tierMultiplier ** (ref.tier - u.tier) * (typeMultiplier(u) / typeMultiplier(ref)) * r;
    counts.set(u, Math.max(Math.floor(planned * healthMult(u)), 1));
  }
  if (opts.specialistsFirst) {
    const tiers = new Set([...counts.keys()].map((u) => u.tier));
    for (const tier of tiers) {
      const same = [...counts.keys()].filter((u) => u.tier === tier);
      const guards = same.filter((u) => u.def.group === 'guardsmen');
      const specs = same.filter((u) => u.def.group === 'specialists');
      if (!guards.length || !specs.length) continue;
      const top = Math.max(...guards.map((u) => counts.get(u) * unitHealth(u))) * Math.pow(1 + SPECIALIST_MARGIN, 1);
      for (const u of specs) counts.set(u, Math.max(counts.get(u), Math.floor(top / unitHealth(u)) + 1));
    }
  }
  return counts;
}

/**
 * The raw size whose base stack comes out closest to the wanted base count
 * (Kaiculator's search: the smallest size that reaches it, or the one below
 * when that lands closer).
 */
function sizeForBase(units, ref, want, opts) {
  const target = Math.max(1, Math.trunc(want));
  const f = (r) => troopCounts(units, ref, r, opts).get(ref);
  let lo = 1;
  let hi = target;
  while (f(hi) < target && hi < Number.MAX_SAFE_INTEGER / 2) hi *= 2;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (f(mid) < target) lo = mid + 1;
    else hi = mid;
  }
  const below = Math.max(1, lo - 1);
  return Math.abs(f(lo) - target) < Math.abs(f(below) - target) ? lo : below;
}

/**
 * Processing order (Kaiculator's): strength ÷ health, then strength, then tier,
 * all ascending. Monsters and mercenaries are sized down this list, so the
 * weakest gets the biggest stack and the strongest the smallest. With
 * `epicHunterLast`, Epic Monster Hunters count their epic bonus here and move
 * to the end: their stack is the smallest, the last to fall.
 */
function processingOrder(units, epicHunterLast) {
  const eff = (u) => u.str * (1 + (epicHunterLast ? u.epicStrengthPct / 100 : 0));
  const pos = new Map(TROOPS.map((x, i) => [x.id, i]));
  return [...units].sort((a, b) => Math.round(eff(a) / a.hp) - Math.round(eff(b) / b.hp)
    || eff(a) - eff(b) || a.tier - b.tier || b.hp - a.hp || pos.get(a.id) - pos.get(b.id));
}

/**
 * One stack of the plan. lossFrom/lossTo/lossOf and gap are filled in once
 * every stack is sized.
 * @typedef {object} Squad
 * @property {string} troopId
 * @property {'troop'|'monster'|'mercenary'|'siege'} kind
 * @property {number} count
 * @property {number} unitHealth  one unit, before its bonus
 * @property {number} healthPct  the bonus used (siege engines: always 0)
 * @property {number} stackHealth  the whole stack, bonus included
 * @property {number} leadership
 * @property {number} authority
 * @property {number} dominance
 * @property {number} revivalGold  before the Temple's reduction
 * @property {number} lossFrom  1 = falls first; stacks with equal health share a range
 * @property {number} lossTo
 * @property {number} lossOf
 * @property {{health: number, pct: number, units: number|null}|null} gap  less health than the group before
 */
/**
 * @typedef {object} StackPlan
 * @property {true} ok
 * @property {string} baseTroopId
 * @property {number} baseWanted
 * @property {number} baseCount
 * @property {Squad[]} squads  in loss order
 * @property {{leadership: number, authority: number, dominance: number}} used
 * @property {{leadership: number, authority: number, dominance: number}} limits
 * @property {{leadership: boolean, authority: boolean, dominance: boolean}} over
 * @property {{mode: string, cut: boolean, dropped: number, before: number, after: number}|null} monsterFit
 * @property {number} revivalGold
 * @property {number} templeReduction
 */
/** @typedef {{ok: false, reason: 'empty'|'no-base'}} NoPlan */

/** @returns {Squad} */
function squadOf(u, count) {
  return {
    troopId: u.id,
    kind: u.kind,
    count,
    unitHealth: u.hp,
    healthPct: u.kind === 'siege' ? 0 : bonusOf(u) * 100,
    stackHealth: u.kind === 'siege' ? count * u.hp : withBonus(u, count),
    leadership: count * u.leadership,
    authority: count * u.authority,
    dominance: count * u.dominance,
    /** Kaiculator's estimate: 90% of the stack revived, before the Temple's reduction. */
    revivalGold: Math.floor(REVIVAL_SHARE * count) * u.revivalGold,
  };
}

/** Fit monsters into a dominance limit: drop whole stacks, or scale them all. */
function fitMonsters(squads, budget, mode) {
  const cost = (s) => s.dominance;
  if (mode === 'whole-stacks') {
    let left = budget;
    return squads.map((s) => {
      if (cost(s) > left) return 0;
      left -= cost(s);
      return s.count;
    });
  }
  const total = squads.reduce((a, s) => a + cost(s), 0);
  if (total <= budget) return squads.map((s) => s.count);
  const share = budget / total;
  return squads.map((s) => Math.floor(s.count * share));
}

/**
 * When monsters were cut, the mercenaries may grow back toward a full-size
 * stack (97% of the base) — as far as the authority left allows, all by the
 * same share of the way.
 */
function growMercenaries(squads, authority, refHealth) {
  const per = (s) => (s.count > 0 ? s.authority / s.count : 0);
  const now = squads.reduce((a, s) => a + s.authority, 0);
  const max = squads.map((s) => {
    return Math.max(s.count, Math.floor((refHealth * HEALTH_RISK_TOLERANCE) / (s.stackHealth / s.count)));
  });
  const full = squads.reduce((a, s, i) => a + max[i] * per(s), 0);
  if (now <= 0 || full <= now || authority <= now) return squads.map((s) => s.count);
  const share = Math.min(1, (authority - now) / (full - now));
  return squads.map((s, i) => Math.max(s.count, Math.floor(s.count + (max[i] - s.count) * share)));
}

function resize(s, u, count) {
  Object.assign(s, squadOf(u, count));
}

/**
 * Size every stack.
 *
 * @param {object} p
 * @param {{troopId: string, healthPct?: number|null}[]} p.rows  the troops picked, with their health bonus (%)
 * @param {number} p.baseCount  wanted size of the base stack
 * @param {number} [p.tierMultiplier]  growth per tier down (1.9)
 * @param {number} [p.siegeMultiplier]  scales the siege decoys (1.0)
 * @param {{leadership?: number, authority?: number, dominance?: number}} [p.limits]  0/missing = no limit
 * @param {'reference'|'whole-stacks'|'scaled'} [p.monsterMode]  what to do when monsters exceed dominance
 * @param {number} [p.templeLevel]  1-45, divides the revival cost
 * @param {boolean} [p.specialistsFirst]  specialists fall before guardsmen of their tier (default on)
 * @param {boolean} [p.epicHunterLast]  Epic Monster Hunters keep the smallest stack
 * @returns {StackPlan | NoPlan}
 */
export function planStacks(p) {
  const opts = {
    tierMultiplier: Number.isFinite(p.tierMultiplier) && p.tierMultiplier > 0 ? p.tierMultiplier : DEFAULT_TIER_MULTIPLIER,
    siegeMultiplier: Number.isFinite(p.siegeMultiplier) ? Math.max(0, p.siegeMultiplier) : DEFAULT_SIEGE_MULTIPLIER,
    specialistsFirst: p.specialistsFirst !== false,
  };
  const limits = {
    leadership: Math.max(0, Math.trunc(p.limits?.leadership ?? 0) || 0),
    authority: Math.max(0, Math.trunc(p.limits?.authority ?? 0) || 0),
    dominance: Math.max(0, Math.trunc(p.limits?.dominance ?? 0) || 0),
  };
  const monsterMode = MONSTER_MODES.includes(p.monsterMode) ? p.monsterMode : 'reference';
  const templeLevel = Math.min(TEMPLE_REVIVAL_REDUCTION.length, Math.max(1, Math.trunc(p.templeLevel ?? 1) || 1));

  const seen = new Set();
  const units = [];
  for (const row of p.rows ?? []) {
    const u = stackUnit(row?.troopId);
    if (!u || seen.has(u.id)) continue;
    seen.add(u.id);
    units.push({ ...u, healthPct: Number.isFinite(row.healthPct) ? row.healthPct : null });
  }
  const ref = pickReference(units);
  if (!ref) return { ok: false, reason: units.length ? 'no-base' : 'empty' };

  const wanted = Math.max(1, Math.trunc(p.baseCount) || 1);
  const r = sizeForBase(units, ref, wanted, opts);
  const counts = troopCounts(units, ref, r, opts);
  const refHealth = ref.hp * counts.get(ref) * (1 + bonusOf(ref));

  // Trained troops from the size; monsters and mercenaries step down from 97%
  // of the base stack, each capped by the one sized before it.
  const squads = [];
  let cap = refHealth * HEALTH_RISK_TOLERANCE;
  for (const u of processingOrder(units, p.epicHunterLast === true)) {
    if (u.kind === 'troop') {
      squads.push(squadOf(u, counts.get(u)));
    } else if (u.kind === 'monster' || u.kind === 'mercenary') {
      const n = Math.floor(Math.floor(cap / u.hp) * healthMult(u));
      if (n > 0) {
        squads.push(squadOf(u, n));
        cap = withBonus(u, n);
      }
    }
  }

  // Over the dominance limit: drop whole monster stacks or scale them all,
  // then let the mercenaries take up what the cut left.
  let monsterFit = null;
  const monsters = squads.filter((s) => s.kind === 'monster');
  if (monsterMode !== 'reference' && limits.dominance > 0 && monsters.length) {
    const before = monsters.reduce((a, s) => a + s.dominance, 0);
    const fitted = fitMonsters(monsters, limits.dominance, monsterMode);
    const cut = monsters.some((s, i) => fitted[i] < s.count);
    let dropped = 0;
    monsters.forEach((s, i) => {
      if (fitted[i] === 0) dropped += 1;
      resize(s, units.find((x) => x.id === s.troopId), fitted[i]);
    });
    if (cut && limits.authority > 0) {
      const mercs = squads.filter((s) => s.kind === 'mercenary');
      const grown = growMercenaries(mercs, limits.authority, refHealth);
      mercs.forEach((s, i) => resize(s, units.find((x) => x.id === s.troopId), grown[i]));
    }
    const after = monsters.reduce((a, s) => a + s.dominance, 0);
    monsterFit = { mode: monsterMode, cut, dropped, before, after };
    for (let i = squads.length - 1; i >= 0; i--) if (squads[i].count <= 0) squads.splice(i, 1);
  }

  // Siege decoys: more health than the biggest stack, by 1.15 plus a step for
  // every tier between the base and the best engineer, times the multiplier.
  const siege = units.filter((u) => u.kind === 'siege').sort((a, b) => b.tier - a.tier);
  if (siege.length && squads.length) {
    const engineers = siege.filter((u) => u.def.group === 'siege');
    const topTier = (engineers[0] ?? siege[0]).tier;
    const scale = (1.15 + ((ref.tier - topTier) * ref.tier / 9) * 0.25) * opts.siegeMultiplier;
    const floor = Math.max(...squads.map((s) => s.stackHealth));
    for (const u of siege) {
      const n = Math.ceil((floor * scale) / u.hp);
      if (n > 0) squads.push(squadOf(u, n));
    }
  }

  // Loss order: most health first. Stacks with the same health fall as a group.
  const byHealth = [...squads].sort((a, b) => b.stackHealth - a.stackHealth);
  let lowest = Infinity;
  let at = 0;
  byHealth.forEach((s, i) => {
    if (s.stackHealth < lowest) {
      lowest = s.stackHealth;
      at = i + 1;
    }
    s.lossFrom = at;
  });
  const groups = [];
  for (const s of byHealth) {
    const g = groups[groups.length - 1];
    if (g && g.from === s.lossFrom) g.squads.push(s);
    else groups.push({ from: s.lossFrom, squads: [s] });
  }
  groups.forEach((g, k) => {
    const prev = k > 0 ? groups[k - 1].squads[0].stackHealth : null;
    for (const s of g.squads) {
      s.lossTo = g.from + g.squads.length - 1;
      s.lossOf = byHealth.length;
      if (prev === null) {
        s.gap = null;
      } else {
        const gap = Math.max(0, prev - s.stackHealth);
        const per = s.count > 0 ? s.stackHealth / s.count : 0;
        s.gap = { health: gap, pct: prev > 0 ? (gap / prev) * 100 : 0, units: per > 0 ? Math.ceil(gap / per) : null };
      }
    }
  });

  const sum = (k) => byHealth.reduce((a, s) => a + s[k], 0);
  const reduction = TEMPLE_REVIVAL_REDUCTION[templeLevel - 1];
  const used = { leadership: sum('leadership'), authority: sum('authority'), dominance: sum('dominance') };
  const base = byHealth.find((s) => s.troopId === ref.id);
  return {
    ok: true,
    baseTroopId: ref.id,
    baseWanted: wanted,
    baseCount: base?.count ?? 0,
    squads: byHealth,
    used,
    limits,
    over: {
      leadership: limits.leadership > 0 && used.leadership > limits.leadership,
      authority: limits.authority > 0 && used.authority > limits.authority,
      dominance: limits.dominance > 0 && used.dominance > limits.dominance,
    },
    monsterFit,
    revivalGold: sum('revivalGold') / reduction,
    templeReduction: reduction,
  };
}

/**
 * The largest base count whose army fits the leadership (Kaiculator's "Find it
 * for me"): estimate from a base of 100, then step to the exact edge. Null when
 * there is nothing to size or no leadership to fit.
 */
export function fitBaseToLeadership(p, leadership) {
  const L = Math.trunc(leadership);
  if (!(L > 0)) return null;
  const at = (n) => planStacks({ ...p, baseCount: n });
  const probe = at(100);
  if (!probe.ok || probe.used.leadership <= 0) return null;
  let n = Math.max(1, Math.floor(100 * (L / probe.used.leadership)));
  let cur = at(n);
  while (n > 1 && cur.used.leadership > L) cur = at(--n);
  // Guard against a runaway: the step-up below can only ever add a little.
  for (let k = 0; k < 100_000 && at(n + 1).used.leadership <= L; k++) n += 1;
  return n;
}
