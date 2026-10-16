/**
 * Pins the public-share page's asset URLs to the path-versioned form.
 *
 * This file used to also pin an unauthenticated allowlist against
 * public-share.js's import graph: every static file sat behind requireAuth, so
 * a share-page import missing from the list got a `302 -> /login` and one
 * failed import blanked the page. Static files are now public for everyone
 * (src/web/frontend-assets.ts), so that list — and the class of outage it kept
 * causing — is gone. tests/web/security/frontend-assets.test.ts covers the
 * serving side.
 *
 * A pure test — reads the files off disk, no DB, no server — so it runs as part
 * of `npm run build` (npm run guards).
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { versionHtmlAssets } from '../../src/web/asset-versioning.js';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../../src/web/public', import.meta.url)));

/**
 * Every share link once rendered blank for eighteen hours after the fix for
 * its missing asset had deployed.
 *
 * The page was served with `?v=<build>` on its asset references. A query
 * string is not part of the base URL an ES module's relative import resolves
 * against, so `/public-share.js?v=123` fetched its own `lib/*.js` imports
 * from bare, unversioned URLs — and Cloudflare was still holding the
 * `302 -> /login` it had cached against bare `/lib/mobile-rows.js` from four
 * minutes before the fix went live. The origin was right; the edge answered
 * anyway.
 *
 * Path-versioning is what makes a deploy self-healing: `/v/<build>/…` is a
 * URL no cache has ever seen, and the prefix rides along into every relative
 * import for free. These tests pin that form so the share page can't drift
 * back to a query string, which is a change that looks completely harmless
 * and is invisible until a shared cache happens to be holding something bad.
 */
describe('public-share asset URLs are path-versioned', () => {
  const html = versionHtmlAssets(
    fs.readFileSync(path.join(PUBLIC_DIR, 'public-share.html'), 'utf8'),
    'testbuild',
  );

  it('routes every local js/css reference through /v/<build>/', () => {
    const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)[^"]*)"/g)].map((m) => m[1]);
    // Sanity: if the HTML stops referencing assets entirely, the assertions
    // below would pass vacuously.
    expect(refs.length).toBeGreaterThan(0);
    const unversioned = refs.filter((r) => !r.startsWith('/v/testbuild/'));
    expect(
      unversioned,
      'these are fetched at a URL that is stable across deploys, so a shared ' +
        'cache can pin a stale (or redirected) response to them: ' + unversioned.join(', '),
    ).toEqual([]);
  });

  it('never falls back to the ?v= query form', () => {
    // The specific regression: versions the entry point and nothing it imports.
    expect(html).not.toMatch(/(?:src|href)="[^"]*\?v=/);
  });

  it('serves the module entry point from a versioned path so imports inherit it', () => {
    // This single reference is what versions the whole graph — every lib/*
    // module is reached by a relative import from here, never by its own tag
    // in the HTML.
    expect(html).toMatch(/<script type="module" src="\/v\/testbuild\/public-share\.js">/);
  });
});
