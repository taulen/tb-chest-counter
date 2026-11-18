import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hero art comes from the extracted game bundles, which tests don't have.
vi.mock('../../src/data/repositories/game-profile-repo.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/data/repositories/game-profile-repo.js')>()),
  heroAvatarUrl: (id: number | null | undefined) => (id ? `/game-art/test/hero-${id}.png` : null),
}));

import { getDb } from '../../src/data/database.js';
import * as userRepo from '../../src/data/repositories/user-repo.js';
import { resolveAccountAvatar, setUserAvatar, removeUserAvatar, avatarInitial, linkedPhotoUrlsForClan, resolveMemberAvatar } from '../../src/data/repositories/avatar-repo.js';
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

  it('an uploaded photo wins over the hero, and removing it brings the hero back', () => {
    addGamePlayer(1, 9001, 42);
    link(user.id, 1, 9001);
    const bytes = pngBytes(512, 512);
    const { url } = setUserAvatar(user.id, bytes, sniffImage(bytes)!);
    expect(url).toMatch(/^\/avatars\/[0-9a-f]{64}\.png$/);
    expect(resolveAccountAvatar(user, 1)).toEqual({ kind: 'photo', url, initial: 'V' });
    expect(removeUserAvatar(user.id)).toBe(true);
    expect(resolveAccountAvatar(user, 1).kind).toBe('hero');
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
    const { url } = setUserAvatar(a.id, bytes, sniffImage(bytes)!);
    setUserAvatar(b.id, pngBytes(256, 256), sniffImage(pngBytes(256, 256))!);
    const photos = linkedPhotoUrlsForClan(1);
    expect([...photos.entries()]).toEqual([[9001, url]]);
  });

  it("keeps resolveAccountAvatar's order", () => {
    expect(resolveMemberAvatar('kael', 'hero-url', 'own-photo-url')).toEqual({ kind: 'photo', url: 'own-photo-url', initial: 'K' });
    expect(resolveMemberAvatar('kael', 'hero-url', null)).toEqual({ kind: 'hero', url: 'hero-url', initial: 'K' });
    expect(resolveMemberAvatar('kael', null, null)).toEqual({ kind: 'initial', url: null, initial: 'K' });
  });
});
