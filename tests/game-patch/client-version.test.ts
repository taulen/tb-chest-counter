// The client version the scan's login sends follows the live game build: read
// from the build's PlayerSettings (made-up bytes here — no game data, the
// repository is public), remembered per build, never older than the hand-set
// fallback, overridable by GAME_CLIENT_VERSION.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clientVersionFromBundle,
  clientVersionFromPlayerSettings,
  readClientBundle,
} from '../../src/game-art/webgl-client.js';
import {
  FALLBACK_CLIENT_VERSION,
  clientVersionInfo,
  compareVersions,
  ensureClientVersion,
  gameClientVersion,
  rememberClientVersion,
  resetClientVersionMemo,
} from '../../src/game-patch/client-version.js';
import { readPatchStatus, resetPatchStatusMemo } from '../../src/game-patch/status.js';
import { buildBundle, buildSerializedFile, t } from '../game-art/synthetic-bundle.js';

const u32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };

function webData(files: Array<[string, Buffer]>): Buffer {
  const magic = Buffer.from('UnityWebData1.0\0', 'latin1');
  const headerSize = magic.length + 4 + files.reduce((n, [name]) => n + 12 + Buffer.byteLength(name), 0);
  const entries: Buffer[] = [];
  let at = headerSize;
  for (const [name, data] of files) {
    entries.push(u32(at), u32(data.length), u32(Buffer.byteLength(name)), Buffer.from(name, 'utf8'));
    at += data.length;
  }
  return Buffer.concat([magic, u32(headerSize), ...entries, ...files.map(([, d]) => d)]);
}

const PLAYER_SETTINGS = t.cls('PlayerSettings', 'Base', [
  t.string('companyName'),
  t.string('productName'),
  t.bool('someFlag'),
  t.bool('otherFlag', true),
  t.float('aspect'),
  t.string('macAppStoreCategory'),
  t.int('count'),
  t.string('bundleVersion'),
]);

/** A client build's data file whose PlayerSettings carries `version`. */
function clientBuild(version: string): Buffer {
  const ggm = buildSerializedFile([{
    pathId: 1n,
    classId: 129,
    tree: PLAYER_SETTINGS,
    value: {
      companyName: 'Studio', productName: 'Game', someFlag: true, otherFlag: false, aspect: 1.5,
      macAppStoreCategory: 'public.app-category.games', count: 3, bundleVersion: version,
    },
  }]);
  return webData([['data.unity3d', buildBundle([{ path: 'globalgamemanagers', data: ggm }])]]);
}

