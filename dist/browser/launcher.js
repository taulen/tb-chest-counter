"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.launchBrowser = launchBrowser;
exports.closeBrowser = closeBrowser;
const playwright_1 = require("playwright");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_js_1 = require("../utils/logger.js");
const viewport_js_1 = require("../config/viewport.js");
const gpu_js_1 = require("./gpu.js");
const profile_lock_js_1 = require("./profile-lock.js");
const game_timezone_js_1 = require("../config/game-timezone.js");
const log = (0, logger_js_1.childLogger)('browser');
// TB's server-side session lives in this httpOnly cookie. If it isn't
// present after hydration the game will redirect to the marketing /
// login page and the auth-check phase will (correctly) report the clan
// as logged out — so we surface its presence explicitly in the logs.
const TB_SESSION_COOKIE = 'PTBHSSID';
/**
 * Apply the saved cookies to the context. `addCookies` is atomic — if a
 * single cookie is malformed (a partitioned / `__Host-` Google cookie,
 * `SameSite=None` without `secure`, a bad `expires`, …) the WHOLE batch
 * is rejected and Playwright throws. That used to drop every cookie,
 * including TB's session, so one unrelated bad cookie left the scanner
 * logged out. We try the fast batch path first, then fall back to
 * applying cookies one-by-one so the maximum valid set survives and the
 * offending cookie is named in the logs instead of silently nuking auth.
 */
