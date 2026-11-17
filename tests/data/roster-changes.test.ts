/**
 * My Clan → Joins & leaves (data/roster-changes.ts): one clan-wide list of who
 * joined, who left and who came back, built from the game's join times, the
 * sync's departures and the member rows. A leave is never shown twice, a join
 * after a recorded leave (or of someone the site already had) is a return,
 * the site's own records say so, and paging is by a stable cursor.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRosterChanges, countRosterChanges, filterRosterChanges, searchKey,
  type RosterMember, type RosterPlayer, type RosterSources,
} from '../../src/data/roster-changes.js';
import { pageNewestFirst, timelineCursor } from '../../src/data/member-timeline.js';

const member = (id: number, name: string, over: Partial<RosterMember> = {}): RosterMember => ({
  id, name, normalizedName: name.toLowerCase(), aliases: [], firstSeen: '2026-12-01T00:00:00Z', lastSeen: '2026-11-17T00:00:00Z',
  isActive: true, leftAt: null, ...over,
});
const player = (playerId: number, name: string, joinedIso: string, over: Partial<RosterPlayer> = {}): RosterPlayer => ({
  playerId, name, joinedAt: Date.parse(joinedIso) / 1000, inClan: true, memberId: null, linked: false, ...over,
});
const left = (at: string, id: number, name: string, linked = true) => ({
  at, action: 'member.left_clan', details: { id, name, source: 'game', linked },
});
const src = (over: Partial<RosterSources>): RosterSources => ({ members: [], players: [], audit: [], ...over });

describe('joins & leaves', () => {
  it('never shows a leave twice: the sync\'s row and the member\'s left_at are one departure', () => {
    const list = buildRosterChanges(src({
      members: [
        // Left through the sync: audit row and left_at a few ms apart.
        member(1, 'Nightfrog', { isActive: false, leftAt: '2026-11-17T17:19:48.640Z' }),
        // Left before the game protocol: only left_at remembers it.
        member(2, 'Clau', { isActive: false, leftAt: '2026-10-23T17:00:00.026Z' }),
      ],
      audit: [left('2026-11-17T17:19:48.634Z', 1, 'Nightfrog')],
    }), 17);
    expect(list.map((e) => [e.name, e.kind, e.source, e.at])).toEqual([
      ['Nightfrog', 'left', 'game', '2026-11-17T17:19:48.634Z'],
      ['Clau', 'left', 'site', '2026-10-23T17:00:00.026Z'],
    ]);
  });

  it('keeps a later removal as a second leave, and calls an unlinked row\'s sweep the site\'s record', () => {
    const list = buildRosterChanges(src({
      members: [
        member(1, 'Bond', { isActive: false, leftAt: '2026-11-20T10:00:00Z' }),
        member(2, 'Sir Grayling', { isActive: false, leftAt: '2026-11-17T03:37:46.250Z' }),
      ],
      audit: [left('2026-11-17T03:00:00Z', 1, 'Bond'), left('2026-11-17T03:37:46.246Z', 2, 'Sir Grayling', false)],
    }), 17);
    expect(list.map((e) => [e.name, e.source, e.at.slice(0, 10)])).toEqual([
      ['Bond', 'site', '2026-11-20'],
      ['Sir Grayling', 'site', '2026-11-17'],
      ['Bond', 'game', '2026-11-17'],
    ]);
  });

  it('calls a join a return after a recorded leave, or when the site had them on the roster before', () => {
    const list = buildRosterChanges(src({
      members: [
        member(1, 'Kern', { firstSeen: '2026-11-01T00:00:00Z' }),
        member(2, 'Nightfrog', { firstSeen: '2026-08-23T17:35:33Z' }),
        member(3, 'Derda', { firstSeen: '2026-11-16T22:02:33Z' }),
        member(4, 'Close', { firstSeen: '2026-11-16T19:30:00Z' }),
        member(5, 'Blank', { firstSeen: '' }),
      ],
      players: [
        player(10, 'Kern', '2026-11-18T09:00:00Z', { memberId: 1, linked: true }),
        player(11, 'Nightfrog', '2026-11-17T17:15:08Z', { memberId: 2, linked: true }),
        player(12, 'Derda', '2026-11-16T20:18:40Z', { memberId: 3, linked: true }),
        // Seen 30 min before the game's join time: not a return (too close to call).
        player(13, 'Close', '2026-11-16T20:00:00Z', { memberId: 4, linked: true }),
        player(14, 'Blank', '2026-11-16T20:00:00Z', { memberId: 5, linked: true }),
      ],
      audit: [left('2026-11-17T05:00:00Z', 1, 'Kern'), left('2026-11-10T05:00:00Z', 1, 'Kern')],
    }), 17);
    const by = new Map(list.filter((e) => e.kind !== 'left').map((e) => [e.name, e]));
    // The latest leave before the join.
    expect(by.get('Kern')).toMatchObject({ kind: 'returned', source: 'game', prevLeftAt: '2026-11-17T05:00:00Z', seenSince: null, playerId: 10 });
    expect(by.get('Nightfrog')).toMatchObject({ kind: 'returned', prevLeftAt: null, seenSince: '2026-08-23T17:35:33Z' });
    expect(by.get('Derda')).toMatchObject({ kind: 'joined', prevLeftAt: null, seenSince: null });
    expect(by.get('Close')?.kind).toBe('joined');
    expect(by.get('Blank')?.kind).toBe('joined');
  });

  it('a leave AFTER the join does not make the join a return', () => {
    const list = buildRosterChanges(src({
      members: [member(1, 'Nightfrog', { isActive: false, leftAt: '2026-11-17T17:19:48.640Z', firstSeen: '2026-10-22T08:52:31Z' })],
      players: [player(9, 'Nightfrog', '2026-10-21T19:06:20Z', { memberId: 1, linked: true, inClan: false })],
      audit: [left('2026-11-17T17:19:48.634Z', 1, 'Nightfrog')],
    }), 17);
    expect(list.map((e) => e.kind)).toEqual(['left', 'joined']);
  });

  it('shows an admin\'s restore, by name or alias, and leaves the [Unknown] placeholder out', () => {
    const list = buildRosterChanges(src({
      members: [
        member(1, 'Strela Ko6o SK', { aliases: ['Strela'] }),
        member(2, '[Unknown]', { isActive: false, leftAt: '2026-11-12T11:55:45Z' }),
      ],
      audit: [
        { at: '2026-11-13T19:05:35Z', action: 'restore_member', details: { name: 'Strela' } },
        { at: '2026-11-13T19:06:00Z', action: 'restore_member', details: { name: 'Nobody here' } },
        left('2026-11-17T03:00:00Z', 2, '[Unknown]'),
      ],
    }), 17);
    expect(list).toEqual([expect.objectContaining({ kind: 'restored', memberId: 1, name: 'Strela Ko6o SK', asName: 'Strela', source: 'site' })]);
  });

  it('follows merges: a linked player\'s leave goes to the surviving member, an unlinked duplicate\'s is dropped', () => {
    const list = buildRosterChanges(src({
      // Members 5 and 6 were merged into 1 (their names are its aliases).
      members: [member(1, 'Endless Sky SS', { aliases: ['Endless Sky', 'Luna Wolf SS'] })],
      audit: [
        left('2026-11-10T03:00:00Z', 5, 'Endless Sky', true),
        left('2026-11-17T03:37:46Z', 6, 'Luna Wolf SS', false),
        // Gone entirely, never merged: the name stays, unlinked.
        left('2026-11-09T03:00:00Z', 7, 'Wanderer', true),
      ],
    }), 17);
    expect(list.map((e) => [e.memberId, e.name, e.asName])).toEqual([
      [1, 'Endless Sky SS', 'Endless Sky'],
      [null, 'Wanderer', null],
    ]);
  });

  it('shows an alt an admin\'s rule folds into a main under the main, by the alt\'s game name', () => {
    const list = buildRosterChanges(src({
      members: [member(1, 'Endless Sky SS', { firstSeen: '2026-11-20T00:00:00Z' })],
      players: [
        player(20, 'Endless Sky SS ツ', '2026-11-16T22:29:21Z', { memberId: 1, linked: true }),
        player(21, 'Endless Sky ツ', '2026-11-18T10:00:00Z', { memberId: 1, linked: false }),
        player(22, 'Stranger', '2026-11-18T11:00:00Z'),
      ],
    }), 17);
    expect(list.map((e) => [e.playerId, e.memberId, e.name, e.asName])).toEqual([
      [22, null, 'Stranger', null],
      [21, 1, 'Endless Sky SS', 'Endless Sky ツ'],
      [20, 1, 'Endless Sky SS', null],
    ]);
  });

  it('is newest first, ties by key, and keys days by the 17:00 UTC rollover', () => {
    const list = buildRosterChanges(src({
      members: [member(1, 'A'), member(2, 'B'), member(3, 'C', { isActive: false, leftAt: '2026-11-17T18:00:00Z' })],
      players: [
        player(1, 'A', '2026-11-17T10:00:00Z', { memberId: 1, linked: true }),
        player(2, 'B', '2026-11-17T10:00:00Z', { memberId: 2, linked: true }),
      ],
    }), 17);
    expect(list.map((e) => [e.name, e.day])).toEqual([['C', '2026-11-17'], ['A', '2026-11-16'], ['B', '2026-11-16']]);
    expect(list[1].key < list[2].key).toBe(true);
  });

  it('pages by cursor (stable when newer entries arrive), filters by chip and name, counts the window', () => {
    const members = Array.from({ length: 8 }, (_, i) => member(i + 1, `Player ${i + 1}`));
    const players = members.map((m, i) => player(100 + i, m.name, `2026-11-0${i + 1}T12:00:00Z`, { memberId: m.id, linked: true }));
    const roster = src({ members, players });
    const all = buildRosterChanges(roster, 17);
    const p1 = pageNewestFirst(all, { limit: 3 });
    expect(p1.entries.map((e) => e.name)).toEqual(['Player 8', 'Player 7', 'Player 6']);
    // Someone leaves; the next page still continues after p1's last.
    roster.members.push(member(99, 'Éclair', { isActive: false, leftAt: '2026-11-12T00:00:00Z' }));
    const later = buildRosterChanges(roster, 17);
    const p2 = pageNewestFirst(later, { before: p1.next, limit: 3 });
    expect(p2.entries.map((e) => e.name)).toEqual(['Player 5', 'Player 4', 'Player 3']);
    const last = pageNewestFirst(later, { before: timelineCursor(p2.entries[2]), limit: 10 });
    expect(last.entries.map((e) => e.name)).toEqual(['Player 2', 'Player 1']);
    expect(last.next).toBeNull();

    expect(filterRosterChanges(later, { filter: 'left' }).map((e) => e.name)).toEqual(['Éclair']);
    expect(filterRosterChanges(later, { filter: 'joined' })).toHaveLength(8);
    expect(filterRosterChanges(later, { query: 'ECLAIR' }).map((e) => e.name)).toEqual(['Éclair']);
    expect(filterRosterChanges(later, { filter: 'joined', query: 'player 1' }).map((e) => e.name)).toEqual(['Player 1']);
    expect(searchKey('  Ébène   SK ')).toBe('ebene sk');
    expect(countRosterChanges(later, '2026-11-05T00:00:00Z')).toEqual({ joined: 4, returned: 0, left: 1 });
  });
});
