/**
 * A player's own armies as their shared battle reports recorded them, for
 * Tools → Citadel and → Stacks: "use the bonuses from my report"
 * (docs/battle-reports.md). The bonuses themselves are worked out in the
 * browser (lib/report-bonuses.js), which has the calculators' troops and the
 * citadels' defenders; this sends what the game measured:
 *
 *  - each troop's units and the game's base strength and health (T9);
 *  - its health per unit with every bonus: the stack's pool on the first hit
 *    it took ÷ its units — exact, a full stack's pool is units × unit health;
 *  - every strike it made with the strike's base damage — the log's extraB
 *    when the strike doubled (that is the damage before the luck), else the
 *    damage when the target survived (not capped). Checked against the Nov 7
 *    2026 Elven 30 report: extraB is the simulator's units × strength ×
 *    (1 + bonus + features) to the unit.
 */
import { getDb } from './database.js';
import { cachedArtUnits } from '../game-art/art-static.js';
import { gameArtDir } from '../game-art/store.js';
import { loadGameNames } from '../game-protocol/static-data.js';
import type { ReportSummary } from './repositories/battle-report-repo.js';

export interface ReportUnit {
  unit: number;
  name: string;
  strength: number;
  health: number;
}

export interface ReportTroop extends ReportUnit {
  count: number;
  /** Health per unit with every bonus, or null when the stack was never hit. */
  unitHealth: number | null;
  /** Its strikes whose damage wasn't capped: units then, base damage, and whom it hit. */
  strikes: Array<{ count: number; base: number; target: ReportUnit }>;
}

export interface ReportArmy {
  entryId: string;
  /** When the battle was fought (ISO). */
  at: string;
  target: { staticId: number | null; name: string };
  won: boolean;
  troops: ReportTroop[];
}

/** Where unit and map-object names come from (tests hand in their own). */
export interface ReportArmyLookups {
  units: () => Map<number, { name: string; strength: number; health: number }>;
  objects: () => Promise<Record<string, string>>;
}

const LIVE: ReportArmyLookups = {
  units: () => cachedArtUnits(gameArtDir()),
  objects: async () => (await loadGameNames()).objects,
};

/** The newest battles these players fought whose strike log was read, newest first. */
export async function reportArmiesFor(playerIds: number[], limit = 8, lookups: ReportArmyLookups = LIVE): Promise<ReportArmy[]> {
  if (!playerIds.length) return [];
  const ph = playerIds.map(() => '?').join(',');
  const rows = getDb().prepare(
    `SELECT entry_id, report_at, target_static_id, won, summary FROM battle_reports
     WHERE status = 'ok' AND kind = 'battle' AND attacker_player_id IN (${ph}) AND summary LIKE '%"strikes"%'
     ORDER BY report_at DESC LIMIT ?`,
  ).all(...playerIds, limit) as Array<{ entry_id: string; report_at: number; target_static_id: number | null; won: number; summary: string }>;
  if (!rows.length) return [];
  const units = lookups.units();
  let objects: Record<string, string> = {};
  try { objects = await lookups.objects(); } catch { /* names unavailable: targets go unnamed */ }
  const unitOf = (id: number): ReportUnit => {
    const u = units.get(id);
    return { unit: id, name: u?.name ?? '', strength: u?.strength ?? 0, health: u?.health ?? 0 };
  };
  const out: ReportArmy[] = [];
  for (const r of rows) {
    let s: ReportSummary;
    try { s = JSON.parse(r.summary) as ReportSummary; } catch { continue; }
    const mine = s.attackers[0];
    if (!mine) continue;
    const strikes = s.strikes ?? [];
    const troops: ReportTroop[] = mine.units.map(([unit, count]) => {
      const firstHit = strikes.find((x) => x.targetArmyId === mine.army && x.targetUnit === unit && x.targetCount > 0);
      const own = strikes.filter((x) => x.byAttacker && x.armyId === mine.army && x.unit === unit && x.count > 0);
      return {
        ...unitOf(unit),
        count,
        unitHealth: firstHit ? firstHit.poolBefore / firstHit.targetCount : null,
        strikes: own.flatMap((x) => {
          const base = x.extraB > 0 ? x.extraB : x.countAfter > 0 ? x.damage : 0;
          return base > 0 ? [{ count: x.count, base, target: unitOf(x.targetUnit) }] : [];
        }),
      };
    });
    out.push({
      entryId: r.entry_id,
      at: new Date(r.report_at * 1000).toISOString(),
      target: { staticId: r.target_static_id, name: r.target_static_id !== null ? objects[String(r.target_static_id)] ?? '' : '' },
      won: r.won === 1,
      troops,
    });
  }
  return out;
}
