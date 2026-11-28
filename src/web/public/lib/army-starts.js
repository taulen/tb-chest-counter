// Learned starting points for the count search (Tools → Monsters, Tools →
// Citadel): the best armies found offline for other players' armies against
// the same target, carried over to this army. Raw counts don't carry over —
// bonuses, caps and troop sets differ — so each row of a known answer is kept
// as what it does (docs/monster-simulator.md, "Learned starts"):
//   'k'  the share of one enemy stack's health its strike takes (a killer
//        sized for that stack: counts = share × stack health ÷ one unit's hit);
//        a killer with units to spare also keeps those as hits of that stack
//        it can take (a fifth number), sized by health,
//   'h'  how many of that stack's full strikes it can take (a stack sized to
//        absorb a hit: counts = share × the hit ÷ one unit's health),
//   'n'  a plain count (one to three units: a sponge or a single monster).
// The search only starts from these: it still plays every candidate, and a
// start that no longer fits (a patch changed the target, a troop is missing)
// just scores worse than the others. No entry: today's search.
//
// Plain ESM, no DOM access.

import { damageVs, makeStack, simulateBothArmies } from './battle-sim.js';

/** Units of a row (its own bonuses) that one strike of theirs is worth against a full enemy stack: damage of one unit. */
const perUnit = (row, foe, enemySide) => damageVs(makeStack('you', row.def, 1, Number(row.strengthPct) || 0, 0), makeStack(enemySide, foe.def, 1));
/** One full strike of an enemy stack on one unit of the row, and that unit's health. */
const hitOn = (row, foe, enemySide) => damageVs(makeStack(enemySide, foe.def, foe.count), makeStack('you', row.def, 1, 0, Number(row.healthPct) || 0));
const unitHp = (row) => row.def.hp * (1 + (Number(row.healthPct) || 0) / 100);
const pool = (foe) => foe.count * foe.def.hp;
/** Six significant digits: a count up to ~100,000 comes back exact (breakpoints are to the unit). */
const sig = (v) => Number(v.toPrecision(6));

/**
 * A known answer as transferable roles: [[unitKey, mode, stack, value], …] for
 * each row sent. Read from both coin flips at the bonuses as typed: a row's
 * first strike names the enemy stack it is sized for; a row that never
 * strikes but is hit is sized for the first strike on it.
 * @param {{ army: any[], enemy: any[], counts: number[], enemySide?: string }} p  rows {def, strengthPct, healthPct}; enemy {def, count}
 */
export function rolesOf({ army, enemy, counts, enemySide = 'enemy' }) {
  const foes = enemy.filter((e) => e.def && e.count > 0);
  const both = simulateBothArmies({ mine: army.map((r, i) => ({ ...r, healthPct: r.healthPct ?? 0, count: counts[i], index: i })), theirs: foes, enemySide });
  const out = [];
  counts.forEach((c, i) => {
    if (!(c > 0)) return;
    const key = army[i].def.id;
    if (c <= 3) { out.push([key, 'n', 0, c]); return; }
    let first = null;
    let hitBy = null;
    for (const res of [both[enemySide], both.you]) {
      for (const st of res.strikes) {
        if (!first && st.side === 'you' && st.actor === key) first = foes.findIndex((f) => f.def.id === st.target);
        if (!hitBy && st.side !== 'you' && st.target === key) hitBy = foes.findIndex((f) => f.def.id === st.actor);
      }
      if (first !== null) break;
    }
    if (first !== null && first >= 0) {
      const foe = foes[first];
      const per = perUnit(army[i], foe, enemySide);
      const role = [key, 'k', first, sig((c * per) / pool(foe))];
      // More units than the kill needs: the rest are there to take that stack's strike (game01master's
      // first striker) — kept apart, as hits absorbed, so they scale with health rather than strength.
      const kill = Math.ceil(pool(foe) / per - 1e-9);
      if (c > kill + 1) role.push(sig(((c - kill) * unitHp(army[i])) / hitOn(army[i], foe, enemySide)));
      out.push(role);
    }
    else if (hitBy !== null && hitBy >= 0) out.push([key, 'h', hitBy, sig((c * unitHp(army[i])) / hitOn(army[i], foes[hitBy], enemySide))]);
    else out.push([key, 'n', 0, c]);
  });
  return out;
}

