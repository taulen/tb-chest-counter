/**
 * Performance page scoring — every tunable in one place.
 *
 * The Performance page (admins only) ranks members against what the clan
 * expects of them and names the over- and underachievers. How much each signal
 * counts is expected to move as the clan uses it, so nothing about the scoring
 * lives anywhere else: change a number here, run `npm run build` (the guard in
 * tests/config/performance-scoring.test.ts checks the values are coherent), ship.
 *
 * How a score is built (see src/data/performance-score.ts):
 *
 *  - Each SIGNAL is measured per unit: a closed clan week, a finished Tin Man
 *    run, a finished event run. A unit only counts for a member who was in the
 *    clan for the whole of it, so a mid-week joiner is never held to that week.
 *  - A unit becomes a RATIO against its expectation (1.0 = exactly met), capped
 *    at `ratioCap` so one huge week can't hide a string of empty ones.
 *  - A signal's value is the mean of its unit ratios; it only counts once the
 *    member has `minUnits` of it in the window.
 *  - The SCORE is the weighted mean of the signals the member has, the weights
 *    re-normalised over those. 1.0 (shown as 100%) = meeting every expectation.
 *
 * Later, admins may get to set weights per clan. `resolvePerformanceConfig` is
 * the one place that would merge such an override over these defaults (e.g. a
 * JSON column on `clans`, as `ancient_planner_defaults` does); every caller
 * already goes through it, and the page renders the weights from the API
 * response rather than from its own copy, so nothing else would need to change.
 */

export const PERFORMANCE_SIGNALS = ['goalHits', 'goalPoints', 'tinman', 'events'] as const;
export type PerformanceSignal = (typeof PERFORMANCE_SIGNALS)[number];

export interface PerformanceTimeframe {
  key: string;
  /** Rolling length in game days, ending today; null = since the clan's data starts. */
  days: number | null;
  /**
   * Share of the window a member must have been in the clan for to be shown at
   * all. Measured against the part of the window the clan has data for, so a
   * 12-month view of a clan tracked for 6 months doesn't exclude everyone.
   */
  minCoverage: number;
}

export interface PerformanceConfig {
  /**
   * Relative weight of each signal in the score. They needn't sum to 1: the
   * score divides by the sum of the weights of the signals a member HAS, so a
   * clan with no weekly goal (or no Tin Man pastes) is scored on the rest.
   *
   *  - goalHits:   share of closed weeks the member reached the weekly points
   *                goal (the Leaderboard's goal) — the consistency signal. A
   *                near miss earns partial credit (goalNearMiss).
   *  - goalPoints: their weekly points as a share of that goal, capped.
   *  - tinman:     Tin Man points per finished run against their guards tier's
   *                target (the Ancient planner targets pasted on Events → Ancients).
   *  - events:     points per finished event run against the clan's median
   *                participant in that run; a run sat out counts as 0.
   */
  weights: Record<PerformanceSignal, number>;
  /** Fewest units a signal needs before it counts toward the score. */
  minUnits: Record<PerformanceSignal, number>;
  /**
   * Partial credit toward `goalHits` for a week that misses the goal but gets
   * close: from `from` of the goal it counts as `credit` of a hit. 0.66 is the
   * Leaderboard's amber "close to goal" band (GOAL_WARN_RATIO in
   * lib/leaderboard-render.js), so a week members saw as amber counts as half.
   * Null = met or not met only.
   */
  goalNearMiss: { from: number; credit: number } | null;
  /** A unit ratio is capped here before averaging (2 = at most 200% per unit). */
  ratioCap: number;
  /** Score at or above this → Overachiever. */
  overThreshold: number;
  /** Score below this → Underachiever. */
  underThreshold: number;
  /**
   * Absolute floor on days in the clan, on top of a timeframe's minCoverage —
   * mostly for All time, which has no coverage share (a member there 2 months
   * of the clan's 6 is a fair All-time row; one there 3 days is not).
   */
  minPresentDays: number;
  /**
   * The floor never asks for more than this share of the window, so a clan
   * tracked for two weeks still gets a page rather than an empty one.
   */
  minPresentDaysMaxShare: number;
  timeframes: PerformanceTimeframe[];
  /** Default timeframe key. */
  defaultTimeframe: string;
  /**
   * Events (EVENT_CATALOG keys) whose runs count toward `events`. Left out on
   * purpose: Triumphal (purchases, not play), Citadels and Heroics (always on,
   * already inside the weekly points).
   */
  participationEvents: string[];
  /** Guards level assumed when a member's is unknown — the Tin Man table's G7. */
  assumedGuardsLevel: number;
  /**
   * A Tin Man run with no targets pasted is measured against the median
   * scoring player instead, rather than dropped. False drops it.
   */
  tinmanMedianFallback: boolean;
  /**
   * Weekly goal multiplier by guards level (level → factor; missing = 1), for
   * holding higher guards to a bigger weekly target than lower ones. All 1
   * today: the clans' goals are flat.
   */
  weeklyGoalScaleByGuards: Partial<Record<number, number>>;
}

export const DEFAULT_PERFORMANCE_CONFIG: PerformanceConfig = {
  weights: {
    goalHits: 0.3,
    goalPoints: 0.2,
    tinman: 0.3,
    events: 0.2,
  },
  minUnits: {
    goalHits: 2,
    goalPoints: 2,
    tinman: 1,
    events: 2,
  },
  goalNearMiss: { from: 0.66, credit: 0.5 },
  ratioCap: 2,
  overThreshold: 1.2,
  underThreshold: 0.7,
  minPresentDays: 21,
  minPresentDaysMaxShare: 0.75,
  timeframes: [
    { key: 'month', days: 30, minCoverage: 0.75 },
    { key: 'quarter', days: 91, minCoverage: 0.75 },
    { key: 'half', days: 182, minCoverage: 0.75 },
    { key: 'year', days: 365, minCoverage: 0.75 },
    { key: 'all', days: null, minCoverage: 0 },
  ],
  defaultTimeframe: 'month',
  participationEvents: ['ancients', 'ragnarok', 'olympus', 'dark-omens', 'runics'],
  assumedGuardsLevel: 7,
  tinmanMedianFallback: true,
  weeklyGoalScaleByGuards: {},
};

/**
 * The scoring config for one clan. Defaults only, for now — the hook for a
 * per-clan override (see the file header).
 */
export function resolvePerformanceConfig(_clanId: number): PerformanceConfig {
  return DEFAULT_PERFORMANCE_CONFIG;
}
