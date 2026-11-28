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
const MAX_BATTLE_ROUNDS = 60;

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
  s = { tags, vs, wall: WALL_TAGS.some((t) => tags.has(t)), siege };
  norm.set(def, s);
  return s;
}

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
    siegeEngine: sh.siege,
    wall: sh.wall,
    uhp,
    pool: count * uhp,
    taken: 0,
  };
}

export function alive(st) {
  return st.pool <= 1e-6 ? 0 : Math.ceil(st.pool / st.uhp - 1e-9);
}

/** Turn order: units × strength × (1 + bonus). Features play no part. */
export function strength(st) {
  return alive(st) * st.def.str * (1 + st.s);
}

export function damageVs(actor, target) {
  let bonus = actor.s;
  let mult = 1;
  for (const f of actor.vs) {
    if (!f.on.some((t) => target.tags.has(t))) continue;
    bonus += f.v;
    mult *= f.mult;
  }
  return alive(actor) * actor.def.str * (1 + bonus) * mult;
}

/** Most damage dealt (capped at what is left); ties → whoever hits back hardest. */
export function pickTarget(actor, enemies, exclude = null) {
  let best = null;
  let bestKey = null;
  for (const t of enemies) {
    if (t === exclude || alive(t) === 0) continue;
    const key = [Math.round(Math.min(damageVs(actor, t), t.pool)), Math.round(damageVs(t, actor)), Math.round(strength(t))];
    if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))) {
      best = t;
      bestKey = key;
    }
  }
  return best;
}

/** What a strike takes: never more than the target has. (The game logs whole points; the engine keeps the fraction.) */
function dealt(damage, pool) {
  return Math.min(damage, pool);
}

function strongestUnacted(stacks, acted) {
  let best = null;
  for (const s of stacks) {
    if (acted.has(s) || alive(s) === 0) continue;
    if (!best || strength(s) > strength(best)) best = s;
  }
  return best;
}

/**
 * One battle.
 * @param {object} p
 * @param {{def: object, count: number, strengthPct?: number, healthPct?: number|null, index?: number}[]} p.mine
 *        rows with no units are left out; healthPct null = not entered (UNKNOWN_HEALTH_FACTOR)
 * @param {{def: object, count: number}[]} p.theirs  the enemy's army, walls included
 * @param {'you'|string} p.opener  who opens the first battle round ('you' or the enemy)
 * @param {string} [p.enemySide]  the enemy's side label in the result ('citadel' for Citadel)
 * @param {Record<number,{double?:boolean,second?:boolean,blocked?:boolean}>} [p.luck]  1-based action number → luck (tests)
 */
