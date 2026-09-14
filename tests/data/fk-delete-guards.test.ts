import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { deleteClan } from '../../src/data/repositories/clan-repo.js';
import { deleteUser } from '../../src/data/repositories/user-repo.js';
import { deleteOrphanedEmptyMembers } from '../../src/data/repositories/chest-repo.js';
import { addMergeRule } from '../../src/data/repositories/merge-repo.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

/**
 * Guard for hard-delete paths against schema drift.
 *
 * Every one of these paths ends in `DELETE FROM <parent>`, so it has to
 * account for EVERY table holding an FK to that parent. The recurring bug is
 * not that someone wrote the delete wrong — it's that a later feature adds a
 * new referencing table and nothing points back at the delete that now has a
 * hole. That is invisible to hand-written test cases: you only write the case
 * for the table you already remembered, which is the same table you didn't
 * forget.
 *
 * So this file works from the live schema instead:
 *
 *   1. EXPECTED_CHILDREN is compared against `PRAGMA foreign_key_list` at
 *      runtime. Add a table that references members/users/clans and this
 *      fails immediately, naming the delete paths that need auditing.
 *   2. The behavioural tests seed a row in every child table and then run the
 *      real delete, proving the current code actually handles them all.
 *
 * When (1) fails: fix the delete path, seed the new table in seedEverything()
 * below, then add it to EXPECTED_CHILDREN. In that order.
 */

const DELETE_PATHS: Record<string, string> = {
  members: 'merge-repo.addMergeRule(player), chest-repo.deleteOrphanedEmptyMembers, clan-repo.deleteClan',
  users: 'user-repo.deleteUser',
  clans: 'clan-repo.deleteClan',
  chest_sources: 'merge-repo.addMergeRule(source), database.ts migration v63',
};

const EXPECTED_CHILDREN: Record<string, string[]> = {
  members: [
    'chest_records.member_id',
    // ON DELETE CASCADE, so the member deletes take it out on their own —
    // still listed, because the point of this file is that every FK is
    // accounted for deliberately rather than by luck.
    'discord_member_links.member_id',
    'member_snapshots.member_id',
    'resource_transactions.member_id',
    'triumphal_chest_records.member_id',
  ],
  users: [
    'audit_log.user_id',
    'clans.created_by',
    'resource_upload_batches.uploaded_by',
    'share_links.created_by',
    'share_links.revoked_by',
    'user_sessions.user_id',
    'users.created_by',
  ],
  clans: [
    'audit_log.clan_id',
    'chest_type_overrides.clan_id',
    'discord_member_links.clan_id',
    'members.clan_id',
    'merge_rules.clan_id',
    'resource_capture_cursor.clan_id',
    'resource_icon_templates.clan_id',
    'resource_transactions.clan_id',
    'resource_upload_batches.clan_id',
    'review_acknowledgments.clan_id',
    'share_links.clan_id',
    'user_sessions.active_clan_id',
    'users.clan_id',
  ],
  // Two paths hard-delete a chest_sources row: the admin source merge, and
  // migration v63's duplicate-spelling cleanup. Both must repoint every
  // referencing table first, or a record is left pointing at a gap.
  chest_sources: [
    'chest_records.chest_source_id',
    'triumphal_chest_records.chest_source_id',
  ],
};

function liveChildren(parent: string): string[] {
  const db = getDb();
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all() as { name: string }[]).map((r) => r.name);
  const out: string[] = [];
  for (const t of tables) {
    const fks = db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as
      { table: string; from: string }[];
    for (const fk of fks) if (fk.table === parent) out.push(`${t}.${fk.from}`);
  }
  return out.sort();
}

/**
 * Populate one row in every table that references clan 2, its member, and
 * user 2 — i.e. the worst case each delete path has to survive.
 *
 * Plus the handful of CLAN-SCOPED tables that carry a clan_id with no foreign
 * key behind it: chest_daily_summary and the ChestTracker ingest chain. The
 * drift detector above is built from `PRAGMA foreign_key_list` and is blind to
 * those by construction, which is exactly how the ingest tables stayed in
 * deleteClan's blind spot — a deleted clan's poll history and snapshots simply
 * stayed in the database. They are seeded here so the behavioural test can
 * assert on them directly.
 */
