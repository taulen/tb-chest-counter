"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicClan = publicClan;
exports.publicClanWithCounts = publicClanWithCounts;
exports.createClanSubRouter = createClanSubRouter;
const fs_1 = __importDefault(require("fs"));
const express_1 = require("express");
const member_repo_js_1 = require("../../../data/repositories/member-repo.js");
const session_repo_js_1 = require("../../../data/repositories/session-repo.js");
const clan_paths_js_1 = require("../../../config/clan-paths.js");
const parse_clan_id_js_1 = require("../../middleware/parse-clan-id.js");
/**
 * Public-facing clan shape — strips the Discord token (a secret) before
 * sending to the client. Tokens are only ever set by the superadmin via
 * the dedicated PUT endpoint and never round-tripped to the browser.
 */
function publicClan(c) {
    const { discordToken, ...rest } = c;
    return { ...rest, discordTokenSet: discordToken.length > 0 };
}
/**
 * Enriches the public clan with onboarding-state counts so the frontend
 * can hide the "Capture members" / "Run first scan" buttons once the
 * clan has any members or any scan history. `authenticated` is a quick
 * "has the operator ever signed this clan into Total Battle" indicator —
 * purely a presence check on the storage-state file. The `needsReauth`
 * flag, on the other hand, reflects the most recent scan attempt: the
 * auth-check phase flips it on when the saved cookies stop loading the
 * canvas and off again as soon as they load it, and the login bridge also
 * clears it when the operator saves a fresh session. So
 * `authenticated && !needsReauth` is the combined "everything's fine"
 * state the UI cares about.
 *
 * That the auth-check phase clears it is load-bearing, not a nicety: while
 * only the login bridge could, one transient failure (a canvas timing out
 * under memory pressure) pinned a clan to "Needs re-authentication" until
 * an operator manually re-signed in, no matter how many scans succeeded
 * afterwards.
 */
function publicClanWithCounts(c) {
    return {
        ...publicClan(c),
        memberCount: (0, member_repo_js_1.getMemberCount)(c.id),
        scanCount: (0, session_repo_js_1.getScanSessionCount)(c.id),
        authenticated: fs_1.default.existsSync((0, clan_paths_js_1.clanStorageStatePath)(c.id)),
    };
}
/**
 * Build a sub-router with the `:clanId` param handler pre-installed.
 * Express `router.param()` doesn't propagate from parent to mounted
 * sub-routers, so each sub-router that uses `:clanId` paths needs its
 * own. This helper centralises that one-liner.
 */
function createClanSubRouter() {
    const router = (0, express_1.Router)();
    router.param('clanId', parse_clan_id_js_1.parseClanIdParam);
    return router;
}
//# sourceMappingURL=_shared.js.map