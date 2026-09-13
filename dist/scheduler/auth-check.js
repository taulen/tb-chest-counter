"use strict";
// Auth-check phase of a scan cycle: navigate to the game, verify the
// stored session is still logged in, and (for non-headless mode) fall
// back to manual login if it isn't. If the browser target crashes
// during navigation we relaunch from the per-clan storage state +
// profile dir and try once more.
//
// Pulled out of ScanLoop so the orchestrator's runSingleScan stays
// readable. The auth phase has its own retry + crash-recovery shape
// that doesn't share much with the post-auth pipeline.
Object.defineProperty(exports, "__esModule", { value: true });
exports.performAuthCheck = performAuthCheck;
exports.relaunchBrowserSession = relaunchBrowserSession;
const launcher_js_1 = require("../browser/launcher.js");
const clan_paths_js_1 = require("../config/clan-paths.js");
const auth_js_1 = require("../browser/auth.js");
const game_url_js_1 = require("../config/game-url.js");
const logger_js_1 = require("../utils/logger.js");
const memory_snapshot_js_1 = require("../utils/memory-snapshot.js");
const clan_repo_js_1 = require("../data/repositories/clan-repo.js");
const bot_js_1 = require("../discord/bot.js");
const log = (0, logger_js_1.childLogger)('scanner');
/**
 * The saved session just proved it still works. Retire any outstanding
 * re-authentication flag, because this phase is the only thing in the app
 * that actually knows.
 *
 * This closes a one-way door. The flag used to be cleared solely by the
 * login bridge writing a fresh storage-state, so ONE bad cycle — a canvas
 * that timed out because the container was under memory pressure, not
 * because the cookies had expired — pinned the clan to "Needs
 * re-authentication" indefinitely, plus a Discord notice telling admins to
 * fix a login that was never broken. Every scan afterwards signed in fine
 * and said nothing.
 *
 * Only the 1 → 0 transition reports, so the healthy path is silent (and
 * write-free).
 */
function noteSessionHealthy(clanId) {
    const { recovered } = (0, clan_repo_js_1.clearClanNeedsReauth)(clanId);
    if (!recovered)
        return;
    log.info(`Clan #${clanId} no longer needs re-authentication — the saved session loaded the game on this ` +
        'cycle. Clearing the flag; whatever failed earlier was transient.');
    // Balances the earlier "login expired" ping. Without it an admin is left
    // chasing an alert for a problem that has already gone away.
    void (0, bot_js_1.postReauthResolvedNotice)(clanId).catch(() => { });
}
/**
 * Drive the auth phase. Returns once the session is verified logged in
 * (or a manual login completes), or after one failed crash+relaunch
 * attempt. Either way `ok: false` means "abort this clan's scan"; only
 * the genuine auth failures behind it flag the clan for re-authentication.
 */
