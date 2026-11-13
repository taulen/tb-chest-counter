import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import {
  getRenameSuggestions, dismissRenameSuggestion, namesShareStem, mergeNameMatchedRenames,
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

  // SK7 (clan 5) dropped its kingdom tags on Nov 12 → 13 2026, 41 players at once. With
  // might as the only signal, the closest might belonged to the wrong player four times
  // out of seven here: Living SK7 → Tigger, Arean SK7 → Blas de Lezo S, NoPantsPanda SK7
  // → TASH S, Strela K260 SK → Arean S.
  const SK_NOW = Date.parse('2026-11-13T20:00:00Z');
  const pairs = (out: ReturnType<typeof getRenameSuggestions>) => out.map((s) => `${s.from.name}>${s.to.name}`).sort();

  it('pairs a retag wave by name, not by the closest might', () => {
    const live: [string, number, number, string, number, number][] = [
      ['Arean SK7', 105, 15114620, 'Arean S', 108, 17400010],
      ['Blas de Lezo SK7', 103, 14394065, 'Blas de Lezo S', 105, 15047065],
      ['Strela K260 SK', 108, 16811195, 'Strela', 108, 17820715],
      ['Living SK7', 107, 19772030, 'Living S', 110, 21603720],
      ['Tigger K260 SK', 110, 18789275, 'Tigger', 110, 19686010],
      ['NoPantsPanda SK7', 77, 10884055, 'NoPantsPanda S', 79, 12688605],
      ['TASH SK7', 77, 9240024, 'TASH S', 77, 11032179],
    ];
    for (const [oldName, oldLevel, oldPower, newName, newLevel, newPower] of live) {
      member(oldName, [['2026-11-12', oldLevel, oldPower]], ['2026-11-12', '2026-11-13']);
      member(newName, [['2026-11-13', newLevel, newPower]]);
    }
    const out = getRenameSuggestions(1, SK_NOW);
    expect(pairs(out)).toEqual(live.map(([o, , , n]) => `${o}>${n}`).sort());
    expect(out.every((s) => s.nameMatch)).toBe(true);
  });

  it('lets a name-linked pair through on Seasonal Kingdom growth', () => {
    // Live: RM sin 3.6× might at the same level, taulen +12 levels overnight.
    member('RM sin sk7', [['2026-11-12', 83, 3202305]]);
    member('RM sin s', [['2026-11-13', 83, 11670005]]);
    member('taulen K260 SK', [['2026-11-12', 122, 25252485]]);
    member('taulen', [['2026-11-13', 134, 33379355]]);
    expect(pairs(getRenameSuggestions(1, SK_NOW))).toEqual(['RM sin sk7>RM sin s', 'taulen K260 SK>taulen']);
  });

  it('still refuses a name-linked pair the numbers contradict', () => {
    member('Ace K260 SK', [['2026-11-12', 103, 16391675]]);
    member('Ace', [['2026-11-13', 95, 16703335]]); // level dropped
    member('Bart SK7', [['2026-11-12', 100, 20000000]]);
    member('Bart', [['2026-11-13', 101, 12000000]]); // 40% of the might
    member('Cid', [['2026-11-12', 100, 20000000]]);
    member('Cid the Great', [['2026-11-13', 140, 60000000]]); // +40 levels in a day
    expect(getRenameSuggestions(1, SK_NOW)).toEqual([]);
  });

  it('keeps might-only pairs for members without a name-linked partner', () => {
    member('Living SK7', [['2026-11-12', 107, 19772030]]);
    member('Living S', [['2026-11-13', 110, 21603720]]);
    member('Cauldron', [['2026-11-12', 239, 488196331]]);
    member('Aldrin', [['2026-11-13', 241, 490352131]]);
    const out = getRenameSuggestions(1, SK_NOW);
    expect(pairs(out)).toEqual(['Cauldron>Aldrin', 'Living SK7>Living S']);
    expect(out.map((s) => s.nameMatch)).toEqual([true, false]);
  });

  describe('mergeNameMatchedRenames', () => {
    const memberRow = (id: number) => getDb().prepare('SELECT name, aliases FROM members WHERE id = ?').get(id) as
      { name: string; aliases: string } | undefined;
    const chestsOf = (id: number) => (getDb().prepare('SELECT COUNT(*) AS n FROM chest_records WHERE member_id = ?').get(id) as { n: number }).n;

    it('merges the name-linked pairs it was sent, and nothing else', () => {
      const living = member('Living SK7', [['2026-11-12', 107, 19772030]], ['2026-11-12', '2026-11-12']);
      const livingS = member('Living S', [['2026-11-13', 110, 21603720]], ['2026-11-13']);
      const tigger = member('Tigger K260 SK', [['2026-11-12', 110, 18789275]], ['2026-11-12']);
      const tiggerNew = member('Tigger', [['2026-11-13', 110, 19686010]]);
      const cauldron = member('Cauldron', [['2026-11-12', 239, 488196331]]);
      const aldrin = member('Aldrin', [['2026-11-13', 241, 490352131]]);

      const outcome = mergeNameMatchedRenames(1, [
        { fromMemberId: living, toMemberId: livingS },
        { fromMemberId: tigger, toMemberId: tiggerNew },
        { fromMemberId: cauldron, toMemberId: aldrin }, // might-only: needs its own click
        { fromMemberId: living, toMemberId: aldrin }, // not a suggestion at all
      ], SK_NOW);

      expect(outcome.merged.map((m) => `${m.from}>${m.to}`).sort()).toEqual(['Living SK7>Living S', 'Tigger K260 SK>Tigger']);
      expect(outcome.skipped).toBe(2);
      expect(outcome.failed).toEqual([]);
      expect(memberRow(living)).toBeUndefined();
      expect(memberRow(tigger)).toBeUndefined();
      expect(chestsOf(livingS)).toBe(3);
      // The old name stays an alias, so a leftover "From: Living SK7" card still lands here.
      expect(JSON.parse(memberRow(livingS)!.aliases)).toEqual(['Living SK7']);
      expect(memberRow(cauldron)?.name).toBe('Cauldron');
      expect(pairs(getRenameSuggestions(1, SK_NOW))).toEqual(['Cauldron>Aldrin']);
    });

    it('folds a chain oldest first, so the middle name is not reborn', () => {
      // X → A on Nov 11, A → B on Nov 13. Merging A → B first would leave X to be
      // renamed "Zed K260" by the missing-destination branch.
      const x = member('Zed K260 SK', [['2026-11-10', 100, 10000000]], ['2026-11-10']);
      const a = member('Zed K260', [['2026-11-11', 100, 10050000], ['2026-11-12', 100, 10100000]], ['2026-11-11']);
      const b = member('Zed', [['2026-11-13', 100, 10150000]], ['2026-11-13']);
      const shown = getRenameSuggestions(1, SK_NOW);
      expect(pairs(shown)).toEqual(['Zed K260 SK>Zed K260', 'Zed K260>Zed']);

      const outcome = mergeNameMatchedRenames(1, shown.map((s) => ({ fromMemberId: s.from.memberId, toMemberId: s.to.memberId })), SK_NOW);
      expect(outcome.merged.map((m) => `${m.from}>${m.to}`)).toEqual(['Zed K260 SK>Zed K260', 'Zed K260>Zed']);
      expect(memberRow(x)).toBeUndefined();
      expect(memberRow(a)).toBeUndefined();
      expect(chestsOf(b)).toBe(3);
      const names = (getDb().prepare('SELECT name FROM members WHERE clan_id = 1').all() as { name: string }[]).map((m) => m.name);
      expect(names).toEqual(['Zed']);
    });
  });
});

describe('namesShareStem', () => {
  it('links a tag added or dropped at either end', () => {
    expect(namesShareStem('Living SK7', 'Living S')).toBe(true);
    expect(namesShareStem('Tigger K260 SK', 'Tigger')).toBe(true);
    expect(namesShareStem('KacieSK2', 'KacieS')).toBe(true);
    expect(namesShareStem('Fiin SK 3', 'Fiin S')).toBe(true);
    expect(namesShareStem('DR JMD K260Sk', 'DR JMD')).toBe(true);
    expect(namesShareStem('[K34] Löwenherz', 'Lowenherz')).toBe(true);
    expect(namesShareStem('Микам SK', 'Микам')).toBe(true);
  });

  it('does not link a changed ending, an unrelated name or a stub', () => {
    expect(namesShareStem('Drop A', 'Drop B')).toBe(false);
    expect(namesShareStem('Bob K34', 'Bob SK')).toBe(false);
    expect(namesShareStem('Cauldron', 'Aldrin')).toBe(false);
    expect(namesShareStem('Arean SK7', 'Blas de Lezo S')).toBe(false);
    expect(namesShareStem('Al K260', 'Al')).toBe(false);
  });
});
