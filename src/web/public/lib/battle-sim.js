// The battle engine behind Tools → Citadel and Tools → Monsters.
//
// The rules were measured from real battle reports (docs/citadel-simulator.md,
// docs/monster-simulator.md): Citadel's replays pin them strike for strike, and
// a replay of 374,502 strikes from shared reports — epics, bosses, the Tin Man,
// Common, Rare and Heroic squads, group attacks — picks the same striker every
// time, the same target 99.5% of the time and the same damage 99.8%.
//
//  - SIEGE (only while walls stand): siege engines strike first, then the
//    walls, then everything else hits the walls. Rounds repeat until the walls
//    are down. Wounds taken from the walls heal before the battle; units the
//    walls kill stay dead.
//  - BATTLE in rounds. Whoever opens round 1 is a coin flip; after that the
//    side that did NOT act last opens the next. Within a round the sides
//    alternate, each using its strongest stack that has not acted yet (units ×
//    strength × (1 + bonus); features play no part). When one side runs out,
//    the other's remaining stacks act back to back.
//  - TARGETING: a stack hits the enemy it would deal the most damage to,
//    features included and capped at what the target has left. Ties go to the
//    target that would hit back hardest.
//  - DAMAGE: units × strength × (1 + bonus + matching features) × the feature's
//    multiplier (×20 for a siege engine on walls). A stack's health is a pool:
//    units alive = ceil(pool ÷ unit health). Wounds stay all battle.
//  - LUCK (double damage, a second squad, a blocked strike taking 67%) is not
//    simulated; `luck` replays it for the tests.
//
// A unit definition (`def`): { id, str, hp, tags, vs, siegeEngine? } — tags a
// list of lower-case words; vs either { tag: percent } (Citadel's hand-entered
// troops: a siege engine's "fortification" feature carries the ×20) or the
// game's own [[tags], percent, multiplier] (battle-data.json). Walls are a
// unit tagged "fortification" or "citywalls".
//
// Plain ESM, no DOM access.

const MAX_SIEGE_ROUNDS = 40;
/** A safety stop only. Every shared report ended with a side gone (Nov 2026,
 *  up to 100 rounds), and players have seen fights of thousands of rounds: the
 *  game sets no limit we know of. A round in which nothing is damaged stops the
 *  fight earlier (it could never end). */
const MAX_BATTLE_ROUNDS = 10000;

/** A health bonus nobody entered: the stack counts as untouchable. That can only
 *  make it MORE attractive as a target (damage is capped at what a target has
 *  left), so a stack that still isn't hit would not be hit with its real health
 *  either; one that IS hit is reported (`healthUnknown`) for the page to ask. */
export const UNKNOWN_HEALTH_FACTOR = 1e9;

const WALL_TAGS = ['fortification', 'citywalls'];
/** Siege engines deal this much more to walls (Citadel's reports; the game data's 2000). */
const SIEGE_VS_WALLS = 20;
/** A blocked strike deals this share (45 monster strikes on monster- or beast-type troops, Nov 2026). */
export const BLOCKED = 0.67;

const norm = new WeakMap();
/** A def's features and flags in one shape: { tags: Set, vs: [{ on: [tags], v, mult }], wall, siege }. */
function shape(def) {
  let s = norm.get(def);
  if (s) return s;
  const tags = new Set(def.tags || []);
  const siege = !!def.siegeEngine || (def.siegeEngine === undefined && tags.has('siege'));
  const vs = Array.isArray(def.vs)
    ? def.vs.map(([on, pct, mult]) => ({ on, v: (Number(pct) || 0) / 100, mult: Number(mult) || 1 }))
    : Object.entries(def.vs || {}).map(([tag, pct]) => ({
      on: [tag],
      v: pct / 100,
      mult: siege && WALL_TAGS.includes(tag) ? SIEGE_VS_WALLS : 1,
    }));
  s = { tags, vs, wall: WALL_TAGS.some((t) => tags.has(t)), siege, uid: nextShapeId++, fx: null };
  norm.set(def, s);
  return s;
}
let nextShapeId = 0;

/** Whether a def is walls. */
export const isWall = (def) => !!def && shape(def).wall;
/** Whether a def is a siege engine (Citadel's flag, or the game's "siege" tag). */
export const isSiegeEngine = (def) => !!def && shape(def).siege;

export function makeStack(side, def, count, strengthPct = 0, healthPct = 0, index = -1) {
  const unknown = healthPct === null;
  const uhp = def.hp * (unknown ? UNKNOWN_HEALTH_FACTOR : 1 + healthPct / 100);
  const sh = shape(def);
  return {
    side, def, index, count, healthUnknown: unknown,
    s: strengthPct / 100,
    tags: sh.tags,
    vs: sh.vs,
    sh,
    siegeEngine: sh.siege,
    wall: sh.wall,
    uhp,
    pool: count * uhp,
    taken: 0,
    acted: 0,
    siegeLost: 0,
    siegeTaken: 0,
  };
}

export function alive(st) {
  return st.pool <= 1e-6 ? 0 : Math.ceil(st.pool / st.uhp - 1e-9);
}

/** Turn order: units × strength × (1 + bonus). Features play no part. */
export function strength(st) {
  return alive(st) * st.def.str * (1 + st.s);
}

/** The features of one def that match another's tags, in the def's order: { vals, mult }.
 *  Cached per pair of shapes — the search plays millions of strikes between the same few. */
const featureCache = new WeakMap();
const NO_FEATURES = { vals: [], mult: 1 };
function featuresOn(a, t) {
  if (!a.vs.length) return NO_FEATURES;
  // Shapes (one per def) carry a number: an array lookup. Hand-made stacks fall back to a WeakMap.
  let f;
  if (a.uid !== undefined && t.uid !== undefined) {
    if (!a.fx) a.fx = [];
    f = a.fx[t.uid];
    if (f) return f;
  } else {
    let byTarget = featureCache.get(a);
    if (!byTarget) featureCache.set(a, (byTarget = new WeakMap()));
    f = byTarget.get(t);
    if (f) return f;
  }
  const vals = [];
  let mult = 1;
  for (const x of a.vs) {
    if (!x.on.some((tag) => t.tags.has(tag))) continue;
    vals.push(x.v);
    mult *= x.mult;
  }
  f = { vals, mult };
  if (a.uid !== undefined && t.uid !== undefined) a.fx[t.uid] = f;
  else featureCache.get(a).set(t, f);
  return f;
}

export function damageVs(actor, target) {
  return damageWith(actor, alive(actor), target);
}

/** damageVs with the actor's units already counted (`units` = alive(actor)): the same sum in the same order. */
function damageWith(actor, units, target) {
  // Stacks from makeStack carry their def's shape; a hand-made one is shaped from its own tags and vs.
  const f = featuresOn(actor.sh ?? { vs: actor.vs, tags: actor.tags }, target.sh ?? { vs: target.vs, tags: target.tags });
  let bonus = actor.s;
  for (let i = 0; i < f.vals.length; i++) bonus += f.vals[i];
  return units * actor.def.str * (1 + bonus) * f.mult;
}

