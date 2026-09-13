"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.XVFB_DISPLAY = void 0;
exports.tryStartXvfb = tryStartXvfb;
exports.stopXvfb = stopXvfb;
const child_process_1 = require("child_process");
const logger_js_1 = require("../../utils/logger.js");
const log = (0, logger_js_1.childLogger)('login-bridge-xvfb');
/**
 * Xvfb display number. :99 is conventional and unlikely to collide with
 * any real display the host might map in. Kept as a single source of
 * truth so the bridge and any future test/dev tooling agree.
 */
exports.XVFB_DISPLAY = ':99';
/**
 * Spawn Xvfb on XVFB_DISPLAY and return the handle on success. Returns
 * null if Xvfb is not installed (ENOENT) or fails to come up — callers
 * fall back to headless mode (degraded cookie coverage but still works).
 */
async function tryStartXvfb(width, height) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = (0, child_process_1.spawn)('Xvfb', [exports.XVFB_DISPLAY, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'], { stdio: 'ignore', detached: false });
        }
        catch (err) {
            log.warn('Failed to spawn Xvfb: ' + String(err));
            resolve(null);
            return;
        }
        let settled = false;
        const settle = (handle) => {
            if (settled)
                return;
            settled = true;
            if (handle === null) {
                try {
                    proc.kill('SIGTERM');
                }
                catch { /* ignore */ }
            }
            resolve(handle);
        };
        proc.once('error', (err) => {
            log.warn('Xvfb spawn error: ' + String(err));
            settle(null);
        });
        proc.once('exit', (code, signal) => {
            if (!settled) {
                log.warn(`Xvfb exited before ready (code=${code} signal=${signal ?? 'none'})`);
                settle(null);
            }
        });
        // Xvfb takes a moment to bind the display socket. 800 ms is plenty
        // in practice; if the process is still alive after that we consider
        // it up.
        setTimeout(() => {
            if (proc.exitCode === null && !proc.killed) {
                log.info(`Xvfb ready on ${exports.XVFB_DISPLAY}`);
                settle({ display: exports.XVFB_DISPLAY, proc });
            }
        }, 800);
    });
}
/** Best-effort SIGTERM. Safe to call if proc is already dead. */
function stopXvfb(handle) {
    if (!handle)
        return;
    try {
        handle.proc.kill('SIGTERM');
    }
    catch {
        // Already exited; nothing to do.
    }
}
//# sourceMappingURL=xvfb.js.map