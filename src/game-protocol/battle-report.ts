/**
 * A battle report from the journal service (journal.ts), read into what the
 * site uses: who attacked what, both armies as they stood when the battle
 * began, what each side lost, and the strike log. Layout decoded from reports
 * recorded on Nov 27 2026 (docs/battle-reports.md):
 *
 *   report  ["battle", won ("true"/"false"), rounds, ?, ?, ?, ?,
 *            attackers[], defenders[], strikeLogId, …, targetStaticId (14), rewards (15), …]
 *   side    [[realm, playerNo], march, [{}, killed {unit: n}, 1], …]
 *   march   [[armyId], [[playerId], [cityId], 1, setOutAt, …], …, effects (14)
 *            [[effectId, sourceBits, count]…], boosts (16) [[effectId, 0, from, to]…],
 *            …, units (30) [[unit, count, 0]…], …]
 *   strike  [attacker ("true"/"false"), [armyId], unit, count, damage, c5, c6, 0,
 *            [targetArmyId], targetUnit, targetCount, targetPoolBefore,
 *            targetCountAfter, targetPoolAfter, …]
 *
 * A side's player is its march's owner (march[1][0]): the same id
 * members.game_player_id holds, realm × 2³² + a number. The side's own
 * [realm, n] — and a chat link's `guid` — keep only that number's low 12 bits,
 * so they are a fallback only. Monsters' "player" is 1116691496961 ([260, 1]).
 */
import { decodeJournalValues, type Wire } from './codec.js';

/** An army's troops: game unit id → units. */
export type UnitCounts = Array<{ unit: number; count: number }>;

export interface BattleSide {
  /** realm × 2³² + player number; null when the report doesn't say. */
  playerId: number | null;
  /** The army when the battle began. */
  units: UnitCounts;
  /** Units lost in this battle, by game unit id. */
  killed: Record<number, number>;
  /** The march's army id (the strike log names armies by it). */
  armyId: number | null;
  /**
   * Every effect on the march (field 14 — research, captains, gear, artifacts…)
   * and the timed boosts running when it set out (field 16): what its troop
   * cards add up (troop-effects.ts). Empty for a monster.
   */
  effects: Array<{ id: number; count: number }>;
}

export interface BattleReport {
  kind: string;
  won: boolean;
  rounds: number | null;
  targetStaticId: number | null;
  /** The id of this battle's strike log (journal.ts fetchJournalItem), or null. */
  strikeLogId: string | null;
  attackers: BattleSide[];
  defenders: BattleSide[];
}

export interface Strike {
  /** Struck by the attacking side. */
  byAttacker: boolean;
  armyId: number | null;
  unit: number;
  count: number;
  /** Damage the target took (capped at what it had left). */
  damage: number;
  /** The log's two further damage figures, kept as the game wrote them (luck: a doubled or second-squad strike). */
  extraA: number;
  extraB: number;
  targetArmyId: number | null;
  targetUnit: number;
  targetCount: number;
  /** The target stack's health pool before and after the strike, and its units after. */
  poolBefore: number;
  countAfter: number;
  poolAfter: number;
}

/** A player id from a short [realm, n] — exact only while the id's number fits in 12 bits. */
export function playerIdOf(realm: number, playerNo: number): number {
  return realm * 2 ** 32 + playerNo;
}

