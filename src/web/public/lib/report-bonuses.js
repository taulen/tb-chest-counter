// Troop bonuses from shared battle reports (docs/battle-reports.md): GET
// /api/tools/report-armies sends what the game measured in each battle —
// every troop's units, base stats, its card as the march's own effects add it
// up, its health per unit and every strike it made — and this works out the
// card bonuses Tools → Citadel and → Stacks ask for. Plain ES module: no DOM,
// no fetching (the pages ask the server).
//
//  - The card: the march's effects (research, captains, gear, artifacts,
//    running boosts — troop-effects.ts) summed for the troop, plus ONE
//    army-wide amount the report doesn't carry (the clan's research: +100% /
//    +115% on Nov 7 2026), measured from a troop the battle shows exactly:
//    what it shows minus its effects' sum (reportGaps). Every troop of the
//    army gets its card that way, those whose strikes all killed their
//    target too. Checked on four cards (Corax I 5226.5% / 3936.8%, Royal Lion
//    I, Battle Griffin VI, Siege Ballistae VII 2277% / 1616.8%).
//  What a battle shows exactly:
//  - Health: health per unit ÷ the troop's base health − 1. Exact: the game
//    logs a stack's whole health pool, and on its first hit that is units ×
//    unit health. "vs" features never touch health.
//  - Strength, from a strike the game logged in full: damage = units ×
//    strength × M, M = 1 + bonus + features. The log's extraA is the share of
//    the damage the features made (damage × features ÷ M — Phoenix I on a
//    Bear: the same 7.01 / 45.375 for 26 units and for 1), so
//        bonus = M × (1 − extraA ÷ damage) − 1
//    with no feature table at all: it holds against the Tin Man, epics or a
//    citadel alike (and against a player's own "vs mounted" research, which
//    the simulator's troop data doesn't know). M comes from the base damage:
//    extraB when the strike doubled (the damage before the luck), else the
//    damage of a strike the target survived. A strike that killed its target
//    without doubling logged only what that took: no M.
//  - Strength of a siege engine from a hit on the walls, killed or not: there
//    M = 20 × (1 + bonus + f), f its "vs fortification" feature
//    (citadel-sim.js), so with s = 1 − extraA ÷ damage:
//        1 + bonus = 20·f·s ÷ (1 − 20·s)
//    (Ballistae VII: 2277% on Nov 7, 2229% on Nov 5 — the typed cards).
//
// A troop the picked battle can't show is taken from the same player's other
// battles within GAP_WINDOW_MS, nearest first (withGapsFilled); the page says
// which. The Nov 7 2026 Elven 30 report gives back the user's card bonuses.

import { TROOPS, DEFENDERS } from './citadel-sim.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Full precision: the card shows one decimal (3936.8), the game uses 3936.75 —
// at a citadel's breakpoints the difference is troops. Two decimals hold every
// effect sum (multiples of 0.05) and drop only float noise from the measured ones.
const exact = (x) => Math.round(x * 100) / 100;

/** A siege engine strikes fortifications ×20 (citadel-sim.js damageVs). */
const SIEGE_VS_WALLS = 20;
/** Bonuses change with every captain swap: gaps are only filled from battles this close to the picked one. */
export const GAP_WINDOW_MS = 24 * 3_600_000;

/** A report unit's calculator troop: same game name and base stats (as the troop icons match), else the only troop of that name. */
export function troopForUnit(u, troops = TROOPS) {
  const named = troops.filter((t) => norm(t.name) === norm(u.name));
  return named.find((t) => t.str === u.strength && t.hp === u.health) ?? (named.length === 1 ? named[0] : null);
}

function isWalls(u) {
  return Object.values(DEFENDERS).some((d) => d.tags.includes('fortification') && norm(d.name) === norm(u.name));
}

/** The strength bonus (as a fraction) a strike shows, or null when it can't say. */
export function strikeBonus(troop, s) {
  if (!troop?.str || !s.count || !(s.damage > 0)) return null;
  const share = 1 - (s.extraA > 0 ? s.extraA / s.damage : 0);
  if (troop.siegeEngine && isWalls(s.target)) {
    const f = (troop.vs?.fortification ?? 0) / 100;
    const d = 1 - SIEGE_VS_WALLS * share;
    if (!(f > 0) || !(d > 0)) return null;
    return (SIEGE_VS_WALLS * f * share) / d - 1;
  }
  const base = s.extraB > 0 ? s.extraB : s.capped ? 0 : s.damage;
  if (!(base > 0)) return null;
  return (base / (s.count * troop.str)) * share - 1;
}

