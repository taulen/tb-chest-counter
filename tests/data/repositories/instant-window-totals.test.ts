import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import {
  getInstantWindowTotals,
  getMemberEarnedInInstantRange,
} from '../../../src/data/repositories/chest-summary-repo.js';
import { makeTestDb } from '../../helpers/test-db.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-09-03T17:00:00Z');

describe('instant-range totals', () => {
  let cleanup: () => void;
  let alice: number;
  let bob: number;

  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    const db = getDb();
    const now = new Date().toISOString();
    const member = (name: string) => (db.prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (1, ?, ?, ?, ?, 1) RETURNING id`,
    ).get(name, name.toLowerCase(), now, now) as { id: number }).id;
    alice = member('Alice');
    bob = member('Bob');
    const session = (db.prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
       VALUES (1, ?, ?, 'completed', 'manual') RETURNING id`,
    ).get(now, now) as { id: number }).id;
    const chest = (db.prepare(
      `INSERT INTO chests (name, chest_type) VALUES ('Common Chest', 'common') RETURNING id`,
    ).get() as { id: number }).id;
    const add = (memberId: number, at: number, points: number) => db.prepare(
      `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(session, memberId, chest, points, at);
    add(alice, T0 + 1 * HOUR, 10);
    add(alice, T0 + 2 * HOUR, 20);
    add(bob, T0 + 3 * HOUR, 40);
  });

  afterEach(() => cleanup());

  it('stops at the exact instant, not at the end of the game day', () => {
    // A cut at 2h30 into the day keeps two of the day's three chests.
    expect(getInstantWindowTotals(1, T0, T0 + 2.5 * HOUR)).toMatchObject({
      chests: 2, points: 30, activeMembers: 1,
    });
    expect(getInstantWindowTotals(1, T0, T0 + 24 * HOUR)).toMatchObject({
      chests: 3, points: 70, activeMembers: 2,
    });
  });

  it('treats the end as exclusive', () => {
    expect(getInstantWindowTotals(1, T0, T0 + 1 * HOUR).chests).toBe(0);
  });

  it('gives each member their own share of the range', () => {
    const map = getMemberEarnedInInstantRange(1, T0, T0 + 2.5 * HOUR);
    expect(map.get(alice)).toEqual({ chests: 2, points: 30 });
    expect(map.has(bob)).toBe(false);
  });
});
