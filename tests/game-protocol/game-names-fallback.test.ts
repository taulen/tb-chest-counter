// loadGameNames when a game patch's names can't be built: the newest names on
// disk keep chest names, sources and game texts showing, and the ~70 MB build
// isn't retried by every caller (scans, page loads, chat). Network stubbed;
// no game bytes.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGameNames, resetGameNamesMemo } from '../../src/game-protocol/static-data.js';
import { readPatchStatus, resetPatchStatusMemo } from '../../src/game-patch/status.js';

const VERSIONS = {
  result: {
    client_static_version: {
      production: { composite_hash: 'fedcba9876543210fedc', strings: 's.bin', vectors: 'v.bin', no_duplicates: 'n.bin' },
    },
    client_translations_catalog_version: 'tr456.json',
  },
};

let dir: string;
let savedDir: string | undefined;
let downloads: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbcc-names-fallback-'));
  savedDir = process.env.GAME_STATIC_DIR;
  process.env.GAME_STATIC_DIR = dir;
  process.env.GAME_PATCH_FILE = path.join(dir, 'game-patch.json');
  resetGameNamesMemo();
  resetPatchStatusMemo();
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
  delete process.env.GAME_PATCH_FILE;
  resetGameNamesMemo();
  resetPatchStatusMemo();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadGameNames when a new patch cannot be built', () => {
  it('serves the previous patch\'s names, reports it, and does not rebuild on the next call', async () => {
    fs.mkdirSync(path.join(dir, 'old'));
    fs.writeFileSync(path.join(dir, 'old', 'names.json'), JSON.stringify({ version: 'previous-patch', gifts: {} }));

    expect((await loadGameNames()).version).toBe('previous-patch');
    const firstTry = downloads.length;
    expect(firstTry).toBeGreaterThan(0);
    expect(readPatchStatus().readers.names).toMatchObject({
      ok: false, live: 'fedcba9876543210-tr456', served: 'previous-patch',
    });

    expect((await loadGameNames()).version).toBe('previous-patch');
    expect(downloads.length).toBe(firstTry);
  });

  it('throws when there are no names at all', async () => {
    await expect(loadGameNames()).rejects.toThrow(/HTTP 404/);
  });
});