/** Most damage dealt (capped at what is left); ties → whoever hits back hardest. */
export function pickTarget(actor, enemies, exclude = null) {
  let best = null;
  let k0 = 0;
  // The tie keys (how hard it hits back, its strength) are worked out only when a tie needs them.
  let k1 = null;
  let k2 = null;
  const units = alive(actor);
  for (const t of enemies) {
    if (t === exclude || alive(t) === 0) continue;
    const a = Math.round(Math.min(damageWith(actor, units, t), t.pool));
    if (!best) { best = t; k0 = a; k1 = null; k2 = null; continue; }
    if (a !== k0) {
      if (!(a > k0)) continue;
      best = t; k0 = a; k1 = null; k2 = null;
      continue;
    }
    if (k1 === null) k1 = Math.round(damageVs(best, actor));
    const b = Math.round(damageVs(t, actor));
    if (b !== k1) {
      if (!(b > k1)) continue;
      best = t; k1 = b; k2 = null;
      continue;
    }
    if (k2 === null) k2 = Math.round(strength(best));
    const c = Math.round(strength(t));
    if (!(c > k2)) continue;
    best = t; k2 = c;
  }
  return best;
}

/** What a strike takes: never more than the target has. (The game logs whole points; the engine keeps the fraction.) */
function dealt(damage, pool) {
  return Math.min(damage, pool);
}

/** The strongest stack with units that has not acted in this round (`round`: the
 *  round's stamp; a stack that acts takes it as `acted`). Ties: the first listed. */
function strongestUnacted(stacks, round) {
  let best = null;
  let top = 0;
  for (const s of stacks) {
    if (s.acted === round) continue;
    const units = alive(s);
    if (units === 0) continue;
    // strength(s), its units counted once.
    const v = units * s.def.str * (1 + s.s);
    if (!best || v > top) {
      best = s;
      top = v;
    }
  }
  return best;
}

/** Whether any stack of the list has units left. */
function anyAlive(list) {
  for (const s of list) if (alive(s) > 0) return true;
  return false;
}

const NO_LUCK = Object.freeze({});

/**
 * One battle.
 * @param {object} p
 * @param {{def: object, count: number, strengthPct?: number, healthPct?: number|null, index?: number}[]} p.mine
 *        rows with no units are left out; healthPct null = not entered (UNKNOWN_HEALTH_FACTOR)
 * @param {{def: object, count: number}[]} p.theirs  the enemy's army, walls included
 * @param {'you'|string} p.opener  who opens the first battle round ('you' or the enemy)
 * @param {string} [p.enemySide]  the enemy's side label in the result ('citadel' for Citadel)
 * @param {Record<number,{double?:boolean,second?:boolean,blocked?:boolean}>} [p.luck]  1-based action number → luck (tests)
 * @param {boolean} [p.keepStrikes]  false: no strike list (the count search plays thousands of battles)
 * @param {(index: number, units: number) => boolean} [p.onLoss]  told each time one of your stacks loses
 *        units (its row index, how many); returning true stops the battle there (`aborted`) — the count
 *        search stops a battle that can no longer beat the best army it has
 */
export function simulateArmies({ mine: rows, theirs: enemy, opener = 'enemy', enemySide = 'enemy', luck = {}, keepStrikes = true, onLoss = null }) {
  const mine = [];
  rows.forEach((row, i) => {
    const n = Math.max(0, Math.floor(Number(row.count) || 0));
    const health = row.healthPct === null || row.healthPct === undefined || row.healthPct === '' ? null : Number(row.healthPct) || 0;
    if (row.def && n > 0) mine.push(makeStack('you', row.def, n, Number(row.strengthPct) || 0, health, row.index ?? i));
  });
  const all = enemy.filter((e) => e.def && e.count > 0).map((e, index) => makeStack(enemySide, e.def, e.count, 0, 0, index));
  const walls = all.find((s) => s.wall) ?? null;
  const theirs = all.filter((s) => s !== walls);
  // Each round's stamp; a stack's `acted` holds the stamp of the last round it acted in.
  let stamp = 0;

  const strikes = [];
  let action = 0;
  let roundDamage = 0;
  let dealtByYou = 0;
  let aborted = false;
  const record = (actor, roll, phase, round, t, dealt, second) => {
    const before = alive(t);
    t.pool -= dealt;
    t.taken += dealt;
    roundDamage += dealt;
    if (actor.side === 'you') dealtByYou += dealt;
    else if (onLoss && before > alive(t) && onLoss(t.index, before - alive(t))) aborted = true;
    if (!keepStrikes) return;
    const after = alive(t);
    strikes.push({
      phase, round, side: actor.side, actor: actor.def.id, target: t.def.id, damage: dealt,
      double: !!roll.double, second, killed: after === 0,
      // Units the hit removed and what the target has left — the "result" column of the strike list.
      unitsLost: before - after, unitsLeft: after,
    });
  };
  const hit = (actor, target, phase, round) => {
    action += 1;
    const roll = luck[action] || NO_LUCK;
    const mult = (roll.double ? 2 : 1) * (roll.blocked ? BLOCKED : 1);
    record(actor, roll, phase, round, target, dealt(damageVs(actor, target) * mult, target.pool), false);
    if (roll.second) {
      const pool = actor.side === 'you' ? (phase === 'siege' ? [] : theirs) : mine;
      const t2 = pickTarget(actor, pool, target);
      if (t2) record(actor, roll, phase, round, t2, dealt(damageVs(actor, t2) * mult, t2.pool), true);
    }
  };
  const living = (list) => list.filter((s) => alive(s) > 0);

  // Siege
  let wallsDown = !walls;
  let siegeRounds = 0;
  if (walls && mine.length) {
    const engines = mine.filter((x) => x.siegeEngine);
    const others = mine.filter((x) => !x.siegeEngine);
    outer: for (let r = 1; r <= MAX_SIEGE_ROUNDS; r++) {
      siegeRounds = r;
      const acted = ++stamp;
      for (let s; (s = strongestUnacted(engines, acted));) {
        hit(s, walls, 'siege', r);
        s.acted = acted;
        if (alive(walls) === 0) { wallsDown = true; break outer; }
      }
      // pickTarget passes over stacks with no units left.
      const target = pickTarget(walls, mine);
      if (target) hit(walls, target, 'siege', r);
      if (aborted || !anyAlive(mine)) break;
      for (let s; (s = strongestUnacted(others, acted));) {
        hit(s, walls, 'siege', r);
        s.acted = acted;
        if (alive(walls) === 0) { wallsDown = true; break outer; }
      }
    }
  }
  // What the walls did, kept on each stack; wounds from the walls heal before the battle, the dead stay dead.
  for (const s of mine) {
    s.siegeLost = s.count - alive(s);
    s.siegeTaken = s.taken;
    s.pool = alive(s) * s.uhp;
  }

  // Battle
  let won = false;
  let reason = null;
  let rounds = 0;
  if (!mine.length) reason = 'empty';
  else if (aborted) reason = 'aborted';
  else if (!wallsDown) reason = living(mine).length ? 'walls' : 'destroyed';
  else {
    let first = opener === 'you' ? 'you' : enemySide;
    const sides = { you: mine, [enemySide]: theirs };
    battle: for (let r = 1; r <= MAX_BATTLE_ROUNDS; r++) {
      rounds = r;
      const acted = ++stamp;
      let side = first;
      let last = null;
      roundDamage = 0;
      for (;;) {
        const other = side === 'you' ? enemySide : 'you';
        const actor = strongestUnacted(sides[side], acted);
        if (!actor) {
          if (!strongestUnacted(sides[other], acted)) break;
          side = other;
          continue;
        }
        const target = pickTarget(actor, sides[other]);
        if (!target) break;
        hit(actor, target, 'battle', r);
        actor.acted = acted;
        last = side;
        if (aborted) { reason = 'aborted'; break battle; }
        if (!anyAlive(theirs)) { won = true; break battle; }
        if (!anyAlive(mine)) { reason = 'destroyed'; break battle; }
        side = other;
      }
      first = last === 'you' ? enemySide : 'you';
      // Nobody damaged anything all round: nothing will change, ever.
      if (roundDamage <= 0) break;
    }
    if (!won && !reason) reason = 'rounds';
  }

  return {
    opener: opener === 'you' ? 'you' : enemySide,
    won,
    reason,
    wallsDown,
    siegeRounds,
    rounds,
    strikes,
    /** How many strikes were played (the count search's measure of work). */
    actions: action,
    /** Stopped by onLoss before the end. */
    aborted,
    /** All the damage your stacks dealt, walls included (what an epic's points come from). */
    dealt: dealtByYou,
    army: mine.map((s) => ({
      index: s.index,
      troopId: s.def.id,
      count: s.count,
      alive: alive(s),
      lost: s.count - alive(s),
      lostInSiege: s.siegeLost,
      siegeDamage: s.siegeTaken,
      battleDamage: s.taken - s.siegeTaken,
      unitHealth: s.uhp,
      healthUnknown: s.healthUnknown,
      wasHit: s.taken > 0,
    })),
    defenders: theirs.map((s) => ({ unitId: s.def.id, count: s.count, alive: alive(s) })),
  };
}

