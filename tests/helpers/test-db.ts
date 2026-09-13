import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDb, getDb } from '../../src/data/database.js';
import { invalidate } from '../../src/utils/ttl-cache.js';
import { resetSummaryStateForTests } from '../../src/data/repositories/chest-summary-repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a fresh, isolated test database for one test (or test suite).
 *
 * Uses a unique temp-file SQLite database (not `:memory:`) so the v17
 * ChestTracker `ATTACH DATABASE` migration's `path.dirname(database.name)`
 * resolves to a real, empty directory and doesn't accidentally attach a
 * real `chesttracker.db` from the project root.
 *
 * Returns a `cleanup()` callback the caller MUST run in `afterEach` /
 * `afterAll` to close the connection and delete the temp file.
 *
 * NOTE: `initDatabase`/`getDb` use a module-level singleton, so only one
 * test database can be live at a time per worker process. Vitest runs
 * each test file in its own worker by default, so cross-file isolation
 * is automatic; within a file, tests must `await cleanup()` between
 * cases.
 */
export function makeTestDb(): { dbPath: string; cleanup: () => void } {
  // Ensure no leftover singleton from a previous test
  closeDb();

  // Aggregate caches and rollup-freshness counters are module singletons that
  // outlive the per-test DB swap — clear them so a fresh test DB can't be
  // served stale data keyed by (clan, params) from a previous test.
  invalidate('');
  resetSummaryStateForTests();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbcc-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  initDatabase(dbPath);

  const cleanup = (): void => {
    closeDb();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort — Windows sometimes holds files briefly after close.
    }
  };

  return { dbPath, cleanup };
}

/**
 * Convenience: insert a deterministic seed into the test DB.
 *
 * Adds a second clan (#2) so multi-clan scoping tests are meaningful;
 * clan #1 is auto-seeded by initDatabase. Returns the seeded ids so
 * tests can reference them without re-querying.
 */
