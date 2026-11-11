/**
 * The Performance page's report: every active member scored against what the
 * clan expects of them over a timeframe, so admins can see who overachieves
 * and who falls short.
 *
 * Signals, scoring and every threshold are in src/config/performance-scoring.ts
 * (the tunables) and src/data/performance-score.ts (the pure maths). This file
 * only gathers the units:
 *
 *  - Weeks: the clan's closed game weeks (its own week start, Sunday or Tinman
 *    to Tinman), each member's earned points against the Leaderboard's weekly
 *    goal. Same numbers as the Leaderboard: chest_daily_summary's earned
 *    points, clan rewards out.
 *  - Tin Man runs: the pasted standings' run total against the run's target for
 *    the member's guards tier — their level on that run's day, from the guards
 *    estimate's level-ups; unknown = the configured assumed level.
 *  - Event runs: each finished run of the configured events, ranked the Events
 *    page's way, against the run's median participant. Sitting a run out is 0.
 *
 * A unit is "in" a timeframe when it ENDED inside it, and counts for a member
 * only if they were in the clan for the whole of it — so a member who joined
 * mid-week is never held to that week, and the windows need no pro-rating.
 *
 * Tenure ("in the clan since") is the earliest of `members.first_seen`, their
 * first chest and their first might reading. `first_seen` alone is the
 * SURVIVING row's date after a player merge, i.e. the new nick's; the chests
 * and readings a merge repoints keep the old nick's history.
 */
import { getDb } from './database.js';
import {
  resolvePerformanceConfig,
  type PerformanceConfig,
  type PerformanceSignal,
} from '../config/performance-scoring.js';
import { getEventDef } from '../config/event-catalog.js';
import {
  getClanDailyEarnedPoints,
  getClanDataStartDay,
  getMemberFirstChestDays,
} from './repositories/chest-summary-repo.js';
import { getGuardsEstimates } from './repositories/guards-repo.js';
import * as tinmanRepo from './repositories/tinman-repo.js';
import { rankedRun } from './member-events.js';
import { getEventOccurrences } from '../external/event-calendar.js';
import { daysBetweenGameDates, gameDateFor, gameWindow, type WeekStart } from '../utils/game-day.js';
import { cached, invalidate } from '../utils/ttl-cache.js';
import { amberPctOrDefault, amberRatioForDays, weeklyGoalForDays, type WeeklyGoalStep } from '../utils/weekly-goal.js';
import { readGoalHistory } from './goal-history.js';
import type { GuardsEstimate } from './guards-estimator.js';
import type { TargetTier } from './tinman-parse.js';
import {
  compositeScore,
  guardsLevelOn,
  median,
  requiredPresentDays,
  statusFor,
  summarizeSignals,
  unitRatio,
  type PerformanceStatus,
  type PerformanceUnit,
  type SignalSummary,
} from './performance-score.js';

/**
 * Dropped under this same literal by notifyChestDataChanged (chest-summary-repo),
 * every Tin Man write (tinman-repo) and invalidateGuardsCache (guards-repo).
 */
const CACHE_PREFIX = 'performance:';
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Far more closed weeks than any clan has; only a guard on the walk back. */
const MAX_WEEKS = 600;

export interface PerformanceMemberRow {
  memberId: number;
  name: string;
  /** Current estimated guards level, or null when unknown. */
  guardsLevel: number | null;
  /** First game day in the clan (see the file header). */
  tenureStart: string;
  /** Game days in the clan within the window. */
  presentDays: number;
  score: number | null;
  status: PerformanceStatus;
  signals: Record<PerformanceSignal, SignalSummary>;
  /** Tin Man runs measured against the median player (no targets pasted). */
  tinmanMedianRuns: number;
}

export interface PerformanceTooNewRow {
  memberId: number;
  name: string;
  tenureStart: string;
  presentDays: number;
}

