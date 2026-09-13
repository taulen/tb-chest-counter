import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import type { WebSocket } from 'ws';
import { childLogger } from '../utils/logger.js';
import { logAction } from '../data/repositories/user-repo.js';
import { clearClanNeedsReauth } from '../data/repositories/clan-repo.js';

// Per-clan persistent profile + storage-state paths. Putting each clan
// under its own directory means scans can hot-swap which clan's auth is
// active without losing the other clans' Total Battle / Google sign-ins.
import { clanLoginProfileDir, clanStorageStatePath } from '../config/clan-paths.js';
import { TB_GAME_URL } from '../config/game-url.js';
import { getConfig } from '../config/index.js';
import { gameDayTimezoneId } from '../config/game-timezone.js';
import { tryStartXvfb, stopXvfb, type XvfbHandle } from './login-bridge/xvfb.js';
import {
  dispatchClientMessage,
  flushRelayWarnings,
  isTargetGoneError,
  parseClientMessage,
} from './login-bridge/relay.js';
import { flushScreencastWarnings, startScreencast } from './login-bridge/screencast.js';
import { settleWithDeadline, withDeadline } from '../utils/deadline.js';
import {
  CONSERVATIVE_STEP,
  initialStreamStep,
  isStreamProfileForced,
  ladderStep,
  STREAM_LADDER,
} from './login-bridge/link-quality.js';
import { measureSocketRtt } from './login-bridge/rtt.js';
import { GPU_ARGS, isBridgeGpuEnabled, logWebglRenderer } from '../browser/gpu.js';
import { clearStaleProfileLocks, killProfileOwner } from '../browser/profile-lock.js';

const log = childLogger('login-bridge');

// Streaming dimensions. The browser RENDERS at this size; the client scales
// the canvas to fit while preserving aspect ratio.
//
// Matters most when WebGL is on the CPU (GPU off, or LOGIN_BRIDGE_DISPLAY=xvfb):
// software rasterising is per-pixel work, so 960x600 is ~45% fewer pixels than
// 1280x800 and renders correspondingly faster, at the cost of a softer picture
// once the client scales it back up. Screencast quality/framerate tuning cannot
// substitute for this — it only affects frames the browser already drew.
//
// Override with LOGIN_BRIDGE_VIEWPORT=960x600. Default keeps 1280x800, which
// is the most readable for typing credentials into OAuth forms.
const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 800;

export function resolveBridgeViewport(raw: string | undefined): { width: number; height: number } {
  const m = (raw ?? '').trim().toLowerCase().match(/^(\d{3,4})\s*[x*]\s*(\d{3,4})$/);
  if (!m) return { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT };
  // Clamp: too small is unusable for reading a login form, too large defeats
  // the point and costs more than the default.
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    width: clamp(Number(m[1]), 640, 1920),
    height: clamp(Number(m[2]), 480, 1200),
  };
}

const { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } = resolveBridgeViewport(
  process.env.LOGIN_BRIDGE_VIEWPORT,
);

/**
 * How the bridge browser gets a display.
 *
 *   'headless' — Chromium's NEW headless mode (full browser, rendering
 *                offscreen). No display server at all. This is the modern
 *                replacement for the Xvfb trick and the ONLY mode where the
 *                iGPU works, because a hardware-backed surface comes from the
 *                render node rather than from a window.
 *   'xvfb'     — the old path: a headed browser on a virtual X display.
 *                Kept as an escape hatch; note Xvfb is a pure software
 *                framebuffer, so this mode can never be GPU-accelerated.
 *
 * The interactive bridge does NOT need a headed browser. What it needs is a
 * full-featured Chromium (hence channel: 'chromium' — NOT the feature-poor
 * headless-shell), CDP screencast, CDP input injection, and a persistent
 * profile. New headless provides all four.
 *
 * History, so this isn't re-litigated: the bridge originally went headed
 * because headless captured ~15 cookies instead of ~55 during Google OAuth
 * (1af9697, Apr 2026). That flow was abandoned — login is email+password —
 * and the cookie-count concern was retracted anyway (c431456, Jun 2026: only
 * PTBHSSID matters). "Headless" back then also meant headless-shell, a
 * genuinely degraded binary, which new headless is not.
 */
export type BridgeDisplay = 'headless' | 'xvfb';

export function resolveBridgeDisplay(raw: string | undefined): BridgeDisplay {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'xvfb' || v === 'headed') return 'xvfb';
  return 'headless';
}

// Safety caps. The bridge screencasts a live, continuously-animating game,
// so a session that nobody is actively driving is a real bandwidth + RAM
// leak (the headed game browser keeps running and, while a socket is
// attached, keeps streaming frames). These bound how long one can live.
//
//   IDLE_TEARDOWN_MS — socket closed and no client reattached → tear down.
//   MAX_SESSION_MS   — absolute cap; a client left connected (forgotten
//                      tab on another device) can otherwise stream forever.
const IDLE_TEARDOWN_MS = 3 * 60_000;
const MAX_SESSION_MS = 30 * 60_000;

// Skip a frame when this much data is already queued on the socket, i.e.
// roughly two un-drained frames. See sendFrame() for why dropping beats
// queueing for a live screencast.
const FRAME_BACKPRESSURE_BYTES = 512 * 1024;

// Cap on Chromium launch. Generous — a cold per-clan profile dir genuinely
// takes 30s+ — but bounded, so a browser that will never come up surfaces as
// an error the operator can read instead of a panel stuck on
// "Launching browser…" until they give up.
const BROWSER_LAUNCH_TIMEOUT_MS = 90_000;

