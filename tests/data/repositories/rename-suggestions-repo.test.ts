import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import {
  getRenameSuggestions, dismissRenameSuggestion,
} from '../../../src/data/repositories/rename-suggestions-repo.js';
import { makeTestDb } from '../../helpers/test-db.js';

/**
 * Likely renames from the might series hand-over. Fixtures follow the live cases:
 * Cauldron → Aldrin (Nov 2 → Nov 3, L239 488.2M → L241 490.4M) and
 * IamNotHades → Atlas (Oct 29 → Oct 30, L245 312.5M → L245 314.0M).
 */
describe('getRenameSuggestions', () => {
  let cleanup: () => void;
  beforeEach(() => { ({ cleanup } = makeTestDb()); session = 0; });
  afterEach(() => cleanup());

  const NOW = Date.parse('2026-11-04T10:00:00Z');
  const DAY = 86400000;
  let session = 0;

  function member(name: string, series: [string, number, number][], chestDays: string[] = []): number {
    const db = getDb();
    const id = (db.prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (1, ?, ?, ?, ?, 1) RETURNING id`,
    ).get(name, name.toLowerCase(), '2026-10-01T00:00:00Z', '2026-11-04T00:00:00Z') as { id: number }).id;
    const snap = db.prepare(
      `INSERT INTO member_snapshots (member_id, clan_id, level, power, captured_at, game_date)
       VALUES (?, 1, ?, ?, ?, ?)`,
    );
    for (const [day, level, power] of series) snap.run(id, level, power, `${day}T17:30:00Z`, day);
    if (!session) {
      session = (db.prepare(
        `INSERT INTO scan_sessions (clan_id, started_at, status) VALUES (1, '2026-10-01T00:00:00Z', 'completed') RETURNING id`,
      ).get() as { id: number }).id;
      db.prepare("INSERT INTO chests (name) VALUES ('Stone Chest') ON CONFLICT(name) DO NOTHING").run();
    }
    const chest = (db.prepare("SELECT id FROM chests WHERE name = 'Stone Chest'").get() as { id: number }).id;
    const ins = db.prepare(
      `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at)
       VALUES (1, ?, ?, ?, 5, ?)`,
    );
    chestDays.forEach((d, i) => ins.run(session, id, chest, Date.parse(`${d}T12:00:00Z`) + id * 1000 + i));
    return id;
  }

  it('pairs a series that ends with one that starts the next day at the same level and might', () => {
    const cauldron = member('Cauldron', [['2026-11-01', 239, 488196331], ['2026-11-02', 239, 488196331]], ['2026-11-01', '2026-11-03']);
    const aldrin = member('Aldrin', [['2026-11-03', 241, 490352131], ['2026-11-04', 241, 490400000]], ['2026-11-03']);
    member('Bystander', [['2026-11-01', 100, 50000000], ['2026-11-04', 101, 51000000]]);

    const out = getRenameSuggestions(1, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].from).toMatchObject({ memberId: cauldron, name: 'Cauldron', gameDate: '2026-11-02', chests: 2 });
    expect(out[0].to).toMatchObject({ memberId: aldrin, name: 'Aldrin', gameDate: '2026-11-03', chests: 1 });
    expect(out[0].powerChangePct).toBeCloseTo(0.44, 2);
  });

  it('allows a 0 level (badge unread) and a short gap in the readings', () => {
    member('IamNotHades', [['2026-10-27', 245, 312546871]]);
    member('Atlas', [['2026-10-30', 0, 314048871]]);
    expect(getRenameSuggestions(1, NOW).map((s) => `${s.from.name}>${s.to.name}`)).toEqual(['IamNotHades>Atlas']);
  });

  it('rejects overlapping series, a might drop or jump, and a level drop', () => {
    member('Overlap A', [['2026-11-01', 200, 300000000], ['2026-11-03', 200, 300000000]]);
    member('Overlap B', [['2026-11-03', 200, 300500000]]);
    member('Drop A', [['2026-11-01', 150, 200000000]]);
    member('Drop B', [['2026-11-02', 150, 190000000]]);
    member('Jump A', [['2026-11-01', 160, 100000000]]);
    member('Jump B', [['2026-11-02', 160, 110000000]]);
    member('Level A', [['2026-11-01', 180, 250000000]]);
    member('Level B', [['2026-11-02', 170, 250500000]]);
    expect(getRenameSuggestions(1, NOW)).toEqual([]);
  });

  it('rejects a pair when the old name keeps collecting chests after the switch', () => {
    member('Still Here', [['2026-10-25', 210, 400000000]], ['2026-10-25', '2026-11-02']);
    member('Newcomer', [['2026-10-26', 211, 401000000]]);
    expect(getRenameSuggestions(1, NOW)).toEqual([]);
  });

  it('ignores hand-overs older than the window', () => {
    member('Long Ago', [['2026-09-01', 120, 90000000]]);
    member('Renamed Long Ago', [['2026-09-02', 120, 90100000]]);
    expect(getRenameSuggestions(1, NOW)).toEqual([]);
    expect(getRenameSuggestions(1, Date.parse('2026-09-05T00:00:00Z'))).toHaveLength(1);
  });

  it('uses each member once, keeping the closest might', () => {
    member('Old', [['2026-11-01', 200, 300000000]]);
    member('Close', [['2026-11-02', 200, 300300000]]);
    member('Further', [['2026-11-02', 200, 306000000]]);
    const out = getRenameSuggestions(1, NOW);
    expect(out.map((s) => `${s.from.name}>${s.to.name}`)).toEqual(['Old>Close']);
  });

  it('stops suggesting a pair once dismissed, and only that pair', () => {
    const a = member('Twin A', [['2026-11-01', 200, 300000000]]);
    const b = member('Twin B', [['2026-11-02', 200, 300300000]]);
    dismissRenameSuggestion(1, a, b);
    dismissRenameSuggestion(1, a, b); // idempotent
    expect(getRenameSuggestions(1, NOW)).toEqual([]);
    expect(getRenameSuggestions(1, NOW + DAY)).toEqual([]);
  });

  it('is scoped to the clan', () => {
    member('Cauldron', [['2026-11-02', 239, 488196331]]);
    member('Aldrin', [['2026-11-03', 241, 490352131]]);
    expect(getRenameSuggestions(2, NOW)).toEqual([]);
  });
});
