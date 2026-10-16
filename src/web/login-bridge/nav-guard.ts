import type { CDPSession } from 'playwright';
import { childLogger } from '../../utils/logger.js';
import { createCoalescedWarner } from '../../utils/log-throttle.js';
import { isTotalBattleHost } from '../../config/game-url.js';

const log = childLogger('login-bridge-nav');

// A page that keeps retrying a blocked navigation would otherwise log one
// line per attempt. Info level never reaches the System warning buffer, so
// this is only about keeping stdout readable.
const blockedLog = createCoalescedWarner((msg) => log.info(msg));

/**
 * May the bridge's top-level page load this URL?
 *
 * The bridge browser is signed in to the shared game account, and the game
 * links out — YouTube, Discord, Facebook — from its news and social buttons.
 * An admin who clicks one would otherwise be driving a logged-in browser
 * around the open web, with the game unloaded behind them. So the page the
 * admins see stays on totalbattle.com or a subdomain of it.
 *
 * Only http(s) is judged: anything else (about:blank, a blob:, the error
 * page Chromium shows for a failed load) has no foreign site behind it.
 * Parsed rather than matched as text, for the same reason as
 * totalBattleUrlOrNull: `totalbattle.com.evil.example` and
 * `totalbattle.com@evil.example` both contain the right string.
 */
export function isAllowedTopLevelUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  return isTotalBattleHost(url.hostname);
}

/**
 * Refuse every top-level navigation off totalbattle.com, at the browser.
 *
 * Done with CDP's Fetch domain rather than Playwright's `page.route()`,
 * because enabling route() disables the HTTP cache for the whole page — the
 * game would then re-download all of its assets on every bridge session
 * instead of loading them from the persistent profile. Fetch here is
 * scoped to Document requests only, so the game's own assets and API calls
 * never pause at all, and redirect hops arrive as requests of their own, so
 * a totalbattle.com link that 302s to YouTube is caught at the hop.
 *
 * Only the MAIN frame is held to the rule. An iframe the game embeds (a
 * video, a payment widget) is part of a totalbattle.com page, and some of
 * those load from other hosts by design; blocking them would break the
 * page without keeping anyone on the game.
 *
 * A refused navigation is failed as `Aborted` (net::ERR_ABORTED), which is
 * the one error Chromium does not answer with an error page — the same path
 * a download or a 204 takes. The navigation is simply dropped and the game
 * keeps running underneath; any other reason would replace the game with
 * "This page has been blocked".
 *
 * `cdp` must belong to the bridge page and live as long as it does (not the
 * per-attach screencast session): interception stops when it detaches.
 */
export async function installNavigationGuard(
  cdp: CDPSession,
  onBlocked: (url: string) => void,
): Promise<void> {
  // The main frame's id is the page target's own and does not change across
  // navigations, so one lookup holds for the session.
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const mainFrameId = frameTree.frame.id;

  // Wired before Fetch.enable so no paused request can arrive unheard — a
  // request nobody continues stays paused, which would hang the page.
  cdp.on('Fetch.requestPaused', (event) => {
    const { requestId, frameId, request } = event;
    if (frameId !== mainFrameId || isAllowedTopLevelUrl(request.url)) {
      void cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    void cdp.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {});
    const host = hostOf(request.url);
    blockedLog.warn(`blocked:${host}`, `Kept the login bridge on totalbattle.com: refused a navigation to ${host}`);
    onBlocked(request.url);
  });

  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
  });
}

/** Hostname for a log line or a UI notice; the raw string if unparseable. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname || raw;
  } catch {
    return raw;
  }
}