async function applyCookiesResilient(context, cookies) {
    try {
        await context.addCookies(cookies);
        return cookies.length;
    }
    catch (err) {
        log.warn(`Batch cookie hydration failed (${String(err)}); retrying cookie-by-cookie so one bad cookie can't drop the whole session.`);
    }
    let applied = 0;
    for (const cookie of cookies) {
        try {
            await context.addCookies([cookie]);
            applied++;
        }
        catch (err) {
            log.warn(`Skipping un-settable cookie ${cookie.name} (domain=${cookie.domain}): ${String(err)}`);
        }
    }
    return applied;
}
async function hydrateContextFromStorageState(context, storageStatePath) {
    if (!fs_1.default.existsSync(storageStatePath)) {
        log.debug(`No storage state found at ${storageStatePath}; continuing without cookie hydration.`);
        return;
    }
    let parsed;
    try {
        const raw = fs_1.default.readFileSync(storageStatePath, 'utf8').trim();
        if (!raw) {
            log.debug('Storage state file exists but is empty; skipping cookie hydration.');
            return;
        }
        parsed = JSON.parse(raw);
    }
    catch (err) {
        log.warn('Failed to read/parse storage state: ' + String(err));
        return;
    }
    const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
    if (cookies.length === 0) {
        log.debug('Storage state contains no cookies; skipping cookie hydration.');
    }
    else {
        const applied = await applyCookiesResilient(context, cookies);
        const hasSession = cookies.some((c) => c.name === TB_SESSION_COOKIE);
        log.debug(`Hydrated browser context with ${applied}/${cookies.length} cookies from storage state.`);
        if (!hasSession) {
            // Not fatal here — navigateToGame will report the logged-out page —
            // but logging it at the hydration boundary makes "the saved session
            // never had a TB session cookie" diagnosable without LOG_LEVEL=debug.
            log.warn(`Saved session has no ${TB_SESSION_COOKIE} cookie — the scanner will be treated as logged out. ` +
                `Re-authenticate via Clans → Refresh login and wait for the game to fully load before saving.`);
        }
        else if (applied < cookies.length) {
            log.warn(`Only ${applied}/${cookies.length} saved cookies could be applied; some may be malformed.`);
        }
    }
    // Restore localStorage too. The login bridge captures it (TB / Braze
    // keep state under the totalbattle.com origin), but a persistent
    // profile only carries it across its OWN runs — a freshly-provisioned
    // scanner profile starts empty. addInitScript runs at document_start on
    // every navigation; we seed each key only when absent so we hydrate a
    // cold profile on first load without ever clobbering the live values TB
    // writes during a session.
    await seedLocalStorageFromOrigins(context, parsed.origins ?? []);
}
async function seedLocalStorageFromOrigins(context, origins) {
    const withData = origins.filter((o) => Array.isArray(o.localStorage) && o.localStorage.length > 0);
    if (withData.length === 0)
        return;
    try {
        await context.addInitScript((seed) => {
            try {
                const here = window.location.origin;
                const match = seed.find((o) => o.origin === here);
                if (!match || !match.localStorage)
                    return;
                for (const { name, value } of match.localStorage) {
                    if (window.localStorage.getItem(name) === null) {
                        window.localStorage.setItem(name, value);
                    }
                }
            }
            catch {
                // localStorage can be unavailable (sandboxed frame); ignore.
            }
        }, withData);
        log.debug(`Registered localStorage seed for ${withData.length} origin(s): ${withData.map((o) => o.origin).join(', ')}`);
    }
    catch (err) {
        log.warn('Failed to register localStorage seed: ' + String(err));
    }
}
async function launchBrowser(config, options = {}) {
    log.debug(`Launching bundled Chromium (headless: ${config.headless})`);
    // Use a persistent profile directory so the browser looks like a real
    // user session — this avoids Google OAuth "insecure browser" blocks.
    // Multi-clan: the caller passes a per-clan dir so each clan has its
    // own cookies / localStorage / IndexedDB / service workers and
    // sequential clan scans never see each other's leftover state.
    const userDataDir = options.userDataDir
        ? path_1.default.resolve(options.userDataDir)
        : path_1.default.resolve('data', 'browser-profile');
    const browser = null;
    // GPU acceleration (opt-in via SCANNER_GPU). Renders the game's WebGL canvas
    // on a passed-through Intel iGPU instead of the CPU (SwiftShader), which is
    // the dominant CPU cost of a scan. The flag set, the env toggle and the
    // "did it actually engage" probe live in ./gpu.ts, shared with the login
    // bridge — see there for the validated recipe and why each flag is needed.
    // Off by default → unchanged headless-shell path.
    const gpuEnabled = (0, gpu_js_1.isGpuEnabled)();
    const baseArgs = [
        '--disable-blink-features=AutomationControlled',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
        // Critical for Docker: prevents Chromium exhausting /dev/shm (64MB default)
        '--disable-dev-shm-usage',
        // Memory reduction
        '--disk-cache-size=52428800', // 50 MB disk cache
        '--media-cache-size=52428800', // 50 MB media cache
        '--disable-extensions',
        '--disable-sync',
        '--disable-translate',
        '--no-first-run',
        '--mute-audio',
    ];
    const wantedTimezone = options.timezoneId?.trim()
        || (0, game_timezone_js_1.gameDayTimezoneId)(config.gameDayRolloverUtcHour);
    const launchOptions = {
        headless: config.headless,
        // `channel: 'chromium'` selects the full Chromium (new headless) needed for
        // GPU; undefined keeps the default (GPU-incapable) headless-shell path.
        channel: (0, gpu_js_1.gpuChannel)(),
        viewport: viewport_js_1.DEFAULT_VIEWPORT,
        locale: 'en-US',
        // A game client whose local midnight is the game's own reset, replacing an
        // arbitrary 'America/New_York' inherited from the initial deploy. Nothing
        // depends on it — the history list's day labels follow the game ACCOUNT's
        // clock, which no browser setting reaches — it is just the least surprising
        // default. See ../config/game-timezone.ts.
        timezoneId: wantedTimezone,
        args: gpuEnabled ? [...baseArgs, ...gpu_js_1.GPU_ARGS] : baseArgs,
    };
    // An unclean shutdown leaves Chromium's singleton locks in the profile dir,
    // and because the container hostname changes on every recreate Chromium
    // treats them as held by "another computer" and refuses to start — for good.
    // Clear the ones that provably can't be live first.
    (0, profile_lock_js_1.clearStaleProfileLocks)(userDataDir, log);
    const context = await playwright_1.chromium.launchPersistentContext(userDataDir, launchOptions);
    // Use existing page or create one
    const page = context.pages()[0] || await context.newPage();
    try {
        const viewport = page.viewportSize();
        const metrics = await page.evaluate(() => ({
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            outerWidth: window.outerWidth,
            outerHeight: window.outerHeight,
            screenWidth: window.screen.width,
            screenHeight: window.screen.height,
            devicePixelRatio: window.devicePixelRatio,
            userAgent: navigator.userAgent,
            timezoneOffsetMin: new Date().getTimezoneOffset(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }));
        log.debug(`Browser render metrics: viewport=${viewport?.width ?? 'n/a'}x${viewport?.height ?? 'n/a'}, inner=${metrics.innerWidth}x${metrics.innerHeight}, outer=${metrics.outerWidth}x${metrics.outerHeight}, screen=${metrics.screenWidth}x${metrics.screenHeight}, dpr=${metrics.devicePixelRatio}`);
        // Chromium fails soft on an override it doesn't like — it keeps the host
        // zone and says nothing — so say it here instead. noAlert: nothing depends
        // on this landing (see the pin above), but a browser silently on a different
        // clock than the one asked for is worth knowing about before it is the
        // explanation for something else. Compared as an OFFSET, not as a zone name,
        // because ICU is free to canonicalise the name it echoes back.
        const expectedOffset = (0, game_timezone_js_1.zoneOffsetMinutesBehindUtc)(wantedTimezone);
        if (metrics.timezoneOffsetMin !== expectedOffset) {
            log.warn({ noAlert: true }, `Browser timezone did not take: asked for ${wantedTimezone} (UTC`
                + `${-expectedOffset / 60 >= 0 ? '+' : ''}${-expectedOffset / 60}) but the page reports `
                + `${metrics.timeZone} (UTC${-metrics.timezoneOffsetMin / 60 >= 0 ? '+' : ''}`
                + `${-metrics.timezoneOffsetMin / 60}). Nothing reads the browser's clock, so this is not `
                + 'itself a fault — but it means the container is overriding what was asked for.');
        }
        else {
            log.debug(`Browser timezone: ${metrics.timeZone} (asked for ${wantedTimezone})`);
        }
    }
    catch (err) {
        log.warn('Could not read browser render metrics: ' + String(err));
    }
    // GPU mode: report the live WebGL renderer so the logs confirm the iGPU
    // engaged. Chromium fails soft — a misconfigured device/driver silently
    // drops to SwiftShader with no error — so this is the only reliable signal.
    //
    // The verdict is now kept, not just logged. It used to be discarded here, so
    // a relaunch that came up on SwiftShader — or on a GPU path broken badly
    // enough that context creation never completes — looked identical to a
    // healthy one, and the scanner committed to a 200+-click sweep either way.
    // That is the shape of the 2026-08-04 stall: a crash-relaunch at 10:47 into a
    // host that was OOM-killing Chromium's children, then five hours of ~310s
    // batches. A caller that knows can at least say so; scan-pipeline's
    // throughput guard is what actually stops the sweep.
    if (gpuEnabled) {
        const renderer = await (0, gpu_js_1.logWebglRenderer)(page, log);
        if (renderer === 'stalled' || renderer === 'software') {
            log.warn(`Scanner browser came up with WebGL "${renderer}" — every compositor flush and input ` +
                'acknowledgement now costs far more than the scan is budgeted for. Expect slow batches; ' +
                'the sweep abandons itself rather than crawling (see scan-pipeline.ts).');
        }
    }
    // Multi-clan: caller may override the storage-state path so the
    // outer scheduler can hydrate the browser with a specific clan's
    // cookies before each scan.
    await hydrateContextFromStorageState(context, options.storageStatePath ?? config.storageStatePath);
    log.debug('Browser session ready');
    return { browser, context, page };
}
async function closeBrowser(session) {
    try {
        await session.context.close();
        if (session.browser)
            await session.browser.close();
        log.debug('Browser closed');
    }
    catch (err) {
        const message = String(err instanceof Error ? err.message : err);
        // Playwright throws this when the context/browser was already torn
        // down (crash, prior close, parent process exit). Closing something
        // that's already closed is the goal we wanted anyway, so just log
        // it at debug level — no operator action is needed.
        if (message.includes('has been closed')) {
            log.debug('Browser was already closed: ' + message);
            return;
        }
        log.warn('Error closing browser: ' + message);
    }
}
//# sourceMappingURL=launcher.js.map