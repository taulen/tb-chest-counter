/**
 * Guards-level estimation: the most likely level history for one member, given
 * the dated donations the ladder can read (see src/config/guards-ladder.ts) and
 * any level an admin has entered by hand.
 *
 * ── The one invariant ────────────────────────────────────────────────────────
 *
 * A guards level never goes down. So the answer is not "the level of the newest
 * donation" — one misattributed line would then rewrite a member — but the
 * NON-DECREASING sequence of levels that best explains every donation at once.
 * It is found exactly, by a Viterbi pass over the member's evidence dates with
 * the transitions restricted to "stay or rise", in the same spirit as the
 * hero-level filter in might-repo.ts (trustedHeroLevels): judge on read, from the
 * raw rows, every time. Nothing here is ever stored, so one more day of evidence
 * can overturn any earlier judgement, and a bad HIGH read is outvoted rather than
 * baked in.
 *
 * ── How much each row is worth ───────────────────────────────────────────────
 *
 * Scores are log-likelihoods; only differences between levels matter.
 *
 *  - Essence: a level whose unit divides the amount explains it. A full donation
 *    (70 or 140 units) explains it better than a partial one, which is what
 *    separates 1,001,000 = 70 × G8 from 91 × G7. A level that does NOT divide it
 *    pays a penalty sized by how easily a stray amount (a misread, someone
 *    else's row) would divide by the levels that do: 5,000 divides every fifth
 *    round number, so a G4 "hit" is weak; 14,300 divides one in 143, so a G8 hit
 *    is strong.
 *  - Tractates: the tier's level fits exactly. A HIGHER level is plausible but
 *    unlikely (a member donating below their level — seen once: a G8 giving the
 *    G7 15M). A LOWER level is close to impossible.
 *  - Admin report: effectively a hard pin for its date. It is still only a pin
 *    on THAT date, so later donations can carry the member above it — a
 *    correction is a floor, not a ceiling.
 *  - Each level gained costs a little, so the path doesn't climb on noise.
 *
 * Pure and dependency-free apart from the ladder, so the guard suite in
 * tests/config can exercise it on every build.
 */

import {
  ESSENCE_FULL_DONATION_UNITS,
  GUARDS_MAX_LEVEL,
  GUARDS_MIN_LEVEL,
  matchEssenceAmount,
  tractateTierLevel,
  type EssenceMatch,
} from '../config/guards-ladder.js';

export type GuardsObservationKind = 'essence' | 'tractate' | 'report';

export interface GuardsObservation {
  kind: GuardsObservationKind;
  /** Game day, YYYY-MM-DD. */
  date: string;
  /** Donated amount (essence / tractate). */
  amount?: number;
  /** Level an admin entered (report). */
  level?: number;
}

export interface GuardsEvidenceRow {
  kind: GuardsObservationKind;
  date: string;
  amount: number | null;
  /** Levels this row is consistent with (essence may fit several). */
  levels: number[];
  /** Where the estimate puts the member on this date. */
  estimatedLevel: number;
  /** The row fits that level. */
  agrees: boolean;
  /** A tractate tier BELOW the estimated level — a partial donation, not a misfit. */
  belowLevel: boolean;
  /** Essence donated on the +20% G9 unit (see EssenceUnit.boosted). */
  boosted: boolean;
}

export interface GuardsLevelUp {
  from: number;
  to: number;
  /** Last date seen at the old level. */
  after: string;
  /** First date seen at the new one. */
  by: string;
}

export type GuardsConfidence = 'high' | 'medium' | 'low';

export interface GuardsEstimate {
  /** Level on `asOf`. Levels only rise, so it is a floor for today. */
  level: number;
  /** Newest date with usable evidence. */
  asOf: string;
  /** Oldest date with usable evidence. */
  firstSeen: string;
  confidence: GuardsConfidence;
  /** Log-likelihood lead of `level` over the runner-up. */
  margin: number;
  levelUps: GuardsLevelUp[];
  /** Usable rows, oldest first. */
  evidence: GuardsEvidenceRow[];
}

/** level → log-probability of starting there. */
export type LevelPrior = ReadonlyMap<number, number>;

