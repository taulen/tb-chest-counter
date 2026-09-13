import path from 'path';

/**
 * Per-clan storage location helpers. Each clan owns:
 *
 *   data/clans/<id>/storage-state.json     — Playwright cookies/auth
 *   data/clans/<id>/browser-profile/       — scanner Chromium profile dir
 *   data/clans/<id>/login-bridge-profile/  — login-bridge persistent profile
 *
 * The two profile dirs are separate so the scanner and the login bridge
 * can run side-by-side without locking each other out (Playwright won't
 * open the same userDataDir twice). Putting BOTH under the per-clan
 * directory means scans can hot-swap the active clan without leaking
 * cookies, localStorage, IndexedDB, or service-worker state between
 * clans — each clan's persistent profile stays isolated.
 */

export function clanDataDir(clanId: number): string {
  return path.resolve('data', 'clans', String(clanId));
}

export function clanStorageStatePath(clanId: number): string {
  return path.join(clanDataDir(clanId), 'storage-state.json');
}

export function clanLoginProfileDir(clanId: number): string {
  return path.join(clanDataDir(clanId), 'login-bridge-profile');
}

/**
 * Persistent profile dir used by the SCANNER's headless Chromium for
 * `clanId`. Distinct from clanLoginProfileDir (which the login bridge
 * uses) so both can run sequentially without colliding on userDataDir.
 */
export function clanBrowserProfileDir(clanId: number): string {
  return path.join(clanDataDir(clanId), 'browser-profile');
}