export function seedTwoClans(): { clanIdA: number; clanIdB: number } {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO clans (id, name, slug, game_url, is_active, created_at)
     VALUES (2, ?, ?, ?, 1, ?)`,
  ).run('Clan #2', 'clan-2', 'https://totalbattle.com', now);
  return { clanIdA: 1, clanIdB: 2 };
}

/**
 * Seed enough rows to exercise every read path: a couple of members, a
 * couple of distinct chests, both a normal and a triumphal scan, and
 * three chest_records + one triumphal_chest_record. Returns the seeded
 * ids so tests can assert against them.
 *
 * Lives here (not in the route test files) so the route smoke tests
 * stay focused on HTTP shape rather than DB plumbing — and so adding
 * coverage for a new route doesn't require figuring out which seed
 * combinations hit the schema in interesting ways.
 *
 * The shape is deliberately minimal: 3 chest_records is enough that
 * GROUP BY queries return >1 row, distinct chests + sources exercise
 * the chests / chest_sources reference tables, and the triumphal row
 * proves that table also has data flowing through.
 */
export function seedChestData(clanId = 1): {
  members: { alice: number; bob: number };
  chests: { common: number; epic: number };
  sources: { crypt5: number; raid: number };
  sessionId: number;
} {
  const db = getDb();
  const now = new Date().toISOString();

  const memberAlice = db.prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (?, 'Alice', 'alice', ?, ?, 1) RETURNING id`,
  ).get(clanId, now, now) as { id: number };
  const memberBob = db.prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (?, 'Bob', 'bob', ?, ?, 1) RETURNING id`,
  ).get(clanId, now, now) as { id: number };

  // Reference rows. ON CONFLICT keeps the helper idempotent if a test
  // ever calls it twice (it doesn't today, but cheap insurance).
  const chestCommon = db.prepare(
    `INSERT INTO chests (name, chest_type) VALUES ('Common Chest', 'common')
     ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
  ).get() as { id: number };
  const chestEpic = db.prepare(
    `INSERT INTO chests (name, chest_type) VALUES ('Epic Chest', 'epic')
     ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
  ).get() as { id: number };
  const sourceCrypt = db.prepare(
    `INSERT INTO chest_sources (source) VALUES ('Level 5 Crypt')
     ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
  ).get() as { id: number };
  const sourceRaid = db.prepare(
    `INSERT INTO chest_sources (source) VALUES ('Raid')
     ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
  ).get() as { id: number };

  const session = db.prepare(
    `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
     VALUES (?, ?, ?, 'completed', 'manual') RETURNING id`,
  ).get(clanId, now, now) as { id: number };

  // 3 chest_records: 2 for Alice (one common from a crypt, one epic from a raid),
  // 1 for Bob (common from a crypt). Distinct captured_at to satisfy UNIQUE.
  db.prepare(
    `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0.95)`,
  ).run(clanId, session.id, memberAlice.id, chestCommon.id, sourceCrypt.id, 5, now);
  db.prepare(
    `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0.97)`,
  ).run(clanId, session.id, memberAlice.id, chestEpic.id, sourceRaid.id, 50, new Date(Date.now() + 1).toISOString());
  db.prepare(
    `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0.92)`,
  ).run(clanId, session.id, memberBob.id, chestCommon.id, sourceCrypt.id, 5, new Date(Date.now() + 2).toISOString());

  // 1 triumphal row so the /triumphal/* endpoints have data.
  db.prepare(
    `INSERT INTO triumphal_chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
     VALUES (?, ?, ?, ?, ?, 0, ?, 0.9)`,
  ).run(clanId, session.id, memberBob.id, chestEpic.id, sourceRaid.id, new Date(Date.now() + 3).toISOString());

  return {
    members: { alice: memberAlice.id, bob: memberBob.id },
    chests: { common: chestCommon.id, epic: chestEpic.id },
    sources: { crypt5: sourceCrypt.id, raid: sourceRaid.id },
    sessionId: session.id,
  };
}

/**
 * Bulk-seed a realistic volume of chest_records spread across members and
 * game-days, so query-plan assertions reflect what the planner does on
 * production-scale data (on a handful of rows SQLite may pick a full scan
 * regardless of indexes). Deterministic — no randomness — so plans and
 * counts are reproducible. Inserts in a single transaction for speed.
 *
 * The caller should run `ANALYZE` afterwards so the planner has stats.
 * Returns the member ids and the exact row count inserted.
 */
export function seedManyChests(opts: {
  clanId?: number;
  members?: number;
  days?: number;
  perMemberPerDay?: number;
} = {}): { clanId: number; memberIds: number[]; total: number } {
  const { clanId = 1, members = 100, days = 60, perMemberPerDay = 3 } = opts;
  const db = getDb();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const session = db.prepare(
    `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
     VALUES (?, ?, ?, 'completed', 'manual') RETURNING id`,
  ).get(clanId, nowIso, nowIso) as { id: number };

  const chestIds = [['Common Chest', 'common'], ['Rare Chest', 'rare'], ['Epic Chest', 'epic']].map(
    ([name, type]) => (db.prepare(
      `INSERT INTO chests (name, chest_type) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
    ).get(name, type) as { id: number }).id,
  );
  const sourceIds = ['Level 5 Crypt', 'Raid', 'Arena'].map(
    (s) => (db.prepare(
      `INSERT INTO chest_sources (source) VALUES (?)
       ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
    ).get(s) as { id: number }).id,
  );

  const insMember = db.prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (?, ?, ?, ?, ?, 1) RETURNING id`,
  );
  const insChest = db.prepare(
    `INSERT OR IGNORE INTO chest_records
       (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, 90)`,
  );

  const memberIds: number[] = [];
  let total = 0;
  db.transaction(() => {
    for (let m = 0; m < members; m++) {
      const name = `Member${clanId}_${m}`;
      memberIds.push(
        (insMember.get(clanId, name, name.toLowerCase(), nowIso, nowIso) as { id: number }).id,
      );
    }
    for (let m = 0; m < members; m++) {
      for (let d = 0; d < days; d++) {
        for (let k = 0; k < perMemberPerDay; k++) {
          // Day term dominates so timestamps never collide across days; the
          // (m,k) offset keeps same-day rows unique for the UNIQUE constraint.
          const capturedAt = nowMs - d * DAY_MS - (m * 7 + k) * 1000;
          const chestId = chestIds[(m + d + k) % chestIds.length];
          const sourceId = sourceIds[(m + k) % sourceIds.length];
          const pts = (((m + d + k) % 5) + 1) * 10;
          const res = insChest.run(clanId, session.id, memberIds[m], chestId, sourceId, pts, capturedAt);
          total += res.changes;
        }
      }
    }
  })();

  return { clanId, memberIds, total };
}
