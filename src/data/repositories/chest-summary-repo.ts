/**
 * chest_daily_summary — a derived rollup of chest_records holding one row per
 * (clan, member, game-day) with that day's chest count and point total.
 *
 * Why: single-day-records and top-contributors previously scanned the whole
 * chest_records history on every (uncached) read, and single-day additionally
 * ran SQLite's rollover-shifted DATE() per row — cost that no index removes and
 * that grows linearly with retained history. Pre-bucketing collapses a member's
 * many chests on a day into one row (~20x fewer rows) and precomputes the
 * game-day, so those reads scale with active-members-per-day, not total history.
 *
 * Freshness model: tracked in-memory per clan via a generation counter.
 * notifyChestDataChanged() bumps it from every chest_records mutation path;
 * ensureFresh() rebuilds the clan's rows from raw when the built generation
 * lags. The counters reset on boot, so the first read after any (re)deploy
 * rebuilds from scratch — a deliberate self-heal that corrects any drift from a
 * mutation path that forgot to notify during the previous run. Every rebuild
 * derives entirely from chest_records, so the rollup can never silently diverge
 * from the source of truth for longer than one deploy cycle.
 */

import { getDb } from '../database.js';
import { clanRewardChestIds, clanRewardExclusionSql } from '../clan-reward-chests.js';
import { loadConfig } from '../../config/index.js';
import { invalidate } from '../../utils/ttl-cache.js';
import { childLogger } from '../../utils/logger.js';
import type { SingleDayRecord } from './chest-repo.js';

const log = childLogger('chest-summary');

/** Clan totals over a game-day window. Both column pairs; the caller picks. */
export interface WindowTotals {
  chests: number;
  points: number;
  earnedChests: number;
  earnedPoints: number;
  activeMembers: number;
  /**
   * The population `activeMembers` is drawn from: everyone who was ON the
   * roster at any point in this window, not the roster as it stands today.
   *
   * The two must come from the same population or the ratio is nonsense. The
   * card used to pair this count with `stats.totalMembers` (`is_active = 1`,
   * i.e. right now), so every member who has since left counted in the
   * numerator and in no denominator — all-time read "227 of 102".
   */
  rosterMembers: number;
}

/** One game day of clan activity. Only days that had activity are present. */
export interface DailyActivityPoint {
  day: string;
  chests: number;
  points: number;
  earnedChests: number;
  earnedPoints: number;
  activeMembers: number;
}

// Per-clan freshness counters. In-memory by design (see file header): reset on
// boot so a redeploy always rebuilds, self-healing any missed notification.
const generation = new Map<number, number>();
const builtGeneration = new Map<number, number>();

/**
 * Announce that a clan's chest_records changed (insert, delete, point recalc,
 * or member reassignment). Marks the rollup stale so the next read rebuilds it
 * and drops the analytics/leaderboard TTL caches so they recompute against the
 * fresh data. Call from every chest_records mutation path.
 */
export function notifyChestDataChanged(clanId: number): void {
  generation.set(clanId, (generation.get(clanId) ?? 0) + 1);
  invalidate(`leaderboard:${clanId}`);
  invalidate(`singleDay:${clanId}`);
  invalidate(`analyticsSummary:${clanId}`);
  invalidate(`analyticsDaily:${clanId}`);
  invalidate(`topContributors:${clanId}`);
  // Prefix match: one entry per (window, compare, limit) the page has asked
  // for, so this clears every window at once rather than the current one only.
  invalidate(`analyticsWindow:${clanId}:`);
}

/**
 * Rebuild the clan's rollup rows from raw chest_records if stale. Cheap when
 * fresh (a Map compare, no DB access). A rebuild is one aggregate pass — the
 * same cost as a single uncached analytics query — and happens at most once per
 * data change (≈ once per scan) plus once on the first read after a boot.
 */
function ensureFresh(clanId: number): void {
  const gen = generation.get(clanId) ?? 0;
  if (builtGeneration.get(clanId) === gen) return;
  rebuild(clanId);
  builtGeneration.set(clanId, gen);
}