const LEVELS: number[] = [];
for (let l = GUARDS_MIN_LEVEL; l <= GUARDS_MAX_LEVEL; l++) LEVELS.push(l);

const LOG = Math.log;
/** A partial essence donation explains its level half as well as a full one. */
const LOG_PARTIAL = LOG(0.5);
/** Floor and ceiling on how readily a stray amount divides by a matched unit. */
const STRAY_MIN = 0.02;
const STRAY_MAX = 0.5;
/** The member really is one level above the tier they donated. */
const LOG_TRACTATE_UNDER_ONE = LOG(0.05);
/** Two or more levels above it. */
const LOG_TRACTATE_UNDER_MORE = LOG(0.01);
/** Donated a tier above their level — near impossible, so a misattributed row. */
const LOG_TRACTATE_OVER = LOG(0.02);
/** An admin's report is a pin; disagreeing with it needs overwhelming evidence. */
const LOG_REPORT_MISS = LOG(1e-6);
/** Cost per level gained. */
const LOG_STEP = LOG(0.7);
/** The clan prior is tempered: it should break ties, not outvote a donation. */
const PRIOR_WEIGHT = 0.5;

const CONFIDENCE_HIGH = LOG(20);
const CONFIDENCE_MEDIUM = LOG(4);

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * How likely a stray amount — a misread, or someone else's row filed under this
 * member — is to fit these units by chance. Strays are overwhelmingly whole
 * thousands, and a multiple of 1,000 is a multiple of `unit` one time in
 * lcm(1000, unit) / 1000.
 */
function strayFitChance(matches: EssenceMatch[]): number {
  let p = 0;
  for (const m of matches) {
    const lcm = (1_000 / gcd(1_000, m.unit)) * m.unit;
    p += 1_000 / lcm;
  }
  return Math.min(STRAY_MAX, Math.max(STRAY_MIN, p));
}

interface PreparedObs {
  kind: GuardsObservationKind;
  date: string;
  amount: number | null;
  levels: number[];
  boostedLevels: Set<number>;
  score: (level: number) => number;
}

function prepare(o: GuardsObservation): PreparedObs | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) return null;

  if (o.kind === 'essence') {
    const amount = o.amount ?? 0;
    const matches = matchEssenceAmount(amount);
    if (matches.length === 0) return null;
    const miss = LOG(strayFitChance(matches)) + LOG_PARTIAL;
    const best = new Map<number, number>();
    for (const m of matches) {
      const s = m.units % ESSENCE_FULL_DONATION_UNITS === 0 ? 0 : LOG_PARTIAL;
      best.set(m.level, Math.max(best.get(m.level) ?? -Infinity, s));
    }
    const boosted = new Set(matches.filter((m) => m.boosted).map((m) => m.level));
    return {
      kind: 'essence',
      date: o.date,
      amount,
      levels: [...best.keys()].sort((a, b) => a - b),
      boostedLevels: boosted,
      score: (l) => best.get(l) ?? miss,
    };
  }

  if (o.kind === 'tractate') {
    const amount = o.amount ?? 0;
    const tier = tractateTierLevel(amount);
    if (tier === null) return null;
    return {
      kind: 'tractate',
      date: o.date,
      amount,
      levels: [tier],
      boostedLevels: new Set(),
      score: (l) => {
        if (l === tier) return 0;
        if (l < tier) return LOG_TRACTATE_OVER;
        return l - tier === 1 ? LOG_TRACTATE_UNDER_ONE : LOG_TRACTATE_UNDER_MORE;
      },
    };
  }

  const level = o.level ?? 0;
  if (!Number.isInteger(level) || level < GUARDS_MIN_LEVEL || level > GUARDS_MAX_LEVEL) return null;
  return {
    kind: 'report',
    date: o.date,
    amount: null,
    levels: [level],
    boostedLevels: new Set(),
    score: (l) => (l === level ? 0 : LOG_REPORT_MISS),
  };
}

/**
 * Laplace-smoothed log-share of each level among `levels` — a clan's own make-up,
 * used to break ties for members whose donations fit two levels equally well.
 */
