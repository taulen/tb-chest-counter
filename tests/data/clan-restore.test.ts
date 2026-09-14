import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { deleteClan } from '../../src/data/repositories/clan-repo.js';
import { inspectBackupClans, restoreClanFromBackup } from '../../src/data/clan-restore.js';
import { makeTestDb, seedTwoClans, seedChestData } from '../helpers/test-db.js';

/**
 * Undoing a clan deletion.
 *
 * `deleteClan` is a wide cascade across ~20 tables and the restore is its
 * mirror image, so the interesting property is not "does it insert rows" but
 * **does the clan come back identical** — same counts, same points, same
 * member→chest attribution — while the clan that was never deleted stays
 * byte-for-byte untouched.
 *
 * So these tests work by comparison rather than by hand-written expectations:
 * snapshot the database, delete, restore, and diff the two. A table the restore
 * forgets shows up as a count mismatch without anyone having to remember it
 * was there — which matters because the failure mode of a partial restore is
 * exactly the failure mode this project keeps hitting elsewhere: a zero that
 * reads like a result.
 */

const CLAN_B_NAME = 'Clan #2';

let ctx: { dbPath: string; cleanup: () => void };
let backupPath: string;

/** Checkpoint the WAL and copy the live file — what a real backup does. */
function snapshotDb(dbPath: string): string {
  getDb().pragma('wal_checkpoint(TRUNCATE)');
  const out = path.join(path.dirname(dbPath), 'snapshot.db');
  fs.copyFileSync(dbPath, out);
  return out;
}

/**
 * Seed one clan with a row in every table the restore has to carry, so a
 * forgotten table cannot hide behind an empty source.
 */