// Deadlines on the lifecycle calls that take no timeout of their own. None of
// these can be allowed to hang: a teardown that never finishes used to leave
// the bridge permanently "active" (see teardown()).
//
//   TEARDOWN_STEP_TIMEOUT_MS  — stopping the screencast / detaching CDP. Both
//                               are single CDP round trips against a session
//                               we are about to throw away.
//   CONTEXT_CLOSE_TIMEOUT_MS  — closing the browser. Generous, because a
//                               healthy Chromium with a big persistent profile
//                               does flush to disk on the way out; past it we
//                               stop asking politely and SIGKILL.
//   LIVENESS_PROBE_TIMEOUT_MS — "is this browser still answering?" A live one
//                               answers in single-digit ms.
//   STORAGE_STATE_TIMEOUT_MS  — reading cookies out for the save. Longer than
//                               the probe because it serialises the whole
//                               profile's cookie jar.
const TEARDOWN_STEP_TIMEOUT_MS = 5_000;
const CONTEXT_CLOSE_TIMEOUT_MS = 15_000;
const LIVENESS_PROBE_TIMEOUT_MS = 10_000;
const STORAGE_STATE_TIMEOUT_MS = 20_000;

// Adaptive streaming. Every window we compare frames sent against frames
// dropped to backpressure and move at most one rung on the quality ladder.
// 2s is long enough to be a real sample at any framerate and short enough that
// a bad guess at connect time is corrected before the operator gives up on it.
const ADAPT_INTERVAL_MS = 2_000;
// Step down above this drop rate. Some dropping is healthy — it's how the
// stream tracks a link's real capacity — so this is well clear of zero.
const ADAPT_DOWN_DROP_RATE = 0.2;
// Step up only after this many consecutive drop-free windows, so we probe for
// headroom without oscillating on a link that is marginal at the better rung.
const ADAPT_UP_CLEAN_WINDOWS = 3;

/**
 * Coordinator for the in-app login bridge: spawns a virtual display +
 * persistent-profile Chromium, screencasts the page over a WebSocket
 * to the admin browser, relays input back, and saves the resulting
 * cookies as the per-clan storage-state.json.
 *
 * Lifecycle pieces (Xvfb, message relay, screencast) live in their own
 * sibling modules under `./login-bridge/`. This file owns the state
 * machine that ties them together.
 */
class LoginBridge {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private socket: WebSocket | null = null;
  private starting = false;
  private startedAt: number | null = null;
  private xvfb: XvfbHandle | null = null;
  /** Stop callback returned by startScreencast — null when the
   *  screencast isn't running. */
  private stopScreencast: (() => Promise<void>) | null = null;
  /** Fires when a socket has been closed and no client reattaches within
   *  IDLE_TEARDOWN_MS — tears down the whole bridge. Cleared when a socket
   *  (re)attaches or on teardown. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Absolute session cap armed in start(); tears down regardless of
   *  socket activity so a forgotten-but-connected tab can't stream forever. */
  private maxSessionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Clan currently being signed in to. Set on start(); reset on
   *  teardown. Each clan has its own profile dir + storage-state.json
   *  so switching clans never overwrites another clan's saved auth. */
  private activeClanId: number | null = null;
  /** True while teardown() is running. The context/page 'close' events we
   *  listen for fire during our OWN teardown too, so without this flag a
   *  normal save/cancel would report itself as an unexpected browser death
   *  and re-enter teardown. */
  private tearingDown = false;
  /** Latched once we've reported the browser dying unexpectedly, so the
   *  hundreds of input events still queued behind it produce one message. */
  private browserGone = false;
  /** Bumped once per browser we launch, and again on teardown. The death
   *  listeners capture the value current when they were wired and ignore
   *  events that don't match, which keeps two cases quiet: the context
   *  start() deliberately discards on the GPU-stall path, and the 'close'
   *  our own teardown provokes. */
  private launchGeneration = 0;
  /** Profile dir of the browser we currently hold. Kept separately from
   *  activeClanId because teardown clears its state up front and may still
   *  need to force-kill a wedged process afterwards. */
  private activeProfileDir: string | null = null;
  /** The browser start() has launched but not yet accepted as the session.
   *
   *  It exists so teardown can close a browser that never made it that far.
   *  Everything between the launch and the liveness gate can throw, and
   *  teardown could only ever close a browser it could SEE — so a failure in
   *  that window used to orphan the whole Chromium: no reference to it, still
   *  holding its memory, still holding the profile lock the next launch needs.
   *
   *  Deliberately not `this.context`: isActive() must stay false until the
   *  session is real, or the start route's "cancel anything lingering" step
   *  would tear down a session that is merely still starting. */
  private pendingContext: BrowserContext | null = null;
  /** Frames skipped because the socket was behind. Reported once at
   *  teardown — a high count means the link, not the browser, is the
   *  limit, which is exactly what you want to know when the stream felt
   *  choppy. Never logged per frame. */
  private droppedFrames = 0;
  /** Current rung on STREAM_LADDER (0 = best). */
  private streamStep = CONSERVATIVE_STEP;
  /** Frames sent / dropped within the current adaptation window. */
  private windowSent = 0;
  private windowDropped = 0;
  /** Consecutive clean windows, used to decide when to try a better rung. */
  private cleanWindows = 0;
  private adaptTimer: ReturnType<typeof setInterval> | null = null;
  /** Live screencast retune, from startScreencast(). */
  private setStreamProfile: ((quality: number, everyNthFrame: number) => Promise<void>) | null = null;
  /** Invoked at the end of every teardown so whoever paused a resource
   *  for this bridge (the scan loop) can resume it regardless of HOW the
   *  bridge ended. Wired once at server startup via setTeardownHook. */
  private onTeardown: (() => void) | null = null;

  /**
   * Register a callback fired after every teardown — explicit save/cancel,
   * the idle-teardown timer, the max-session cap, or a failed start().
   * The web server uses this to resume the scan loop it paused when the
   * bridge opened, so an abandoned login session (socket closed → idle
   * teardown) can no longer leave the scanner paused forever.
   */
  setTeardownHook(fn: () => void): void {
    this.onTeardown = fn;
  }

  isActive(): boolean {
    return this.context !== null;
  }

