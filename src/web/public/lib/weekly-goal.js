/**
 * The clan's weekly points goal over time, for the pages that colour a past
 * window against it (Leaderboard, share page, Analytics, member profile).
 *
 * Mirrors src/utils/weekly-goal.ts — read the rationale there. In short: each
 * step is "from this game day on, the weekly goal is N", a change covers the
 * whole week it was made in, and a finished week keeps the goal it was played
 * under. tests/config/weekly-goal-parity.test.ts runs both on the same cases.
 *
 * `goal` everywhere below is the /api/leaderboard/goal shape:
 * `{ weeklyPoints, amberPct, history: [{ from, weeklyPoints, amberPct }] }`.
 * The share page builds the same shape from its /clan response.
 */
import { computeGameWindowDates } from './period.js';

// Amber ("close to goal") for a clan that never set its own percent.
export const DEFAULT_GOAL_AMBER_PCT = 66;

const DAY_MS = 86_400_000;

function usable(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** A stored amber percent, or the default when it is unset or out of range. */
export function amberPctOrDefault(pct) {
  return typeof pct === 'number' && Number.isFinite(pct) && pct > 0 && pct < 100 ? pct : DEFAULT_GOAL_AMBER_PCT;
}

function stepOn(history, day) {
  if (!Array.isArray(history) || history.length === 0) return null;
  let found = history[0];
  for (const step of history) {
    if (step.from > day) break;
    found = step;
  }
  return found;
}

/** The weekly goal in force on a game day (YYYY-MM-DD), or null. */
export function weeklyGoalOn(history, day) {
  return usable(stepOn(history, day)?.weeklyPoints);
}

/** The amber percent in force on a game day. */
export function amberPctOn(history, day) {
  return amberPctOrDefault(stepOn(history, day)?.amberPct);
}

/** Amber as a ratio of the goal across [fromDay, toDay]; see the server twin. */
export function amberRatioForDays(currentPct, history, fromDay, toDay) {
  const start = Date.parse(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${toDay}T00:00:00Z`);
  if (!Array.isArray(history) || history.length === 0 || Number.isNaN(start) || Number.isNaN(end)) {
    return amberPctOrDefault(currentPct) / 100;
  }
  let sum = 0;
  let days = 0;
  for (let ms = start; ms <= end; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    if (weeklyGoalOn(history, day) === null) continue;
    sum += amberPctOn(history, day);
    days += 1;
  }
  return (days ? sum / days : amberPctOrDefault(currentPct)) / 100;
}

/** The day-weighted mean weekly goal across [fromDay, toDay], or null. */
export function meanWeeklyGoal(history, fromDay, toDay) {
  const start = Date.parse(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${toDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || !Array.isArray(history) || history.length === 0) return null;
  let sum = 0;
  let days = 0;
  for (let ms = start; ms <= end; ms += DAY_MS) {
    const goal = weeklyGoalOn(history, new Date(ms).toISOString().slice(0, 10));
    if (goal !== null) {
      sum += goal;
      days += 1;
    }
  }
  return days ? Math.round(sum / days) : null;
}

/** The weekly goal to judge [fromDay, toDay] by; null when the clan has none. */
export function weeklyGoalForDays(current, history, fromDay, toDay) {
  if (usable(current) === null) return null;
  if (!Array.isArray(history) || history.length === 0) return current;
  return meanWeeklyGoal(history, fromDay, toDay);
}

/**
 * The WEEKLY goal a (period, offset) window is judged against — feed it to
 * scaleGoalForPeriod() for the window's own target. Last week at offset 1 gets
 * last week's goal, not this one's. 'all' returns the current goal, which
 * scaleGoalForPeriod then drops (All Time has no length to price a goal for).
 */
export function weeklyGoalForWindow(goal, period, offset, rolloverHr, weekStart) {
  const current = usable(goal?.weeklyPoints);
  if (current === null) return null;
  const dates = computeGameWindowDates(period, offset || 0, rolloverHr, weekStart);
  if (!dates) return current;
  return weeklyGoalForDays(current, goal.history, dates.from, dates.to);
}

/**
 * Where amber starts for a (period, offset) window, as a ratio of its goal —
 * the clan's own percent in force then (Clans → Leaderboard goal), 0.66 when
 * it never set one. Pass it to the goal helpers in lib/leaderboard-render.js.
 */
export function amberRatioForWindow(goal, period, offset, rolloverHr, weekStart) {
  const dates = computeGameWindowDates(period, offset || 0, rolloverHr, weekStart);
  if (!dates) return amberPctOrDefault(goal?.amberPct) / 100;
  return amberRatioForDays(goal?.amberPct, goal?.history, dates.from, dates.to);
}
