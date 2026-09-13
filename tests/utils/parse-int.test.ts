import { describe, expect, it } from 'vitest';
import { parseBoundedInt, parseBoundedFloat } from '../../src/utils/parse-int.js';

describe('parseBoundedInt', () => {
  it('returns the parsed integer for a numeric string', () => {
    expect(parseBoundedInt('42', 0)).toBe(42);
  });

  it('returns the parsed integer for an actual number', () => {
    expect(parseBoundedInt(7, 0)).toBe(7);
  });

  it('returns the fallback for null', () => {
    expect(parseBoundedInt(null, 17)).toBe(17);
  });

  it('returns the fallback for undefined', () => {
    expect(parseBoundedInt(undefined, 17)).toBe(17);
  });

  it('returns the fallback for an empty string', () => {
    expect(parseBoundedInt('', 17)).toBe(17);
  });

  it('returns the fallback for non-numeric strings', () => {
    expect(parseBoundedInt('not a number', 99)).toBe(99);
  });

  it('returns the fallback for objects', () => {
    expect(parseBoundedInt({}, 1)).toBe(1);
  });

  it('truncates floats by parseInt semantics', () => {
    // Number.parseInt('3.9', 10) → 3 (intentional behavior — matches all
    // the prior copies, callers use this for ?page=3.9 style query inputs).
    expect(parseBoundedInt('3.9', 0)).toBe(3);
  });

  it('clamps to max when input exceeds it', () => {
    expect(parseBoundedInt('1000', 0, { max: 100 })).toBe(100);
  });

  it('clamps to min when input is below it', () => {
    expect(parseBoundedInt('-5', 0, { min: 0 })).toBe(0);
  });

  it('respects both min and max together', () => {
    expect(parseBoundedInt('50', 0, { min: 1, max: 25 })).toBe(25);
    expect(parseBoundedInt('0', 0, { min: 1, max: 25 })).toBe(1);
    expect(parseBoundedInt('15', 0, { min: 1, max: 25 })).toBe(15);
  });

  it('falls back without clamping when input is unparseable', () => {
    // The fallback is applied as-is — it's the caller's responsibility
    // to ensure the fallback already satisfies the bounds.
    expect(parseBoundedInt('garbage', 999, { min: 0, max: 100 })).toBe(999);
  });

  it('uses safe-integer extremes when bounds are unset', () => {
    expect(parseBoundedInt(String(Number.MAX_SAFE_INTEGER), 0)).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseBoundedInt(String(Number.MIN_SAFE_INTEGER), 0)).toBe(Number.MIN_SAFE_INTEGER);
  });
});

describe('parseBoundedFloat', () => {
  it('returns the parsed float', () => {
    expect(parseBoundedFloat('3.14', 0)).toBeCloseTo(3.14);
  });

  it('returns the fallback for non-numeric strings', () => {
    expect(parseBoundedFloat('nope', 1.5)).toBe(1.5);
  });

  it('clamps within [min, max]', () => {
    expect(parseBoundedFloat('99.9', 0, { min: 0, max: 1 })).toBe(1);
    expect(parseBoundedFloat('-99.9', 0, { min: 0, max: 1 })).toBe(0);
    expect(parseBoundedFloat('0.5', 0, { min: 0, max: 1 })).toBeCloseTo(0.5);
  });

  it('handles fractional fallbacks correctly', () => {
    expect(parseBoundedFloat(undefined, 0.25)).toBeCloseTo(0.25);
  });
});
