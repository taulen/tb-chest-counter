import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import {
  getAllMembers,
  markMembersSeen,
  removeMember,
  upsertMember,
} from '../../../src/data/repositories/member-repo.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

/**
 * Being on the in-game member list counts as being seen.
 *
 * Every scan's game member sync (game-protocol/member-sync.ts) marks everyone on
 * the clan's roster through markMembersSeen, by member id — which is what these
 * cases pin.
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

  it('refreshes last_seen to the sighting', () => {
    const m = upsertMember('Quiet', 1);
    // Eight days without a chest.
    setLastSeen(m.id, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString());

    const seenAt = new Date().toISOString();
    markMembersSeen(1, [m.id], seenAt);

    expect(lastSeenOf(m.id)).toBe(seenAt);
  });

  it('reactivates a member who had been removed', () => {
    const m = upsertMember('Returned', 1);
    removeMember(m.id, 1);
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
