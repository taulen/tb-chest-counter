"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.noteSessionHealthy = noteSessionHealthy;
exports.noteSessionLoggedOut = noteSessionLoggedOut;
/**
 * One place that decides what a clan's saved Total Battle login is worth.
 *
 * Two independent observers report into it:
 *   - the scan's auth check (auth-check.ts), which loads the game in a browser;
 *   - the browser-free session check (session-check.ts), one GET of the site
 *     page with the stored cookies, every 30 minutes and before each capture.
 *
 * Both must behave identically: a definite "logged out" flips the clan to
 * "Needs re-authentication" (System warning keyed for auto-resolve, one
 * Discord ping per streak); a definite "logged in" clears it and announces the
 * recovery once. Anything ambiguous (network error, odd page, browser crash)
 * must go through neither.
 */
const logger_js_1 = require("../utils/logger.js");
const clan_repo_js_1 = require("../data/repositories/clan-repo.js");
const bot_js_1 = require("../discord/bot.js");
const log = (0, logger_js_1.childLogger)('session-health');
/**
 * The saved session demonstrably works. Only the 1 → 0 transition reports, so
 * the healthy path is silent (and write-free).
 */
function noteSessionHealthy(clanId, how) {
    const { recovered } = (0, clan_repo_js_1.clearClanNeedsReauth)(clanId);
    if (!recovered)
        return;
    log.info(`Clan #${clanId} no longer needs re-authentication — ${how}. Clearing the flag.`);
    // Balances the earlier "login expired" ping.
    void (0, bot_js_1.postReauthResolvedNotice)(clanId).catch(() => { });
}
/**
 * The saved session is demonstrably unusable. The Discord notice fires once
 * per failure streak (markClanNeedsReauth reports only the 0 → 1 transition).
 */
function noteSessionLoggedOut(clanId, cause) {
    const { firstTime } = (0, clan_repo_js_1.markClanNeedsReauth)(clanId);
    const reason = `Clan #${clanId} needs re-authentication — ${cause}. Open Clans → Refresh login.`;
    // Keyed so the System page retires it once the flag clears.
    log.error({ resolveKey: (0, clan_repo_js_1.reauthWarningKey)(clanId) }, reason);
    if (firstTime)
        void (0, bot_js_1.postReauthRequiredNotice)(clanId).catch(() => { });
}
//# sourceMappingURL=session-health.js.map