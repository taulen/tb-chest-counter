/**
 * Gold Ingots (402 field 17, v110): public in the game for every player. They
 * tick up by one every few minutes, so they are kept as the current value on
 * game_players and the game day's latest reading in game_player_daily — and a
 * tick alone must never write a game_player_history row (that would be a row
 * per player per scan, and history rows also queue city re-reads).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { savePlayers } from '../../src/data/repositories/game-protocol-repo.js';
import { getGamePlayer, getPlayerGoldIngotsDaily } from '../../src/data/repositories/game-profile-repo.js';
import type { ClanMember, PlayerRecord } from '../../src/game-protocol/messages.js';
import { makeTestDb } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

const CLAN = 1;
const PLAYER = 4599909974644;
const members: ClanMember[] = [{ playerId: PLAYER, role: 5, joinedAt: 1790000000 }];
const player = (goldIngots: number | null, might = 29724600): PlayerRecord => ({
  playerId: PLAYER, name: 'baron', position: [1071, 549, 527], heroAvatar: 2, heroLevel: 116, cityLevel: 30, vip: 12,
  might, clanId: 999, clanTag: 'TST', cityId: 4599917580129, goldPass: false, goldIngots,
});

const daily = () => getDb().prepare('SELECT game_date, gold_ingots FROM game_player_daily WHERE clan_id = ? AND player_id = ? ORDER BY game_date')
  .all(CLAN, PLAYER) as Array<{ game_date: string; gold_ingots: number }>;
const historyRows = () => (getDb().prepare('SELECT COUNT(*) AS n FROM game_player_history WHERE clan_id = ? AND player_id = ?')
  .get(CLAN, PLAYER) as { n: number }).n;

describe('gold ingots', () => {
  it('keeps the current value and the game day\'s latest reading, without history rows for a tick', () => {
    savePlayers(CLAN, members, [player(12163)], '2026-11-17T10:00:00Z', '2026-11-16');
    savePlayers(CLAN, members, [player(12169)], '2026-11-17T10:20:00Z', '2026-11-16');
    savePlayers(CLAN, members, [player(12301)], '2026-11-17T18:00:00Z', '2026-11-17');

    expect(getGamePlayer(CLAN, PLAYER)?.goldIngots).toBe(12301);
    expect(daily()).toEqual([
      { game_date: '2026-11-16', gold_ingots: 12169 },
      { game_date: '2026-11-17', gold_ingots: 12301 },
    ]);
    // Only the first read is history: nothing else the history tracks moved.
    expect(historyRows()).toBe(1);
  });

  it('never blanks a known value when a reply lacks the field', () => {
    savePlayers(CLAN, members, [player(12163)], '2026-11-17T10:00:00Z', '2026-11-16');
    savePlayers(CLAN, members, [player(null)], '2026-11-17T10:20:00Z', '2026-11-16');
    expect(getGamePlayer(CLAN, PLAYER)?.goldIngots).toBe(12163);
    expect(daily()).toEqual([{ game_date: '2026-11-16', gold_ingots: 12163 }]);
  });

  it('serves the Might tab its history: the day\'s last reading per game day, bounded by a start day', () => {
    savePlayers(CLAN, members, [player(12100)], '2026-11-16T10:00:00Z', '2026-11-15');
    savePlayers(CLAN, members, [player(12163)], '2026-11-17T10:00:00Z', '2026-11-16');
    savePlayers(CLAN, members, [player(12169)], '2026-11-17T10:20:00Z', '2026-11-16');
    expect(getPlayerGoldIngotsDaily(CLAN, PLAYER)).toEqual({
      current: 12169,
      readAt: '2026-11-17T10:20:00Z',
      points: [{ gameDate: '2026-11-15', goldIngots: 12100 }, { gameDate: '2026-11-16', goldIngots: 12169 }],
    });
    expect(getPlayerGoldIngotsDaily(CLAN, PLAYER, '2026-11-16').points).toEqual([{ gameDate: '2026-11-16', goldIngots: 12169 }]);
  });
});
