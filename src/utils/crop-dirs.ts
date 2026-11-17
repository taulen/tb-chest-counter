import path from 'path';

/**
 * Where screenshot crops kept as review evidence live, and the guard that decides
 * whether a stored path may be served.
 *
 * A crop path comes out of the database, so it's untrusted input: an endpoint must
 * confine it to one of these directories before streaming the file, or a crafted path
 * turns an image endpoint into arbitrary file read. Three endpoints need that check
 * (chest crop, resource row crop, member evidence crop), so it lives here rather than
 * being re-derived at each call site.
 *
 * The crops were written by the retired screenshot reader; nothing writes new
 * ones, but the rows that point at them are still reviewed in the admin UI.
 */

/** Batch gift-card crops kept when a scan couldn't read the player name, or met a new member. */
export const MISSING_NAME_CROP_DIR = path.resolve('data', 'screenshots', 'ocr_missing_name');

/** Single history rows kept when a resource import couldn't resolve a row. */
export const UNRESOLVED_CROP_DIR = path.resolve('data', 'screenshots', 'resource_unresolved');

/** Single member-list rows kept when a might capture met a name not on the roster. */
export const MIGHT_NEW_MEMBER_CROP_DIR = path.resolve('data', 'screenshots', 'might_new_member');

const ALLOWED_CROP_DIRS = [MISSING_NAME_CROP_DIR, UNRESOLVED_CROP_DIR, MIGHT_NEW_MEMBER_CROP_DIR];

/**
 * Resolve a stored crop path and confirm it sits inside one of the allowed
 * directories. Returns the resolved absolute path, or null to reject.
 *
 * Requires a path strictly *inside* a directory — the directory itself is not a file
 * and streaming it would error.
 */
export function resolveAllowedCropPath(storedPath: string): string | null {
  const resolved = path.resolve(storedPath);
  return ALLOWED_CROP_DIRS.some((dir) => resolved.startsWith(dir + path.sep)) ? resolved : null;
}
