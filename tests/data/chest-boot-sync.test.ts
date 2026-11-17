import { describe, expect, it, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDb, getDb } from '../../src/data/database.js';
import { applyMergeRules } from '../../src/data/repositories/merge-repo.js';
import { invalidate } from '../../src/utils/ttl-cache.js';
import { resetSummaryStateForTests } from '../../src/data/repositories/chest-summary-repo.js';

/**
 * The chest passes in `initDatabase` run on EVERY boot. That makes their
 * failure modes unusually expensive: a throw there is an app that cannot start,
 * with no recovery short of editing code.
 *
 * These tests reboot a real database — seed, close, reopen — because that is the
 * only way to exercise a pass, and it is also exactly how a change would arrive
 * in production: someone edits CHEST_TYPES, and the next restart reconciles.
 *
 * (The boot-time rename pass, cleanupChestNames, went with the OCR spelling
 * corrector it ran: chests arrive under the game's own names, and stored names
 * stay as recorded.)
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

describe('syncChestTypes (boot-time type pass)', () => {
  it('gives a stored chest the type CHEST_TYPES declares, and leaves undeclared names alone', () => {
    const dbPath = freshPath();
    bootAndSeed(dbPath, (db) => {
      // Stored as common on first sight, before the list said legendary.
      db.prepare(`INSERT INTO chests (name, chest_type) VALUES ('Legendary Chest of Wealth', 'common')`).run();
      db.prepare(`INSERT INTO chests (name, chest_type) VALUES ('Pumpkin Chest', 'rare')`).run();
    });

    initDatabase(dbPath);
    const typeOf = (name: string): string =>
      (getDb().prepare('SELECT chest_type FROM chests WHERE name = ?').get(name) as { chest_type: string }).chest_type;
    expect(typeOf('Legendary Chest of Wealth')).toBe('legendary');
    expect(typeOf('Pumpkin Chest')).toBe('rare');
  });
});

describe('stored chest names (history stays as recorded)', () => {
  it('leaves every stored spelling alone on boot, OCR-era ones included', () => {
    // The retired rename pass rewrote these through the OCR corrector on every
    // boot ("Ore Chest" → "Orc Chest"). Nothing produces such spellings any
    // more, and a stored name is history: a merge rule is the way to fold one.
    const dbPath = freshPath();
    bootAndSeed(dbPath, (db) => {
      for (const name of ['Ore Chest', "Jormungandr's Chest", 'Connection lost']) {
        db.prepare(`INSERT INTO chests (name, chest_type) VALUES (?, 'common')`).run(name);
      }
    });

    initDatabase(dbPath);
    const names = (getDb().prepare('SELECT name FROM chests ORDER BY name').all() as { name: string }[])
      .map((r) => r.name);
    expect(names).toEqual(['Connection lost', "Jormungandr's Chest", 'Ore Chest']);
  });
});

describe('record views (v126)', () => {
  it('no longer carry the OCR-era confidence or crop path', () => {
    // confidence was the OCR parser's hard-coded 0.6, never a measurement; the
    // columns stay on the tables with their old values, unread.
    const dbPath = freshPath();
    closeDb();
    initDatabase(dbPath);
    const db = getDb();
    for (const view of ['chest_records_v', 'triumphal_chest_records_v']) {
      const cols = (db.prepare(`PRAGMA table_info(${view})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols, view).toContain('chest_type');
      expect(cols, view).not.toContain('confidence');
      expect(cols, view).not.toContain('debug_crop_path');
    }
    for (const table of ['chest_records', 'triumphal_chest_records']) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols, table).toContain('confidence');
    }
  });
});
