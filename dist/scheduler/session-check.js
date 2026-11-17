"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkClanSessions = checkClanSessions;
/**
 * Browser-free check of every active clan's saved Total Battle login.
 *
 * The Clans page's "Authenticated" used to mean only "a session file exists":
 * whether it still worked was learned when the next scan hit the logged-out
 * page, so with scans paused a dead login looked fine indefinitely. One GET of
 * the site page with the stored cookies answers it in about a second
 * (client.checkSiteSession), presents no token, and is run every 30 minutes by
 * the scan loop. Definite answers go through session-health.ts — the same path
 * the scan's auth check uses — and 'unknown' (network error, odd page) changes
 * nothing.
 */
const fs_1 = __importDefault(require("fs"));
const logger_js_1 = require("../utils/logger.js");
const clan_repo_js_1 = require("../data/repositories/clan-repo.js");
const clan_paths_js_1 = require("../config/clan-paths.js");
const client_js_1 = require("../game-protocol/client.js");
const session_health_js_1 = require("./session-health.js");
const log = (0, logger_js_1.childLogger)('session-check');
async function checkClanSessions() {
    for (const clan of (0, clan_repo_js_1.listClans)({ activeOnly: true })) {
        const file = (0, clan_paths_js_1.clanStorageStatePath)(clan.id);
        if (!fs_1.default.existsSync(file))
            continue;
        const state = await (0, client_js_1.checkSiteSession)(file);
        if (state === 'ok')
            (0, session_health_js_1.noteSessionHealthy)(clan.id, 'the saved session is signed in on totalbattle.com (checked without a browser)');
        else if (state === 'logged-out')
            (0, session_health_js_1.noteSessionLoggedOut)(clan.id, 'saved Total Battle session is logged out (checked without a browser)');
        else
            log.debug(`Clan #${clan.id}: session check inconclusive; leaving the re-auth flag as it is`);
    }
}
//# sourceMappingURL=session-check.js.map