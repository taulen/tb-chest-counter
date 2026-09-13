/**
 * The static files the public share page (/<token>) is allowed to fetch
 * without a session.
 *
 * Everything else under src/web/public sits behind requireAuth, so this list
 * is the whole boundary: a file the page loads but this list omits is served
 * a redirect to /login instead. For a stylesheet that degrades the page; for
 * an ES module it *kills* it — one failed import aborts the entire module
 * graph, so public-share.js never runs and the visitor gets a page with an
 * empty #content and no error.
 *
 * That is exactly how `lib/mobile-rows.js` broke every share link: it was
 * added as an import by the compact-row overhaul and nothing connected that
 * to this list. `tests/config/public-share-assets.test.ts` now walks the
 * import graph from public-share.js and fails the build when the two
 * disagree, because nothing else about the change looks wrong — the
 * authenticated app loads the same file fine, and only an anonymous visitor
 * ever sees the failure.
 *
 * Paths are relative to src/web/public and use forward slashes.
 */
export const PUBLIC_SHARE_ASSETS = [
  // Entry point + its own styles.
  'public-share.js',
  'public-share.css',
  // Shared with the authenticated app: the public page reuses their classes
  // (.card, .ext-meta-strip, .ext-detail-table, …) so it matches the
  // ChestTracker tab. base.css has its own public route (login needs it too).
  'style.css',
  'external.css',
  // Transitive imports of public-share.js — the same period math, sort
  // logic, renderers and mobile-row behaviour the authenticated app uses,
  // so a fix on either side applies to both.
  'lib/period.js',
  'lib/period-nav.js',
  'lib/leaderboard-render.js',
  'lib/chesttracker-render.js',
  'lib/mobile-rows.js',
  'lib/state.js',
  'lib/ui.js',
] as const;
