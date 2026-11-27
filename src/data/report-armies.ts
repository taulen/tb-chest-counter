/**
 * Players' armies as their shared battle reports recorded them, for Tools →
 * Citadel and → Stacks: "fill in from a battle report" (docs/battle-reports.md).
 * The bonuses themselves are worked out in the browser (lib/report-bonuses.js),
 * which has the calculators' troops and the citadels' defenders; this sends
 * what the game measured:
 *
 *  - each troop's units and the game's base strength and health (T9);
 *  - its health per unit with every bonus: the stack's pool on the first hit
 *    it took ÷ its units — exact, a full stack's pool is units × unit health;
 *  - its card as the march's own effects add it up (troop-effects.ts: the
 *    report's field-14 effects and running boosts, every strength / health
 *    line aimed at its unit) — the card less one army-wide amount the report
 *    doesn't carry, which the page measures from what the battle shows;
 *  - every strike it made, as the log has it: the damage dealt (capped at what
 *    the target had left), extraA — the part of it that came from "vs"
 *    features (damage × features ÷ (1 + bonus + features): Phoenix I on a
 *    Bear, 26 units or 1, the same 7.01 / 45.375 share) — and extraB, the
 *    damage before the luck when the strike doubled (the simulator's units ×
 *    strength × (1 + bonus + features) to the unit), plus whether it killed
 *    its target (then the damage is only what that took).
 *
 * Whose: a player's battles are the ones they FOUGHT (the march owner — the
 * army whose bonuses these are) and the ones they POSTED (usually their own;
 * a report of someone else's army says whose it is). The viewer picks the
 * player (reportPlayers): their own players see every clan's shares, anyone
 * else only what was shared in the clan being viewed.
 */
import fs from 'fs';
import zlib from 'zlib';
import { getDb } from './database.js';
import { cachedArtUnits } from '../game-art/art-static.js';
import { gameArtDir } from '../game-art/store.js';
import { loadGameNames, newestStaticFile } from '../game-protocol/static-data.js';
import { parseBattleReport } from '../game-protocol/battle-report.js';
import { TROOP_EFFECTS_FILE, TROOP_EFFECTS_FORMAT, troopCard, type TroopEffects } from '../game-protocol/troop-effects.js';
import { gamePlayerNames } from './game-player-names.js';
import type { ReportSummary } from './repositories/battle-report-repo.js';

export interface ReportUnit {
  unit: number;
  name: string;
  strength: number;
  health: number;
}

export interface ReportTroop extends ReportUnit {
  count: number;
  /** Its strength and health bonus (%) as the march's effects add them up, or null when the table isn't built yet. */
  card: { strength: number; health: number } | null;
  /** Health per unit with every bonus, or null when the stack was never hit. */
  unitHealth: number | null;
  /** Its strikes: units then, damage dealt, the log's two further figures, whether it killed the target, and whom it hit. */
  strikes: Array<{ count: number; damage: number; extraA: number; extraB: number; capped: boolean; target: ReportUnit }>;
}

export interface ReportArmy {
  entryId: string;
  /** When the battle was fought (ISO). */
  at: string;
  target: { staticId: number | null; name: string };
  won: boolean;
  /** Whose army it is (the march owner) and who posted the report. */
  attacker: { playerId: number | null; name: string };
  sharedBy: string;
  troops: ReportTroop[];
}

/** Where unit, map-object and player names, and the troop-effects table, come from (tests hand in their own). */
export interface ReportArmyLookups {
  units: () => Map<number, { name: string; strength: number; health: number }>;
  objects: () => Promise<Record<string, string>>;
  troopEffects?: () => TroopEffects | null;
}

let effectsMemo: { file: string; mtimeMs: number; table: TroopEffects } | null = null;

/** The newest troop-effects.json the names build wrote (static-data.ts), kept in memory until a newer one appears. */
export function loadTroopEffects(): TroopEffects | null {
  const file = newestStaticFile(TROOP_EFFECTS_FILE);
  if (!file) return null;
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (effectsMemo?.file === file && effectsMemo.mtimeMs === mtimeMs) return effectsMemo.table;
  try {
    const table = JSON.parse(fs.readFileSync(file, 'utf8')) as TroopEffects;
    if (table.format !== TROOP_EFFECTS_FORMAT) return null;
    effectsMemo = { file, mtimeMs, table };
    return table;
  } catch {
    return null;
  }
}

const LIVE: ReportArmyLookups = {
  units: () => cachedArtUnits(gameArtDir()),
  objects: async () => (await loadGameNames()).objects,
  troopEffects: loadTroopEffects,
};

/** Battles of the dialog: read, with a strike log. */
const READABLE = `r.status = 'ok' AND r.kind = 'battle' AND r.summary LIKE '%"strikes"%'`;

export interface ReportPlayer {
  playerId: number;
  name: string;
  /** Battles of theirs the dialog can list. */
  battles: number;
  /** One of the viewer's own players. */
  own: boolean;
}

/** A player's name: the clan's (member or game), else the game's anywhere, else what they post under. */
function namesFor(clanId: number, ids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const [id, n] of gamePlayerNames(clanId, ids)) if (n.name) out.set(id, n.name);
  const db = getDb();
  for (const id of ids) {
    if (out.has(id)) continue;
    const g = db.prepare('SELECT name FROM game_players WHERE player_id = ? ORDER BY last_seen DESC LIMIT 1').get(id) as { name: string } | undefined;
    const s = g ? undefined : db.prepare("SELECT sender_name AS name FROM battle_report_shares WHERE sender_player_id = ? AND sender_name <> '' ORDER BY shared_at DESC LIMIT 1").get(id) as { name: string } | undefined;
    const name = g?.name ?? s?.name;
    if (name) out.set(id, name);
  }
  return out;
}