/**
 * Where each enemy stack the answers name is now: their stack j is this
 * enemy's stack at (j); a patch that moved or replaced stacks maps by unit
 * (the k-th stack of that unit), and a unit that is gone maps nowhere.
 */
function stackMap(enemyIds, foes) {
  if (!Array.isArray(enemyIds)) return (j) => j;
  const at = enemyIds.map((id, j) => {
    if (String(foes[j]?.def.id) === String(id)) return j;
    const nth = enemyIds.slice(0, j).filter((x) => String(x) === String(id)).length;
    const hits = foes.map((f, k) => (String(f.def.id) === String(id) ? k : -1)).filter((k) => k >= 0);
    return hits[nth] ?? hits[0] ?? -1;
  });
  return (j) => at[j] ?? -1;
}

/** A count from a role, for this army's row (its bonuses) against this enemy; null when it can't be read. */
function countFor(role, row, foes, enemySide, where = (j) => j) {
  const [, mode, j, v] = role;
  if (mode === 'n') return v;
  const foe = foes[where(j)];
  if (!foe) return null;
  if (mode === 'k' && role.length > 4) {
    // A killer that also absorbs: the kill at this army's strength, plus the hits at its health.
    const kill = Math.ceil(pool(foe) / perUnit(row, foe, enemySide) - 1e-9);
    const extra = (role[4] * hitOn(row, foe, enemySide)) / unitHp(row);
    return Number.isFinite(kill) && Number.isFinite(extra) ? kill + Math.round(extra) : null;
  }
  const x = mode === 'k' ? (v * pool(foe)) / perUnit(row, foe, enemySide) : (v * hitOn(row, foe, enemySide)) / unitHp(row);
  if (!Number.isFinite(x) || x < 0) return null;
  // A whole number to the last digit kept is that number (the same army gets its own counts back).
  const r = Math.round(x);
  return Math.abs(x - r) <= Math.max(1e-6, x * 1e-5) ? r : Math.ceil(x);
}

/** An army's bonus level: its median strength bonus in hundreds of % (rounded), for matching answers of armies like it. */
export function bonusLevel(army) {
  const s = army.map((r) => Number(r.strengthPct) || 0).sort((a, b) => a - b);
  return s.length ? Math.round(s[s.length >> 1] / 100) : 0;
}

/** The troop "line" a unit belongs to for stand-ins: its kind and how it fights. */
export const lineOf = (def) => [def.kind ?? def.group ?? '', ['melee', 'ranged', 'mounted', 'flying', 'siege', 'scout'].filter((t) => (def.tags ?? []).includes(t)).join('+')].join(':');

/**
 * Starting counts for this army from a target's known answers, best match
 * first: answers whose troops this army has (by share of their rows), then
 * those of a level like the army's. A troop the army lacks is stood in for by
 * one of its own of the same kind and way of fighting (the nearest tier), not
 * already used. Rows no answer names start at 0.
 * @param {{ exemplars: any[], enemyIds?: any[]|null, army: any[], enemy: any[], enemySide?: string, tier?: number|null, max?: number, defOf?: ((key: string) => any)|null }} p
 *        army: rows {def, strengthPct, healthPct, cap}; enemy: {def, count}; exemplars: [{t?, b?, r: roles}]
 *        enemyIds: the enemy's units, stack by stack, when the answers were found (a patch may have changed them);
 *        defOf: a unit's def by its key (to find a stand-in for a troop the army lacks); none: no stand-ins
 * @returns {number[][]}
 */
