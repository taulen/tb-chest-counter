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
 * a report of someone else's army says whose it is). The dialog opens on the
 * viewer's own players together and lists anyone else on request
 * (reportPlayers): their own players see every clan's shares, anyone else
 * only what was shared in the clan being viewed.
 *
 * Only the last REPORT_WINDOW_DAYS: bonuses change with captains and gear, so
 * an older battle is never what anyone fills in from — and reading every
 * report's summary for every player made the dialog take seconds to open.
 * Tools → Citadel asks for citadel battles only (`targets`: the game's
 * citadels, static-data.ts GameCitadel), each with its level.
 */
import fs from 'fs';
import zlib from 'zlib';
import { getDb } from './database.js';
import { cachedArtUnits } from '../game-art/art-static.js';
import { gameArtDir } from '../game-art/store.js';
import { cachedGameNames, loadGameNames, newestStaticFile, type GameCitadel, type GameNames } from '../game-protocol/static-data.js';
import { HERO_COMMANDER, parseBattleReport } from '../game-protocol/battle-report.js';
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
  /** What was attacked; `level` is a citadel's (null for anything else). */
  target: { staticId: number | null; name: string; level: number | null };
  won: boolean;
  /** Whose army it is (the march owner) and who posted the report. */
  attacker: { playerId: number | null; name: string };
  /**
   * Who led the march: the Hero, and how many captains (null when the raw
   * report can't say). Bonuses and leadership differ with it — a Rare squad
   * is the Hero's alone, a Common squad one captain's (docs/monster-simulator.md).
   */
  led: { hero: boolean; captains: number } | null;
  sharedBy: string;
  troops: ReportTroop[];
}

/** Where unit, map-object and player names, and the troop-effects table, come from (tests hand in their own). */
export interface ReportArmyLookups {
  units: () => Map<number, { name: string; strength: number; health: number }>;
  objects: () => Promise<Record<string, string>>;
  citadels?: () => Promise<Record<string, GameCitadel>>;
  troopEffects?: () => TroopEffects | null;
}

/**
 * The names as built, without the game version check loadGameNames makes on
 * every call (a network round trip each: the report dialog made two or three
 * and took 5+ s to open, Nov 28 2026). Built ones are always there after the
 * first build; only before it does this ask the game.
 */
async function namesNow(): Promise<GameNames> {
  return cachedGameNames() ?? loadGameNames();
}

/** The game's citadels by T7 id (names build, format 16+); empty when the names can't be read. */
export async function loadCitadels(): Promise<Record<string, GameCitadel>> {
  try {
    return (await namesNow()).citadels ?? {};
  } catch {
    return {};
  }
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
  objects: async () => (await namesNow()).objects,
  citadels: loadCitadels,
  troopEffects: loadTroopEffects,
};

/** How far back the dialog looks. */
export const REPORT_WINDOW_DAYS = 7;

export interface ReportFilter {
  /** "Now" for the window (tests); default the clock. */
  nowMs?: number;
  /** Only battles against these T7 ids (the citadels), or null for every battle. */
  targets?: number[] | null;
}

/**
 * Battles of the dialog: read, with a strike log, fought in the window. The
 * time comes first so the summary's text is only searched for those.
 */
function readable(f: ReportFilter): { sql: string; args: number[] } {
  const since = Math.floor((f.nowMs ?? Date.now()) / 1000) - REPORT_WINDOW_DAYS * 86_400;
  const targets = f.targets ?? null;
  const onTarget = targets === null ? '' : targets.length ? `AND r.target_static_id IN (${targets.map(() => '?').join(',')})` : 'AND 0';
  return {
    sql: `r.report_at >= ? AND r.status = 'ok' AND r.kind = 'battle' ${onTarget} AND r.summary LIKE '%"strikes"%'`,
    args: [since, ...(targets ?? [])],
  };
}

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
 * who fought or posted a readable battle shared in `clanId`, each with their
 * battles in the window. Own first, then by name. One pass over the window's
 * shares.
 */