/** Both coin-flip outcomes for the same armies: { you, [enemySide] }. */
export function simulateBothArmies(params) {
  const enemySide = params.enemySide ?? 'enemy';
  return { you: simulateArmies({ ...params, opener: 'you' }), [enemySide]: simulateArmies({ ...params, opener: enemySide }) };
}

// ─── Automatic counts: search with the simulator itself ───────────

/**
 * game01master's sizing made general, as starting counts for the search
 * (docs/monster-simulator.md). The enemy's stacks strongest first (units ×
 * strength); each goes to an unused troop that can kill it whole in one strike
 * within what the player has, the cheapest such (units × what one lost unit
 * costs) or the one needing the fewest units, sized to do exactly that; the
 * first of them also gets enough units to live through the strongest enemy
 * strike on it (game01master's first striker taking the dragon's opening hit),
 * or not. One siege engine sized to bring the walls down in one strike. Four
 * starts; the search refines them.
 *
 * @param rows      optimizeArmy's rows (def, strengthPct, healthPct, cap, weight)
 * @param targets   [{ def, n, wall }]
 * @param perUnit   (rowIndex, target) → damage of one unit of the row on that stack
 */
export function roleStarts(rows, targets, perUnit, enemySide = 'enemy') {
  const enemies = targets.filter((x) => !x.wall).sort((a, b) => b.n * b.def.str - a.n * a.def.str);
  const walls = targets.find((x) => x.wall) ?? null;
  const cost = (i) => rows[i].weight ?? rows[i].def.hp;
  const cap = (i) => (Number.isFinite(rows[i].cap) ? rows[i].cap : Infinity);
  const unitHp = (i) => rows[i].def.hp * (1 + (Number(rows[i].healthPct) || 0) / 100);
  // The hardest strike any enemy stack, whole, lands on one stack of this row.
  const opening = (i) => {
    const me = makeStack('you', rows[i].def, 1, 0, 0);
    return enemies.reduce((m, x) => Math.max(m, damageVs(makeStack(enemySide, x.def, x.n), me)), 0);
  };
  const out = [];
  for (const pick of ['cost', 'units']) {
    for (const absorb of [true, false]) {
      const counts = rows.map(() => 0);
      const used = new Set();
      if (walls) {
        let best = -1;
        let bestN = 0;
        rows.forEach((r, i) => {
          if (!isSiegeEngine(r.def)) return;
          const per = perUnit(i, walls);
          const n = per > 0 ? Math.ceil((walls.n * walls.def.hp) / per) : Infinity;
          if (n <= cap(i) && (best < 0 || n * cost(i) < bestN * cost(best))) { best = i; bestN = n; }
        });
        if (best >= 0) { counts[best] = bestN; used.add(best); }
      }
      let first = true;
      for (const x of enemies) {
        let best = -1;
        let bestScore = Infinity;
        let bestN = 0;
        rows.forEach((r, i) => {
          if (used.has(i) || isSiegeEngine(r.def)) return;
          const per = perUnit(i, x);
          if (!(per > 0)) return;
          let n = Math.ceil((x.n * x.def.hp) / per);
          if (first && absorb) n += Math.ceil(opening(i) / unitHp(i));
          if (n > cap(i)) return;
          const score = pick === 'cost' ? n * cost(i) : n;
          if (score < bestScore) { best = i; bestScore = score; bestN = n; }
        });
        if (best < 0) continue;
        counts[best] = bestN;
        used.add(best);
        first = false;
      }
      out.push(counts);
    }
  }
  return out;
}

/** Automatic counts must still win with every bonus this much lower. */
export const SAFETY = 0.03;

/**
 * Expected losses of a setup (the mean of both coin flips), split into the
 * protected rows (monsters, mercenaries: never traded for cheaper losses) and
 * the rest. Each lost unit is worth its base health, so one Wyvern (2.07M)
 * weighs about eleven Corax I (183.6k) and losing cheap low-tier units is cheap.
 */
function lossValue(results, rows, worstCase = false) {
  let rest = 0;
  let prot = 0;
  let protWorst = 0;
  for (const res of results) {
    let p = 0;
    for (const s of res.army) {
      const row = rows[s.index];
      const w = s.lost * (row.weight ?? row.def.hp);
      if (row.protected) p += w;
      else rest += w;
    }
    prot += p;
    protWorst = Math.max(protWorst, p);
  }
  return { prot: worstCase ? protWorst : prot / results.length, rest: rest / results.length };
}