export interface PerformanceReport {
  timeframe: string;
  timeframes: Array<{ key: string; days: number | null }>;
  /** Today's game day; the window runs [windowFrom, today). */
  today: string;
  windowFrom: string | null;
  /** The window's last whole game day (yesterday). */
  windowTo: string | null;
  /** The clan's first game day with chest data. */
  dataStart: string | null;
  windowDays: number;
  /** Days in the clan a member needs to be shown. */
  requiredDays: number;
  weeklyGoal: number | null;
  /**
   * The weekly goal across the window, one step per value, the first clamped
   * to windowFrom. Each closed week is judged by the step it falls in, so more
   * than one step means the goal changed inside this timeframe.
   */
  goalSteps: WeeklyGoalStep[];
  /** Where amber ("close to goal") starts now, in percent of the goal. */
  goalAmberPct: number;
  weekStart: WeekStart;
  units: {
    weeks: number;
    tinmanRuns: number;
    tinmanRunsWithTargets: number;
    eventRuns: number;
  };
  /** Finished runs counted per event, in config order. */
  events: Array<{ key: string; name: string; runs: number }>;
  /** As used for THIS timeframe: `minUnits` already carries its overrides. */
  scoring: Pick<PerformanceConfig, 'weights' | 'minUnits' | 'overCurve' | 'ratioCap' | 'overThreshold' | 'underThreshold'
    | 'assumedGuardsLevel' | 'goalNearMiss' | 'tinmanMedianFallback'>;
  members: PerformanceMemberRow[];
  tooNew: PerformanceTooNewRow[];
}

export interface PerformanceInput {
  clanId: number;
  timeframe: string;
  weeklyGoal: number | null;
  /** The clan's amber percent now (null = the default); history covers the past. */
  goalAmberPct?: number | null;
  weekStart: WeekStart;
  rolloverUtcHour: number;
  nowMs?: number;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const minDay = (...days: Array<string | null | undefined>): string | null =>
  days.filter((d): d is string => !!d).sort()[0] ?? null;

interface MemberBase {
  id: number;
  name: string;
  tenureStart: string;
}

function activeMembers(clanId: number, rollover: number, today: string): MemberBase[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, name, first_seen AS firstSeen FROM members WHERE clan_id = ? AND is_active = 1',
  ).all(clanId) as Array<{ id: number; name: string; firstSeen: string }>;
  const firstSnapshot = new Map(
    (db.prepare(`
      SELECT member_id AS memberId, MIN(game_date) AS d FROM member_snapshots
      WHERE clan_id = ? AND game_date != '' GROUP BY member_id
    `).all(clanId) as Array<{ memberId: number; d: string }>).map((r) => [r.memberId, r.d]),
  );
  const firstChest = getMemberFirstChestDays(clanId);
  return rows.map((r) => {
    const seenMs = Date.parse(r.firstSeen);
    const seenDay = Number.isNaN(seenMs) ? null : gameDateFor(seenMs, rollover);
    return {
      id: r.id,
      name: r.name,
      tenureStart: minDay(seenDay, firstChest.get(r.id), firstSnapshot.get(r.id)) ?? today,
    };
  });
}

function levelOn(est: GuardsEstimate | undefined, day: string): number | null {
  return est ? guardsLevelOn(day, est.level, est.levelUps) : null;
}

interface WeekUnit { firstDay: string; lastDay: string }

/** Closed weeks that ended in [windowFrom, today) and lie wholly inside the data. */
function closedWeeks(input: PerformanceInput, nowMs: number, windowFrom: string, dataStart: string): WeekUnit[] {
  const weeks: WeekUnit[] = [];
  for (let offset = 1; offset <= MAX_WEEKS; offset++) {
    const w = gameWindow('weekly', offset, input.rolloverUtcHour, input.weekStart, nowMs);
    if (!w) break;
    const firstDay = gameDateFor(Date.parse(w.from), input.rolloverUtcHour);
    const lastDay = gameDateFor(Date.parse(w.to) - 1, input.rolloverUtcHour);
    if (lastDay < windowFrom || firstDay < dataStart) break;
    weeks.push({ firstDay, lastDay });
  }
  return weeks;
}

/**
 * The goal each closed week was played under. Raising the goal from 30,000 to
 * 35,000 must not turn a week cleared at 32,000 into a miss, so every week is
 * judged by the clan's goal history (utils/weekly-goal.ts), never today's number.
 */
interface WeekGoal {
  goal: number | null;
  /** Where that week's amber band started, as a ratio of its goal. */
  amber: number;
}

