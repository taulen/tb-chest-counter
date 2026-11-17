/**
 * Guards (Guardsmen) levels per member — the Guardsmen tier from the member's
 * own research, as the game reports it (data/member-tiers.ts,
 * game-protocol/troop-tiers.ts). Nothing here is inferred: a member whose
 * research has not been read from the game has no level.
 *
 * Level-ups are the Guardsmen tier changes seen after the member's first
 * research read, each dated between the read before it ("after") and the read
 * that saw it ("by"). A tier held at the first read was reached at some point
 * before it, so it is not a level-up.
 *
 * Until Nov 2026 the level was estimated from Omen Essence and Scientific
 * Tractates donations plus admin entries; that estimate is retired, and the
 * member_guards_reports table those entries went into is kept, unread.
 */
import { getDb } from '../database.js';
import { cached } from '../../utils/ttl-cache.js';
import { daysBetweenGameDates, gameDateFor } from '../../utils/game-day.js';
import { loadConfig } from '../../config/index.js';
import { getMemberTiers } from '../member-tiers.js';
import { GUARDS_STALE_DAYS } from '../../config/guards-levels.js';

const CACHE_TTL_MS = 60_000;

export interface GuardsLevelUp {
  from: number;
  to: number;
  /** Game day of the read before the one that saw the new level. */
  after: string;
  /** Game day of the read that first saw it. */
  by: string;
}

export interface MemberGuards {
  level: number;
  /** Game day the member's research was last read. */
  asOf: string;
  /** Game day of the first read; the level held then may be older. */
  firstSeen: string;
  /** Level-ups seen after the first read, oldest first. */
  levelUps: GuardsLevelUp[];
}

/** What a table cell needs: the level and how old the read is. */
export interface MemberGuardsSummary {
  level: number;
  asOf: string;
  /** Research not read for GUARDS_STALE_DAYS — the level may have moved on. */
  stale: boolean;
  lastLevelUp: GuardsLevelUp | null;
}

/**
 * memberId → sorted game days their city (research) was read, for dating a
 * level-up between two reads.
 */
function readDays(clanId: number): Map<number, string[]> {
  const rows = getDb().prepare(`
    SELECT m.id AS memberId, s.game_date AS day
      FROM members m
      JOIN game_city_snapshots s ON s.clan_id = m.clan_id AND s.player_id = m.game_player_id
     WHERE m.clan_id = ?
     ORDER BY m.id, s.game_date
  `).all(clanId) as Array<{ memberId: number; day: string }>;
  const out = new Map<number, string[]>();
  for (const r of rows) {
    const list = out.get(r.memberId);
    if (list) list.push(r.day);
    else out.set(r.memberId, [r.day]);
  }
  return out;
}

/**
 * Every member's Guardsmen level for one clan; members whose research has not
 * been read (or who have no Guardsmen unlock) are absent.
 *
 * Returns a SHARED cached Map — read it, never mutate it.
 */
export function getGuardsLevels(clanId: number): Map<number, MemberGuards> {
  return cached(`guards:${clanId}:levels`, CACHE_TTL_MS, () => {
    const rollover = loadConfig().gameDayRolloverUtcHour;
    const day = (iso: string) => gameDateFor(Date.parse(iso), rollover);
    const days = readDays(clanId);
    const out = new Map<number, MemberGuards>();
    for (const [memberId, m] of getMemberTiers(clanId)) {
      const level = m.tiers.guardsmen;
      if (!level) continue;
      const firstSeen = day(m.firstReadAt);
      const reads = days.get(memberId) ?? [];
      const levelUps: GuardsLevelUp[] = [];
      for (const c of m.changes.guardsmen) {
        if (c.from === null) continue;
        const by = day(c.at);
        // The newest read before the one that saw it; failing that, the first read.
        let after = firstSeen;
        for (const d of reads) if (d < by) after = d;
        levelUps.push({ from: c.from, to: c.to, after, by });
      }
      out.set(memberId, { level, asOf: day(m.readAt), firstSeen, levelUps });
    }
    return out;
  });
}

/** Cut a member's level down to what a table cell shows. `today` is a game day. */
export function summarizeGuards(g: MemberGuards, today: string): MemberGuardsSummary {
  const age = daysBetweenGameDates(g.asOf, today);
  return {
    level: g.level,
    asOf: g.asOf,
    stale: age !== null && age > GUARDS_STALE_DAYS,
    lastLevelUp: g.levelUps.length > 0 ? g.levelUps[g.levelUps.length - 1] : null,
  };
}

/** memberId → summary for every member with a level. */
export function getGuardsSummaries(clanId: number, today: string): Map<number, MemberGuardsSummary> {
  const out = new Map<number, MemberGuardsSummary>();
  for (const [memberId, g] of getGuardsLevels(clanId)) out.set(memberId, summarizeGuards(g, today));
  return out;
}

export interface ClanGuardsOverview {
  /** Active members per level, highest first. */
  distribution: Array<{ level: number; members: number }>;
  /** Active members with a level read from the game, and without one. */
  known: number;
  unknown: number;
  stale: number;
  /** Level-ups first seen within `recentDays`, newest first. */
  recentLevelUps: Array<GuardsLevelUp & { memberId: number; name: string }>;
}

/** The clan's make-up for the Analytics overview — active members only. */
export function getClanGuardsOverview(clanId: number, today: string, recentDays = 30): ClanGuardsOverview {
  const active = getDb().prepare(
    'SELECT id, name FROM members WHERE clan_id = ? AND is_active = 1',
  ).all(clanId) as Array<{ id: number; name: string }>;
  const levels = getGuardsLevels(clanId);

  const counts = new Map<number, number>();
  let known = 0;
  let stale = 0;
  const recentLevelUps: ClanGuardsOverview['recentLevelUps'] = [];
  for (const m of active) {
    const g = levels.get(m.id);
    if (!g) continue;
    known++;
    counts.set(g.level, (counts.get(g.level) ?? 0) + 1);
    if (summarizeGuards(g, today).stale) stale++;
    for (const up of g.levelUps) {
      const age = daysBetweenGameDates(up.by, today);
      if (age !== null && age <= recentDays) recentLevelUps.push({ ...up, memberId: m.id, name: m.name });
    }
  }
  recentLevelUps.sort((a, b) => (a.by < b.by ? 1 : a.by > b.by ? -1 : a.name.localeCompare(b.name)));

  return {
    distribution: [...counts.entries()].sort((a, b) => b[0] - a[0]).map(([level, members]) => ({ level, members })),
    known,
    unknown: active.length - known,
    stale,
    recentLevelUps,
  };
}
