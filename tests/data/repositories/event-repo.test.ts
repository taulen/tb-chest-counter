import { describe, it, expect, afterEach } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import { getEventBreakdown, getEventMemberDetail } from '../../../src/data/repositories/event-repo.js';
import { makeTestDb } from '../../helpers/test-db.js';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/**
 * Seed a "Runic Chest" (the only chest in the Runics event) at several raid
 * tiers, each with a source that parses to a distinct level, so the level-mode
 * breakdown and the "By level" card have something to split on.
 */
function seedRunics(clanId = 1): { alice: number; bob: number } {
  const db = getDb();
  const now = Date.now();
  const iso = (offset: number): string => new Date(now + offset).toISOString();

  const alice = (
    db
      .prepare(
        `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
         VALUES (?, 'Alice', 'alice', ?, ?, 1) RETURNING id`,
      )
      .get(clanId, iso(0), iso(0)) as { id: number }
  ).id;
  const bob = (
    db
      .prepare(
        `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
         VALUES (?, 'Bob', 'bob', ?, ?, 1) RETURNING id`,
      )
      .get(clanId, iso(0), iso(0)) as { id: number }
  ).id;

  const chestId = (
    db
      .prepare(
        `INSERT INTO chests (name, chest_type) VALUES ('Runic Chest', 'common')
         ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
      )
      .get() as { id: number }
  ).id;

  const sourceId = (label: string): number =>
    (
      db
        .prepare(
          `INSERT INTO chest_sources (source) VALUES (?)
           ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
        )
        .get(label) as { id: number }
    ).id;
  const lvl20 = sourceId('Lvl 20-24 Raid Runic Squad');
  const lvl25 = sourceId('Lvl 25-29 Raid Runic Squad');
  const lvl30 = sourceId('Lvl 30-34 Raid Runic Squad');

  const session = (
    db
      .prepare(
        `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
         VALUES (?, ?, ?, 'completed', 'manual') RETURNING id`,
      )
      .get(clanId, iso(0), iso(0)) as { id: number }
  ).id;

  let t = 0;
  const rec = (memberId: number, srcId: number, points: number): void => {
    db.prepare(
      `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0.95)`,
    ).run(clanId, session, memberId, chestId, srcId, points, iso(++t));
  };
  // Alice: two lvl-20 + one lvl-25. Bob: one lvl-25 + one lvl-30.
  rec(alice, lvl20, 20);
  rec(alice, lvl20, 20);
  rec(alice, lvl25, 25);
  rec(bob, lvl25, 25);
  rec(bob, lvl30, 30);

  return { alice, bob };
}

