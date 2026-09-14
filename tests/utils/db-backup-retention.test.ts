import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPreActionBackup, listBackups } from '../../src/utils/db-backup.js';
import { makeTestDb } from '../helpers/test-db.js';

/**
 * Retention has one rule that is not about disk space: **never prune the file
 * the caller is about to read.**
 *
 * Restoring a clan out of an old `pre-delete-clan-*` snapshot takes a snapshot
 * of its own first — which is itself a pre-action file, so it makes a fourth
 * under a keep-3 policy, and the prune then takes the oldest. The oldest is the
 * snapshot being restored FROM. Without `protect` the restore deletes its own
 * source before reading a single row, and the operator gets an ENOENT on the
 * one click that mattered.
 *
 * Nothing about that is visible from the retention policy alone, so it is
 * pinned here.
 */

let ctx: { dbPath: string; cleanup: () => void };
let backupsDir: string;

/** Write a backup file directly, with a chosen age, bypassing the real writer. */
function plantBackup(name: string, ageMinutes: number): string {
  const full = path.join(backupsDir, name);
  fs.writeFileSync(full, 'not a real database, only its name matters here');
  const when = new Date(Date.now() - ageMinutes * 60 * 1000);
  fs.utimesSync(full, when, when);
  return full;
}

describe('pre-action backup retention', () => {
  beforeEach(() => {
    ctx = makeTestDb();
    backupsDir = path.join(path.dirname(ctx.dbPath), 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
  });

  afterEach(() => ctx.cleanup());

  it('prunes the oldest pre-action snapshot once a fourth is written', async () => {
    // Aged past the debounce window so the new snapshot actually writes.
    const oldest = plantBackup('2026-09-01T00-00-00-000Z-pre-delete-clan-Oldest.db.gz', 60 * 24 * 5);
    plantBackup('2026-09-02T00-00-00-000Z-pre-delete-clan-B.db.gz', 60 * 24 * 4);
    plantBackup('2026-09-03T00-00-00-000Z-pre-delete-clan-C.db.gz', 60 * 24 * 3);

    await createPreActionBackup('pre-action-restore-clan-2');

    expect(fs.existsSync(oldest)).toBe(false);
    expect(listBackups().filter((b) => b.kind === 'pre-action')).toHaveLength(3);
  });

  it('keeps the snapshot named by `protect`, even when it is the prune target', async () => {
    const restoringFrom = '2026-09-01T00-00-00-000Z-pre-delete-clan-Oldest.db.gz';
    const source = plantBackup(restoringFrom, 60 * 24 * 5);
    const second = plantBackup('2026-09-02T00-00-00-000Z-pre-delete-clan-B.db.gz', 60 * 24 * 4);
    plantBackup('2026-09-03T00-00-00-000Z-pre-delete-clan-C.db.gz', 60 * 24 * 3);

    await createPreActionBackup('pre-action-restore-clan-2', { protect: restoringFrom });

    expect(fs.existsSync(source), 'the restore deleted its own source').toBe(true);
    // A protected file is stepped over entirely rather than counted, so the
    // keep-3 budget applies to the other three and the directory sits at four
    // for one cycle. That is the intended trade: the next pre-action write,
    // which protects nothing, trims it straight back.
    expect(fs.existsSync(second)).toBe(true);
    expect(listBackups().filter((b) => b.kind === 'pre-action')).toHaveLength(4);
  });

  it('debounces a burst rather than snapshotting on every click', async () => {
    const first = await createPreActionBackup('pre-delete-clan-A');
    const second = await createPreActionBackup('pre-delete-clan-B');
    expect(second).toBe(first);
  });
});
