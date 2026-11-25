/**
 * Event standings pasted by hand before the game was read (Nov 2026): Rise of
 * the Ancients per summon, and Trials of Olympus, Ragnarok and Dark Omens per
 * day. Pasting is gone (Nov 25 2026); the scores come from the game
 * (data/event-scores.ts). These rows stay readable for the runs the game never
 * read, and nothing writes them any more.
 *
 * The in-game ranking is CUMULATIVE over the run: each upload was a full
 * snapshot, keyed by (clan, run day, summon), and what a player scored IN a
 * summon is the difference from their previous snapshot. A player missing from
 * a later snapshot carries their last total forward.
 *
 * Also the Ancients per-tier targets (tinman_targets): a plan pasted from the
 * Ancient planner, not a score, so still written here.
 */
import { getDb } from '../database.js';
import { TARGET_TIERS, type TargetTier } from '../tinman-parse.js';
import { invalidate } from '../../utils/ttl-cache.js';

export const TINMAN_MAX_SUMMONS = 8;

/**
 * Events with a score table. Ancients is per summon, with targets; Trials of
 * Olympus (five days), Ragnarok and Dark Omens per day. Dark Omens' is the
 * Spoils of Dread damage ranking — the event's other measure, Omen Essence
 * donated, comes from resource tracking. A run is keyed by `tinman_date`
 * whatever the event: the Tinman day for Ancients, the run's first game day
 * for the per-day events. `summon` is the round — the day, for those.
 */
export const SCORE_EVENTS = {
  ancients: { maxRounds: TINMAN_MAX_SUMMONS },
  olympus: { maxRounds: 5 },
  ragnarok: { maxRounds: 2 },
  'dark-omens': { maxRounds: 2 },
} as const;
export type ScoreEventKey = keyof typeof SCORE_EVENTS;

/** How a pasted name was matched when it was pasted. */
export type TinmanMatchKind = 'exact' | 'fuzzy' | 'manual' | 'unmatched' | 'rejected';

/**
 * Every write here changes the Performance page's Tin Man signal; its cached
 * report (data/performance.ts) is keyed under this same literal.
 */
function dropPerformanceCache(clanId: number): void {
  invalidate(`performance:${clanId}:`);
}

// ─── Reading ─────────────────────────────────────────────────────

export interface TinmanUploadInfo {
  summon: number;
  uploadedAt: string;
  uploadedBy: string;
  rows: number;
  unmatched: number;
}

export interface TinmanPlayer {
  /** Matched member, or null for a name nobody has been assigned to. */
  memberId: number | null;
  name: string;
  /** The name as last pasted. */
  rawName: string;
  matchKind: TinmanMatchKind;
  /** Cumulative points after each uploaded summon (summon → points). */
  cumulative: Record<number, number>;
  /** Points scored IN each uploaded summon: the step from the previous upload. */
  perSummon: Record<number, number>;
  total: number;
  /** Summons with points scored in them. */
  played: number;
  /** Latest pasted rank. */
  rank: number;
}

export interface TinmanStandings {
  date: string;
  summons: TinmanUploadInfo[];
  players: TinmanPlayer[];
}

