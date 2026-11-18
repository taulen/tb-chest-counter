// Home → roster changes: the clan's in-game rank changes over a window, from
// game_player_history (the same rows the member timeline reads per member).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { recentRankChanges } from '../../src/data/repositories/roster-changes-repo.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

function history(clanId: number, playerId: number, at: string, role: number | null, name = `p${playerId}`): void {
  getDb().prepare(
    'INSERT INTO game_player_history (clan_id, player_id, captured_at, name, role) VALUES (?, ?, ?, ?, ?)',
  ).run(clanId, playerId, at, name, role);
}

describe('recentRankChanges', () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
  });
  afterEach(() => cleanup());

  it('lists promotions and demotions in the window, newest first, against the rank held before it', () => {
    // A Soldier since long before the window becomes a Superior inside it.
    history(1, 10, '2026-09-01T10:00:00.000Z', 5, 'Ana');
    history(1, 10, '2026-11-15T10:00:00.000Z', 2, 'Ana');
    // An Officer demoted to Veteran.
    history(1, 11, '2026-11-10T10:00:00.000Z', 3, 'Bo');
    history(1, 11, '2026-11-16T12:00:00.000Z', 4, 'Bo');
    // Same rank recorded again: not a change.
    history(1, 12, '2026-11-12T10:00:00.000Z', 4, 'Cy');
    history(1, 12, '2026-11-16T10:00:00.000Z', 4, 'Cy');
    // A first sighting has nothing to change from.
    history(1, 13, '2026-11-16T09:00:00.000Z', 1, 'Di');
    // Another clan's change never shows.
    history(2, 10, '2026-11-01T10:00:00.000Z', 5, 'Ana2');
    history(2, 10, '2026-11-16T10:00:00.000Z', 1, 'Ana2');

    const out = recentRankChanges(1, '2026-11-14T00:00:00.000Z');
    expect(out.map((r) => [r.name, r.from, r.to, r.promoted])).toEqual([
      ['Bo', 3, 4, false],
      ['Ana', 5, 2, true],
    ]);
  });

  it('a change from before the window is left out, and the member link comes from the roster', () => {
    getDb().prepare(
      "INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, game_player_id) VALUES (1, 'Ana', 'ana', '2026-01-01', '2026-11-16', 10)",
    ).run();
    history(1, 10, '2026-11-01T10:00:00.000Z', 5);
    history(1, 10, '2026-11-02T10:00:00.000Z', 3);
    history(1, 10, '2026-11-15T10:00:00.000Z', 2);
    const out = recentRankChanges(1, '2026-11-14T00:00:00.000Z');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: 3, to: 2, promoted: true });
    expect(out[0].memberId).toEqual(expect.any(Number));
  });
});
