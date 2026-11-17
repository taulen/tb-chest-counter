/**
 * Captains read from city field 9 (v108): the current row per captain, and a
 * history row only when a captain is new or its level or star level moved —
 * experience alone moves with every battle and must not fill the history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { playersWithCaptains, saveCaptains } from '../../src/data/repositories/game-protocol-repo.js';
import { getPlayerCaptainChanges, getPlayerCaptains } from '../../src/data/repositories/game-profile-repo.js';
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
});