/** Per troop: its card's effects sum (or null) and what the battle shows of it exactly (percent, or null). */
function readings(report, troops) {
  const out = [];
  for (const tr of report?.troops ?? []) {
    const troop = troopForUnit(tr, troops);
    if (!troop) continue;
    const health = tr.unitHealth && troop.hp ? (tr.unitHealth / troop.hp - 1) * 100 : null;
    let strength = null;
    for (const s of tr.strikes ?? []) {
      const b = strikeBonus(troop, s);
      if (b === null || !Number.isFinite(b)) continue;
      strength = b * 100;
      break;
    }
    out.push({ troop, card: tr.card ?? null, strength, health });
  }
  return out;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The army-wide amount a report's effects don't carry — what the battle shows
 * of a troop minus its effects' sum — for strength and health; null when the
 * battle shows neither for any troop with a card.
 */
export function reportGaps(report, troops = TROOPS) {
  const rs = readings(report, troops).filter((r) => r.card);
  return {
    strength: median(rs.filter((r) => r.strength !== null).map((r) => r.strength - r.card.strength)),
    health: median(rs.filter((r) => r.health !== null).map((r) => r.health - r.card.health)),
  };
}

/**
 * troopId → { strengthPct, healthPct } (each null when the report can't say)
 * from one report army: what the battle shows exactly, else the card (its
 * effects' sum + the army-wide gap — this report's, or `gaps` handed in).
 */
export function bonusesFromReport(report, troops = TROOPS, gaps = reportGaps(report, troops)) {
  const out = new Map();
  for (const r of readings(report, troops)) {
    const strength = r.strength !== null ? r.strength
      : r.card && gaps.strength !== null ? r.card.strength + gaps.strength : null;
    const health = r.health !== null ? r.health
      : r.card && gaps.health !== null ? r.card.health + gaps.health : null;
    if (strength === null && health === null) continue;
    out.set(r.troop.id, { strengthPct: strength === null ? null : exact(strength), healthPct: health === null ? null : exact(health) });
  }
  return out;
}

/**
 * The picked battle's bonuses. When it shows nothing to measure the army-wide
 * gap from, the gap comes from the same army's nearest battle within
 * GAP_WINDOW_MS (`gapsFrom`); a troop it still can't give (no card) is taken
 * from those battles, nearest first (`borrowed`: { report, troopIds }).
 */
export function withGapsFilled(picked, reports, troops = TROOPS) {
  const at = Date.parse(picked?.at);
  const owner = picked?.attacker?.playerId ?? null;
  const near = (reports ?? [])
    .filter((r) => r !== picked && r.entryId !== picked?.entryId && (r.attacker?.playerId ?? null) === owner)
    .filter((r) => Math.abs(Date.parse(r.at) - at) <= GAP_WINDOW_MS)
    .sort((a, b) => Math.abs(Date.parse(a.at) - at) - Math.abs(Date.parse(b.at) - at));
  let gaps = reportGaps(picked, troops);
  let gapsFrom = null;
  for (const r of near) {
    if (gaps.strength !== null && gaps.health !== null) break;
    const g = reportGaps(r, troops);
    if (gaps.strength === null && g.strength !== null) { gaps = { ...gaps, strength: g.strength }; gapsFrom = gapsFrom ?? r; }
    if (gaps.health === null && g.health !== null) { gaps = { ...gaps, health: g.health }; gapsFrom = gapsFrom ?? r; }
  }
  const found = bonusesFromReport(picked, troops, gaps);
  const borrowed = [];
  for (const r of near) {
    const ids = new Set();
    for (const [id, v] of bonusesFromReport(r, troops)) {
      const mine = found.get(id) ?? { strengthPct: null, healthPct: null };
      let took = false;
      if (mine.strengthPct === null && v.strengthPct !== null) { mine.strengthPct = v.strengthPct; took = true; }
      if (mine.healthPct === null && v.healthPct !== null) { mine.healthPct = v.healthPct; took = true; }
      if (took) {
        found.set(id, mine);
        ids.add(id);
      }
    }
    if (ids.size) borrowed.push({ report: r, troopIds: [...ids] });
  }
  return { found, borrowed, gapsFrom };
}
