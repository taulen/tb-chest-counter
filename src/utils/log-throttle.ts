// Coalescing wrapper around a log function, for call sites that live on a
// hot path and can fail in bursts.
//
// The motivating case: the login bridge relays every client mousemove to
// Chromium over CDP. When the remote browser dies mid-session, EVERY
// queued input event fails with the identical error — the observed
// behaviour was ~100 byte-for-byte-identical warnings inside two seconds.
// That is worse than noisy: the System page's warning buffer only holds
// 20 entries (see log-buffer.ts), so one input flood evicts every other
// warning the admin actually needed to see, and it hammers the JSONL
// persister at the same time.
//
// Contract: the first occurrence of a key logs immediately (never delay
// the signal), repeats inside the window are counted, and when the window
// closes a single summary line reports how many were swallowed. Worst case
// per key is 2 lines per window instead of unbounded.

export interface CoalescedWarner {
  /**
   * Log `message`, or count it as a repeat if an identical `key` was
   * logged within the current window. `key` is what dedupes — pass a
   * stable string (event kind + error text), not the full message.
   */
  warn(key: string, message: string): void;
  /**
   * Emit any pending "repeated N×" summaries right now and close every
   * window. Call this at a natural boundary (e.g. session teardown) so
   * the tail of a burst is reported in context instead of arriving
   * seconds later next to unrelated logs.
   */
  flush(): void;
  /** Drop all pending state WITHOUT logging summaries. For tests. */
  reset(): void;
}

const DEFAULT_WINDOW_MS = 10_000;

interface PendingWindow {
  /** Repeats observed after the initial (already logged) occurrence. */
  count: number;
  /** Most recent message for this key — used in the summary line. */
  last: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Build a coalescing warner over `emit` (normally `log.warn.bind(log)`).
 *
 * @param emit      Underlying sink. Called with a ready-to-log string.
 * @param windowMs  Suppression window per key.
 */
export function createCoalescedWarner(
  emit: (message: string) => void,
  windowMs: number = DEFAULT_WINDOW_MS,
): CoalescedWarner {
  const pending = new Map<string, PendingWindow>();

  const closeWindow = (key: string): void => {
    const win = pending.get(key);
    if (!win) return;
    pending.delete(key);
    clearTimeout(win.timer);
    if (win.count > 0) {
      emit(`${win.last} — repeated ${win.count}× in the last ${Math.round(windowMs / 1000)}s (suppressed)`);
    }
  };

  return {
    warn(key: string, message: string): void {
      const win = pending.get(key);
      if (win) {
        win.count++;
        win.last = message;
        return;
      }
      emit(message);
      const timer = setTimeout(() => closeWindow(key), windowMs);
      // Never let a suppression window hold the process open on shutdown.
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(key, { count: 0, last: message, timer });
    },
    flush(): void {
      for (const key of [...pending.keys()]) closeWindow(key);
    },
    reset(): void {
      for (const win of pending.values()) clearTimeout(win.timer);
      pending.clear();
    },
  };
}
