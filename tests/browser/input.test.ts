import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import {
  INPUT_DEADLINE_MS,
  keyPress,
  mouseClick,
  mouseDown,
  mouseMove,
  mouseUp,
  mouseWheel,
} from '../../src/browser/input.js';
import { DeadlineExceeded } from '../../src/utils/deadline.js';

/**
 * The property under test is liveness, not correctness: page.mouse.* and
 * page.keyboard.press take no timeout of their own and are a bare CDP round
 * trip, so a renderer that is alive but wedged answers none of them and
 * rejects none of them either. On 2026-08-04 a scan sat inside one of these
 * for the better part of five hours while the host OOM-killed Chromium's
 * children around it.
 *
 * So every test here asks the same question of a different method: given an
 * input call that NEVER settles, does the caller get control back?
 */

/** A promise that will never settle — the wedged-renderer case. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** Minimal Page stand-in whose input methods behave however a test says. */
function fakePage(behaviour: <T>() => Promise<T>): Page {
  return {
    mouse: {
      move: () => behaviour<void>(),
      down: () => behaviour<void>(),
      up: () => behaviour<void>(),
      click: () => behaviour<void>(),
      wheel: () => behaviour<void>(),
    },
    keyboard: {
      press: () => behaviour<void>(),
    },
  } as unknown as Page;
}

const WEDGED = fakePage(neverSettles);
const RESPONSIVE = fakePage(<T,>() => Promise.resolve(undefined as T));

/** Every wrapper, invoked against whichever page the test supplies. */
const CALLS: ReadonlyArray<[string, (page: Page) => Promise<void>]> = [
  ['mouseMove', (p) => mouseMove(p, 10, 20)],
  ['mouseDown', (p) => mouseDown(p)],
  ['mouseUp', (p) => mouseUp(p)],
  ['mouseClick', (p) => mouseClick(p, 10, 20)],
  ['mouseWheel', (p) => mouseWheel(p, 0, 100)],
  ['keyPress', (p) => keyPress(p, 'Escape')],
];

describe('bounded browser input', () => {
  it.each(CALLS)('%s gives up on a renderer that never answers', async (_name, call) => {
    vi.useFakeTimers();
    try {
      const pending = call(WEDGED).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(INPUT_DEADLINE_MS + 1);
      expect(await pending).toBeInstanceOf(DeadlineExceeded);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(CALLS)('%s resolves normally when the renderer answers', async (_name, call) => {
    await expect(call(RESPONSIVE)).resolves.toBeUndefined();
  });

  it('forwards the step count on a humanised move', async () => {
    const move = vi.fn(() => Promise.resolve());
    const page = { mouse: { move } } as unknown as Page;
    await mouseMove(page, 5, 6, { steps: 4 });
    expect(move).toHaveBeenCalledWith(5, 6, { steps: 4 });
  });

  it('names the failing call in the error, so a log line says which input wedged', async () => {
    vi.useFakeTimers();
    try {
      const pending = mouseUp(WEDGED).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(INPUT_DEADLINE_MS + 1);
      expect(String(await pending)).toContain('mouse.up');
    } finally {
      vi.useRealTimers();
    }
  });
});
