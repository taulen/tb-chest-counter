import type { BrowserContext, Page } from 'playwright';
import { childLogger } from '../utils/logger.js';
import type { AppConfig } from '../models/types.js';
import { TB_GAME_URL } from '../config/game-url.js';
import { randomDelay } from '../utils/human-delay.js';
import { keyPress } from './input.js';

const log = childLogger('auth');

export class BrowserTargetCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserTargetCrashedError';
  }
}

/**
 * Saved session is gone — the page rendered the public marketing /
 * login form instead of the game. Thrown by navigateToGame so the
 * auth-check phase can short-circuit instead of polling for 120s for
 * a canvas that will never appear. Treated identically to a canvas-
 * stabilise timeout (mark needs_reauth, post Discord), but distinct
 * so the log line can say "logged out" instead of "canvas didn't
 * load".
 */
export class LoggedOutError extends Error {
  constructor(snippet: string) {
    super(`Saved Total Battle session is logged out. snippet="${snippet}"`);
    this.name = 'LoggedOutError';
  }
}

// Substrings that only appear on TB's public marketing / login page.
// Both must combine with "no canvas in DOM" before we declare logged
// out — neither alone is a reliable signal, but TB's logged-in client
// always renders a canvas, so absence of canvas + presence of either
// string is essentially diagnostic.
const LOGGED_OUT_SIGNATURES = ['register or log in', 'sign up with'];

export function isCrashLikeError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return msg.includes('target crashed') || msg.includes('page crashed') || msg.includes('has been closed');
}

export async function navigateToGame(page: Page, gameUrl: string): Promise<void> {
  // Always do a fresh navigation to free accumulated RAM and pick up
  // session changes (e.g. login from another device).
  log.info(`Navigating to ${gameUrl}`);
  await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  // Fast-path detection for an expired session. Without this we'd sit
  // through the full 60s canvas-selector wait + 120s stabilisation
  // poll just to discover the cookies are gone — two minutes of
  // "Waiting for canvas..." log spam for a question we can answer in
  // ~1.5s by reading the page text.
  const loggedOut = await detectLoggedOutPage(page);
  if (loggedOut) {
    throw new LoggedOutError(loggedOut.snippet);
  }

  // Wait for the game canvas to appear (Unity WebGL takes time to load)
  log.info('Waiting for game canvas to appear...');
  try {
    await page.waitForSelector('canvas', { timeout: 60_000 });
    log.info('Canvas element found, waiting for game to fully render...');
  } catch {
    // 60s timeout is the soft ceiling for canvas appearance. The
    // subsequent stabilisation poll usually succeeds anyway, so this
    // path is informational rather than alarming.
    log.debug('Canvas not found within 60s, continuing anyway');
  }

  // Poll until the canvas has non-zero stable dimensions.
  // Unity WebGL resizes the canvas as it loads; once width/height stop
  // changing and are full-sized the game UI is interactive.
  const canvasReady = await waitForCanvasStable(page);
  if (!canvasReady) {
    const diag = await page.evaluate(() => {
      const title = document.title || '';
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      return { title, text };
    }).catch(() => ({ title: '', text: '' }));

    throw new Error(
      `Game canvas did not become ready. url=${page.url()} title="${diag.title}" snippet="${diag.text}"`,
    );
  }

  // Canvas stable ≠ ready to use: TB keeps streaming offer overlays in well after
  // the map first renders. This watches until the bottom nav bar is readable and
  // STAYS readable, pressing Escape only when something is actually covering it —
  // rather than the old fixed 24-30s sleep followed by twelve blind Escapes, which
  // cost ~45s on every navigation regardless of whether a popup ever appeared.
  log.info('Waiting for the game to become interactive...');
  await waitForInteractiveGame(page);
}

/**
 * Sample the page immediately after navigation to spot TB's public
 * marketing / login form. Returns the body-text snippet when the
 * page is unambiguously logged out, null otherwise. Conservative on
 * purpose: a positive verdict requires both "no `<canvas>` element in
 * the DOM" AND a known marketing-page substring, so a slow Cloudflare
 * challenge or a half-loaded game can never trip it.
 */
