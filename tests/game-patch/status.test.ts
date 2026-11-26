// What a reader of the game's files reports when a patch can't be read: one
// alerting warning per reader and game version (not one per page load or
// scan), cleared when it reads again; kept on disk so a restart neither
// forgets the failure nor raises it again.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ warn: [] as Array<{ obj: unknown; msg: string }>, info: [] as string[] }));

vi.mock('../../src/utils/logger.js', () => ({
  childLogger: () => ({
    warn: (obj: unknown, msg: string) => logged.warn.push({ obj, msg }),
    info: (msg: string) => logged.info.push(msg),
    error: () => {},
    debug: () => {},
  }),
}));
vi.mock('../../src/utils/log-buffer.js', () => ({ resolveEntries: vi.fn(() => 0) }));

import { resolveEntries } from '../../src/utils/log-buffer.js';
import {
  readPatchStatus,
  reportReaderFailed,
  reportReaderOk,
  resetPatchStatusMemo,
  warningKey,
} from '../../src/game-patch/status.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbcc-patch-status-'));
  process.env.GAME_PATCH_FILE = path.join(dir, 'game-patch.json');
  resetPatchStatusMemo();
  logged.warn.length = 0;
  logged.info.length = 0;
  vi.mocked(resolveEntries).mockClear();
});

afterEach(() => {
  delete process.env.GAME_PATCH_FILE;
  resetPatchStatusMemo();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('game patch reader status', () => {
  it('warns once per reader and game version, with a key that clears it', () => {
    reportReaderFailed('trees', 'v2', 'v1', new Error('not a catalogue: unexpected header'));
    reportReaderFailed('trees', 'v2', 'v1', new Error('not a catalogue: unexpected header'));

    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0].obj).toEqual({ resolveKey: warningKey('trees') });
    expect(logged.warn[0].msg).toMatch(/Research trees can't be read for game version v2: not a catalogue/);
    expect(logged.warn[0].msg).toMatch(/Serving the previous patch's \(v1\)/);

    const st = readPatchStatus().readers.trees!;
    expect(st).toMatchObject({ ok: false, live: 'v2', served: 'v1', error: 'not a catalogue: unexpected header' });
    expect(st.failingSince).toBeTruthy();

    // A newer patch that fails too is a new warning.
    reportReaderFailed('trees', 'v3', 'v1', new Error('boom'));
    expect(logged.warn).toHaveLength(2);
  });

  it('keeps when a failure started across repeated failures', () => {
    reportReaderFailed('names', 'v2', null, new Error('a'));
    const since = readPatchStatus().readers.names!.failingSince;
    reportReaderFailed('names', 'v2', null, new Error('b'));
    expect(readPatchStatus().readers.names!.failingSince).toBe(since);
    expect(readPatchStatus().readers.names!.error).toBe('b');
    expect(logged.warn[0].msg).toMatch(/Nothing to serve until it can/);
  });

  it('clears the warning when the reader reads again', () => {
    reportReaderFailed('art', 'v2', 'v1', new Error('boom'));
    reportReaderOk('art', 'v2');

    expect(resolveEntries).toHaveBeenCalledWith(warningKey('art'));
    expect(readPatchStatus().readers.art).toMatchObject({ ok: true, live: 'v2', served: 'v2', error: null });
    expect(logged.info.join('\n')).toMatch(/Game art read for game version v2/);

    // Already ok on this version: nothing to write or clear.
    vi.mocked(resolveEntries).mockClear();
    reportReaderOk('art', 'v2');
    expect(resolveEntries).not.toHaveBeenCalled();
  });

  it('survives a restart: the failure is remembered and not raised again', () => {
    reportReaderFailed('client', 'b2', '349.9.1116', new Error('PlayerSettings holds no version string'));
    expect(fs.existsSync(process.env.GAME_PATCH_FILE!)).toBe(true);

    resetPatchStatusMemo(); // a restart
    reportReaderFailed('client', 'b2', '349.9.1116', new Error('PlayerSettings holds no version string'));
    expect(logged.warn).toHaveLength(1);
    expect(readPatchStatus().readers.client!.ok).toBe(false);
  });
});
