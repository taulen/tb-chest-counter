/**
 * The static files the setup wizard (/setup) is allowed to fetch before the
 * operator has an account — the pre-auth counterpart of PUBLIC_SHARE_ASSETS,
 * and it fails the same way.
 *
 * In setup mode the app serves these explicitly; everything else under
 * src/web/public sits behind requireAuth, whose rejection is a redirect. For a
 * stylesheet that degrades the page; for an ES module it *kills* it — one
 * failed import aborts the whole module graph, so setup.js never runs at all.
 *
 * That is not hypothetical. `lib/login-bridge.js` gained an import of
 * `lib/wheel.js` and nothing connected that to this list, so on a real first
 * run the wizard rendered but was inert: the theme buttons did nothing, the
 * defaults never populated, and the submit handler was never bound — a page
 * that looks finished and answers no clicks. The authenticated app loads the
 * same file happily, so only a first-run operator ever sees it.
 *
 * tests/config/setup-mode-assets.test.ts walks the real import graph from
 * setup.js and fails the build when it outgrows this list.
 *
 * Paths are relative to src/web/public and use forward slashes.
 */
export const SETUP_MODE_ASSETS = [
  // Entry point + the two stylesheets it loads (base.css first: it carries the
  // token system the wizard's own styles reference).
  'setup.js',
  'setup.css',
  'base.css',
  // Transitive imports of setup.js. login-bridge.js is the embedded Total
  // Battle sign-in; theme.js is the picker in the card's top-right; wheel.js
  // is the bridge's scroll normaliser.
  'lib/api.js',
  'lib/state.js',
  'lib/ui.js',
  'lib/login-bridge.js',
  'lib/wheel.js',
  'lib/theme.js',
] as const;

/** The JS/CSS subset, i.e. everything served from the same PUBLIC_DIR root. */
export type SetupModeAsset = (typeof SETUP_MODE_ASSETS)[number];
