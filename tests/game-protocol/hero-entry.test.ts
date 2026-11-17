/**
 * The hero's own field-9 entry (level, XP) from the archive replay, and its
 * level-ups from the player record history (Nov 2026: the Captains tab's hero
 * gets the captains' details).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveCaptains, saveHeroEntryFromArchive, savePlayers } from '../../src/data/repositories/game-protocol-repo.js';
import { getPlayerHeroEntry, getPlayerHeroLevelChanges } from '../../src/data/repositories/game-profile-repo.js';
import type { CityCaptain, ClanMember, PlayerRecord } from '../../src/game-protocol/messages.js';
import { makeTestDb } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

const CLAN = 1;
const PLAYER = 4599909974644;
const hero = (level: number, xp: number): CityCaptain => ({ id: 1, level, stars: 0, xp, slot: 0, equipment: [] } as unknown as CityCaptain);

describe('hero entry from the archive', () => {
  it('keeps the newest read whatever the replay order, and the earliest as first seen', () => {
    // A live read today stored first...
    saveCaptains(CLAN, PLAYER, [hero(214, 900)], '2026-11-17T14:30:00Z');
    // ...then the archive replays, oldest first: older reads never win.
    saveHeroEntryFromArchive(CLAN, PLAYER, hero(212, 100), '2026-11-10T10:00:00Z');
    saveHeroEntryFromArchive(CLAN, PLAYER, hero(213, 500), '2026-11-15T10:00:00Z');
    expect(getPlayerHeroEntry(CLAN, PLAYER)).toMatchObject({ level: 214, xp: 900, firstSeen: '2026-11-10T10:00:00Z', lastSeen: '2026-11-17T14:30:00Z' });
  });

  it('fills a hero with no entry, newest archived read last', () => {
    saveHeroEntryFromArchive(CLAN, PLAYER, hero(212, 100), '2026-11-10T10:00:00Z');
    saveHeroEntryFromArchive(CLAN, PLAYER, hero(213, 500), '2026-11-15T10:00:00Z');
    expect(getPlayerHeroEntry(CLAN, PLAYER)).toMatchObject({ level: 213, xp: 500, firstSeen: '2026-11-10T10:00:00Z' });
  });

  it('ignores anything but the hero entry', () => {
    expect(saveHeroEntryFromArchive(CLAN, PLAYER, { ...hero(50, 1), id: 7 } as CityCaptain, '2026-11-10T10:00:00Z')).toBe(0);
    expect(getPlayerHeroEntry(CLAN, PLAYER)).toBeNull();
  });
});

describe('hero level-ups', () => {
  const members: ClanMember[] = [{ playerId: PLAYER, role: 5, joinedAt: 1790000000 }];
  const player = (heroLevel: number): PlayerRecord => ({
    playerId: PLAYER, name: 'baron', position: [1071, 549, 527], heroAvatar: 2, heroLevel, cityLevel: 30, vip: 12,
    might: 29724600, clanId: 999, clanTag: 'TST', cityId: 4599917580129, goldPass: false, goldIngots: null,
  });

  it('lists each change, newest first, never the first reading', () => {
    savePlayers(CLAN, members, [player(210)], '2026-11-10T10:00:00Z', '2026-11-09');
    savePlayers(CLAN, members, [player(211)], '2026-11-12T10:00:00Z', '2026-11-11');
    savePlayers(CLAN, members, [player(213)], '2026-11-15T10:00:00Z', '2026-11-14');
    expect(getPlayerHeroLevelChanges(CLAN, PLAYER, '2026-11-01T00:00:00Z')).toEqual([
      { level: 213, prevLevel: 211, changedAt: '2026-11-15T10:00:00Z' },
      { level: 211, prevLevel: 210, changedAt: '2026-11-12T10:00:00Z' },
    ]);
    expect(getPlayerHeroLevelChanges(CLAN, PLAYER, '2026-11-13T00:00:00Z')).toHaveLength(1);
  });
});
