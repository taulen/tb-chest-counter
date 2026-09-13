import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clearStaleProfileLocks, killProfileOwner } from '../../src/browser/profile-lock.js';

/**
 * Reproduces the crash loop from 2026-07-26: a container was killed while
 * Chromium held a persistent profile, leaving SingletonLock behind. Because
 * Docker assigns a new hostname on every recreate, Chromium read the lock,
 * saw a different host, and refused to break it — permanently, since it
 * cannot verify a process on another host is dead:
 *
 *   The profile appears to be in use by another Chromium process (24) on
 *   another computer (f174855942cd).
 *
 * The app then died on startup, restarted, and hit the same wall forever.
 */

function makeLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-profile-lock-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Write one singleton file the way Chromium does — a symlink whose target is
 * the payload, dangling on purpose. Windows dev boxes can't create symlinks
 * without elevation, so fall back to a regular file holding the same text;
 * readLockOwner() reads either.
 */
function writeSingleton(name: string, payload: string) {
  const target = path.join(dir, name);
  try {
    fs.symlinkSync(payload, target);
  } catch {
    fs.writeFileSync(target, payload);
  }
}

function writeLock(owner: string) {
  writeSingleton('SingletonLock', owner);
  writeSingleton('SingletonSocket', '/tmp/some.sock');
  writeSingleton('SingletonCookie', 'deadbeef');
}

/** lstat, because these are dangling symlinks — existsSync follows and lies. */
function lockPresent(name = 'SingletonLock'): boolean {
  try {
    fs.lstatSync(path.join(dir, name));
    return true;
  } catch {
    return false;
  }
}

describe('clearStaleProfileLocks', () => {
  it('removes a lock left by a different host (the container-recreate case)', () => {
    writeLock('f174855942cd-24');
    const log = makeLogger();

    clearStaleProfileLocks(dir, log);

    expect(lockPresent('SingletonLock')).toBe(false);
    expect(lockPresent('SingletonSocket')).toBe(false);
    expect(lockPresent('SingletonCookie')).toBe(false);
    expect(log.info).toHaveBeenCalled();
    expect(String(log.info.mock.calls[0][0])).toContain('f174855942cd');
  });

  it('removes a same-host lock whose owning process is gone', () => {
    // A pid that cannot be running: beyond any pid_max.
    writeLock(`${os.hostname()}-4194304`);

    clearStaleProfileLocks(dir, makeLogger());
    expect(lockPresent()).toBe(false);
  });

  it('LEAVES a same-host lock whose process is still alive', () => {
    // Our own pid is by definition alive — that's a real conflict, so the
    // lock must survive and Chromium gets to refuse rather than us letting
    // two browsers into one profile.
    writeLock(`${os.hostname()}-${process.pid}`);
    const log = makeLogger();

    clearStaleProfileLocks(dir, log);

    expect(lockPresent()).toBe(true);
    expect(log.warn).toHaveBeenCalled();
    expect(String(log.warn.mock.calls[0][0])).toContain('LIVE');
  });

  it('handles a hostname containing dashes (splits at the last one)', () => {
    writeLock('my-docker-host-99');
    clearStaleProfileLocks(dir, makeLogger());
    expect(lockPresent()).toBe(false);
  });

  it('is a no-op on a clean profile dir', () => {
    const log = makeLogger();
    clearStaleProfileLocks(dir, log);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('clears leftover socket/cookie even when the lock itself is absent', () => {
    // A half-written set from a kill mid-launch.
    writeSingleton('SingletonSocket', '/tmp/some.sock');
    clearStaleProfileLocks(dir, makeLogger());
    expect(lockPresent('SingletonSocket')).toBe(false);
  });

  it('ignores an unparseable lock target rather than deleting blindly', () => {
    writeSingleton('SingletonLock', 'garbage-with-no-pid');
    clearStaleProfileLocks(dir, makeLogger());
    expect(lockPresent()).toBe(true);
  });

  it('never throws on a missing directory', () => {
    expect(() =>
      clearStaleProfileLocks(path.join(dir, 'does', 'not', 'exist'), makeLogger()),
    ).not.toThrow();
  });
});

/**
 * The escape hatch for a browser that is alive but wedged (out of memory) and
 * answers no CDP command. clearStaleProfileLocks deliberately LEAVES that lock
 * alone, which is right at launch time and fatal afterwards: the leaked process
 * would hold the profile against every future session. So the timed-out
 * teardown path kills the owner instead of hoping.
 */
describe('killProfileOwner', () => {
  it('signals the live same-host owner and clears its locks', () => {
    writeLock(`${os.hostname()}-${process.pid}`);
    const log = makeLogger();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    // Our own pid stands in for the wedged browser: it is the only pid a test
    // can be sure is alive. The signal is stubbed, for obvious reasons.
    const killed = killProfileOwner(dir, log);

    expect(killed).toBe(process.pid);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');
    expect(lockPresent('SingletonLock')).toBe(false);
    expect(lockPresent('SingletonSocket')).toBe(false);
    expect(lockPresent('SingletonCookie')).toBe(false);
    expect(String(log.warn.mock.calls[0][0])).toContain('Force-killed');
    kill.mockRestore();
  });

  it('kills nothing when the owner is already dead, but still clears the locks', () => {
    writeLock(`${os.hostname()}-4194304`);
    expect(killProfileOwner(dir, makeLogger())).toBeNull();
    expect(lockPresent()).toBe(false);
  });

  it("does not signal another host's pid — that number means nothing here", () => {
    // A pid from a previous container is just an integer in our namespace, and
    // it could well belong to something unrelated and important.
    writeLock(`f174855942cd-${process.pid}`);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(killProfileOwner(dir, makeLogger())).toBeNull();
    expect(kill).not.toHaveBeenCalled();
    expect(lockPresent()).toBe(false);
    kill.mockRestore();
  });

  it('is a no-op on a profile with no lock at all', () => {
    expect(killProfileOwner(dir, makeLogger())).toBeNull();
  });

  it('never throws when the kill is refused', () => {
    writeLock(`${os.hostname()}-${process.pid}`);
    const log = makeLogger();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    expect(() => killProfileOwner(dir, log)).not.toThrow();
    expect(log.warn).toHaveBeenCalled();
    kill.mockRestore();
  });
});