/**
 * Counts that win in BOTH coin-flip outcomes with the fewest expected losses,
 * for the troop types and bonuses given, against any army. A local search over
 * each row's count, trying the breakpoints where a stack's damage crosses an
 * enemy stack's health — the counts where its target can change — plus plain
 * nudges. Deterministic. Rows whose health is unknown are searched at 0%
 * health (pessimistic); the page asks for it if that stack ends up being hit.
 *
 * Every candidate must also win with all bonuses SAFETY lower (a misread card,
 * a captain left behind), and its losses are averaged over both — so the
 * search can't settle on a count that only works to the last unit.
 *
 * Win first; then the fewest protected losses; then the fewest other losses;
 * then the smaller army (less strength sent). A row's count never goes over
 * its `cap` (what the player has); rows at 0 are left at home.
 *
 * A row's `weight` is what one lost unit costs (Tools → Monsters: its revival
 * gold), else its base health. With `worstCase`, protected losses are judged
 * on the worse coin flip, not the mean: "none if I strike first, 400
 * mercenaries if they do" is not an army to send (the user, Nov 28 2026).
 *
 * With `roles`, the search also starts from game01master's idea made general
 * (roleStarts): a local search only improves where it starts, and on the
 * citadels, where Citadel's answers are known, it found them only from
 * game01master's counts (Nov 28 2026).
 *
 * With `explore`, the explore search (optimizeArmySteps, below) instead:
 * several stages on a budget of work (`work`), never worse than this search
 * from the same starts, reporting progress to `onProgress({ done, total,
 * phase })`. Tools → Monsters uses it (in a worker, lib/army-search.js).
 * `scoreWeaker: false` (Tools → Citadel, Tools → Monsters): the 3%-weaker
 * battles must be won but their losses don't count — the score is the losses
 * at the bonuses as typed, what the page shows. `protWeaker` (Tools →
 * Monsters): protected losses of the weaker battles do count, a margin for
 * mercenaries and monsters (with worstCase: the worst of all four). `baseline` (Tools → Citadel): this search's own
 * answer, scored that way, is the floor.
 *
 * @param {{ army: {def: object, strengthPct?: number|null, healthPct?: number|null, protected?: boolean, cap?: number, weight?: number}[],
 *           enemy: {def: object, count: number}[], budget?: number, starts?: number[][], enemySide?: string,
 *           timeLimitMs?: number, worstCase?: boolean, roles?: boolean, explore?: boolean,
 *           onProgress?: (p: {done: number, total: number, phase: string}) => void, work?: number, scoreWeaker?: boolean, protWeaker?: boolean,
 *           baseline?: boolean, baselineStarts?: number[][]|null, tune?: object }} p
 *        timeLimitMs: stop improving after this long (a phone, 25 troop types); not used by explore
 * @returns {{ ok: boolean, counts: number[], both: any, evaluations: number }}
 */
export function optimizeArmy({ army, enemy, budget = 2500, starts = [], enemySide = 'enemy', timeLimitMs = Infinity, worstCase = false, roles: useRoles = false, explore = false, onProgress = null, work, scoreWeaker = true, protWeaker = scoreWeaker, baseline = false, baselineStarts = null, tune }) {
  if (explore) {
    const res = runSteps(optimizeArmySteps({ army, enemy, starts, enemySide, worstCase, work, scoreWeaker, protWeaker, baseline, baselineStarts, tune }), onProgress);
    const withStrikes = (counts) => simulateBothArmies({ mine: army.map((r, i) => ({ ...r, healthPct: r.healthPct ?? 0, count: counts[i] })), theirs: enemy, enemySide });
    return { ...res, both: res.counts.length ? withStrikes(res.counts) : null };
  }
  const until = Date.now() + timeLimitMs;
  if (!army.length) return { ok: false, counts: [], both: null, evaluations: 0 };
  const rows = army.map((r, index) => ({ ...r, index, healthPct: r.healthPct ?? 0 }));
  const caps = rows.map((r) => (Number.isFinite(r.cap) && r.cap >= 0 ? Math.floor(r.cap) : Infinity));
  // The same army with every bonus SAFETY lower (on the multiplier, 1 + bonus).
  const lower = (pct) => ((1 + (Number(pct) || 0) / 100) * (1 - SAFETY) - 1) * 100;
  const weaker = rows.map((r) => ({ ...r, strengthPct: lower(r.strengthPct), healthPct: lower(r.healthPct) }));
  const targets = enemy.filter((e) => e.def && e.count > 0).map((e) => ({ def: e.def, n: e.count, wall: isWall(e.def) }));
  const hasWalls = targets.some((x) => x.wall);
  /** Damage of ONE unit of row i against a full enemy stack. */
  const perUnit = (i, target) => damageVs(makeStack('you', rows[i].def, 1, Number(rows[i].strengthPct) || 0, 0), makeStack(enemySide, target.def, 1));
  const clamp = (counts) => counts.map((n, i) => Math.min(n, caps[i]));

  let evaluations = 0;
  const evaluate = (counts) => {
    evaluations += 1;
    const sim = (list) => simulateBothArmies({ mine: list.map((r, i) => ({ ...r, count: counts[i] })), theirs: enemy, enemySide, keepStrikes: false });
    const both = sim(rows);
    const weak = sim(weaker);
    const results = [both.you, both[enemySide], weak.you, weak[enemySide]];
    const won = results.every((r) => r.won);
    const left = results.reduce((a, res) => a + res.defenders.reduce((x, d) => x + d.alive, 0), 0);
    const power = counts.reduce((a, n, i) => a + n * rows[i].def.str * (1 + (Number(rows[i].strengthPct) || 0) / 100), 0);
    const l = lossValue([both.you, both[enemySide]], rows, worstCase);
    const w = lossValue([weak.you, weak[enemySide]], rows, worstCase);
    const prot = won ? (worstCase ? Math.max(l.prot, w.prot) : (l.prot + w.prot) / 2) : Infinity;
    const loss = won ? (l.rest + w.rest) / 2 : Infinity;
    return { counts: [...counts], both, won, prot, loss, left, power };
  };
  const better = (a, b) => {
    if (a.won !== b.won) return a.won;
    if (!a.won) return a.left < b.left || (a.left === b.left && a.power < b.power);
    if (Math.abs(a.prot - b.prot) > 1e-6) return a.prot < b.prot;
    if (Math.abs(a.loss - b.loss) > 1e-6) return a.loss < b.loss;
    return a.power < b.power - 1e-6;
  };

  // Start: every stack big enough to one-shot the biggest enemy stack (siege
  // engines: the walls), then double everything until both outcomes are won.
  const biggest = targets.filter((x) => !x.wall).reduce((m, x) => Math.max(m, x.n * x.def.hp), 0);
  const wallHp = targets.filter((x) => x.wall).reduce((m, x) => Math.max(m, x.n * x.def.hp), 0);
  let start = rows.map((r, i) => {
    const onWalls = hasWalls && isSiegeEngine(r.def);
    const want = onWalls ? wallHp : biggest;
    const best = Math.max(...targets.filter((x) => (onWalls ? x.wall : !x.wall)).map((x) => perUnit(i, x)), 1);
    return Math.max(1, Math.ceil(want / best));
  });
  let best = evaluate(clamp(start));
  for (let k = 0; k < 8 && !best.won; k++) {
    start = start.map((n) => n * 2);
    const next = evaluate(clamp(start));
    if (better(next, best)) best = next;
  }
  for (const s of [...starts, ...(useRoles ? roleStarts(rows, targets, perUnit, enemySide) : [])]) {
    if (!Array.isArray(s) || s.length !== rows.length || !s.every((n) => Number.isInteger(n) && n >= 0)) continue;
    const cand = evaluate(clamp(s));
    if (better(cand, best)) best = cand;
  }
  // The search plays without strike lists; the answer is played again with them.
  const withStrikes = (counts) => simulateBothArmies({ mine: rows.map((r, i) => ({ ...r, count: counts[i] })), theirs: enemy, enemySide });
  if (!best.won) return { ok: false, counts: best.counts, both: withStrikes(best.counts), evaluations };

  // Breakpoints per row: counts where its damage just reaches each enemy stack's health.
  const breaks = rows.map((r, i) => {
    const set = new Set();
    for (const x of targets) {
      const per = perUnit(i, x);
      if (per <= 0) continue;
      for (const frac of [1, 0.5, 0.25]) {
        const k = Math.floor((x.n * x.def.hp * frac) / per);
        for (const d of [-1, 0, 1]) if (k + d >= 0) set.add(k + d);
      }
    }
    return [...set];
  });

  const more = () => evaluations < budget && Date.now() < until;
  /** One row at a time, every candidate count, until nothing improves: a local best. */
  const descend = (from) => {
    let cur = from;
    let improved = true;
    while (improved && more()) {
      improved = false;
      for (let i = 0; i < rows.length && more(); i++) {
        const n = cur.counts[i];
        const cands = new Set([0, n - 1, n + 1, ...breaks[i]]);
        for (const f of [0.5, 0.75, 0.9, 0.97, 1.03, 1.1, 1.33, 2]) cands.add(Math.round(n * f));
        if (Number.isFinite(caps[i])) cands.add(caps[i]);
        for (const c of cands) {
          if (c < 0 || c === n || c > 1e8 || c > caps[i] || !more()) continue;
          const counts = [...cur.counts];
          counts[i] = c;
          const cand = evaluate(counts);
          if (better(cand, cur)) {
            cur = cand;
            improved = true;
          }
        }
      }
    }
    return cur;
  };
  best = descend(best);
  // With `roles`: kick the local best out of its hole — each row to none, half
  // or double — and descend again, keeping what beats it, while time lasts.
  // On the citadels this is what found Citadel's answers without game01master.
  if (useRoles) {
    let kicked = true;
    while (kicked && more()) {
      kicked = false;
      for (let i = 0; i < rows.length && more(); i++) {
        const n = best.counts[i];
        for (const c of [0, Math.round(n / 2), Math.min(n * 2 || 1, caps[i])]) {
          if (c === n || c < 0 || c > caps[i] || !more()) continue;
          const counts = [...best.counts];
          counts[i] = c;
          const cand = descend(evaluate(counts));
          if (better(cand, best)) {
            best = cand;
            kicked = true;
          }
        }
      }
    }
  }
  return { ok: true, counts: best.counts, both: withStrikes(best.counts), evaluations };
}

