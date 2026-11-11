import { describe, expect, it } from 'vitest';
import {
  compositeScore,
  guardsLevelOn,
  median,
  requiredPresentDays,
  scoredRatio,
  statusFor,
  summarizeSignals,
  unitRatio,
  type PerformanceUnit,
} from '../../src/data/performance-score.js';
import { DEFAULT_PERFORMANCE_CONFIG, type PerformanceConfig } from '../../src/config/performance-scoring.js';

const config: PerformanceConfig = {
  ...DEFAULT_PERFORMANCE_CONFIG,
  weights: { goalHits: 0.3, goalPoints: 0.2, tinman: 0.3, events: 0.2 },
  minUnits: { goalHits: 2, goalPoints: 2, tinman: 1, events: 2 },
  overCurve: { from: 1, perDoubling: 0.5 },
  ratioCap: 2,
  overThreshold: 1.2,
  underThreshold: 0.7,
  minPresentDays: 21,
  minPresentDaysMaxShare: 0.75,
};

const u = (ratio: number, hit = ratio >= 1): PerformanceUnit => ({ ratio, hit });
/** 1 + 0.5 × log2(share): what a share over 100% scores under `config`. */
const curve = (share: number) => 1 + 0.5 * Math.log2(share);

describe('unitRatio', () => {
  it('is the real share, uncapped', () => {
    expect(unitRatio(50_000, 10_000)).toBe(5);
    expect(unitRatio(5_000, 10_000)).toBe(0.5);
    expect(unitRatio(-5, 10)).toBe(0);
  });
  it('refuses an expectation it cannot measure against', () => {
    expect(() => unitRatio(1, 0)).toThrow();
  });
});

describe('scoredRatio', () => {
  it('scores a share up to 100% as it is', () => {
    expect(scoredRatio(0, config)).toBe(0);
    expect(scoredRatio(0.5, config)).toBe(0.5);
    expect(scoredRatio(1, config)).toBe(1);
  });
  it('adds 50% per doubling above it, so the cap takes 400%', () => {
    expect(scoredRatio(2, config)).toBeCloseTo(1.5);
    expect(scoredRatio(4, config)).toBeCloseTo(2);
    expect(scoredRatio(1.5, config)).toBeCloseTo(curve(1.5));
    // 200% and 400% no longer score the same; 400% and 800% do.
    expect(scoredRatio(4, config)).toBeGreaterThan(scoredRatio(2, config) + 0.4);
    expect(scoredRatio(8, config)).toBe(2);
  });
  it('still lets no single unit hide an empty one beyond the cap', () => {
    const s = summarizeSignals({ weeks: [u(10), u(0)], tinman: [], events: [] }, config);
    expect(s.goalPoints.value).toBeCloseTo(1);
    expect(s.goalPoints.share).toBeCloseTo(5);
  });
  it('is linear up to the cap with no curve', () => {
    const linear = { ...config, overCurve: null };
    expect(scoredRatio(1.5, linear)).toBe(1.5);
    expect(scoredRatio(3, linear)).toBe(2);
  });
  it('can start the curve higher up', () => {
    const late = { ...config, overCurve: { from: 2, perDoubling: 1 }, ratioCap: 3 };
    expect(scoredRatio(1.5, late)).toBe(1.5);
    expect(scoredRatio(2, late)).toBe(2);
    expect(scoredRatio(3, late)).toBeCloseTo(2 + Math.log2(1.5));
    expect(scoredRatio(4, late)).toBeCloseTo(3);
    expect(scoredRatio(9, late)).toBe(3);
  });
});

