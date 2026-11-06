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
// Plain ESM, no DOM access — imported by pages/citadel-tool.js and the tests.

/** Base strength and health from the game cards / totalbattlewiki.com; features
 *  ("vs") in percent. `group` sorts the picker and seeds new rows' bonuses. */
function troop(id, name, group, str, hp, tags, vs, extra = {}) {
  return { id, name, group, str, hp, tags, vs, siegeEngine: false, ...extra };
}
const SIEGE = { siegeEngine: true };

export const TROOPS = [
  troop('corax-2', 'Corax II', 'guardsmen', 110200, 330600, ['flying', 'guardsman', 'human'], { mounted: 1999, fortification: 1051 }),
  troop('corax-1', 'Corax I', 'guardsmen', 61200, 183600, ['flying', 'guardsman', 'human'], { mounted: 1333, fortification: 701 }),
  troop('griffin-7', 'Battle Griffin VII', 'guardsmen', 34000, 102000, ['beast', 'flying', 'guardsman'], { mounted: 888, fortification: 467 }),
  troop('griffin-6', 'Battle Griffin VI', 'guardsmen', 19000, 57000, ['beast', 'flying', 'guardsman'], { mounted: 592, fortification: 311 }),
  troop('griffin-5', 'Battle Griffin V', 'guardsmen', 10000, 30000, ['beast', 'flying', 'guardsman'], { mounted: 395, fortification: 208 }),
  troop('punisher-1', 'Punisher I', 'guardsmen', 3060, 9180, ['guardsman', 'human', 'melee'], { beast: 1367, mounted: 667 }),
  troop('heavy-halberdier-7', 'Heavy Halberdier VII', 'guardsmen', 1700, 5100, ['guardsman', 'human', 'melee'], { beast: 911, mounted: 444 }),
  troop('heavy-halberdier-6', 'Heavy Halberdier VI', 'guardsmen', 940, 2820, ['guardsman', 'human', 'melee'], { beast: 608, mounted: 296 }),
  troop('spearmen-5', 'Spearman V', 'guardsmen', 520, 1560, ['guardsman', 'human', 'melee'], { beast: 405, mounted: 197 }),
  troop('royal-lion-2', 'Royal Lion II', 'specialists', 110200, 330600, ['beast', 'flying', 'specialist'], { mounted: 1000, fortification: 525 }),
  troop('royal-lion-1', 'Royal Lion I', 'specialists', 61200, 183600, ['beast', 'flying', 'specialist'], { mounted: 667, fortification: 350 }),
  troop('vulture-7', 'Vulture VII', 'specialists', 1700, 5100, ['flying', 'human', 'specialist'], { mounted: 444, fortification: 234, human: 105 }),
  troop('vulture-6', 'Vulture VI', 'specialists', 940, 2820, ['flying', 'human', 'specialist'], { mounted: 296, fortification: 156, human: 105 }),
  troop('vulture-5', 'Vulture V', 'specialists', 520, 1560, ['flying', 'human', 'specialist'], { mounted: 197, fortification: 104, human: 105 }),
  troop('duelist-1', 'Duelist I', 'specialists', 3060, 9180, ['human', 'melee', 'specialist'], { beast: 683, mounted: 333 }),
  troop('heavy-knight-7', 'Heavy Knight VII', 'specialists', 1700, 5100, ['human', 'melee', 'specialist'], { beast: 456, human: 105, mounted: 222 }),
  troop('heavy-knight-6', 'Heavy Knight VI', 'specialists', 940, 2820, ['human', 'melee', 'specialist'], { beast: 304, human: 105, mounted: 148 }),
  troop('swordsmen-5', 'Swordsman V', 'specialists', 520, 1560, ['human', 'melee', 'specialist'], { beast: 203, human: 105, mounted: 99 }),
  troop('fire-phoenix-2', 'Fire Phoenix II', 'monsters', 1190000, 3570000, ['elemental', 'flying', 'monster'], { melee: 1051, dragon: 1871 }),
  troop('fire-phoenix-1', 'Fire Phoenix I', 'monsters', 660000, 1980000, ['elemental', 'flying', 'monster'], { melee: 701, dragon: 1247 }),
  troop('manticore', 'Fearsome Manticore', 'monsters', 46000, 138000, ['beast', 'flying', 'monster'], { flying: 253, giant: 324 }),
  troop('wyvern', 'Wyvern', 'mercenaries', 690000, 2070000, ['cursed', 'flying', 'mercenary'], { melee: 75 }),
  troop('warregal', 'Warregal', 'mercenaries', 220000, 660000, ['beast', 'flying', 'guardsman', 'mercenary'], { fortification: 1051, mounted: 1999 }),
  troop('jago', 'Jago', 'mercenaries', 220000, 660000, ['beast', 'flying', 'mercenary', 'specialist'], { fortification: 525, mounted: 1000 }),
  troop('epic-monster-hunter', 'Epic Monster Hunter', 'mercenaries', 25000, 75000, ['guardsman', 'mercenary'], {}),
  troop('ariel', 'Ariel', 'mercenaries', 55000, 330000, ['human', 'mercenary', 'siege'], { fortification: 1667 }, SIEGE),
  // Siege health is game01master's (6× strength): the Siege Ballistae VII card
  // reads 51,000. totalbattlewiki.com halves it for every siege engine.
  troop('josephine-2', 'Josephine II', 'siege', 27550, 165300, ['engineer', 'human', 'siege'], { fortification: 1667 }, SIEGE),
  troop('josephine-1', 'Josephine I', 'siege', 15310, 91800, ['engineer', 'human', 'siege'], { fortification: 1111 }, SIEGE),
  troop('siege-ballistae-7', 'Siege Ballistae VII', 'siege', 8500, 51000, ['engineer', 'human', 'siege'], { fortification: 740 }, SIEGE),
  troop('siege-ballistae-6', 'Siege Ballistae VI', 'siege', 4730, 28400, ['engineer', 'human', 'siege'], { fortification: 494 }, SIEGE),
  troop('catapult-5', 'Catapult V', 'siege', 2630, 15800, ['engineer', 'human', 'siege'], { fortification: 329 }, SIEGE),
  troop('catapult-4', 'Catapult IV', 'siege', 1460, 8750, ['engineer', 'human', 'siege'], { fortification: 219 }, SIEGE),
  troop('catapult-3', 'Catapult III', 'siege', 810, 4860, ['engineer', 'human', 'siege'], { fortification: 146 }, SIEGE),
];
export const TROOP_GROUPS = ['guardsmen', 'specialists', 'monsters', 'mercenaries', 'siege'];