// ─── The explore search (Tools → Monsters) ───────────────────────
//
// optimizeArmy's local search only improves where it starts, one row at a
// time; on the benchmark (research/monster-sim/bench, docs/monster-simulator.md)
// it ended far from the best armies known. The explore search runs it as one
// stage of several, on a budget of work instead of time:
//  1. greedy — build an army from nothing, a row at a time, the move that
//     leaves the enemy weakest, until it wins; then down;
//  2. page — optimizeArmy's own descent from its own start (so the answer is
//     never worse than its, given the same starts);
//  3. roles — roleStarts (game01master's sizing made general), each taken down;
//  4. grow — again and again: one more killer (an unsent row at a count that
//     ties a sent row in turn order or kills an enemy stack whole), or one row
//     out or resized; a short descent; kept when it beats the best. The rows
//     the best known answers had and the old search lacked were mostly such
//     killers (protected rows that strike first and are never hit);
//  5. kicks — a sent row out, halved or doubled, or swapped for another.
// Candidates are scored lazily: the four battles stop as soon as a candidate
// can't beat the incumbent, even mid-battle (simulateArmies onLoss), and every
// score is kept by its counts.

/**
 * How much the explore search may play, in (strikes + 50) × stacks per battle
 * (deterministic, unlike a time limit: a phone finds the same army, only
 * slower). About 0.6 s in Node on a desktop (p90 1.2 s, the largest suggested
 * armies), a few seconds on a phone.
 */
export const EXPLORE_WORK = 6e7;
const EPS = 1e-6;
const WORSE = Object.freeze({ worse: true });
/** How often the search reports progress: this share of its work. */
const PROGRESS_STEP = 1 / 200;
/** The page stage plays at least as many candidates as optimizeArmy's default budget, so it ends where that ends or further. */
const PAGE_MIN_CALLS = 2500;
/** The stages, in order, and the share of the work each may take (what one leaves goes to the next). */
const STAGES = ['greedy', 'page', 'roles', 'grow', 'kicks'];
const SHARE = { greedy: 0.2, page: 0.2, roles: 0.1 };

/** optimizeArmy's order: true when `a` is the better army (`b` may be null). */
function betterArmy(a, b) {
  if (!b) return true;
  if (a.worse) return false;
  if (a.won !== b.won) return a.won;
  if (!a.won) return a.left < b.left || (a.left === b.left && a.power < b.power);
  if (Math.abs(a.prot - b.prot) > EPS) return a.prot < b.prot;
  if (Math.abs(a.loss - b.loss) > EPS) return a.loss < b.loss;
  return a.power < b.power - EPS;
}

/** Whether lower bounds on a candidate's protected and other losses already lose to a won incumbent. */
const cantBeat = (plb, llb, inc) => plb > inc.prot + EPS || (plb >= inc.prot - EPS && llb > inc.loss + EPS);

/** Drive a search generator to its end, passing each progress report on; returns the generator's value. */
function runSteps(gen, onProgress) {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    if (onProgress) onProgress(r.value);
  }
}

/**
 * The explore search as a generator: yields { done, total, phase } as it goes
 * ('starts', then 'improve'; done never goes back, the last report has done =
 * total) and returns { ok, counts, evaluations }. Tools → Monsters drives it in
 * a Web Worker, or in slices on the main thread (lib/army-search.js).
 * Arguments as optimizeArmy's, plus `work` (EXPLORE_WORK) and `tune` (research
 * only: stages, shares and the knobs below, for the benchmark).
 */
