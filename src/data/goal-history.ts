/**
 * Storage for a clan's weekly points goal over time (v93 `clan_goal_history`).
 * The lookup rules live in utils/weekly-goal.ts; this is where steps are
 * written, and how the table was first filled.
 *
 * Every function takes the database handle so the v93 migration can run them
 * before getDb() is wired up; clan-repo.ts passes getDb().
 */
import type Database from 'better-sqlite3';
import { gameDateFor, gameWindow, isWeekStart, type WeekStart } from '../utils/game-day.js';
import type { WeeklyGoalStep } from '../utils/weekly-goal.js';

/** First game day of the clan week holding the instant `ms`. */
export function weekFirstDay(ms: number, rolloverUtcHour: number, weekStart: WeekStart): string {
  const week = gameWindow('weekly', 0, rolloverUtcHour, weekStart, ms)!;
  return gameDateFor(Date.parse(week.from), rolloverUtcHour);
}

export interface GoalHistoryRow extends WeeklyGoalStep {
  /** When the step was last written (ISO), for the Clans page. */
  setAt: string;
}

/** A clan's goal steps, oldest first. */
export function readGoalHistory(db: Database.Database, clanId: number): GoalHistoryRow[] {
  return db.prepare(`
    SELECT effective_from AS "from", weekly_points AS weeklyPoints, set_at AS setAt
    FROM clan_goal_history WHERE clan_id = ? ORDER BY effective_from
  `).all(clanId) as GoalHistoryRow[];
}

/**
 * Record that, from the week starting `effectiveFrom`, the goal is
 * `weeklyPoints`. A second change in the same week replaces the first (the last
 * one made is what the week was played under), and a step later than this one
 * — only possible after the clan switched week shape — is dropped, because the
 * goal just saved is the one in force from now on. A step that repeats the one
 * before it is removed, so turning the colours off and on again, or setting a
 * goal back to what it was, leaves no noise behind.
 */
export function writeGoalStep(
  db: Database.Database,
  clanId: number,
  effectiveFrom: string,
  weeklyPoints: number | null,
  setAt: string,
): void {
  db.prepare(`
    INSERT INTO clan_goal_history (clan_id, effective_from, weekly_points, set_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (clan_id, effective_from) DO UPDATE SET weekly_points = excluded.weekly_points, set_at = excluded.set_at
  `).run(clanId, effectiveFrom, weeklyPoints, setAt);
  db.prepare('DELETE FROM clan_goal_history WHERE clan_id = ? AND effective_from > ?').run(clanId, effectiveFrom);
  collapseRepeats(db, clanId);
}

function collapseRepeats(db: Database.Database, clanId: number): void {
  const remove = db.prepare('DELETE FROM clan_goal_history WHERE clan_id = ? AND effective_from = ?');
  let previous: number | null | undefined;
  for (const step of readGoalHistory(db, clanId)) {
    if (previous !== undefined && step.weeklyPoints === previous) remove.run(clanId, step.from);
    else previous = step.weeklyPoints;
  }
}

interface AuditGoalChange { at: string; details: string | null }

/**
 * Fill the table from what is already known (migration v93).
 *
 * Every save of the goal since it shipped is in the audit log as
 * `clan.leaderboard_goal.update`, with the target clan and the new number, so
 * the real history can be rebuilt rather than guessed: each change becomes a
 * step from the first day of the week it was made in. The clan comes from the
 * details, not audit_log.clan_id — that column is the clan the admin was
 * VIEWING, which for a superadmin editing another clan is the wrong one.
 *
 * Then the saved number is made to hold for the week in progress, so a clan
 * whose goal predates the audit log (or was set some other way) still gets one
 * step carrying it.
 */
export function backfillGoalHistory(db: Database.Database, rolloverUtcHour: number, nowMs: number): void {
  const clans = db.prepare(
    'SELECT id, week_start AS weekStart, leaderboard_weekly_goal_points AS points FROM clans',
  ).all() as Array<{ id: number; weekStart: string; points: number | null }>;
  const byId = new Map(clans.map((c) => [c.id, c]));
  const shape = (c: { weekStart: string }): WeekStart => (isWeekStart(c.weekStart) ? c.weekStart : 'sunday');
  const positive = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

  const changes = db.prepare(`
    SELECT created_at AS at, details FROM audit_log
    WHERE action = 'clan.leaderboard_goal.update' ORDER BY id
  `).all() as AuditGoalChange[];
  for (const change of changes) {
    let details: { clanId?: unknown; weeklyPoints?: unknown };
    try {
      details = JSON.parse(change.details ?? '');
    } catch {
      continue;
    }
    const clan = byId.get(Number(details?.clanId));
    const ms = Date.parse(change.at);
    if (!clan || Number.isNaN(ms)) continue;
    writeGoalStep(db, clan.id, weekFirstDay(ms, rolloverUtcHour, shape(clan)), positive(details.weeklyPoints), change.at);
  }

  const now = new Date(nowMs).toISOString();
  for (const clan of clans) {
    const current = positive(clan.points);
    const steps = readGoalHistory(db, clan.id);
    const last = steps[steps.length - 1];
    if (last ? last.weeklyPoints === current : current === null) continue;
    writeGoalStep(db, clan.id, weekFirstDay(nowMs, rolloverUtcHour, shape(clan)), current, now);
  }
}
