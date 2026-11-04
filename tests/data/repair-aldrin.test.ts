import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import {
  repairAldrin, MISFILED_CHEST_IDS, MISFILED_TRIUMPHAL_IDS,
} from '../../src/data/repair-aldrin-2026-11.js';
import { makeTestDb } from '../helpers/test-db.js';

/**
 * Migration v91's data repair, on a reconstruction of clan #3 as it stood on
 * Nov 4 2026: Cauldron's history, Aldrin's rows, and Aldrin's chests filed
 * under Ilrin next to a few that really are Ilrin's.
 */
describe('repairAldrin (migration v91)', () => {
  let cleanup: () => void;
  beforeEach(() => { ({ cleanup } = makeTestDb()); });
  afterEach(() => cleanup());

  const GENUINE_ILRIN = [743990, 743991, 743992, 744302, 744304];

  function seed(): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO clans (id, name, slug, game_url, is_active, created_at)
       VALUES (3, 'SIK', 'sik', 'https://totalbattle.com', 1, '2026-10-20T00:00:00Z')`,
    ).run();
    const member = db.prepare(
      `INSERT INTO members (id, clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (?, 3, ?, ?, ?, ?, 1)`,
    );
    member.run(1354, 'Cauldron', 'cauldron', '2026-10-20T23:25:28.899Z', '2026-11-03T00:37:09.971Z');
    member.run(1508, 'Ilrin', 'ilrin', '2026-10-24T22:19:00.586Z', '2026-11-03T17:18:35.985Z');
    member.run(1527, 'Aldrin', 'aldrin', '2026-11-03T17:18:35.984Z', '2026-11-04T05:50:44.949Z');
    db.prepare(
      `INSERT INTO scan_sessions (id, clan_id, started_at, completed_at, status, trigger_source)
       VALUES (8002, 3, '2026-11-03T02:38:42Z', '2026-11-03T02:41:43Z', 'completed', 'scheduled')`,
    ).run();
    const chest = (db.prepare(
      "INSERT INTO chests (name, chest_type) VALUES ('Barbarian Chest', 'common') RETURNING id",
    ).get() as { id: number }).id;
    const row = db.prepare(
      `INSERT INTO chest_records (id, clan_id, session_id, member_id, chest_id, point_value, captured_at)
       VALUES (?, 3, 8002, ?, ?, 10, ?)`,
    );
    let t = 1793673000000;
    for (const id of MISFILED_CHEST_IDS) row.run(id, 1508, chest, t++);
    for (const id of GENUINE_ILRIN) row.run(id, 1508, chest, t++);
    row.run(700001, 1354, chest, t++); // Cauldron's history
    row.run(700002, 1354, chest, t++);
    row.run(745000, 1527, chest, t++); // Aldrin after the row existed
    const tri = db.prepare(
      `INSERT INTO triumphal_chest_records (id, clan_id, session_id, member_id, chest_id, point_value, captured_at)
       VALUES (?, 3, 8002, ?, ?, 0, ?)`,
    );
    for (const id of MISFILED_TRIUMPHAL_IDS) tri.run(id, 1508, chest, t++);
    db.prepare(
      `INSERT INTO member_snapshots (member_id, clan_id, level, power, captured_at, game_date)
       VALUES (1354, 3, 239, 488196331, '2026-11-02T18:16:39Z', '2026-11-02'),
              (1527, 3, 241, 490352131, '2026-11-03T17:18:35Z', '2026-11-03')`,
    ).run();
  }

  const count = (sql: string, ...args: unknown[]): number =>
    (getDb().prepare(sql).get(...args) as { n: number }).n;

  it('moves the misfiled rows to Aldrin, leaves Ilrin\'s own, and folds Cauldron in', () => {
    seed();
    repairAldrin(getDb());

    expect(count('SELECT COUNT(*) n FROM chest_records WHERE member_id = 1508')).toBe(GENUINE_ILRIN.length);
    expect(count('SELECT COUNT(*) n FROM chest_records WHERE member_id = 1527'))
      .toBe(MISFILED_CHEST_IDS.length + 2 + 1);
    expect(count('SELECT COUNT(*) n FROM triumphal_chest_records WHERE member_id = 1527'))
      .toBe(MISFILED_TRIUMPHAL_IDS.length);

    // The merge: Cauldron gone, its might history carried over, rule + alias in place.
    expect(count('SELECT COUNT(*) n FROM members WHERE id = 1354')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM member_snapshots WHERE member_id = 1527')).toBe(2);
    expect(count(
      "SELECT COUNT(*) n FROM merge_rules WHERE clan_id = 3 AND type = 'player' AND from_value = 'Cauldron' AND to_value = 'Aldrin'",
    )).toBe(1);
    const aldrin = getDb().prepare('SELECT aliases, first_seen FROM members WHERE id = 1527')
      .get() as { aliases: string; first_seen: string };
    expect(JSON.parse(aldrin.aliases)).toContain('Cauldron');
    expect(aldrin.first_seen).toBe('2026-10-20T23:25:28.899Z');
  });

  it('is a no-op on replay', () => {
    seed();
    repairAldrin(getDb());
    const before = count('SELECT COUNT(*) n FROM chest_records WHERE member_id = 1527');
    repairAldrin(getDb());
    expect(count('SELECT COUNT(*) n FROM chest_records WHERE member_id = 1527')).toBe(before);
    expect(count('SELECT COUNT(*) n FROM chest_records WHERE member_id = 1508')).toBe(GENUINE_ILRIN.length);
  });

  it('touches nothing when the members are not the ones it was written for', () => {
    seed();
    // Same ids, different player on 1527 — e.g. an unrelated database.
    getDb().prepare("UPDATE members SET name = 'Someone' WHERE id = 1527").run();
    repairAldrin(getDb());
    expect(count('SELECT COUNT(*) n FROM chest_records WHERE member_id = 1508'))
      .toBe(MISFILED_CHEST_IDS.length + GENUINE_ILRIN.length);
    expect(count('SELECT COUNT(*) n FROM members WHERE id = 1354')).toBe(1);
  });

  it('is a no-op on a fresh database', () => {
    expect(() => repairAldrin(getDb())).not.toThrow();
  });
});