function goalsForWeeks(input: PerformanceInput, weeks: WeekUnit[]): WeekGoal[] {
  const amber = amberPctOrDefault(input.goalAmberPct) / 100;
  if (!input.weeklyGoal || weeks.length === 0) return weeks.map(() => ({ goal: null, amber }));
  const history = readGoalHistory(getDb(), input.clanId);
  return weeks.map((w) => ({
    goal: weeklyGoalForDays(input.weeklyGoal, history, w.firstDay, w.lastDay),
    amber: amberRatioForDays(input.goalAmberPct, history, w.firstDay, w.lastDay),
  }));
}

/** The judged weeks' goals as steps, oldest first: one entry per change. */
function goalStepsOf(weeks: WeekUnit[], weekGoals: WeekGoal[]): WeeklyGoalStep[] {
  const steps: WeeklyGoalStep[] = [];
  for (let i = weeks.length - 1; i >= 0; i--) {
    const last = steps[steps.length - 1];
    const amberPct = Math.round(weekGoals[i].amber * 100);
    if (last && last.weeklyPoints === weekGoals[i].goal && last.amberPct === amberPct) continue;
    steps.push({ from: weeks[i].firstDay, weeklyPoints: weekGoals[i].goal, amberPct });
  }
  return steps;
}

function weekUnits(
  input: PerformanceInput,
  config: PerformanceConfig,
  weeks: WeekUnit[],
  /** Per week, the goal and amber band it was played under (see goalsForWeeks). */
  weekGoals: WeekGoal[],
  members: MemberBase[],
  guards: Map<number, GuardsEstimate>,
): Map<number, PerformanceUnit[]> {
  const out = new Map<number, PerformanceUnit[]>();
  if (!input.weeklyGoal || weeks.length === 0) return out;

  const dayToWeek = new Map<string, number>();
  weeks.forEach((w, i) => {
    for (let d = w.firstDay; d <= w.lastDay; d = addDays(d, 1)) dayToWeek.set(d, i);
  });
  const points = new Map<number, number[]>();
  const oldest = weeks[weeks.length - 1].firstDay;
  for (const r of getClanDailyEarnedPoints(input.clanId, oldest, weeks[0].lastDay)) {
    const i = dayToWeek.get(r.day);
    if (i === undefined) continue;
    let list = points.get(r.memberId);
    if (!list) points.set(r.memberId, (list = new Array<number>(weeks.length).fill(0)));
    list[i] += r.points;
  }

  for (const m of members) {
    const units: PerformanceUnit[] = [];
    weeks.forEach((w, i) => {
      if (m.tenureStart > w.firstDay) return;
      const { goal: weekGoal, amber } = weekGoals[i];
      if (!weekGoal) return;
      const level = levelOn(guards.get(m.id), w.firstDay) ?? config.assumedGuardsLevel;
      const goal = weekGoal * (config.weeklyGoalScaleByGuards[level] ?? 1);
      if (!(goal > 0)) return;
      const actual = points.get(m.id)?.[i] ?? 0;
      const hit = actual >= goal;
      const near = !hit && !!config.goalNearMiss && actual >= goal * amber;
      units.push({
        ratio: unitRatio(actual, goal),
        hit,
        credit: hit ? 1 : near ? config.goalNearMiss!.credit : 0,
      });
    });
    out.set(m.id, units);
  }
  return out;
}

interface TinmanResult {
  units: Map<number, PerformanceUnit[]>;
  medianRuns: Map<number, number>;
  runs: number;
  runsWithTargets: number;
}