export function getTinmanStandings(clanId: number, date: string, eventKey: ScoreEventKey = 'ancients'): TinmanStandings {
  const db = getDb();
  const uploads = db.prepare(`
    SELECT u.id, u.summon, u.uploaded_at AS uploadedAt, u.uploaded_by AS uploadedBy,
           COUNT(s.id) AS rows,
           SUM(CASE WHEN s.member_id IS NULL THEN 1 ELSE 0 END) AS unmatched
    FROM tinman_uploads u LEFT JOIN tinman_scores s ON s.upload_id = u.id
    WHERE u.clan_id = ? AND u.event_key = ? AND u.tinman_date = ?
    GROUP BY u.id ORDER BY u.summon ASC
  `).all(clanId, eventKey, date) as Array<TinmanUploadInfo & { id: number }>;

  const scores = db.prepare(`
    SELECT u.summon AS summon, s.rank, s.raw_name AS rawName, s.member_id AS memberId,
           s.match_kind AS matchKind, s.points, m.name AS memberName
    FROM tinman_scores s
    JOIN tinman_uploads u ON u.id = s.upload_id
    LEFT JOIN members m ON m.id = s.member_id
    WHERE u.clan_id = ? AND u.event_key = ? AND u.tinman_date = ?
    ORDER BY u.summon ASC, s.rank ASC
  `).all(clanId, eventKey, date) as Array<{
    summon: number; rank: number; rawName: string; memberId: number | null;
    matchKind: TinmanMatchKind; points: number; memberName: string | null;
  }>;

  const byKey = new Map<string, TinmanPlayer>();
  for (const s of scores) {
    const key = s.memberId ? `m:${s.memberId}` : `n:${s.rawName.trim().toLowerCase()}`;
    let p = byKey.get(key);
    if (!p) {
      p = {
        memberId: s.memberId, name: s.memberName ?? s.rawName, rawName: s.rawName, matchKind: s.matchKind,
        cumulative: {}, perSummon: {}, total: 0, played: 0, rank: s.rank,
      };
      byKey.set(key, p);
    }
    // Two pasted rows on one member in one upload can't happen (claims are
    // exclusive) — but if a hand edit ever did it, keep the larger total.
    p.cumulative[s.summon] = Math.max(p.cumulative[s.summon] ?? 0, s.points);
    p.rawName = s.rawName;
    p.matchKind = s.matchKind;
    p.rank = s.rank;
  }

  const summonNumbers = uploads.map((u) => u.summon);
  for (const p of byKey.values()) {
    let prev = 0;
    for (const n of summonNumbers) {
      const cum = p.cumulative[n];
      if (cum === undefined) continue; // not in this snapshot — total carries forward
      p.perSummon[n] = cum - prev;
      if (cum - prev > 0) p.played++;
      prev = cum;
    }
    p.total = prev;
  }

  const players = [...byKey.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return {
    date,
    summons: uploads.map(({ id: _id, ...u }) => ({ ...u, unmatched: u.unmatched ?? 0 })),
    players,
  };
}

/** Run days this clan has standings for (Tinman days, for Ancients), newest first. */
export function listTinmanDates(clanId: number, limit = 30, eventKey: ScoreEventKey = 'ancients'): string[] {
  const rows = getDb().prepare(`
    SELECT DISTINCT tinman_date AS d FROM tinman_uploads WHERE clan_id = ? AND event_key = ? ORDER BY d DESC LIMIT ?
  `).all(clanId, eventKey, limit) as Array<{ d: string }>;
  return rows.map((r) => r.d);
}

// ─── Targets ─────────────────────────────────────────────────────

export interface TinmanTargets {
  /** Points each, per tier key (t9, g9 … g1). */
  tiers: Partial<Record<TargetTier, number>>;
  kills: number | null;
  savedBy: string;
  savedAt: string;
}

/** The run's per-tier targets, or null when none were pasted. */
export function getTinmanTargets(clanId: number, date: string): TinmanTargets | null {
  const row = getDb().prepare(
    'SELECT tiers, kills, saved_by AS savedBy, saved_at AS savedAt FROM tinman_targets WHERE clan_id = ? AND tinman_date = ?',
  ).get(clanId, date) as { tiers: string; kills: number | null; savedBy: string; savedAt: string } | undefined;
  if (!row) return null;
  let tiers: TinmanTargets['tiers'] = {};
  try {
    const parsed = JSON.parse(row.tiers) as Record<string, unknown>;
    for (const t of TARGET_TIERS) {
      const v = parsed[t];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) tiers[t] = v;
    }
  } catch {
    tiers = {};
  }
  return { tiers, kills: row.kills, savedBy: row.savedBy, savedAt: row.savedAt };
}

/** Store (or replace) the run's targets. */
export function saveTinmanTargets(input: {
  clanId: number;
  date: string;
  tiers: Partial<Record<TargetTier, number>>;
  kills: number | null;
  savedBy: string;
}): void {
  getDb().prepare(`
    INSERT INTO tinman_targets (clan_id, tinman_date, tiers, kills, saved_by, saved_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (clan_id, tinman_date) DO UPDATE SET
      tiers = excluded.tiers, kills = excluded.kills,
      saved_by = excluded.saved_by, saved_at = excluded.saved_at
  `).run(input.clanId, input.date, JSON.stringify(input.tiers), input.kills, input.savedBy, new Date().toISOString());
  dropPerformanceCache(input.clanId);
}

export function deleteTinmanTargets(clanId: number, date: string): boolean {
  const removed = getDb().prepare('DELETE FROM tinman_targets WHERE clan_id = ? AND tinman_date = ?')
    .run(clanId, date).changes > 0;
  dropPerformanceCache(clanId);
  return removed;
}
