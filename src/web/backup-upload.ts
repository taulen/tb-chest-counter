import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { Response } from 'express';

/**
 * Chunked upload of a database backup, shared by the in-app restore
 * (/api/import/backup-db) and the first-run setup restore.
 *
 * A backup used to travel as one base64 JSON body with 100MB/200MB ceilings.
 * The database outgrew those in Sep 2026, and raising them would not help:
 * Cloudflare refuses any single request body over 100MB whatever the origin
 * allows. So the browser now sends the file as it is, in raw slices small
 * enough for any proxy, which are appended to a staging file on disk — the
 * backup is never held in memory whole, on either side.
 *
 * Flow: start (fileName) → uploadId; one PUT per slice, in order; then the
 * route's own finish step calls `finishBackupUpload`, which gunzips if needed
 * and checks the SQLite header, leaving a staged .db for the route to validate
 * and adopt.
 */

/** Slice size the browser is told to use. Far below Cloudflare's 100MB. */
export const BACKUP_CHUNK_BYTES = 16 * 1024 * 1024;

// Backstops against filling the disk, not expected limits: prod was 271MB
// raw in Oct 2026. The decompressed cap is what stops a gzip bomb.
const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;
const MAX_DB_BYTES = 8 * 1024 ** 3;

/** An upload nobody has touched for this long is abandoned and deleted. */
const IDLE_TTL_MS = 60 * 60 * 1000;
const STAGING_PREFIX = 'restore-';

interface PendingUpload {
  id: string;
  owner: string;
  parentDir: string;
  dir: string;
  partPath: string;
  fileName: string;
  bytes: number;
  nextIndex: number;
  busy: boolean;
  touchedAt: number;
}

export interface StagedBackup {
  fileName: string;
  /** A complete, uncompressed SQLite file — header checked, not yet opened. */
  dbPath: string;
  bytes: number;
  /** Deletes the staging directory. Safe to call more than once. */
  cleanup: () => void;
}

export class BackupUploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'BackupUploadError';
  }
}

const pending = new Map<string, PendingUpload>();

export function isBackupFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith('.db') || lower.endsWith('.db.gz') || lower.endsWith('.gz');
}

/**
 * Open a new upload. `owner` binds it to whoever started it (a user id, or
 * the setup flow), so one caller can never append to or adopt another's file.
 * Starting again discards the owner's earlier unfinished upload.
 */
export function startBackupUpload(
  fileNameRaw: string,
  owner: string,
  parentDir: string,
): { uploadId: string; chunkBytes: number } {
  const fileName = path.basename(fileNameRaw.trim());
  if (!fileName) throw new BackupUploadError('fileName is required');
  if (!isBackupFileName(fileName)) throw new BackupUploadError('Backup file must be a .db or .db.gz file');

  sweepStale(parentDir);
  for (const upload of pending.values()) {
    if (upload.owner === owner && !upload.busy) discard(upload);
  }

  fs.mkdirSync(parentDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parentDir, STAGING_PREFIX));
  const partPath = path.join(dir, 'upload.part');
  fs.writeFileSync(partPath, '');

  const id = crypto.randomBytes(16).toString('hex');
  pending.set(id, {
    id, owner, parentDir, dir, partPath, fileName,
    bytes: 0, nextIndex: 0, busy: false, touchedAt: Date.now(),
  });
  return { uploadId: id, chunkBytes: BACKUP_CHUNK_BYTES };
}

/**
 * Append one slice, streamed straight from the request to disk. Slices must
 * arrive in order; a slice that fails part-way is cut back off the file, so
 * the same index can simply be sent again.
 */
