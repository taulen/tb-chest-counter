import { describe, expect, it } from 'vitest';
import { giftEarnedAtMs, GIFT_LIFETIME_MS } from '../../src/utils/gift-time.js';

const SCAN = Date.parse('2026-07-19T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

describe('giftEarnedAtMs', () => {
  it('derives received = scanTime + timeLeft − 20h for a clean read', () => {
    // 18h54m left of a 20h window → received 1h6m before the scan.
    expect(giftEarnedAtMs('18h54m', SCAN)).toBe(SCAN - (1 * HOUR + 6 * MIN));
  });

  it('places a nearly-full timer just before the scan (19h59m ≈ 1m ago)', () => {
    expect(giftEarnedAtMs('19h59m', SCAN)).toBe(SCAN - 1 * MIN);
  });

  it('places a nearly-empty timer close to 20h ago', () => {
    expect(giftEarnedAtMs('0h1m', SCAN)).toBe(SCAN - (GIFT_LIFETIME_MS - 1 * MIN));
  });

  it('never returns a time in the future or older than the 20h window', () => {
    for (const t of ['19h59m', '10h30m', '0h1m', '20h0m']) {
      const earned = giftEarnedAtMs(t, SCAN);
      expect(earned).toBeLessThanOrEqual(SCAN);
      expect(earned).toBeGreaterThanOrEqual(SCAN - GIFT_LIFETIME_MS);
    }
  });

  it('falls back to the scan time when the countdown is not a clean HHhMMm', () => {
    for (const bad of ['', 'garbage', '5h', '19h60m', '99h99m', '2d3h', '18 h 54 m']) {
      expect(giftEarnedAtMs(bad, SCAN)).toBe(SCAN);
    }
  });

  it('falls back to the scan time for a zero / expired countdown', () => {
    expect(giftEarnedAtMs('0h0m', SCAN)).toBe(SCAN);
  });

  it('tolerates a non-string timeLeft without throwing', () => {
    // @ts-expect-error — exercising the defensive guard against bad input.
    expect(giftEarnedAtMs(undefined, SCAN)).toBe(SCAN);
  });

  describe('screenshot vs fallback reference (3-arg form)', () => {
    const SHOT = Date.parse('2026-07-19T12:00:00.000Z'); // screenshot moment
    const INSERT = SHOT + 18 * MIN; // rows inserted ~18 min later, end of scan

    it('computes from the SCREENSHOT time, not the insert time', () => {
      // A clean read must ignore the (later) insert clock entirely.
      expect(giftEarnedAtMs('18h54m', SHOT, INSERT)).toBe(SHOT - (1 * HOUR + 6 * MIN));
    });

    it('falls back to the provided fallback (insert clock), not the screenshot', () => {
      expect(giftEarnedAtMs('garbage', SHOT, INSERT)).toBe(INSERT);
      expect(giftEarnedAtMs('0h0m', SHOT, INSERT)).toBe(INSERT);
    });
  });
});
