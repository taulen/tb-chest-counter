// loadTechTrees when a game patch's trees can't be built (Nov 2026: the asset
// catalogue's header changed and every build failed): the previous patch's
// trees keep the Research tab drawn, and the ~67 MB build isn't retried on
// every page load and scan. Network stubbed; no game bytes.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTechTrees, resetTechTreesMemo, type TechTrees } from '../../src/game-protocol/tech-trees.js';

const VERSIONS = {
  result: {
    client_static_version: {
      production: { composite_hash: '0123456789abcdef0123', strings: 's.bin', vectors: 'v.bin', no_duplicates: 'n.bin' },
    },
    client_translations_catalog_version: 'tr123.json',
    unity_catalog_version: { webgl: 'ffeeddccbbaa99887766554433221100' },
  },
};

const PREVIOUS: TechTrees = { version: 'previous-patch', builtAt: '2026-11-20T00:00:00.000Z', trees: [] };

let dir: string;
let savedDir: string | undefined;
let downloads: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbcc-trees-fallback-'));
  savedDir = process.env.GAME_STATIC_DIR;
  process.env.GAME_STATIC_DIR = dir;
  resetTechTreesMemo();
  downloads = [];
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.startsWith('https://versions.totalbattle.com/')) {
      return new Response(JSON.stringify(VERSIONS), { status: 200 });
    }
    downloads.push(url);
    return new Response('gone', { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedDir === undefined) delete process.env.GAME_STATIC_DIR;
  else process.env.GAME_STATIC_DIR = savedDir;
  resetTechTreesMemo();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadTechTrees when a new patch cannot be built', () => {
  it('serves the previous patch\'s trees and does not rebuild on the next call', async () => {
    fs.mkdirSync(path.join(dir, 'old'));
    fs.writeFileSync(path.join(dir, 'old', 'tech-trees.json'), JSON.stringify(PREVIOUS));

    expect((await loadTechTrees()).version).toBe('previous-patch');
    const firstTry = downloads.length;
    expect(firstTry).toBeGreaterThan(0);

    expect((await loadTechTrees()).version).toBe('previous-patch');
    expect(downloads.length).toBe(firstTry);
  });

  it('throws when there are no trees at all', async () => {
    await expect(loadTechTrees()).rejects.toThrow(/HTTP 404/);
    await expect(loadTechTrees()).rejects.toThrow(/HTTP 404/);
  });
});
