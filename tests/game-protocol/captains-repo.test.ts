/**
 * Captains read from city field 9 (v108): the current row per captain, and a
 * history row only when a captain is new or its level or star level moved —
 * experience alone moves with every battle and must not fill the history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { playersWithCaptains, rawCitiesMissingData, saveCaptains, saveRawSnapshot, saveTechs } from '../../src/data/repositories/game-protocol-repo.js';
import { getPlayerCaptainChanges, getPlayerCaptains, getPlayerHeroEntry } from '../../src/data/repositories/game-profile-repo.js';
import { makeTestDb } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

const PLAYER = 4599909974644;
const cap = (id: number, level: number, stars: number, xp = level * 1000, slot = 0) => ({ id, level, stars, xp, slot });

describe('captains', () => {
  it('keeps the current values and a history row only when level or stars move', () => {
    const clanId = 1;
    // First read: the baseline (Carter in slot 1, Cleopatra).
    expect(saveCaptains(clanId, PLAYER, [cap(8, 199, 6, 600, 1), cap(20, 278, 5)], '2026-11-17T01:00:00Z')).toBe(2);
    // XP alone moved: no history row.
    expect(saveCaptains(clanId, PLAYER, [cap(8, 199, 6, 650, 1), cap(20, 278, 5)], '2026-11-17T03:00:00Z')).toBe(0);
    // Carter levels up, Cleopatra gains a star, Hercules is new.
    expect(saveCaptains(clanId, PLAYER, [cap(8, 200, 6, 700, 1), cap(20, 278, 6), cap(28, 164, 4, 0, 2)], '2026-11-17T05:00:00Z')).toBe(3);

    expect(getPlayerCaptains(clanId, PLAYER).map((c) => [c.captainId, c.level, c.stars, c.xp, c.slot])).toEqual([
      [20, 278, 6, 278000, 0],
      [8, 200, 6, 700, 1],
      [28, 164, 4, 0, 2],
    ]);
    expect(playersWithCaptains(clanId)).toEqual(new Set([PLAYER]));

    // Changes leave the baseline out and carry what each moved from.
    const changes = getPlayerCaptainChanges(clanId, PLAYER, '2026-11-01T00:00:00Z');
    expect(changes.map((c) => [c.captainId, c.prevLevel, c.level, c.prevStars, c.stars])).toEqual([
      [20, 278, 278, 5, 6],
      [8, 199, 200, 6, 6],
      [28, null, 164, null, 4],
    ]);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM game_player_captain_history').get()).toEqual({ n: 5 });
  });

  it('hands back the latest archived city of a player missing research or captains, until both are stored', () => {
    const clanId = 1;
    const body = [[[[[[4599920185526]]], []]]];
    saveRawSnapshot(clanId, 'city', PLAYER, '2026-11-16', [['older']], '2026-11-16T05:00:00Z');
    saveRawSnapshot(clanId, 'city', PLAYER, '2026-11-17', body, '2026-11-17T04:27:00Z');
    expect(rawCitiesMissingData(clanId)).toEqual([{ playerId: PLAYER, capturedAt: '2026-11-17T04:27:00Z', body }]);

    saveCaptains(clanId, PLAYER, [cap(8, 200, 6)], '2026-11-17T04:27:00Z');
    expect(rawCitiesMissingData(clanId)).toHaveLength(1); // research still missing
    saveTechs(clanId, PLAYER, { 1000: 1 }, '2026-11-17T04:27:00Z');
    expect(rawCitiesMissingData(clanId)).toEqual([]);
  });

  it("stores the hero's entry (id 1) for its level and XP, outside the captains and their history", () => {
    const clanId = 1;
    saveCaptains(clanId, PLAYER, [cap(1, 213, 0, 2_200_000_000_000), cap(8, 200, 6)], '2026-11-17T01:00:00Z');
    // The hero levels up: not a captain change (its level history is game_players.hero_level).
    expect(saveCaptains(clanId, PLAYER, [cap(1, 214, 0, 2_295_854_228_842), cap(8, 200, 6)], '2026-11-17T03:00:00Z')).toBe(0);

    expect(getPlayerCaptains(clanId, PLAYER).map((c) => c.captainId)).toEqual([8]);
    expect(getPlayerHeroEntry(clanId, PLAYER)).toMatchObject({ captainId: 1, level: 214, xp: 2_295_854_228_842 });
    expect(getDb().prepare('SELECT captain_id FROM game_player_captain_history').all()).toEqual([{ captain_id: 8 }]);
    expect(getPlayerHeroEntry(clanId, PLAYER + 1)).toBeNull();
  });
});