describe('median', () => {
  it('handles odd, even and empty lists', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('summarizeSignals + compositeScore', () => {
  it('reads weeks twice: how often the goal was reached and by how much', () => {
    const s = summarizeSignals({ weeks: [u(2), u(0.5), u(1), u(1.5)], tinman: [], events: [] }, config);
    expect(s.goalHits).toMatchObject({ units: 4, hits: 3, value: 0.75, counted: true });
    // The score uses the curved shares, the page shows the real ones.
    expect(s.goalPoints.value).toBeCloseTo((1.5 + 0.5 + 1 + curve(1.5)) / 4);
    expect(s.goalPoints.share).toBeCloseTo(1.25);
    expect(s.tinman).toMatchObject({ units: 0, value: null, share: null, counted: false });
  });

  it('gives a near miss its partial credit toward the hit share', () => {
    const near = (ratio: number): PerformanceUnit => ({ ratio, hit: false, credit: 0.5 });
    const s = summarizeSignals({ weeks: [u(1), near(0.95), near(0.7), u(0.3, false)], tinman: [], events: [] }, config);
    // (1 + 0.5 + 0.5 + 0) / 4
    expect(s.goalHits).toMatchObject({ units: 4, hits: 1, near: 2, value: 0.5 });
    expect(s.goalPoints.value).toBeCloseTo((1 + 0.95 + 0.7 + 0.3) / 4);
  });

  it('re-normalises the weights over the signals a member has', () => {
    const s = summarizeSignals({ weeks: [u(1), u(1)], tinman: [], events: [] }, config);
    // Only the two weekly signals count: (0.3 × 1 + 0.2 × 1) / 0.5.
    expect(compositeScore(s, config)).toBeCloseTo(1);
  });

  it('leaves out a signal below its minimum', () => {
    const s = summarizeSignals({ weeks: [u(0)], tinman: [u(1.5)], events: [u(0, false)] }, config);
    expect(s.goalHits.counted).toBe(false);
    expect(s.events.counted).toBe(false);
    expect(compositeScore(s, config)).toBeCloseTo(curve(1.5));
  });

  it('is null with nothing to score', () => {
    const s = summarizeSignals({ weeks: [], tinman: [], events: [] }, config);
    expect(compositeScore(s, config)).toBeNull();
    expect(statusFor(null, config)).toBe('unscored');
  });

  it('weighs every signal when all are present', () => {
    const s = summarizeSignals({
      weeks: [u(2), u(2)], // hits 1.0, points 200% → 1.5
      tinman: [u(1.25)],
      events: [u(1), u(0, false)], // 0.5
    }, config);
    expect(compositeScore(s, config)).toBeCloseTo(0.3 * 1 + 0.2 * 1.5 + 0.3 * curve(1.25) + 0.2 * 0.5);
  });
});

describe('statusFor', () => {
  it('splits at the thresholds', () => {
    expect(statusFor(1.2, config)).toBe('over');
    expect(statusFor(1.19, config)).toBe('on-track');
    expect(statusFor(0.7, config)).toBe('on-track');
    expect(statusFor(0.69, config)).toBe('under');
  });
});

describe('requiredPresentDays', () => {
  it('asks for the timeframe share of a full window', () => {
    expect(requiredPresentDays(30, 0.75, config)).toBe(23);
    expect(requiredPresentDays(91, 0.75, config)).toBe(69);
  });
  it('holds All time to the absolute floor', () => {
    expect(requiredPresentDays(190, 0, config)).toBe(21);
  });
  it('never asks more than the share of a short history', () => {
    // A clan tracked for 16 days: 12, not 16 or 21, so a member who joined a
    // day after tracking began is still shown.
    expect(requiredPresentDays(16, 0.75, config)).toBe(12);
    expect(requiredPresentDays(16, 0, config)).toBe(12);
  });
  it('is 0 for an empty window', () => {
    expect(requiredPresentDays(0, 0.75, config)).toBe(0);
  });
});

describe('guardsLevelOn', () => {
  const ups = [
    { from: 6, by: '2026-08-10' },
    { from: 7, by: '2026-10-01' },
  ];
  it('walks back through level-ups', () => {
    expect(guardsLevelOn('2026-10-15', 8, ups)).toBe(8);
    expect(guardsLevelOn('2026-10-01', 8, ups)).toBe(8);
    expect(guardsLevelOn('2026-09-30', 8, ups)).toBe(7);
    expect(guardsLevelOn('2026-08-09', 8, ups)).toBe(6);
  });
  it('is the current level with no level-ups', () => {
    expect(guardsLevelOn('2026-01-01', 5, [])).toBe(5);
  });
});
