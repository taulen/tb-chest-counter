import { loadConfig } from './config/index.js';
import { createLogger } from './utils/logger.js';
import { initDatabase, closeDb } from './data/database.js';
import { createVisionProvider } from './vision/factory.js';
import { launchBrowser, closeBrowser, type BrowserSession } from './browser/launcher.js';
import { ScanLoop } from './scheduler/loop.js';
import { MultiClanExternalLoop } from './scheduler/external-loop.js';
import { startInactiveSweep, stopInactiveSweep } from './scheduler/inactive-sweep.js';
import { startWebServer } from './web/server.js';
import {
  startAllClanBots,
  stopAllBots as stopAllDiscordBots,
  postScanReport,
} from './discord/bot.js';
import { printScanReport } from './output/console-report.js';
import { cleanOldScreenshots } from './browser/screenshotter.js';
import { needsSetup } from './setup-wizard.js';
import { DEFAULT_CONFIG } from './config/defaults.js';
import { clanStorageStatePath, clanBrowserProfileDir } from './config/clan-paths.js';
import { BUILD_INFO } from './utils/build-info.js';

/**
 * Two-line startup banner sized to fit whichever of the title /
 * build-info subtitle is wider. The subtitle pulls from BUILD_INFO so
 * the line updates automatically with each rebuild — date for "is this
 * recent", fingerprint for "did the rebuilt image pick up my commit".
 */
function printStartupBanner(): void {
  const title = 'TB CHEST COUNTER';
  const buildDate = BUILD_INFO.builtAt.slice(0, 10);
  const subtitle = `build ${buildDate} · ${BUILD_INFO.fingerprint}`;
  const innerWidth = Math.max(title.length, subtitle.length) + 6;
  const horiz = '═'.repeat(innerWidth);
  const center = (s: string): string => {
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

async function main(): Promise<void> {
  printStartupBanner();

  // If first-run setup is needed, serve the setup wizard and wait for it to
  // complete before continuing with normal startup. This way the main scan
  // loop launches automatically right after setup — no restart required.
  if (needsSetup()) {
    console.log('  No configuration found. Starting web setup at /setup ...\n');
    const { waitForSetupComplete } = await import('./web/routes/setup.js');
    const setupServer = startWebServer(DEFAULT_CONFIG.webPort, undefined, { setupMode: true });
    try {
      await waitForSetupComplete();
    } catch (err) {
      console.error('  Setup failed:', String(err));
      process.exit(1);
    }
    // Close the setup-mode HTTP server; normal-mode server starts below.
    await new Promise<void>((resolve) => setupServer.close(() => resolve()));
    console.log('  Setup complete! Starting normal scan mode...\n');
  }

  // Load configuration
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  const dashboardOnly = process.argv.includes('--dashboard-only');

  log.info('Starting TB Chest Counter...');

  // Initialize database. As of migration v27, the previously-separate
  // chesttracker.db is folded into this same file — its tables are
  // created here and any existing sibling file gets absorbed during
  // migration, so no second open() is needed.
  initDatabase(config.dbPath);

  // Mark any leftover PENDING scan sessions from previous runs as FAILED.
  // These are from scans interrupted by container restarts / crashes.
  const sessionRepo = await import('./data/repositories/session-repo.js');
  const staleCount = sessionRepo.failStalePendingSessions();
  if (staleCount > 0) {
    log.warn(`Marked ${staleCount} stale pending scan session(s) as failed`);
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
    throw new Error(
      'No super admin user found in the database, but config exists. ' +
      'Either restore a database backup that contains the admin account, ' +
      'or delete data/app.env (and .env if present) so the web /setup flow ' +
      'runs again on next startup to create one.',
    );
  }

  // Start the chesttracker.com ingest loop early so it runs in all modes
  // (including --dashboard-only). It's entirely independent of the scanner
  // and the Discord bot, and no-ops if no share code is configured.
  const externalLoop = new MultiClanExternalLoop();
  externalLoop.start();

  if (dashboardOnly) {
    // Dashboard-only mode: no browser, no scanning. startWebServer
    // already logs "Web dashboard running at http://localhost:..." so
    // we don't need a second "Dashboard: ..." line here.
    log.info('Dashboard-only mode');
    startWebServer(config.webPort, undefined, { externalLoop, externalUrl: config.webExternalUrl });
    return;
  }

  // Spin up the local OCR pipeline (PaddleOCR — PP-OCRv6_small via ONNX).
  // Member-list capture (member-capture.ts) uses the same shared service.
  const vision = createVisionProvider();
  await vision.initialize(config);

  // Clean old screenshots
  await cleanOldScreenshots('./data/screenshots', config.screenshotRetentionDays);

  // Launch browser
  let browserSession: BrowserSession | undefined;
  let scanLoop: ScanLoop | undefined;

  try {
    // Boot launch hydrates from clan #1's per-clan paths. The first
    // scheduled scan will iterate active clans and re-launch with the
    // matching clan's paths if there are more than one active.
    browserSession = await launchBrowser(config, {
      storageStatePath: clanStorageStatePath(1),
      userDataDir: clanBrowserProfileDir(1),
    });

    // Create scan loop
    scanLoop = new ScanLoop(config, browserSession, vision, (result, clanId) => {
      // Called after each scan completes for one clan. Routes the report
      // to that clan's Discord bot — a no-op when the clan has Discord
      // disabled, no token, or the bot isn't yet running.
      printScanReport(result);
      postScanReport(clanId, result).catch(() => {});
    });

    // Start web dashboard
    if (config.webEnabled) {
      startWebServer(config.webPort, scanLoop, { externalLoop, externalUrl: config.webExternalUrl });
    }

    // Start one Discord bot per clan that has Discord enabled.
    // Pre-multi-clan deployments seeded clan #1 with the existing
    // env-configured token+channel, so this preserves the prior single-
    // clan behavior automatically.
    await startAllClanBots(config.gameDayRolloverUtcHour);

    // Start the daily member-inactivity sweep (soft-removes members unseen
    // for config.memberInactivityDays days; returning players are auto-
    // reactivated on their next scan sighting via upsertMember).
    startInactiveSweep(config.gameDayRolloverUtcHour, config.memberInactivityDays);

    // Start scanning
    await scanLoop.start();

    log.info('TB Chest Counter is running');
    // The web server itself already logged "Web dashboard running at
    // http://localhost:..." earlier in startup, so don't restate it.

  } catch (err) {
    log.error('Startup error: ' + String(err));
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
    scanLoop?.stop();
    externalLoop.stop();
    stopInactiveSweep();
    if (browserSession) await closeBrowser(browserSession);
    if (vision.teardown) {
      try {
        await vision.teardown();
      } catch (err) {
        log.warn('Vision teardown during shutdown failed: ' + String(err));
      }
    }
    await stopAllDiscordBots();
    closeDb();
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
