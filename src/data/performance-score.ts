/**
 * Pure scoring for the Performance page: unit ratios → signal values → one
 * score and a status. No database, no clock, so the tests drive it directly.
 * The tunables live in src/config/performance-scoring.ts; the data that feeds
 * this is gathered in src/data/performance.ts.
 */
import {
  PERFORMANCE_SIGNALS,
  type PerformanceConfig,
  type PerformanceSignal,
} from '../config/performance-scoring.js';

/** One measured unit: a closed week, a finished Tin Man run or event run. */
export interface PerformanceUnit {
  /** Actual over expected, uncapped (the real share). 1 = exactly met. */
  ratio: number;
  /** Goal reached, target reached, or (events) took part. */
  hit: boolean;
  /**
   * What the unit counts toward a hit share (goalHits): 1 for a hit, partial
   * for a near miss. Absent = 1 for a hit, 0 otherwise.
   */
  credit?: number;
}

export interface SignalSummary {
  units: number;
  hits: number;
  /** Units that missed but earned partial credit (near misses). */
  near: number;
  /**
   * What the score uses: the mean of the SCORED unit ratios (see scoredRatio),
   * or for goalHits the hit share. Null with no units.
   */
  value: number | null;
  /**
   * Mean of the REAL unit ratios, uncurved and uncapped — what the page shows
   * as "% of the goal / target / median". Null with no units.
   */
  share: number | null;
  /** Has enough units (config.minUnits) to count toward the score. */
  counted: boolean;
}

export type PerformanceStatus = 'over' | 'on-track' | 'under' | 'unscored';

/**
 * actual / expected, uncapped. Never negative. An expectation of zero or less
 * can't be measured against and must be filtered out by the caller.
 */
export function unitRatio(actual: number, expected: number): number {
  if (!(expected > 0)) throw new Error(`unitRatio: expected must be > 0, got ${expected}`);
  return Math.max(actual, 0) / expected;
}

/**
 * What one unit's real share counts for in the score. Up to `overCurve.from`
 * it counts as it is; above, every doubling adds `overCurve.perDoubling`
 * (from 1 at 0.5: 200% → 150%, 400% → 200%), and nothing counts for more than
 * `ratioCap`.
 */
export function scoredRatio(ratio: number, config: Pick<PerformanceConfig, 'overCurve' | 'ratioCap'>): number {
  const share = Math.max(ratio, 0);
  const c = config.overCurve;
  const curved = c && share > c.from ? c.from + c.perDoubling * Math.log2(share / c.from) : share;
  return Math.min(curved, config.ratioCap);
}

/** Median of a list, or null when it is empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const creditOf = (u: PerformanceUnit) => u.credit ?? (u.hit ? 1 : 0);

const mean = (units: PerformanceUnit[], of: (u: PerformanceUnit) => number) =>
  units.reduce((s, u) => s + of(u), 0) / units.length;

function summarize(units: PerformanceUnit[], value: (u: PerformanceUnit) => number, minUnits: number): SignalSummary {
  const any = units.length > 0;
  return {
    units: units.length,
    hits: units.filter((u) => u.hit).length,
    near: units.filter((u) => !u.hit && creditOf(u) > 0).length,
    value: any ? mean(units, value) : null,
    share: any ? mean(units, (u) => u.ratio) : null,
    counted: units.length >= minUnits && any,
  };
}

/**
 * Every signal for one member from their units. Weeks feed two signals: how
 * often the goal was reached (goalHits) and by how much (goalPoints).
 */
export function summarizeSignals(
  units: { weeks: PerformanceUnit[]; tinman: PerformanceUnit[]; events: PerformanceUnit[] },
  config: PerformanceConfig,
): Record<PerformanceSignal, SignalSummary> {
  const scored = (u: PerformanceUnit) => scoredRatio(u.ratio, config);
  return {
    goalHits: summarize(units.weeks, creditOf, config.minUnits.goalHits),
    goalPoints: summarize(units.weeks, scored, config.minUnits.goalPoints),
    tinman: summarize(units.tinman, scored, config.minUnits.tinman),
    events: summarize(units.events, scored, config.minUnits.events),
  };
}

/**
 * Weighted mean of the counted signals, the weights re-normalised over them.
 * Null when no signal counts (or every counted signal weighs 0).
 */
export function compositeScore(
  signals: Record<PerformanceSignal, SignalSummary>,
  config: PerformanceConfig,
): number | null {
  let sum = 0;
  let weight = 0;
  for (const key of PERFORMANCE_SIGNALS) {
    const s = signals[key];
    const w = config.weights[key];
    if (!s.counted || s.value === null || !(w > 0)) continue;
    sum += s.value * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : null;
}

export function statusFor(score: number | null, config: PerformanceConfig): PerformanceStatus {
  if (score === null) return 'unscored';
  if (score >= config.overThreshold) return 'over';
  if (score < config.underThreshold) return 'under';
  return 'on-track';
}

/**
 * Days a member must have been in the clan to be shown for a window of
 * `windowDays`: the timeframe's share of the window, and at least the absolute
 * floor — the floor itself capped at the same share of the window, so a clan
 * tracked for only a couple of weeks still gets a page.
 */
export function requiredPresentDays(windowDays: number, minCoverage: number, config: PerformanceConfig): number {
  if (windowDays <= 0) return 0;
  const share = Math.ceil(windowDays * minCoverage);
  const floor = Math.min(config.minPresentDays, Math.ceil(windowDays * config.minPresentDaysMaxShare));
  return Math.max(share, floor);
}

/**
 * Guards level on `day`, from the estimate's current level and its level-ups:
 * before a level-up was first seen, the member was still at the old level.
 */
export function guardsLevelOn(
  day: string,
  current: number,
  levelUps: ReadonlyArray<{ from: number; by: string }>,
): number {
  let level = current;
  for (let i = levelUps.length - 1; i >= 0; i--) {
    if (day < levelUps[i].by) level = levelUps[i].from;
  }
  return level;
}