const num = (v: Wire | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const firstId = (v: Wire | undefined): number | null => (Array.isArray(v) ? num(v[0]) : num(v));

/** `[[unit, count, x]…]` — or null when `v` isn't a units list. */
function asUnits(v: Wire | undefined): UnitCounts | null {
  if (!Array.isArray(v)) return null;
  const out: UnitCounts = [];
  for (const e of v) {
    if (!Array.isArray(e) || e.length < 2) return null;
    const unit = num(e[0]);
    const count = num(e[1]);
    if (unit === null || count === null) return null;
    out.push({ unit, count });
  }
  return out;
}

function asKilled(v: Wire | undefined): Record<number, number> {
  const out: Record<number, number> = {};
  if (v && typeof v === 'object' && !Array.isArray(v) && !('hex' in v) && !('$pairs' in v)) {
    for (const [k, n] of Object.entries(v)) {
      const unit = Number(k);
      if (Number.isInteger(unit) && typeof n === 'number') out[unit] = n;
    }
  }
  return out;
}

/**
 * The army in a march record. Index 30 on every report seen; when that isn't a
 * units list (a changed layout), the units list covering what the side lost.
 */
function marchUnits(march: Wire[], killed: Record<number, number>): UnitCounts {
  const at30 = asUnits(march[30]);
  if (at30 && at30.length) return at30;
  const lost = Object.keys(killed).map(Number);
  for (let i = march.length - 1; i >= 0; i--) {
    const u = asUnits(march[i]);
    if (u && u.length && lost.length && lost.every((id) => u.some((x) => x.unit === id))) return u;
  }
  return [];
}

function readSide(v: Wire): BattleSide | null {
  if (!Array.isArray(v)) return null;
  const who = v[0];
  const march = Array.isArray(v[1]) ? v[1] : [];
  const killed = asKilled(Array.isArray(v[2]) ? v[2][1] : undefined);
  // The march's owner is the full player id. The side's [realm, n] is not: n is
  // only the id's low 12 bits ("taulen K260 SK" 4599909976661 = realm 1071,
  // 0x258A55, shows as [1071, 2645]) — the same short form chat links carry.
  const owner = Array.isArray(march[1]) ? firstId(march[1][0]) : null;
  let playerId = owner;
  if (playerId === null && Array.isArray(who) && typeof who[0] === 'number' && typeof who[1] === 'number') playerId = playerIdOf(who[0], who[1]);
  return { playerId, units: marchUnits(march, killed), killed, armyId: firstId(march[0]), effects: marchEffects(march) };
}

/** A march's effects (field 14, counted) and the boosts (field 16) running when it set out. */
function marchEffects(march: Wire[]): Array<{ id: number; count: number }> {
  const out: Array<{ id: number; count: number }> = [];
  for (const e of Array.isArray(march[14]) ? march[14] : []) {
    if (Array.isArray(e) && typeof e[0] === 'number') out.push({ id: e[0], count: typeof e[2] === 'number' && e[2] > 0 ? e[2] : 1 });
  }
  const setOut = Array.isArray(march[1]) ? num(march[1][3]) : null;
  for (const b of Array.isArray(march[16]) ? march[16] : []) {
    if (!Array.isArray(b) || typeof b[0] !== 'number') continue;
    const from = num(b[2]);
    const to = num(b[3]);
    if (setOut !== null && from !== null && to !== null && (setOut < from || setOut > to)) continue;
    out.push({ id: b[0], count: 1 });
  }
  return out;
}

/** A report's bytes (journal.ts fetchSharedEntry) read, or null when they aren't a battle. */
export function parseBattleReport(bytes: Buffer): BattleReport | null {
  let values: Wire[];
  try {
    values = decodeJournalValues(bytes);
  } catch {
    return null;
  }
  const b = values[0];
  if (!Array.isArray(b) || b[0] !== 'battle') return null;
  const sides = (v: Wire | undefined): BattleSide[] =>
    (Array.isArray(v) ? v : []).map(readSide).filter((s): s is BattleSide => s !== null);
  return {
    kind: 'battle',
    won: b[1] === 'true' || b[1] === true,
    rounds: num(b[2]),
    targetStaticId: num(b[14]),
    strikeLogId: typeof b[9] === 'string' && b[9] ? b[9] : null,
    attackers: sides(b[7]),
    defenders: sides(b[8]),
  };
}

/** A strike log's bytes read into strikes (oldest first); [] when unreadable. */
export function parseStrikeLog(bytes: Buffer): Strike[] {
  let values: Wire[];
  try {
    values = decodeJournalValues(bytes);
  } catch {
    return [];
  }
  const rows = Array.isArray(values[0]) ? values[0] : [];
  const out: Strike[] = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const unit = num(r[2]);
    const targetUnit = num(r[9]);
    if (unit === null || targetUnit === null) continue;
    out.push({
      byAttacker: r[0] === 'true' || r[0] === true,
      armyId: firstId(r[1]),
      unit,
      count: num(r[3]) ?? 0,
      damage: num(r[4]) ?? 0,
      extraA: num(r[5]) ?? 0,
      extraB: num(r[6]) ?? 0,
      targetArmyId: firstId(r[8]),
      targetUnit,
      targetCount: num(r[10]) ?? 0,
      poolBefore: num(r[11]) ?? 0,
      countAfter: num(r[12]) ?? 0,
      poolAfter: num(r[13]) ?? 0,
    });
  }
  return out;
}

/**
 * A clan announcement shared in chat: `["clan_announcement", [realm, n], text]`
 * (the [realm, n] is the author's short id; the chat link names them). Null
 * when the bytes aren't one.
 */
export function parseAnnouncement(bytes: Buffer): { text: string } | null {
  let values: Wire[];
  try {
    values = decodeJournalValues(bytes);
  } catch {
    return null;
  }
  const a = values[0];
  if (!Array.isArray(a) || a[0] !== 'clan_announcement' || typeof a[2] !== 'string') return null;
  return { text: a[2] };
}

// ── The Tin Man ────────────────────────────────────────────────────────────

/**
 * Rise of the Ancients' Tin Man is the map object "Epic Ancient squad": 750 of
 * them in the game's T7, three runs of 250 — 6000–6249, 7000–7249 (the Seasonal
 * Kingdom's, SK7 on Nov 22 2026) and 8000–8249 — one per Tin Man level 1–250.
 */
const TINMAN_BLOCKS = [6000, 7000, 8000];

/**
 * The Tin Man's stacks while it is whole — and the rule: hit it only while it
 * still has all of them (the user, Nov 27 2026: always on, always 4).
 */
export const TINMAN_FULL_STACKS = 4;
const TINMAN_LEVELS = 250;

/** The Tin Man's level when `staticId` is a Tin Man, else null. */
export function tinmanLevel(staticId: number | null): number | null {
  if (staticId === null) return null;
  for (const base of TINMAN_BLOCKS) {
    if (staticId >= base && staticId < base + TINMAN_LEVELS) return staticId - base + 1;
  }
  return null;
}

/**
 * How many stacks of monsters the Tin Man still had when it was hit: it starts
 * with 4 and drops to 3, 2, 1 as its health goes. Some clans require hitting it
 * while it has all 4 (waiting for fewer gives one player more rewards at the
 * clan's cost). Null when the report isn't a hit on a Tin Man.
 */
export function tinmanStacks(report: BattleReport): number | null {
  if (tinmanLevel(report.targetStaticId) === null) return null;
  const units = report.defenders[0]?.units ?? [];
  return units.filter((u) => u.count > 0).length;
}
