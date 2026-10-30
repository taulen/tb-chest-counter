import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import {
  appendBackupChunk,
  BackupUploadError,
  finishBackupUpload,
  startBackupUpload,
} from '../../src/web/backup-upload.js';

/**
 * A database restore used to be one base64 JSON body, capped at 100MB/200MB.
 * Prod outgrew that in Sep 2026, and Cloudflare refuses any single body over
 * 100MB anyway, so a backup now arrives as raw slices appended on disk. What
 * must hold: the bytes come back exactly, in order, from the owner only, and
 * a slice that dies part-way can be resent without corrupting the file.
 */
describe('backup upload: chunked restore staging', () => {
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-upload-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const fakeDb = (): Buffer => Buffer.concat([Buffer.from('SQLite format 3\0'), crypto.randomBytes(50_000)]);

  const sendInSlices = async (uploadId: string, owner: string, data: Buffer, slice: number) => {
    for (let index = 0, offset = 0; offset < data.length; index++, offset += slice) {
      await appendBackupChunk(uploadId, owner, index, Readable.from([data.subarray(offset, offset + slice)]));
    }
  };

  it('reassembles a plain .db from its slices byte for byte', async () => {
    const data = fakeDb();
    const { uploadId } = startBackupUpload('prod.db', 'user:1', dir);
    await sendInSlices(uploadId, 'user:1', data, 7_000);

    const staged = await finishBackupUpload(uploadId, 'user:1');
    expect(staged.fileName).toBe('prod.db');
    expect(staged.bytes).toBe(data.length);
    expect(fs.readFileSync(staged.dbPath).equals(data)).toBe(true);
    staged.cleanup();
    expect(fs.existsSync(path.dirname(staged.dbPath))).toBe(false);
  });

  it('gunzips a .db.gz upload', async () => {
    const data = fakeDb();
    const { uploadId } = startBackupUpload('prod.db.gz', 'user:1', dir);
    await sendInSlices(uploadId, 'user:1', zlib.gzipSync(data), 9_000);

    const staged = await finishBackupUpload(uploadId, 'user:1');
    expect(fs.readFileSync(staged.dbPath).equals(data)).toBe(true);
    staged.cleanup();
  });

  it('refuses a slice out of order', async () => {
    const { uploadId } = startBackupUpload('prod.db', 'user:1', dir);
    await expect(appendBackupChunk(uploadId, 'user:1', 1, Readable.from([Buffer.from('x')])))
      .rejects.toMatchObject({ status: 409 });
  });

  it('cuts a half-received slice back off so the same index can be resent', async () => {
    const data = fakeDb();
    const { uploadId } = startBackupUpload('prod.db', 'user:1', dir);
    await appendBackupChunk(uploadId, 'user:1', 0, Readable.from([data.subarray(0, 20_000)]));

    const dying = new Readable({ read() {} });
    dying.push(data.subarray(20_000, 25_000));
    setImmediate(() => dying.destroy(new Error('connection reset')));
    await expect(appendBackupChunk(uploadId, 'user:1', 1, dying)).rejects.toThrow('connection reset');

    await appendBackupChunk(uploadId, 'user:1', 1, Readable.from([data.subarray(20_000)]));
    const staged = await finishBackupUpload(uploadId, 'user:1');
    expect(fs.readFileSync(staged.dbPath).equals(data)).toBe(true);
    staged.cleanup();
  });

  it('will not let another owner append to or adopt an upload', async () => {
    const { uploadId } = startBackupUpload('prod.db', 'user:1', dir);
    await expect(appendBackupChunk(uploadId, 'user:2', 0, Readable.from([fakeDb()])))
      .rejects.toMatchObject({ status: 404 });
    await expect(finishBackupUpload(uploadId, 'user:2')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a file that is not SQLite and leaves no staging behind', async () => {
    const { uploadId } = startBackupUpload('prod.db', 'user:1', dir);
    await sendInSlices(uploadId, 'user:1', crypto.randomBytes(5_000), 5_000);

    await expect(finishBackupUpload(uploadId, 'user:1')).rejects.toThrow('valid SQLite backup');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('rejects a name that is not a backup before staging anything', () => {
    expect(() => startBackupUpload('notes.txt', 'user:1', dir)).toThrow(BackupUploadError);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('starting again discards the same owner\'s unfinished upload', async () => {
    const first = startBackupUpload('a.db', 'user:1', dir);
    const second = startBackupUpload('b.db', 'user:1', dir);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    await expect(finishBackupUpload(first.uploadId, 'user:1')).rejects.toMatchObject({ status: 404 });
    expect(second.uploadId).not.toBe(first.uploadId);
  });
});