describe('Runics event breakdown', () => {
  it('breaks the single Runic Chest out by raid level', () => {
    ({ cleanup } = makeTestDb());
    const { alice, bob } = seedRunics(1);

    const b = getEventBreakdown('runics', 1);
    expect(b).not.toBeNull();
    if (!b) return;

    // Catalog wiring
    expect(b.name).toBe('Runics');
    expect(b.columnMode).toBe('level');
    expect(b.showLevelCard).toBe(true);
    // No lead card: every Runic chest is leveled, so it would duplicate Total.
    expect(b.levelSummaryLabel).toBeNull();
    expect(b.levelCardLabel).toBe('Raid');

    // One column per present level, ascending — labelled with the full tier
    // range parsed from the source ("Lvl 20-24 Raid Runic Squad"). Single-rule
    // events drop the redundant chest-name prefix, so it's just "Lvl 20-24".
    expect(b.columns.map((c) => c.label)).toEqual([
      'Lvl 20-24',
      'Lvl 25-29',
      'Lvl 30-34',
    ]);
    // Every level column counts toward the Total in level mode.
    expect(b.columns.every((c) => c.countInTotal)).toBe(true);

    // Totals across all 5 seeded chests.
    expect(b.totalChests).toBe(5);
    expect(b.uniqueParticipants).toBe(2);
    expect(b.totalPoints).toBe(20 + 20 + 25 + 25 + 30);

    // "By level" card: one row per level with aggregated counts.
    const card = Object.fromEntries(b.levelCard.map((r) => [r.level, r]));
    expect(card[20]).toMatchObject({ participants: 1, chests: 2, points: 40 });
    expect(card[25]).toMatchObject({ participants: 2, chests: 2, points: 50 });
    expect(card[30]).toMatchObject({ participants: 1, chests: 1, points: 30 });

    // Per-player matrix cells keyed by "<label>::<level>".
    const aliceRow = b.players.find((p) => p.memberId === alice);
    const bobRow = b.players.find((p) => p.memberId === bob);
    expect(aliceRow?.counts).toEqual({ 'Runic::20': 2, 'Runic::25': 1 });
    expect(aliceRow?.countableChests).toBe(3);
    expect(bobRow?.counts).toEqual({ 'Runic::25': 1, 'Runic::30': 1 });
    expect(bobRow?.countableChests).toBe(2);
  });

  it('keeps the type prefix for multi-rule level events (Citadels)', () => {
    ({ cleanup } = makeTestDb());
    const db = getDb();
    const now = Date.now();
    const iso = (o: number): string => new Date(now + o).toISOString();
    const member = (
      db
        .prepare(
          `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
           VALUES (1, 'Cara', 'cara', ?, ?, 1) RETURNING id`,
        )
        .get(iso(0), iso(0)) as { id: number }
    ).id;
    const chest = (name: string, type: string): number =>
      (
        db
          .prepare(
            `INSERT INTO chests (name, chest_type) VALUES (?, ?)
             ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
          )
          .get(name, type) as { id: number }
      ).id;
    const source = (label: string): number =>
      (
        db
          .prepare(
            `INSERT INTO chest_sources (source) VALUES (?)
             ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
          )
          .get(label) as { id: number }
      ).id;
    const elven = chest('Elven Citadel Chest', 'common');
    const cursed = chest('Cursed Citadel Chest', 'common');
    const session = (
      db
        .prepare(
          `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
           VALUES (1, ?, ?, 'completed', 'manual') RETURNING id`,
        )
        .get(iso(0), iso(0)) as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
       VALUES (1, ?, ?, ?, ?, 35, ?, 0.95)`,
    ).run(session, member, elven, source('Level 25 Elven Citadel'), iso(1));
    db.prepare(
      `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
       VALUES (1, ?, ?, ?, ?, 40, ?, 0.95)`,
    ).run(session, member, cursed, source('Level 25 Cursed Citadel'), iso(2));

    const b = getEventBreakdown('citadels', 1);
    expect(b?.columns.map((c) => c.label).sort()).toEqual(['Cursed Lvl 25', 'Elven Lvl 25']);
  });

  /**
   * Heroics: one source-only rule, five monster chests on a repeating
   * five-level cycle, collapsed into the catalog's declared level tiers.
   * `extras` seeds rows the buckets don't cover, for the tests that need them.
   */
  function seedHeroics(
    extras: Array<{ chest: string; source: string }> = [],
  ): { dana: number } {
    const db = getDb();
    const now = Date.now();
    const iso = (o: number): string => new Date(now + o).toISOString();
    const dana = (
      db
        .prepare(
          `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
           VALUES (1, 'Dana', 'dana', ?, ?, 1) RETURNING id`,
        )
        .get(iso(0), iso(0)) as { id: number }
    ).id;
    const session = (
      db
        .prepare(
          `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
           VALUES (1, ?, ?, 'completed', 'manual') RETURNING id`,
        )
        .get(iso(0), iso(0)) as { id: number }
    ).id;
    const chest = (name: string): number =>
      (
        db
          .prepare(
            `INSERT INTO chests (name, chest_type) VALUES (?, 'common')
             ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
          )
          .get(name) as { id: number }
      ).id;
    const source = (label: string): number =>
      (
        db
          .prepare(
            `INSERT INTO chest_sources (source) VALUES (?)
             ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
          )
          .get(label) as { id: number }
      ).id;

    // Real prod shape: the game's own casing is a lowercase "heroic".
    const rows = [
      { chest: 'Undead Chest', source: 'Level 16 heroic Monster' },
      { chest: 'Elven Chest', source: 'Level 17 heroic Monster' },
      { chest: 'Cursed Chest', source: 'Level 18 heroic Monster' },
      { chest: 'Barbarian Chest', source: 'Level 19 heroic Monster' },
      { chest: 'Inferno Chest', source: 'Level 20 heroic Monster' },
      { chest: 'Undead Chest', source: 'Level 26 heroic Monster' },
      ...extras,
    ];
    rows.forEach((r, i) => {
      db.prepare(
        `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
         VALUES (1, ?, ?, ?, ?, 20, ?, 0.95)`,
      ).run(session, dana, chest(r.chest), source(r.source), iso(i + 1));
    });
    // A Barbarian Chest from a CRYPT — the same chest name the heroic rule
    // would have matched had it been keyed on names. In prod this outnumbers
    // the heroic Barbarians ~100:1, so it must not reach the event at all.
    db.prepare(
      `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
       VALUES (1, ?, ?, ?, ?, 15, ?, 0.95)`,
    ).run(session, dana, chest('Barbarian Chest'), source('Level 15 Crypt'), iso(99));
    return { dana };
  }

  it('groups Heroic levels into the catalog’s declared tiers', () => {
    ({ cleanup } = makeTestDb());
    const { dana } = seedHeroics();

    const b = getEventBreakdown('heroics', 1);
    expect(b?.columnMode).toBe('level');
    expect(b?.showLevelCard).toBe(false);
    expect(b?.configErrors).toEqual([]);

    // Every declared bucket, in order, present in the data or not — an empty
    // tier must not make the header reshuffle between timeframes.
    expect(b?.columns.map((c) => c.label)).toEqual([
      'Lvl 16-19', 'Lvl 20-24', 'Lvl 25-29', 'Lvl 30-34', 'Lvl 35-39', 'Lvl 40-44', 'Lvl 45',
    ]);

    const row = b?.players.find((p) => p.memberId === dana);
    // 16/17/18/19 fold into one column; 20 opens the next; 26 lands in 25-29.
    // The crypt Barbarian is excluded, so the first bucket is 4 and not 5.
    expect(row?.counts['bucket::16-19']).toBe(4);
    expect(row?.counts['bucket::20-24']).toBe(1);
    expect(row?.counts['bucket::25-29']).toBe(1);
    expect(row?.counts['bucket::30-34']).toBeUndefined();
    expect(b?.totalChests).toBe(6);
  });

  it('splits a Heroic bucket per level, naming the monster behind each', () => {
    ({ cleanup } = makeTestDb());
    const { dana } = seedHeroics();

    const b = getEventBreakdown('heroics', 1);
    const first = b?.columns.find((c) => c.key === 'bucket::16-19');
    // Column parts and the player's breakdown keys are joined by string
    // equality in the frontend tooltip, so they have to agree exactly.
    expect(first?.parts).toEqual([
      'Lvl 16 (Undead)', 'Lvl 17 (Elven)', 'Lvl 18 (Cursed)', 'Lvl 19 (Barbarian)',
    ]);
    const row = b?.players.find((p) => p.memberId === dana);
    expect(row?.breakdown['bucket::16-19']).toEqual({
      'Lvl 16 (Undead)': 1, 'Lvl 17 (Elven)': 1, 'Lvl 18 (Cursed)': 1, 'Lvl 19 (Barbarian)': 1,
    });
    // A tier with no chests this window carries no tooltip rather than an empty one.
    expect(b?.columns.find((c) => c.key === 'bucket::45')?.parts).toBeUndefined();
  });

  it('gives a Heroic level outside every bucket its own column', () => {
    // The game raising its level cap must not read as nobody playing — the
    // same reason a dead catalog literal is surfaced instead of zeroed.
    ({ cleanup } = makeTestDb());
    seedHeroics([{ chest: 'Undead Chest', source: 'Level 51 heroic Monster' }]);

    const b = getEventBreakdown('heroics', 1);
    const loose = b?.columns.find((c) => c.key === 'bucket::lvl-51');
    expect(loose?.label).toBe('Lvl 51');
    // Sorted by level, so it follows the last declared bucket rather than
    // being appended wherever the map happened to iterate.
    expect(b?.columns.at(-1)?.key).toBe('bucket::lvl-51');
    expect(b?.totalChests).toBe(7);
    // Still reaches the Total column — a column nobody can total is no better
    // than a dropped row.
    expect(b?.players[0]?.countableChests).toBe(7);
  });

  it('keeps a Heroic chest whose source has no readable level', () => {
    ({ cleanup } = makeTestDb());
    // A heroic source OCR read without its level at all.
    seedHeroics([{ chest: 'Undead Chest', source: 'heroic Monster' }]);

    const b = getEventBreakdown('heroics', 1);
    const unknown = b?.columns.find((c) => c.key === 'bucket::unknown');
    expect(unknown?.label).toBe('Unknown');
    expect(unknown?.parts).toBeUndefined();   // no level to split on
    expect(b?.players[0]?.counts['bucket::unknown']).toBe(1);
    expect(b?.totalChests).toBe(7);
  });

  it('drills into a member’s Heroic chests by source', () => {
    ({ cleanup } = makeTestDb());
    const { dana } = seedHeroics();

    const detail = getEventMemberDetail('heroics', 1, dana);
    const bySource = Object.fromEntries(detail.map((r) => [r.source, r]));
    expect(bySource['Level 16 heroic Monster']).toMatchObject({ chestName: 'Undead Chest', chests: 1 });
    expect(bySource['Level 26 heroic Monster']).toMatchObject({ chestName: 'Undead Chest', chests: 1 });
    // The crypt Barbarian is not a heroic kill and must not appear here either.
    expect(bySource['Level 15 Crypt']).toBeUndefined();
    expect(detail).toHaveLength(6);
  });

  it('drills into a member’s Runic chests by source', () => {
    ({ cleanup } = makeTestDb());
    const { alice } = seedRunics(1);

    const detail = getEventMemberDetail('runics', 1, alice);
    // Alice: lvl-20 (x2) and lvl-25 (x1) — grouped by source.
    const bySource = Object.fromEntries(detail.map((r) => [r.source, r]));
    expect(bySource['Lvl 20-24 Raid Runic Squad']).toMatchObject({ chests: 2, points: 40 });
    expect(bySource['Lvl 25-29 Raid Runic Squad']).toMatchObject({ chests: 1, points: 25 });
    expect(detail.every((r) => r.chestName === 'Runic Chest')).toBe(true);
  });
});

describe('event window uses earn time (effective_at), not scan time', () => {
  // A chest earned inside the event window but claimed by a scan AFTER it must
  // still count; a chest scanned inside the window but earned BEFORE it must
  // not. This is the whole point of earned_at vs captured_at.
  function seedWithEarnTimes(): { from: string; to: string } {
    const db = getDb();
    const base = Date.parse('2026-07-16T17:00:00.000Z'); // event start
    const H = 3600_000;
    const member = (
      db
        .prepare(
          `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
           VALUES (1, 'Eve', 'eve', ?, ?, 1) RETURNING id`,
        )
        .get(new Date(base).toISOString(), new Date(base).toISOString()) as { id: number }
    ).id;
    const chestId = (
      db
        .prepare(
          `INSERT INTO chests (name, chest_type) VALUES ('Runic Chest', 'common')
           ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
        )
        .get() as { id: number }
    ).id;
    const sourceId = (
      db
        .prepare(
          `INSERT INTO chest_sources (source) VALUES ('Lvl 25-29 Raid Runic Squad')
           ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
        )
        .get() as { id: number }
    ).id;
    const session = (
      db
        .prepare(
          `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
           VALUES (1, ?, ?, 'completed', 'manual') RETURNING id`,
        )
        .get(new Date(base).toISOString(), new Date(base).toISOString()) as { id: number }
    ).id;

    // capturedMs, earnedMs (earned_at NULL falls back to captured via effective_at)
    const rec = (capturedMs: number, earnedMs: number | null): void => {
      db.prepare(
        `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, earned_at, confidence)
         VALUES (1, ?, ?, ?, ?, 25, ?, ?, 0.95)`,
      ).run(session, member, chestId, sourceId, capturedMs, earnedMs);
    };
    // A: scanned 2h AFTER the window closes, but earned inside → counts.
    rec(base + 12 * H, base + 5 * H);
    // B: scanned inside the window, but earned 5h BEFORE it opened → excluded.
    rec(base + 3 * H, base - 5 * H);
    // C: control — no earned_at, captured inside → counts via fallback.
    rec(base + 4 * H, null);

    return { from: new Date(base).toISOString(), to: new Date(base + 10 * H).toISOString() };
  }

  it('includes earned-in / scanned-after and excludes scanned-in / earned-before', () => {
    ({ cleanup } = makeTestDb());
    const { from, to } = seedWithEarnTimes();

    const windowed = getEventBreakdown('runics', 1, from, to);
    // A (earned in, scanned after) + C (fallback, in) = 2; B excluded.
    expect(windowed?.totalChests).toBe(2);

    // All-time still sees every row.
    const all = getEventBreakdown('runics', 1);
    expect(all?.totalChests).toBe(3);
  });
});

describe('Dark Omens combined summon column', () => {
  function seedDarkOmens(clanId = 1): number {
    const db = getDb();
    const now = Date.now();
    const iso = (o: number): string => new Date(now + o).toISOString();
    const dave = (
      db
        .prepare(
          `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
           VALUES (?, 'Dave', 'dave', ?, ?, 1) RETURNING id`,
        )
        .get(clanId, iso(0), iso(0)) as { id: number }
    ).id;
    const chest = (name: string, type: string): number =>
      (
        db
          .prepare(
            `INSERT INTO chests (name, chest_type) VALUES (?, ?)
             ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
          )
          .get(name, type) as { id: number }
      ).id;
    const minor = chest('Minor Omen Chest', 'common');
    const major = chest('Major Omen Chest', 'uncommon');
    const epic = chest('Epic Omen Chest', 'epic');
    const arcane = chest('Arcane Chest', 'common');
    const session = (
      db
        .prepare(
          `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
           VALUES (?, ?, ?, 'completed', 'manual') RETURNING id`,
        )
        .get(clanId, iso(0), iso(0)) as { id: number }
    ).id;
    let t = 0;
    const rec = (chestId: number, points: number): void => {
      db.prepare(
        `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at, confidence)
         VALUES (?, ?, ?, ?, ?, ?, 0.95)`,
      ).run(clanId, session, dave, chestId, points, iso(++t));
    };
    // Dave: 2 Minor + 3 Major + 1 Epic (all summon → one column) + 4 Arcane.
    rec(minor, 1);
    rec(minor, 1);
    rec(major, 2);
    rec(major, 2);
    rec(major, 2);
    rec(epic, 5);
    rec(arcane, 3);
    rec(arcane, 3);
    rec(arcane, 3);
    rec(arcane, 3);
    return dave;
  }

  it('folds Minor/Major/Epic into one column and adds Arcane', () => {
    ({ cleanup } = makeTestDb());
    const dave = seedDarkOmens(1);

    const b = getEventBreakdown('dark-omens', 1);
    expect(b).not.toBeNull();
    if (!b) return;

    // The three summon chests collapse to one column; Arcane is its own.
    const labels = b.columns.map((c) => c.label);
    expect(labels).toContain('Omens (M/M/E)');
    expect(labels).toContain('Arcane');
    expect(labels).not.toContain('Minor Omen');
    expect(labels).not.toContain('Major Omen');

    // The combined cell sums all six summon chests; Arcane stays separate.
    const row = b.players.find((p) => p.memberId === dave);
    expect(row?.counts['Omens (M/M/E)']).toBe(6);
    expect(row?.counts['Arcane']).toBe(4);

    // The combined column exposes its component chests (catalog order) so the
    // UI can render the hover split; single-chest columns carry no parts.
    const omens = b.columns.find((c) => c.key === 'Omens (M/M/E)');
    const arcane = b.columns.find((c) => c.key === 'Arcane');
    expect(omens?.parts).toEqual(['Minor Omen Chest', 'Major Omen Chest', 'Epic Omen Chest']);
    expect(arcane?.parts).toBeUndefined();

    // Per-player split for the tooltip.
    expect(row?.breakdown['Omens (M/M/E)']).toEqual({
      'Minor Omen Chest': 2,
      'Major Omen Chest': 3,
      'Epic Omen Chest': 1,
    });
    expect(row?.breakdown['Arcane']).toBeUndefined();
  });

  it('still lists each summon chest separately in the drill-down', () => {
    ({ cleanup } = makeTestDb());
    const dave = seedDarkOmens(1);

    const detail = getEventMemberDetail('dark-omens', 1, dave);
    const byName = Object.fromEntries(detail.map((r) => [r.chestName, r]));
    expect(byName['Minor Omen Chest']).toMatchObject({ chests: 2 });
    expect(byName['Major Omen Chest']).toMatchObject({ chests: 3 });
    expect(byName['Epic Omen Chest']).toMatchObject({ chests: 1 });
    expect(byName['Arcane Chest']).toMatchObject({ chests: 4 });
  });

  it('drills into a member’s Runic chests by source', () => {
    ({ cleanup } = makeTestDb());
    const { alice } = seedRunics(1);

    const detail = getEventMemberDetail('runics', 1, alice);
    // Alice: lvl-20 (x2) and lvl-25 (x1) — grouped by source.
    const bySource = Object.fromEntries(detail.map((r) => [r.source, r]));
    expect(bySource['Lvl 20-24 Raid Runic Squad']).toMatchObject({ chests: 2, points: 40 });
    expect(bySource['Lvl 25-29 Raid Runic Squad']).toMatchObject({ chests: 1, points: 25 });
    expect(detail.every((r) => r.chestName === 'Runic Chest')).toBe(true);
  });
});