function tinmanUnits(
  clanId: number,
  config: PerformanceConfig,
  today: string,
  windowFrom: string,
  members: MemberBase[],
  guards: Map<number, GuardsEstimate>,
): TinmanResult {
  const units = new Map<number, PerformanceUnit[]>(members.map((m) => [m.id, []]));
  const medianRuns = new Map<number, number>();
  let runs = 0;
  let runsWithTargets = 0;

  // A run is in the window when its Tinman day (its last day) is, and only once
  // it's over: mid-run everyone simply reads as not there yet.
  const dates = tinmanRepo.listTinmanDates(clanId, 10_000, 'ancients')
    .filter((d) => d < today && d >= windowFrom);
  for (const date of dates) {
    const standings = tinmanRepo.getTinmanStandings(clanId, date, 'ancients');
    if (standings.summons.length === 0) continue;
    const totals = new Map<number, number>();
    for (const p of standings.players) if (p.memberId !== null) totals.set(p.memberId, p.total);

    const tiers = tinmanRepo.getTinmanTargets(clanId, date)?.tiers ?? {};
    const hasTargets = Object.keys(tiers).length > 0;
    let fallback: number | null = null;
    if (!hasTargets) {
      if (!config.tinmanMedianFallback) continue;
      fallback = median([...totals.values()].filter((v) => v > 0));
      if (!fallback) continue;
    }
    runs++;
    if (hasTargets) runsWithTargets++;

    // Day 1 is Ancients' Treasure, the Tinman day is day 2.
    const runFirstDay = addDays(date, -1);
    for (const m of members) {
      if (m.tenureStart > runFirstDay) continue;
      let expected: number | null | undefined = fallback;
      if (hasTargets) {
        const level = levelOn(guards.get(m.id), date) ?? config.assumedGuardsLevel;
        expected = tiers[`g${level}` as TargetTier];
      }
      if (!expected || !(expected > 0)) continue;
      const actual = totals.get(m.id) ?? 0;
      units.get(m.id)!.push({ ratio: unitRatio(actual, expected), hit: actual >= expected });
      if (!hasTargets) medianRuns.set(m.id, (medianRuns.get(m.id) ?? 0) + 1);
    }
  }
  return { units, medianRuns, runs, runsWithTargets };
}

interface EventResult {
  units: Map<number, PerformanceUnit[]>;
  perEvent: Array<{ key: string; name: string; runs: number }>;
}

async function eventUnits(
  input: PerformanceInput,
  config: PerformanceConfig,
  today: string,
  windowFrom: string,
  dataStart: string,
  members: MemberBase[],
): Promise<EventResult> {
  const units = new Map<number, PerformanceUnit[]>(members.map((m) => [m.id, []]));
  const perEvent: EventResult['perEvent'] = [];
  const rollover = input.rolloverUtcHour;

  for (const key of config.participationEvents) {
    const def = getEventDef(key);
    if (!def) continue;
    const occurrences = await getEventOccurrences(key, input.clanId).catch(() => []);
    let runs = 0;
    for (const o of occurrences) {
      if (o.isCurrent) continue;
      const firstDay = gameDateFor(Date.parse(o.from), rollover);
      const lastDay = gameDateFor(Date.parse(o.resetAt) - 1, rollover);
      if (lastDay >= today || lastDay < windowFrom || firstDay < dataStart) continue;
      const ranked = rankedRun(key, input.clanId, o.from, o.to);
      const typical = median([...ranked.byMember.values()].map((v) => v.points).filter((p) => p > 0));
      // Nobody scored: the run can't be measured against (or the event's chests
      // weren't recognised yet), so it counts for no one.
      if (!typical) continue;
      runs++;
      for (const m of members) {
        if (m.tenureStart > firstDay) continue;
        const actual = ranked.byMember.get(m.id)?.points ?? 0;
        units.get(m.id)!.push({ ratio: unitRatio(actual, typical), hit: actual > 0 });
      }
    }
    perEvent.push({ key, name: def.name, runs });
  }
  return { units, perEvent };
}