/**
 * Troops that read the same strength and health bonus off their cards: the
 * same captain, artifact and research lines apply to every tier. These are
 * game01master's groups (its getBonusGroup, which links the strength fields);
 * the page links strength AND health within a family. A troop in no family
 * shares with nothing.
 */
export const BONUS_FAMILIES = {
  corax: ['corax-1', 'corax-2'],
  phoenix: ['fire-phoenix-1', 'fire-phoenix-2'],
  vulture: ['vulture-5', 'vulture-6', 'vulture-7'],
  'royal-lion': ['royal-lion-1', 'royal-lion-2', 'jago'],
  griffin: ['griffin-5', 'griffin-6', 'griffin-7', 'warregal'],
  'melee-guardsmen': ['punisher-1', 'heavy-halberdier-6', 'heavy-halberdier-7', 'spearmen-5'],
  'melee-specialists': ['duelist-1', 'heavy-knight-6', 'heavy-knight-7', 'swordsmen-5'],
};
/**
 * The order the game lists troops when a march is set up (game01master's
 * RESULT_ORDER): the march list follows it, so a player goes straight down
 * the screen typing counts instead of hunting for each troop. One fix from the
 * game itself (Nov 2026 march screen): Jago comes before Warregal —
 * game01master has them the other way round.
 */