function rebuild(clanId: number): void {
  const db = getDb();
  const rolloverModifier = `-${loadConfig().gameDayRolloverUtcHour} hours`;
  // Resolved here rather than at module load, and from the same connection, so
  // the id set can never lag the rows it is bucketing: a scan mints a new
  // `chests` row for a chest the game just added and then triggers this rebuild.
  const rewardIds = clanRewardChestIds().filter((id) => Number.isInteger(id));
  // '1' — not '1=1' — is the no-rewards-resolved case: every row counts as
  // earned, which is exactly the pre-v70 behaviour.
  const isEarned = rewardIds.length ? `chest_id NOT IN (${rewardIds.join(',')})` : '1';
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM chest_daily_summary WHERE clan_id = ?').run(clanId);
    db.prepare(`
      INSERT INTO chest_daily_summary
        (clan_id, member_id, game_day, chests, points, earned_chests, earned_points)
      SELECT clan_id,
             member_id,
             DATE(effective_at / 1000, 'unixepoch', ?) AS game_day,
             COUNT(*),
             COALESCE(SUM(point_value), 0),
             COALESCE(SUM(CASE WHEN ${isEarned} THEN 1 ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN ${isEarned} THEN point_value ELSE 0 END), 0)
      FROM chest_records
      WHERE clan_id = ? AND member_id IS NOT NULL
      GROUP BY member_id, game_day
    `).run(rolloverModifier, clanId);
  });
  tx();
}

/**
 * The clan's top 3 single-day performances by chest count and by points, one
 * entry per member (their personal-best day only, so three different members
 * fill the podium). Reads pre-bucketed rows — no per-row DATE(), no history
 * scan. Ties on the best value resolve to the most recent day.
 *
 * Reads the earned_* columns, i.e. with end-of-event clan rewards removed. A
 * podium is a MAX() over a member's days, so a single 1006-chest placement drop
 * would sit at the top of it forever — see src/data/clan-reward-chests.ts. The
 * unfiltered chests/points columns stay for verifyClanSummary.
 */
export function getSingleDayRecords(clanId: number): {
  byChests: SingleDayRecord[];
  byPoints: SingleDayRecord[];
} {
  ensureFresh(clanId);
  const db = getDb();

  const query = (metric: 'earned_chests' | 'earned_points') => db.prepare(`
    WITH best AS (
      SELECT member_id, MAX(${metric}) AS value
      FROM chest_daily_summary
      WHERE clan_id = ?
      GROUP BY member_id
    )
    SELECT b.member_id AS memberId,
           m.name AS memberName,
           b.value AS value,
           (SELECT s.game_day FROM chest_daily_summary s
              WHERE s.clan_id = ? AND s.member_id = b.member_id AND s.${metric} = b.value
              ORDER BY s.game_day DESC LIMIT 1) AS date
    FROM best b
    JOIN members m ON m.id = b.member_id
    WHERE b.value > 0
    ORDER BY b.value DESC, LOWER(m.name) ASC
    LIMIT 3
  `).all(clanId, clanId) as SingleDayRecord[];

  return { byChests: query('earned_chests'), byPoints: query('earned_points') };
}

/**
 * All-time top contributors by chest count and by points, top `limit` each.
 * Aggregates the rollup rather than the full chest_records history.
 *
 * Also on the earned_* columns: this is a ranking, and clan placement rewards
 * put ~3600 chests nobody farmed onto one member's all-time total.
 */
export function getTopContributors(
  clanId: number,
  limit: number,
  fromDay?: string,
  toDay?: string,
): {
  topChests: Array<{ memberId: number; name: string; chests: number }>;
  topPoints: Array<{ memberId: number; name: string; points: number }>;
} {
  ensureFresh(clanId);
  const db = getDb();
  const windowed = !!(fromDay && toDay);
  const range = windowed ? ' AND s.game_day >= ? AND s.game_day <= ?' : '';
  const args = (last: number): unknown[] =>
    (windowed ? [clanId, fromDay, toDay, last] : [clanId, last]);

  const topChests = db.prepare(`
    SELECT m.id AS memberId, m.name, SUM(s.earned_chests) AS chests
    FROM chest_daily_summary s JOIN members m ON m.id = s.member_id
    WHERE s.clan_id = ?${range}
    GROUP BY s.member_id HAVING chests > 0 ORDER BY chests DESC LIMIT ?
  `).all(...args(limit)) as Array<{ memberId: number; name: string; chests: number }>;

  const topPoints = db.prepare(`
    SELECT m.id AS memberId, m.name, SUM(s.earned_points) AS points
    FROM chest_daily_summary s JOIN members m ON m.id = s.member_id
    WHERE s.clan_id = ?${range}
    GROUP BY s.member_id HAVING points > 0 ORDER BY points DESC LIMIT ?
  `).all(...args(limit)) as Array<{ memberId: number; name: string; points: number }>;

  return { topChests, topPoints };
}