export function buildLevelPrior(levels: number[]): LevelPrior {
  const counts = new Map<number, number>(LEVELS.map((l) => [l, 1]));
  let total = LEVELS.length;
  for (const l of levels) {
    if (!counts.has(l)) continue;
    counts.set(l, (counts.get(l) as number) + 1);
    total++;
  }
  return new Map(LEVELS.map((l) => [l, LOG((counts.get(l) as number) / total)]));
}

function confidenceFor(margin: number): GuardsConfidence {
  if (margin >= CONFIDENCE_HIGH) return 'high';
  if (margin >= CONFIDENCE_MEDIUM) return 'medium';
  return 'low';
}

/**
 * The best non-decreasing level path through a member's evidence, or null when
 * none of it is usable (no essence amount the ladder explains, no tractate tier,
 * no report).
 */
export function estimateGuardsLevel(
  observations: readonly GuardsObservation[],
  prior?: LevelPrior,
): GuardsEstimate | null {
  const prepared = observations
    .map(prepare)
    .filter((o): o is PreparedObs => o !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (prepared.length === 0) return null;

  const dates = [...new Set(prepared.map((o) => o.date))];
  const byDate = new Map<string, PreparedObs[]>();
  for (const o of prepared) {
    const list = byDate.get(o.date);
    if (list) list.push(o);
    else byDate.set(o.date, [o]);
  }

  // score[l] = best log-likelihood of any path ending at level l on this date.
  let score = new Map<number, number>(
    LEVELS.map((l) => [l, PRIOR_WEIGHT * (prior?.get(l) ?? 0)]),
  );
  const back: Array<Map<number, number>> = [];

  for (let i = 0; i < dates.length; i++) {
    const today = byDate.get(dates[i]) as PreparedObs[];
    const next = new Map<number, number>();
    const pointers = new Map<number, number>();
    for (const l of LEVELS) {
      let best = -Infinity;
      let from = l;
      if (i === 0) {
        best = score.get(l) as number;
      } else {
        // Ascending with a strict `>`: on a tie the LOWER previous level wins,
        // which places a level-up as late as the evidence allows — the estimate
        // never claims a rise earlier than something actually showed it.
        for (const p of LEVELS) {
          if (p > l) break;
          const s = (score.get(p) as number) + LOG_STEP * (l - p);
          if (s > best) { best = s; from = p; }
        }
      }
      let obsScore = 0;
      for (const o of today) obsScore += o.score(l);
      next.set(l, best + obsScore);
      pointers.set(l, from);
    }
    back.push(pointers);
    score = next;
  }

  // Lowest level wins a tie here too: never overstate.
  let level = LEVELS[0];
  for (const l of LEVELS) if ((score.get(l) as number) > (score.get(level) as number)) level = l;
  let runnerUp = -Infinity;
  for (const l of LEVELS) if (l !== level) runnerUp = Math.max(runnerUp, score.get(l) as number);
  const margin = (score.get(level) as number) - runnerUp;

  const path = new Array<number>(dates.length);
  let cur = level;
  for (let i = dates.length - 1; i >= 0; i--) {
    path[i] = cur;
    cur = back[i].get(cur) as number;
  }

  const levelUps: GuardsLevelUp[] = [];
  for (let i = 1; i < dates.length; i++) {
    if (path[i] !== path[i - 1]) {
      levelUps.push({ from: path[i - 1], to: path[i], after: dates[i - 1], by: dates[i] });
    }
  }

  const levelOn = new Map(dates.map((d, i) => [d, path[i]]));
  const evidence: GuardsEvidenceRow[] = prepared.map((o) => {
    const est = levelOn.get(o.date) as number;
    const tier = o.kind === 'tractate' ? o.levels[0] : null;
    return {
      kind: o.kind,
      date: o.date,
      amount: o.amount,
      levels: o.levels,
      estimatedLevel: est,
      agrees: o.levels.includes(est),
      belowLevel: tier !== null && est > tier,
      boosted: o.boostedLevels.has(est),
    };
  });

  return {
    level,
    asOf: dates[dates.length - 1],
    firstSeen: dates[0],
    confidence: confidenceFor(margin),
    margin,
    levelUps,
    evidence,
  };
}