async function buildReport(input: PerformanceInput, nowMs: number): Promise<PerformanceReport> {
  const clanConfig = resolvePerformanceConfig(input.clanId);
  const tf = clanConfig.timeframes.find((t) => t.key === input.timeframe)
    ?? clanConfig.timeframes.find((t) => t.key === clanConfig.defaultTimeframe)!;
  // The timeframe's own minimums win: a year needs more Tin Man runs than a month.
  const config: PerformanceConfig = { ...clanConfig, minUnits: { ...clanConfig.minUnits, ...tf.minUnits } };
  const today = gameDateFor(nowMs, input.rolloverUtcHour);
  const dataStart = getClanDataStartDay(input.clanId);

  const base: PerformanceReport = {
    timeframe: tf.key,
    timeframes: config.timeframes.map((t) => ({ key: t.key, days: t.days })),
    today,
    windowFrom: null,
    windowTo: null,
    dataStart,
    windowDays: 0,
    requiredDays: 0,
    weeklyGoal: input.weeklyGoal,
    goalSteps: [],
    goalAmberPct: amberPctOrDefault(input.goalAmberPct),
    weekStart: input.weekStart,
    units: { weeks: 0, tinmanRuns: 0, tinmanRunsWithTargets: 0, eventRuns: 0 },
    events: [],
    scoring: {
      weights: config.weights,
      minUnits: config.minUnits,
      overCurve: config.overCurve,
      ratioCap: config.ratioCap,
      overThreshold: config.overThreshold,
      underThreshold: config.underThreshold,
      assumedGuardsLevel: config.assumedGuardsLevel,
      goalNearMiss: config.goalNearMiss,
      tinmanMedianFallback: config.tinmanMedianFallback,
    },
    members: [],
    tooNew: [],
  };
  if (!dataStart || dataStart >= today) return base;

  const rawFrom = tf.days === null ? dataStart : addDays(today, -tf.days);
  const windowFrom = rawFrom < dataStart ? dataStart : rawFrom;
  const windowDays = daysBetweenGameDates(windowFrom, today) ?? 0;
  const requiredDays = requiredPresentDays(windowDays, tf.minCoverage, config);

  const everyone = activeMembers(input.clanId, input.rolloverUtcHour, today);
  const eligible: Array<MemberBase & { presentDays: number }> = [];
  const tooNew: PerformanceTooNewRow[] = [];
  for (const m of everyone) {
    const from = m.tenureStart > windowFrom ? m.tenureStart : windowFrom;
    const presentDays = Math.max(0, daysBetweenGameDates(from, today) ?? 0);
    if (presentDays >= requiredDays && presentDays > 0) eligible.push({ ...m, presentDays });
    else tooNew.push({ memberId: m.id, name: m.name, tenureStart: m.tenureStart, presentDays });
  }

  const guards = getGuardsEstimates(input.clanId);
  const weeks = input.weeklyGoal ? closedWeeks(input, nowMs, windowFrom, dataStart) : [];
  const weekGoals = goalsForWeeks(input, weeks);
  const weekly = weekUnits(input, config, weeks, weekGoals, eligible, guards);
  const tinman = tinmanUnits(input.clanId, config, today, windowFrom, eligible, guards);
  const events = await eventUnits(input, config, today, windowFrom, dataStart, eligible);

  const members: PerformanceMemberRow[] = eligible.map((m) => {
    const signals = summarizeSignals({
      weeks: weekly.get(m.id) ?? [],
      tinman: tinman.units.get(m.id) ?? [],
      events: events.units.get(m.id) ?? [],
    }, config);
    const score = compositeScore(signals, config);
    return {
      memberId: m.id,
      name: m.name,
      guardsLevel: guards.get(m.id)?.level ?? null,
      tenureStart: m.tenureStart,
      presentDays: m.presentDays,
      score,
      status: statusFor(score, config),
      signals,
      tinmanMedianRuns: tinman.medianRuns.get(m.id) ?? 0,
    };
  });
  members.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name));
  tooNew.sort((a, b) => b.tenureStart.localeCompare(a.tenureStart) || a.name.localeCompare(b.name));

  return {
    ...base,
    windowFrom,
    windowTo: addDays(today, -1),
    windowDays,
    requiredDays,
    goalSteps: goalStepsOf(weeks, weekGoals),
    units: {
      weeks: weeks.length,
      tinmanRuns: tinman.runs,
      tinmanRunsWithTargets: tinman.runsWithTargets,
      eventRuns: events.perEvent.reduce((s, e) => s + e.runs, 0),
    },
    events: events.perEvent,
    members,
    tooNew,
  };
}

/**
 * The report for one clan and timeframe, cached for a few minutes and dropped
 * whenever the chests, Tin Man pastes or guards estimates behind it change.
 */
export function getPerformanceReport(input: PerformanceInput): Promise<PerformanceReport> {
  const nowMs = input.nowMs ?? Date.now();
  const today = gameDateFor(nowMs, input.rolloverUtcHour);
  const key = `${CACHE_PREFIX}${input.clanId}:${input.timeframe}:${today}:${input.weeklyGoal ?? 0}:${input.goalAmberPct ?? 0}:${input.weekStart}`;
  if (input.nowMs !== undefined) return buildReport(input, nowMs);
  const pending = cached(key, CACHE_TTL_MS, () => buildReport(input, nowMs));
  // A failed build must not be served from the cache for the next five minutes.
  pending.catch(() => invalidate(key));
  return pending;
}
