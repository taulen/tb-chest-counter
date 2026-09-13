"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCoalescedWarner = createCoalescedWarner;
const DEFAULT_WINDOW_MS = 10_000;
/**
 * Build a coalescing warner over `emit` (normally `log.warn.bind(log)`).
 *
 * @param emit      Underlying sink. Called with a ready-to-log string.
 * @param windowMs  Suppression window per key.
 */
function createCoalescedWarner(emit, windowMs = DEFAULT_WINDOW_MS) {
    const pending = new Map();
    const closeWindow = (key) => {
        const win = pending.get(key);
        if (!win)
            return;
        pending.delete(key);
        clearTimeout(win.timer);
        if (win.count > 0) {
            emit(`${win.last} — repeated ${win.count}× in the last ${Math.round(windowMs / 1000)}s (suppressed)`);
        }
    };
    return {
        warn(key, message) {
            const win = pending.get(key);
            if (win) {
                win.count++;
                win.last = message;
                return;
            }
            emit(message);
            const timer = setTimeout(() => closeWindow(key), windowMs);
            // Never let a suppression window hold the process open on shutdown.
            if (typeof timer.unref === 'function')
                timer.unref();
            pending.set(key, { count: 0, last: message, timer });
        },
        flush() {
            for (const key of [...pending.keys()])
                closeWindow(key);
        },
        reset() {
            for (const win of pending.values())
                clearTimeout(win.timer);
            pending.clear();
        },
    };
}
//# sourceMappingURL=log-throttle.js.map