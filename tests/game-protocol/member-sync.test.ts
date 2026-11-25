/**
 * Member sync from the game's own roster (game-protocol/member-sync.ts).
 *
 * The game's player id is permanent, so once a member is linked to it every
 * later cycle is exact. The FIRST link of an existing member is by exact name
 * only — a wrong link would rename someone else's history, so a near-miss
 * spelling is a new member, never a guess.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { upsertMember } from '../../src/data/repositories/member-repo.js';
import { saveSnapshots } from '../../src/data/repositories/might-repo.js';
import { syncMembersFromGame } from '../../src/game-protocol/member-sync.js';
import type { ClanMember, PlayerRecord } from '../../src/game-protocol/messages.js';
import { makeTestDb } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

const DAY = '2026-11-16';
const NOW = '2026-11-16T20:00:00.000Z';

function player(playerId: number, name: string, might: number, heroLevel = 100): PlayerRecord {
  return {
    playerId, name, might, heroLevel, position: [1071, 500, 500], heroAvatar: 1, cityLevel: 30, vip: 10,
    clanId: 999, clanTag: 'TST', cityId: playerId + 1, goldPass: false, goldIngots: null,
  };
}
const rosterOf = (players: PlayerRecord[]): ClanMember[] => players.map((p) => ({ playerId: p.playerId, role: 4, joinedAt: 1790000000 }));

const row = (id: number) =>
  getDb().prepare('SELECT name, aliases, game_player_id, is_active, clan_role FROM members WHERE id = ?').get(id) as
    { name: string; aliases: string; game_player_id: number | null; is_active: number; clan_role: string };
const memberCount = () => (getDb().prepare('SELECT COUNT(*) AS n FROM members WHERE clan_id = 1').get() as { n: number }).n;

describe('syncMembersFromGame', () => {
  it('links an exact name, records the day’s might and hero level, and marks the role', () => {
    const id = upsertMember('Miana', 1).id;
    const p = player(101, 'Miana', 12_500_000, 140);
    const r = syncMembersFromGame(1, rosterOf([p]), [p], DAY, NOW);
    expect(r).toMatchObject({ linked: 1, newlyLinked: 1, created: 0, renamed: 0 });
    expect(r.memberIds.get(101)).toBe(id);
    expect(row(id)).toMatchObject({ game_player_id: 101, clan_role: '4' });
    const snap = getDb().prepare('SELECT power, level FROM member_snapshots WHERE member_id = ? AND game_date = ?').get(id, DAY);
    expect(snap).toEqual({ power: 12_500_000, level: 140 });
  });

  it('never links a near-miss spelling, even with the same might — it is a new member', () => {
    const ocr = upsertMember('Kordobrek1', 1).id;
    saveSnapshots(1, '2026-11-15', '2026-11-15T20:00:00.000Z', [{ memberId: ocr, might: 20_000_000, level: 150 }]);
    const p = player(202, 'Kordobrekl', 20_400_000);
    const r = syncMembersFromGame(1, rosterOf([p]), [p], DAY, NOW);
    expect(r).toMatchObject({ newlyLinked: 0, created: 1, renamed: 0 });
    expect(row(ocr)).toMatchObject({ name: 'Kordobrek1', game_player_id: null });
    expect(memberCount()).toBe(2);
  });

  it('follows an in-game rename through the permanent player id', () => {
    const p = player(303, 'OldName', 1_000_000);
    const first = syncMembersFromGame(1, rosterOf([p]), [p], DAY, NOW);
    const id = first.memberIds.get(303)!;
    const renamed = { ...p, name: 'BrandNew' };
    const r = syncMembersFromGame(1, rosterOf([renamed]), [renamed], DAY, NOW);
    expect(r).toMatchObject({ newlyLinked: 0, created: 0, renamed: 1 });
    expect(r.memberIds.get(303)).toBe(id);
    expect(row(id).name).toBe('BrandNew');
    expect(JSON.parse(row(id).aliases)).toContain('OldName');
  });

  it('keeps a name an admin set by hand, while an untouched member follows the game', () => {
    const p = player(505, 'Нимдуен', 2_000_000);
    const first = syncMembersFromGame(1, rosterOf([p]), [p], DAY, NOW);
    const id = first.memberIds.get(505)!;
    // The admin renames the member on the site.
    getDb().prepare('UPDATE members SET name = ?, normalized_name = ? WHERE id = ?').run('Nimduen', 'nimduen', id);
    // As the site's rename logs it: the member id as a string, no source.
    getDb().prepare("INSERT INTO audit_log (user_id, clan_id, action, details, created_at) VALUES (NULL, 1, 'rename_member', ?, ?)")
      .run(JSON.stringify({ id: String(id), newName: 'Nimduen' }), '2026-11-17T01:52:48.608Z');
    const r = syncMembersFromGame(1, rosterOf([p]), [p], DAY, NOW);
    expect(r.renamed).toBe(0);
    expect(row(id).name).toBe('Nimduen');
    expect(JSON.parse(row(id).aliases)).toContain('Нимдуен');
  });

  it('keeps a second account as its own member, linked to its own player id', () => {
    const main = player(401, 'MainPlayer', 30_000_000, 180);
    const alt = player(402, 'FarmAccount', 2_000_000, 40);
    const r = syncMembersFromGame(1, rosterOf([main, alt]), [main, alt], DAY, NOW);
    expect(r).toMatchObject({ created: 2, renamed: 0 });
    expect(r.memberIds.get(401)).not.toBe(r.memberIds.get(402));
    expect(row(r.memberIds.get(402)!)).toMatchObject({ name: 'FarmAccount', game_player_id: 402 });
  });

  it('marks linked members who left the clan, but never on a suspiciously short roster', () => {
    const players = [1, 2, 3, 4, 5, 6].map((n) => player(n, `Member${n}`, 1_000_000 * n));
    const first = syncMembersFromGame(1, rosterOf(players), players, DAY, NOW);
    const gone = first.memberIds.get(6)!;

    // A two-player read proves nothing about the other four.
    syncMembersFromGame(1, rosterOf(players.slice(0, 2)), players.slice(0, 2), DAY, NOW);
    expect(row(gone).is_active).toBe(1);

    const r = syncMembersFromGame(1, rosterOf(players.slice(0, 5)), players.slice(0, 5), DAY, NOW);
    expect(r.departed).toBe(1);
    expect(row(gone).is_active).toBe(0);

    // Coming back reactivates the same member.
    syncMembersFromGame(1, rosterOf(players), players, DAY, NOW);
    expect(row(gone).is_active).toBe(1);
  });

  it('retires an active member the roster does not account for, but never the [Unknown] placeholder', () => {
    const players = [1, 2, 3, 4, 5].map((n) => player(n, `Member${n}`, 1_000_000 * n));
    const ghost = upsertMember('OldOcrSpelling', 1).id;
    const unknown = upsertMember('[Unknown]', 1).id;
    const r = syncMembersFromGame(1, rosterOf(players), players, DAY, NOW);
    expect(r.departed).toBe(1);
    expect(row(ghost).is_active).toBe(0);
    expect(row(unknown).is_active).toBe(1);
    const audit = getDb().prepare("SELECT details FROM audit_log WHERE action = 'member.left_clan'").all() as Array<{ details: string }>;
    expect(JSON.parse(audit[0].details)).toMatchObject({ name: 'OldOcrSpelling', source: 'game', linked: false });
  });
});
