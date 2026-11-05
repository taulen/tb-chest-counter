/**
 * Guards for the Performance page's scoring config.
 *
 * In tests/config because `npm run build` runs this directory, and the config
 * is meant to be retuned by hand as the clans use the page. Every mistake below
 * is silent at runtime: an event key with a typo just scores no runs, a negative
 * weight quietly inverts a signal, a timeframe with no label reads as its raw key.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERFORMANCE_CONFIG as C,
  PERFORMANCE_SIGNALS,
  resolvePerformanceConfig,
} from '../../src/config/performance-scoring.js';
import { EVENT_CATALOG } from '../../src/config/event-catalog.js';
import { GUARDS_MAX_LEVEL, GUARDS_MIN_LEVEL } from '../../src/config/guards-ladder.js';

const PAGE = fs.readFileSync(
  path.resolve(fileURLToPath(new URL('../../src/web/public/pages/performance.js', import.meta.url))),
  'utf8',
);

describe('performance scoring config', () => {
  it('weighs every signal with a finite, non-negative weight, and something counts', () => {
    for (const s of PERFORMANCE_SIGNALS) {
      expect(Number.isFinite(C.weights[s]), s).toBe(true);
      expect(C.weights[s], s).toBeGreaterThanOrEqual(0);
    }
    expect(PERFORMANCE_SIGNALS.some((s) => C.weights[s] > 0)).toBe(true);
  });

  it('asks every signal for at least one whole unit', () => {
    for (const s of PERFORMANCE_SIGNALS) {
      expect(Number.isInteger(C.minUnits[s]), s).toBe(true);
      expect(C.minUnits[s], s).toBeGreaterThanOrEqual(1);
    }
  });

  it('has thresholds that leave room for "on track" around 100%', () => {
    expect(C.ratioCap).toBeGreaterThanOrEqual(1);
    expect(C.underThreshold).toBeGreaterThan(0);
    expect(C.underThreshold).toBeLessThanOrEqual(1);
    expect(C.overThreshold).toBeGreaterThan(1);
    // An over threshold the cap makes unreachable would leave the card empty forever.
    expect(C.overThreshold).toBeLessThanOrEqual(C.ratioCap);
  });

  it('gives a near miss less than a hit, and only for a real near miss', () => {
    if (C.goalNearMiss === null) return;
    expect(C.goalNearMiss.from).toBeGreaterThan(0);
    expect(C.goalNearMiss.from).toBeLessThan(1);
    expect(C.goalNearMiss.credit).toBeGreaterThan(0);
    expect(C.goalNearMiss.credit).toBeLessThan(1);
  });

  it('has distinct timeframes, a default among them, and sane coverage', () => {
    const keys = C.timeframes.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(C.defaultTimeframe);
    for (const t of C.timeframes) {
      expect(t.key).toMatch(/^[a-z0-9-]+$/);
      if (t.days !== null) {
        expect(Number.isInteger(t.days), t.key).toBe(true);
        expect(t.days, t.key).toBeGreaterThan(0);
      }
      expect(t.minCoverage, t.key).toBeGreaterThanOrEqual(0);
      expect(t.minCoverage, t.key).toBeLessThanOrEqual(1);
      for (const [signal, n] of Object.entries(t.minUnits ?? {})) {
        expect(PERFORMANCE_SIGNALS as readonly string[], `${t.key}.minUnits`).toContain(signal);
        expect(Number.isInteger(n) && n >= 1, `${t.key}.minUnits.${signal}`).toBe(true);
      }
    }
    expect(C.minPresentDays).toBeGreaterThanOrEqual(0);
    expect(C.minPresentDaysMaxShare).toBeGreaterThan(0);
    expect(C.minPresentDaysMaxShare).toBeLessThanOrEqual(1);
  });

  it('gives every timeframe a label on the page', () => {
    for (const t of C.timeframes) {
      expect(PAGE, `TIMEFRAME_LABELS in pages/performance.js has no "${t.key}"`).toMatch(new RegExp(`\\n\\s*'?${t.key}'?: t\\(`));
    }
  });

  it('only counts events that exist in the catalog', () => {
    const known = new Set(EVENT_CATALOG.map((e) => e.key));
    for (const key of C.participationEvents) expect(known.has(key), key).toBe(true);
    expect(new Set(C.participationEvents).size).toBe(C.participationEvents.length);
  });

  it('assumes and scales real guards levels only', () => {
    expect(C.assumedGuardsLevel).toBeGreaterThanOrEqual(GUARDS_MIN_LEVEL);
    expect(C.assumedGuardsLevel).toBeLessThanOrEqual(GUARDS_MAX_LEVEL);
    for (const [level, factor] of Object.entries(C.weeklyGoalScaleByGuards)) {
      expect(Number(level), level).toBeGreaterThanOrEqual(GUARDS_MIN_LEVEL);
      expect(Number(level), level).toBeLessThanOrEqual(GUARDS_MAX_LEVEL);
      expect(factor, level).toBeGreaterThan(0);
    }
  });

  it('resolves to the defaults until per-clan overrides exist', () => {
    expect(resolvePerformanceConfig(1)).toBe(C);
  });
});