/**
 * Top contributors for a window as ONE ranked list carrying both figures.
 *
 * getTopContributors returns two independent top-N lists, which is the right
 * shape for two podiums and the wrong one for a single table: a member can
 * place in the points list and not the chest list, so merging the two on the
 * client leaves rows whose chest count is simply unknown. Ranked by points,
 * with chests as the tiebreak and name last so the order is total.
 *
 * earned_* throughout — this ranks members against each other, and an
 * end-of-event placement drop belongs to the clan, not to whoever the game
 * handed it to. See src/data/clan-reward-chests.ts.
 */
export function getWindowContributors(
  clanId: number,
  limit: number,
  fromDay?: string,
  toDay?: string,
): Array<{
  memberId: number; name: string; chests: number; points: number;
  activeDays: number; bestDayPoints: number;
}> {
  ensureFresh(clanId);
  const windowed = !!(fromDay && toDay);
  const range = windowed ? ' AND s.game_day >= ? AND s.game_day <= ?' : '';
  const params: unknown[] = windowed ? [clanId, fromDay, toDay, limit] : [clanId, limit];

  return getDb().prepare(`
    SELECT m.id   AS memberId,
           m.name AS name,
           SUM(s.earned_chests) AS chests,
           SUM(s.earned_points) AS points,
           -- Consistency, from the same GROUP BY rather than a second pass.
           -- activeDays is what separates someone who turned up all week from
           -- someone who had one enormous evening; bestDayPoints is what says
           -- WHICH of the two a big total actually was.
           COUNT(DISTINCT s.game_day) AS activeDays,
           MAX(s.earned_points)       AS bestDayPoints
    FROM chest_daily_summary s JOIN members m ON m.id = s.member_id
    WHERE s.clan_id = ?${range}
    GROUP BY s.member_id
    HAVING chests > 0 OR points > 0
    ORDER BY points DESC, chests DESC, LOWER(m.name) ASC
    LIMIT ?
  `).all(...params) as Array<{
    memberId: number; name: string; chests: number; points: number;
    activeDays: number; bestDayPoints: number;
  }>;
}

/**
 * Clan totals for a game-day window (inclusive on both ends), or all time when
 * the bounds are omitted.
 *
 * Both column pairs come back. The caller picks, and has to: a clan total is
 * *holdings* and an end-of-event placement drop is genuinely part of it, while
 * anything that ranks members against each other has to use the earned_* pair
 * or one account wears the whole clan's prize. See src/data/clan-reward-chests.ts.
 *
 * Bounds are game days (YYYY-MM-DD), not timestamps, because that is the
 * rollup's own key — `game_day` was computed once at rebuild with the rollover
 * modifier applied, so a BETWEEN here is exactly the window a
 * `effective_at >= from AND effective_at < to` scan of chest_records would
 * select, without re-deriving the date per row.
 */
export function getWindowTotals(
  clanId: number,
  fromDay?: string,
  toDay?: string,
): WindowTotals {
  ensureFresh(clanId);
  const windowed = !!(fromDay && toDay);
  const sql = `
    SELECT COALESCE(SUM(chests), 0)        AS chests,
           COALESCE(SUM(points), 0)        AS points,
           COALESCE(SUM(earned_chests), 0) AS earnedChests,
           COALESCE(SUM(earned_points), 0) AS earnedPoints,
           COUNT(DISTINCT member_id)       AS activeMembers
    FROM chest_daily_summary
    WHERE clan_id = ?${windowed ? ' AND game_day >= ? AND game_day <= ?' : ''}
  `;
  const params: unknown[] = windowed ? [clanId, fromDay, toDay] : [clanId];
  const totals = getDb().prepare(sql).get(...params) as WindowTotals;
  return { ...totals, rosterMembers: getWindowRosterSize(clanId, fromDay, toDay) };
}

