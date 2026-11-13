import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import {
  deactivateStaleMembers,
  getAllMembers,
  markMembersSeen,
  retireOffRosterMembers,
  upsertMember,
} from '../../../src/data/repositories/member-repo.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

/**
 * Being on the in-game member list counts as being seen.
 *
 * The inactivity sweep soft-removes anyone not seen for their clan's threshold, and
 * "seen" used to mean only "turned up in a chest or gift scan" — so a player who
 * went a week without earning a chest was removed while the game still listed them
 * in the clan. The daily might capture reads that list and marks everyone on it,
 * which is what these cases pin.
 */
describe('markMembersSeen', () => {
  let cleanup: () => void;

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    seedTwoClans();
  });

  afterEach(() => cleanup());

  const lastSeenOf = (id: number): string =>
    (getDb().prepare('SELECT last_seen AS l FROM members WHERE id = ?').get(id) as { l: string }).l;

  const setLastSeen = (id: number, iso: string): void => {
    getDb().prepare('UPDATE members SET last_seen = ? WHERE id = ?').run(iso, id);
  };

  it('refreshes last_seen so the sweep no longer considers them stale', () => {
    const m = upsertMember('Quiet', 1);
    // Eight days without a chest — the sweep's 7-day cutoff would take them.
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    setLastSeen(m.id, stale);

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // Sanity: without the sighting they are stale.
    expect(lastSeenOf(m.id) < cutoff).toBe(true);

    markMembersSeen(1, [m.id], new Date().toISOString());

    expect(lastSeenOf(m.id) > cutoff).toBe(true);
    expect(deactivateStaleMembers(1, cutoff)).toEqual([]);
  });

  it('reactivates a member the sweep had already removed', () => {
    const m = upsertMember('Returned', 1);
    setLastSeen(m.id, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString());
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    expect(deactivateStaleMembers(1, cutoff).map((r) => r.name)).toEqual(['Returned']);
    expect(getAllMembers(true, 1).map((x) => x.name)).not.toContain('Returned');

    const result = markMembersSeen(1, [m.id], new Date().toISOString());

    expect(result.reactivated).toBe(1);
    expect(result.updated).toBe(1);
    expect(getAllMembers(true, 1).map((x) => x.name)).toContain('Returned');
  });

  it('reports only genuine reactivations, so caches are not dropped for nothing', () => {
    // Runs daily against a whole roster; an already-active member must not be
    // counted as reactivated or the derived-cache invalidation would fire every day.
    const active = upsertMember('Active', 1);
    const inactive = upsertMember('Inactive', 1);
    getDb().prepare('UPDATE members SET is_active = 0 WHERE id = ?').run(inactive.id);

    const result = markMembersSeen(1, [active.id, inactive.id], new Date().toISOString());
    expect(result.updated).toBe(2);
    expect(result.reactivated).toBe(1);

    // Second pass: both active now, nothing to reactivate.
    expect(markMembersSeen(1, [active.id, inactive.id], new Date().toISOString()).reactivated).toBe(0);
  });

  it('will not touch another clan by id', () => {
    const other = upsertMember('Foreign', 2);
    const before = lastSeenOf(other.id);
    getDb().prepare('UPDATE members SET is_active = 0 WHERE id = ?').run(other.id);

    const result = markMembersSeen(1, [other.id], '2099-01-01T00:00:00.000Z');

    expect(result.updated).toBe(0);
    expect(result.reactivated).toBe(0);
    expect(lastSeenOf(other.id)).toBe(before);
    expect(getAllMembers(true, 2).map((x) => x.name)).not.toContain('Foreign');
  });

  it('is a no-op on an empty id list', () => {
    expect(markMembersSeen(1, [], new Date().toISOString())).toEqual({ updated: 0, reactivated: 0 });
  });
});