async function detectLoggedOutPage(page: Page): Promise<{ snippet: string } | null> {
  // Short settle so DOMContentLoaded -> SPA hydration has a chance to
  // either render the login modal or start mounting the canvas. 1.5s
  // is empirically enough for TB; any longer and we're not really
  // "fast path" anymore.
  await new Promise((r) => setTimeout(r, 1500));

  const sample = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const hasCanvas = document.querySelector('canvas') !== null;
    return { text, hasCanvas };
  }).catch(() => ({ text: '', hasCanvas: false }));

  if (sample.hasCanvas) return null;
  const lower = sample.text.toLowerCase();
  if (!LOGGED_OUT_SIGNATURES.some((s) => lower.includes(s))) return null;
  return { snippet: sample.text.slice(0, 240) };
}

/** Poll canvas dimensions until they are non-zero and stable for several consecutive checks. */
async function waitForCanvasStable(
  page: Page,
  { pollMs = 2_500, stableRequired = 4, timeoutMs = 120_000 } = {},
): Promise<boolean> {
  type CanvasDims = { w: number; h: number; total: number; visible: number };
  const probeTimeoutMs = 8_000;
  const maxTimedOutProbes = 3;

  const probeCanvasDims = async (): Promise<CanvasDims | null> => {
    const evalPromise = page.evaluate(():
      | { w: number; h: number; total: number; visible: number }
      | null => {
      const canvases = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[];
      if (!canvases.length) return null;

      const measured = canvases.map((c) => {
        const rect = c.getBoundingClientRect();
        const style = window.getComputedStyle(c);
        const isVisible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0;

        // Prefer actual render size, but fall back to CSS rect size during transitions.
        const w = Math.max(c.width || 0, Math.round(rect.width));
        const h = Math.max(c.height || 0, Math.round(rect.height));
        return { w, h, isVisible };
      });

      const visibleCanvases = measured.filter((m) => m.isVisible);
      const pool = visibleCanvases.length ? visibleCanvases : measured;
      const best = pool.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
      return { w: best.w, h: best.h, total: canvases.length, visible: visibleCanvases.length };
    });

    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), probeTimeoutMs);
    });

    return Promise.race([evalPromise, timeoutPromise]).catch((): null => null);
  };

  const deadline = Date.now() + timeoutMs;
  let lastW = 0;
  let lastH = 0;
  let stableCount = 0;
  let lastNoCanvasLogAt = 0;
  let lastGoodCanvasAt = 0;
  let hadFullSizeCanvas = false;
  let recoveredAfterDrop = false;
  let timedOutProbeCount = 0;

  while (Date.now() < deadline) {
    const probeStartedAt = Date.now();
    const dims = await probeCanvasDims();
    const probeElapsedMs = Date.now() - probeStartedAt;
    const probeTimedOut = probeElapsedMs >= probeTimeoutMs - 100;

    if (probeTimedOut) {
      timedOutProbeCount++;
      log.warn(
        `Canvas probe timed out after ${probeElapsedMs}ms (${timedOutProbeCount}/${maxTimedOutProbes}); renderer may be stalled`,
      );

      if (timedOutProbeCount >= maxTimedOutProbes) {
        throw new BrowserTargetCrashedError('Canvas probes repeatedly timed out; renderer appears hung');
      }
    } else {
      timedOutProbeCount = 0;
    }

    if (dims && dims.w > 100 && dims.h > 100) {
      lastGoodCanvasAt = Date.now();
      if (dims.w >= 1200 && dims.h >= 700) {
        hadFullSizeCanvas = true;
      }

      if (dims.w === lastW && dims.h === lastH) {
        stableCount++;
        log.info(
          `Canvas stable at ${dims.w}x${dims.h} (${stableCount}/${stableRequired}) canvases=${dims.total} visible=${dims.visible}`,
        );
        if (stableCount >= stableRequired) {
          log.info('Canvas dimensions stable — game appears fully loaded');
          return true;
        }
      } else {
        // Dimensions changed — still loading assets
        if (dims.w !== lastW || dims.h !== lastH) {
          log.info(
            `Canvas resizing: ${lastW}x${lastH} → ${dims.w}x${dims.h} canvases=${dims.total} visible=${dims.visible}`,
          );
        }
        stableCount = 1;
        lastW = dims.w;
        lastH = dims.h;
      }
    } else {
      const now = Date.now();
      if (hadFullSizeCanvas && stableCount >= 2 && now - lastGoodCanvasAt > 20_000) {
        log.warn('Canvas disappeared after appearing full-size; continuing with cautious fallback');
        return true;
      }

      if (hadFullSizeCanvas && stableCount >= 2 && now - lastGoodCanvasAt <= 20_000) {
        if (!recoveredAfterDrop) {
          log.info('Canvas temporarily unavailable after partial stabilisation, waiting for recovery...');
          recoveredAfterDrop = true;
        }
      } else {
        stableCount = 0;
      }

      if (now - lastNoCanvasLogAt >= 10_000) {
        // Debug rather than info — most "no canvas yet" loops are
        // either the early-bail-caught logged-out case (now short-
        // circuited) or a transient hiccup that resolves within a
        // few seconds. Repeating it every 10s for two minutes filled
        // the operator log with no actionable content. The
        // "Canvas resizing X→Y" line above stays at info so genuine
        // slow-load cases still show progress.
        log.debug('Waiting for canvas to initialise...');
        lastNoCanvasLogAt = now;
      }
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  // Caller (navigateToGame) throws a richer error with URL/title/snippet
  // diagnostics when this returns false, and the auth-check phase logs a
  // single consolidated message describing the user-facing remediation.
  // Logging here too would just produce a duplicate warning for the same
  // failure.
  return false;
}

/**
 * Bottom-nav labels that are only on screen when nothing is covering the game.
 *
 * The positive signal for "the UI is usable". A negative test ("no popup text
 * found") cannot work here: with nothing in the way, full-page OCR of a game canvas
 * returns near-garbage, which is indistinguishable from an overlay the classifier
 * doesn't recognise. These words, by contrast, are present on the city and world
 * views and are covered by every offer overlay observed so far.
 */
const NAV_LABELS = [
  'quests', 'forge', 'journal', 'army', 'clan', 'academy', 'rankings', 'items', 'city', 'map',
];

/** How many of those labels must be readable to call the screen clear. Two, not
 *  one: 'clan' and 'city' are short enough to turn up in OCR noise by accident. */
const NAV_LABELS_NEEDED = 2;

/**
 * True when the bottom nav strip is readable, i.e. nothing is covering the game.
 *
 * Crops the bottom of the canvas rather than OCR'ing the whole page: that strip is
 * where the labels are, and a small crop is both much faster and far less noisy
 * than a full-page read of a rendered game.
 */
async function isGameChromeVisible(page: Page): Promise<boolean | null> {
  try {
    const [{ captureFullPage }, sharpMod, { getPaddleOcr }] = await Promise.all([
      import('./screenshotter.js'),
      import('sharp'),
      import('../vision/paddle-service.js'),
    ]);
    const sharp = sharpMod.default;
    const shot = await captureFullPage(page);
    const meta = await sharp(shot).metadata();
    const width = meta.width ?? 1920;
    const height = meta.height ?? 1080;
    const { data, info } = await sharp(shot)
      .extract({
        left: 0,
        top: Math.round(height * 0.86),
        width,
        height: height - Math.round(height * 0.86),
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ocr = await getPaddleOcr();
    const results = await ocr.recognize({
      width: info.width,
      height: info.height,
      data: new Uint8Array(data),
    });
    const text = results.map((r) => r.text).join(' ').toLowerCase();
    const hits = NAV_LABELS.filter((label) => text.includes(label));
    log.debug(`Game-chrome probe found ${hits.length} nav label(s): ${hits.join(', ')}`);
    return hits.length >= NAV_LABELS_NEEDED;
  } catch (err) {
    // Probe unavailable (models missing, page mid-navigation). Returning null makes
    // the caller fall back to the old fixed-duration behaviour rather than guess.
    log.debug(`Game-chrome probe failed: ${String(err instanceof Error ? err.message : err)}`);
    return null;
  }
}

/**
 * Get the game to a state where the UI is actually usable, then return.
 *
 * Replaces "sleep 24-30s, then press Escape twelve times and hope". Both halves of
 * that were guesses: the sleep was sized to outlast late-arriving offer overlays,
 * and the twelve presses to outnumber them. Together they cost ~45s on EVERY
 * navigation — every scan, member capture, might capture and calibration — whether
 * or not a single popup was ever shown.
 *
 * This instead looks, presses Escape only when something is in the way, and looks
 * again. Two things stop that from being naively faster-but-worse:
 *
 *   - It requires the screen to stay clear across `CLEAR_PROBES_NEEDED` probes
 *     spanning at least MIN_SETTLE_MS. TB streams overlays in well after the canvas
 *     first renders, so a single clean look proves nothing — this is what the old
 *     blind sleep was really buying, and it has to be preserved.
 *   - It is capped at the old worst case, so it can never be slower than the code
 *     it replaces, and it falls back to that code's behaviour if the probe is
 *     unavailable.
 *
 * The common case — no popups, or popups that close on the first Escape — now
 * finishes in a few seconds instead of forty-five.
 */
const MIN_SETTLE_MS = 6_000;
const CLEAR_PROBES_NEEDED = 3;
const MAX_READY_WAIT_MS = 45_000;

export async function waitForInteractiveGame(page: Page): Promise<void> {
  const startedAt = Date.now();
  let clearProbes = 0;
  let escapes = 0;
  let firstClearAt = 0;

  while (Date.now() - startedAt < MAX_READY_WAIT_MS) {
    if (page.isClosed()) return;

    const visible = await isGameChromeVisible(page);
    if (visible === null) {
      log.info(
        'Game-readiness probe unavailable; falling back to the fixed wait + Escape sequence.',
      );
      await randomDelay(24_000, 30_000);
      await dismissPopups(page);
      return;
    }

    if (visible) {
      clearProbes++;
      if (!firstClearAt) firstClearAt = Date.now();
      const settled = Date.now() - firstClearAt;
      if (clearProbes >= CLEAR_PROBES_NEEDED && settled >= MIN_SETTLE_MS) {
        log.info(
          `Game is interactive after ${Math.round((Date.now() - startedAt) / 1000)}s `
          + `(${escapes} Escape(s) needed) — nav bar has been clear for ${Math.round(settled / 1000)}s.`,
        );
        return;
      }
    } else {
      // Something is covering the game. Reset the streak: a popup arriving after a
      // clear look is exactly the late-arrival case, and the settle window has to
      // start again from here.
      clearProbes = 0;
      firstClearAt = 0;
      escapes++;
      await keyPress(page, 'Escape').catch(() => {});
      log.debug(`Game chrome hidden — pressed Escape (${escapes} so far).`);
    }

    await randomDelay(1_500, 2_200);
  }

  // Cap reached with the screen never staying clear. Not fatal on its own: the
  // caller's own verification (card-crop checks, screen-state classification) is
  // what actually gates the work, and this is deliberately no worse than the fixed
  // wait it replaced.
  log.warn(
    { noAlert: true },
    `Game did not settle into a clear, interactive state within ${MAX_READY_WAIT_MS / 1000}s `
    + `(${escapes} Escape(s) pressed). Continuing anyway — the caller verifies the screen it needs `
    + 'before reading anything.',
  );
}

/**
 * How long to sit on about:blank before loading the game again, giving the
 * game server time to process the old connection's close.
 */
const SOCKET_DRAIN_MS = 3_000;

/**
 * Reload the game the long way round: park on about:blank, let the old
 * connection die, then navigate in fresh.
 *
 * Both recovery paths that reload (navigator's third navigation attempt,
 * member-capture's last resort) exist for the same reason — a store/offer
 * popup Escape cannot close — and both used to go straight from the live game
 * to a fresh load of it. That is the one move in this codebase that can make
 * the game think the account signed in twice.
 *
 * The 2026-09-15 clan #2 cycle is the case in point, and the sequence is
 * legible in the log:
 *   17:44:53  game loads
 *   17:45:39  never settles — 45s, 13 Escapes (healthy is ~18s, 2)
 *   17:46:12  the crop shows a "PHARAOH'S VALUE BAZAAR" offer panel
 *   17:46:19  navigation has failed twice; recovery reload fires
 *   17:47:02  "Connection lost / Someone has logged into your account from
 *             another device. Would you like to reconnect?"
 * That was the only reload in the whole day's log, and the only kick. Three
 * other navigations that day loaded in 18-20s and never went near this path.
 *
 * The mechanism is a hypothesis, not something we can observe from outside:
 * the reloaded client authenticates before the server has finished tearing
 * down the socket the unloading document held, so it counts as a second
 * concurrent login and the newcomer gets offered the session back. about:blank
 * plus a drain window makes the disconnect unambiguous and puts a clear gap
 * between the two logins.
 *
 * Cheap insurance either way: this only runs on a path that has already
 * failed twice and is committed to costing tens of seconds. If a kick still
 * follows a reload after this, the hypothesis was wrong and the cause is
 * outside the app — the SESSION_KICKED detection in navigator.ts now aborts
 * the scan cleanly and names it in the log, so the next occurrence says so
 * instead of inventing a chest.
 */
export async function reloadGameCleanly(page: Page, gameUrl: string): Promise<void> {
  try {
    await page.goto('about:blank', { waitUntil: 'load', timeout: 15_000 });
    await randomDelay(SOCKET_DRAIN_MS, SOCKET_DRAIN_MS + 1_000);
  } catch (err) {
    // Not worth abandoning the reload over — the fresh navigation below is
    // still strictly better than repeating the clicks that just failed.
    log.debug(`about:blank teardown before reload failed: ${(err as Error).message}`);
  }
  await navigateToGame(page, gameUrl);
  await waitForInteractiveGame(page);
}

export async function dismissPopups(page: Page, maxAttempts: number = 12): Promise<void> {
  // Use Escape key only - clicking coordinates risks hitting game tiles
  for (let i = 0; i < maxAttempts; i++) {
    if (page.isClosed()) {
      log.warn('Page closed during popup dismissal; stopping Escape attempts.');
      break;
    }

    try {
      await keyPress(page, 'Escape');
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      if (isCrashLikeError(err)) {
        log.warn(`Escape press interrupted by browser target crash/close (attempt ${i + 1}/${maxAttempts}): ${message}`);
        break;
      }

      // Non-fatal: continue with remaining attempts.
      log.warn(`Escape press failed (attempt ${i + 1}/${maxAttempts}): ${message}`);
    }

    await randomDelay(800, 1500);
  }
  log.info('Popup dismissal complete');
  // Brief settle for any remaining fade animations
  await randomDelay(2_000, 3_000);
  log.info('UI settle complete');
}

export async function performManualLogin(
  page: Page,
  _context: BrowserContext,
  config: AppConfig,
): Promise<boolean> {
  log.info('Manual login required. Opening browser for you to log in...');
  console.log('\n========================================');
  console.log('  MANUAL LOGIN REQUIRED');
  console.log('========================================');
  console.log('A browser window has opened with Total Battle.');
  console.log('Please log in to your account manually.');
  console.log('Once you are in the game, press Enter here to continue...');
  console.log('========================================');
  console.log('Your session is saved automatically via the browser profile.');
  console.log('========================================\n');

  await navigateToGame(page, TB_GAME_URL);

  // Wait for user to press Enter
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  log.info('Login session captured via persistent browser profile');
  return true;
}

export async function checkLoginStatus(page: Page): Promise<boolean> {
  if (page.isClosed()) {
    throw new BrowserTargetCrashedError('Page closed before login status check');
  }

  // Check if we can see game canvas (indicates we're logged in)
  try {
    const canvas = await page.$('canvas');
    if (canvas) {
      log.info('Game canvas found - appears to be logged in');
      return true;
    }

    // Check for common login form elements
    const loginForm = await page.$('input[type="password"], .login-form, #login, .auth-form');
    if (loginForm) {
      log.info('Login form detected - not logged in');
      return false;
    }

    // Cloudflare/challenge/login interstitial pages can contain game-like URLs,
    // so do not treat URL alone as authenticated.
    const bodyText = await page.evaluate(() => (document.body?.innerText || '').toLowerCase()).catch(() => '');
    if (bodyText.includes('checking your browser') || bodyText.includes('just a moment')) {
      // First-load Cloudflare/CAPTCHA pages are expected on a cold
      // start. The auth flow handles this by waiting / re-checking;
      // raising it as a warning treats a normal startup as a problem.
      log.info('Challenge/interstitial detected - not logged in yet');
      return false;
    }

    log.warn('Unable to determine login status definitively');
    return false;
  } catch (err) {
    if (isCrashLikeError(err) || page.isClosed()) {
      const message = String(err instanceof Error ? err.message : err);
      log.warn('Login status check interrupted by target crash/close: ' + message);
      throw new BrowserTargetCrashedError(message);
    }

    log.error('Error checking login status: ' + String(err));
    return false;
  }
}