/**
 * Catalog literals vs. the data.
 *
 * The name→id lookup in resolvePredicate is the only boundary between a
 * hand-written string in event-catalog.ts and the records, and it used to be a
 * byte-exact `WHERE name IN (…)` whose failure mode was a bare `return`. The
 * Ragnarok column therefore read 0 for weeks with 2113 matching records in the
 * DB. These cases pin both halves of the fix: the data comes out right anyway,
 * and when it genuinely can't, the page says so instead of showing a zero.
 */
describe('event breakdown: stale and dead catalog references', () => {
  const NOW = 1_700_000_000_000;

  let seq = 0;

  /** One member with `n` chests of `chestName`, from `source`. */
  function seedChest(chestName: string, n: number, source?: string): number {
    const db = getDb();
    const iso = new Date(NOW).toISOString();
    // A distinct member per call — UNIQUE(clan_id, normalized_name).
    const who = `Player${seq++}`;
    const member = (db.prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (1, ?, ?, ?, ?, 1) RETURNING id`,
    ).get(who, who.toLowerCase(), iso, iso) as { id: number }).id;
    const session = (db.prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
       VALUES (1, ?, ?, 'completed', 'manual') RETURNING id`,
    ).get(iso, iso) as { id: number }).id;
    const chestId = (db.prepare(
      `INSERT INTO chests (name, chest_type) VALUES (?, 'common')
       ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
    ).get(chestName) as { id: number }).id;
    const sourceId = source
      ? (db.prepare(
          `INSERT INTO chest_sources (source) VALUES (?)
           ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
        ).get(source) as { id: number }).id
      : null;
    for (let i = 0; i < n; i++) {
      db.prepare(
        `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
         VALUES (1, ?, ?, ?, ?, 10, ?, 100)`,
      ).run(session, member, chestId, sourceId, NOW + i);
    }
    return member;
  }

  it('counts the chests even when the catalog spells the name the old way', () => {
    // The catalog now says "Jörmungandr's Chest"; store it the plain way, which
    // is what a rename in the other direction looks like. The corrector knows
    // both, so the records must still be found.
    ({ cleanup } = makeTestDb());
    seedChest("Jormungandr's Chest", 4);

    const b = getEventBreakdown('ragnarok', 1);
    expect(b?.totalChests).toBe(4);
    expect(b?.players[0]?.counts.Jormungandr).toBe(4);

    // …and it says the literal needs fixing rather than passing silently.
    const err = b?.configErrors.find((e) => e.declared === "Jörmungandr's Chest");
    expect(err).toMatchObject({ resolvedTo: "Jormungandr's Chest", kind: 'chest' });
    // The column is real, so it must NOT be marked unresolved.
    expect(b?.columns.find((c) => c.key === 'Jormungandr')?.unresolved).toBeUndefined();
  });

  it('marks a column whose chest matches nothing, instead of showing a bare 0', () => {
    ({ cleanup } = makeTestDb());
    seedChest("Fenrir's Chest", 3);

    const b = getEventBreakdown('ragnarok', 1);
    const jorm = b?.columns.find((c) => c.key === 'Jormungandr');
    expect(jorm?.unresolved).toBe(true);
    expect(jorm?.unresolvedReason).toBe('chest');
    // Still emitted — catalog order is stable whether or not a rule resolves.
    expect(b?.columns.map((c) => c.key)).toEqual(['Jormungandr', 'Fenrir']);
    expect(b?.configErrors).toContainEqual(
      { declared: "Jörmungandr's Chest", resolvedTo: null, kind: 'chest' },
    );
  });

  it('marks a column whose source needle matches nothing — the second silent-zero exit', () => {
    // Ancients' Sapphire rule needs BOTH the chest and a "vault of the ancients"
    // source. A dead needle kills the rule including its chest half.
    ({ cleanup } = makeTestDb());
    seedChest('Sapphire Chest', 5, 'Level 10 Crypt');

    const b = getEventBreakdown('ancients', 1);
    const vault = b?.columns.find((c) => c.key === 'Vault');
    expect(vault?.unresolved).toBe(true);
    expect(vault?.unresolvedReason).toBe('source');
    expect(b?.configErrors).toContainEqual(
      { declared: 'vault of the ancients', resolvedTo: null, kind: 'source' },
    );
  });

  it('matches an accented source through an unaccented needle', () => {
    // sourcesMatching folds both sides now. Before, an ASCII needle could never
    // match an accented source — the source-side twin of the anchor bug, and
    // migration v63 makes the accented spelling the surviving one.
    ({ cleanup } = makeTestDb());
    seedChest('Sapphire Chest', 6, 'Lvl 35-39 Vàult of the Ancients');

    const b = getEventBreakdown('ancients', 1);
    expect(b?.players[0]?.counts['Vault']).toBe(6);
    expect(b?.columns.find((c) => c.key === 'Vault')?.unresolved).toBeUndefined();
  });

  it('reports config errors even when the whole event resolves to nothing', () => {
    // Level mode derives its columns FROM the data, so when its sole rule dies
    // there is no column left to mark and the tab reads as a quiet week. The
    // breakdown carries the errors so the page can still say why.
    ({ cleanup } = makeTestDb());
    seedChest('Sapphire Chest', 2);

    const b = getEventBreakdown('runics', 1);
    expect(b?.columns).toEqual([]);
    expect(b?.totalChests).toBe(0);
    expect(b?.configErrors).toContainEqual(
      { declared: 'Runic Chest', resolvedTo: null, kind: 'chest' },
    );
  });

  it('reports nothing when the catalog and the data agree', () => {
    ({ cleanup } = makeTestDb());
    seedChest("Jörmungandr's Chest", 2);
    seedChest("Fenrir's Chest", 1);

    const b = getEventBreakdown('ragnarok', 1);
    expect(b?.configErrors).toEqual([]);
    expect(b?.columns.every((c) => !c.unresolved)).toBe(true);
  });

  it('counts both Golden Guardian rarities under one column', () => {
    // Naming only the Epic chest silently dropped 179 Legendary ones in prod.
    ({ cleanup } = makeTestDb());
    seedChest('Golden Guardian Epic Chest', 3, 'Epic Ancient squad');
    seedChest('Golden Guardian Legendary Chest', 2, 'Epic Ancient squad');

    const b = getEventBreakdown('ancients', 1);
    const total = (b?.players ?? []).reduce((s, p) => s + (p.counts['Golden Guardian'] || 0), 0);
    expect(total).toBe(5);
    expect(b?.columns.find((c) => c.key === 'Golden Guardian')?.parts)
      .toEqual(['Golden Guardian Epic Chest', 'Golden Guardian Legendary Chest']);
  });
});
