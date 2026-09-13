/**
 * Pins the public-share page's unauthenticated asset allowlist against the
 * real ES-module import graph of public-share.js.
 *
 * Every share link stopped rendering its leaderboard when `lib/mobile-rows.js`
 * was added as an import: the file is served only behind requireAuth, so an
 * anonymous visitor's fetch for it redirected to /login, and one failed import
 * aborts the whole module graph — public-share.js never ran and #content stayed
 * empty. Nothing about the change looked wrong from the inside, because the
 * authenticated app serves the same file happily; only a logged-out visitor
 * ever sees it.
 *
 * A pure test — reads the files off disk, no DB, no server — so it runs as part
 * of `npm run build` (npm run guards) and goes red the moment someone adds an
 * import to the public page without opening the allowlist.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { PUBLIC_SHARE_ASSETS } from '../../src/web/public-share-assets.js';
import { versionHtmlAssets } from '../../src/web/asset-versioning.js';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../../src/web/public', import.meta.url)));

// Matches the static `from './x.js'` / `import './x.js'` forms only. Anything
// dynamic wouldn't be resolvable here anyway — and would fail at runtime for
// the same reason, so keep the public page's imports static.
const IMPORT_RE = /(?:from|import)\s*['"](\.[^'"]+)['"]/g;

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Walk the static import graph from an entry file, relative to PUBLIC_DIR. */
function collectImports(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.shift() as string;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(PUBLIC_DIR, rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const resolved = toPosix(path.normalize(path.join(path.dirname(rel), m[1])));
      queue.push(resolved);
    }
  }
  return [...seen];
}

describe('public-share asset allowlist', () => {
  const graph = collectImports('public-share.js');

  it('covers every file public-share.js imports, transitively', () => {
    const allowed = new Set<string>(PUBLIC_SHARE_ASSETS);
    const missing = graph.filter((f) => !allowed.has(f));
    expect(
      missing,
      `public-share.js imports these without an unauthenticated route — add them to ` +
        `src/web/public-share-assets.ts or the share page will render blank: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('finds the whole graph on disk', () => {
    // A typo'd import path would otherwise be silently skipped by the walker
    // and read as "nothing missing".
    const absent = graph.filter((f) => !fs.existsSync(path.join(PUBLIC_DIR, f)));
    expect(absent).toEqual([]);
  });

  it('lists no file that no longer exists', () => {
    const absent = PUBLIC_SHARE_ASSETS.filter((f) => !fs.existsSync(path.join(PUBLIC_DIR, f)));
    expect(absent).toEqual([]);
  });
});

/**
 * The allowlist above was correct and deployed, and every share link still
 * rendered blank for another eighteen hours.
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
    // This single reference is what versions the whole graph — every
    // PUBLIC_SHARE_ASSETS lib/* entry is reached by a relative import from
    // here, never by its own tag in the HTML.
    expect(html).toMatch(/<script type="module" src="\/v\/testbuild\/public-share\.js">/);
  });
});
