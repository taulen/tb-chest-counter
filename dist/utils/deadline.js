"use strict";
// Deadlines for operations that talk to the browser.
//
// Playwright's own timeouts cover navigation and page actions, but a
// surprising amount of its surface takes no timeout and is not guaranteed to
// settle: the login bridge's teardown calls (Page.stopScreencast,
// CDPSession.detach(), BrowserContext.close(), storageState()) and — the
// costlier omission — every input method, page.mouse.* and page.keyboard.*
// alike, which wait on the renderer acknowledging a CDP event. A browser
// process that is still alive but wedged (the classic out-of-memory
// swap-thrash) answers none of them and rejects none of them either: the
// promise simply never resolves.
//
// `.catch(() => {})` is no defence against that. It handles a rejection; it
// cannot rescue an await that never returns. So every such call gets a
// deadline, and the caller decides what to do when the deadline passes. The
// bounded input wrappers live in browser/input.ts; this module is just the
// primitive.
//
// Lived here as web/login-bridge/deadline.ts until the scanner needed it too:
// a five-hour scan on 2026-08-04 was parked inside an unbounded page.mouse.up.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeadlineExceeded = void 0;
exports.withDeadline = withDeadline;
exports.settleWithDeadline = settleWithDeadline;
/** Thrown by withDeadline when the operation outlives its deadline. */
class DeadlineExceeded extends Error {
    constructor(label, ms) {
        super(`${label} did not finish within ${ms}ms`);
        this.name = 'DeadlineExceeded';
    }
}
exports.DeadlineExceeded = DeadlineExceeded;
/**
 * Await `op`, rejecting with DeadlineExceeded if it takes longer than `ms`.
 *
 * The abandoned operation keeps running — we cannot cancel a CDP round trip
 * in flight — so a catch handler is attached to it immediately. Without that,
 * an operation that rejects *after* we stopped waiting surfaces as an
 * unhandled rejection and, depending on the Node flags, takes the process
 * with it.
 */
async function withDeadline(op, ms, label) {
    const promise = typeof op === 'function' ? op() : op;
    promise.catch(() => { });
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new DeadlineExceeded(label, ms)), ms);
                if (typeof timer.unref === 'function')
                    timer.unref();
            }),
        ]);
    }
    finally {
        // Always clear it, including on the success path — a pending timer would
        // otherwise hold a reference to the rejecter for the full duration.
        if (timer)
            clearTimeout(timer);
    }
}
/**
 * Run a best-effort cleanup step and report how it went, never throwing.
 *
 * The distinction between 'failed' and 'timeout' is the useful part:
 * 'failed' almost always means the thing was already gone (a detached CDP
 * session, a closed context) and is unremarkable, whereas 'timeout' means the
 * browser is still there and not answering — which is the case that needs a
 * harder escape hatch than a polite close().
 */
async function settleWithDeadline(op, ms, label) {
    try {
        await withDeadline(op, ms, label);
        return 'done';
    }
    catch (err) {
        return err instanceof DeadlineExceeded ? 'timeout' : 'failed';
    }
}
//# sourceMappingURL=deadline.js.map