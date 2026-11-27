// Troop bonuses from the player's own battle reports (docs/battle-reports.md):
// GET /api/tools/report-armies sends what the game measured in each battle —
// every troop's units, base stats, health per unit and the base damage of its
// strikes — and this works out the card bonuses Tools → Citadel and → Stacks
// ask for. Plain ES module: no DOM, no fetching (the pages ask the server).
//
//  - Health: health per unit ÷ the troop's base health − 1. Exact: the game
//    logs a stack's whole health pool, and on its first hit that is units ×
//    unit health. "vs" features never touch health.
//  - Strength: a strike's base damage = units × strength × (1 + bonus +
//    matching "vs" features) (docs/citadel-simulator.md), so bonus = base ÷
//    (units × strength) − 1 − features. Features are known for the citadels'
//    defenders; against anything else only a troop with no features counts.
//    Hits on the walls are left out (siege rules of their own).
//
// The Nov 7 2026 Elven 30 report gives back the user's card bonuses: Corax I
// 5226.5% strength, 3936.8% health.

import { TROOPS, DEFENDERS } from './citadel-sim.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const round1 = (x) => Math.round(x * 10) / 10;

/** A report unit's calculator troop: same game name and base stats (as the troop icons match), else the only troop of that name. */
export function troopForUnit(u, troops = TROOPS) {
  const named = troops.filter((t) => norm(t.name) === norm(u.name));
  return named.find((t) => t.str === u.strength && t.hp === u.health) ?? (named.length === 1 ? named[0] : null);
}

function defenderFor(u) {
  return Object.values(DEFENDERS).find((d) => norm(d.name) === norm(u.name) && d.str === u.strength && d.hp === u.health) ?? null;
}

/** The "vs" features of a troop that apply to a target, as a fraction (+667% → 6.67); null when the target is unknown and the troop has features. */
function featuresVs(troop, target) {
  const vs = Object.entries(troop.vs || {});
  const def = defenderFor(target);
  if (!def) return vs.length ? null : 0;
  if (def.tags.includes('fortification')) return null;
  return vs.filter(([tag]) => def.tags.includes(tag)).reduce((a, [, pct]) => a + pct / 100, 0);
}

/** troopId → { strengthPct, healthPct } (each null when the report can't say) from one report army. */
export function bonusesFromReport(report, troops = TROOPS) {
  const out = new Map();
  for (const tr of report?.troops ?? []) {
    const troop = troopForUnit(tr, troops);
    if (!troop) continue;
    const healthPct = tr.unitHealth && troop.hp ? round1((tr.unitHealth / troop.hp - 1) * 100) : null;
    let strengthPct = null;
    for (const s of tr.strikes ?? []) {
      const feat = featuresVs(troop, s.target);
      if (feat === null || !s.count || !troop.str) continue;
      strengthPct = round1((s.base / (s.count * troop.str) - 1 - feat) * 100);
      break;
    }
    if (healthPct !== null || strengthPct !== null) out.set(troop.id, { strengthPct, healthPct });
  }
  return out;
}
