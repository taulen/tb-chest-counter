import { describe, expect, it, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDb, getDb } from '../../src/data/database.js';
import { applyMergeRules } from '../../src/data/repositories/merge-repo.js';
import { invalidate } from '../../src/utils/ttl-cache.js';
import { resetSummaryStateForTests } from '../../src/data/repositories/chest-summary-repo.js';

/**
 * `cleanupChestNames` runs on EVERY boot, inside `initDatabase`. That makes its
 * failure modes unusually expensive: a throw here is not a failed rename, it is
 * an app that cannot start, with no recovery short of editing code.
 *
 * These tests reboot a real database — seed, close, reopen — because that is the
 * only way to exercise the pass, and it is also exactly how the bug would arrive
 * in production: someone edits KNOWN_CHESTS, and the next restart reconciles.
 */
let tmpDir: string | null = null;
afterEach(() => {
  closeDb();
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
    tmpDir = null;
  }
});

function freshPath(): string {
  invalidate('');
  resetSummaryStateForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbcc-cleanup-'));
  return path.join(tmpDir, 'test.db');
}

const NOW = new Date().toISOString();

/** Boot, run `seed`, close. The next initDatabase is the pass under test. */
function bootAndSeed(dbPath: string, seed: (db: ReturnType<typeof getDb>) => void): void {
  closeDb();
  initDatabase(dbPath);
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO members (id, clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (1, 1, 'Taulen', 'taulen', ?, ?, 1)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT OR IGNORE INTO scan_sessions (id, clan_id, started_at, status, trigger_source)
     VALUES (1, 1, ?, 'COMPLETED', 'manual')`,
  ).run(NOW);
  seed(db);
  closeDb();
}

describe('cleanupChestNames (boot-time rename pass)', () => {
  it('survives a merge whose records collide on the UNIQUE key', () => {
    // chest_records has UNIQUE(session_id, member_id, chest_id, captured_at), and
    // one scan really can hold several chests for one member at one instant —
    // 180 such groups in production. When a rename merges chest A into chest B and
    // B already has a row for that moment, a plain UPDATE throws SQLITE_CONSTRAINT
    // and the app never finishes booting. Migration v61 guards the identical merge;
    // this path did not.
    const dbPath = freshPath();
    bootAndSeed(dbPath, (db) => {
      const plain = (db.prepare(
        `INSERT INTO chests (name, chest_type) VALUES (?, 'common') RETURNING id`,
      ).get("Jormungandr's Chest") as { id: number }).id;
      const accented = (db.prepare(
        `INSERT INTO chests (name, chest_type) VALUES (?, 'common') RETURNING id`,
      ).get("Jörmungandr's Chest") as { id: number }).id;
      // Same session + member + instant, two chest ids — legal now, collides on merge.
      for (const id of [plain, accented]) {
        db.prepare(
          `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at, confidence)
           VALUES (1, 1, 1, ?, 0, 1700000000000, 100)`,
        ).run(id);
      }
      // Plus one that does NOT collide, which must be kept.
      db.prepare(
        `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at, confidence)
         VALUES (1, 1, 1, ?, 0, 1700000000001, 100)`,
      ).run(plain);
    });

    expect(() => initDatabase(dbPath)).not.toThrow();
    const db = getDb();
    expect((db.prepare('SELECT name FROM chests').all() as { name: string }[]).map((r) => r.name))
      .toEqual(["Jörmungandr's Chest"]);
    // The colliding pair is the same physical chest read under two spellings, so
    // one goes; the non-colliding row survives.
    expect((db.prepare('SELECT COUNT(*) AS n FROM chest_records').get() as { n: number }).n).toBe(2);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('carries a chest merge rule onto the new name without deleting the rule', () => {
    // merge_rules is the fourth name-keyed table and the only one nothing carried.
    // A rule left pointing at the dead name keeps rewriting fresh OCR onto it,
    // re-minting the `chests` row the rename just removed — but repointing
    // from_value too would collapse the rule onto itself and delete it, which
    // breaks it just as thoroughly in the other direction.
    const dbPath = freshPath();
    bootAndSeed(dbPath, (db) => {
      db.prepare(
        `INSERT INTO chests (name, chest_type) VALUES (?, 'common')`,
      ).run("Jormungandr's Chest");
      db.prepare(
        `INSERT INTO merge_rules (clan_id, type, from_value, to_value, created_at)
         VALUES (1, 'chest', 'Jormungandrs Chest', ?, ?)`,
      ).run("Jormungandr's Chest", NOW);
    });

    initDatabase(dbPath);
    const rule = getDb().prepare(
      "SELECT from_value, to_value FROM merge_rules WHERE type = 'chest'",
    ).get() as { from_value: string; to_value: string } | undefined;

    expect(rule?.to_value).toBe("Jörmungandr's Chest");
    // The variant the rule exists to catch is untouched.
    expect(rule?.from_value).toBe('Jormungandrs Chest');
  });

  it('carries the three name-keyed config tables across the rename', () => {
    const dbPath = freshPath();
    bootAndSeed(dbPath, (db) => {
      db.prepare(
        `INSERT INTO chests (name, chest_type) VALUES (?, 'common')`,
      ).run("Jormungandr's Chest");
      db.prepare(
        `INSERT INTO source_point_overrides (source_key, chest_name, point_value, updated_at)
         VALUES ('jormungandr shop', ?, 50, ?)`,
      ).run("Jormungandr's Chest", NOW);
      db.prepare(
        `INSERT INTO chest_type_overrides (clan_id, chest_name, chest_type, created_at)
         VALUES (1, ?, 'epic', ?)`,
      ).run("Jormungandr's Chest", NOW);
    });

    initDatabase(dbPath);
    const db = getDb();
    expect((db.prepare('SELECT chest_name FROM source_point_overrides').get() as { chest_name: string }).chest_name)
      .toBe("Jörmungandr's Chest");
    expect((db.prepare('SELECT chest_name FROM chest_type_overrides').get() as { chest_name: string }).chest_name)
      .toBe("Jörmungandr's Chest");
  });
});

describe('merge rule fuzzy matching folds accents', () => {
  it('matches an unaccented reading against an accented rule', () => {
    // normalize() ran `[^a-z0-9]` without folding first, so the "ö" of
    // "Jörmungandr Shop" was DELETED rather than turned into an "o"
    // ("jrmungandrshop"). The accented and unaccented readings of one source
    // therefore never compared equal — the last unfolded normalizer left after
    // v61/v62 fixed the same defect elsewhere.
    const dbPath = freshPath();
    closeDb();
    initDatabase(dbPath);
    const db = getDb();
    db.prepare(
      `INSERT INTO merge_rules (clan_id, type, from_value, to_value, created_at)
       VALUES (1, 'source', 'Jörmungandr Shop', 'Jormungandr Store', ?)`,
    ).run(NOW);

    expect(applyMergeRules('source', 'Jormungandr Shop', 1)).toBe('Jormungandr Store');
    // And the other direction.
    expect(applyMergeRules('source', 'Jörmungandr Shop', 1)).toBe('Jormungandr Store');
  });
});