export function startsFrom({ exemplars, enemyIds = null, army, enemy, enemySide = 'enemy', tier = null, max = 3, defOf = null }) {
  const standIns = typeof defOf === 'function';
  if (!Array.isArray(exemplars) || !exemplars.length || !army.length) return [];
  const foes = enemy.filter((e) => e.def && e.count > 0);
  const where = stackMap(enemyIds, foes);
  const rowOf = new Map(army.map((r, i) => [String(r.def.id), i]));
  const caps = army.map((r) => (Number.isFinite(r.cap) && r.cap >= 0 ? Math.floor(r.cap) : Infinity));
  // The army's bonus level (its median strength bonus, in hundreds of %) to compare with each answer's `b`.
  const level = bonusLevel(army);
  // How much of an answer this army can play: its own troops count whole, a stand-in of the same line nearly so.
  const lines = standIns ? new Set(army.map((r) => lineOf(r.def))) : null;
  const playable = ([k]) => {
    if (rowOf.has(String(k))) return 1;
    const d = lines ? defOf(String(k)) : null;
    return d && lines.has(lineOf(d)) ? 0.9 : 0;
  };
  const ranked = exemplars
    .map((ex) => {
      const have = ex.r.reduce((a, role) => a + playable(role), 0) / Math.max(1, ex.r.length);
      return { ex, have, near: tier === null || ex.t === undefined ? 0 : Math.abs(ex.t - tier), like: ex.b === undefined ? 0 : Math.abs(ex.b - level) };
    })
    .sort((a, b) => b.have - a.have || a.near - b.near || a.like - b.like);
  const out = [];
  const seen = new Set();
  // Different shapes first: an answer that sizes the same lines for the same enemy stacks as one
  // already taken waits until every other shape has had its turn (a new army can start in either basin).
  const shapeOf = (ex) => ex.r.map(([k, mode, j]) => {
    const d = rowOf.has(String(k)) ? army[rowOf.get(String(k))].def : standIns ? defOf(String(k)) : null;
    return `${d ? lineOf(d) : k}:${mode}${mode === 'n' ? '' : j}`;
  }).sort().join('|');
  const shapes = new Set();
  const firstOfShape = [];
  const later = [];
  for (const x of ranked) {
    const k = shapeOf(x.ex);
    if (shapes.has(k)) later.push(x);
    else { shapes.add(k); firstOfShape.push(x); }
  }
  for (const { ex } of [...firstOfShape, ...later]) {
    if (out.length >= max) break;
    const counts = army.map(() => 0);
    const taken = new Set();
    const placeLater = [];
    for (const role of ex.r) {
      const i = rowOf.get(String(role[0]));
      if (i === undefined || taken.has(i)) { placeLater.push(role); continue; }
      const c = countFor(role, army[i], foes, enemySide, where);
      if (c === null) continue;
      counts[i] = Math.min(caps[i], c);
      taken.add(i);
    }
    if (standIns) {
      for (const role of placeLater) {
        const want = defOf(String(role[0]));
        if (!want) continue;
        const line = lineOf(want);
        let best = -1;
        army.forEach((r, i) => {
          if (taken.has(i) || lineOf(r.def) !== line) return;
          if (best < 0 || Math.abs((r.def.tier ?? 0) - (want.tier ?? 0)) < Math.abs((army[best].def.tier ?? 0) - (want.tier ?? 0))) best = i;
        });
        if (best < 0) continue;
        const c = countFor(role, army[best], foes, enemySide, where);
        if (c === null) continue;
        counts[best] = Math.min(caps[best], c);
        taken.add(best);
      }
    }
    const key = counts.join(',');
    if (!counts.some((c) => c > 0) || seen.has(key)) continue;
    seen.add(key);
    out.push(counts);
  }
  return out;
}