export const MARCH_ORDER = [
  'wyvern', 'jago', 'warregal', 'ariel', 'epic-monster-hunter', 'fire-phoenix-2',
  'fire-phoenix-1', 'manticore', 'corax-2', 'royal-lion-2', 'corax-1',
  'royal-lion-1', 'griffin-7', 'josephine-2', 'griffin-6', 'josephine-1',
  'griffin-5', 'siege-ballistae-7', 'siege-ballistae-6', 'punisher-1',
  'duelist-1', 'catapult-5', 'vulture-7', 'heavy-halberdier-7',
  'heavy-knight-7', 'catapult-4', 'vulture-6', 'heavy-halberdier-6',
  'heavy-knight-6', 'catapult-3', 'spearmen-5', 'swordsmen-5', 'vulture-5',
];

/** Rows with troops to send, sorted as the march screen lists them. */
export function marchList(rows) {
  const at = (id) => {
    const k = MARCH_ORDER.indexOf(id);
    return k === -1 ? MARCH_ORDER.length : k;
  };
  return rows.filter((r) => r.count > 0).sort((a, b) => at(a.troopId) - at(b.troopId));
}

/**
 * The level that unlocks each troop: [kind, tier], kind g/s/m/e (Guardsmen,
 * Specialists, Monsters, Engineers — the levels players quote as "8/8/8/7").
 * The roman numeral is the tier up to VII; the newer names start again at
 * I = tier 8. Strength ×1.8 per tier holds straight across that seam (Heavy
 * Halberdier VII 1,700 → Punisher I 3,060; Battle Griffin VII 34,000 → Corax I
 * 61,200 → Corax II 110,200; Ballistae VII 8,500 → Josephine I 15,310), and
 * game01master calls the Phoenixes M8/M9; the Fearsome Manticore is M5 (from
 * the user, Nov 2026). Mercenaries aren't unlocked by level and are always offered.
 */
export const TROOP_TIERS = {
  'spearmen-5': ['g', 5], 'heavy-halberdier-6': ['g', 6], 'heavy-halberdier-7': ['g', 7], 'punisher-1': ['g', 8],
  'griffin-5': ['g', 5], 'griffin-6': ['g', 6], 'griffin-7': ['g', 7], 'corax-1': ['g', 8], 'corax-2': ['g', 9],
  'swordsmen-5': ['s', 5], 'heavy-knight-6': ['s', 6], 'heavy-knight-7': ['s', 7], 'duelist-1': ['s', 8],
  'vulture-5': ['s', 5], 'vulture-6': ['s', 6], 'vulture-7': ['s', 7], 'royal-lion-1': ['s', 8], 'royal-lion-2': ['s', 9],
  'manticore': ['m', 5], 'fire-phoenix-1': ['m', 8], 'fire-phoenix-2': ['m', 9],
  'catapult-3': ['e', 3], 'catapult-4': ['e', 4], 'catapult-5': ['e', 5],
  'siege-ballistae-6': ['e', 6], 'siege-ballistae-7': ['e', 7], 'josephine-1': ['e', 8], 'josephine-2': ['e', 9],
};

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

const FAMILY_OF = new Map(Object.entries(BONUS_FAMILIES).flatMap(([fam, ids]) => ids.map((id) => [id, fam])));

/** The bonus family of a troop, or null when it shares its bonuses with none. */
export function bonusFamily(troopId) {
  return FAMILY_OF.get(troopId) ?? null;
}