export function simulateArmies({ mine: rows, theirs: enemy, opener = 'enemy', enemySide = 'enemy', luck = {} }) {
  const mine = [];
  rows.forEach((row, i) => {
    const n = Math.max(0, Math.floor(Number(row.count) || 0));
    const health = row.healthPct === null || row.healthPct === undefined || row.healthPct === '' ? null : Number(row.healthPct) || 0;
    if (row.def && n > 0) mine.push(makeStack('you', row.def, n, Number(row.strengthPct) || 0, health, row.index ?? i));
  });
  const all = enemy.filter((e) => e.def && e.count > 0).map((e, index) => makeStack(enemySide, e.def, e.count, 0, 0, index));
  const walls = all.find((s) => s.wall) ?? null;
  const theirs = all.filter((s) => s !== walls);

  const strikes = [];
  let action = 0;
  const hit = (actor, target, phase, round) => {
    action += 1;
    const roll = luck[action] || {};
    const mult = (roll.double ? 2 : 1) * (roll.blocked ? BLOCKED : 1);
    const record = (t, dealt, second) => {
      const before = alive(t);
      t.pool -= dealt;
      t.taken += dealt;
      const after = alive(t);
      strikes.push({
        phase, round, side: actor.side, actor: actor.def.id, target: t.def.id, damage: dealt,
        double: !!roll.double, second, killed: after === 0,
        // Units the hit removed and what the target has left — the "result" column of the strike list.
        unitsLost: before - after, unitsLeft: after,
      });
    };
    record(target, dealt(damageVs(actor, target) * mult, target.pool), false);
    if (roll.second) {
      const pool = actor.side === 'you' ? (phase === 'siege' ? [] : theirs) : mine;
      const t2 = pickTarget(actor, pool, target);
      if (t2) record(t2, dealt(damageVs(actor, t2) * mult, t2.pool), true);
    }
  };
  const living = (list) => list.filter((s) => alive(s) > 0);

  // Siege
  let wallsDown = !walls;
  let siegeRounds = 0;
  if (walls && mine.length) {
    outer: for (let r = 1; r <= MAX_SIEGE_ROUNDS; r++) {
      siegeRounds = r;
      const acted = new Set();
      for (let s; (s = strongestUnacted(mine.filter((x) => x.siegeEngine), acted));) {
        hit(s, walls, 'siege', r);
        acted.add(s);
        if (alive(walls) === 0) { wallsDown = true; break outer; }
      }
      const target = pickTarget(walls, living(mine));
      if (target) hit(walls, target, 'siege', r);
      if (!living(mine).length) break;
      for (let s; (s = strongestUnacted(mine.filter((x) => !x.siegeEngine), acted));) {
        hit(s, walls, 'siege', r);
        acted.add(s);
        if (alive(walls) === 0) { wallsDown = true; break outer; }
      }
    }
  }
  const siegeLost = new Map(mine.map((s) => [s, s.count - alive(s)]));
  const siegeTaken = new Map(mine.map((s) => [s, s.taken]));
  // Wounds from the walls heal before the battle; the dead stay dead.
  for (const s of mine) s.pool = alive(s) * s.uhp;

  // Battle
  let won = false;
  let reason = null;
  let rounds = 0;
  if (!mine.length) reason = 'empty';
  else if (!wallsDown) reason = living(mine).length ? 'walls' : 'destroyed';
  else {
    let first = opener === 'you' ? 'you' : enemySide;
    const sides = { you: mine, [enemySide]: theirs };
    battle: for (let r = 1; r <= MAX_BATTLE_ROUNDS; r++) {
      rounds = r;
      const acted = new Set();
      let side = first;
      let last = null;
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
        acted.add(actor);
        last = side;
        if (!living(theirs).length) { won = true; break battle; }
        if (!living(mine).length) { reason = 'destroyed'; break battle; }
        side = other;
      }
      first = last === 'you' ? enemySide : 'you';
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
    army: mine.map((s) => ({
      index: s.index,
      troopId: s.def.id,
      count: s.count,
      alive: alive(s),
      lost: s.count - alive(s),
      lostInSiege: siegeLost.get(s),
      siegeDamage: siegeTaken.get(s),
      battleDamage: s.taken - siegeTaken.get(s),
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

/** Automatic counts must still win with every bonus this much lower. */
export const SAFETY = 0.03;

/**
 * Expected losses of a setup (the mean of both coin flips), split into the
 * protected rows (monsters, mercenaries: never traded for cheaper losses) and
 * the rest. Each lost unit is worth its base health, so one Wyvern (2.07M)
 * weighs about eleven Corax I (183.6k) and losing cheap low-tier units is cheap.
 */
function lossValue(results, rows) {
  let rest = 0;
  let prot = 0;
  for (const res of results) {
    for (const s of res.army) {
      const row = rows[s.index];
      if (row.protected) prot += s.lost * row.def.hp;
      else rest += s.lost * row.def.hp;
    }
  }
  return { prot: prot / results.length, rest: rest / results.length };
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
 * @param {{ army: {def: object, strengthPct?: number|null, healthPct?: number|null, protected?: boolean, cap?: number}[],
 *           enemy: {def: object, count: number}[], budget?: number, starts?: number[][], enemySide?: string }} p
 * @returns {{ ok: boolean, counts: number[], both: any, evaluations: number }}
 */
export function optimizeArmy({ army, enemy, budget = 2500, starts = [], enemySide = 'enemy' }) {
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
    const sim = (list) => simulateBothArmies({ mine: list.map((r, i) => ({ ...r, count: counts[i] })), theirs: enemy, enemySide });
    const both = sim(rows);
    const weak = sim(weaker);
    const results = [both.you, both[enemySide], weak.you, weak[enemySide]];
    const won = results.every((r) => r.won);
    const left = results.reduce((a, res) => a + res.defenders.reduce((x, d) => x + d.alive, 0), 0);
    const power = counts.reduce((a, n, i) => a + n * rows[i].def.str * (1 + (Number(rows[i].strengthPct) || 0) / 100), 0);
    const l = lossValue([both.you, both[enemySide]], rows);
    const w = lossValue([weak.you, weak[enemySide]], rows);
    const prot = won ? (l.prot + w.prot) / 2 : Infinity;
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
  for (const s of starts) {
    if (!Array.isArray(s) || s.length !== rows.length || !s.every((n) => Number.isInteger(n) && n >= 0)) continue;
    const cand = evaluate(clamp(s));
    if (better(cand, best)) best = cand;
  }
  if (!best.won) return { ok: false, counts: best.counts, both: best.both, evaluations };

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

  let improved = true;
  while (improved && evaluations < budget) {
    improved = false;
    for (let i = 0; i < rows.length && evaluations < budget; i++) {
      const n = best.counts[i];
      const cands = new Set([0, n - 1, n + 1, ...breaks[i]]);
      for (const f of [0.5, 0.75, 0.9, 0.97, 1.03, 1.1, 1.33, 2]) cands.add(Math.round(n * f));
      if (Number.isFinite(caps[i])) cands.add(caps[i]);
      for (const c of cands) {
        if (c < 0 || c === n || c > 1e8 || c > caps[i] || evaluations >= budget) continue;
        const counts = [...best.counts];
        counts[i] = c;
        const cand = evaluate(counts);
        if (better(cand, best)) {
          best = cand;
          improved = true;
        }
      }
    }
  }
  return { ok: true, counts: best.counts, both: best.both, evaluations };
}