/**
 * How many members the clan had over a game-day window — the denominator for
 * `activeMembers`.
 *
 * "Had" means overlapped the window: joined on or before its last day, and
 * either still on the roster or last seen on or after its first day. `left_at`
 * is only populated for departures the scanner actually witnessed, so
 * `last_seen` is the fallback for the majority of inactive rows.
 *
 * `members.first_seen` / `last_seen` are wall-clock instants while the window
 * is in game days, so both are shifted by the rollover before comparing —
 * otherwise a member first seen between midnight and 17:00 UTC looks a day
 * younger than the game day their first chest landed on.
 *
 * All time is every member the clan has ever had, matching a `COUNT(DISTINCT
 * member_id)` with no bounds.
 */
function getWindowRosterSize(clanId: number, fromDay?: string, toDay?: string): number {
  if (!fromDay || !toDay) {
    return (getDb().prepare(
      'SELECT COUNT(*) AS n FROM members WHERE clan_id = ?',
    ).get(clanId) as { n: number }).n;
  }
  const shift = `-${loadConfig().gameDayRolloverUtcHour} hours`;
  return (getDb().prepare(`
    SELECT COUNT(*) AS n
    FROM members
    WHERE clan_id = ?
      AND DATE(first_seen, ?) <= ?
      AND (is_active = 1 OR DATE(COALESCE(left_at, last_seen), ?) >= ?)
  `).get(clanId, shift, toDay, shift, fromDay) as { n: number }).n;
}

/**
 * One row per game day that had any activity, for the window (or all time).
 *
 * Days with no chests are ABSENT, not zero — the rollup only holds
 * (member, day) pairs that earned something. Callers that draw a chart must
 * expand this against the window into a dense skeleton themselves; treating a
 * missing row as "the scanner was down" is wrong, and treating it as a gap in
 * the x-axis silently compresses quiet days out of the picture.
 */
export function getWindowDailySeries(
  clanId: number,
  fromDay?: string,
  toDay?: string,
): DailyActivityPoint[] {
  ensureFresh(clanId);
  const windowed = !!(fromDay && toDay);
  const sql = `
    SELECT game_day                        AS day,
           COALESCE(SUM(chests), 0)        AS chests,
           COALESCE(SUM(points), 0)        AS points,
           COALESCE(SUM(earned_chests), 0) AS earnedChests,
           COALESCE(SUM(earned_points), 0) AS earnedPoints,
           COUNT(DISTINCT member_id)       AS activeMembers
    FROM chest_daily_summary
    WHERE clan_id = ?${windowed ? ' AND game_day >= ? AND game_day <= ?' : ''}
    GROUP BY game_day
    ORDER BY game_day
  `;
  const params: unknown[] = windowed ? [clanId, fromDay, toDay] : [clanId];
  return getDb().prepare(sql).all(...params) as DailyActivityPoint[];
}

/** One member's figures across two adjacent windows. */
export interface MemberWindowComparison {
  memberId: number;
  name: string;
  firstSeen: string;
  isActive: number;
  chests: number;
  points: number;
  prevChests: number;
  prevPoints: number;
}

/**
 * Every member who contributed in EITHER of two adjacent windows, with both
 * sets of figures on one row.
 *
 * getWindowContributors answers "who is on top"; this answers "who moved",
 * which needs the whole roster rather than a top-N — the member who mattered
 * last week and is missing this week is precisely the one a top-N of THIS week
 * cannot contain.
 *
 * Two things it does that the leaderboard deliberately does not:
 *
 * - It ignores is_active. A member who faded and was then swept by the daily
 *   inactivity job is absent from getLeaderboard entirely (includeAllMembers
 *   still filters is_active = 1), and they are the single largest drop on the
 *   board. Their row comes back with is_active so the caller can badge it.
 * - It returns first_seen, so a caller can exclude someone who JOINED inside
 *   the window. Their previous window is empty for a reason that is not a
 *   drop, and reporting them as "down 100%" is how a watchlist teaches people
 *   to ignore it.
 *
 * The two windows must be adjacent and previous-then-current; the outer range
 * scan covers prevFrom..curTo in one pass and the CASE arms split it.
 * earned_* throughout — this compares members against each other over time,
 * and a placement drop is the clan's, not the recipient's.
 */