  /**
   * We hold a browser, but it is provably not usable any more.
   *
   * Deliberately NOT folded into isActive(): "active" has to keep meaning
   * "this bridge owns a browser", because that is what tells the caller a
   * teardown is still owed. Reporting a dead session as inactive would let
   * start() launch a second browser over the top of the first and orphan it.
   * So the distinction is: isActive() says whether we hold something,
   * isSessionDead() says whether it's worth holding.
   *
   * Every check here is synchronous and local — no round trip to a browser
   * that by definition might not answer.
   */
  private isSessionDead(): boolean {
    if (this.browserGone) return true;
    if (this.page?.isClosed()) return true;
    const browser = this.context?.browser();
    if (browser && !browser.isConnected()) return true;
    return false;
  }

  isSocketAttached(): boolean {
    return this.socket !== null && this.socket.readyState === 1; // OPEN
  }

  getActiveClanId(): number | null {
    return this.activeClanId;
  }

  async start(clanId: number = 1): Promise<{ width: number; height: number }> {
    if (this.starting) {
      throw new Error('Login session already active.');
    }
    if (this.isActive()) {
      // Reclaim rather than refuse. "Login session already active" was the
      // message an operator got for half an hour after the browser died on
      // its own, because the only thing that could clear a dead session was
      // the max-session cap or a container restart. If what we're holding
      // cannot serve anyone, it is not a reason to refuse a new session.
      if (!this.isSessionDead()) {
        throw new Error('Login session already active.');
      }
      log.warn('Previous login session is holding a dead browser — reclaiming it before starting a new one.');
      await this.teardown();
    }
    this.starting = true;
    this.activeClanId = clanId;
    this.browserGone = false;
    this.droppedFrames = 0;
    try {
      // Game URL is hardcoded to TB's domain — clan-switching happens
      // inside the game's canvas, not via different URLs. Per-clan
      // profile dirs + storage-state files keep each clan's account
      // isolated.
      const gameUrl = TB_GAME_URL;
      const profileDir = clanLoginProfileDir(clanId);
      const targetStorageState = clanStorageStatePath(clanId);
      this.activeProfileDir = profileDir;

      // Pick the display backend. Default is new headless — no X server, and
      // the only mode where WebGL can reach the iGPU. See BridgeDisplay.
      const display = resolveBridgeDisplay(process.env.LOGIN_BRIDGE_DISPLAY);
      log.info(
        `Login bridge rendering at ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT} ` +
          `(display: ${display === 'xvfb' ? 'Xvfb, software-only' : 'new headless'}).`,
      );

      let headed = false;
      if (display === 'xvfb') {
        this.xvfb = await tryStartXvfb(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        headed = this.xvfb !== null;
        if (!headed) {
          log.info('Xvfb unavailable; using new headless instead.');
        }
      }

      // Persistent profile so cookies, localStorage and IndexedDB carry across
      // uses. That's what keeps the account signed in between sessions, so an
      // admin opening the bridge to run a few actions lands in-game instead of
      // back at the login form.
      fs.mkdirSync(profileDir, { recursive: true });

      // iGPU offload. In new headless this is the same configuration the
      // scanner has been running on the iGPU for months, so it inherits
      // SCANNER_GPU by default. Under Xvfb it cannot work at all — a virtual
      // framebuffer has no hardware-backed surface — so don't even try, or
      // we'd pay the stall-then-relaunch detour on every session.
      let gpuEnabled = isBridgeGpuEnabled() && !headed;
      if (isBridgeGpuEnabled() && headed) {
        log.warn(
          'GPU rendering is requested but the display is Xvfb, which is a pure software ' +
            'framebuffer — running software-rendered. Use LOGIN_BRIDGE_DISPLAY=headless ' +
            '(the default) to render the game on the iGPU.',
        );
      }
      let context = await this.launchBridgeBrowser(profileDir, headed, gpuEnabled);
      let page = context.pages()[0] ?? (await context.newPage());

      if (gpuEnabled) {
        // Verify BEFORE navigating. Chromium fails soft — a misconfigured
        // device silently drops to SwiftShader with no error — and in the
        // worst case it doesn't fail at all: creating a WebGL context simply
        // never completes. Probing the blank start page is cheap and
        // time-boxed; probing after loading the game would mean a second
        // context on a page that already holds one, which is itself slow
        // enough to look like a hang.
        const status = await logWebglRenderer(page, log);
        if (status === 'stalled') {
          // This is exactly the state that presented as "stuck on launching
          // browser": the game is a WebGL app, so continuing would stall
          // identically for the whole navigation timeout. Throw the GPU
          // attempt away and relaunch software — slower, but it works, which
          // beats a session that never opens.
          log.warn(
            'Abandoning the GPU attempt for this login session and relaunching with ' +
              'software rendering. Set LOGIN_BRIDGE_GPU=0 to skip this detour on ' +
              'future sessions, and check /dev/dri passthrough plus the mesa/vulkan ' +
              'drivers — see docs/igpu-passthrough.md.',
          );
          // Bump the generation BEFORE closing, so the 'close' this provokes
          // is attributed to a superseded launch and not reported as the
          // session dying.
          this.launchGeneration++;
          const discarded = await settleWithDeadline(
            context.close(),
            CONTEXT_CLOSE_TIMEOUT_MS,
            'discarding the GPU attempt',
          );
          if (discarded === 'timeout') {
            // It must be gone, not merely abandoned: we are about to relaunch
            // into the SAME profile dir, and a live process still holding
            // SingletonLock is the one lock clearStaleProfileLocks refuses to
            // break — so the relaunch would fail with "profile in use".
            killProfileOwner(profileDir, log);
          }
          gpuEnabled = false;
          context = await this.launchBridgeBrowser(profileDir, headed, false);
          page = context.pages()[0] ?? (await context.newPage());
        }
      } else {
        log.info(
          'Login bridge is software-rendering the game. That is the main limit on ' +
            'bridge framerate — the screencast can only forward frames the browser ' +
            'already drew.',
        );
      }

      // Watch for the browser dying from HERE, not after the navigation.
      //
      // Loading the game is by far the likeliest moment for it to die — the
      // WebGL renderer is the biggest memory consumer in the container, so an
      // out-of-memory kill lands during exactly this window. Wiring the
      // listeners afterwards meant the events fired into nothing: Playwright
      // emits 'crash'/'close' once, at the moment it happens, so a listener
      // added later never hears about a page that is ALREADY dead. start()
      // then stored the corpse in this.context and returned success — leaving
      // a bridge that reported itself active, had no living browser behind it,
      // and could only be cleared by the 30-minute cap or a restart.
      const generation = this.watchForDeath(context, page);

      // First run: seed the persistent profile from this clan's existing
      // storage-state.json (if present). This brings over Google's "remember
      // me" cookies, TB's device cookies, etc., so the user sees the account
      // picker / one-click resume instead of a cold sign-in form.
      // Subsequent runs: cookies already live in the profile dir, so seeding
      // is a no-op overlay.
      //
      // Done after the GPU decision so a relaunch doesn't have to redo it.
      await this.hydrateFromStorageState(context, targetStorageState);

      // Patch window.open so OAuth providers (Google, Facebook) that
      // normally pop a new window navigate the same tab instead — keeps
      // the entire login flow inside the single page we are screencasting.
      await context.addInitScript(() => {
        const originalOpen = window.open;
        Object.defineProperty(window, 'open', {
          configurable: true,
          writable: true,
          value: function patchedOpen(url?: string | URL): Window | null {
            if (url) {
              window.location.href = String(url);
            }
            return null;
          },
        });
        // Mute "noisy" target=_blank anchors during login so OAuth lands in-tab.
        document.addEventListener(
          'click',
          (ev) => {
            const a = (ev.target as HTMLElement | null)?.closest?.('a[target=_blank]');
            if (a instanceof HTMLAnchorElement) {
              ev.preventDefault();
              window.location.href = a.href;
            }
          },
          true,
        );
        // Reference originalOpen so the linter doesn't complain about the
        // unused capture above; harmless in production.
        void originalOpen;
      });

      await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((err) => {
        // A slow game load is routine and stays at debug. The browser
        // vanishing mid-navigation is not — say so, because the liveness gate
        // below is about to refuse the session and the operator deserves the
        // cause next to the effect.
        if (isTargetGoneError(err)) {
          log.warn('The browser went away during the initial navigation: ' + String(err).split('\n')[0]);
        } else {
          log.debug('Initial navigation slow or failed: ' + String(err));
        }
      });

      // Someone tore this session down while it was still starting (a cancel
      // from the UI, or the death handler). Don't resurrect it.
      if (generation !== this.launchGeneration) {
        throw new Error('Login session was torn down while it was starting.');
      }

      // Refuse to declare a session active unless the browser is provably
      // still there. This is the backstop that makes the whole start path
      // safe: whatever went wrong above — a crash during the WebGL probe, the
      // cookie seeding, or the navigation — a dead or wedged browser fails
      // here and takes the normal error path, which tears down and reports a
      // real message. Previously any of those left an unusable session behind
      // that nevertheless answered "already active" to every retry.
      if (!(await this.confirmAlive(context, page))) {
        throw new Error(
          'The browser stopped responding while the login session was starting (most likely out of ' +
            'memory). Nothing has been left running — try again.',
        );
      }

      // Accepted: this is now the session, not a launch in progress.
      this.context = context;
      this.page = page;
      this.pendingContext = null;
      this.startedAt = Date.now();

      // Keep the client's URL bar in sync as the page navigates (OAuth
      // redirects, etc). Registered here rather than in attachSocket, which
      // runs again on every reconnect — that leaked a listener (and a
      // duplicate url message) per reattach.
      page.on('framenavigated', (frame) => {
        if (frame !== this.page?.mainFrame()) return;
        this.send({ kind: 'url', url: frame.url() });
      });

      // Absolute cap: even a client that stays connected gets cut off so a
      // forgotten tab can't screencast the live game indefinitely.
      this.maxSessionTimer = setTimeout(() => {
        log.warn(`Login session hit the ${MAX_SESSION_MS / 60_000}-min cap; tearing down to stop the screencast.`);
        void this.cancel();
      }, MAX_SESSION_MS);

      log.info(`Login session launched (clan=${clanId}, target=${gameUrl})`);
      return { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
    } catch (err) {
      // Log before tearing down: teardown is async and the route only turns
      // the thrown error into a response afterwards, so without this a failed
      // launch left nothing in the logs to explain it.
      log.warn(`Login session failed to launch (clan=${clanId}): ` + String(err));
      await this.teardown();
      throw err;
    } finally {
      this.starting = false;
    }
  }

  /**
   * Attach an admin WebSocket and start streaming.
   *
   * `clientAddress` is the resolved address of the admin's browser (see
   * link-quality.ts). It selects the screencast quality/framerate profile:
   * a client on the LAN gets a smooth, higher-quality stream, while a
   * client over the internet keeps the frugal one. Omit it and the frugal
   * profile applies.
   */
  /**
   * Launch the bridge's Chromium. Extracted so start() can throw away a
   * broken GPU attempt and relaunch software-rendered without duplicating the
   * whole option set.
   */
  private async launchBridgeBrowser(
    profileDir: string,
    headed: boolean,
    gpuEnabled: boolean,
  ): Promise<BrowserContext> {
    // An unclean shutdown leaves Chromium's singleton locks in the profile,
    // and a new container hostname makes them permanently unbreakable — so
    // one wedged session would otherwise brick the bridge for good.
    clearStaleProfileLocks(profileDir, log);

    const context = await chromium.launchPersistentContext(profileDir, {
      headless: !headed,
      // ALWAYS the full Chromium build, never headless-shell.
      //
      // Two reasons, both load-bearing for this feature. It's the only build
      // with GPU support. And when headless:true it selects Chromium's NEW
      // headless — a complete browser rendering offscreen — whereas the
      // default would be headless-shell, a stripped binary that is not a
      // sound host for an interactive session an admin drives by hand.
      channel: 'chromium',
      // Fail loudly instead of hanging on "Launching browser…" forever.
      timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      locale: 'en-US',
      // Same zone as the scanner — see ../config/game-timezone.ts.
      timezoneId: gameDayTimezoneId(getConfig().gameDayRolloverUtcHour),
      env: headed && this.xvfb ? { ...process.env, DISPLAY: this.xvfb.display } : process.env,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--mute-audio',
        // The bridge window is never "visible" to the compositor under Xvfb,
        // and Chromium throttles rendering for occluded/background windows —
        // which shows up as a stuttering screencast. The scanner sets these too.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
        ...(gpuEnabled ? GPU_ARGS : []),
      ],
    });
    // Reachable by teardown from the very first instant it exists. Everything
    // start() does next can throw — even `context.pages()` if the browser died
    // on launch — and teardown can only close a browser it can see.
    this.pendingContext = context;
    return context;
  }

  async attachSocket(ws: WebSocket, clientAddress?: string): Promise<void> {
    // `starting` as well as the fields: a launch in flight is not a session to
    // stream, and attaching to one that hasn't cleared its liveness gate would
    // race the teardown a failed start is about to run.
    if (!this.context || !this.page || this.starting) {
      ws.close(1011, 'Login session not active');
      return;
    }
    if (this.socket && this.socket.readyState === 1) {
      // Reject second concurrent socket; admin opening multiple tabs would
      // otherwise fight for input and frames.
      ws.close(1011, 'Already attached');
      return;
    }
    this.socket = ws;

    // A client (re)attached — cancel any pending idle teardown.
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Everything from here to the 'ready' message talks to the browser, so it
    // can fail if the browser died between start() and the client connecting.
    // The caller invokes this as `void attachSocket(...)`, which means a
    // rejection escaping here is an UNHANDLED rejection, and the client is
    // left on "Connecting…" with no idea why. Own the failure instead.
    try {
      await this.streamTo(ws, clientAddress);
    } catch (err) {
      const detail = String(err instanceof Error ? err.message : err).split('\n')[0];
      log.warn('Could not start streaming the login session: ' + detail);
      if (isTargetGoneError(err)) {
        // Terminal — the thing we were going to stream no longer exists.
        // Reported with the socket still attached, so the client gets the
        // 'fatal' explanation rather than a bare close code, and the teardown
        // that follows closes the socket for us.
        this.handleBrowserGone('the stream could not attach to the browser');
      } else {
        // The browser may well be fine, but nobody is watching it. Arm the
        // idle teardown so a session no client can attach to still ends on its
        // own rather than surviving to the max-session cap.
        this.armIdleTeardown();
      }
      if (this.socket === ws) {
        this.socket = null;
        try {
          ws.close(1011, 'Could not attach to the remote browser');
        } catch {
          // Already gone.
        }
      }
      return;
    }

    ws.on('message', (raw) => {
      const parsed = parseClientMessage(raw.toString());
      if (!parsed) return;
      const activeCdp = this.cdp;
      const activePage = this.page;
      if (!activeCdp || !activePage) return;
      void dispatchClientMessage(activeCdp, activePage, parsed).then((result) => {
        // The relay is often the first thing to notice a dead browser —
        // it's the only component talking to it every few milliseconds.
        // Treat that as the death notice instead of warning per event.
        if (result === 'target-closed') {
          this.handleBrowserGone('the input relay lost the browser');
        }
      });
    });

    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.socket = null;
      // Stop streaming the instant the client goes away — a closed or
      // backgrounded tab must not keep the game rendering frames into a
      // dead socket (that was the 9.46 GB egress leak). We keep the
      // browser alive briefly so a reconnect (admin reloaded the page)
      // can resume, but if nobody reattaches within IDLE_TEARDOWN_MS we
      // tear the whole bridge down to reclaim the bandwidth + RAM.
      void this.stopActiveScreencast();
      this.armIdleTeardown();
    });

