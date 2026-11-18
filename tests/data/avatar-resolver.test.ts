import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The account ↔ game player link is a seam the invite branch fills in; stub it
// here so the hero step can be exercised before that exists.
const linked = vi.hoisted(() => ({ map: new Map<string, number>() }));
vi.mock('../../src/data/repositories/account-link.js', () => ({
  linkedGamePlayerId: (userId: number, clanId: number) => linked.map.get(`${userId}:${clanId}`) ?? null,
}));
// Hero art comes from the extracted game bundles, which tests don't have.
vi.mock('../../src/data/repositories/game-profile-repo.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/data/repositories/game-profile-repo.js')>()),
  heroAvatarUrl: (id: number | null | undefined) => (id ? `/game-art/test/hero-${id}.png` : null),
}));

import { getDb } from '../../src/data/database.js';
import * as userRepo from '../../src/data/repositories/user-repo.js';
import { resolveAccountAvatar, setUserAvatar, removeUserAvatar, avatarInitial } from '../../src/data/repositories/avatar-repo.js';
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

describe('resolveAccountAvatar: photo → game hero → initial', () => {
  let cleanup: () => void;
  let user: userRepo.User;

  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
    linked.map.clear();
    user = userRepo.createUser('valka', 'Test1234!aA', 'user', undefined, 1);
  });
  afterEach(() => cleanup());

  it('shows the initial for an account with no photo and no linked player', () => {
    expect(resolveAccountAvatar(user, 1)).toEqual({ kind: 'initial', url: null, initial: 'V' });
  });

  it('shows the linked player\'s hero portrait, in the clan being viewed', () => {
    addGamePlayer(1, 9001, 42);
    addGamePlayer(2, 9002, 7);
    linked.map.set(`${user.id}:1`, 9001);
    linked.map.set(`${user.id}:2`, 9002);
    expect(resolveAccountAvatar(user, 1)).toEqual({ kind: 'hero', url: '/game-art/test/hero-42.png', initial: 'V' });
    expect(resolveAccountAvatar(user, 2)).toEqual({ kind: 'hero', url: '/game-art/test/hero-7.png', initial: 'V' });
  });

  it('falls back to the initial when the linked player has no hero or no row', () => {
    addGamePlayer(1, 9001, null);
    linked.map.set(`${user.id}:1`, 9001);
    expect(resolveAccountAvatar(user, 1).kind).toBe('initial');
    linked.map.set(`${user.id}:1`, 12345); // no game_players row
    expect(resolveAccountAvatar(user, 1).kind).toBe('initial');
    // No clan (a superadmin): no hero to look up.
    expect(resolveAccountAvatar(user, null).kind).toBe('initial');
  });

  it('an uploaded photo wins over the hero, and removing it brings the hero back', () => {
    addGamePlayer(1, 9001, 42);
    linked.map.set(`${user.id}:1`, 9001);
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
