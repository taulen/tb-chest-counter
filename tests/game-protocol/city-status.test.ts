/**
 * Shield and burning state of member cities from the map (v112): the current
 * state on game_players, a history row only when it is first seen or flips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { saveCityStatuses, savePlayers } from '../../src/data/repositories/game-protocol-repo.js';
import { getGamePlayer } from '../../src/data/repositories/game-profile-repo.js';
import type { PlayerRecord } from '../../src/game-protocol/messages.js';
import { gapMs } from '../../src/utils/request-gap.js';
import { makeTestDb } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

const CLAN = 1;
const P = 1297080171719;
const player: PlayerRecord = {
  playerId: P, name: 'taulen302', position: [260, 803, 165], heroAvatar: 9, heroLevel: 214, cityLevel: 44, vip: 17,
  might: 295274115, clanId: 1297080123906, clanTag: 'CWB', cityId: 1297100544969, goldPass: false, goldIngots: 12169,
};
const history = () => getDb().prepare('SELECT changed_at, shielded, burning FROM game_city_status_history WHERE clan_id = ? AND player_id = ? ORDER BY changed_at')
  .all(CLAN, P) as Array<{ changed_at: string; shielded: number; burning: number }>;

describe('city shield / burning', () => {
  it('keeps the current state and a history row only when it changes', () => {
    savePlayers(CLAN, [{ playerId: P, role: 4, joinedAt: 1790000000 }], [player], '2026-11-17T10:00:00Z', '2026-11-16');
    expect(getGamePlayer(CLAN, P)).toMatchObject({ shielded: null, burning: null, mapSeenAt: null });

    expect(saveCityStatuses(CLAN, [{ playerId: P, shielded: true, burning: false }], '2026-11-17T10:00:00Z')).toBe(1);
    expect(saveCityStatuses(CLAN, [{ playerId: P, shielded: true, burning: false }], '2026-11-17T10:20:00Z')).toBe(0);
    expect(saveCityStatuses(CLAN, [{ playerId: P, shielded: false, burning: true }], '2026-11-17T10:40:00Z')).toBe(1);
    // Someone who isn't a stored player of this clan is ignored.
    expect(saveCityStatuses(CLAN, [{ playerId: 42, shielded: true, burning: true }], '2026-11-17T10:40:00Z')).toBe(0);

    expect(getGamePlayer(CLAN, P)).toMatchObject({ shielded: false, burning: true, mapSeenAt: '2026-11-17T10:40:00Z' });
    expect(history()).toEqual([
      { changed_at: '2026-11-17T10:00:00Z', shielded: 1, burning: 0 },
      { changed_at: '2026-11-17T10:40:00Z', shielded: 0, burning: 1 },
    ]);
  });
});

describe('request gaps', () => {
  it('vary within the range, never one fixed tick', () => {
    expect(gapMs(25, 75, () => 0)).toBe(25);
    expect(gapMs(25, 75, () => 1)).toBe(75);
    expect(gapMs(25, 75, () => 0.5)).toBe(50);
    expect(gapMs(75, 25, () => 0)).toBe(25); // reversed bounds still work
    const seen = new Set(Array.from({ length: 50 }, () => gapMs(25, 75)));
    expect(seen.size).toBeGreaterThan(5);
    for (const v of seen) expect(v).toBeGreaterThanOrEqual(25), expect(v).toBeLessThanOrEqual(75);
  });
});