function seedEverything(): { clanId: number; userId: number; memberId: number } {
  const db = getDb();
  const now = new Date().toISOString();
  const clanId = 2;

  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at, clan_id)
     VALUES (1, 'super', 'x', 'superadmin', ?, NULL)`,
  ).run(now);
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at, clan_id, created_by)
     VALUES (2, 'admin2', 'x', 'admin', ?, ?, 1)`,
  ).run(now, clanId);
  // users.created_by pointing AT the user being deleted.
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at, clan_id, created_by)
     VALUES (3, 'made-by-2', 'x', 'user', ?, ?, 2)`,
  ).run(now, clanId);
  db.prepare('UPDATE clans SET created_by = 2 WHERE id = ?').run(clanId);

  const member = db.prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (?, 'Zoe', 'zoe', ?, ?, 1) RETURNING id`,
  ).get(clanId, now, now) as { id: number };
  const session = db.prepare(
    `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
     VALUES (?, ?, ?, 'completed', 'manual') RETURNING id`,
  ).get(clanId, now, now) as { id: number };
  const chest = db.prepare(
    `INSERT INTO chests (name, chest_type) VALUES ('Guard Chest', 'common')
     ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
  ).get() as { id: number };
  const source = db.prepare(
    `INSERT INTO chest_sources (source) VALUES ('Guard Source')
     ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
  ).get() as { id: number };

  db.prepare(
    `INSERT INTO chest_records
       (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at)
     VALUES (?, ?, ?, ?, ?, 5, ?)`,
  ).run(clanId, session.id, member.id, chest.id, source.id, now);
  db.prepare(
    `INSERT INTO triumphal_chest_records
       (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  ).run(clanId, session.id, member.id, chest.id, source.id, now);
  db.prepare(
    'INSERT INTO member_snapshots (member_id, level, power, captured_at, clan_id) VALUES (?, 9, 99, ?, ?)',
  ).run(member.id, now, clanId);
  db.prepare(
    'INSERT INTO chest_daily_summary (clan_id, member_id, game_day, chests, points) VALUES (?, ?, ?, 1, 5)',
  ).run(clanId, member.id, '2026-07-20');

  const typeId = (db.prepare('SELECT id FROM resource_types ORDER BY id LIMIT 1')
    .get() as { id: number }).id;
  const batch = db.prepare(
    `INSERT INTO resource_upload_batches (clan_id, uploaded_by, uploaded_at, upload_date)
     VALUES (?, 2, ?, ?) RETURNING id`,
  ).get(clanId, now, now) as { id: number };
  db.prepare(
    `INSERT INTO resource_transactions
       (clan_id, batch_id, member_id, resource_type_id, direction, amount, transaction_date, created_at)
     VALUES (?, ?, ?, ?, 1, 100, '2026-07-20', ?)`,
  ).run(clanId, batch.id, member.id, typeId, now);
  db.prepare(
    'INSERT INTO resource_icon_templates (clan_id, resource_type_id, template_data, updated_at) VALUES (?, ?, ?, ?)',
  ).run(clanId, typeId, Buffer.from([1, 2, 3]), now);

  const link = db.prepare(
    `INSERT INTO share_links (clan_id, token, created_at, created_by, revoked_by)
     VALUES (?, 'guard-token', ?, 2, 2) RETURNING id`,
  ).get(clanId, now) as { id: number };
  db.prepare(
    'INSERT INTO share_link_daily (link_id, day, views) VALUES (?, ?, 3)',
  ).run(link.id, '2026-07-20');

  db.prepare(
    `INSERT INTO discord_member_links (clan_id, discord_user_id, member_id, linked_at)
     VALUES (?, 'guard-discord-user', ?, ?)`,
  ).run(clanId, member.id, now);

  db.prepare(
    "INSERT INTO audit_log (user_id, clan_id, action, details, created_at) VALUES (2, ?, 'guard', '{}', ?)",
  ).run(clanId, now);
  db.prepare(
    `INSERT INTO merge_rules (clan_id, type, from_value, to_value, created_at)
     VALUES (?, 'player', 'Zed', 'Zoe', ?)`,
  ).run(clanId, now);
  db.prepare(
    `INSERT INTO chest_type_overrides (clan_id, chest_name, chest_type, created_at)
     VALUES (?, 'Guard Chest', 'rare', ?)`,
  ).run(clanId, now);
  db.prepare(
    `INSERT INTO review_acknowledgments (clan_id, category, acknowledged_at)
     VALUES (?, 'member', ?)`,
  ).run(clanId, now);
  db.prepare(
    `INSERT INTO user_sessions (user_id, token, expires_at, created_at, active_clan_id)
     VALUES (2, 'guard-session', ?, ?, ?)`,
  ).run(now, now, clanId);

  // ChestTracker ingest: clan-scoped, but only by convention — no FK to clans.
  const playerRef = db.prepare(
    `INSERT INTO ct_player_ref (clan_id, name) VALUES (?, 'GuardPlayer') RETURNING id`,
  ).get(clanId) as { id: number };
  const snapshot = db.prepare(
    `INSERT INTO snapshot (clan_id, fetched_at, share_code, window_start, window_end, duration_days)
     VALUES (?, ?, 'GUARDCODE', '2026-07-13', '2026-07-20', 7) RETURNING id`,
  ).get(clanId, now) as { id: number };
  db.prepare(
    `INSERT INTO player_snapshot (snapshot_id, player_ref_id, guards_level, points, chests, clan_id)
     VALUES (?, ?, 1, 5, 1, ?)`,
  ).run(snapshot.id, playerRef.id, clanId);
  db.prepare(
    `INSERT INTO player_category (snapshot_id, player_ref_id, category, chests, clan_id)
     VALUES (?, ?, 'Crypt', 1, ?)`,
  ).run(snapshot.id, playerRef.id, clanId);
  const defRef = db.prepare(
    `INSERT INTO chest_definition_ref (type, name, source, points)
     VALUES ('common', 'Guard Chest', 'Guard Source', 5) RETURNING id`,
  ).get() as { id: number };
  db.prepare(
    'INSERT INTO snapshot_chest_definition (snapshot_id, chest_definition_ref_id, clan_id) VALUES (?, ?, ?)',
  ).run(snapshot.id, defRef.id, clanId);
  db.prepare(
    `INSERT INTO poll_log (polled_at, share_code, window_start, window_end, trigger, status, clan_id)
     VALUES (?, 'GUARDCODE', '2026-07-13', '2026-07-20', 'scheduled', 200, ?)`,
  ).run(now, clanId);

  return { clanId, userId: 2, memberId: member.id };
}

describe('hard-delete paths: schema drift', () => {
  let cleanup: () => void;
  beforeEach(() => { cleanup = makeTestDb().cleanup; });
  afterEach(() => cleanup());

  for (const parent of Object.keys(EXPECTED_CHILDREN)) {
    it(`every FK to ${parent}(id) is accounted for`, () => {
      expect(
        liveChildren(parent),
        `\nThe set of tables referencing ${parent}(id) changed.\n`
        + `Audit these delete paths before updating this list: ${DELETE_PATHS[parent]}\n`,
      ).toEqual(EXPECTED_CHILDREN[parent]);
    });
  }

  // A drift detector nobody has seen fail is indistinguishable from a
  // detector that can't fail. Add a referencing table to this test's throwaway
  // DB and prove the check goes red.
  it('notices a newly-added referencing table', () => {
    expect(liveChildren('members')).toEqual(EXPECTED_CHILDREN.members);
    getDb().exec(
      'CREATE TABLE drift_probe (id INTEGER PRIMARY KEY, member_id INTEGER REFERENCES members(id))',
    );
    expect(liveChildren('members')).toContain('drift_probe.member_id');
    expect(liveChildren('members')).not.toEqual(EXPECTED_CHILDREN.members);
  });
});

describe('hard-delete paths: survive a fully-populated schema', () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
  });
  afterEach(() => cleanup());

  it('deleteClan removes a clan with data in every child table', () => {
    const { clanId } = seedEverything();
    const result = deleteClan(clanId);
    expect(result).toEqual({ ok: false, reason: '2 user(s) are still attached to this clan' });

    // Detach the users it (correctly) refuses to orphan, then retry.
    getDb().prepare('UPDATE users SET clan_id = NULL WHERE clan_id = ?').run(clanId);
    expect(deleteClan(clanId)).toEqual({ ok: true });

    const db = getDb();
    expect(db.prepare('SELECT id FROM clans WHERE id = ?').get(clanId)).toBeUndefined();
    // The audit trail survives the clan, unattributed.
    const audit = db.prepare("SELECT clan_id FROM audit_log WHERE action = 'guard'").get() as
      { clan_id: number | null };
    expect(audit.clan_id).toBeNull();
    // Live sessions lose only their active-clan pointer.
    const sess = db.prepare("SELECT active_clan_id FROM user_sessions WHERE token = 'guard-session'")
      .get() as { active_clan_id: number | null };
    expect(sess.active_clan_id).toBeNull();

    // Nothing clan-scoped is left behind, FK or not. A survivor here is not
    // harmless: clans(id) is an AUTOINCREMENT the next clan can be handed, and
    // orphaned rows would then read as that clan's history.
    const residue: Record<string, string> = {
      chest_daily_summary: 'SELECT COUNT(*) c FROM chest_daily_summary WHERE clan_id = ?',
      ct_player_ref: 'SELECT COUNT(*) c FROM ct_player_ref WHERE clan_id = ?',
      snapshot: 'SELECT COUNT(*) c FROM snapshot WHERE clan_id = ?',
      player_snapshot: 'SELECT COUNT(*) c FROM player_snapshot WHERE clan_id = ?',
      player_category: 'SELECT COUNT(*) c FROM player_category WHERE clan_id = ?',
      snapshot_chest_definition: 'SELECT COUNT(*) c FROM snapshot_chest_definition WHERE clan_id = ?',
      poll_log: 'SELECT COUNT(*) c FROM poll_log WHERE clan_id = ?',
    };
    for (const [table, sql] of Object.entries(residue)) {
      const row = db.prepare(sql).get(clanId) as { c: number };
      expect(row.c, `${table} still holds rows for the deleted clan`).toBe(0);
    }
  });

  it('deleteUser removes a user referenced from every direction', () => {
    const { userId } = seedEverything();
    expect(deleteUser(userId)).toBe(true);

    const db = getDb();
    expect(db.prepare('SELECT id FROM users WHERE id = ?').get(userId)).toBeUndefined();
    // History survives with a null actor rather than being destroyed.
    const audit = db.prepare("SELECT user_id FROM audit_log WHERE action = 'guard'").get() as
      { user_id: number | null };
    expect(audit.user_id).toBeNull();
    const batch = db.prepare('SELECT uploaded_by FROM resource_upload_batches LIMIT 1').get() as
      { uploaded_by: number | null };
    expect(batch.uploaded_by).toBeNull();
    // The upload's transactions are untouched clan data.
    const txCount = db.prepare('SELECT COUNT(*) c FROM resource_transactions').get() as { c: number };
    expect(txCount.c).toBe(1);
    // Accounts this user created outlive them.
    expect(db.prepare('SELECT id FROM users WHERE id = 3').get()).toBeTruthy();
  });

  it('a player merge survives a member referenced from every child table', () => {
    const { clanId, memberId } = seedEverything();
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (?, 'Yara', 'yara', ?, ?, 1)`,
    ).run(clanId, now, now);

    expect(() => addMergeRule('player', 'Zoe', 'Yara', clanId)).not.toThrow();
    expect(db.prepare('SELECT id FROM members WHERE id = ?').get(memberId)).toBeUndefined();
  });

  it('a source merge leaves no record pointing at the deleted source row', () => {
    // addMergeRule(source) ends in DELETE FROM chest_sources, and both
    // chest_records and triumphal_chest_records reference it. seedEverything
    // gives 'Guard Source' one of each.
    const { clanId } = seedEverything();
    const db = getDb();

    expect(() => addMergeRule('source', 'Guard Source', 'Guard Source Renamed', clanId)).not.toThrow();
    expect(db.prepare("SELECT id FROM chest_sources WHERE source = 'Guard Source'").get())
      .toBeUndefined();
    for (const table of ['chest_records', 'triumphal_chest_records']) {
      const dangling = db.prepare(
        `SELECT COUNT(*) c FROM ${table}
         WHERE chest_source_id IS NOT NULL
           AND chest_source_id NOT IN (SELECT id FROM chest_sources)`,
      ).get() as { c: number };
      expect(dangling.c, `${table} left a dangling chest_source_id`).toBe(0);
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('deleteOrphanedEmptyMembers skips blank members that still hold data', () => {
    const { clanId } = seedEverything();
    const db = getDb();
    const now = new Date().toISOString();

    // Blank member with a snapshot only -> should be collected.
    const disposable = db.prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (?, '', '', ?, ?, 1) RETURNING id`,
    ).get(clanId, now, now) as { id: number };
    db.prepare(
      'INSERT INTO member_snapshots (member_id, level, power, captured_at, clan_id) VALUES (?, 1, 1, ?, ?)',
    ).run(disposable.id, now, clanId);

    // Blank member that still owns a resource transaction -> must be kept.
    // Distinct normalized_name because members are UNIQUE(clan_id,
    // normalized_name); the display name is what the cleanup matches on.
    const keep = db.prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (?, '   ', 'ws-phantom', ?, ?, 1) RETURNING id`,
    ).get(clanId, now, now) as { id: number };
    const batchId = (db.prepare('SELECT id FROM resource_upload_batches LIMIT 1')
      .get() as { id: number }).id;
    db.prepare(
      `INSERT INTO resource_transactions
         (clan_id, batch_id, member_id, resource_type_id, direction, amount, transaction_date, created_at)
       VALUES (?, ?, ?, NULL, 1, 7, '2026-07-21', ?)`,
    ).run(clanId, batchId, keep.id, now);

    let removed = 0;
    expect(() => { removed = deleteOrphanedEmptyMembers(clanId); }).not.toThrow();
    expect(removed).toBe(1);
    expect(db.prepare('SELECT id FROM members WHERE id = ?').get(disposable.id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM members WHERE id = ?').get(keep.id)).toBeTruthy();
    // Its orphaned snapshot went with it.
    const snaps = db.prepare(
      'SELECT COUNT(*) c FROM member_snapshots WHERE member_id = ?',
    ).get(disposable.id) as { c: number };
    expect(snaps.c).toBe(0);
  });
});