export async function appendBackupChunk(
  uploadId: string,
  owner: string,
  index: number,
  body: Readable,
): Promise<number> {
  const upload = getOwned(uploadId, owner);
  if (upload.busy) throw new BackupUploadError('Another chunk of this upload is still being received', 409);
  if (index !== upload.nextIndex) {
    throw new BackupUploadError(`Expected chunk ${upload.nextIndex}, got ${index}`, 409);
  }

  upload.busy = true;
  const before = upload.bytes;
  let received = 0;
  try {
    await pipeline(
      body,
      byteLimit((n) => {
        received = n;
        if (n > BACKUP_CHUNK_BYTES) return 'Chunk too large';
        if (before + n > MAX_UPLOAD_BYTES) return 'Backup file too large (max 4GB)';
        return null;
      }),
      fs.createWriteStream(upload.partPath, { flags: 'a' }),
    );
    if (received === 0) throw new BackupUploadError('Empty chunk');
  } catch (err) {
    try {
      fs.truncateSync(upload.partPath, before);
    } catch {
      // The staging file is gone; the next chunk or the finish step will say so.
    }
    throw err;
  } finally {
    upload.busy = false;
    upload.touchedAt = Date.now();
  }

  upload.bytes = before + received;
  upload.nextIndex += 1;
  return upload.bytes;
}

/**
 * Close the upload and turn it into a staged SQLite file. The upload is
 * consumed either way: on failure its staging directory is already gone.
 */
export async function finishBackupUpload(uploadId: string, owner: string): Promise<StagedBackup> {
  const upload = getOwned(uploadId, owner);
  if (upload.busy) throw new BackupUploadError('A chunk of this upload is still being received', 409);
  pending.delete(upload.id);

  const cleanup = () => fs.rmSync(upload.dir, { recursive: true, force: true });
  try {
    if (upload.bytes < 16) throw new BackupUploadError('Backup file is too small or invalid');

    let dbPath = upload.partPath;
    const magic = readHead(upload.partPath, 2);
    // gzip files always start with 0x1f 0x8b.
    if (magic[0] === 0x1f && magic[1] === 0x8b) {
      dbPath = path.join(upload.dir, 'restore.db');
      try {
        await pipeline(
          fs.createReadStream(upload.partPath),
          zlib.createGunzip(),
          byteLimit((n) => (n > MAX_DB_BYTES ? 'Decompressed backup too large (max 8GB)' : null)),
          fs.createWriteStream(dbPath),
        );
      } catch (err) {
        if (err instanceof BackupUploadError) throw err;
        throw new BackupUploadError(`Failed to decompress gzip backup: ${String(err)}`);
      }
      fs.rmSync(upload.partPath, { force: true });
    }

    if (!readHead(dbPath, 16).toString('utf8').startsWith('SQLite format 3')) {
      throw new BackupUploadError('File does not appear to be a valid SQLite backup');
    }
    return { fileName: upload.fileName, dbPath, bytes: fs.statSync(dbPath).size, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Answer a failed upload step with its message and status. */
export function sendBackupUploadError(res: Response, err: unknown): Response {
  if (err instanceof BackupUploadError) return res.status(err.status).json({ error: err.message });
  return res.status(400).json({ error: `Backup upload failed: ${String(err)}` });
}

function getOwned(uploadId: string, owner: string): PendingUpload {
  const upload = pending.get(uploadId);
  if (!upload || upload.owner !== owner) {
    throw new BackupUploadError('Upload not found or expired — start the restore again', 404);
  }
  return upload;
}

function discard(upload: PendingUpload): void {
  pending.delete(upload.id);
  fs.rmSync(upload.dir, { recursive: true, force: true });
}

/**
 * Drop idle uploads, plus staging left on disk by a process that died
 * mid-restore (the map is gone, the directory is not).
 */
function sweepStale(parentDir: string): void {
  const cutoff = Date.now() - IDLE_TTL_MS;
  for (const upload of pending.values()) {
    if (!upload.busy && upload.touchedAt < cutoff) discard(upload);
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(parentDir);
  } catch {
    return;
  }
  const live = new Set([...pending.values()].map((u) => u.dir));
  for (const name of entries) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const full = path.join(parentDir, name);
    if (live.has(full)) continue;
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // Raced with another cleanup; nothing to do.
    }
  }
}

function readHead(filePath: string, length: number): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** Pass-through that counts bytes and fails once `check` returns a message. */
function byteLimit(check: (total: number) => string | null): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      total += chunk.length;
      const problem = check(total);
      callback(problem ? new BackupUploadError(problem, 413) : null, problem ? undefined : chunk);
    },
  });
}