const str = (s: string): Buffer => {
  const b = Buffer.from(s, 'latin1');
  return Buffer.concat([u32(b.length), b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
};

describe('reading the client version from a build', () => {
  it('finds bundleVersion among the PlayerSettings strings', () => {
    expect(clientVersionFromBundle(readClientBundle(clientBuild('350.0.1122')))).toBe('350.0.1122');
  });

  it('wherever it sits, even after unaligned bytes', () => {
    const obj = Buffer.concat([str('Studio'), Buffer.from([1, 0, 1]), str('351.2.3'), str('Standard')]);
    expect(clientVersionFromPlayerSettings(obj)).toBe('351.2.3');
  });

  it('fails loudly on none or two, never guessing', () => {
    expect(() => clientVersionFromPlayerSettings(Buffer.concat([str('Studio'), str('Game')]))).toThrow(/no version string/);
    expect(() => clientVersionFromPlayerSettings(Buffer.concat([str('1.2.3'), str('4.5.6')]))).toThrow(/2 version strings/);
  });

  it('says what is missing from a build without one', () => {
    const noGgm = webData([['data.unity3d', buildBundle([{ path: 'resources.assets', data: Buffer.alloc(64) }])]]);
    expect(() => clientVersionFromBundle(readClientBundle(noGgm))).toThrow(/no globalgamemanagers/);
  });
});

describe('the version the login sends', () => {
  let dir: string;
  const BUILD = 'a'.repeat(32);
  const NEXT = 'b'.repeat(32);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbcc-client-version-'));
    process.env.GAME_ART_DIR = dir;
    process.env.GAME_PATCH_FILE = path.join(dir, 'game-patch.json');
    delete process.env.GAME_CLIENT_VERSION;
    resetClientVersionMemo();
    resetPatchStatusMemo();
  });

  afterEach(() => {
    delete process.env.GAME_ART_DIR;
    delete process.env.GAME_PATCH_FILE;
    delete process.env.GAME_CLIENT_VERSION;
    resetClientVersionMemo();
    resetPatchStatusMemo();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('compares versions part by part', () => {
    expect(compareVersions('350.0.1122', '349.9.1116')).toBe(1);
    expect(compareVersions('349.10.1', '349.9.9999')).toBe(1);
    expect(compareVersions('349.9.1116', '349.9.1116')).toBe(0);
    expect(compareVersions('348.0.0', '349.9.1116')).toBe(-1);
  });

  it('is the fallback until a build is read, then the build\'s; the env override beats both', () => {
    expect(clientVersionInfo()).toEqual({ version: FALLBACK_CLIENT_VERSION, source: 'fallback' });

    rememberClientVersion(BUILD, '350.0.1122');
    expect(gameClientVersion()).toBe('350.0.1122');
    expect(clientVersionInfo()).toMatchObject({ source: 'game', build: BUILD });

    resetClientVersionMemo(); // a restart reads it back
    expect(gameClientVersion()).toBe('350.0.1122');

    process.env.GAME_CLIENT_VERSION = '999.0.1';
    expect(clientVersionInfo()).toEqual({ version: '999.0.1', source: 'env' });
  });

  it('never sends a version older than the fallback', () => {
    rememberClientVersion(BUILD, '300.0.1');
    expect(gameClientVersion()).toBe(FALLBACK_CLIENT_VERSION);
  });

  it('downloads a new build once, and not at all when the build is already read', async () => {
    const downloads: string[] = [];
    let live = BUILD;
    const fetchImpl = (async (url: string) => {
      if (url.startsWith('https://versions.totalbattle.com/')) {
        return new Response(JSON.stringify({ result: { webgl_client_version: { default: live } } }), { status: 200 });
      }
      downloads.push(url);
      return new Response(new Uint8Array(clientBuild(live === BUILD ? '350.0.1122' : '351.0.7')), { status: 200 });
    }) as unknown as typeof fetch;

    expect((await ensureClientVersion(fetchImpl)).version).toBe('350.0.1122');
    expect(await ensureClientVersion(fetchImpl)).toMatchObject({ version: '350.0.1122', build: BUILD });
    expect(downloads).toHaveLength(1);
    expect(readPatchStatus().readers.client).toMatchObject({ ok: true, live: BUILD });

    live = NEXT;
    expect((await ensureClientVersion(fetchImpl)).version).toBe('351.0.7');
    expect(downloads).toHaveLength(2);
    expect(downloads[1]).toContain(NEXT);
  });

  it('a build it cannot read keeps the version it had, reports it, and waits before retrying', async () => {
    rememberClientVersion(BUILD, '350.0.1122');
    let downloads = 0;
    const fetchImpl = (async (url: string) => {
      if (url.startsWith('https://versions.totalbattle.com/')) {
        return new Response(JSON.stringify({ result: { webgl_client_version: { default: NEXT } } }), { status: 200 });
      }
      downloads++;
      return new Response(new Uint8Array(Buffer.from('not a web data file')), { status: 200 });
    }) as unknown as typeof fetch;

    expect((await ensureClientVersion(fetchImpl)).version).toBe('350.0.1122');
    expect(readPatchStatus().readers.client).toMatchObject({ ok: false, live: NEXT, served: '350.0.1122' });
    await ensureClientVersion(fetchImpl);
    expect(downloads).toBe(1);
  });
});