async function performAuthCheck(ctx) {
    let { session } = ctx;
    let page = session.page;
    ctx.reportProgress('auth', 'Navigating to game and validating session...');
    for (let authAttempt = 1; authAttempt <= 2; authAttempt++) {
        try {
            await (0, auth_js_1.navigateToGame)(page, game_url_js_1.TB_GAME_URL);
            const loggedIn = await (0, auth_js_1.checkLoginStatus)(page);
            if (!loggedIn) {
                log.warn('Not logged in');
                if (!ctx.config.headless) {
                    await (0, auth_js_1.performManualLogin)(page, session.context, ctx.config);
                    noteSessionHealthy(ctx.clanId);
                    return { ok: true, session };
                }
                log.error('Cannot login in headless mode. Please run with HEADLESS=false first to authenticate.');
                return { ok: false, session };
            }
            noteSessionHealthy(ctx.clanId);
            return { ok: true, session };
        }
        catch (err) {
            const message = String(err instanceof Error ? err.message : err);
            const crashed = err instanceof auth_js_1.BrowserTargetCrashedError || (0, auth_js_1.isCrashLikeError)(err) || page.isClosed();
            if (crashed && authAttempt < 2) {
                session = await relaunchBrowserSession(ctx.config, session, ctx.clanId, message, ctx.reportProgress);
                page = session.page;
                continue;
            }
            if (crashed) {
                // The browser died twice — the renderer process was killed, or the
                // page was torn down under us. That says NOTHING about the saved TB
                // session, so this must not go anywhere near markClanNeedsReauth:
                // doing so told operators to refresh a login that was working
                // perfectly (and posted a Discord notice saying so), while the real
                // fault — the container losing a renderer, usually to the OOM
                // killer — went unnamed. Skip the clan and try again next cycle;
                // the memory reading is here because a crash is otherwise
                // undiagnosable after the fact (see utils/memory-snapshot.ts).
                const mem = (0, memory_snapshot_js_1.memorySnapshot)();
                log.error(`Clan #${ctx.clanId} scan aborted — the browser crashed twice while loading the game, ` +
                    `so the session could not be checked. This is a browser/host failure, NOT an expired ` +
                    `login: the saved session is untouched and the next cycle will retry. ${message}. ` +
                    `Memory at crash: ${mem.summary}` +
                    (mem.oomKills ? ' — the kernel HAS OOM-killed processes in this container.' : ''));
                ctx.reportProgress('auth', 'Browser crashed while loading the game; retrying on the next cycle.');
                return { ok: false, session };
            }
            if (ctx.config.headless) {
                // Both remaining branches (logged-out fast path and canvas-
                // stabilise timeout) mean the saved TB session is no longer
                // usable. markClanNeedsReauth returns firstTime=true only on the
                // 0→1 transition, so the Discord notice fires once per
                // failure streak instead of every cycle.
                const { firstTime } = (0, clan_repo_js_1.markClanNeedsReauth)(ctx.clanId);
                const cause = err instanceof auth_js_1.LoggedOutError
                    ? 'saved Total Battle session is logged out'
                    : 'saved Total Battle session cannot load the game canvas';
                const reason = `Clan #${ctx.clanId} needs re-authentication — ${cause}. Open Clans → Refresh login.`;
                log.error(reason);
                ctx.reportProgress('auth', 'Saved login expired — re-authenticate via Clans → Refresh login.');
                if (firstTime) {
                    // Fire and forget — Discord delivery shouldn't block the
                    // scanner moving on to the next clan.
                    void (0, bot_js_1.postReauthRequiredNotice)(ctx.clanId).catch(() => { });
                }
                return { ok: false, session };
            }
            // Non-headless mode can continue to manual login fallback.
            log.warn('Failed to navigate to game: ' + message);
            ctx.reportProgress('auth', `Game did not load correctly: ${message}`);
            await (0, auth_js_1.performManualLogin)(page, session.context, ctx.config);
            noteSessionHealthy(ctx.clanId);
            return { ok: true, session };
        }
    }
    // Loop exits on return; falling out means both attempts failed without
    // throwing, which can't happen given the structure above. Guard so the
    // type checker is happy.
    return { ok: false, session };
}
/**
 * Close the (likely-crashed) browser and launch a fresh one from the
 * active clan's storage state + per-clan profile dir. Surfaces a
 * progress message so the admin UI shows something other than a stale
 * "validating session..." while the relaunch proceeds.
 *
 * Exported because the orchestrator still calls this directly when the
 * clan-switch path needs to swap browsers between iterations of a
 * multi-clan rotation; the auth-check loop above also uses it on a
 * crash mid-attempt.
 */
async function relaunchBrowserSession(config, session, clanId, reason, reportProgress) {
    // Sample memory before the relaunch frees anything. A renderer death is
    // almost always the cgroup OOM killer choosing the biggest process in the
    // container, and this is the first line an operator sees when it happens.
    const mem = (0, memory_snapshot_js_1.memorySnapshot)();
    log.warn(`Relaunching browser session after crash: ${reason} [${mem.summary}]`);
    reportProgress('auth', 'Browser target crashed; relaunching session and retrying auth...');
    try {
        await (0, launcher_js_1.closeBrowser)(session);
    }
    catch {
        // Ignore close errors; target is already unstable.
    }
    // Per-clan: hydrate from the active clan's storage state AND its own
    // userDataDir so cookies / localStorage / IndexedDB / service workers
    // never leak between clans. Single-clan deployments stay on clan #1
    // which ends up at the same effective paths as the legacy single
    // location after migrateLegacyClanFiles.
    return (0, launcher_js_1.launchBrowser)(config, {
        storageStatePath: (0, clan_paths_js_1.clanStorageStatePath)(clanId),
        userDataDir: (0, clan_paths_js_1.clanBrowserProfileDir)(clanId),
    });
}
//# sourceMappingURL=auth-check.js.map