import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { realNameBehindCut, repairCutNames } from '../../src/data/repair-cut-names-2026-11.js';
import { makeTestDb } from '../helpers/test-db.js';

/**
 * SK7, Nov 13 2026: the member-list reader cut "Living SK7" to "Living S", and "Merge
 * all name matches" then folded the hand-named "Living SK7" INTO "Living S". The repair
 * gives the real name back. Fixtures are the live clan 5 shapes.
 */
describe('repairCutNames', () => {
  let cleanup: () => void;
  beforeEach(() => { ({ cleanup } = makeTestDb()); });
  afterEach(() => cleanup());

  const member = (name: string, aliases: string[]): number => (getDb().prepare(
    `INSERT INTO members (clan_id, name, normalized_name, despaced_name, aliases, first_seen, last_seen, is_active)
     VALUES (1, ?, ?, ?, ?, '2026-11-12T00:00:00Z', '2026-11-13T00:00:00Z', 1) RETURNING id`,
  ).get(name, name.toLowerCase(), name.toLowerCase().replace(/[^a-z0-9]/g, ''), JSON.stringify(aliases)) as { id: number }).id;
  const rule = (from: string, to: string): void => {
    getDb().prepare(
      "INSERT INTO merge_rules (clan_id, type, from_value, to_value, created_at) VALUES (1, 'player', ?, ?, '2026-11-13T18:42:32Z')",
    ).run(from, to);
  };
  const row = (id: number) => getDb().prepare(
    'SELECT name, normalized_name AS n, despaced_name AS d, aliases FROM members WHERE id = ?',
  ).get(id) as { name: string; n: string; d: string; aliases: string };
  const rules = () => (getDb().prepare(
    "SELECT from_value AS f, to_value AS t FROM merge_rules WHERE clan_id = 1 AND type = 'player' ORDER BY f",
  ).all() as { f: string; t: string }[]).map((r) => `${r.f} > ${r.t}`);

  it('gives a merged member its hand-set name back and re-points the merge rules', () => {
    const living = member('Living S', ['Living SK7']);
    const tigger = member('Tigger', ['Tigger K260 SK']);
    const fiin = member('Fiin S', ['Fiin SK 3']);
    // Finfinin: the admin's own merge K260 SK → K260 SK7 first, then the bad one.
    const finfinin = member('Finfinin', ['Finfinin K260 SK7']);
    rule('Living SK7', 'Living S');
    rule('Tigger K260 SK', 'Tigger');
    rule('Fiin SK 3', 'Fiin S');
    rule('Finfinin K260 SK', 'Finfinin K260 SK7');
    rule('Finfinin K260 SK7', 'Finfinin');

    expect(repairCutNames(getDb())).toBe(4);
    expect(row(living)).toEqual({ name: 'Living SK7', n: 'living sk7', d: 'livingsk7', aliases: '["Living S"]' });
    expect(row(tigger).name).toBe('Tigger K260 SK');
    expect(row(fiin).name).toBe('Fiin SK 3');
    expect(row(finfinin)).toMatchObject({ name: 'Finfinin K260 SK7', aliases: '["Finfinin"]' });
    // Real → cut-off rules became self-rules and are gone; the admin's own rule stays.
    expect(rules()).toEqual(['Finfinin K260 SK > Finfinin K260 SK7']);

    expect(repairCutNames(getDb())).toBe(0); // replay is a no-op
  });

  it('leaves alone what is not a cut-off name', () => {
    const fiin2 = member('Fiin SK 2', ['Fiin S']); // clan 3: already the right way round
    const aldrin = member('Aldrin', ['Cauldron']); // a real rename
    const feli = member('FELI', ['FELI 2']); // an alt suffix, not a K-number
    member('Ace', ['Ace K260 SK']);
    member('Ace K260 SK', []); // the real name is already taken: skip, don't collide
    expect(repairCutNames(getDb())).toBe(0);
    expect([row(fiin2).name, row(aldrin).name, row(feli).name]).toEqual(['Fiin SK 2', 'Aldrin', 'FELI']);
  });
});

describe('realNameBehindCut', () => {
  it('finds the alias the old reader cut down to the name', () => {
    expect(realNameBehindCut('KacieS', ['KacieSK2'])).toBe('KacieSK2');
    expect(realNameBehindCut('Kobe 260 S', ['Kobe 260 SK7'])).toBe('Kobe 260 SK7');
    expect(realNameBehindCut('Blud S', ['Blud SK 260'])).toBe('Blud SK 260');
    expect(realNameBehindCut('DR JMD', ['DR JMD K260Sk'])).toBe('DR JMD K260Sk');
    expect(realNameBehindCut('King Of Mean', ['King Of Mean k260'])).toBe('King Of Mean k260');
  });

  it('refuses no fit, a non-K tail and an ambiguous pair', () => {
    expect(realNameBehindCut('Living S', [])).toBeNull();
    expect(realNameBehindCut('Princess', ['Princess 260 SK'])).toBeNull();
    expect(realNameBehindCut('Ace', ['Ace K260 SK', 'Ace K34'])).toBeNull();
  });
});