export function getMemberWindowComparison(
  clanId: number,
  prevFromDay: string,
  prevToDay: string,
  curFromDay: string,
  curToDay: string,
): MemberWindowComparison[] {
  ensureFresh(clanId);
  return getDb().prepare(`
    SELECT m.id         AS memberId,
           m.name       AS name,
           m.first_seen AS firstSeen,
           m.is_active  AS isActive,
           COALESCE(SUM(CASE WHEN s.game_day >= ? AND s.game_day <= ? THEN s.earned_chests END), 0) AS chests,
           COALESCE(SUM(CASE WHEN s.game_day >= ? AND s.game_day <= ? THEN s.earned_points END), 0) AS points,
           COALESCE(SUM(CASE WHEN s.game_day >= ? AND s.game_day <= ? THEN s.earned_chests END), 0) AS prevChests,
           COALESCE(SUM(CASE WHEN s.game_day >= ? AND s.game_day <= ? THEN s.earned_points END), 0) AS prevPoints
    FROM chest_daily_summary s
    JOIN members m ON m.id = s.member_id
    WHERE s.clan_id = ? AND s.game_day >= ? AND s.game_day <= ?
    GROUP BY s.member_id
    HAVING points > 0 OR prevPoints > 0
    ORDER BY points DESC, prevPoints DESC, LOWER(m.name) ASC
  `).all(
    curFromDay, curToDay,
    curFromDay, curToDay,
    prevFromDay, prevToDay,
    prevFromDay, prevToDay,
    clanId, prevFromDay, curToDay,
  ) as MemberWindowComparison[];
}

export interface Concentration {
  totalPoints: number;
  contributors: number;
  topFiveShare: number | null;
  membersForHalf: number | null;
  weekly: Array<{ weekStart: string; share: number }>;
}

/**
 * How much of the clan's output comes from how few people.
 *
 * A leader can read a leaderboard for months without noticing that four of
 * fifty members produce half of everything — until two of them go quiet and the
 * clan misses a target it has always hit. The level is context; the TREND is
 * the signal, which is why the weekly series matters more than the headline.
 *
 * earned_points throughout, and this is the surface where that matters most: a
 * single end-of-event placement drop lands ~3,600 chests on ONE account, so on
 * the raw column the card would report near-total dependency on one member in
 * exactly the weeks a clan did best together. It would lie precisely when
 * someone was most likely to read it.
 *
 * `weeks` buckets on the game week (Sunday at the rollover), matching every
 * other weekly window on the site: SQLite's strftime('%w') gives the weekday of
 * the already-rollover-shifted game_day, so subtracting it lands on that week's
 * Sunday without re-deriving anything.
 */
export function getConcentration(
  clanId: number,
  fromDay: string | undefined,
  toDay: string | undefined,
  weeks = 8,
): Concentration {
  ensureFresh(clanId);
  const db = getDb();
  const windowed = !!(fromDay && toDay);
  const range = windowed ? ' AND game_day >= ? AND game_day <= ?' : '';
  const params: unknown[] = windowed ? [clanId, fromDay, toDay] : [clanId];

  const ranked = db.prepare(`
    SELECT SUM(earned_points) AS points
    FROM chest_daily_summary
    WHERE clan_id = ?${range}
    GROUP BY member_id
    HAVING points > 0
    ORDER BY points DESC
  `).all(...params) as Array<{ points: number }>;

  const totalPoints = ranked.reduce((sum, r) => sum + r.points, 0);
  let running = 0;
  let membersForHalf: number | null = null;
  for (let i = 0; i < ranked.length; i += 1) {
    running += ranked[i].points;
    if (membersForHalf === null && running >= totalPoints / 2) membersForHalf = i + 1;
  }
  const topFive = ranked.slice(0, 5).reduce((sum, r) => sum + r.points, 0);

  // Trend, always over recent game weeks regardless of the selected window —
  // a concentration figure for one week is a fact, and only the run of them
  // says whether the clan is becoming more or less dependent.
  const weeklyRows = db.prepare(`
    SELECT DATE(game_day, '-' || CAST(strftime('%w', game_day) AS INTEGER) || ' days') AS weekStart,
           member_id AS memberId,
           SUM(earned_points) AS points
    FROM chest_daily_summary
    WHERE clan_id = ?
    GROUP BY weekStart, member_id
    HAVING points > 0
    ORDER BY weekStart DESC
  `).all(clanId) as Array<{ weekStart: string; memberId: number; points: number }>;

  const byWeek = new Map<string, number[]>();
  for (const row of weeklyRows) {
    const hit = byWeek.get(row.weekStart);
    if (hit) hit.push(row.points);
    else byWeek.set(row.weekStart, [row.points]);
  }
  const weekly = [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, weeks)
    .map(([weekStart, points]) => {
      const sorted = [...points].sort((a, b) => b - a);
      const total = sorted.reduce((s, p) => s + p, 0);
      const top = sorted.slice(0, 5).reduce((s, p) => s + p, 0);
      return { weekStart, share: total > 0 ? top / total : 0 };
    })
    .reverse();

  return {
    totalPoints,
    contributors: ranked.length,
    // Under six contributors "the top five" is very nearly everyone, and the
    // share is arithmetic rather than information.
    topFiveShare: ranked.length >= 6 && totalPoints > 0 ? topFive / totalPoints : null,
    membersForHalf,
    weekly,
  };
}

