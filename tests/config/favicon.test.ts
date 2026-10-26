import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { versionHtmlAssets } from '../../src/web/asset-versioning.js';
import { SETUP_MODE_ASSETS } from '../../src/web/setup-mode-assets.js';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../../src/web/public', import.meta.url)));
const SHELLS = ['index.html', 'login.html', 'public-share.html', 'setup.html'];

// The tab icon is an asset like any other: Cloudflare caches .svg by
// extension, so it has to ride the /v/<build>/ prefix, and setup mode only
// serves what its allowlist names.
describe('favicon', () => {
  it('exists', () => {
    expect(fs.existsSync(path.join(PUBLIC_DIR, 'favicon.svg'))).toBe(true);
  });

  for (const shell of SHELLS) {
    it(`${shell} links it at a versioned URL`, () => {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, shell), 'utf8');
      expect(versionHtmlAssets(html, 'abc123')).toContain(
        '<link rel="icon" type="image/svg+xml" href="/v/abc123/favicon.svg">',
      );
    });
  }

  it('is served in setup mode', () => {
    expect(SETUP_MODE_ASSETS).toContain('favicon.svg');
  });
});
