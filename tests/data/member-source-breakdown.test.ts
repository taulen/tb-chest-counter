import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { foldMemberSources, getMemberSourceBreakdown } from '../../src/data/member-source-breakdown.js';
import { getLeaderboard } from '../../src/data/repositories/chest-repo.js';
import { invalidateSourceKeySummary } from '../../src/data/repositories/source-points-repo.js';
import { invalidate } from '../../src/utils/ttl-cache.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

/**
 * The leaderboard's per-player breakdown: one line per chest source, in the FAQ
 * points table's sections. What matters most is that it explains the row it
 * hangs off — same window, same clan-reward exclusion, every chest counted
 * once — so a visitor never sees a breakdown that adds up to a different score.
 */

describe('foldMemberSources (pure)', () => {
  const RAW = [
    { source: 'Level 10 Crypt', chests: 5, points: 50 },
    { source: 'Level 5 Crypt', chests: 10, points: 50 },
    { source: 'Level 15 rare Crypt', chests: 2, points: 60 },
    { source: 'Level 20 Citadel', chests: 1, points: 100 },
    { source: 'Level 16 heroic Monster', chests: 3, points: 30 },
    { source: 'Rise of the Ancients event', chests: 4, points: 40 },
    { source: 'Pumpkin Harvest event', chests: 6, points: 90 },
    // The same source read without its spaces: one line, not two.
    { source: 'Level10Crypt', chests: 1, points: 10 },
    { source: '', chests: 2, points: 0 },
  ];

  it('totals every record exactly once', () => {
    const out = foldMemberSources(RAW);
    expect(out.totalChests).toBe(34);
    expect(out.totalPoints).toBe(430);
    const lines = out.sections.flatMap((s) => s.rows);
    expect(lines.reduce((n, r) => n + r.chests, 0)).toBe(34);
    expect(lines.reduce((n, r) => n + r.points, 0)).toBe(430);
    for (const s of out.sections) {
      expect(s.chests).toBe(s.rows.reduce((n, r) => n + r.chests, 0));
      expect(s.points).toBe(s.rows.reduce((n, r) => n + r.points, 0));
    }
  });

  it('uses the FAQ points table sections, in its order', () => {
    expect(foldMemberSources(RAW).sections.map((s) => s.key)).toEqual(['crypts', 'heroic', 'events', 'other']);
  });

  it('lists a ladder by tier and level: crypts before citadels, common before rare', () => {
    const crypts = foldMemberSources(RAW).sections.find((s) => s.key === 'crypts')!;
    expect(crypts.rows.map((r) => r.source)).toEqual([
      'Level 5 Crypt', 'Level 10 Crypt', 'Level 15 rare Crypt', 'Level 20 Citadel',
    ]);
    // The despaced reading merged into its spaced twin, under the spelling most chests carried.
    expect(crypts.rows[1]).toEqual({ source: 'Level 10 Crypt', chests: 6, points: 60 });
  });

  it('lists named sources by what they paid', () => {
    const events = foldMemberSources(RAW).sections.find((s) => s.key === 'events')!;
    expect(events.rows.map((r) => r.source)).toEqual(['Pumpkin Harvest event', 'Rise of the Ancients event']);
  });

  it('keeps chests with no source as an unlabelled line rather than dropping them', () => {
    const other = foldMemberSources(RAW).sections.find((s) => s.key === 'other')!;
    expect(other.rows).toEqual([{ source: '', chests: 2, points: 0 }]);
  });

  it('labels a source with the clan spelling when one is given', () => {
    const out = foldMemberSources(
      [{ source: 'Level 10 Crypt.', chests: 3, points: 30 }],
      new Map([['common10', 'Level 10 Crypt']]),
    );
    expect(out.sections[0].rows[0].source).toBe('Level 10 Crypt');
  });

  it('is empty, not missing, for a member with no chests', () => {
    expect(foldMemberSources([])).toEqual({ totalChests: 0, totalPoints: 0, sections: [] });
  });
});

