/**
 * Pins the setup wizard's pre-auth asset allowlist against the real ES-module
 * import graph of setup.js — the first-run twin of
 * tests/config/public-share-assets.test.ts.
 *
 * A first run is the one moment nobody is logged in and every page is a page
 * the operator has never seen, so a missing module has no visible symptom: the
 * wizard renders, and then does nothing. That is what happened when
 * lib/login-bridge.js took on an import of lib/wheel.js — setup mode served
 * every file on its list and redirected that one, one failed import aborted
 * the graph, and setup.js never executed. The theme picker was dead, the
 * defaults never filled in, and the submit button was bound to nothing. The
 * authenticated app loads wheel.js fine, so nothing anywhere else was wrong.
 *
 * Pure test — reads files off disk, no DB, no server — so it runs in
 * `npm run build` (npm run guards) and goes red the moment the wizard's import
 * graph outgrows the list.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { SETUP_MODE_ASSETS } from '../../src/web/setup-mode-assets.js';
import { versionHtmlAssets } from '../../src/web/asset-versioning.js';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../../src/web/public', import.meta.url)));

// Static `from './x.js'` / `import './x.js'` only — a dynamic import would be
// unresolvable here and would fail at runtime for the same reason, so the
// wizard's imports stay static.
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
      queue.push(toPosix(path.normalize(path.join(path.dirname(rel), m[1]))));
    }
  }
  return [...seen];
}

describe('setup-mode asset allowlist', () => {
  const graph = collectImports('setup.js');

  it('covers every file setup.js imports, transitively', () => {
    const allowed = new Set<string>(SETUP_MODE_ASSETS);
    const missing = graph.filter((f) => !allowed.has(f));
    expect(
      missing,
      'setup.js imports these but setup mode does not serve them — add them to ' +
        `src/web/setup-mode-assets.ts or the wizard will render inert: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('covers every stylesheet setup.html loads', () => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'setup.html'), 'utf8');
    const hrefs = [...html.matchAll(/href="\/?([\w./-]+\.css)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    const allowed = new Set<string>(SETUP_MODE_ASSETS);
    expect(hrefs.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it('finds the whole graph on disk', () => {
    // A typo'd import path would otherwise be skipped by the walker and read
    // as "nothing missing".
    expect(graph.filter((f) => !fs.existsSync(path.join(PUBLIC_DIR, f)))).toEqual([]);
  });

  it('lists no file that no longer exists', () => {
    expect(SETUP_MODE_ASSETS.filter((f) => !fs.existsSync(path.join(PUBLIC_DIR, f)))).toEqual([]);
  });
});

/**
 * Same path-versioning rule the share page is held to, for the same reason:
 * a `?v=` query string is not part of the base URL a relative import resolves
 * against, so it versions the entry point and none of its imports — and
 * Cloudflare keys on the path anyway. setup.html carried `?v=20260407b` for
 * exactly that reason and was skipping the rewriter entirely.
 */
describe('setup asset URLs are path-versioned', () => {
  const html = versionHtmlAssets(
    fs.readFileSync(path.join(PUBLIC_DIR, 'setup.html'), 'utf8'),
    'testbuild',
  );

  it('routes every local js/css reference through /v/<build>/', () => {
    const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)[^"]*)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !r.startsWith('/v/testbuild/'))).toEqual([]);
  });

  it('never falls back to the ?v= query form', () => {
    expect(html).not.toMatch(/(?:src|href)="[^"]*\?v=/);
  });
});
