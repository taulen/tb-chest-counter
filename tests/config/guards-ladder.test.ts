/**
 * Guards for the guardsmen ladder and the estimator built on it.
 *
 * In tests/config because `npm run build` runs this directory and nothing else,
 * and every failure here is silent at runtime: a wrong unit or tier does not
 * throw, it files that level's donations as noise and the member quietly reads
 * one level off. The sequences below are real members' donation histories from
 * the 2026-09-28 production backup, reduced to the rows that decide them.
 */
import { describe, expect, it } from 'vitest';
import {
  ESSENCE_FULL_DONATION_UNITS,
  ESSENCE_MAX_UNITS_PER_LINE,
  ESSENCE_UNITS,
  GOLD_PASS_TRACTATE_AMOUNT,
  GUARDS_MAX_LEVEL,
  GUARDS_MIN_LEVEL,
  TRACTATE_TIERS,
  matchEssenceAmount,
  tractateTierLevel,
} from '../../src/config/guards-ladder.js';
import {
  buildLevelPrior,
  estimateGuardsLevel,
  type GuardsObservation,
} from '../../src/data/guards-estimator.js';

const ess = (date: string, amount: number): GuardsObservation => ({ kind: 'essence', date, amount });
const tr = (date: string, amount: number): GuardsObservation => ({ kind: 'tractate', date, amount });
const report = (date: string, level: number): GuardsObservation => ({ kind: 'report', date, level });

describe('the ladder', () => {
  const regular = ESSENCE_UNITS.filter((u) => !u.boosted);

  it('has one regular essence unit per level, rising with the level', () => {
    const levels = regular.map((u) => u.level);
    expect(new Set(levels).size).toBe(levels.length);
    for (let i = 1; i < regular.length; i++) {
      expect(regular[i].level).toBe(regular[i - 1].level + 1);
      expect(regular[i].unit).toBeGreaterThan(regular[i - 1].unit);
    }
  });

  it('steps ×1.3 per level, as every measured unit does', () => {
    // The ladder's shape is the evidence that G2/G3 (one observation each) are
    // real: a typo in any unit breaks the ratio.
    for (let i = 1; i < regular.length; i++) {
      const ratio = regular[i].unit / regular[i - 1].unit;
      expect(ratio, `G${regular[i].level} / G${regular[i - 1].level}`).toBeGreaterThan(1.28);
      expect(ratio, `G${regular[i].level} / G${regular[i - 1].level}`).toBeLessThan(1.32);
    }
  });

  it('reproduces the full donations players quote', () => {
    const full = (level: number) =>
      (regular.find((u) => u.level === level)?.unit ?? 0) * ESSENCE_FULL_DONATION_UNITS * 2;
    expect(full(7)).toBe(1_540_000);
    expect(full(8)).toBe(2_002_000);
  });

  it('keeps the boosted unit inside the level range', () => {
    for (const u of ESSENCE_UNITS) {
      expect(u.level).toBeGreaterThanOrEqual(GUARDS_MIN_LEVEL);
      expect(u.level).toBeLessThanOrEqual(GUARDS_MAX_LEVEL);
    }
  });

  it('has strictly rising tractate tiers, one per level', () => {
    for (let i = 1; i < TRACTATE_TIERS.length; i++) {
      expect(TRACTATE_TIERS[i].level).toBe(TRACTATE_TIERS[i - 1].level + 1);
      expect(TRACTATE_TIERS[i].amount).toBeGreaterThan(TRACTATE_TIERS[i - 1].amount);
    }
  });

  it('never reads the gold-pass tractate line as a level tier', () => {
    // 250k is donated by members of every level. Mistaking it for a tier would
    // pin most of the clan to one level.
    expect(tractateTierLevel(GOLD_PASS_TRACTATE_AMOUNT)).toBeNull();
  });
});

describe('matchEssenceAmount', () => {
  it('lists every level an amount fits within the cap', () => {
    // 1,001,000 is 70 × G8 and 91 × G7; the estimator, not this, picks between them.
    expect(matchEssenceAmount(1_001_000).map((m) => m.level)).toEqual([7, 8]);
    expect(matchEssenceAmount(770_000).map((m) => m.level)).toEqual([7]);
    expect(matchEssenceAmount(343_200).map((m) => m.level)).toEqual([8]);
    expect(matchEssenceAmount(1_302_000).map((m) => m.level)).toEqual([9]);
  });

  it('caps a line at two merged full donations', () => {
    // 770,000 is also 154 × G4 and 200 × G3; the cap is what rules both out.
    expect(ESSENCE_MAX_UNITS_PER_LINE).toBe(ESSENCE_FULL_DONATION_UNITS * 2);
    expect(matchEssenceAmount(350_000 * 2).map((m) => m.level)).toEqual([4]);
  });

  it('recognises the boosted G9 unit as G9', () => {
    const m = matchEssenceAmount(892_000);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ level: 9, boosted: true, units: 40 });
  });

  it('explains nothing for an amount no level divides', () => {
    expect(matchEssenceAmount(354_457)).toEqual([]);
    expect(matchEssenceAmount(0)).toEqual([]);
    expect(matchEssenceAmount(-11_000)).toEqual([]);
  });
});

