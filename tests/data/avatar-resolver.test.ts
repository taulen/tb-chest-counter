import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hero art comes from the extracted game bundles, which tests don't have.
vi.mock('../../src/data/repositories/game-profile-repo.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/data/repositories/game-profile-repo.js')>()),
  heroAvatarUrl: (id: number | null | undefined) => (id ? `/game-art/test/hero-${id}.png` : null),
}));

import { getDb } from '../../src/data/database.js';
import * as userRepo from '../../src/data/repositories/user-repo.js';
import {
  resolveAccountAvatar, setUserAvatar, removeUserAvatar, avatarInitial, linkedPhotoUrlsForClan, resolveMemberAvatar,
  photoUrlForPlayer, setPlayerAvatar, removePlayerAvatar, accountPlayers,
} from '../../src/data/repositories/avatar-repo.js';
import { setMainPlayer } from '../../src/data/repositories/account-invite-repo.js';
import { sniffImage } from '../../src/utils/image-sniff.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';
import { pngBytes } from '../helpers/image-bytes.js';

function addGamePlayer(clanId: number, playerId: number, heroAvatar: number | null): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO game_players (clan_id, player_id, name, hero_avatar, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(clanId, playerId, `Player ${playerId}`, heroAvatar, now, now);
}

/** Link the account to a game player in a clan, as a redeemed invite code does (v127). */
function link(userId: number, clanId: number, playerId: number): void {
  const now = new Date().toISOString();
  getDb().prepare('DELETE FROM user_game_links WHERE user_id = ? AND clan_id = ?').run(userId, clanId);
  getDb().prepare('DELETE FROM user_clan_main WHERE user_id = ? AND clan_id = ?').run(userId, clanId);
  getDb().prepare(
    `INSERT INTO user_game_links (user_id, clan_id, player_id, player_name, linked_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, clanId, playerId, `Player ${playerId}`, now, now);
}

describe('resolveAccountAvatar: photo → game hero → initial', () => {
  let cleanup: () => void;
  let user: userRepo.User;

  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
    user = userRepo.createUser('valka', 'Test1234!aA', 'user', undefined, 1);
  });
  afterEach(() => cleanup());

  it('shows the initial for an account with no photo and no linked player', () => {
    expect(resolveAccountAvatar(user, 1)).toEqual({ kind: 'initial', url: null, initial: 'V' });
  });

  it('shows the linked player\'s hero portrait, in the clan being viewed', () => {
    addGamePlayer(1, 9001, 42);
    addGamePlayer(2, 9002, 7);
    link(user.id, 1, 9001);
    link(user.id, 2, 9002);
    expect(resolveAccountAvatar(user, 1)).toEqual({ kind: 'hero', url: '/game-art/test/hero-42.png', initial: 'V' });
    expect(resolveAccountAvatar(user, 2)).toEqual({ kind: 'hero', url: '/game-art/test/hero-7.png', initial: 'V' });
  });

  it('falls back to the initial when the linked player has no hero or no row', () => {
    addGamePlayer(1, 9001, null);
    link(user.id, 1, 9001);
    expect(resolveAccountAvatar(user, 1).kind).toBe('initial');
    link(user.id, 1, 12345); // no game_players row
    expect(resolveAccountAvatar(user, 1).kind).toBe('initial');
    // No clan (a superadmin): no hero to look up.
    expect(resolveAccountAvatar(user, null).kind).toBe('initial');
  });

  it("the main player's photo wins over its hero, and removing it brings the hero back", () => {
    addGamePlayer(1, 9001, 42);
    link(user.id, 1, 9001);
    const bytes = pngBytes(512, 512);
    const { url } = setPlayerAvatar(9001, user.id, bytes, sniffImage(bytes)!);
    expect(url).toMatch(/^\/api\/avatars\/[0-9a-f]{64}$/);
    expect(resolveAccountAvatar(user, 1)).toEqual({ kind: 'photo', url, initial: 'V' });
    expect(removePlayerAvatar(9001)).toBe(true);
    expect(resolveAccountAvatar(user, 1).kind).toBe('hero');
  });

  it('an account with no player keeps its own photo; once linked, its player decides', () => {
    const bytes = pngBytes(512, 512);
    const { url } = setUserAvatar(user.id, bytes, sniffImage(bytes)!);
    expect(resolveAccountAvatar(user, 1)).toEqual({ kind: 'photo', url, initial: 'V' });
    addGamePlayer(1, 9001, 42);
    link(user.id, 1, 9001);
    expect(resolveAccountAvatar(user, 1).kind).toBe('hero');
    expect(removeUserAvatar(user.id)).toBe(true);
  });

  it('a member profile shows the photo of the account linked to its player, nothing otherwise', () => {
    addGamePlayer(1, 9001, 42);
    expect(photoUrlForPlayer(9001)).toBeNull(); // not linked
    link(user.id, 1, 9001);
    expect(photoUrlForPlayer(9001)).toBeNull(); // linked, no photo: the profile shows the hero
    const bytes = pngBytes(512, 512);
    const { url } = setPlayerAvatar(9001, user.id, bytes, sniffImage(bytes)!);
    // The very URL the account's own avatar resolves to (its main player).
    expect(photoUrlForPlayer(9001)).toBe(url);
    expect(photoUrlForPlayer(9001)).toBe(resolveAccountAvatar(user, 1).url);
    removePlayerAvatar(9001);
    expect(photoUrlForPlayer(9001)).toBeNull();
  });

  it('takes the first letter of any script, upper-cased', () => {
    expect(avatarInitial('élise')).toBe('É');
    expect(avatarInitial('Ярослав')).toBe('Я');
    expect(avatarInitial('')).toBe('?');
  });
});

describe("a member's picture (Members board): the linked account's photo → hero → initial", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
  });
  afterEach(() => cleanup());

  it('finds the photos of accounts linked in that clan only', () => {
    const a = userRepo.createUser('alpha', 'Test1234!aA', 'user', undefined, 1);
    const b = userRepo.createUser('bravo', 'Test1234!aA', 'user', undefined, 2);
    addGamePlayer(1, 9001, 42);
    addGamePlayer(2, 9002, 7);
    link(a.id, 1, 9001);
    link(b.id, 2, 9002);
    const bytes = pngBytes(512, 512);
    const { url } = setPlayerAvatar(9001, a.id, bytes, sniffImage(bytes)!);
    setPlayerAvatar(9002, b.id, pngBytes(256, 256), sniffImage(pngBytes(256, 256))!);
    const photos = linkedPhotoUrlsForClan(1);
    expect([...photos.entries()]).toEqual([[9001, url]]);
  });

  it("alts each show their own photo; the account shows its main player's", () => {
    const u = userRepo.createUser('twins', 'Test1234!aA', 'user', undefined, 1);
    addGamePlayer(1, 9101, 42);
    addGamePlayer(1, 9102, 7);
    const now = new Date().toISOString();
    for (const p of [9101, 9102]) {
      getDb().prepare('INSERT INTO user_game_links (user_id, clan_id, player_id, player_name, linked_at, synced_at) VALUES (?, 1, ?, ?, ?, ?)')
        .run(u.id, p, `Player ${p}`, now, now);
    }
    const one = setPlayerAvatar(9101, u.id, pngBytes(512, 512), sniffImage(pngBytes(512, 512))!);
    const two = setPlayerAvatar(9102, u.id, pngBytes(256, 256), sniffImage(pngBytes(256, 256))!);
    expect(linkedPhotoUrlsForClan(1)).toEqual(new Map([[9101, one.url], [9102, two.url]]));
    expect(resolveAccountAvatar(u, 1).url).toBe(one.url);
    setMainPlayer(u.id, 1, 9102);
    expect(resolveAccountAvatar(u, 1).url).toBe(two.url);
    expect(accountPlayers(u.id).map((p) => [p.playerId, p.isMain, p.avatar.url])).toEqual([[9101, false, one.url], [9102, true, two.url]]);
  });

  it("keeps resolveAccountAvatar's order", () => {
    expect(resolveMemberAvatar('kael', 'hero-url', 'own-photo-url')).toEqual({ kind: 'photo', url: 'own-photo-url', initial: 'K' });
    expect(resolveMemberAvatar('kael', 'hero-url', null)).toEqual({ kind: 'hero', url: 'hero-url', initial: 'K' });
    expect(resolveMemberAvatar('kael', null, null)).toEqual({ kind: 'initial', url: null, initial: 'K' });
  });
});
