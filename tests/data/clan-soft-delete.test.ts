import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import {
  clanCount,
  getClanById,
  getClanByIdIncludingDeleted,
  getClanBySlug,
  getClanByPublicShareToken,
  listClans,
  listDeletedClans,
  restoreDeletedClan,
  softDeleteClan,
} from '../../src/data/repositories/clan-repo.js';
import { makeTestDb, seedTwoClans, seedChestData } from '../helpers/test-db.js';

/**
 * Soft delete has exactly one failure mode worth testing for, and it is not
 * "does the flag get set".
 *
 * It is that a hidden clan keeps showing up somewhere. Every row it owns is
 * still in the database, so anything that resolves a clan without asking about
 * `deleted_at` carries on serving it as if nothing happened — the picker, the
 * scan loop, the Discord digest, the poller, its own public share link, and
 * most quietly of all the people who were in it. That is why all five lookups
 * filter, and why the tests below go through the lookups rather than reading
 * the column.
 *
 * The mirror risk is losing data on the way back: restore has to return the
 * clan whole, on the same id, with the rows still attached to it.
 */

let ctx: { dbPath: string; cleanup: () => void };

const TOKEN = 'AbC123';

function countChests(clanId: number): number {
  return (getDb().prepare(
    'SELECT COUNT(*) n FROM chest_records WHERE clan_id = ?',
  ).get(clanId) as { n: number }).n;
}

describe('softDeleteClan', () => {
  beforeEach(() => {
    ctx = makeTestDb();
    seedTwoClans();
    seedChestData(1);
    seedChestData(2);
    getDb().prepare('UPDATE clans SET public_share_token = ? WHERE id = 2').run(TOKEN);
  });

  afterEach(() => ctx.cleanup());

  it('keeps every row and hides the clan from all five lookups', () => {
    const before = countChests(2);
    expect(before).toBeGreaterThan(0);

    expect(softDeleteClan(2)).toEqual({ ok: true });

    // Nothing was destroyed — that is the entire promise.
    expect(countChests(2)).toBe(before);

    // …and nothing can reach it.
    expect(listClans().map((c) => c.id)).toEqual([1]);
    expect(listClans({ activeOnly: true }).map((c) => c.id)).toEqual([1]);
    expect(getClanById(2)).toBeNull();
    expect(getClanBySlug('clan-2')).toBeNull();
    expect(getClanByPublicShareToken(TOKEN)).toBeNull();
    expect(clanCount()).toBe(1);

    // Except the two deliberate ways back in.
    expect(listDeletedClans().map((c) => c.id)).toEqual([2]);
    expect(getClanByIdIncludingDeleted(2)?.name).toBe('Clan #2');
  });

  it('stamps deletedAt and clears is_active', () => {
    softDeleteClan(2);
    const clan = getClanByIdIncludingDeleted(2)!;
    expect(clan.deletedAt).not.toBe('');
    expect(Number.isNaN(Date.parse(clan.deletedAt))).toBe(false);
    expect(clan.isActive).toBe(false);
  });

  it('does not require the clan to be emptied of users first', () => {
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO users (username, password_hash, role, created_at, clan_id)
       VALUES ('member-of-2', 'x', 'user', ?, 2)`,
    ).run(now);

    // The hard delete refuses here, and satisfying it meant destroying the
    // accounts first — which is how the September loss became permanent.
    expect(softDeleteClan(2)).toEqual({ ok: true });
    const user = getDb().prepare("SELECT clan_id FROM users WHERE username = 'member-of-2'")
      .get() as { clan_id: number };
    expect(user.clan_id).toBe(2);
  });

  it('unparks any session pointed at the clan', () => {
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO users (id, username, password_hash, role, created_at) VALUES (9, 'super', 'x', 'superadmin', ?)`,
    ).run(now);
    getDb().prepare(
      `INSERT INTO user_sessions (user_id, token, expires_at, created_at, active_clan_id)
       VALUES (9, 'sess', ?, ?, 2)`,
    ).run(now, now);

    softDeleteClan(2);
    const sess = getDb().prepare("SELECT active_clan_id FROM user_sessions WHERE token = 'sess'")
      .get() as { active_clan_id: number | null };
    expect(sess.active_clan_id).toBeNull();
  });

  it('still refuses to remove the last remaining clan', () => {
    expect(softDeleteClan(2)).toEqual({ ok: true });
    expect(softDeleteClan(1)).toEqual({ ok: false, reason: 'Cannot delete the last remaining clan' });
    expect(getClanById(1)).not.toBeNull();
  });

  it('refuses a clan that is already deleted', () => {
    // A third clan, so `clanCount()` stays above 1 and the last-clan guard
    // can't answer first — otherwise this passes for the wrong reason.
    getDb().prepare(
      `INSERT INTO clans (id, name, slug, game_url, is_active, created_at)
       VALUES (3, 'Clan #3', 'clan-3', 'https://totalbattle.com', 1, ?)`,
    ).run(new Date().toISOString());

    softDeleteClan(2);
    expect(softDeleteClan(2)).toEqual({ ok: false, reason: 'Clan not found' });
  });

  it('keeps the name, slug and share token reserved while hidden', () => {
    softDeleteClan(2);
    // A new clan must not be able to take them, or the restore would collide
    // with something created in the meantime.
    expect(() => getDb().prepare(
      `INSERT INTO clans (name, slug, game_url, is_active, created_at)
       VALUES ('Clan #2', 'clan-2', 'https://totalbattle.com', 1, ?)`,
    ).run(new Date().toISOString())).toThrow(/UNIQUE/i);
  });
});

describe('restoreDeletedClan', () => {
  beforeEach(() => {
    ctx = makeTestDb();
    seedTwoClans();
    seedChestData(1);
    seedChestData(2);
    getDb().prepare('UPDATE clans SET public_share_token = ? WHERE id = 2').run(TOKEN);
  });

  afterEach(() => ctx.cleanup());

  it('puts the clan back whole, on the same id and the same share link', () => {
    const chestsBefore = countChests(2);
    softDeleteClan(2);
    expect(restoreDeletedClan(2)).toEqual({ ok: true });

    const clan = getClanById(2);
    expect(clan).not.toBeNull();
    expect(clan!.name).toBe('Clan #2');
    expect(clan!.deletedAt).toBe('');
    // The delete cleared is_active; a clan restored inactive would still be
    // invisible to the scan loop, which is the subtler half of "back".
    expect(clan!.isActive).toBe(true);
    expect(listClans({ activeOnly: true }).map((c) => c.id)).toEqual([1, 2]);
    expect(getClanByPublicShareToken(TOKEN)?.id).toBe(2);
    expect(countChests(2)).toBe(chestsBefore);
    expect(listDeletedClans()).toEqual([]);
  });

  it('refuses a clan that was never deleted', () => {
    expect(restoreDeletedClan(2)).toEqual({ ok: false, reason: 'No deleted clan with that id' });
  });

  it('refuses an id that does not exist', () => {
    expect(restoreDeletedClan(99)).toEqual({ ok: false, reason: 'No deleted clan with that id' });
  });
});