describe('estimateGuardsLevel', () => {
  it('returns null when nothing is usable', () => {
    expect(estimateGuardsLevel([])).toBeNull();
    expect(estimateGuardsLevel([ess('2026-08-11', 354_457), tr('2026-08-25', 250_000)])).toBeNull();
  });

  it('follows a level-up between two events (taulen, G7 → G8)', () => {
    const e = estimateGuardsLevel([
      ess('2026-07-18', 770_000), ess('2026-07-18', 770_000),
      tr('2026-08-01', 15_000_000),
      ess('2026-08-11', 1_540_000),
      tr('2026-08-25', 58_000_000),
      ess('2026-09-03', 1_001_000),
      tr('2026-09-18', 58_000_000),
    ]);
    expect(e?.level).toBe(8);
    expect(e?.asOf).toBe('2026-09-18');
    expect(e?.confidence).toBe('high');
    expect(e?.levelUps).toEqual([{ from: 7, to: 8, after: '2026-08-11', by: '2026-08-25' }]);
  });

  it('never goes down: one stray low line does not demote a member', () => {
    // A G8 whose September run carries one line that only a G4 would explain.
    const e = estimateGuardsLevel([
      ess('2026-08-10', 1_001_000), ess('2026-08-11', 657_800),
      tr('2026-08-25', 58_000_000),
      ess('2026-09-03', 300_000),
      ess('2026-09-04', 343_200),
    ]);
    expect(e?.level).toBe(8);
    expect(e?.levelUps).toEqual([]);
    const stray = e?.evidence.find((r) => r.amount === 300_000);
    expect(stray?.agrees).toBe(false);
  });

  it('reads a below-level tractate as a partial donation, not a demotion (Gritle)', () => {
    const e = estimateGuardsLevel([
      ess('2026-07-17', 1_001_000), ess('2026-07-18', 700_700),
      tr('2026-08-01', 15_000_000),
      ess('2026-08-10', 1_001_000), ess('2026-08-11', 657_800),
      tr('2026-08-25', 58_000_000),
    ]);
    expect(e?.level).toBe(8);
    const partial = e?.evidence.find((r) => r.kind === 'tractate' && r.amount === 15_000_000);
    expect(partial?.belowLevel).toBe(true);
  });

  it('does not let one round number make a member G4', () => {
    // 5,000 divides every fifth round thousand, so a lone G4 "hit" against a
    // clean G7 history is noise.
    const e = estimateGuardsLevel([
      ess('2026-08-11', 770_000), ess('2026-08-11', 506_000),
      tr('2026-08-25', 15_000_000),
      ess('2026-09-03', 150_000),
    ]);
    expect(e?.level).toBe(7);
  });

  it('prefers the level a full donation belongs to', () => {
    // 1,001,000 is 70 × G8 and 91 × G7 — the full donation decides it.
    const e = estimateGuardsLevel([ess('2026-09-03', 1_001_000)]);
    expect(e?.level).toBe(8);
    expect(e?.confidence).toBe('low');
  });

  it('carries the boosted G9 unit as G9 and flags the row', () => {
    const e = estimateGuardsLevel([ess('2026-08-11', 892_000), tr('2026-08-25', 76_000_000)]);
    expect(e?.level).toBe(9);
    expect(e?.evidence[0].boosted).toBe(true);
  });

  it('treats an admin report as a pin for its date, and a floor after it', () => {
    const pinned = estimateGuardsLevel([ess('2026-08-11', 770_000), report('2026-08-20', 8)]);
    expect(pinned?.level).toBe(8);
    expect(pinned?.asOf).toBe('2026-08-20');

    // Later donations still carry the member above the reported level.
    const risen = estimateGuardsLevel([
      report('2026-08-20', 8),
      ess('2026-09-03', 1_302_000),
      tr('2026-09-18', 76_000_000),
    ]);
    expect(risen?.level).toBe(9);
  });

  it('breaks a genuine tie with the clan prior, never by overstating', () => {
    // 308,000 fits G3 (80 units) and G7 (28 units) equally well.
    const flat = estimateGuardsLevel([ess('2026-07-18', 308_000)]);
    expect(flat?.level).toBe(3);
    const prior = buildLevelPrior([7, 7, 7, 8, 8, 6]);
    expect(estimateGuardsLevel([ess('2026-07-18', 308_000)], prior)?.level).toBe(7);
  });

  it('ignores observations with a malformed date', () => {
    expect(estimateGuardsLevel([ess('18/07/2026', 770_000)])).toBeNull();
  });
});
