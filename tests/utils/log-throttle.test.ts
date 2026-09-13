import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescedWarner } from '../../src/utils/log-throttle.js';

/**
 * The coalescer exists because the login bridge relays every client
 * mousemove over CDP: when the remote browser dies, ~100 byte-identical
 * warnings landed inside two seconds, which overflows the 20-entry System
 * warning buffer and evicts everything else. Guarantee here is "first
 * occurrence immediately, then at most one summary per window per key".
 */
describe('createCoalescedWarner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('logs the first occurrence immediately', () => {
    const emit = vi.fn();
    const w = createCoalescedWarner(emit, 1000);
    w.warn('k', 'boom');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('boom');
  });

  it('collapses a burst into one immediate line plus one summary', () => {
    const emit = vi.fn();
    const w = createCoalescedWarner(emit, 1000);
    for (let i = 0; i < 100; i++) w.warn('k', 'boom');

    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][0]).toContain('repeated 99×');
  });

  it('emits no summary when the first occurrence never repeated', () => {
    const emit = vi.fn();
    const w = createCoalescedWarner(emit, 1000);
    w.warn('k', 'boom');
    vi.advanceTimersByTime(5000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('keys are independent — a new error is not hidden by another one window', () => {
    const emit = vi.fn();
    const w = createCoalescedWarner(emit, 1000);
    w.warn('a', 'first problem');
    w.warn('b', 'different problem');
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('logs immediately again once the window has passed', () => {
    const emit = vi.fn();
    const w = createCoalescedWarner(emit, 1000);
    w.warn('k', 'boom');
    vi.advanceTimersByTime(1001);
    w.warn('k', 'boom');
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('flush() emits pending summaries right away', () => {
    const emit = vi.fn();
    const w = createCoalescedWarner(emit, 60_000);
    w.warn('k', 'boom');
    w.warn('k', 'boom');
    w.warn('k', 'boom');
    expect(emit).toHaveBeenCalledTimes(1);

    w.flush();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][0]).toContain('repeated 2×');

    // Window is closed — nothing more fires later, and no double summary.
    vi.advanceTimersByTime(120_000);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('reset() drops state without emitting a summary', () => {
    const emit = vi.fn();
    const w = createCoalescedWarner(emit, 1000);
    w.warn('k', 'boom');
    w.warn('k', 'boom');
    w.reset();
    vi.advanceTimersByTime(5000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('summarises using the most recent message for the key', () => {
    const emit = vi.fn();
    const w = createCoalescedWarner(emit, 1000);
    w.warn('k', 'first text');
    w.warn('k', 'later text');
    w.flush();
    expect(emit.mock.calls[1][0]).toContain('later text');
  });
});
