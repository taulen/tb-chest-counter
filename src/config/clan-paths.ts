import path from 'path';

/**
 * Per-clan storage location helpers. Each clan owns:
 *
 *   data/clans/<id>/storage-state.json     — the saved website login (cookies)
 *   data/clans/<id>/login-bridge-profile/  — login-bridge persistent profile
 *   data/clans/<id>/game-device.json       — the game client's device id
 *
 * Keeping each clan under its own directory means no cookies, localStorage,
 * IndexedDB or service-worker state can leak between clans.
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

