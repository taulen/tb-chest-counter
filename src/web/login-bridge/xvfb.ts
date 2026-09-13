import { spawn, type ChildProcess } from 'child_process';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('login-bridge-xvfb');

/**
 * Xvfb display number. :99 is conventional and unlikely to collide with
 * any real display the host might map in. Kept as a single source of
 * truth so the bridge and any future test/dev tooling agree.
 */
export const XVFB_DISPLAY = ':99';

export interface XvfbHandle {
  display: string;
  proc: ChildProcess;
}

/**
 * Spawn Xvfb on XVFB_DISPLAY and return the handle on success. Returns
 * null if Xvfb is not installed (ENOENT) or fails to come up — callers
 * fall back to headless mode (degraded cookie coverage but still works).
 */
export async function tryStartXvfb(width: number, height: number): Promise<XvfbHandle | null> {
  return new Promise<XvfbHandle | null>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(
        'Xvfb',
        [XVFB_DISPLAY, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'],
        { stdio: 'ignore', detached: false },
      );
    } catch (err) {
      log.warn('Failed to spawn Xvfb: ' + String(err));
      resolve(null);
      return;
    }

    let settled = false;
    const settle = (handle: XvfbHandle | null) => {
      if (settled) return;
      settled = true;
      if (handle === null) {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
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
        log.info(`Xvfb ready on ${XVFB_DISPLAY}`);
        settle({ display: XVFB_DISPLAY, proc });
      }
    }, 800);
  });
}

/** Best-effort SIGTERM. Safe to call if proc is already dead. */
export function stopXvfb(handle: XvfbHandle | null): void {
  if (!handle) return;
  try {
    handle.proc.kill('SIGTERM');
  } catch {
    // Already exited; nothing to do.
  }
}