/** Citadel defenders, from their in-game cards (all checked). */
function unit(id, name, str, hp, tags, vs) {
  return { id, name, str, hp, tags, vs };
}
export const DEFENDERS = Object.fromEntries([
  unit('walls', 'Citadel Walls', 10000, 30000, ['fortification'], { melee: 100, ranged: 100, mounted: 100 }),
  unit('dwarf', 'Dwarf', 28, 84, ['elves', 'melee'], { mounted: 10 }),
  unit('elven-archer', 'Elven Archer', 100, 300, ['elves', 'ranged'], { melee: 35 }),
  unit('druid', 'Druid', 900, 2700, ['elves', 'ranged'], { melee: 25 }),
  unit('centaur', 'Centaur', 2600, 7800, ['elves', 'mounted'], { ranged: 50, siege: 20 }),
  unit('pegasus-rider', 'Pegasus Rider', 8200, 24600, ['elves', 'flying'], { melee: 60, dragon: 50 }),
  unit('bear', 'Bear', 22000, 66000, ['beast', 'elves', 'melee'], { mounted: 70, elemental: 50 }),
  unit('unicorn-rider', 'Unicorn Rider', 27000, 81000, ['elves', 'mounted'], { ranged: 65 }),
  unit('ent', 'Ent', 73000, 219000, ['elemental', 'elves', 'melee'], { ranged: 55, dragon: 45 }),
  unit('life-dragon', 'Life Dragon', 240000, 720000, ['dragon', 'elves', 'flying'], { mounted: 60, giant: 50 }),
  unit('werewolf', 'Werewolf', 360, 1080, ['beast', 'cursed', 'melee'], { mounted: 45 }),
  unit('death-rider', 'Death Rider', 3200, 9600, ['cursed', 'mounted'], { ranged: 50 }),
  unit('bull-rider', 'Bull Rider', 29000, 87000, ['cursed', 'mounted'], { ranged: 55 }),
  unit('giant-zombie', 'Giant Zombie', 33000, 99000, ['cursed', 'giant', 'melee'], { mounted: 70, beast: 45 }),
  unit('cursed-dendroid', 'Cursed Dendroid', 110000, 330000, ['cursed', 'elemental', 'melee'], { ranged: 65, dragon: 50 }),
  unit('cursed-dragon', 'Cursed Dragon', 320000, 960000, ['cursed', 'dragon', 'flying'], { giant: 50, mounted: 50 }),
].map((d) => [d.id, d]));

/** What is inside each citadel — counted from in-game march screens. */
export const CITADELS = [
  { id: 'elven-10', kind: 'elven', level: 10, walls: 90, units: [['bear', 9], ['pegasus-rider', 19], ['elven-archer', 1200], ['druid', 100], ['dwarf', 2200]] },
  { id: 'elven-15', kind: 'elven', level: 15, walls: 700, units: [['ent', 21], ['unicorn-rider', 47], ['centaur', 290], ['druid', 1100], ['elven-archer', 5000]] },
  { id: 'elven-20', kind: 'elven', level: 20, walls: 3650, units: [['life-dragon', 41], ['ent', 110], ['bear', 230], ['centaur', 2500], ['druid', 3600]] },
  { id: 'elven-25', kind: 'elven', level: 25, walls: 31900, units: [['life-dragon', 480], ['ent', 880], ['bear', 2400], ['pegasus-rider', 4300], ['centaur', 10000]] },
  { id: 'elven-30', kind: 'elven', level: 30, walls: 135000, units: [['life-dragon', 2300], ['ent', 4300], ['bear', 12000], ['pegasus-rider', 21000], ['centaur', 49000]] },
  { id: 'cursed-20', kind: 'cursed', level: 20, walls: 9200, units: [['cursed-dragon', 10], ['giant-zombie', 80], ['bull-rider', 54], ['death-rider', 650], ['werewolf', 2900]] },
  { id: 'cursed-25', kind: 'cursed', level: 25, walls: 77500, units: [['cursed-dragon', 120], ['cursed-dendroid', 205], ['giant-zombie', 540], ['bull-rider', 400], ['death-rider', 2750]] },
];

