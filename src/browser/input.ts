// Bounded mouse and keyboard input.
//
// Playwright's default action timeout covers the methods that resolve a
// selector or wait for a navigation — page.screenshot(), page.goto(),
// locator.click(). It does NOT cover raw input: page.mouse.move/down/up/
// click/wheel and page.keyboard.press/type take no timeout option and are
// implemented as a bare CDP round trip (Input.dispatchMouseEvent /
// Input.dispatchKeyEvent) raced only against the page closing. If the
// renderer is alive but not answering, the promise never settles and the
// caller waits forever.
//
// That is not hypothetical. On 2026-08-04 the host — not this container, whose
// cgroup was at 914MB of a 5120MB ceiling — ran out of memory and the kernel
// began OOM-killing Chromium's children. The renderer that survived stayed
// alive but wedged, and a scheduled scan sat inside the capture loop for
// 4h59m37s taking ~310 seconds per batch against a healthy ~4, until the
// renderer finally died outright and the sweep's last words were
// "mouse.up: Target crashed". Every scheduled cycle for both clans was
// blocked behind the scan-in-progress guard for that entire window, and the
// operator had to kill the stack by hand.
//
// This whole module is that hole closed: every raw input call in the codebase
// goes through here, so a wedged renderer produces a throw the existing
// crash-handling paths already know what to do with (isCrashLikeError, the
// per-batch catch in scan-pipeline.ts, the relaunch loop in auth-check.ts)
// instead of an await that never returns.
//
// The deadline is deliberately generous — this is a liveness backstop, not a
// latency budget. Input on a working browser answers in single-digit
// milliseconds; anything approaching 30s is already a broken browser.

import type { Page } from 'playwright';
import { withDeadline } from '../utils/deadline.js';

/**
 * Ceiling on a single input round trip. Matches Playwright's own default
 * action timeout so a bounded mouse click behaves like a bounded locator
 * click, and so nothing here can be the slowest thing in a scan without the
 * rest of the scan already having given up.
 */
export const INPUT_DEADLINE_MS = 30_000;

/**
 * Move the mouse, giving up if the renderer doesn't acknowledge.
 *
 * `steps` is forwarded because the humanised-movement helpers rely on it; a
 * multi-step move is several CDP events, so it gets the deadline as a whole
 * rather than per event. Still bounded, still generous.
 */
export async function mouseMove(
  page: Page,
  x: number,
  y: number,
  options?: { steps?: number },
): Promise<void> {
  await withDeadline(page.mouse.move(x, y, options), INPUT_DEADLINE_MS, `mouse.move(${x},${y})`);
}

/**
 * Press the primary button.
 *
 * A down that lands while the matching up times out leaves the button
 * logically held, which sounds worse than it is: every caller treats a
 * deadline as "abandon this phase", and the next scan re-navigates (or
 * relaunches) the page before it clicks anything. Trying to be clever about
 * releasing it would mean another unbounded call on a browser that just
 * proved it doesn't answer them.
 */
export async function mouseDown(page: Page): Promise<void> {
  await withDeadline(page.mouse.down(), INPUT_DEADLINE_MS, 'mouse.down');
}

/** Release the primary button. See mouseDown for the half-click caveat. */
export async function mouseUp(page: Page): Promise<void> {
  await withDeadline(page.mouse.up(), INPUT_DEADLINE_MS, 'mouse.up');
}

/** Click at viewport coordinates. */
export async function mouseClick(page: Page, x: number, y: number): Promise<void> {
  await withDeadline(page.mouse.click(x, y), INPUT_DEADLINE_MS, `mouse.click(${x},${y})`);
}

/** Scroll by a wheel delta. */
export async function mouseWheel(page: Page, deltaX: number, deltaY: number): Promise<void> {
  await withDeadline(page.mouse.wheel(deltaX, deltaY), INPUT_DEADLINE_MS, `mouse.wheel(${deltaX},${deltaY})`);
}

/**
 * Press a key.
 *
 * Escape is the single most common input call in this codebase — it is how
 * every phase closes whatever panel the last one left open — which makes it
 * the likeliest place to park. The auth phase already logs "Escape press
 * interrupted by browser target crash/close" on the crash path; before this
 * it had no equivalent for the wedge path, because there was nothing to log.
 */
export async function keyPress(page: Page, key: string): Promise<void> {
  await withDeadline(page.keyboard.press(key), INPUT_DEADLINE_MS, `keyboard.press(${key})`);
}