    ws.on('error', (err) => {
      log.warn('Login session socket error: ' + String(err));
    });
  }

  /** (Re)arm the idle teardown that ends a session nobody is watching. */
  private armIdleTeardown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log.info('No client reattached to login session within idle window; tearing down.');
      void this.cancel();
    }, IDLE_TEARDOWN_MS);
  }

  /**
   * Open a CDP session, pick a starting rung on the quality ladder and begin
   * screencasting to `ws`. Split out of attachSocket so every browser call in
   * the attach path sits inside one try/catch — see the caller.
   */
  private async streamTo(ws: WebSocket, clientAddress?: string): Promise<void> {
    const context = this.context;
    const page = this.page;
    if (!context || !page) throw new Error('Login session not active.');

    const cdp = await context.newCDPSession(page);
    this.cdp = cdp;

    // Measure the actual round-trip to pick a STARTING rung on the quality
    // ladder. The client's IP can prove a link is local (loopback/RFC1918) but
    // never that it is remote — an IPv6 client has a globally-routable address,
    // since IPv6 has no NAT, and a client arriving through Cloudflare looks
    // remote even from the same LAN. Getting this wrong is cheap: the adaptive
    // loop below corrects within a couple of seconds.
    const rttMs = await measureSocketRtt(ws);
    const start = initialStreamStep({ address: clientAddress, rttMs });
    this.streamStep = start.step;
    const profile = ladderStep(this.streamStep);
    log.info(
      `Login session client at ${clientAddress ?? 'unknown address'} ` +
        `starting at "${profile.label}" (${start.reason}); quality ${profile.quality}, ` +
        `every ${profile.everyNthFrame} frame(s).`,
    );

    const screencast = await startScreencast(cdp, {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      quality: profile.quality,
      everyNthFrame: profile.everyNthFrame,
      onFrame: (jpeg) => this.sendFrame(jpeg),
    });
    this.stopScreencast = screencast.stop;
    this.setStreamProfile = screencast.setProfile;
    this.startAdaptiveLoop();

    this.send({
      kind: 'ready',
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      url: page.url(),
      quality: `${profile.label} — ${start.reason}`,
    });
  }

  /**
   * Subscribe to the ways a browser can die on us, and return the launch
   * generation the listeners are bound to.
   *
   * Called immediately after the launch that produced `context`/`page`, before
   * anything is done with them. A crash here is usually memory pressure — the
   * game's WebGL renderer is the biggest consumer in the container — and it
   * lands most often while the game is loading, which is why this cannot wait
   * until the navigation is finished.
   *
   * The generation check is what keeps the listeners honest. Playwright fires
   * 'close' for browsers WE close too: the GPU attempt start() throws away,
   * and every normal teardown. Both bump the generation first, so those events
   * arrive stale and are dropped instead of being reported as a crash.
   */
  private watchForDeath(context: BrowserContext, page: Page): number {
    const generation = ++this.launchGeneration;
    const gone = (reason: string) => {
      if (generation !== this.launchGeneration) return;
      this.handleBrowserGone(reason);
    };
    page.on('crash', () => gone('the page crashed (most likely out of memory)'));
    page.on('close', () => gone('the page closed'));
    context.on('close', () => gone('the browser exited'));
    return generation;
  }

  /**
   * Is this browser still answering? Used as a gate before start() declares a
   * session active.
   *
   * Deliberately a browser-process call (`cookies()`) rather than
   * `page.evaluate()`. Evaluating in the renderer can reject with "execution
   * context was destroyed" purely because the game navigated, which would
   * fail a perfectly healthy session. cookies() answers in milliseconds from a
   * live browser, rejects promptly when the process is gone, and hangs when
   * the process is alive but wedged — which the deadline turns into an answer.
   */
  private async confirmAlive(context: BrowserContext, page: Page): Promise<boolean> {
    if (this.browserGone || page.isClosed()) return false;
    const browser = context.browser();
    if (browser && !browser.isConnected()) return false;
    try {
      await withDeadline(context.cookies(), LIVENESS_PROBE_TIMEOUT_MS, 'browser liveness probe');
      return true;
    } catch (err) {
      log.warn('Login bridge browser did not answer a liveness probe: ' + String(err).split('\n')[0]);
      return false;
    }
  }

  /**
   * The remote browser ended without us asking. Report it exactly once,
   * tell the client so it stops streaming input into nothing, and tear the
   * session down so the scan loop resumes and a retry can start fresh.
   *
   * Idempotent and re-entrancy safe: the page-close, context-close and
   * relay-failure paths all race to call this during the same death.
   */
  private handleBrowserGone(reason: string): void {
    if (this.tearingDown || this.browserGone) return;
    this.browserGone = true;
    log.warn(`Login session ended unexpectedly: ${reason}. Tearing the bridge down.`);
    this.send({
      kind: 'fatal',
      message: `The remote browser stopped (${reason}). Start a new login session to try again.`,
    });
    // Mid-start: leave the teardown to start()'s own error path. It checks
    // browserGone before declaring the session live, and racing two teardowns
    // against a half-built session is how state gets left behind.
    if (this.starting) return;
    void this.teardown();
  }

  /**
   * Stop the active screencast and detach its CDP session, without tearing
   * down the browser. Lets a reconnecting client get a fresh screencast
   * (attachSocket creates a new CDP session + screencast each time) while
   * ensuring a disconnected client never leaves frames being encoded.
   */
  private async stopActiveScreencast(): Promise<void> {
    this.stopAdaptiveLoop();
    this.setStreamProfile = null;
    // Take the references and clear the fields before awaiting, for the same
    // reason teardown() does: a wedged browser must not be able to leave a
    // reattaching client sharing a half-stopped screencast.
    const stopScreencast = this.stopScreencast;
    const cdp = this.cdp;
    this.stopScreencast = null;
    this.cdp = null;
    if (stopScreencast) {
      await settleWithDeadline(stopScreencast(), TEARDOWN_STEP_TIMEOUT_MS, 'stopping the screencast');
    }
    if (cdp) {
      await settleWithDeadline(cdp.detach(), TEARDOWN_STEP_TIMEOUT_MS, 'detaching the CDP session');
    }
  }

  /** Control messages (ready / url / fatal) go as JSON text frames. */
  private send(payload: Record<string, unknown>): void {
    const sock = this.socket;
    if (!sock || sock.readyState !== 1) return;
    try {
      sock.send(JSON.stringify(payload));
    } catch (err) {
      log.warn('Send failed: ' + String(err));
    }
  }

  /**
   * Send one screencast frame as a raw binary message. Binary vs the old
   * base64-inside-JSON saves 25% on the wire and skips building a
   * ~250 KB string per frame on both ends. The client tells frames from
   * control messages by type: binary = frame, text = JSON control.
   *
   * Drops the frame if the socket is already behind. A screencast is
   * strictly "newest frame wins" — queuing frames a slow link hasn't
   * drained yet just grows the send buffer and adds latency between the
   * operator's click and the picture, which reads as lag AND stutter. This
   * makes the stream self-regulating on any link, independent of the
   * quality profile the address heuristic picked.
   */
  private sendFrame(jpeg: Buffer): void {
    const sock = this.socket;
    if (!sock || sock.readyState !== 1) return;
    if (sock.bufferedAmount > FRAME_BACKPRESSURE_BYTES) {
      this.droppedFrames++;
      this.windowDropped++;
      return;
    }
    try {
      sock.send(jpeg, { binary: true });
      this.windowSent++;
    } catch (err) {
      log.warn('Frame send failed: ' + String(err));
    }
  }

  /**
   * Close the loop on stream quality.
   *
   * Guessing the right quality from the client's address or RTT is
   * unreliable — RTT is only a proxy for the bandwidth the stream actually
   * consumes, and a client behind Cloudflare or a VPN measures nothing like
   * its true capacity. So the starting rung is a guess, and this corrects it
   * from the one signal that cannot lie: whether the socket drains the frames
   * we hand it.
   *
   * Down on sustained drops, up after several clean windows, one rung at a
   * time so the picture never lurches. Movement is bounded by the ladder, so
   * the worst case is the frugal profile we used to pin everyone to.
   */
  private startAdaptiveLoop(): void {
    this.stopAdaptiveLoop();
    // Pinned by the operator — respect it and don't fight them.
    if (isStreamProfileForced()) return;

    this.adaptTimer = setInterval(() => {
      const sent = this.windowSent;
      const dropped = this.windowDropped;
      this.windowSent = 0;
      this.windowDropped = 0;

      const total = sent + dropped;
      // An idle window (nothing rendered, e.g. a static screen) is not
      // evidence about the link either way.
      if (total === 0) return;

      const dropRate = dropped / total;
      if (dropRate > ADAPT_DOWN_DROP_RATE) {
        this.cleanWindows = 0;
        this.moveStream(this.streamStep + 1, `${Math.round(dropRate * 100)}% of frames dropped`);
        return;
      }
      if (dropped === 0) {
        this.cleanWindows++;
        if (this.cleanWindows >= ADAPT_UP_CLEAN_WINDOWS) {
          this.cleanWindows = 0;
          this.moveStream(this.streamStep - 1, 'link is keeping up');
        }
        return;
      }
      // A few drops: right where we should be. Hold, but don't bank progress
      // toward stepping up.
      this.cleanWindows = 0;
    }, ADAPT_INTERVAL_MS);
    if (typeof this.adaptTimer.unref === 'function') this.adaptTimer.unref();
  }

  private stopAdaptiveLoop(): void {
    if (this.adaptTimer) {
      clearInterval(this.adaptTimer);
      this.adaptTimer = null;
    }
    this.cleanWindows = 0;
    this.windowSent = 0;
    this.windowDropped = 0;
  }

  /** Move to `next` on the ladder if it's a real, in-range change. */
  private moveStream(next: number, why: string): void {
    const clamped = Math.min(STREAM_LADDER.length - 1, Math.max(0, next));
    if (clamped === this.streamStep) return;
    const direction = clamped > this.streamStep ? 'down' : 'up';
    this.streamStep = clamped;
    const profile = ladderStep(clamped);
    log.info(
      `Login session stream stepped ${direction} to "${profile.label}" ` +
        `(quality ${profile.quality}, every ${profile.everyNthFrame} frame(s)) — ${why}.`,
    );
    this.send({ kind: 'quality', quality: `${profile.label} — ${why}` });
    void this.setStreamProfile?.(profile.quality, profile.everyNthFrame);
  }

  /**
   * Seed the bridge's persistent context with cookies + localStorage from the
   * scanner's existing storage-state.json. Best-effort — failures are logged
   * and swallowed so a malformed/missing file doesn't block login.
   */
  private async hydrateFromStorageState(context: BrowserContext, storageStatePath: string): Promise<void> {
    if (!fs.existsSync(storageStatePath)) return;
    try {
      const raw = fs.readFileSync(storageStatePath, 'utf8').trim();
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        cookies?: Parameters<BrowserContext['addCookies']>[0];
        origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
      };
      const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
      if (cookies.length > 0) {
        await context.addCookies(cookies);
        log.info(`Seeded login bridge with ${cookies.length} cookies from existing session.`);
      }
      // localStorage seeding is best-effort and only useful on first run; the
      // persistent profile takes over after that. Skip it for now — Playwright
      // requires a page navigation to that origin first, which would slow
      // things down without much benefit since the cookies alone are enough
      // for OAuth providers to remember the account.
    } catch (err) {
      log.warn('Could not seed login bridge from storage-state.json: ' + String(err));
    }
  }

  /** Capture cookies, write storage-state.json (per-clan), tear down the browser. */
  async save(adminUserId: number | null): Promise<{
    ok: boolean;
    cookies: number;
    hasTbAuth: boolean;
    hasSessionCookie: boolean;
    storageStatePath: string;
  }> {
    if (!this.context) {
      throw new Error('Login session not active.');
    }
    const clanId = this.activeClanId ?? 1;
    const targetStorageState = clanStorageStatePath(clanId);

    // Let in-flight cookies finish writing before capture. TB sets several
    // important cookies (Braze ab.storage.{userId,deviceId,sessionId},
    // helpshift cf_clearance) only after the Unity client finishes booting.
    // Without this settle the bridge captures ~15 cookies vs the ~55 a fully
    // loaded game produces. We do NOT renavigate — the operator selected the
    // correct account in-game and we want the state exactly as they left it.
    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.waitForLoadState('networkidle', { timeout: 15_000 });
      } catch {
        log.warn('Network did not idle before save; capturing anyway.');
      }
      // Brief additional settle: a few cookies (Braze sessionId, _ga_*) get
      // set on a delayed timer after networkidle clears.
      await new Promise((r) => setTimeout(r, 2_000));
    }

    // Bounded, like every other lifecycle call to the browser: storageState()
    // takes no timeout of its own, and a wedged browser would leave the save
    // request hanging with the session still marked active — the exact wedge
    // this file used to be full of. If it can't answer, the session is over;
    // tear it down so the operator gets an error they can act on and a bridge
    // they can immediately restart.
    let state: Awaited<ReturnType<BrowserContext['storageState']>>;
    try {
      state = await withDeadline(
        this.context.storageState(),
        STORAGE_STATE_TIMEOUT_MS,
        'reading the browser session state',
      );
    } catch (err) {
      log.warn('Could not read the login session state: ' + String(err).split('\n')[0]);
      await this.teardown();
      throw new Error(
        'The browser stopped responding before the session could be captured, so nothing was saved. ' +
          'The session has been closed — start a new one and sign in again.',
      );
    }
    const cookies = state.cookies ?? [];
    const hasTbAuth = cookies.some((c) => typeof c.domain === 'string' && c.domain.includes('totalbattle'));

    // Capture-completeness check. The ONLY cookie the headless scanner
    // needs is PTBHSSID — TB's server-side session id. The big Google /
    // YouTube OAuth cookie set (which is what swings the total between
    // ~16 and ~55) only matters for the interactive bridge remembering
    // the account; the scanner just replays the session cookie. So we key
    // the warning on PTBHSSID presence, NOT on the raw cookie count — a
    // 16-cookie capture with a valid PTBHSSID is healthy and has scanned
    // fine for months. Warning on the count was a false alarm.
    const hasSessionCookie = cookies.some((c) => c.name === 'PTBHSSID');
    if (!hasSessionCookie) {
      log.warn(
        `Captured session is missing the TB session cookie (PTBHSSID) — the scanner will treat this clan as logged out. ` +
          `Wait for the game to fully load (canvas + your base visible) before saving.`,
      );
    } else {
      log.info(`Captured ${cookies.length} cookies including the TB session cookie (PTBHSSID) — session is scannable.`);
    }

    fs.mkdirSync(path.dirname(targetStorageState), { recursive: true });
    if (fs.existsSync(targetStorageState)) {
      fs.copyFileSync(targetStorageState, targetStorageState + '.bak');
    }
    fs.writeFileSync(targetStorageState, JSON.stringify(state, null, 2));

    if (adminUserId !== null) {
      logAction(adminUserId, 'login_session_save', { cookies: cookies.length, hasTbAuth, clanId });
    }

    // Fresh storage-state on disk — the auth-check phase will be able
    // to load the canvas again, so drop the "needs re-auth" badge and
    // re-arm the Discord notice for the next time cookies expire.
    clearClanNeedsReauth(clanId);

    await this.teardown();
    return { ok: true, cookies: cookies.length, hasTbAuth, hasSessionCookie, storageStatePath: targetStorageState };
  }

  async cancel(): Promise<void> {
    await this.teardown();
  }

  /**
   * End the session. Two halves, and the order between them is the point:
   *
   *   1. The state transition, entirely synchronous. Every field that makes
   *      this bridge look occupied — context, page, cdp, socket, timers — is
   *      cleared before anything is awaited.
   *   2. Releasing the resources: asynchronous, best-effort, and bounded by a
   *      deadline on every single step.
   *
   * It used to be the other way around: `this.context` was nulled only after
   * `await this.context.close()` returned, with `tearingDown` latched for the
   * whole duration. A browser that was alive but wedged — the out-of-memory
   * swap-thrash this bridge is most likely to meet — answers close() with
   * neither a resolve nor a reject, so that await never returned, and with it:
   * isActive() stayed true, every subsequent cancel() returned instantly as a
   * no-op against the latch, start() refused with "Login session already
   * active", and the max-session timer that might have rescued it had already
   * been cleared on the way in. Nothing short of restarting the container
   * cleared it.
   *
   * Now the worst a wedged browser can cost is a leaked process — and even
   * that gets SIGKILLed, because leaving it alive would hand the next launch a
   * profile lock it is not allowed to break.
   */
  private async teardown(): Promise<void> {
    if (this.tearingDown) return;
    this.tearingDown = true;

    // ---- 1. State transition. No awaits above this line's work. ----
    // Bump first: closing the context fires 'close', and that must read as
    // "we did this" rather than as the browser dying under us.
    this.launchGeneration++;
    // Either the accepted session's browser or one start() is still building.
    const context = this.context ?? this.pendingContext;
    const cdp = this.cdp;
    const socket = this.socket;
    const stopScreencast = this.stopScreencast;
    const xvfb = this.xvfb;
    const profileDir = this.activeProfileDir;
    const droppedFrames = this.droppedFrames;

    this.context = null;
    this.pendingContext = null;
    this.page = null;
    this.cdp = null;
    this.socket = null;
    this.stopScreencast = null;
    this.setStreamProfile = null;
    this.xvfb = null;
    this.activeClanId = null;
    this.activeProfileDir = null;
    this.startedAt = null;
    this.droppedFrames = 0;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.maxSessionTimer) {
      clearTimeout(this.maxSessionTimer);
      this.maxSessionTimer = null;
    }
    this.stopAdaptiveLoop();

    // ---- 2. Release the resources. Every step bounded. ----
    try {
      if (stopScreencast) {
        await settleWithDeadline(stopScreencast(), TEARDOWN_STEP_TIMEOUT_MS, 'stopping the screencast');
      }
      if (cdp) {
        await settleWithDeadline(cdp.detach(), TEARDOWN_STEP_TIMEOUT_MS, 'detaching the CDP session');
      }
      if (socket) {
        try {
          socket.close(1000, 'Session ended');
        } catch {
          // Already closing/closed — nothing to do.
        }
      }
      if (context) {
        // launchPersistentContext owns the browser; closing the context tears
        // it down too.
        const outcome = await settleWithDeadline(
          context.close(),
          CONTEXT_CLOSE_TIMEOUT_MS,
          'closing the login bridge browser',
        );
        if (outcome === 'timeout') {
          log.warn(
            `The login bridge browser did not close within ${CONTEXT_CLOSE_TIMEOUT_MS / 1000}s — it is ` +
              'wedged rather than merely slow. The bridge itself is already free; killing the process so ' +
              'it cannot hold the profile lock against the next session.',
          );
          if (profileDir) killProfileOwner(profileDir, log);
        }
      }
      stopXvfb(xvfb);
    } finally {
      // Unconditionally, however badly the release went. A latch left set here
      // is what turned one dead browser into a dead feature.
      this.tearingDown = false;
    }

    // Session boundary — emit any coalesced "repeated N×" summaries now,
    // while they still sit next to the failure they belong to, instead of
    // letting them surface later beside unrelated logs.
    flushRelayWarnings();
    flushScreencastWarnings();

    if (droppedFrames > 0) {
      log.info(
        `Login session dropped ${droppedFrames} frame(s) to socket backpressure — ` +
          'the network link was the limit, not the browser.',
      );
    }

    // Resume whatever was paused for this bridge (the scan loop), no
    // matter how we got here. Previously only the save/cancel HTTP routes
    // resumed the scanner, so an abandoned session that tore down via the
    // idle/max-session timer left the scanner paused indefinitely — the
    // dashboard just showed "Next scan: now" and nothing ran.
    const onTeardown = this.onTeardown;
    if (onTeardown) {
      try {
        onTeardown();
      } catch (err) {
        log.warn('Login bridge teardown hook threw (non-fatal): ' + String(err));
      }
    }
  }

  status(): { active: boolean; startedAt: string | null; socketAttached: boolean } {
    return {
      active: this.isActive(),
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      socketAttached: this.isSocketAttached(),
    };
  }
}

export const loginBridge = new LoginBridge();