function seedEverything(clanId: number): void {
  const db = getDb();
  const now = new Date().toISOString();
  const seeded = seedChestData(clanId);

  db.prepare(
    `INSERT INTO member_snapshots (member_id, clan_id, level, power, captured_at, game_date)
     VALUES (?, ?, 30, 5000000, ?, '2026-09-01')`,
  ).run(seeded.members.alice, clanId, now);

  db.prepare(
    `INSERT INTO chest_daily_summary (clan_id, member_id, game_day, chests, points, earned_chests, earned_points)
     VALUES (?, ?, '2026-09-01', 2, 55, 2, 55)`,
  ).run(clanId, seeded.members.alice);

  db.prepare(
    `INSERT INTO merge_rules (clan_id, type, from_value, to_value, created_at)
     VALUES (?, 'player', ?, 'Alice', ?)`,
  ).run(clanId, `Ailce${clanId}`, now);

  db.prepare(
    `INSERT INTO chest_type_overrides (clan_id, chest_name, chest_type, created_at)
     VALUES (?, 'Common Chest', 'rare', ?)`,
  ).run(clanId, now);

  db.prepare(
    `INSERT INTO review_acknowledgments (clan_id, category, acknowledged_at) VALUES (?, 'member', ?)`,
  ).run(clanId, now);

  const batch = db.prepare(
    `INSERT INTO resource_upload_batches (clan_id, uploaded_at, upload_date, row_count, source)
     VALUES (?, ?, '2026-09-01', 2, 'capture') RETURNING id`,
  ).get(clanId, now) as { id: number };

  const resourceType = db.prepare('SELECT id FROM resource_types ORDER BY id LIMIT 1').get() as { id: number };
  for (const [direction, amount] of [[1, 12345], [-1, 999]] as const) {
    db.prepare(
      `INSERT INTO resource_transactions
         (clan_id, batch_id, member_id, resource_type_id, direction, amount, transaction_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '2026-09-01', ?)`,
    ).run(clanId, batch.id, seeded.members.bob, resourceType.id, direction, amount, now);
  }

  db.prepare(
    `INSERT INTO resource_icon_templates (clan_id, resource_type_id, template_data, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(clanId, resourceType.id, Buffer.from([1, 2, 3, 4]), now);

  db.prepare(
    `INSERT INTO resource_capture_cursor (clan_id, top_rows, game_date, captured_at, newest_date, rows_inserted)
     VALUES (?, '["a","b"]', '2026-09-01', ?, '2026-08-31', 7)`,
  ).run(clanId, now);

  const link = db.prepare(
    `INSERT INTO share_links (clan_id, token, created_at, hit_count) VALUES (?, ?, ?, 12) RETURNING id`,
  ).get(clanId, `tok-${clanId}`, now) as { id: number };
  db.prepare(
    `INSERT INTO share_link_daily (link_id, day, views) VALUES (?, '2026-09-01', 4)`,
  ).run(link.id);

  db.prepare(
    `INSERT INTO discord_member_links (clan_id, discord_user_id, member_id, linked_at) VALUES (?, ?, ?, ?)`,
  ).run(clanId, `discord-${clanId}`, seeded.members.alice, now);

  // ChestTracker ingest: snapshot -> player rows -> chest definitions.
  const playerRef = db.prepare(
    'INSERT INTO ct_player_ref (clan_id, name) VALUES (?, ?) RETURNING id',
  ).get(clanId, `CtPlayer${clanId}`) as { id: number };
  const snapshot = db.prepare(
    `INSERT INTO snapshot (clan_id, fetched_at, share_code, window_start, window_end, duration_days,
                           player_count, total_chests, total_points)
     VALUES (?, ?, 'SHARE1', '2026-08-25', '2026-09-01', 7, 1, 3, 60) RETURNING id`,
  ).get(clanId, now) as { id: number };
  db.prepare(
    `INSERT INTO player_snapshot (snapshot_id, player_ref_id, guards_level, points, chests, clan_id)
     VALUES (?, ?, 4, 60, 3, ?)`,
  ).run(snapshot.id, playerRef.id, clanId);
  db.prepare(
    `INSERT INTO player_category (snapshot_id, player_ref_id, category, chests, clan_id)
     VALUES (?, ?, 'Crypt', 3, ?)`,
  ).run(snapshot.id, playerRef.id, clanId);
  // Global and uniquely keyed on (type, name, source) — the second clan seeded
  // shares the row rather than minting its own, which is exactly the shape the
  // restore's reference mapping has to cope with.
  const defRef = db.prepare(
    `INSERT INTO chest_definition_ref (type, name, source, points)
     VALUES ('common', 'Common Chest', 'Level 5 Crypt', 5)
     ON CONFLICT DO UPDATE SET points = excluded.points RETURNING id`,
  ).get() as { id: number };
  db.prepare(
    `INSERT INTO snapshot_chest_definition (snapshot_id, chest_definition_ref_id, clan_id) VALUES (?, ?, ?)`,
  ).run(snapshot.id, defRef.id, clanId);

  db.prepare(
    `INSERT INTO poll_log (polled_at, share_code, window_start, window_end, trigger, status, clan_id)
     VALUES (?, 'SHARE1', '2026-08-25', '2026-09-01', 'scheduled', 200, ?)`,
  ).run(now, clanId);
}

/** Every table the restore is responsible for, scoped to one clan. */
const SCOPED_COUNTS: Record<string, (clanId: number) => string> = {
  members: (c) => `SELECT COUNT(*) n FROM members WHERE clan_id = ${c}`,
  scan_sessions: (c) => `SELECT COUNT(*) n FROM scan_sessions WHERE clan_id = ${c}`,
  chest_records: (c) => `SELECT COUNT(*) n FROM chest_records WHERE clan_id = ${c}`,
  triumphal_chest_records: (c) => `SELECT COUNT(*) n FROM triumphal_chest_records WHERE clan_id = ${c}`,
  member_snapshots: (c) => `SELECT COUNT(*) n FROM member_snapshots WHERE member_id IN (SELECT id FROM members WHERE clan_id = ${c})`,
  chest_daily_summary: (c) => `SELECT COUNT(*) n FROM chest_daily_summary WHERE clan_id = ${c}`,
  merge_rules: (c) => `SELECT COUNT(*) n FROM merge_rules WHERE clan_id = ${c}`,
  chest_type_overrides: (c) => `SELECT COUNT(*) n FROM chest_type_overrides WHERE clan_id = ${c}`,
  review_acknowledgments: (c) => `SELECT COUNT(*) n FROM review_acknowledgments WHERE clan_id = ${c}`,
  resource_upload_batches: (c) => `SELECT COUNT(*) n FROM resource_upload_batches WHERE clan_id = ${c}`,
  resource_transactions: (c) => `SELECT COUNT(*) n FROM resource_transactions WHERE clan_id = ${c}`,
  resource_icon_templates: (c) => `SELECT COUNT(*) n FROM resource_icon_templates WHERE clan_id = ${c}`,
  resource_capture_cursor: (c) => `SELECT COUNT(*) n FROM resource_capture_cursor WHERE clan_id = ${c}`,
  share_links: (c) => `SELECT COUNT(*) n FROM share_links WHERE clan_id = ${c}`,
  share_link_daily: (c) => `SELECT COUNT(*) n FROM share_link_daily WHERE link_id IN (SELECT id FROM share_links WHERE clan_id = ${c})`,
  discord_member_links: (c) => `SELECT COUNT(*) n FROM discord_member_links WHERE clan_id = ${c}`,
  ct_player_ref: (c) => `SELECT COUNT(*) n FROM ct_player_ref WHERE clan_id = ${c}`,
  snapshot: (c) => `SELECT COUNT(*) n FROM snapshot WHERE clan_id = ${c}`,
  player_snapshot: (c) => `SELECT COUNT(*) n FROM player_snapshot WHERE clan_id = ${c}`,
  player_category: (c) => `SELECT COUNT(*) n FROM player_category WHERE clan_id = ${c}`,
  snapshot_chest_definition: (c) => `SELECT COUNT(*) n FROM snapshot_chest_definition WHERE snapshot_id IN (SELECT id FROM snapshot WHERE clan_id = ${c})`,
  poll_log: (c) => `SELECT COUNT(*) n FROM poll_log WHERE clan_id = ${c}`,
};

function countsFor(clanId: number): Record<string, number> {
  const db = getDb();
  const out: Record<string, number> = {};
  for (const [table, sql] of Object.entries(SCOPED_COUNTS)) {
    out[table] = (db.prepare(sql(clanId)).get() as { n: number }).n;
  }
  return out;
}

/** Points per member name — proves the id remapping kept the attribution. */
function pointsByMember(clanId: number): Record<string, number> {
  const rows = getDb().prepare(
    `SELECT m.name AS name, SUM(r.point_value) AS pts
       FROM chest_records r JOIN members m ON m.id = r.member_id
      WHERE r.clan_id = ? GROUP BY m.name ORDER BY m.name`,
  ).all(clanId) as { name: string; pts: number }[];
  return Object.fromEntries(rows.map((r) => [r.name, r.pts]));
}

describe('restoreClanFromBackup', () => {
  beforeEach(() => {
    ctx = makeTestDb();
    seedTwoClans();
    seedEverything(1);
    seedEverything(2);
    backupPath = snapshotDb(ctx.dbPath);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('brings a deleted clan back identical, and leaves the other clan alone', () => {
    const expectedB = countsFor(2);
    const expectedBPoints = pointsByMember(2);
    const expectedA = countsFor(1);
    const expectedAPoints = pointsByMember(1);

    expect(deleteClan(2)).toEqual({ ok: true });
    expect(countsFor(2).chest_records).toBe(0);

    const result = restoreClanFromBackup(backupPath, 2);
    expect(result.clanId).toBe(2);
    expect(result.name).toBe(CLAN_B_NAME);

    expect(countsFor(2)).toEqual(expectedB);
    expect(pointsByMember(2)).toEqual(expectedBPoints);
    expect(countsFor(1)).toEqual(expectedA);
    expect(pointsByMember(1)).toEqual(expectedAPoints);

    expect(getDb().pragma('foreign_key_check')).toEqual([]);
  });

  it('reports every table it wrote, and nothing it did not', () => {
    deleteClan(2);
    const result = restoreClanFromBackup(backupPath, 2);

    // Every seeded table appears in the report with a non-zero count — the
    // guard against a table being silently skipped rather than restored empty.
    for (const table of Object.keys(SCOPED_COUNTS)) {
      expect(result.tables[table], `${table} missing from restore report`).toBeGreaterThan(0);
    }
    expect(result.totalRows).toBe(
      Object.values(result.tables).reduce((a, b) => a + b, 0),
    );
    // Accounts are deliberately not part of a data restore.
    expect(result.tables.users).toBeUndefined();
    expect(result.tables.audit_log).toBeUndefined();
  });

  it('matches global reference rows instead of duplicating them', () => {
    const db = getDb();
    deleteClan(2);
    const chestsBefore = (db.prepare('SELECT COUNT(*) n FROM chests').get() as { n: number }).n;
    const sourcesBefore = (db.prepare('SELECT COUNT(*) n FROM chest_sources').get() as { n: number }).n;
    const typesBefore = (db.prepare('SELECT COUNT(*) n FROM resource_types').get() as { n: number }).n;

    restoreClanFromBackup(backupPath, 2);

    // Clan 1 still holds every chest name clan 2 used, so nothing new is minted.
    expect((db.prepare('SELECT COUNT(*) n FROM chests').get() as { n: number }).n).toBe(chestsBefore);
    expect((db.prepare('SELECT COUNT(*) n FROM chest_sources').get() as { n: number }).n).toBe(sourcesBefore);
    expect((db.prepare('SELECT COUNT(*) n FROM resource_types').get() as { n: number }).n).toBe(typesBefore);

    // And the restored rows point at those live rows, not at dangling ids.
    const orphans = db.prepare(
      `SELECT COUNT(*) n FROM chest_records r
        WHERE r.clan_id = 2 AND NOT EXISTS (SELECT 1 FROM chests c WHERE c.id = r.chest_id)`,
    ).get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it('refuses when a live clan already holds that name', () => {
    // Clan 2 was never deleted — restoring on top of it would double every row.
    expect(() => restoreClanFromBackup(backupPath, 2)).toThrow(/already live/i);
  });

  it('lands on a fresh id when the original is taken by a different clan', () => {
    const db = getDb();
    deleteClan(2);
    db.prepare(
      `INSERT INTO clans (id, name, slug, game_url, is_active, created_at)
       VALUES (2, 'Someone Else', 'someone-else', 'https://totalbattle.com', 1, ?)`,
    ).run(new Date().toISOString());

    const result = restoreClanFromBackup(backupPath, 2);
    expect(result.clanId).toBeGreaterThan(2);
    expect(result.name).toBe(CLAN_B_NAME);
    expect(countsFor(result.clanId).chest_records).toBeGreaterThan(0);
    expect(getDb().pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back completely when the restore cannot finish', () => {
    const db = getDb();
    deleteClan(2);
    const before = countsFor(2);
    expect(() => restoreClanFromBackup(backupPath, 999)).toThrow(/no clan with id 999/i);
    expect(countsFor(2)).toEqual(before);
  });
});

describe('inspectBackupClans', () => {
  beforeEach(() => {
    ctx = makeTestDb();
    seedTwoClans();
    seedEverything(1);
    seedEverything(2);
    backupPath = snapshotDb(ctx.dbPath);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('lists both clans with their counts and flags what is already live', () => {
    deleteClan(2);
    const inspection = inspectBackupClans(backupPath);

    expect(inspection.schemaVersion).toBeGreaterThan(0);
    expect(inspection.clans.map((c) => c.clanId)).toEqual([1, 2]);

    const a = inspection.clans.find((c) => c.clanId === 1)!;
    expect(a.nameTakenLive).toBe(true);
    expect(a.idTakenLive).toBe(true);

    const b = inspection.clans.find((c) => c.clanId === 2)!;
    expect(b.name).toBe(CLAN_B_NAME);
    expect(b.nameTakenLive).toBe(false);
    expect(b.idTakenLive).toBe(false);
    expect(b.counts.members).toBe(2);
    expect(b.counts.chestRecords).toBe(3);
    expect(b.counts.triumphalRecords).toBe(1);
    expect(b.counts.resourceTransactions).toBe(2);
    expect(b.newestChestAt).not.toBeNull();
  });

  it('does not write to the backup file it reads', () => {
    const before = fs.statSync(backupPath);
    inspectBackupClans(backupPath);
    const after = fs.statSync(backupPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(fs.existsSync(`${backupPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${backupPath}-shm`)).toBe(false);
  });
});