const TROOP_BY_ID = new Map(TROOPS.map((x) => [x.id, x]));
const CITADEL_BY_ID = new Map(CITADELS.map((c) => [c.id, c]));
export const troopById = (id) => TROOP_BY_ID.get(id) ?? null;
export const citadelById = (id) => CITADEL_BY_ID.get(id) ?? null;

// ─── Engine ──────────────────────────────────────────────────────

const MAX_SIEGE_ROUNDS = 40;
const MAX_BATTLE_ROUNDS = 60;

/** A health bonus nobody entered: the stack counts as untouchable. That can only
 *  make it MORE attractive as a target (damage is capped at what a target has
 *  left), so a stack that still isn't hit would not be hit with its real health
 *  either; one that IS hit is reported (`healthUnknown`) for the page to ask. */
const UNKNOWN_HEALTH_FACTOR = 1e9;

function makeStack(side, def, count, strengthPct = 0, healthPct = 0, index = -1) {
  const unknown = healthPct === null;
  const uhp = def.hp * (unknown ? UNKNOWN_HEALTH_FACTOR : 1 + healthPct / 100);
  return {
    side, def, index, count, healthUnknown: unknown,
    s: strengthPct / 100,
    tags: new Set(def.tags),
    vs: Object.entries(def.vs || {}).map(([tag, pct]) => [tag, pct / 100]),
    siegeEngine: !!def.siegeEngine,
    uhp,
    pool: count * uhp,
    taken: 0,
  };
}

function alive(st) {
  return st.pool <= 1e-6 ? 0 : Math.ceil(st.pool / st.uhp - 1e-9);
}

/** Turn order: units × strength × (1 + bonus). Features play no part. */
function strength(st) {
  return alive(st) * st.def.str * (1 + st.s);
}

function damageVs(actor, target) {
  let bonus = actor.s;
  for (const [tag, v] of actor.vs) if (target.tags.has(tag)) bonus += v;
  const d = alive(actor) * actor.def.str * (1 + bonus);
  return actor.siegeEngine && target.tags.has('fortification') ? d * 20 : d;
}