export function* optimizeArmySteps({ army, enemy, starts = [], enemySide = 'enemy', worstCase = false, work = EXPLORE_WORK, scoreWeaker = true, protWeaker = scoreWeaker, baseline = false, baselineStarts = null, tune = {} }) {
  const T = {
    stages: STAGES, share: SHARE, seed: 1,
    greedySteps: 12, greedyFull: 3, growStale: 20, growAdd: 0.7, growPasses: 1, ...tune,
  };
  const total = work;
  if (!army.length) {
    yield { done: total, total, phase: 'improve' };
    return { ok: false, counts: [], evaluations: 0 };
  }
  const n = army.length;
  const lower = (pct) => ((1 + (Number(pct) || 0) / 100) * (1 - SAFETY) - 1) * 100;
  const R = army.map((r, index) => ({ ...r, index, healthPct: r.healthPct ?? 0 }));
  const W = R.map((r) => ({ ...r, strengthPct: lower(r.strengthPct), healthPct: lower(r.healthPct) }));
  const caps = R.map((r) => (Number.isFinite(r.cap) && r.cap >= 0 ? Math.floor(r.cap) : Infinity));
  const targets = enemy.filter((e) => e.def && e.count > 0).map((e) => ({ def: e.def, n: e.count, wall: isWall(e.def) }));
  const unitStr = R.map((r) => r.def.str * (1 + (Number(r.strengthPct) || 0) / 100));
  const weight = R.map((r) => r.weight ?? r.def.hp);
  // Each enemy stack's unit strength, in the order battles list them (walls left out).
  const foeStr = targets.filter((x) => !x.wall).map((x) => x.def.str);
  // The battles a candidate must win, the one most likely lost first: the weaker army, the enemy opening.
  const order = [[W, enemySide], [W, 'you'], [R, enemySide], [R, 'you']];
  // Which of them count, and how many: protected losses (protWeaker: the weaker battles too, a margin),
  // the other losses (scoreWeaker: the weaker battles too); otherwise only the battles at the bonuses as typed.
  const nProt = protWeaker ? 4 : 2;
  const nRest = scoreWeaker ? 4 : 2;
  const memo = new Map();
  const memo1 = new Map();
  let used = 0;
  let calls = 0;
  let evaluations = 0;
  let phase = 'starts';
  let reported = -1;
  // A stage stops at its share of the work (`limit`), the page stage not before `floorCalls`.
  let limit = work;
  let floorCalls = 0;
  const more = () => used < work && (used < limit || calls < floorCalls);
  const due = () => Math.floor(Math.min(used, total) / total / PROGRESS_STEP) > reported;
  const report = () => {
    reported = Math.floor(Math.min(used, total) / total / PROGRESS_STEP);
    return { done: Math.min(used, total), total, phase };
  };
  const sentOf = (counts) => {
    const sent = [];
    for (let i = 0; i < n; i++) if (counts[i] > 0) sent.push(i);
    return sent;
  };
  const power = (counts) => counts.reduce((a, c, i) => a + c * unitStr[i], 0);

  /**
   * The score of some counts: { counts, won, prot, loss, power, left, leftStr }.
   * With a won incumbent, the battles stop as soon as the candidate can't beat
   * it (WORSE), mid-battle too. Scores are kept by counts, so a search that
   * comes back to the same counts plays nothing.
   */
  const evaluate = (counts, inc = null) => {
    const key = counts.join(',');
    const m = memo.get(key);
    const prune = !!(inc && inc.won);
    used += 1;
    calls += 1;
    if (m && !m.partial) return m;
    if (m && prune && (m.lost || cantBeat(m.plb, m.llb, inc))) return WORSE;
    evaluations += 1;
    const sent = sentOf(counts);
    let protMax = 0;
    let protSum = 0;
    let restSum = 0;
    let left = 0;
    let leftStr = 0;
    let won = true;
    for (const [list, opener] of order) {
      // A weaker battle must always be won; whether its losses count is protWeaker / scoreWeaker.
      const protCounts = protWeaker || list === R;
      const restCounts = scoreWeaker || list === R;
      let pNow = 0;
      let restNow = 0;
      const onLoss = prune && (protCounts || restCounts) ? (index, units) => {
        if (R[index].protected) { if (protCounts) pNow += units * weight[index]; } else if (restCounts) restNow += units * weight[index];
        return cantBeat(worstCase ? Math.max(protMax, pNow) : (protSum + pNow) / nProt, (restSum + restNow) / nRest, inc);
      } : null;
      // Only the rows sent; each keeps its index for the losses. (Reused objects: a battle only reads them.)
      const mine = sent.map((i) => { list[i].count = counts[i]; return list[i]; });
      const res = simulateArmies({ mine, theirs: enemy, opener, enemySide, keepStrikes: false, onLoss });
      used += (res.actions + 50) * (sent.length + targets.length);
      if (res.aborted) {
        memo.set(key, { partial: true, plb: worstCase ? Math.max(protMax, pNow) : (protSum + pNow) / nProt, llb: (restSum + restNow) / nRest });
        return WORSE;
      }
      if (!res.won) won = false;
      res.defenders.forEach((d, k) => { left += d.alive; leftStr += d.alive * foeStr[k]; });
      let p = 0;
      let rest = 0;
      for (const s of res.army) {
        if (R[s.index].protected) p += s.lost * weight[s.index];
        else rest += s.lost * weight[s.index];
      }
      if (protCounts) {
        protMax = Math.max(protMax, p);
        protSum += p;
      }
      if (restCounts) restSum += rest;
      if (prune) {
        if (!won) { memo.set(key, { partial: true, lost: true }); return WORSE; }
        const plb = worstCase ? protMax : protSum / nProt;
        if (cantBeat(plb, restSum / nRest, inc)) { memo.set(key, { partial: true, plb, llb: restSum / nRest }); return WORSE; }
      }
    }
    const out = {
      counts: [...counts], won, left, leftStr, power: power(counts),
      // worstCase: the worst counted battle; else the mean of those counted.
      prot: won ? (worstCase ? protMax : protSum / nProt) : Infinity,
      loss: won ? restSum / nRest : Infinity,
    };
    memo.set(key, out);
    return out;
  };

  /** One battle only, the hardest (the weaker army, the enemy opening): the greedy build's first look at a move. */
  const glance = (counts) => {
    const key = counts.join(',');
    used += 1;
    const m = memo1.get(key);
    if (m) return m;
    const sent = sentOf(counts);
    const res = simulateArmies({ mine: sent.map((i) => { W[i].count = counts[i]; return W[i]; }), theirs: enemy, opener: enemySide, enemySide, keepStrikes: false });
    used += (res.actions + 50) * (sent.length + targets.length);
    let leftStr = 0;
    res.defenders.forEach((d, k) => { leftStr += d.alive * foeStr[k]; });
    let prot = 0;
    let loss = 0;
    for (const x of res.army) {
      if (R[x.index].protected) prot += x.lost * weight[x.index];
      else loss += x.lost * weight[x.index];
    }
    const out = { counts: [...counts], won: res.won, leftStr, prot, loss, power: power(counts) };
    memo1.set(key, out);
    return out;
  };

  const perUnit = (i, x) => damageVs(makeStack('you', R[i].def, 1, Number(R[i].strengthPct) || 0, 0), makeStack(enemySide, x.def, 1));
  const unitHp = (i) => R[i].def.hp * (1 + (Number(R[i].healthPct) || 0) / 100);
  /** How many units of a row kill each enemy stack whole in one strike. */
  const wholeKills = R.map((r, i) => targets.flatMap((x) => {
    const per = perUnit(i, x);
    return per > 0 ? [Math.ceil((x.n * x.def.hp) / per)] : [];
  }));
  /**
   * Counts worth trying for a row whatever the others do: none, one, the
   * breakpoints where its strike just kills a share of an enemy stack, and
   * how many units one full strike of each enemy stack kills (a stack that
   * size takes that strike). `rich` adds more shares, two, three and all.
   */
  const fixedCounts = (fractions) => R.map((r, i) => {
    const set = new Set([0, 1]);
    for (const x of targets) {
      const per = perUnit(i, x);
      if (per > 0) for (const f of fractions) { const k = Math.floor((x.n * x.def.hp * f) / per); set.add(k); set.add(k + 1); }
      if (!x.wall) set.add(Math.ceil(damageVs(makeStack(enemySide, x.def, x.n), makeStack('you', r.def, 1, 0, Number(r.healthPct) || 0)) / unitHp(i)));
    }
    return [...set].filter((c) => c >= 0 && c <= caps[i] && c < 1e8).sort((a, b) => a - b);
  });
  const cheap = fixedCounts([1, 0.5, 0.25]);
  const rich = fixedCounts([1, 0.5, 1 / 3, 0.25, 1 / 6, 1 / 8]).map((l, i) => [...new Set([...l, 2, 3, caps[i]])].filter((c) => c <= caps[i] && Number.isFinite(c)));
  // optimizeArmy's own breakpoints (1, ½ and ¼ of each enemy stack, ±1), for its candidates in its order.
  const pageBreaks = R.map((r, i) => {
    const set = new Set();
    for (const x of targets) {
      const per = perUnit(i, x);
      if (per <= 0) continue;
      for (const frac of [1, 0.5, 0.25]) {
        const k = Math.floor((x.n * x.def.hp * frac) / per);
        for (const d of [-1, 0, 1]) if (k + d >= 0) set.add(k + d);
      }
    }
    return [...set];
  });
  /**
   * A row's candidates around the current counts. 'page': exactly what
   * optimizeArmy tries, in its order. Otherwise: a row not sent tries one unit
   * or a whole-stack kill; a sent row its fixed counts, nudges, and the counts
   * where it ties another sent row in turn order.
   */
  const candidates = (counts, i, mode) => {
    const c = counts[i];
    if (mode === 'page') {
      const set = new Set([0, c - 1, c + 1, ...pageBreaks[i]]);
      for (const f of [0.5, 0.75, 0.9, 0.97, 1.03, 1.1, 1.33, 2]) set.add(Math.round(c * f));
      if (Number.isFinite(caps[i])) set.add(caps[i]);
      return [...set].filter((v) => v >= 0 && v !== c && v <= 1e8 && v <= caps[i]);
    }
    if (c === 0) return [...new Set([1, ...wholeKills[i]])].filter((v) => v > 0 && v <= caps[i]);
    const set = new Set(cheap[i]);
    set.add(c - 1);
    set.add(c + 1);
    for (const f of [0.5, 0.9, 1.1, 2]) set.add(Math.round(c * f));
    for (let j = 0; j < n; j++) {
      if (j === i || !counts[j]) continue;
      const eq = (counts[j] * unitStr[j]) / unitStr[i];
      set.add(Math.floor(eq));
      set.add(Math.ceil(eq));
    }
    set.delete(c);
    return [...set].filter((v) => v >= 0 && v <= caps[i] && v < 1e8);
  };

  /**
   * First-improvement descent, one row at a time, until a pass changes
   * nothing (or `passes` run out). Outside the page stage a small step that
   * helped is followed, twice as far each time: most kept moves were ±1 or
   * ±2, and walking them one pass at a time spent the work on passes.
   */
  function* descend(cur, passes = Infinity, mode = 'cheap') {
    let improved = true;
    for (let pass = 0; improved && pass < passes && more(); pass++) {
      improved = false;
      for (let i = 0; i < n && more(); i++) {
        for (const c of candidates(cur.counts, i, mode)) {
          if (!more()) break;
          const counts = [...cur.counts];
          counts[i] = c;
          const s = evaluate(counts, cur);
          if (due()) yield report();
          if (!betterArmy(s, cur)) continue;
          const from = cur.counts[i];
          cur = s;
          improved = true;
          if (mode !== 'page' && Math.abs(c - from) <= Math.max(2, from * 0.1)) {
            for (let step = 2 * (c - from); more(); step *= 2) {
              const v = cur.counts[i] + step;
              if (v < 0 || v > caps[i] || v > 1e8) break;
              const next = [...cur.counts];
              next[i] = v;
              const t = evaluate(next, cur);
              if (due()) yield report();
              if (!betterArmy(t, cur)) break;
              cur = t;
            }
            break;
          }
        }
      }
    }
    return cur;
  }

  // optimizeArmy's start: every stack able to one-shot the biggest enemy stack
  // (siege engines: the walls), doubled until it wins, or a better given start.
  const biggest = targets.filter((x) => !x.wall).reduce((m, x) => Math.max(m, x.n * x.def.hp), 0);
  const wallHp = targets.filter((x) => x.wall).reduce((m, x) => Math.max(m, x.n * x.def.hp), 0);
  const clamp = (c) => c.map((v, i) => Math.min(v, caps[i]));
  let one = R.map((r, i) => {
    const onWalls = wallHp > 0 && isSiegeEngine(r.def);
    const top = Math.max(...targets.filter((x) => (onWalls ? x.wall : !x.wall)).map((x) => perUnit(i, x)), 1);
    return Math.max(1, Math.ceil((onWalls ? wallHp : biggest) / top));
  });
  let best = evaluate(clamp(one));
  for (let k = 0; k < 8 && !best.won; k++) {
    if (due()) yield report();
    one = one.map((v) => v * 2);
    const s = evaluate(clamp(one));
    if (betterArmy(s, best)) best = s;
  }
  for (const st of starts) {
    if (due()) yield report();
    if (!Array.isArray(st) || st.length !== n || !st.every((v) => Number.isInteger(v) && v >= 0)) continue;
    const s = evaluate(clamp(st));
    if (betterArmy(s, best)) best = s;
  }
  const pageStart = best;
  if (!best.won) {
    for (const st of roleStarts(R, targets, perUnit, enemySide)) {
      const s = evaluate(clamp(st));
      if (betterArmy(s, best)) best = s;
    }
  }
  if (!best.won) {
    yield { done: total, total, phase };
    return { ok: false, counts: best.counts, evaluations };
  }
  const keep = (s) => { if (betterArmy(s, best)) best = s; };
  let rs = (T.seed * 2654435761) | 0 || 1;
  const rng = () => { rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; return (rs >>> 0) / 4294967296; };

  /** Build an army from nothing: a siege engine for the walls, then the move that leaves the enemy weakest, until it wins. */
  function* greedy() {
    const c = Array(n).fill(0);
    if (wallHp > 0) {
      let bi = -1;
      let bn = 0;
      R.forEach((r, i) => {
        if (!isSiegeEngine(r.def)) return;
        const per = perUnit(i, targets.find((x) => x.wall));
        const k = per > 0 ? Math.ceil(wallHp / per) : Infinity;
        if (k <= caps[i] && (bi < 0 || k * weight[i] < bn * weight[bi])) { bi = i; bn = k; }
      });
      if (bi >= 0) c[bi] = bn;
    }
    // A row grows from none to one unit or to a whole-stack kill, or doubles.
    const grow = (i, v) => [...new Set([v === 0 ? 1 : v * 2, ...wholeKills[i]])].filter((k) => k > v && k <= caps[i]);
    const ahead = (a, b) => {
      if (a.won !== b.won) return a.won;
      if (a.won) return betterArmy(a, b);
      if (Math.abs(a.leftStr - b.leftStr) > EPS) return a.leftStr < b.leftStr;
      return a.power < b.power;
    };
    let cur = evaluate(c);
    for (let step = 0; step < T.greedySteps && !cur.won && more(); step++) {
      // Every move at a glance (the hardest battle only); the few best in full.
      const looks = [];
      for (let i = 0; i < n && more(); i++) {
        for (const v of grow(i, cur.counts[i])) {
          const cc = [...cur.counts];
          cc[i] = v;
          looks.push(glance(cc));
          if (due()) yield report();
        }
      }
      looks.sort((a, b) => (ahead(a, b) ? -1 : ahead(b, a) ? 1 : 0));
      let next = null;
      for (const l of looks.slice(0, T.greedyFull)) {
        const sc = evaluate(l.counts);
        if (!next || ahead(sc, next)) next = sc;
      }
      if (!next || !ahead(next, cur)) break;
      cur = next;
    }
    if (cur.won) keep(yield* descend(cur, Infinity, 'page'));
  }

  /** One more killer, or one row out or resized; a short descent; kept when it beats the best. */
  function* growStage() {
    for (let stale = 0; more() && stale < T.growStale * n;) {
      const counts = [...best.counts];
      const unsent = [];
      const sent = [];
      for (let i = 0; i < n; i++) (counts[i] > 0 ? sent : unsent).push(i);
      if (unsent.length && (rng() < T.growAdd || !sent.length)) {
        const j = unsent[Math.floor(rng() * unsent.length)];
        const opts = [1, 2, ...wholeKills[j]];
        for (const i of sent) { const eq = (counts[i] * unitStr[i]) / unitStr[j]; opts.push(Math.floor(eq), Math.ceil(eq)); }
        const v = opts[Math.floor(rng() * opts.length)];
        if (!(v > 0 && v <= caps[j])) { stale++; continue; }
        counts[j] = v;
      } else {
        const i = sent[Math.floor(rng() * sent.length)];
        counts[i] = rng() < 0.5 ? 0 : rich[i][Math.floor(rng() * rich[i].length)];
      }
      const s0 = evaluate(counts);
      if (due()) yield report();
      if (!s0.won) { stale++; continue; }
      const s1 = yield* descend(s0, T.growPasses);
      if (betterArmy(s1, best)) { best = yield* descend(s1); stale = 0; } else stale++;
    }
  }

  /**
   * A sent row out, halved or doubled; a protected row out with every other
   * row at all it has (the rest take its place); or swapped for an unsent row
   * at one of its breakpoints — then down again, kept when it beats the best.
   */
  function* kicks() {
    let kicked = true;
    while (kicked && more()) {
      kicked = false;
      for (let i = 0; i < n && more() && !kicked; i++) {
        const c = best.counts[i];
        const tries = [0, Math.round(c / 2), Math.min(c * 2 || 1, caps[i])].filter((v) => v !== c).map((v) => [[i, v]]);
        if (c > 0 && R[i].protected) {
          const fill = [[i, 0]];
          for (let j = 0; j < n; j++) if (!R[j].protected && Number.isFinite(caps[j]) && best.counts[j] < caps[j]) fill.push([j, caps[j]]);
          tries.unshift(fill);
        }
        if (c > 0) for (let j = 0; j < n; j++) if (j !== i && !best.counts[j]) for (const v of cheap[j]) if (v > 0) tries.push([[i, 0], [j, v]]);
        for (const moves of tries) {
          if (!more()) break;
          const counts = [...best.counts];
          for (const [r, v] of moves) counts[r] = v;
          const s0 = evaluate(counts);
          if (due()) yield report();
          if (!s0.won) continue;
          const s = yield* descend(s0, moves.length === 2 ? 1 : Infinity);
          if (betterArmy(s, best)) {
            best = yield* descend(s);
            kicked = true;
            break;
          }
        }
      }
    }
  }

  for (const stage of T.stages) {
    limit = Math.min(work, used + (T.share?.[stage] ?? 1) * work);
    floorCalls = stage === 'page' ? calls + PAGE_MIN_CALLS : 0;
    if (!more()) break;
    if (stage === 'greedy') yield* greedy();
    else if (stage === 'page') keep(yield* descend(pageStart, Infinity, 'page'));
    else if (stage === 'roles') {
      for (const st of roleStarts(R, targets, perUnit, enemySide)) {
        if (!more()) break;
        const s0 = evaluate(clamp(st));
        if (s0.won) keep(yield* descend(s0, Infinity, 'page'));
      }
    } else if (stage === 'grow') {
      phase = 'improve';
      yield* growStage();
    } else if (stage === 'kicks') {
      phase = 'improve';
      yield* kicks();
    }
  }
  if (baseline) best = yield* oldFloor(best);
  yield { done: total, total, phase };
  return { ok: true, counts: best.counts, evaluations, score: { prot: best.prot, loss: best.loss, power: best.power } };

  /**
   * Tools → Citadel's floor: the old search's answers for the same army and
   * starts — as it ran before Nov 28 2026 (base health) and on this army's
   * prices — scored the way this search scores. The better army is the
   * answer: Citadel's Auto is never worse than it was.
   */
  function* oldFloor(found) {
    yield report();
    let best = found;
    // The old search as it was (losses by base health, the weaker battles averaged in) and on this army's prices.
    const variants = [army.map((r) => ({ ...r, weight: undefined }))];
    if (army.some((r) => r.weight !== undefined)) variants.push(army);
    for (const rows of variants) {
      // From the starts the old search had (the caller's own, not the learned ones added since).
      const old = optimizeArmy({ army: rows, enemy, starts: baselineStarts ?? starts, enemySide, worstCase });
      if (!old.ok) continue;
      const ref = evaluate(old.counts);
      if (betterArmy(ref, best)) best = ref;
    }
    return best;
  }
}
