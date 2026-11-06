/**
 * A clan's weekly points goal over time.
 *
 * Admins raise the goal every so often — 30,000 one week, 35,000 the next — and
 * a finished week has to be judged against the goal it was played under, not
 * today's. Until v93 the clan held one number, so raising it quietly turned
 * every earlier week a member had cleared at 30,000 into a miss.
 *
 * Each step reads "from this game day on, the weekly goal is N" (null: no
 * goal). `from` is the first game day of the week the change was made in
 * (data/goal-history.ts), so a change covers the whole week it was made in —
 * the week the Leaderboard was already colouring with it — and every week
 * after, never a week before. Before the first recorded step the first step's
 * value applies: that is the oldest goal anyone set, and the closest thing
 * there is to what those weeks were played under.
 *
 * Pure, and mirrored in web/public/lib/weekly-goal.js;
 * tests/config/weekly-goal-parity.test.ts runs both on the same cases.
 */

export interface WeeklyGoalStep {
  /** First game day (YYYY-MM-DD) the value applies to. */
  from: string;
  weeklyPoints: number | null;
}

const DAY_MS = 86_400_000;

function usable(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** The weekly goal in force on a game day, or null when there was none. */
export function weeklyGoalOn(history: readonly WeeklyGoalStep[], day: string): number | null {
  if (history.length === 0) return null;
  let goal = history[0].weeklyPoints;
  for (const step of history) {
    if (step.from > day) break;
    goal = step.weeklyPoints;
  }
  return usable(goal);
}

/**
 * The mean weekly goal across the game days [fromDay, toDay], rounded, or null
 * when none of them had a goal. A week is a single value (steps start on a week
 * boundary); a month or a year that straddles a raise gets the day-weighted
 * blend, so two weeks at 30,000 and two at 35,000 price the month at 32,500 a
 * week rather than pretending the whole month was played under either.
 */
export function meanWeeklyGoal(history: readonly WeeklyGoalStep[], fromDay: string, toDay: string): number | null {
  const start = Date.parse(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${toDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || history.length === 0) return null;
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

/**
 * The weekly goal to judge [fromDay, toDay] by. `current` is the clan's goal as
 * resolveWeeklyGoalPoints() reads it — null switches the whole feature off, past
 * windows included, exactly as before. A clan with no recorded steps keeps the
 * one number it has.
 */
export function weeklyGoalForDays(
  current: number | null,
  history: readonly WeeklyGoalStep[],
  fromDay: string,
  toDay: string,
): number | null {
  if (usable(current) === null) return null;
  if (history.length === 0) return current;
  return meanWeeklyGoal(history, fromDay, toDay);
}
