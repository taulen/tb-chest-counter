// Stale Chromium profile-lock cleanup.
//
// A persistent-profile Chromium writes three singleton files into its
// userDataDir so a second instance can't corrupt the profile:
//
//   SingletonLock    symlink whose TARGET is the literal text "<hostname>-<pid>"
//   SingletonSocket  symlink to the IPC socket path
//   SingletonCookie  symlink holding a random cookie value
//
// On an unclean exit (SIGKILL, OOM kill, container stop mid-launch) they
// survive in the mounted volume. On the next start Chromium reads
// SingletonLock, compares the hostname against its own, and — because Docker
// assigns a NEW container hostname on every recreate — concludes the profile
// is held by a process "on another computer". It then refuses to break the
// lock, by design: it cannot verify that a process on a different host is
// dead. So it exits with:
//
//   The profile appears to be in use by another Chromium process (24) on
//   another computer (f174855942cd).
//
// That state is unrecoverable without deleting the files, which turns one
// unclean shutdown into a permanent crash loop. This module clears the locks
// when they cannot possibly be live.
//
// Safe here because each profile dir has exactly one launcher in this app —
// the scanner and the login bridge deliberately use SEPARATE dirs (see
// config/clan-paths.ts) and each serializes its own launches. We still only
// remove a lock we can PROVE is dead rather than clearing unconditionally.

import fs from 'fs';
import os from 'os';
import path from 'path';
import type pino from 'pino';

const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/**
 * Delete a path that is very likely a symlink.
 *
 * fs.existsSync() is useless here: SingletonLock's target ("host-1234") is
 * not a real file, so it is a DANGLING symlink and existsSync — which
 * follows links — reports false for a file that is definitely there.
 * unlink() operates on the link itself, so just attempt it and ignore ENOENT.
 */
function unlinkIfPresent(target: string): boolean {
  try {
    fs.unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Parsed contents of a SingletonLock symlink target. */
interface LockOwner {
  hostname: string;
  pid: number;
}

/**
 * Read SingletonLock's owner and split it into hostname + pid. The format is
 * "<hostname>-<pid>" and a hostname may itself contain '-', so split at the
 * LAST separator. Returns null if the lock is absent or unparseable.
 *
 * Chromium writes this as a symlink target on Linux (our deployment target).
 * Falling back to reading it as a regular file costs nothing, covers a
 * filesystem that can't do symlinks, and lets this be tested on a dev box
 * without symlink privileges.
 */
function readLockOwner(lockPath: string): LockOwner | null {
  let target: string;
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    try {
      target = fs.readFileSync(lockPath, 'utf8').trim();
    } catch {
      return null;
    }
  }
  const sep = target.lastIndexOf('-');
  if (sep <= 0) return null;
  const pid = Number(target.slice(sep + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { hostname: target.slice(0, sep), pid };
}

/** Whether a pid is alive in OUR namespace. Signal 0 checks without sending. */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but isn't ours — treat as alive, don't touch it.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Clear Chromium's singleton locks from `userDataDir` when they cannot be
 * held by a live browser. Call immediately before launchPersistentContext.
 *
 * Leaves the lock alone in the one case where it might be real: it names THIS
 * host and that pid is still running. Then we log a warning and let Chromium
 * make the call — better a clear "profile in use" error than two browsers in
 * one profile.
 *
 * Best-effort and never throws; a cleanup failure must not stop a launch that
 * might well have succeeded anyway.
 */
export function clearStaleProfileLocks(userDataDir: string, log: pino.Logger): void {
  try {
    const lockPath = path.join(userDataDir, 'SingletonLock');
    const owner = readLockOwner(lockPath);
    if (!owner) {
      // No lock (the normal case) — but a half-written set can still linger.
      for (const name of SINGLETON_FILES.slice(1)) {
        unlinkIfPresent(path.join(userDataDir, name));
      }
      return;
    }

    const sameHost = owner.hostname === os.hostname();
    if (sameHost && pidIsAlive(owner.pid)) {
      log.warn(
        `Chromium profile ${userDataDir} is locked by a LIVE process (pid ${owner.pid}) ` +
          'on this host — leaving the lock in place. If nothing should be using this ' +
          'profile, that process is a leaked browser.',
      );
      return;
    }

    const why = sameHost
      ? `its owner (pid ${owner.pid}) is gone`
      : `it belongs to container/host "${owner.hostname}", not this one (${os.hostname()})`;
    let removed = 0;
    for (const name of SINGLETON_FILES) {
      if (unlinkIfPresent(path.join(userDataDir, name))) removed++;
    }
    log.info(
      `Cleared ${removed} stale Chromium singleton lock file(s) from ${userDataDir} — ${why}. ` +
        'Left over from an unclean shutdown; Chromium would otherwise refuse to start.',
    );
  } catch (err) {
    log.warn('Profile lock cleanup failed (continuing to launch anyway): ' + String(err));
  }
}

/**
 * Last resort: SIGKILL the Chromium that holds `userDataDir`, then clear the
 * locks it leaves behind.
 *
 * Only for the case where a graceful `context.close()` has already been given
 * a deadline and missed it — a browser that is alive but wedged (typically out
 * of memory) accepts no CDP command and exits on no signal short of SIGKILL.
 * Left alone it is worse than a leaked process: it still owns SingletonLock
 * with a LIVE pid on THIS host, which is precisely the one case
 * clearStaleProfileLocks refuses to clear, so the next launch into that
 * profile fails with "profile appears to be in use" — a wedge that outlives
 * the session that caused it.
 *
 * Safe because a profile dir has exactly one launcher in this app (see the
 * module header): whatever holds this one is ours, and by this point we have
 * already decided it is unrecoverable.
 *
 * Never throws. Returns the pid killed, or null if there was nothing to kill.
 */
export function killProfileOwner(userDataDir: string, log: pino.Logger): number | null {
  try {
    const owner = readLockOwner(path.join(userDataDir, 'SingletonLock'));
    if (!owner) {
      // Chromium already released the lock, so it is on its way out by
      // itself. Still sweep the half-written set as the launch path does.
      for (const name of SINGLETON_FILES) unlinkIfPresent(path.join(userDataDir, name));
      return null;
    }
    if (owner.hostname !== os.hostname()) {
      // Another container's leftovers — not a live process we can signal.
      // The normal pre-launch cleanup handles these.
      for (const name of SINGLETON_FILES) unlinkIfPresent(path.join(userDataDir, name));
      return null;
    }
    if (!pidIsAlive(owner.pid)) {
      for (const name of SINGLETON_FILES) unlinkIfPresent(path.join(userDataDir, name));
      return null;
    }
    process.kill(owner.pid, 'SIGKILL');
    log.warn(
      `Force-killed the wedged Chromium holding ${userDataDir} (pid ${owner.pid}) — it did not ` +
        'respond to a graceful close. Its profile locks have been cleared so the next launch works.',
    );
    for (const name of SINGLETON_FILES) unlinkIfPresent(path.join(userDataDir, name));
    return owner.pid;
  } catch (err) {
    log.warn(`Could not force-kill the browser holding ${userDataDir}: ` + String(err));
    return null;
  }
}