export function reportPlayers(clanId: number, ownIds: number[], filter: ReportFilter = {}): ReportPlayer[] {
  const { sql, args } = readable(filter);
  const rows = getDb().prepare(
    `SELECT r.entry_id AS e, r.attacker_player_id AS a, s.sender_player_id AS p, s.clan_id AS c
     FROM battle_reports r JOIN battle_report_shares s ON s.entry_id = r.entry_id
     WHERE ${sql}`,
  ).all(...args) as Array<{ e: string; a: number | null; p: number | null; c: number }>;
  const own = new Set(ownIds);
  const inClan = new Set(rows.filter((r) => r.c === clanId).map((r) => r.e));
  const battles = new Map<number, Set<string>>(ownIds.map((id) => [id, new Set<string>()]));
  const add = (id: number | null, e: string) => {
    // Another player's battles only as shared in this clan; the viewer's own from every clan's.
    if (id === null || (!own.has(id) && !inClan.has(e))) return;
    let set = battles.get(id);
    if (!set) battles.set(id, (set = new Set()));
    set.add(e);
  };
  for (const r of rows) {
    add(r.a, r.e);
    add(r.p, r.e);
  }
  const names = namesFor(clanId, [...battles.keys()]);
  return [...battles].map(([id, set]) => ({ playerId: id, name: names.get(id) ?? '', battles: set.size, own: own.has(id) }))
    .sort((a, b) => Number(b.own) - Number(a.own) || Number(!a.name) - Number(!b.name) || a.name.localeCompare(b.name));
}

/** The players' readable battles (fought or posted), newest first; `clanId` = only those shared there. */
function battleIds(playerIds: number[], clanId: number | null, filter: ReportFilter, limit: number): string[] {
  if (!playerIds.length) return [];
  const { sql, args } = readable(filter);
  const ph = playerIds.map(() => '?').join(',');
  return (getDb().prepare(
    `SELECT r.entry_id FROM battle_reports r
     WHERE ${sql}
       AND (r.attacker_player_id IN (${ph}) OR EXISTS (SELECT 1 FROM battle_report_shares s WHERE s.entry_id = r.entry_id AND s.sender_player_id IN (${ph})))
       AND (? IS NULL OR EXISTS (SELECT 1 FROM battle_report_shares s WHERE s.entry_id = r.entry_id AND s.clan_id = ?))
     ORDER BY r.report_at DESC LIMIT ?`,
  ).all(...args, ...playerIds, ...playerIds, clanId, clanId, limit) as Array<{ entry_id: string }>).map((r) => r.entry_id);
}

/**
 * The newest battles with a strike log of one player or several (the
 * viewer's own, together), fought or posted, newest first, in the window.
 * `clanId` limits them to what was shared in that clan (anyone but the
 * viewer's own players); `namesClanId` is the clan whose names are used.
 */
export async function reportArmiesFor(
  players: number | number[],
  opts: { clanId: number | null; namesClanId: number; limit?: number } & ReportFilter,
  lookups: ReportArmyLookups = LIVE,
): Promise<ReportArmy[]> {
  const ids = battleIds(Array.isArray(players) ? players : [players], opts.clanId, opts, opts.limit ?? 20);
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
  let citadels: Record<string, GameCitadel> = {};
  try { citadels = (await lookups.citadels?.()) ?? {}; } catch { /* no levels */ }
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
    // The march's effects and commanders come from the raw report (kept for every report read): the summary predates them.
    let effects: Array<{ id: number; count: number }> | null = null;
    let led: ReportArmy['led'] = null;
    if (r.raw) {
      try {
        const side = parseBattleReport(zlib.gunzipSync(r.raw))?.attackers[0];
        if (effectsTable) effects = side?.effects ?? null;
        if (side?.commanders.length) {
          led = { hero: side.commanders.includes(HERO_COMMANDER), captains: side.commanders.filter((c) => c !== HERO_COMMANDER).length };
        }
      } catch { effects = null; }
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
      target: {
        staticId: r.target_static_id,
        name: r.target_static_id !== null ? objects[String(r.target_static_id)] ?? '' : '',
        level: r.target_static_id !== null ? citadels[String(r.target_static_id)]?.level ?? null : null,
      },
      won: r.won === 1,
      attacker: { playerId: r.attacker_player_id, name: r.attacker_player_id !== null ? attackerNames.get(r.attacker_player_id) ?? '' : '' },
      led,
      sharedBy: r.shared_by ?? '',
      troops,
    });
  }
  return out;
}
