import { describe, expect, it, vi } from 'vitest';
import {
  DeadlineExceeded,
  settleWithDeadline,
  withDeadline,
} from '../../src/utils/deadline.js';

/**
 * These deadlines exist because of a real wedge: a login bridge whose browser
 * was alive but out of memory answered `context.close()` with neither a resolve
 * nor a reject. The teardown awaiting it never returned, so the bridge stayed
 * "active" forever and the operator could only restart the container.
 *
 * The property that matters, and the one every test here is about, is that a
 * promise which NEVER settles must not be able to hold us up.
 */

/** A promise that will never settle — the wedged-browser case. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('withDeadline', () => {
  it('returns the value when the operation finishes in time', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 1_000, 'op')).resolves.toBe('ok');
  });

  it('accepts a thunk as well as a promise', async () => {
    await expect(withDeadline(() => Promise.resolve(7), 1_000, 'op')).resolves.toBe(7);
  });

  it('rejects with DeadlineExceeded when the operation never settles', async () => {
    const err: unknown = await withDeadline(neverSettles(), 20, 'closing the browser').catch((e) => e);
    expect(err).toBeInstanceOf(DeadlineExceeded);
    expect((err as Error).message).toContain('closing the browser');
    expect((err as Error).message).toContain('20ms');
  });

  it("passes the operation's own rejection through unchanged", async () => {
    const boom = new Error('target closed');
    await expect(withDeadline(Promise.reject(boom), 1_000, 'op')).rejects.toBe(boom);
  });

  it('does not leave the process holding a timer after success', async () => {
    // Regression guard for the naive Promise.race: a pending timer keeps a
    // reference to the rejecter, so a long deadline on a fast operation would
    // hold the event loop open for the full duration.
    const clear = vi.spyOn(global, 'clearTimeout');
    await withDeadline(Promise.resolve(1), 60_000, 'op');
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('swallows a rejection that arrives after the deadline passed', async () => {
    // The abandoned operation keeps running and may reject later. Nobody is
    // awaiting it by then, so without an attached handler that surfaces as an
    // unhandled rejection.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    let reject!: (e: Error) => void;
    const slow = new Promise<void>((_res, rej) => {
      reject = rej;
    });

    await expect(withDeadline(slow, 10, 'op')).rejects.toBeInstanceOf(DeadlineExceeded);
    reject(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 20));

    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });
});

describe('settleWithDeadline', () => {
  it("reports 'done' for a clean completion", async () => {
    await expect(settleWithDeadline(Promise.resolve(), 1_000, 'op')).resolves.toBe('done');
  });

  it("reports 'failed' — not 'timeout' — when the operation rejects", async () => {
    // The distinction is the point: 'failed' almost always means the thing was
    // already gone (a detached CDP session), which needs no escalation, while
    // 'timeout' means a live process is ignoring us and must be killed.
    await expect(
      settleWithDeadline(Promise.reject(new Error('already detached')), 1_000, 'op'),
    ).resolves.toBe('failed');
  });

  it("reports 'timeout' when the operation never settles", async () => {
    await expect(settleWithDeadline(neverSettles(), 20, 'op')).resolves.toBe('timeout');
  });

  it('never throws, whatever the operation does', async () => {
    await expect(
      settleWithDeadline(() => {
        throw new Error('threw synchronously');
      }, 20, 'op'),
    ).resolves.toBe('failed');
  });
});
