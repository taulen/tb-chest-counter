"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clanDataDir = clanDataDir;
exports.clanStorageStatePath = clanStorageStatePath;
exports.clanLoginProfileDir = clanLoginProfileDir;
exports.clanBrowserProfileDir = clanBrowserProfileDir;
const path_1 = __importDefault(require("path"));
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
function clanDataDir(clanId) {
    return path_1.default.resolve('data', 'clans', String(clanId));
}
function clanStorageStatePath(clanId) {
    return path_1.default.join(clanDataDir(clanId), 'storage-state.json');
}
function clanLoginProfileDir(clanId) {
    return path_1.default.join(clanDataDir(clanId), 'login-bridge-profile');
}
/**
 * Persistent profile dir used by the SCANNER's headless Chromium for
 * `clanId`. Distinct from clanLoginProfileDir (which the login bridge
 * uses) so both can run sequentially without colliding on userDataDir.
 */
function clanBrowserProfileDir(clanId) {
    return path_1.default.join(clanDataDir(clanId), 'browser-profile');
}
//# sourceMappingURL=clan-paths.js.map