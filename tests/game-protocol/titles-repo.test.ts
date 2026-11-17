/**
 * Players' titles as stored (v125): one row per grant (title, assigned_at),
 * first/last sighting, gone_at once a read lacks it — and replays of archived
 * city reads in any order that never mark a current title gone, never date a
 * grant's absence before it was received, and widen first_seen backwards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { savePlayers, saveTitleCounts, saveTitles } from '../../src/data/repositories/game-protocol-repo.js';
import { getPlayerTitles } from '../../src/data/repositories/game-profile-repo.js';
import type { PlayerRecord } from '../../src/game-protocol/messages.js';
import type { HeldTitle } from '../../src/game-protocol/titles.js';
import { makeTestDb } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

const CLAN = 1;
const P = 4599909974049;
// Prefect received 2026-11-11T10:16:09Z, Crypt Delver 2026-11-04T17:11:07Z.
const PREFECT = 1794392169;
const DELVER = 1793812267;
const held = (titleId: number, assignedAt: number, eventId: number | null = null): HeldTitle => ({ titleId, assignedAt, eventId });
const rows = () => getDb().prepare(
  `SELECT title_id, assigned_at, event_id, first_seen, last_seen, gone_at FROM game_player_titles
    WHERE clan_id = ? AND player_id = ? ORDER BY assigned_at, title_id`,
).all(CLAN, P);

describe('saveTitles', () => {
  it('keeps one row per grant and marks it gone at the first read without it', () => {
    expect(saveTitles(CLAN, P, [held(29, PREFECT), held(375, DELVER)], '2026-11-17T10:00:00Z')).toBe(2);
    expect(saveTitles(CLAN, P, [held(29, PREFECT), held(375, DELVER)], '2026-11-17T10:20:00Z')).toBe(0);
    // Prefect ran out (or was taken): gone at this read, the row kept.
    expect(saveTitles(CLAN, P, [held(375, DELVER)], '2026-11-18T11:00:00Z')).toBe(1);
    expect(saveTitles(CLAN, P, [held(375, DELVER)], '2026-11-18T11:20:00Z')).toBe(0);
    expect(rows()).toEqual([
      { title_id: 375, assigned_at: DELVER, event_id: null, first_seen: '2026-11-17T10:00:00Z', last_seen: '2026-11-18T11:20:00Z', gone_at: null },
      { title_id: 29, assigned_at: PREFECT, event_id: null, first_seen: '2026-11-17T10:00:00Z', last_seen: '2026-11-17T10:20:00Z', gone_at: '2026-11-18T11:00:00Z' },
    ]);
    // Received again a week later: a new grant, a new row.
    expect(saveTitles(CLAN, P, [held(29, PREFECT + 7 * 86400), held(375, DELVER)], '2026-11-18T18:00:00Z')).toBe(1);
    expect(getPlayerTitles(CLAN, P).map((t) => [t.titleId, t.assignedAt])).toEqual([[29, PREFECT + 7 * 86400], [375, DELVER]]);
  });

  it('replays older archived reads without undoing newer ones', () => {
    // Today's player record first (the scan), then the archive, oldest first.
    saveTitles(CLAN, P, [held(29, PREFECT), held(375, DELVER)], '2026-11-17T18:00:00Z');
    // A read from before Prefect was received says nothing about it.
    saveTitles(CLAN, P, [held(375, DELVER, 53)], '2026-11-10T04:00:00Z');
    saveTitles(CLAN, P, [held(29, PREFECT, 0), held(375, DELVER, 53)], '2026-11-16T04:25:52Z');
    expect(rows()).toEqual([
      { title_id: 375, assigned_at: DELVER, event_id: 53, first_seen: '2026-11-10T04:00:00Z', last_seen: '2026-11-17T18:00:00Z', gone_at: null },
      { title_id: 29, assigned_at: PREFECT, event_id: 0, first_seen: '2026-11-16T04:25:52Z', last_seen: '2026-11-17T18:00:00Z', gone_at: null },
    ]);
    // Replaying the same reads again changes nothing.
    expect(saveTitles(CLAN, P, [held(29, PREFECT, 0), held(375, DELVER, 53)], '2026-11-16T04:25:52Z')).toBe(0);
    expect(rows()).toHaveLength(2);
  });

  it('dates an end from the archive, and moves it earlier when an older read lacks it', () => {
    // A title only the archive saw: held on the 12th, gone by the 14th.
    saveTitles(CLAN, P, [held(101, 1794300000)], '2026-11-12T04:00:00Z');
    saveTitles(CLAN, P, [], '2026-11-16T04:00:00Z');
    saveTitles(CLAN, P, [], '2026-11-14T04:00:00Z');
    expect(rows()).toEqual([
      { title_id: 101, assigned_at: 1794300000, event_id: null, first_seen: '2026-11-12T04:00:00Z', last_seen: '2026-11-12T04:00:00Z', gone_at: '2026-11-14T04:00:00Z' },
    ]);
    expect(getPlayerTitles(CLAN, P)).toEqual([]);
    // Seen again after the gone mark: the mark was wrong (a partial read), cleared.
    saveTitles(CLAN, P, [held(101, 1794300000)], '2026-11-15T04:00:00Z');
    expect(getPlayerTitles(CLAN, P).map((t) => t.titleId)).toEqual([101]);
  });
});

describe('title counts and the player record', () => {
  const player = (titles: HeldTitle[] | null, titleCounts: Record<string, number> | null): PlayerRecord => ({
    playerId: P, name: 'Faulx', position: [289, 500, 500], heroAvatar: 9, heroLevel: 214, cityLevel: 44, vip: 17,
    might: 295274115, clanId: 1297080123906, clanTag: 'CWB', cityId: 1297100544969, goldPass: false, goldIngots: 12169,
    titles, titleCounts,
  });
  const member = [{ playerId: P, role: 4, joinedAt: 1790000000 }];

  it('stores what every scan reads, with how often each title was received', () => {
    savePlayers(CLAN, member, [player([held(29, PREFECT), held(161, 1794840304)], { 29: 2, 161: 190, 375: 3 })], '2026-11-17T10:00:00Z', '2026-11-16');
    expect(getPlayerTitles(CLAN, P)).toEqual([
      { titleId: 161, assignedAt: 1794840304, eventId: null, firstSeen: '2026-11-17T10:00:00Z', lastSeen: '2026-11-17T10:00:00Z', times: 190 },
      { titleId: 29, assignedAt: PREFECT, eventId: null, firstSeen: '2026-11-17T10:00:00Z', lastSeen: '2026-11-17T10:00:00Z', times: 2 },
    ]);
    // A record without the fields (an unknown shape) leaves what is stored alone.
    savePlayers(CLAN, member, [player(null, null)], '2026-11-17T10:20:00Z', '2026-11-16');
    expect(getPlayerTitles(CLAN, P)).toHaveLength(2);
    // A count that moves keeps when it was first read.
    saveTitleCounts(CLAN, P, { 29: 3 }, '2026-11-18T18:00:00Z');
    expect(getDb().prepare('SELECT times, first_seen, updated_at FROM game_player_title_counts WHERE clan_id = ? AND player_id = ? AND title_id = 29').get(CLAN, P))
      .toEqual({ times: 3, first_seen: '2026-11-17T10:00:00Z', updated_at: '2026-11-18T18:00:00Z' });
  });

  it('only stores clan members', () => {
    savePlayers(CLAN, [], [player([held(29, PREFECT)], { 29: 1 })], '2026-11-17T10:00:00Z', '2026-11-16');
    expect(getPlayerTitles(CLAN, P)).toEqual([]);
  });
});
