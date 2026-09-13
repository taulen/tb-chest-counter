import { describe, expect, it } from 'vitest';
import {
  DOM_DELTA_LINE,
  DOM_DELTA_PAGE,
  DOM_DELTA_PIXEL,
  LINE_HEIGHT_PX,
  normalizeWheelDelta,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - plain browser module, deliberately import-free so it can be tested here
} from '../../../src/web/public/lib/wheel.js';

/**
 * Scrolling in the bridge was broken two ways at once, and both are the kind of
 * bug that reads fine in review:
 *
 *  - the deltas were NEGATED, reversing scroll direction (CDP's mouseWheel uses
 *    the same sign convention as the DOM: positive deltaY scrolls down);
 *  - they were forwarded in whatever unit the browser chose, while CDP always
 *    means pixels — so a LINE-mode notch (deltaY ≈ 3) asked the remote page to
 *    scroll 3 pixels, which is indistinguishable from nothing happening.
 */
describe('normalizeWheelDelta', () => {
  it('passes PIXEL-mode deltas through unchanged', () => {
    const out = normalizeWheelDelta({ deltaMode: DOM_DELTA_PIXEL, deltaX: 0, deltaY: 100 }, 800);
    expect(out).toEqual({ deltaX: 0, deltaY: 100 });
  });

  it('preserves sign — scrolling down stays positive', () => {
    // The regression: negating here reversed scrolling in the remote browser.
    expect(normalizeWheelDelta({ deltaY: 120 }, 800).deltaY).toBeGreaterThan(0);
    expect(normalizeWheelDelta({ deltaY: -120 }, 800).deltaY).toBeLessThan(0);
    expect(normalizeWheelDelta({ deltaX: 50 }, 800).deltaX).toBeGreaterThan(0);
  });

  it('scales LINE-mode deltas to pixels', () => {
    // A typical 3-line notch must become a visible scroll, not 3px.
    const out = normalizeWheelDelta({ deltaMode: DOM_DELTA_LINE, deltaX: 0, deltaY: 3 }, 800);
    expect(out.deltaY).toBe(3 * LINE_HEIGHT_PX);
    expect(out.deltaY).toBeGreaterThan(100);
  });

  it('scales PAGE-mode deltas by the remote viewport height', () => {
    const out = normalizeWheelDelta({ deltaMode: DOM_DELTA_PAGE, deltaY: 1 }, 800);
    expect(out.deltaY).toBe(800);
  });

  it('keeps sub-pixel trackpad deltas instead of rounding them away', () => {
    // Rounding would silently kill slow trackpad scrolling.
    expect(normalizeWheelDelta({ deltaMode: DOM_DELTA_PIXEL, deltaY: 0.4 }, 800).deltaY).toBeCloseTo(0.4);
  });

  it('defaults to PIXEL mode when deltaMode is missing', () => {
    expect(normalizeWheelDelta({ deltaY: 100 }, 800).deltaY).toBe(100);
  });

  it('treats missing deltas as zero rather than NaN', () => {
    const out = normalizeWheelDelta({}, 800);
    expect(out).toEqual({ deltaX: 0, deltaY: 0 });
  });

  it('falls back to a sane page height when none is usable', () => {
    for (const bad of [undefined, 0, -1, NaN]) {
      const out = normalizeWheelDelta({ deltaMode: DOM_DELTA_PAGE, deltaY: 1 }, bad as number);
      expect(out.deltaY).toBeGreaterThan(0);
      expect(Number.isFinite(out.deltaY)).toBe(true);
    }
  });

  it('survives a null-ish event without throwing', () => {
    expect(() => normalizeWheelDelta(undefined as never, 800)).not.toThrow();
    expect(normalizeWheelDelta(undefined as never, 800)).toEqual({ deltaX: 0, deltaY: 0 });
  });

  it('handles horizontal-only scrolling', () => {
    const out = normalizeWheelDelta({ deltaMode: DOM_DELTA_LINE, deltaX: 2, deltaY: 0 }, 800);
    expect(out.deltaX).toBe(2 * LINE_HEIGHT_PX);
    expect(out.deltaY).toBe(0);
  });
});
