import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config/index.js', () => ({
  loadConfig: () => ({ gameDayRolloverUtcHour: 17 }),
  getConfig: () => ({ gameDayRolloverUtcHour: 17 }),
  resetConfig: vi.fn(),
}));

import { getDb } from '../../../src/data/database.js';
import {
  getClanGuardsOverview,
  getGuardsLevels,
  getGuardsSummaries,
} from '../../../src/data/repositories/guards-repo.js';
import {
  getGoldPassStatuses,
  goldPassForWindow,
  goldPassHoldersNow,
  triumphalCycle,
} from '../../../src/data/repositories/gold-pass-repo.js';
import { invalidate } from '../../../src/utils/ttl-cache.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import { linkPlayer, readResearch, useResearchTrees } from '../../helpers/research-tiers.js';

const ROLLOVER = 17;

function member(clanId: number, name: string): number {
  const now = new Date().toISOString();
  return (getDb().prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (?, ?, ?, ?, ?, 1) RETURNING id`,
  ).get(clanId, name, name.toLowerCase(), now, now) as { id: number }).id;
}

describe('guards-repo (Guardsmen tier from research)', () => {
  let cleanup: () => void;
  let undoTrees: () => void;
  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
    undoTrees = useResearchTrees();
  });
  afterEach(() => {
    undoTrees();
    cleanup();
  });

  it('reads each member\'s level off their research, clan-scoped', () => {
    const taulen = member(1, 'taulen');
    const other = member(2, 'other');
    const unread = member(1, 'unread');
    linkPlayer(taulen, 101);
    linkPlayer(other, 202);
    linkPlayer(unread, 303);
    readResearch(1, 101, 8, '2026-11-17T20:00:00.000Z', '2026-11-17');
    readResearch(2, 202, 5, '2026-11-17T20:00:00.000Z', '2026-11-17');

    const clan1 = getGuardsLevels(1);
    expect(clan1.get(taulen)).toEqual({ level: 8, asOf: '2026-11-17', firstSeen: '2026-11-17', levelUps: [] });
    // Linked but never read: no level, never a guess.
    expect(clan1.has(unread)).toBe(false);
    expect(clan1.has(other)).toBe(false);
    expect(getGuardsLevels(2).get(other)?.level).toBe(5);
  });

  it('dates a level-up between the read before and the read that saw it', () => {
    const m = member(1, 'climber');
    linkPlayer(m, 101);
    readResearch(1, 101, 6, '2026-11-17T20:00:00.000Z', '2026-11-17');
    readResearch(1, 101, 6, '2026-11-18T20:00:00.000Z', '2026-11-18');
    readResearch(1, 101, 7, '2026-11-20T09:00:00.000Z', '2026-11-19');

    expect(getGuardsLevels(1).get(m)).toEqual({
      level: 7,
      asOf: '2026-11-19',
      // G6 was held at the first read: reached before it, so not a level-up.
      firstSeen: '2026-11-17',
      levelUps: [{ from: 6, to: 7, after: '2026-11-18', by: '2026-11-19' }],
    });
    expect(getGuardsSummaries(1, '2026-11-20').get(m)).toEqual({
      level: 7, asOf: '2026-11-19', stale: false,
      lastLevelUp: { from: 6, to: 7, after: '2026-11-18', by: '2026-11-19' },
    });
  });

  it('marks a level old once the research has not been read for a week', () => {
    const m = member(1, 'gone-quiet');
    linkPlayer(m, 101);
    readResearch(1, 101, 7, '2026-11-17T20:00:00.000Z', '2026-11-17');
    expect(getGuardsSummaries(1, '2026-11-20').get(m)?.stale).toBe(false);
    expect(getGuardsSummaries(1, '2026-11-30').get(m)?.stale).toBe(true);
  });

  it('summarises the active roster for the analytics overview', () => {
    const a = member(1, 'a');
    const c = member(1, 'c');
    member(1, 'never-read');
    linkPlayer(a, 101);
    linkPlayer(c, 102);
    readResearch(1, 101, 7, '2026-11-17T20:00:00.000Z', '2026-11-17');
    readResearch(1, 102, 8, '2026-11-17T20:00:00.000Z', '2026-11-17');
    readResearch(1, 101, 8, '2026-11-18T20:00:00.000Z', '2026-11-18');

    const o = getClanGuardsOverview(1, '2026-11-19');
    expect(o.distribution).toEqual([{ level: 8, members: 2 }]);
    expect(o.known).toBe(2);
    expect(o.unknown).toBe(1);
    expect(o.recentLevelUps).toMatchObject([{ memberId: a, name: 'a', from: 7, to: 8, by: '2026-11-18' }]);
  });
});

describe('gold-pass-repo (the game\'s flag)', () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
  });
  afterEach(() => cleanup());

  function player(clanId: number, memberId: number, playerId: number, goldPass: boolean): void {
    getDb().prepare('UPDATE members SET game_player_id = ? WHERE id = ?').run(playerId, memberId);
    getDb().prepare(
      `INSERT INTO game_players (clan_id, player_id, name, gold_pass, first_seen, last_seen)
       VALUES (?, ?, 'p', ?, '', '')`,
    ).run(clanId, playerId, goldPass ? 1 : 0);
  }

  /** A history row: the record as one scan read it. */
  function seen(clanId: number, playerId: number, atIso: string, goldPass: boolean): void {
    getDb().prepare(
      `INSERT INTO game_player_history (clan_id, player_id, captured_at, name, gold_pass) VALUES (?, ?, ?, 'p', ?)`,
    ).run(clanId, playerId, atIso, goldPass ? 1 : 0);
    invalidate('');
  }

  it('holds this cycle exactly the members the game flags now', () => {
    const holder = member(1, 'holder');
    const none = member(1, 'none');
    player(1, holder, 101, true);
    player(1, none, 102, false);
    expect(goldPassHoldersNow(1)).toEqual(new Set([holder]));
    expect(getGoldPassStatuses(1, Date.now(), ROLLOVER)).toEqual(new Map([[holder, 'current']]));
  });

  it('counts a window from the history, carrying the flag in from before it', () => {
    const early = member(1, 'early');
    const late = member(1, 'late');
    const lapsed = member(1, 'lapsed');
    player(1, early, 101, true);
    player(1, late, 102, true);
    player(1, lapsed, 103, false);
    seen(1, 101, '2026-10-01T00:00:00.000Z', true); // on before the window, still on
    seen(1, 102, '2026-10-01T00:00:00.000Z', false);
    seen(1, 102, '2026-10-25T00:00:00.000Z', true); // switched on inside it
    seen(1, 103, '2026-10-01T00:00:00.000Z', true);
    seen(1, 103, '2026-10-10T00:00:00.000Z', false); // off before the window

    const w = goldPassForWindow(1, '2026-10-22T17:00:00.000Z', '2026-11-21T17:00:00.000Z');
    expect(w.basis).toBe('game');
    expect(w.memberIds).toEqual(new Set([early, late]));

    // History starting inside a window covers only part of it; before, none.
    expect(goldPassForWindow(1, '2026-09-20T17:00:00.000Z', '2026-10-05T17:00:00.000Z').basis).toBe('partial');
    expect(goldPassForWindow(1, '2026-08-20T17:00:00.000Z', '2026-09-19T17:00:00.000Z')).toEqual({ basis: 'none', memberIds: new Set() });
  });

  it('marks last cycle\'s holders as previous until the game flags them again', () => {
    const now = Date.now();
    const prev = triumphalCycle(now, ROLLOVER, 1)!;
    const lapsed = member(1, 'lapsed');
    player(1, lapsed, 101, false);
    seen(1, 101, new Date(Date.parse(prev.from) + 86_400_000).toISOString(), true);
    seen(1, 101, new Date(Date.parse(prev.to) + 86_400_000).toISOString(), false);
    expect(getGoldPassStatuses(1, now, ROLLOVER).get(lapsed)).toBe('previous');
  });
});
