import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import { getDb } from '../../../src/data/database.js';
import {
  createBatch,
  insertTransactions,
  listTransactions,
  getRowCropPath,
  deleteBatch,
} from '../../../src/data/repositories/resource-repo.js';
import { upsertMember, getMemberEvidenceCropPath } from '../../../src/data/repositories/member-repo.js';
import { getReviewQueue } from '../../../src/data/repositories/review-queue-repo.js';

/**
 * Row crops are the evidence an admin hovers while resolving an unresolved
 * resource-import row. The path lives in the DB and the PNG on disk, so the two
 * have to stay in step: served only for the owning clan, and cleaned up when the
 * batch that produced them is deleted.
 */
describe('resource row crops', () => {
  let cleanup: () => void;
  let cropDir: string;

  let userId: number;

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    cropDir = fs.mkdtempSync(path.join(os.tmpdir(), 'row-crops-'));
    // resource_upload_batches.uploaded_by is an FK to users(id).
    userId = getDb().prepare(
      "INSERT INTO users (username, password_hash, role, created_at) VALUES ('t', 'x', 'admin', '2026-07-27')",
    ).run().lastInsertRowid as number;
  });

  afterEach(() => {
    cleanup();
    fs.rmSync(cropDir, { recursive: true, force: true });
  });

  function makeCropFile(name: string): string {
    const p = path.join(cropDir, name);
    fs.writeFileSync(p, 'not-really-a-png');
    return p;
  }

  function newBatch(clanId: number) {
    return createBatch({
      clanId, uploadedBy: userId, uploadDate: '2026-07-27',
      fileCount: 1, rowCount: 1, errorCount: 0, notes: '',
    });
  }

  it('reports hasCrop only for rows that kept one, and returns the stored path', () => {
    const member = upsertMember('Taulen', 1);
    const batch = newBatch(1);
    const cropPath = makeCropFile('row0.png');

    insertTransactions([
      {
        clanId: 1, batchId: batch.id, memberId: member.id, resourceTypeId: null,
        direction: 1, amount: 500, transactionDate: '2026-07-27',
        rawPlayerName: 'Taulen', rowCropPath: cropPath,
      },
      {
        clanId: 1, batchId: batch.id, memberId: member.id, resourceTypeId: 1,
        direction: 1, amount: 900, transactionDate: '2026-07-27',
        rawPlayerName: 'Taulen', rowCropPath: null,
      },
    ]);

    const { rows } = listTransactions({ clanId: 1, limit: 50, offset: 0, sortBy: 'amount', sortDir: 'asc' });
    expect(rows).toHaveLength(2);
    const withCrop = rows.find((r) => r.amount === 500)!;
    const withoutCrop = rows.find((r) => r.amount === 900)!;
    expect(withCrop.hasCrop).toBe(true);
    expect(withoutCrop.hasCrop).toBe(false);
    expect(getRowCropPath(withCrop.id, 1)).toBe(cropPath);
    expect(getRowCropPath(withoutCrop.id, 1)).toBeNull();
  });

  it('will not hand a crop path to another clan', () => {
    const { clanIdB } = seedTwoClans();
    const member = upsertMember('Taulen', 1);
    const batch = newBatch(1);
    const cropPath = makeCropFile('scoped.png');

    insertTransactions([{
      clanId: 1, batchId: batch.id, memberId: member.id, resourceTypeId: null,
      direction: 1, amount: 500, transactionDate: '2026-07-27',
      rawPlayerName: 'Taulen', rowCropPath: cropPath,
    }]);
    const { rows } = listTransactions({ clanId: 1, limit: 50, offset: 0 });

    expect(getRowCropPath(rows[0].id, 1)).toBe(cropPath);
    // Same transaction id, wrong clan — must not resolve.
    expect(getRowCropPath(rows[0].id, clanIdB)).toBeNull();
  });

  it('deletes the crop files on disk when the batch is deleted', () => {
    const member = upsertMember('Taulen', 1);
    const batch = newBatch(1);
    const a = makeCropFile('a.png');
    const b = makeCropFile('b.png');

    insertTransactions([
      {
        clanId: 1, batchId: batch.id, memberId: member.id, resourceTypeId: null,
        direction: 1, amount: 500, transactionDate: '2026-07-27',
        rawPlayerName: 'Taulen', rowCropPath: a,
      },
      {
        clanId: 1, batchId: batch.id, memberId: member.id, resourceTypeId: null,
        direction: 1, amount: 600, transactionDate: '2026-07-27',
        rawPlayerName: 'Taulen', rowCropPath: b,
      },
    ]);

    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);

    deleteBatch(batch.id, 1);

    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    expect(listTransactions({ clanId: 1, limit: 50, offset: 0 }).rows).toHaveLength(0);
  });

  it('deleting a batch does not remove another batch\'s crops', () => {
    const member = upsertMember('Taulen', 1);
    const keep = newBatch(1);
    const drop = newBatch(1);
    const keepCrop = makeCropFile('keep.png');
    const dropCrop = makeCropFile('drop.png');

    insertTransactions([
      {
        clanId: 1, batchId: keep.id, memberId: member.id, resourceTypeId: null,
        direction: 1, amount: 500, transactionDate: '2026-07-27',
        rawPlayerName: 'Taulen', rowCropPath: keepCrop,
      },
      {
        clanId: 1, batchId: drop.id, memberId: member.id, resourceTypeId: null,
        direction: 1, amount: 600, transactionDate: '2026-07-27',
        rawPlayerName: 'Taulen', rowCropPath: dropCrop,
      },
    ]);

    deleteBatch(drop.id, 1);

    expect(fs.existsSync(dropCrop)).toBe(false);
    expect(fs.existsSync(keepCrop)).toBe(true);
  });

  // ── member evidence crop: what the "New Members" review-queue hover resolves ──

  it('prefers the resource row crop over a chest crop for the same member', () => {
    const db = getDb();
    const member = upsertMember('Taulen', 1);
    const batch = newBatch(1);
    const resourceCrop = makeCropFile('resource.png');
    const chestCrop = makeCropFile('chest.png');

    // A chest row for the same member, also carrying a crop.
    const session = db.prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, status, trigger_source)
       VALUES (1, '2026-07-27T00:00:00Z', 'COMPLETED', 'manual') RETURNING id`,
    ).get() as { id: number };
    const chest = db.prepare(
      "INSERT INTO chests (name, chest_type) VALUES ('Runic Chest', 'common') RETURNING id",
    ).get() as { id: number };
    db.prepare(
      `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at, confidence, debug_crop_path)
       VALUES (1, ?, ?, ?, 0, 1000, 90, ?)`,
    ).run(session.id, member.id, chest.id, chestCrop);

    insertTransactions([{
      clanId: 1, batchId: batch.id, memberId: member.id, resourceTypeId: null,
      direction: 1, amount: 500, transactionDate: '2026-07-27',
      rawPlayerName: 'Taulen', rowCropPath: resourceCrop,
    }]);

    // The resource crop is a single outlined row; the chest crop is a whole batch.
    expect(getMemberEvidenceCropPath(member.id, 1)).toBe(resourceCrop);
    // ...and it is what the review queue reports as available.
    const entry = getReviewQueue(1).members.entries.find((e) => e.value === 'Taulen');
    expect(entry?.hasCrop).toBe(true);
    expect(entry?.memberId).toBe(member.id);
  });

  it('falls back to the chest crop when the member has no resource crop', () => {
    const db = getDb();
    const member = upsertMember('Taulen', 1);
    const chestCrop = makeCropFile('chest-only.png');
    const session = db.prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, status, trigger_source)
       VALUES (1, '2026-07-27T00:00:00Z', 'COMPLETED', 'manual') RETURNING id`,
    ).get() as { id: number };
    const chest = db.prepare(
      "INSERT INTO chests (name, chest_type) VALUES ('Runic Chest', 'common') RETURNING id",
    ).get() as { id: number };
    db.prepare(
      `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at, confidence, debug_crop_path)
       VALUES (1, ?, ?, ?, 0, 1000, 90, ?)`,
    ).run(session.id, member.id, chest.id, chestCrop);

    expect(getMemberEvidenceCropPath(member.id, 1)).toBe(chestCrop);
    expect(getReviewQueue(1).members.entries.find((e) => e.value === 'Taulen')?.hasCrop).toBe(true);
  });

  it('reports no crop for a member with none, and is clan-scoped', () => {
    const { clanIdB } = seedTwoClans();
    const member = upsertMember('Taulen', 1);
    const batch = newBatch(1);
    const crop = makeCropFile('scoped-member.png');

    insertTransactions([{
      clanId: 1, batchId: batch.id, memberId: member.id, resourceTypeId: null,
      direction: 1, amount: 500, transactionDate: '2026-07-27',
      rawPlayerName: 'Taulen', rowCropPath: crop,
    }]);

    expect(getMemberEvidenceCropPath(member.id, 1)).toBe(crop);
    expect(getMemberEvidenceCropPath(member.id, clanIdB)).toBeNull();

    const other = upsertMember('NoEvidence', 1);
    expect(getMemberEvidenceCropPath(other.id, 1)).toBeNull();
    expect(getReviewQueue(1).members.entries.find((e) => e.value === 'NoEvidence')?.hasCrop).toBe(false);
  });

  it('survives a crop file that is already gone', () => {
    const member = upsertMember('Taulen', 1);
    const batch = newBatch(1);
    const missing = path.join(cropDir, 'never-written.png');

    insertTransactions([{
      clanId: 1, batchId: batch.id, memberId: member.id, resourceTypeId: null,
      direction: 1, amount: 500, transactionDate: '2026-07-27',
      rawPlayerName: 'Taulen', rowCropPath: missing,
    }]);

    expect(() => deleteBatch(batch.id, 1)).not.toThrow();
    expect(listTransactions({ clanId: 1, limit: 50, offset: 0 }).rows).toHaveLength(0);
  });

  /**
   * Within one day the list has to read the way the GAME reads it: newest at the top.
   *
   * Both importers walk the list newest-first, so the newest row of a day is inserted
   * first and carries the LOWEST id. The tie-break used to be `rt.id DESC`, which turned
   * every day upside down and left its newest entry at the bottom of the group.
   */
  it('orders rows within a day newest-first, matching the game', () => {
    const member = upsertMember('Taulen', 1);
    const batch = newBatch(1);
    const row = (amount: number, transactionDate: string) => ({
      clanId: 1, batchId: batch.id, memberId: member.id, resourceTypeId: 1,
      direction: 1 as const, amount, transactionDate,
      rawPlayerName: 'Taulen', rowCropPath: null,
    });

    // Insertion order is the order the importer read them, i.e. newest first.
    insertTransactions([
      row(300, '2026-07-27'), row(200, '2026-07-27'), row(100, '2026-07-27'),
      row(900, '2026-07-26'), row(800, '2026-07-26'),
    ]);

    const label = (r: { transactionDate: string; amount: number }) => `${r.transactionDate}:${r.amount}`;

    const desc = listTransactions({ clanId: 1, limit: 50, offset: 0, sortBy: 'date', sortDir: 'desc' }).rows;
    expect(desc.map(label)).toEqual([
      '2026-07-27:300', '2026-07-27:200', '2026-07-27:100',
      '2026-07-26:900', '2026-07-26:800',
    ]);

    // Oldest day first flips the days AND the rows inside each one.
    const asc = listTransactions({ clanId: 1, limit: 50, offset: 0, sortBy: 'date', sortDir: 'asc' }).rows;
    expect(asc.map(label)).toEqual([
      '2026-07-26:800', '2026-07-26:900',
      '2026-07-27:100', '2026-07-27:200', '2026-07-27:300',
    ]);
  });
});
