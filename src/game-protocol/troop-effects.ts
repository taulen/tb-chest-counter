/**
 * What a troop card adds up: every effect's strength and health lines with the
 * units they reach (T20), built beside names.json as troop-effects.json once
 * per game patch (static-data.ts), read for battle reports' armies
 * (data/report-armies.ts, docs/battle-reports.md).
 *
 * A battle report's march carries every effect active on it (field 14, the
 * city-record format `[effectId, sourceBits, count]` — research, captains,
 * gear, artifacts…) and its timed boosts (field 16). The game draws a troop's
 * card from them: the sum of the strength (kind 4) and health (kind 5) lines
 * whose target list holds the troop's unit id (empty = every unit). Checked on
 * Nov 27 2026 against four cards: the sum is the card minus one army-wide
 * amount the report doesn't carry (+100% / +115% that day — clan research),
 * which the page measures from a troop the battle shows exactly
 * (lib/report-bonuses.js).
 *
 * Only lines of the general condition count: 45,239 of the 46,369 strength and
 * health lines carry one condition set (2786 on Nov 27 2026); the rest (1,120
 * of 71285, a few others) are situational and not on the card. The general
 * set is found by majority, so a patch renumbering it changes nothing.
 *
 * Pure.
 */
import type { Wire } from './codec.js';

export const TROOP_EFFECTS_FILE = 'troop-effects.json';
/** Bump when the file's shape changes. */
export const TROOP_EFFECTS_FORMAT = 1;
export const KIND_STRENGTH = 4;
export const KIND_HEALTH = 5;

export interface TroopEffects {
  format: number;
  /** names.json's version key: the static data it was built from. */
  version: string;
  /** Unit-id lists the lines aim at; a line's target is an index here, -1 = every unit. */
  targets: number[][];
  /** Effect id → its strength / health lines: [kind, target index or -1, percent]. */
  effects: Record<string, Array<[number, number, number]>>;
}

const isLine = (e: Wire): e is Wire[] => Array.isArray(e);
const condKey = (e: Wire[]): string => JSON.stringify(Array.isArray(e[3]) ? e[3] : []);
const percent = (e: Wire[]): number => (typeof e[5] === 'number' && e[5] !== 0 ? (e[5] - 10000) / 100 : 0);

/** The table from T20 (rows `[…, …, …, lines]`, a line `[kind, targetVec, [], [cond], 0, value ×10000, flat]`). */
export function buildTroopEffects(
  t20: Record<string, Wire>,
  vec: (ref: Wire) => Wire[] | undefined,
  version: string,
): TroopEffects {
  const linesOf = (row: Wire): Wire[][] => (Array.isArray(row) && Array.isArray(row[3]) ? row[3].filter(isLine) : [])
    .filter((e) => e[0] === KIND_STRENGTH || e[0] === KIND_HEALTH);
  const counts = new Map<string, number>();
  for (const row of Object.values(t20)) for (const e of linesOf(row)) counts.set(condKey(e), (counts.get(condKey(e)) ?? 0) + 1);
  const general = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '[]';
  const targets: number[][] = [];
  const targetIndex = new Map<string, number>();
  const effects: TroopEffects['effects'] = {};
  for (const [id, row] of Object.entries(t20)) {
    const out: Array<[number, number, number]> = [];
    for (const e of linesOf(row)) {
      const cond = condKey(e);
      if (cond !== general && cond !== '[]') continue;
      const pct = percent(e);
      if (!pct) continue;
      const units = (vec(e[1]) ?? []).filter((u): u is number => typeof u === 'number');
      let t = -1;
      if (units.length) {
        const key = units.join(',');
        t = targetIndex.get(key) ?? -1;
        if (t === -1) {
          t = targets.length;
          targets.push(units);
          targetIndex.set(key, t);
        }
      }
      out.push([e[0] as number, t, pct]);
    }
    if (out.length) effects[id] = out;
  }
  return { format: TROOP_EFFECTS_FORMAT, version, targets, effects };
}

/**
 * A unit's strength and health bonus (percent) from an effect list, as its
 * card adds them up — less what the effect list doesn't carry.
 */
export function troopCard(
  table: TroopEffects,
  effects: ReadonlyArray<{ id: number; count: number }>,
  unitId: number,
): { strength: number; health: number } {
  const reaches = new Set<number>([-1]);
  table.targets.forEach((units, i) => { if (units.includes(unitId)) reaches.add(i); });
  let strength = 0;
  let health = 0;
  for (const e of effects) {
    for (const [kind, target, pct] of table.effects[String(e.id)] ?? []) {
      if (!reaches.has(target)) continue;
      if (kind === KIND_STRENGTH) strength += pct * (e.count || 1);
      else if (kind === KIND_HEALTH) health += pct * (e.count || 1);
    }
  }
  return { strength: Math.round(strength * 1000) / 1000, health: Math.round(health * 1000) / 1000 };
}
