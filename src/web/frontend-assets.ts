import path from 'path';
import express, { Router } from 'express';
import type { RequestHandler } from 'express';

/**
 * The frontend's static files — every script, stylesheet and image a page
 * loads — served to anyone, session or not.
 *
 * They used to sit behind requireAuth, and that gate is what left the app
 * blank on a phone for the length of a holiday (Oct 2026) while the same
 * account worked on a desktop at home. Cloudflare caches by file extension and
 * overrides the origin's Cache-Control, so ONE logged-out request for
 * `/v/<build>/app.js` stores the `302 -> /login` at that edge location for
 * ~22 hours. `denyCaching()`'s `private, no-store` does not stop it: a
 * throwaway probe URL came back `cf-cache-status: HIT` on its second request.
 * From then on every visitor routed through that location gets the redirect
 * in place of a module, one failed import aborts the whole graph, and a
 * perfectly good login lands on an empty shell. Each Cloudflare location
 * caches on its own, which is why it read as a mobile bug: the desktop's
 * location held the real file, the phone's held the redirect.
 *
 * The gate never protected anything. The repository is public, so is every
 * file here, and the edge was already handing its cached 200 to anyone who
 * asked. All it could add was that failure — and the hand-kept allowlist the
 * public share page needed to get around it, whose one missing entry once cost
 * every share link 18 hours. The auth boundary is /api, where the data is.
 *
 * HTML is the exception: the shells go through the version rewriter and the
 * SPA fallback, so a `.html` path falls through to the routes after this one,
 * as does anything that isn't a file here (a directory, a missing path).
 */

/** The /assets subdirectories the frontend references (resource-format.js, system.js). */
const PUBLIC_ASSET_DIRS = ['resource-icons', 'calibration-examples'] as const;

function skipHtml(handler: RequestHandler): RequestHandler {
  return (req, res, next) => (
    path.extname(req.path).toLowerCase() === '.html' ? next() : handler(req, res, next)
  );
}

export function createFrontendAssetRouter(publicDir: string, assetsDir: string): Router {
  const router = Router();

  // Chart.js from the dependency that is already installed, rather than a CDN.
  //
  // It was loaded from jsdelivr, which makes a self-hosted tool depend on a
  // third party being up and on whatever that third party serves — and would
  // force the CSP to allow an external script origin. It is in package.json
  // and therefore in the image; serve it from there.
  router.get(['/vendor/chart.umd.js', '/v/:buildVersion/vendor/chart.umd.js'], (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('application/javascript');
    res.sendFile(path.resolve('node_modules/chart.js/dist/chart.umd.js'));
  });

  // Versioned: the HTML rewrite (./asset-versioning.ts) prefixes every
  // entry-point reference with `/v/<BUILD_VERSION>/`, and relative imports
  // inherit it. The URL is unique per build, so immutable + a year is always
  // correct for it.
  router.use('/v/:buildVersion', skipHtml((_req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    next();
  }), skipHtml(express.static(publicDir, { index: false, redirect: false })));

  // Bare, un-versioned paths: kept for any URL a browser cached before the
  // version prefix existed. no-store, because an ES module's relative imports
  // resolve against the importer's own URL — a stale bare copy would mix with
  // fresh ones and break on a "does not provide an export named X".
  router.use(skipHtml(express.static(publicDir, {
    index: false,
    redirect: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    },
  })));

  for (const dir of PUBLIC_ASSET_DIRS) {
    router.use(`/assets/${dir}`, express.static(path.join(assetsDir, dir), {
      maxAge: 86_400_000,
      redirect: false,
    }));
  }

  return router;
}
