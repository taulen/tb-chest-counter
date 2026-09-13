/**
 * members.left_at must always mean "gone, since" — never "was gone once".
 *
 * is_active has always been a single bit with no history behind it, so "when
 * did X leave" was answerable only as "last_seen was around here", and a member
 * who left and came back overwrote even that. The column only stays honest if
 * every path that flips the bit maintains it, and there are four ways back in:
 * the scanner seeing the name, the scanner seeing an alias, the daily roster
 * capture marking everyone present, and an admin pressing Restore.
 *
 * Nothing charts this yet, deliberately — there is no honest value for anyone
 * who left before the column existed. It starts recording from here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import {
  deactivateStaleMembers,
  markMembersSeen,
  removeMember,
  restoreMember,
  upsertMember,
} from '../../src/data/repositories/member-repo.js';
import { makeTestDb } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

const leftAt = (id: number): string | null =>
  (getDb().prepare('SELECT left_at FROM members WHERE id = ?').get(id) as { left_at: string | null }).left_at;

const isActive = (id: number): number =>
  (getDb().prepare('SELECT is_active FROM members WHERE id = ?').get(id) as { is_active: number }).is_active;

function seedMember(name: string, aliases: string[] = []): number {
  const now = new Date().toISOString();
  const id = (getDb().prepare(
    `INSERT INTO members (clan_id, name, normalized_name, despaced_name, aliases, first_seen, last_seen, is_active)
     VALUES (1, ?, ?, ?, ?, ?, ?, 1) RETURNING id`,
  ).get(name, name.toLowerCase(), name.toLowerCase().replace(/\s/g, ''), JSON.stringify(aliases), now, now) as { id: number }).id;
  return id;
}

describe('members.left_at', () => {
  it('is null while a member is on the roster', () => {
    expect(leftAt(seedMember('Present'))).toBeNull();
  });

  it('is stamped by a manual removal', () => {
    const id = seedMember('Removed');
    removeMember(id, 1);
    expect(isActive(id)).toBe(0);
    expect(leftAt(id)).toBeTruthy();
  });

  it('is stamped by the inactivity sweep', () => {
    const id = seedMember('Stale');
    getDb().prepare("UPDATE members SET last_seen = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    const removed = deactivateStaleMembers(1, '2026-01-01T00:00:00.000Z');
    expect(removed.map((r) => r.id)).toContain(id);
    expect(leftAt(id)).toBeTruthy();
  });

  it('is NOT overwritten by removing an already-removed member', () => {
    // A double-click or a retried request must not rewrite the date they
    // actually went.
    const id = seedMember('Twice');
    removeMember(id, 1);
    const first = leftAt(id);
    getDb().prepare("UPDATE members SET left_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    removeMember(id, 1);
    expect(leftAt(id)).toBe('2020-01-01T00:00:00.000Z');
    expect(first).toBeTruthy();
  });

  describe('is cleared on every way back in', () => {
    it('the scanner seeing the name again', () => {
      const id = seedMember('Returner');
      removeMember(id, 1);
      upsertMember('Returner', 1);
      expect(isActive(id)).toBe(1);
      expect(leftAt(id)).toBeNull();
    });

    it('the scanner seeing a known alias', () => {
      const id = seedMember('Canonical', ['0ld Sp3lling']);
      removeMember(id, 1);
      upsertMember('0ld Sp3lling', 1);
      expect(isActive(id)).toBe(1);
      expect(leftAt(id)).toBeNull();
    });

    it('the daily roster capture marking them present', () => {
      // With might tracking on this is the COMMON path back — the in-game
      // member list is authoritative and refreshes everyone on it.
      const id = seedMember('Rostered');
      removeMember(id, 1);
      const res = markMembersSeen(1, [id], new Date().toISOString());
      expect(res.reactivated).toBe(1);
      expect(leftAt(id)).toBeNull();
    });

    it('an admin pressing Restore', () => {
      const id = seedMember('Restored');
      removeMember(id, 1);
      restoreMember(id, 1);
      expect(isActive(id)).toBe(1);
      expect(leftAt(id)).toBeNull();
    });
  });
});