/**
 * Donors known only from Clan Capital resource history and on no member-list read are
 * former members. Live: SK7's first resource read (Nov 13 2026) went back 3 days and
 * created 10 such names as ACTIVE members of an 80-player clan, so its roster read 90.
 */
describe('retireOffRosterMembers', () => {
  let cleanup: () => void;
  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    seedTwoClans();
  });
  afterEach(() => cleanup());

  const NOW = Date.parse('2026-11-13T18:20:00Z');
  const snapshot = (memberId: number, clanId: number, capturedAt: string): void => {
    getDb().prepare(
      `INSERT INTO member_snapshots (member_id, clan_id, level, power, captured_at, game_date)
       VALUES (?, ?, 100, 1000000, ?, ?)`,
    ).run(memberId, clanId, capturedAt, capturedAt.slice(0, 10));
  };
  const chest = (memberId: number): void => {
    const db = getDb();
    const session = (db.prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, status) VALUES (1, '2026-11-13T10:00:00Z', 'completed') RETURNING id`,
    ).get() as { id: number }).id;
    db.prepare("INSERT INTO chests (name) VALUES ('Stone Chest') ON CONFLICT(name) DO NOTHING").run();
    const chestId = (db.prepare("SELECT id FROM chests WHERE name = 'Stone Chest'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at)
       VALUES (1, ?, ?, ?, 5, ?)`,
    ).run(session, memberId, chestId, NOW - 3600000);
  };
  const activeNames = (clanId: number) => getAllMembers(true, clanId).map((m) => m.name).sort();

  it('retires donors on no member-list read while the list is being read, and only them', () => {
    const onRoster = upsertMember('Living S', 1);
    snapshot(onRoster.id, 1, '2026-11-13T17:53:59.365Z');
    const giftOnly = upsertMember('Gift Sender', 1); // a gift is a sighting of its own
    chest(giftOnly.id);
    upsertMember('bye Felecia', 1); // donation history only
    upsertMember('Sevro au Barca', 1);

    const retired = retireOffRosterMembers(1, NOW);
    expect(retired.map((m) => m.name).sort()).toEqual(['Sevro au Barca', 'bye Felecia']);
    expect(activeNames(1)).toEqual(['Gift Sender', 'Living S']);
    const leftAt = getDb().prepare("SELECT left_at AS l FROM members WHERE name = 'bye Felecia'").get() as { l: string };
    expect(leftAt.l).toBe(new Date(NOW).toISOString());
    expect(retireOffRosterMembers(1, NOW)).toEqual([]); // idempotent
  });

  it('does nothing without a recent member-list read to judge against', () => {
    upsertMember('Donor', 1);
    expect(retireOffRosterMembers(1, NOW)).toEqual([]); // might tracking never ran

    const old = upsertMember('Old Roster', 1);
    snapshot(old.id, 1, '2026-11-11T17:00:00Z'); // 49h before NOW
    expect(retireOffRosterMembers(1, NOW)).toEqual([]);
    expect(activeNames(1)).toEqual(['Donor', 'Old Roster']);
  });

  it('is scoped to the clan, and a later member-list read brings a retired player back', () => {
    const a = upsertMember('Roster A', 1);
    snapshot(a.id, 1, '2026-11-13T17:53:59Z');
    const donor = upsertMember('Joined Late', 1);
    upsertMember('Clan Two Donor', 2); // clan 2's list was never read

    expect(retireOffRosterMembers(1, NOW).map((m) => m.name)).toEqual(['Joined Late']);
    expect(activeNames(2)).toEqual(['Clan Two Donor']);

    // Tomorrow's read finds them on the list after all.
    markMembersSeen(1, [donor.id], '2026-11-14T17:50:00Z');
    snapshot(donor.id, 1, '2026-11-14T17:50:00Z');
    expect(activeNames(1)).toEqual(['Joined Late', 'Roster A']);
    expect(retireOffRosterMembers(1, NOW + 86400000)).toEqual([]);
  });
});
