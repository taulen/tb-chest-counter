// A tab left open across a deploy keeps running the build it loaded: every
// asset URL carries /v/<build>/ (docs/cloudflare-caching.md), so nothing in
// the tab changes until the page itself reloads. In Nov 2026 a Captains-tab
// fix "needed a hard refresh" for exactly that reason.
//
// The live build is read from /api/health when the tab comes back into view
// and on navigation (at most once a minute). A newer one reloads the page at
// the NEXT navigation, so code is never swapped under someone mid-read. Once
// per build: if the reload still serves the old build (an edge holding the
// old HTML), the tab carries on rather than reloading in a loop.

/** The build this page was loaded from: the /v/<build>/ segment of this module's own URL. */
const LOADED = (import.meta.url.match(/\/v\/([^/]+)\//) || [])[1] || null;
const CHECK_EVERY_MS = 60_000;
const GUARD_KEY = 'tb-build-reloaded-for';

let latest = null;
let checkedAt = 0;

/** Record the live build's fingerprint (from any /api/health read). */
export function noteLiveBuild(fingerprint) {
  if (fingerprint && fingerprint !== 'unknown') latest = String(fingerprint);
}

/** Read the live build, at most once a minute. Never throws. */
export async function checkLiveBuild() {
  if (!LOADED || Date.now() - checkedAt < CHECK_EVERY_MS) return;
  checkedAt = Date.now();
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (r.ok) noteLiveBuild((await r.json())?.fingerprint);
  } catch {
    // Offline or restarting: the next navigation tries again.
  }
}

/**
 * Reload when a newer build is live than the one this page runs (call it on
 * navigation). Returns true when a reload was started.
 */
export function reloadIfNewBuild() {
  if (!LOADED || !latest || latest === LOADED) return false;
  try {
    if (sessionStorage.getItem(GUARD_KEY) === latest) return false;
    sessionStorage.setItem(GUARD_KEY, latest);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** Wire the checks: on returning to the tab, and once now. */
export function initBuildCheck() {
  if (!LOADED) return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkLiveBuild();
  });
  void checkLiveBuild();
}
