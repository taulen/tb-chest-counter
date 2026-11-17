"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clanDataDir = clanDataDir;
exports.clanStorageStatePath = clanStorageStatePath;
exports.clanLoginProfileDir = clanLoginProfileDir;
const path_1 = __importDefault(require("path"));
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
function clanDataDir(clanId) {
    return path_1.default.resolve('data', 'clans', String(clanId));
}
function clanStorageStatePath(clanId) {
    return path_1.default.join(clanDataDir(clanId), 'storage-state.json');
}
function clanLoginProfileDir(clanId) {
    return path_1.default.join(clanDataDir(clanId), 'login-bridge-profile');
}
//# sourceMappingURL=clan-paths.js.map