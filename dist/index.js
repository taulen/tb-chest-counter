"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("./config/index.js");
const logger_js_1 = require("./utils/logger.js");
const database_js_1 = require("./data/database.js");
const loop_js_1 = require("./scheduler/loop.js");
const external_loop_js_1 = require("./scheduler/external-loop.js");
const server_js_1 = require("./web/server.js");
const bot_js_1 = require("./discord/bot.js");
const console_report_js_1 = require("./output/console-report.js");
const setup_wizard_js_1 = require("./setup-wizard.js");
const defaults_js_1 = require("./config/defaults.js");
const build_info_js_1 = require("./utils/build-info.js");
const store_js_1 = require("./game-art/store.js");
/**
 * Two-line startup banner sized to fit whichever of the title /
 * build-info subtitle is wider. The subtitle pulls from BUILD_INFO so
 * the line updates automatically with each rebuild — date for "is this
 * recent", fingerprint for "did the rebuilt image pick up my commit".
 */
function printStartupBanner() {
    const title = 'TB CHEST COUNTER';
    const buildDate = build_info_js_1.BUILD_INFO.builtAt.slice(0, 10);
    const subtitle = `build ${buildDate} · ${build_info_js_1.BUILD_INFO.fingerprint}`;
    const innerWidth = Math.max(title.length, subtitle.length) + 6;
    const horiz = '═'.repeat(innerWidth);
    const center = (s) => {
        const pad = innerWidth - s.length;
        const left = Math.floor(pad / 2);
        return ' '.repeat(left) + s + ' '.repeat(pad - left);
    };
    console.log('');
    console.log('  ╔' + horiz + '╗');
    console.log('  ║' + center(title) + '║');
    console.log('  ║' + center(subtitle) + '║');
    console.log('  ╚' + horiz + '╝');
    console.log('');
}
async function main() {
    printStartupBanner();
    // If first-run setup is needed, serve the setup wizard and wait for it to
    // complete before continuing with normal startup. This way the main scan
    // loop launches automatically right after setup — no restart required.
    if ((0, setup_wizard_js_1.needsSetup)()) {
        console.log('  No configuration found. Starting web setup at /setup ...\n');
        const { waitForSetupComplete } = await import('./web/routes/setup.js');
        const setupServer = (0, server_js_1.startWebServer)(defaults_js_1.DEFAULT_CONFIG.webPort, undefined, { setupMode: true });
        try {
            await waitForSetupComplete();
        }
        catch (err) {
            console.error('  Setup failed:', String(err));
            process.exit(1);
        }
        // Close the setup-mode HTTP server; normal-mode server starts below.
        await new Promise((resolve) => setupServer.close(() => resolve()));
        console.log('  Setup complete! Starting normal scan mode...\n');
    }
    // Load configuration
    const config = (0, index_js_1.loadConfig)();
    const log = (0, logger_js_1.createLogger)(config.logLevel);
    const dashboardOnly = process.argv.includes('--dashboard-only');
    log.info('Starting TB Chest Counter...');
    // Initialize database. As of migration v27, the previously-separate
    // chesttracker.db is folded into this same file — its tables are
    // created here and any existing sibling file gets absorbed during
    // migration, so no second open() is needed.
    (0, database_js_1.initDatabase)(config.dbPath);
    // Mark any leftover PENDING scan sessions from previous runs as FAILED.
    // These are from scans interrupted by container restarts / crashes.
    const sessionRepo = await import('./data/repositories/session-repo.js');
    const staleCount = sessionRepo.failStalePendingSessions();
    if (staleCount > 0) {
        log.warn(`Marked ${staleCount} stale pending scan session(s) as failed`);
    }
    // One-time repair (Nov 17 2026): SK7 scanned with SIK's login. REMOVE once it
    // has run on prod; a no-op on any other database and after it ran once.
    try {
        const { repairWrongAccountScan } = await import('./data/repair-wrong-account-2026-11-17.js');
        const { getDb } = await import('./data/database.js');
        repairWrongAccountScan(getDb());
    }
    catch (err) {
        log.error(`Wrong-account repair failed (nothing changed): ${String(err)}`);
    }
    // Ensure at least one super admin exists. The web /setup flow normally
    // creates this during first-run setup; if we land here with zero users
    // it means the env file exists but the database was wiped or never had
    // an admin written to it (rare — typically a partial restore from
    // backup). The legacy CLI wizard that handled this case has been
    // retired in favour of the web flow, so the safe answer is to fail
    // loud with actionable instructions instead of silently dropping the
    // operator into a half-set-up state.
    const { userCount, cleanExpiredSessions } = await import('./data/repositories/user-repo.js');
    cleanExpiredSessions();
    setInterval(cleanExpiredSessions, 60 * 60 * 1000);
    if (userCount() === 0) {
        throw new Error('No super admin user found in the database, but config exists. ' +
            'Either restore a database backup that contains the admin account, ' +
            'or delete data/app.env (and .env if present) so the web /setup flow ' +
            'runs again on next startup to create one.');
    }
    // Start the chesttracker.com ingest loop early so it runs in all modes
    // (including --dashboard-only). It's entirely independent of the scanner
    // and the Discord bot, and no-ops if no share code is configured.
    const externalLoop = new external_loop_js_1.MultiClanExternalLoop();
    externalLoop.start();
    // Game art from the game's CDN: checked 30 s after startup, then daily.
    // Non-blocking and never throws; a failed check keeps the served version.
    (0, store_js_1.startGameArtSchedule)();
    if (dashboardOnly) {
        // Dashboard-only mode: no scanning. startWebServer
        // already logs "Web dashboard running at http://localhost:..." so
        // we don't need a second "Dashboard: ..." line here.
        log.info('Dashboard-only mode');
        (0, server_js_1.startWebServer)(config.webPort, undefined, { externalLoop, externalUrl: config.webExternalUrl });
        return;
    }
    let scanLoop;
    try {
        scanLoop = new loop_js_1.ScanLoop(config, (result, clanId) => {
            // Called after each scan completes for one clan. Routes the report
            // to that clan's Discord bot — a no-op when the clan has Discord
            // disabled, no token, or the bot isn't yet running.
            (0, console_report_js_1.printScanReport)(result);
            (0, bot_js_1.postScanReport)(clanId, result).catch(() => { });
            // A daily digest held back at the rollover goes out now, once this
            // scan has collected the chests earned in the day's last minutes.
            (0, bot_js_1.onClanScanCompleted)(clanId).catch(() => { });
        });
        // Start web dashboard
        if (config.webEnabled) {
            (0, server_js_1.startWebServer)(config.webPort, scanLoop, { externalLoop, externalUrl: config.webExternalUrl });
        }
        // Start one Discord bot per clan that has Discord enabled.
        // Pre-multi-clan deployments seeded clan #1 with the existing
        // env-configured token+channel, so this preserves the prior single-
        // clan behavior automatically.
        await (0, bot_js_1.startAllClanBots)(config.gameDayRolloverUtcHour);
        // Start scanning
        await scanLoop.start();
        log.info('TB Chest Counter is running');
        // The web server itself already logged "Web dashboard running at
        // http://localhost:..." earlier in startup, so don't restate it.
    }
    catch (err) {
        log.error('Startup error: ' + String(err));
        process.exit(1);
    }
    // Graceful shutdown
    const shutdown = async () => {
        log.info('Shutting down...');
        scanLoop?.stop();
        externalLoop.stop();
        await (0, bot_js_1.stopAllBots)();
        (0, database_js_1.closeDb)();
        log.info('Goodbye!');
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map