// The patch watcher: a changed versions config runs every reader at once; an
// unchanged one runs nothing (one small request every 10 min); a reader that
// failed is retried every 30 min; Check now runs everything with retry waits
// lifted. Network and readers stubbed.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkGamePatch, fingerprintFromConfig, type PatchReaderRuns } from '../../src/game-patch/watch.js';
import { readPatchStatus, reportReaderFailed, resetPatchStatusMemo, updatePatchStatus } from '../../src/game-patch/status.js';

function config(over: { static?: string; catalog?: string; client?: string; translations?: string } = {}): unknown {
  return {
    result: {
      client_static_version: { production: { composite_hash: over.static ?? 's1' }, prod_coldfix: { composite_hash: 'other' } },
      client_translations_catalog_version: over.translations ?? 't1.json',
      unity_catalog_version: { webgl: over.catalog ?? 'c1', win: 'w' },
      webgl_client_version: { default: over.client ?? 'b1', 'coldfix-x': 'b0' },
    },
  };
}

let served: unknown = config();
const fetchImpl = (async () => new Response(JSON.stringify(served), { status: 200 })) as unknown as typeof fetch;

function runs(): PatchReaderRuns & { calls: string[]; cleared: number } {
  const calls: string[] = [];
  const r = {
    calls,
    cleared: 0,
    names: async () => { calls.push('names'); },
    trees: async () => { calls.push('trees'); },
    art: async () => { calls.push('art'); },
    client: async () => { calls.push('client'); },
    clearRetries: () => { r.cleared++; },
  };
  return r;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbcc-patch-watch-'));
  process.env.GAME_PATCH_FILE = path.join(dir, 'game-patch.json');
  resetPatchStatusMemo();
  served = config();
});

afterEach(() => {
  delete process.env.GAME_PATCH_FILE;
  resetPatchStatusMemo();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

const markAllOk = (): void => {
  updatePatchStatus((s) => {
    for (const r of ['names', 'trees', 'art', 'client'] as const) {
      s.readers[r] = { live: 'x', served: 'x', ok: true, error: null, checkedAt: new Date().toISOString() };
    }
  });
};

describe('fingerprintFromConfig', () => {
  it('takes the live parts a patch changes, and refuses a config missing one', () => {
    expect(fingerprintFromConfig(config())).toEqual({ static: 's1', translations: 't1.json', catalog: 'c1', client: 'b1' });
    expect(() => fingerprintFromConfig({ result: {} })).toThrow(/no static, translations, catalog, client version/);
  });
});

describe('checkGamePatch', () => {
  it('reads everything the first time it sees the game, then nothing while the patch is unchanged and read', async () => {
    const r = runs();
    expect((await checkGamePatch({ fetchImpl, runs: r })).ran).toEqual(['names', 'trees', 'art', 'client']);
    expect(readPatchStatus().fingerprint).toEqual({ static: 's1', translations: 't1.json', catalog: 'c1', client: 'b1' });

    markAllOk();
    r.calls.length = 0;
    const again = await checkGamePatch({ fetchImpl, runs: r });
    expect(again).toEqual({ changed: [], ran: [] });
    expect(r.calls).toEqual([]);
  });

  it('a new patch runs every reader in order and records when it was seen', async () => {
    const r = runs();
    await checkGamePatch({ fetchImpl, runs: r });
    markAllOk();
    const firstSeen = readPatchStatus().patchSeenAt;

    served = config({ catalog: 'c2' });
    r.calls.length = 0;
    const res = await checkGamePatch({ fetchImpl, runs: r });
    expect(res.changed).toEqual(['catalog']);
    expect(r.calls).toEqual(['names', 'trees', 'art', 'client']);
    expect(readPatchStatus().fingerprint?.catalog).toBe('c2');
    expect(readPatchStatus().patchSeenAt! >= firstSeen!).toBe(true);
  });

  it('retries a failing reader every 30 min, not every poll', async () => {
    const r = runs();
    await checkGamePatch({ fetchImpl, runs: r });
    markAllOk();
    reportReaderFailed('trees', 'v2', 'v1', new Error('boom'));

    r.calls.length = 0;
    await checkGamePatch({ fetchImpl, runs: r });
    expect(r.calls).toEqual([]);

    updatePatchStatus((s) => {
      s.readers.trees!.checkedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    });
    await checkGamePatch({ fetchImpl, runs: r });
    expect(r.calls).toEqual(['trees']);
  });

  it('Check now runs every reader with the retry waits lifted', async () => {
    const r = runs();
    await checkGamePatch({ fetchImpl, runs: r });
    markAllOk();
    r.calls.length = 0;
    await checkGamePatch({ fetchImpl, runs: r, force: true });
    expect(r.calls).toEqual(['names', 'trees', 'art', 'client']);
    expect(r.cleared).toBe(1);
  });

  it('a reader that throws does not stop the others', async () => {
    const r = runs();
    r.names = async () => {
      r.calls.push('names');
      throw new Error('boom');
    };
    await checkGamePatch({ fetchImpl, runs: r });
    expect(r.calls).toEqual(['names', 'trees', 'art', 'client']);
  });

  it('records a versions endpoint failure and runs nothing', async () => {
    const r = runs();
    const down = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const res = await checkGamePatch({ fetchImpl: down, runs: r });
    expect(res.error).toMatch(/HTTP 503/);
    expect(r.calls).toEqual([]);
    expect(readPatchStatus().lastCheckError).toMatch(/HTTP 503/);

    await checkGamePatch({ fetchImpl, runs: r });
    expect(readPatchStatus().lastCheckError).toBeNull();
  });
});
