"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RETAINED_CROP_DIRS = exports.MIGHT_NEW_MEMBER_CROP_DIR = exports.UNRESOLVED_CROP_DIR = exports.MISSING_NAME_CROP_DIR = void 0;
exports.resolveAllowedCropPath = resolveAllowedCropPath;
const path_1 = __importDefault(require("path"));
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
 * Dependency-free on purpose — api.ts can import this without dragging in the
 * scanner's Playwright/OCR module tree.
 */
/** Batch gift-card crops kept when a scan couldn't read the player name, or met a new member. */
exports.MISSING_NAME_CROP_DIR = path_1.default.resolve('data', 'screenshots', 'ocr_missing_name');
/** Single history rows kept when a resource import couldn't resolve a row. */
exports.UNRESOLVED_CROP_DIR = path_1.default.resolve('data', 'screenshots', 'resource_unresolved');
/** Single member-list rows kept when a might capture met a name not on the roster. */
exports.MIGHT_NEW_MEMBER_CROP_DIR = path_1.default.resolve('data', 'screenshots', 'might_new_member');
const ALLOWED_CROP_DIRS = [exports.MISSING_NAME_CROP_DIR, exports.UNRESOLVED_CROP_DIR, exports.MIGHT_NEW_MEMBER_CROP_DIR];
/**
 * Crop directories exempt from the age-based screenshot cleanup.
 *
 * These hold review evidence whose lifetime is the DATABASE ROW that points at
 * it, not a number of days. Ageing them out would leave rows referencing files
 * that no longer exist, so the admin hover would break on anything older than
 * the retention window — and a new member can easily sit unacknowledged for
 * longer than that.
 */
exports.RETAINED_CROP_DIRS = [exports.UNRESOLVED_CROP_DIR, exports.MIGHT_NEW_MEMBER_CROP_DIR];
/**
 * Resolve a stored crop path and confirm it sits inside one of the allowed
 * directories. Returns the resolved absolute path, or null to reject.
 *
 * Requires a path strictly *inside* a directory — the directory itself is not a file
 * and streaming it would error.
 */
function resolveAllowedCropPath(storedPath) {
    const resolved = path_1.default.resolve(storedPath);
    return ALLOWED_CROP_DIRS.some((dir) => resolved.startsWith(dir + path_1.default.sep)) ? resolved : null;
}
//# sourceMappingURL=crop-dirs.js.map