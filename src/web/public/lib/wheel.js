// Wheel delta normalization for the login bridge's input relay.
//
// Deliberately import-free so it can be unit-tested in Node: sign and scale
// bugs here are invisible in code review and silently break scrolling, which
// is exactly what happened before.
//
// Two things have to be right when turning a DOM WheelEvent into CDP's
// Input.dispatchMouseEvent(type: 'mouseWheel'):
//
// 1. UNITS. WheelEvent.deltaY is only in pixels when deltaMode is PIXEL. In
//    LINE mode one notch is about ±3, and in PAGE mode about ±1. CDP always
//    interprets its deltas as PIXELS, so forwarding a raw value from either of
//    those modes asks the remote page to scroll 3px or 1px — indistinguishable
//    from "scrolling is broken".
//
// 2. SIGN. CDP's mouseWheel uses the SAME convention as the DOM: positive
//    deltaY scrolls down. (Playwright's mouse.wheel(0, 100) scrolls down and
//    passes its deltas straight through to Input.dispatchMouseEvent.) So the
//    deltas must be forwarded unchanged — negating them reverses scrolling.

/** DOM WheelEvent.deltaMode values. */
export const DOM_DELTA_PIXEL = 0;
export const DOM_DELTA_LINE = 1;
export const DOM_DELTA_PAGE = 2;

/**
 * Pixels per "line" for LINE-mode wheel events. 40 matches what Chromium uses
 * internally for scrollbar line stepping, and puts a typical 3-line notch at a
 * familiar ~120px.
 */
export const LINE_HEIGHT_PX = 40;

/**
 * Convert a DOM WheelEvent's deltas into the pixel deltas CDP expects.
 *
 * @param {{deltaMode?: number, deltaX?: number, deltaY?: number}} ev
 * @param {number} pageHeightPx Height of one "page" for PAGE-mode events —
 *   pass the remote viewport height.
 * @returns {{deltaX: number, deltaY: number}} Pixel deltas, sign unchanged.
 */
export function normalizeWheelDelta(ev, pageHeightPx) {
  const mode = Number.isFinite(ev?.deltaMode) ? ev.deltaMode : DOM_DELTA_PIXEL;
  const page = Number.isFinite(pageHeightPx) && pageHeightPx > 0 ? pageHeightPx : 800;

  let scale = 1;
  if (mode === DOM_DELTA_LINE) scale = LINE_HEIGHT_PX;
  else if (mode === DOM_DELTA_PAGE) scale = page;

  const dx = Number.isFinite(ev?.deltaX) ? ev.deltaX : 0;
  const dy = Number.isFinite(ev?.deltaY) ? ev.deltaY : 0;

  // Not rounded: a trackpad legitimately produces sub-pixel deltas in PIXEL
  // mode, and rounding those to zero would drop slow scrolling entirely.
  return { deltaX: dx * scale, deltaY: dy * scale };
}