describe('getMemberSourceBreakdown (DB)', () => {
  let cleanup: () => void;
  const DAY = 86_400_000;
  const T0 = Date.UTC(2026, 10, 1, 18); // inside the window below
  const FROM = new Date(Date.UTC(2026, 10, 1, 17)).toISOString();
  const TO = new Date(Date.UTC(2026, 10, 8, 17)).toISOString();

  let alice = 0;
  let bob = 0;
  let gone = 0;

  function insertMember(clanId: number, name: string, active = 1): number {
    return (getDb().prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (?, ?, ?, '2026-01-01', '2026-11-01', ?) RETURNING id`,
    ).get(clanId, name, name.toLowerCase(), active) as { id: number }).id;
  }
  function chest(name: string): number {
    return (getDb().prepare(
      `INSERT INTO chests (name, chest_type) VALUES (?, 'common')
       ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
    ).get(name) as { id: number }).id;
  }
  function source(text: string): number {
    return (getDb().prepare(
      `INSERT INTO chest_sources (source) VALUES (?)
       ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
    ).get(text) as { id: number }).id;
  }

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    seedTwoClans();
    // Both caches are process-wide and would carry another test's DB across.
    invalidate('leaderboard:');
    invalidateSourceKeySummary();

    alice = insertMember(1, 'Alice');
    bob = insertMember(1, 'Bob');
    gone = insertMember(1, 'Gone', 0);
    const session = (getDb().prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
       VALUES (1, '2026-11-01', '2026-11-01', 'completed', 'manual') RETURNING id`,
    ).get() as { id: number }).id;

    const crypt5 = source('Level 5 Crypt');
    const crypt10 = source('Level 10 Crypt');
    const olympusEvent = source('Trials of Olympus event');
    const common = chest('Common Chest');
    // An end-of-event clan reward: the board leaves it out, so must this.
    const reward = chest('Olympus Chest');

    let n = 0;
    const add = (member: number, chestId: number, sourceId: number | null, points: number, at: number) => {
      getDb().prepare(
        `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
         VALUES (1, ?, ?, ?, ?, ?, ?, 0.9)`,
      ).run(session, member, chestId, sourceId, points, at + n++);
    };
    for (let i = 0; i < 4; i++) add(alice, common, crypt5, 5, T0);
    for (let i = 0; i < 2; i++) add(alice, common, crypt10, 10, T0 + DAY);
    add(alice, common, null, 0, T0 + 2 * DAY);
    add(alice, reward, olympusEvent, 1000, T0 + DAY);
    add(alice, common, crypt5, 5, T0 - 3 * DAY); // before the window
    add(bob, common, crypt10, 10, T0);
    add(gone, common, crypt5, 5, T0);
  });
  afterEach(() => cleanup());

  it('adds up to the member\'s leaderboard row, for a window and for all time', () => {
    for (const [from, to] of [[FROM, TO], [undefined, undefined]] as const) {
      const row = getLeaderboard(1, from, to, { includeAllMembers: true }).find((e) => e.memberId === alice)!;
      const b = getMemberSourceBreakdown(1, alice, from, to)!;
      expect(b.totalChests).toBe(row.totalChests);
      expect(b.totalPoints).toBe(row.totalPoints);
    }
  });

  it('leaves out the clan reward and anything outside the window', () => {
    const b = getMemberSourceBreakdown(1, alice, FROM, TO)!;
    expect(b.memberName).toBe('Alice');
    expect(b.totalChests).toBe(7);
    expect(b.totalPoints).toBe(40);
    expect(b.sections.map((s) => s.key)).toEqual(['crypts', 'other']);
    expect(b.sections[0].rows).toEqual([
      { source: 'Level 5 Crypt', chests: 4, points: 20 },
      { source: 'Level 10 Crypt', chests: 2, points: 20 },
    ]);
  });

  it('answers only for an active member of the clan asked about', () => {
    expect(getMemberSourceBreakdown(1, gone)).toBeNull();
    expect(getMemberSourceBreakdown(2, alice)).toBeNull();
    expect(getMemberSourceBreakdown(1, 999_999)).toBeNull();
    expect(getMemberSourceBreakdown(1, bob)?.totalChests).toBe(1);
  });
});
