import { describe, expect, it } from 'vitest';
import {
  compositeScore,
  guardsLevelOn,
  median,
  requiredPresentDays,
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
  ratioCap: 2,
  overThreshold: 1.2,
  underThreshold: 0.7,
  minPresentDays: 21,
  minPresentDaysMaxShare: 0.75,
};

const u = (ratio: number, hit = ratio >= 1): PerformanceUnit => ({ ratio, hit });

describe('unitRatio', () => {
  it('caps a huge unit so it cannot hide empty ones', () => {
    expect(unitRatio(50_000, 10_000, 2)).toBe(2);
    expect(unitRatio(5_000, 10_000, 2)).toBe(0.5);
    expect(unitRatio(-5, 10, 2)).toBe(0);
  });
  it('refuses an expectation it cannot measure against', () => {
    expect(() => unitRatio(1, 0, 2)).toThrow();
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
    expect(s.goalPoints.value).toBeCloseTo(1.25);
    expect(s.tinman).toMatchObject({ units: 0, value: null, counted: false });
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
    expect(compositeScore(s, config)).toBeCloseTo(1.5);
  });

  it('is null with nothing to score', () => {
    const s = summarizeSignals({ weeks: [], tinman: [], events: [] }, config);
    expect(compositeScore(s, config)).toBeNull();
    expect(statusFor(null, config)).toBe('unscored');
  });

  it('weighs every signal when all are present', () => {
    const s = summarizeSignals({
      weeks: [u(2), u(2)], // hits 1.0, points 2.0
      tinman: [u(1.25)],
      events: [u(1), u(0, false)], // 0.5
    }, config);
    expect(compositeScore(s, config)).toBeCloseTo(0.3 * 1 + 0.2 * 2 + 0.3 * 1.25 + 0.2 * 0.5);
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