/**
 * The players the viewer can pick: their own (every clan's shares) and anyone
 * who fought or posted a readable battle shared in `clanId`. Own first, then
 * by name.
 */
export function reportPlayers(clanId: number, ownIds: number[]): ReportPlayer[] {
  const db = getDb();
  const fought = db.prepare(
    `SELECT r.attacker_player_id AS p, COUNT(DISTINCT r.entry_id) AS n FROM battle_reports r
     JOIN battle_report_shares s ON s.entry_id = r.entry_id AND s.clan_id = ?
     WHERE ${READABLE} AND r.attacker_player_id IS NOT NULL GROUP BY r.attacker_player_id`,
  ).all(clanId) as Array<{ p: number; n: number }>;
  const posted = db.prepare(
    `SELECT s.sender_player_id AS p FROM battle_report_shares s JOIN battle_reports r ON r.entry_id = s.entry_id
     WHERE s.clan_id = ? AND ${READABLE} AND s.sender_player_id IS NOT NULL GROUP BY s.sender_player_id`,
  ).all(clanId) as Array<{ p: number }>;
  const ids = new Set<number>([...ownIds, ...fought.map((r) => r.p), ...posted.map((r) => r.p)]);
  const names = namesFor(clanId, [...ids]);
  const own = new Set(ownIds);
  return [...ids].map((id) => ({
    playerId: id,
    name: names.get(id) ?? '',
    battles: battleIds(id, own.has(id) ? null : clanId).length,
    own: own.has(id),
  }))
    .filter((p) => p.own || p.battles > 0)
    .sort((a, b) => Number(b.own) - Number(a.own) || Number(!a.name) - Number(!b.name) || a.name.localeCompare(b.name));
}

/** A player's readable battles (fought or posted), newest first; `clanId` = only those shared there. */
function battleIds(playerId: number, clanId: number | null, limit = 1000): string[] {
  return (getDb().prepare(
    `SELECT r.entry_id FROM battle_reports r
     WHERE ${READABLE}
       AND (r.attacker_player_id = ? OR EXISTS (SELECT 1 FROM battle_report_shares s WHERE s.entry_id = r.entry_id AND s.sender_player_id = ?))
       AND (? IS NULL OR EXISTS (SELECT 1 FROM battle_report_shares s WHERE s.entry_id = r.entry_id AND s.clan_id = ?))
     ORDER BY r.report_at DESC LIMIT ?`,
  ).all(playerId, playerId, clanId, clanId, limit) as Array<{ entry_id: string }>).map((r) => r.entry_id);
}

/**
 * A player's newest battles with a strike log (fought or posted), newest first.
 * `clanId` limits them to what was shared in that clan (anyone but the
 * viewer's own players); `namesClanId` is the clan whose names are used.
 */
export async function reportArmiesFor(
  playerId: number,
  opts: { clanId: number | null; namesClanId: number; limit?: number },
  lookups: ReportArmyLookups = LIVE,
): Promise<ReportArmy[]> {
  const ids = battleIds(playerId, opts.clanId, opts.limit ?? 12);
  if (!ids.length) return [];
  const db = getDb();
  const row = db.prepare(
    `SELECT r.entry_id, r.report_at, r.target_static_id, r.won, r.attacker_player_id, r.summary, r.raw,
            (SELECT s.sender_name FROM battle_report_shares s WHERE s.entry_id = r.entry_id ORDER BY s.shared_at LIMIT 1) AS shared_by
     FROM battle_reports r WHERE r.entry_id = ?`,
  );
  const rows = ids.map((id) => row.get(id) as {
    entry_id: string; report_at: number; target_static_id: number | null; won: number; attacker_player_id: number | null; summary: string;
    raw: Buffer | null; shared_by: string | null;
  });
  const effectsTable = lookups.troopEffects?.() ?? null;
  const units = lookups.units();
  let objects: Record<string, string> = {};
  try { objects = await lookups.objects(); } catch { /* names unavailable: targets go unnamed */ }
  const attackerNames = namesFor(opts.namesClanId, [...new Set(rows.map((r) => r.attacker_player_id).filter((p): p is number => p !== null))]);
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
    // The march's effects come from the raw report (kept for every report read): the summary predates them.
    let effects: Array<{ id: number; count: number }> | null = null;
    if (effectsTable && r.raw) {
      try { effects = parseBattleReport(zlib.gunzipSync(r.raw))?.attackers[0]?.effects ?? null; } catch { effects = null; }
    }
    const troops: ReportTroop[] = mine.units.map(([unit, count]) => {
      const firstHit = strikes.find((x) => x.targetArmyId === mine.army && x.targetUnit === unit && x.targetCount > 0);
      const own = strikes.filter((x) => x.byAttacker && x.armyId === mine.army && x.unit === unit && x.count > 0);
      return {
        ...unitOf(unit),
        count,
        card: effectsTable && effects?.length ? troopCard(effectsTable, effects, unit) : null,
        unitHealth: firstHit ? firstHit.poolBefore / firstHit.targetCount : null,
        strikes: own.map((x) => ({
          count: x.count, damage: x.damage, extraA: x.extraA, extraB: x.extraB, capped: x.countAfter === 0, target: unitOf(x.targetUnit),
        })),
      };
    });
    out.push({
      entryId: r.entry_id,
      at: new Date(r.report_at * 1000).toISOString(),
      target: { staticId: r.target_static_id, name: r.target_static_id !== null ? objects[String(r.target_static_id)] ?? '' : '' },
      won: r.won === 1,
      attacker: { playerId: r.attacker_player_id, name: r.attacker_player_id !== null ? attackerNames.get(r.attacker_player_id) ?? '' : '' },
      sharedBy: r.shared_by ?? '',
      troops,
    });
  }
  return out;
}