/** Most damage dealt (capped at what is left); ties → whoever hits back hardest. */
function pickTarget(actor, enemies, exclude = null) {
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

function strongestUnacted(stacks, acted) {
  let best = null;
  for (const s of stacks) {
    if (acted.has(s) || alive(s) === 0) continue;
    if (!best || strength(s) > strength(best)) best = s;
  }
  return best;
}

/**
 * Simulate one attack.
 * @param {object} p
 * @param {string} p.citadelId   e.g. 'elven-30'
 * @param {{troopId:string,count:number,strengthPct?:number,healthPct?:number|null}[]} p.army
 *        healthPct null = not entered (see UNKNOWN_HEALTH_FACTOR)
 * @param {'you'|'citadel'} p.opener  who opens the first battle round
 * @param {Record<number,{double?:boolean,second?:boolean}>} [p.luck]  1-based action number → luck rolls (tests)
 */
export function simulate({ citadelId, army, opener = 'citadel', luck = {} }) {
  const citadel = citadelById(citadelId);
  if (!citadel) throw new Error(`unknown citadel ${citadelId}`);
  const mine = [];
  army.forEach((row, index) => {
    const def = troopById(row.troopId);
    const n = Math.max(0, Math.floor(Number(row.count) || 0));
    const health = row.healthPct === null || row.healthPct === undefined || row.healthPct === '' ? null : Number(row.healthPct) || 0;
    if (def && n > 0) mine.push(makeStack('you', def, n, Number(row.strengthPct) || 0, health, index));
  });
  const theirs = citadel.units.map(([id, n], index) => makeStack('citadel', DEFENDERS[id], n, 0, 0, index));
  const walls = citadel.walls > 0 ? makeStack('citadel', DEFENDERS.walls, citadel.walls, 0, 0, -1) : null;

  const strikes = [];
  let action = 0;
  const hit = (actor, target, phase, round) => {
    action += 1;
    const roll = luck[action] || {};
    const mult = roll.double ? 2 : 1;
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
    record(target, Math.min(damageVs(actor, target) * mult, target.pool), false);
    if (roll.second) {
      const pool = actor.side === 'you' ? (phase === 'siege' ? [] : theirs) : mine;
      const t2 = pickTarget(actor, pool, target);
      if (t2) record(t2, Math.min(damageVs(actor, t2) * mult, t2.pool), true);
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
    let first = opener === 'you' ? 'you' : 'citadel';
    const sides = { you: mine, citadel: theirs };
    battle: for (let r = 1; r <= MAX_BATTLE_ROUNDS; r++) {
      rounds = r;
      const acted = new Set();
      let side = first;
      let last = null;
      for (;;) {
        const other = side === 'you' ? 'citadel' : 'you';
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
      first = last === 'you' ? 'citadel' : 'you';
    }
    if (!won && !reason) reason = 'rounds';
  }

  return {
    citadelId,
    opener,
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

/** Both coin-flip outcomes for the same army. */
export function simulateBoth(params) {
  return { you: simulate({ ...params, opener: 'you' }), citadel: simulate({ ...params, opener: 'citadel' }) };
}

// ─── Automatic counts: search with the simulator itself ───────────

/** Automatic counts must still win with every bonus this much lower. */
export const SAFETY = 0.03;

/** Monsters and mercenaries are never traded for cheaper losses: a setup that
 *  loses even one of them ranks below every setup that loses only guardsmen,
 *  specialists or siege engines, however many. The first striker is there to
 *  absorb the losses; these are not. */
export const PROTECTED_GROUPS = new Set(['monsters', 'mercenaries']);

/** Expected losses of a setup (the mean of both coin flips), split into the
 *  protected kinds and the rest. Each lost troop is worth its base health, so one
 *  Wyvern (2.07M) weighs about eleven Corax I (183.6k) and losing cheap low-tier
 *  units is cheap. */
function lossValue(both) {
  let rest = 0;
  let prot = 0;
  for (const res of [both.you, both.citadel]) {
    for (const s of res.army) {
      const def = troopById(s.troopId);
      if (PROTECTED_GROUPS.has(def.group)) prot += s.lost * def.hp;
      else rest += s.lost * def.hp;
    }
  }
  return { prot: prot / 2, rest: rest / 2 };
}

/**
 * Counts that win in BOTH coin-flip outcomes with the fewest expected losses,
 * for the troop types and bonuses given (any citadel). A local search over
 * each row's count, trying the breakpoints where a stack's damage crosses a
 * defender's health — the counts where its target can change — plus plain
 * nudges. Deterministic. Rows whose health is unknown are searched at 0% health
 * (pessimistic); the page asks for it if that stack ends up being hit.
 *
 * Every candidate must also win with all your bonuses SAFETY lower (a misread
 * card, a captain left behind), and its losses are averaged over both — so the
 * search can't settle on a count that only works to the last unit.
 *
 * @param {{ citadelId: string, army: {troopId: string, count?: number, strengthPct?: number|null, healthPct?: number|null}[], budget?: number, starts?: number[][] }} p
 *        starts: extra starting counts (game01master's, the player's own)
 * @returns {{ ok: boolean, counts: number[], both: any, evaluations: number }}
 */
export function optimizeCounts({ citadelId, army, budget = 2500, starts = [] }) {
  const citadel = citadelById(citadelId);
  if (!citadel || !army.length) return { ok: false, counts: army.map(() => 0), both: null, evaluations: 0 };
  const rows = army.map((r) => ({ ...r, healthPct: r.healthPct ?? 0 }));
  // The same army with every bonus SAFETY lower (on the multiplier, 1 + bonus).
  const lower = (pct) => ((1 + (Number(pct) || 0) / 100) * (1 - SAFETY) - 1) * 100;
  const weaker = rows.map((r) => ({ ...r, strengthPct: lower(r.strengthPct), healthPct: lower(r.healthPct) }));
  const defs = rows.map((r) => troopById(r.troopId));
  const targets = [
    ...citadel.units.map(([id, n]) => ({ def: DEFENDERS[id], n })),
    ...(citadel.walls ? [{ def: DEFENDERS.walls, n: citadel.walls }] : []),
  ];
  /** Damage of ONE unit of row i against a full defender stack. */
  const perUnit = (i, target) => {
    const tgt = makeStack('citadel', target.def, 1);
    const me = makeStack('you', defs[i], 1, Number(rows[i].strengthPct) || 0, 0);
    return damageVs(me, tgt);
  };

  let evaluations = 0;
  const evaluate = (counts) => {
    evaluations += 1;
    const both = simulateBoth({ citadelId, army: rows.map((r, i) => ({ ...r, count: counts[i] })) });
    const weak = simulateBoth({ citadelId, army: weaker.map((r, i) => ({ ...r, count: counts[i] })) });
    const won = both.you.won && both.citadel.won && weak.you.won && weak.citadel.won;
    const left = [both.you, both.citadel, weak.you, weak.citadel].reduce((a, res) => a + res.defenders.reduce((x, d) => x + d.alive, 0), 0);
    const power = counts.reduce((a, n, i) => a + n * defs[i].str * (1 + (Number(rows[i].strengthPct) || 0) / 100), 0);
    const l = lossValue(both);
    const w = lossValue(weak);
    const prot = won ? (l.prot + w.prot) / 2 : Infinity;
    const loss = won ? (l.rest + w.rest) / 2 : Infinity;
    return { counts: [...counts], both, won, prot, loss, left, power };
  };
  // Win first; then the fewest monster/mercenary losses; then the fewest other
  // losses; then the smaller army (less strength sent).
  const better = (a, b) => {
    if (a.won !== b.won) return a.won;
    if (!a.won) return a.left < b.left || (a.left === b.left && a.power < b.power);
    if (Math.abs(a.prot - b.prot) > 1e-6) return a.prot < b.prot;
    if (Math.abs(a.loss - b.loss) > 1e-6) return a.loss < b.loss;
    return a.power < b.power - 1e-6;
  };

  // Start: every stack big enough to one-shot the biggest defender stack (siege
  // engines: the walls), then double everything until both outcomes are won.
  const biggest = targets.filter((x) => x.def.id !== 'walls').reduce((m, x) => Math.max(m, x.n * x.def.hp), 0);
  const wallHp = citadel.walls * DEFENDERS.walls.hp;
  let start = rows.map((r, i) => {
    const want = defs[i].siegeEngine && citadel.walls ? wallHp : biggest;
    const best = Math.max(...targets.filter((x) => (defs[i].siegeEngine ? x.def.id === 'walls' : x.def.id !== 'walls')).map((x) => perUnit(i, x)), 1);
    return Math.max(1, Math.ceil(want / best));
  });
  let best = evaluate(start);
  for (let k = 0; k < 8 && !best.won; k++) {
    start = start.map((n) => n * 2);
    const next = evaluate(start);
    if (better(next, best)) best = next;
  }
  for (const s of starts) {
    if (!Array.isArray(s) || s.length !== rows.length || !s.every((n) => Number.isInteger(n) && n >= 0)) continue;
    const cand = evaluate(s);
    if (better(cand, best)) best = cand;
  }
  if (!best.won) return { ok: false, counts: best.counts, both: best.both, evaluations };

  // Breakpoints per row: counts where its damage just reaches each defender's health.
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
      for (const c of cands) {
        if (c < 0 || c === n || c > 1e8 || evaluations >= budget) continue;
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