/**
 * One member's day-by-day figures, sparse (only days they earned something).
 *
 * The caller expands this against the window into a dense skeleton. A missing
 * day here means "no chests", NOT "the scanner was down" — the two are
 * different questions and only getScanCoverage answers the second one.
 */
export function getMemberDailySeries(
  clanId: number,
  memberId: number,
  fromDay: string,
  toDay: string,
): Array<{ day: string; chests: number; points: number }> {
  ensureFresh(clanId);
  return getDb().prepare(`
    SELECT game_day AS day, earned_chests AS chests, earned_points AS points
    FROM chest_daily_summary
    WHERE clan_id = ? AND member_id = ? AND game_day >= ? AND game_day <= ?
    ORDER BY game_day
  `).all(clanId, memberId, fromDay, toDay) as Array<{ day: string; chests: number; points: number }>;
}

/**
 * Test-only: clear the in-memory freshness counters so a fresh test database
 * rebuilds the rollup from scratch rather than trusting a prior test's state
 * (the counters are module singletons that outlive a per-test DB swap).
 */
export function resetSummaryStateForTests(): void {
  generation.clear();
  builtGeneration.clear();
}

/**
 * Cross-check the rollup against raw chest_records (member-scoped totals).
 * Not on any hot path — call from a test or an admin diagnostic. Logs a warning
 * on any mismatch so drift is caught rather than silently served.
 *
 * Both column pairs are checked against their own raw recomputation. That the
 * unfiltered pair still equals a plain COUNT(*)/SUM() is the whole reason v70
 * ADDED earned_* columns instead of filtering the rollup in place: had the
 * exclusion been folded into `chests`, this check would have had to learn about
 * it and would have stopped being an independent cross-check.
 */
export function verifyClanSummary(clanId: number): {
  ok: boolean;
  raw: { chests: number; points: number };
  summary: { chests: number; points: number };
  rawEarned: { chests: number; points: number };
  summaryEarned: { chests: number; points: number };
} {
  ensureFresh(clanId);
  const db = getDb();
  const raw = db.prepare(
    'SELECT COUNT(*) AS chests, COALESCE(SUM(point_value), 0) AS points FROM chest_records WHERE clan_id = ? AND member_id IS NOT NULL',
  ).get(clanId) as { chests: number; points: number };
  const summary = db.prepare(
    'SELECT COALESCE(SUM(chests), 0) AS chests, COALESCE(SUM(points), 0) AS points FROM chest_daily_summary WHERE clan_id = ?',
  ).get(clanId) as { chests: number; points: number };
  const rawEarned = db.prepare(
    'SELECT COUNT(*) AS chests, COALESCE(SUM(point_value), 0) AS points FROM chest_records'
      + ` WHERE clan_id = ? AND member_id IS NOT NULL${clanRewardExclusionSql()}`,
  ).get(clanId) as { chests: number; points: number };
  const summaryEarned = db.prepare(
    'SELECT COALESCE(SUM(earned_chests), 0) AS chests, COALESCE(SUM(earned_points), 0) AS points FROM chest_daily_summary WHERE clan_id = ?',
  ).get(clanId) as { chests: number; points: number };
  const ok =
    raw.chests === summary.chests
    && raw.points === summary.points
    && rawEarned.chests === summaryEarned.chests
    && rawEarned.points === summaryEarned.points;
  if (!ok) {
    log.warn(
      `chest_daily_summary drift for clan ${clanId}: raw={${raw.chests},${raw.points}} summary={${summary.chests},${summary.points}}`
        + ` rawEarned={${rawEarned.chests},${rawEarned.points}} summaryEarned={${summaryEarned.chests},${summaryEarned.points}}`,
    );
  }
  return { ok, raw, summary, rawEarned, summaryEarned };
}