/**
 * The known answers for a target — { exemplars, enemyIds } for startsFrom —
 * its own entry, else the same family's nearest level that has one (levels of
 * a family share their troops and scale their counts, and the roles are
 * shares, so they carry over). Empty when there are none.
 * @param {any} lib  the data file: { targets: { [key]: {e, x} }, families?: { [name]: [[level, key]…] } }
 * @param {string} key  the target's key (its first T7 id)
 * @param {string|null} [family]  the target's name
 * @param {number|null} [level]
 * @returns {{ exemplars: any[], enemyIds: any[]|null }}
 */
export function exemplarsFor(lib, key, family = null, level = null) {
  const none = { exemplars: [], enemyIds: null };
  const entry = (k) => {
    const e = lib?.targets?.[k];
    return e?.x?.length ? { exemplars: e.x, enemyIds: e.e ?? null } : null;
  };
  const own = entry(key);
  if (own) return own;
  const fam = family ? lib?.families?.[family] : null;
  if (!fam?.length || level === null) return none;
  let best = null;
  for (const [lvl, k] of fam) if (entry(k) && (!best || Math.abs(lvl - level) < Math.abs(best[0] - level))) best = [lvl, k];
  return best ? entry(best[1]) : none;
}

/**
 * A citadel's known answers ({ exemplars, enemyIds }) from the data file.
 * @param {any} lib
 * @param {string} citadelId
 * @returns {{ exemplars: any[], enemyIds: any[]|null }}
 */
export function citadelExemplars(lib, citadelId) {
  const e = lib?.citadels?.[citadelId];
  return e?.x?.length ? { exemplars: e.x, enemyIds: e.e ?? null } : { exemplars: [], enemyIds: null };
}

/**
 * The data file's format; a file of another format is not used. In the file
 * a role is short — [unit, "k3", share, hits?] (mode and enemy stack in one
 * string, four significant digits: a start a unit or two off is fine, the
 * search plays on from it); decodeArmyStarts turns it back into the
 * [unit, mode, stack, value, hits?] the functions above read.
 */
export const ARMY_STARTS_FORMAT = 2;
let loading = null;

const sig4 = (v) => Number(v.toPrecision(4));
/**
 * One role in the file's short form.
 * @param {any[]} role  [unit, mode, stack, value, hits?]
 */
export function encodeRole([key, mode, j, v, extra]) {
  const out = [key, mode === 'n' ? 'n' : `${mode}${j}`, mode === 'n' ? v : sig4(v)];
  if (extra !== undefined) out.push(sig4(extra));
  return out;
}
/**
 * One role back from the file's short form.
 * @param {any[]} short  [unit, "k3", value, hits?]
 */
export function decodeRole([key, code, v, extra]) {
  const mode = String(code)[0];
  const role = [key, mode, mode === 'n' ? 0 : Number(String(code).slice(1)) || 0, v];
  if (extra !== undefined) role.push(extra);
  return role;
}
/** The data file as the functions above read it (roles decoded); null for a file of another format. */
export function decodeArmyStarts(raw) {
  if (raw?.v !== ARMY_STARTS_FORMAT) return null;
  const entry = (e) => ({ ...e, x: (e?.x ?? []).map((x) => ({ ...x, r: (x.r ?? []).map(decodeRole) })) });
  const map = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, e]) => [k, entry(e)]));
  return { ...raw, targets: map(raw.targets), citadels: map(raw.citadels) };
}

/**
 * The learned starts (data/army-starts.json, built offline — see
 * docs/monster-simulator.md for how to rebuild it after a patch). Its URL is
 * built from this module's, so it carries the page's /v/<build>/ prefix like
 * every asset. Null when it can't be loaded: the search then runs as before.
 */
export function loadArmyStarts() {
  if (!loading) {
    loading = (async () => {
      try {
        const res = await fetch(new URL('../data/army-starts.json', import.meta.url));
        return res.ok ? decodeArmyStarts(await res.json()) : null;
      } catch {
        return null;
      }
    })();
  }
  return loading;
}
