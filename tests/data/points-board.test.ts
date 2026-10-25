import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initDatabase } from '../../src/data/database.js';
import {
  applyCopyFrom, applyPointChanges, getPointsBoard, PointsChangeError, previewCopyFrom, previewPointChanges, previewRecalculate,
  type BoardSource,
} from '../../src/data/points-board.js';
import { invalidateSourceKeySummary } from '../../src/data/repositories/source-points-repo.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

/**
 * The Chest Points admin board. What matters:
 *  - one line per source, valued at what its chests actually score, with the
 *    odd ones out as exceptions — and ladders in level order, not string order,
 *  - a save is a target state: the source's chests move, its exceptions don't,
 *    and the override table ends up with no row that restates a fallback,
 *  - a preview predicts exactly what the save then does, and writes nothing.
 */

let cleanup: () => void;
let dbPath = '';
let memberId = 0;
let sessionId = 0;
let clock = Date.UTC(2026, 8, 1);

beforeEach(() => {
  ({ cleanup, dbPath } = makeTestDb());
  const db = getDb();
  const now = new Date().toISOString();
  memberId = (db.prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (1, 'Alice', 'alice', ?, ?, 1) RETURNING id`,
  ).get(now, now) as { id: number }).id;
  sessionId = (db.prepare(
    `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
     VALUES (1, ?, ?, 'completed', 'manual') RETURNING id`,
  ).get(now, now) as { id: number }).id;
});
afterEach(() => cleanup());

/** `count` chest_records of `chest` from `source`, stored at `points`. */
function record(source: string, chest: string, count: number, points: number): void {
  const db = getDb();
  const chestId = (db.prepare(
    `INSERT INTO chests (name, chest_type) VALUES (?, 'common')
     ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
  ).get(chest) as { id: number }).id;
  const sourceId = (db.prepare(
    `INSERT INTO chest_sources (source) VALUES (?)
     ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
  ).get(source) as { id: number }).id;
  const insert = db.prepare(
    `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < count; i++) insert.run(sessionId, memberId, chestId, sourceId, points, clock++);
  invalidateSourceKeySummary();
}

function override(sourceKey: string, chestName: string, points: number): void {
  getDb().prepare(
    `INSERT INTO source_point_overrides (clan_id, source_key, chest_name, point_value, updated_at) VALUES (1, ?, ?, ?, ?)`,
  ).run(sourceKey, chestName, points, new Date().toISOString());
  invalidateSourceKeySummary();
}

function overrideRows(): { source_key: string; chest_name: string; point_value: number }[] {
  return getDb().prepare(
    'SELECT source_key, chest_name, point_value FROM source_point_overrides ORDER BY source_key, chest_name',
  ).all() as { source_key: string; chest_name: string; point_value: number }[];
}

function storedPoints(source: string, chest: string): number[] {
  return (getDb().prepare(`
    SELECT DISTINCT cr.point_value AS p FROM chest_records cr
      JOIN chest_sources cs ON cs.id = cr.chest_source_id
      JOIN chests ch ON ch.id = cr.chest_id
     WHERE cs.source = ? AND ch.name = ?`).all(source, chest) as { p: number }[]).map((r) => r.p);
}

function source(key: string): BoardSource {
  const s = getPointsBoard(1).sources.find((x) => x.key === key);
  if (!s) throw new Error(`no source ${key}`);
  return s;
}

/** Common 10 pays 5 (seeded) for every chest it drops. */
function seedCrypt(): void {
  record('Level 10 Crypt', 'Barbarian Chest', 6, 5);
  record('Level 10 Crypt', 'Orc Chest', 4, 5);
}

/** Summoning Dark Omens: each omen chest has its own seeded value (50/100/150). */
function seedOmens(): void {
  record('Summoning Dark Omens', 'Minor Omen Chest', 6, 50);
  record('Summoning Dark Omens', 'Major Omen Chest', 3, 100);
  record('Summoning Dark Omens', 'Epic Omen Chest', 1, 150);
}

describe('board', () => {
  it('one line per source, valued at its chests, exceptions listed', () => {
    seedOmens();
    const s = source('summoning dark omens');
    expect(s.label).toBe('Summoning Dark Omens');
    expect(s.category).toBe('events');
    expect(s.points).toBe(50);
    expect(s.records).toBe(10);
    expect(s.chests.filter((c) => c.points !== s.points).map((c) => c.name)).toEqual(['Epic Omen Chest', 'Major Omen Chest']);
    expect(s.staleRecords).toBe(0);
  });

  it('a Tartaros crypt is its own source, not an exception of a common one', () => {
    seedCrypt();
    record('Tartaros Crypt level 10', 'Tartaros Chest', 3, 8);
    const common = source('common 10');
    expect(common.chests.map((c) => c.name)).toEqual(['Barbarian Chest', 'Orc Chest']);
    const tartaros = source('tartaros 10');
    expect(tartaros).toMatchObject({ label: 'Tartaros Crypt · Level 10', category: 'crypts', points: 8, staleRecords: 0 });
  });

  it('groups heroic levels into the admins\' tiers, leaving an unknown level on its own', () => {
    for (const level of [16, 19, 20, 30, 35, 36, 45, 46]) {
      record(`Level ${level} heroic Monster`, 'Undead Chest', 1, 25);
    }
    const board = getPointsBoard(1);
    const groupOf = (level: number) => board.sources.find((s) => s.key === `level ${level} heroic monster`)?.group;
    expect(groupOf(16)).toBe('heroic-16-19');
    expect(groupOf(19)).toBe('heroic-16-19');
    expect(groupOf(20)).toBe('heroic-20-24');
    expect(groupOf(30)).toBe('heroic-30-35');
    expect(groupOf(35)).toBe('heroic-30-35');
    expect(groupOf(36)).toBe('heroic-36-40');
    expect(groupOf(45)).toBe('heroic-41-45');
    expect(groupOf(46)).toBeNull();
    expect(board.groups.map((g) => g.label)).toEqual([
      'Heroic Monster · Level 16–19', 'Heroic Monster · Level 20–24', 'Heroic Monster · Level 30–35',
      'Heroic Monster · Level 36–40', 'Heroic Monster · Level 41–45',
    ]);
    // Nothing else is grouped.
    seedCrypt();
    expect(getPointsBoard(1).sources.find((s) => s.key === 'common 10')?.group).toBeNull();
  });

  it('orders a ladder by level, not as strings', () => {
    record('Level 5 Crypt', 'Barbarian Chest', 1, 1);
    record('Level 25 Crypt', 'Barbarian Chest', 1, 275);
    record('Level 10 Crypt', 'Barbarian Chest', 1, 5);
    record('Level 10 epic Crypt', 'Barbarian Chest', 1, 10);
    record('Tartaros Crypt level 15', 'Tartaros Chest', 1, 60);
    const crypts = getPointsBoard(1).sources.filter((s) => s.category === 'crypts').map((s) => s.label);
    expect(crypts).toEqual([
      'Common Crypt · Level 5', 'Common Crypt · Level 10', 'Common Crypt · Level 25', 'Epic Crypt · Level 10',
      'Tartaros Crypt · Level 15',
    ]);
  });

  it('a source OCR-read with and without spaces is one line', () => {
    record('Clan wealth', 'Rare Chest of Wealth', 2, 1);
    record('ClanWealth', 'Rare Chest of Wealth', 3, 1);
    const wealth = getPointsBoard(1).sources.filter((s) => s.category === 'other');
    expect(wealth).toHaveLength(1);
    expect(wealth[0].key).toBe('clan wealth');
    expect(wealth[0].records).toBe(5);
  });

  it('flags only a source nobody has valued — not one seeded at 0', () => {
    record('Brand new thing', 'Mystery Chest', 2, 0);
    record('Epic Basilisk squad', 'Basilisk Chest', 2, 0);
    expect(source('brand new thing').unset).toBe(true);
    expect(source('epic basilisk squad').unset).toBe(false);
    override('brand new thing', '', 0);
    expect(source('brand new thing').unset).toBe(false);
  });

  it('counts records whose stored value is out of date', () => {
    record('Level 10 Crypt', 'Barbarian Chest', 4, 3);
    expect(source('common 10').staleRecords).toBe(4);
    expect(getPointsBoard(1).staleRecords).toBe(4);
  });
});

describe('saving', () => {
  it('a source value moves its chests and keeps its exceptions', () => {
    seedOmens();
    const change = [{ sourceKey: 'summoning dark omens', chestName: '', points: 60 }];
    const preview = previewPointChanges(1, change);
    expect(preview.edits).toEqual([
      { key: 'summoning dark omens', label: 'Summoning Dark Omens', chestName: '', from: 50, to: 60 },
    ]);
    expect(preview.impact.records).toBe(6);
    expect(preview.impact.delta).toBe(60);
    // The preview wrote nothing.
    expect(overrideRows()).toEqual([]);
    expect(storedPoints('Summoning Dark Omens', 'Minor Omen Chest')).toEqual([50]);

    const result = applyPointChanges(1, change);
    expect(result.updated).toBe(preview.impact.records);
    expect(storedPoints('Summoning Dark Omens', 'Minor Omen Chest')).toEqual([60]);
    // Major and Epic were seeded per chest; the new wildcard outranks a seed,
    // so they are pinned at their own values rather than swept along.
    expect(storedPoints('Summoning Dark Omens', 'Major Omen Chest')).toEqual([100]);
    expect(storedPoints('Summoning Dark Omens', 'Epic Omen Chest')).toEqual([150]);
    expect(overrideRows()).toEqual([
      { source_key: 'summoning dark omens', chest_name: '', point_value: 60 },
      { source_key: 'summoning dark omens', chest_name: 'Epic Omen Chest', point_value: 150 },
      { source_key: 'summoning dark omens', chest_name: 'Major Omen Chest', point_value: 100 },
    ]);
    const s = source('summoning dark omens');
    expect(s.points).toBe(60);
    expect(s.chests.find((c) => c.name === 'Epic Omen Chest')?.points).toBe(150);
  });

  it('a saved value leaves nothing for Recalculate', () => {
    seedCrypt();
    applyPointChanges(1, [{ sourceKey: 'common 10', chestName: '', points: 7 }]);
    expect(previewRecalculate(1).records).toBe(0);
    expect(getPointsBoard(1).staleRecords).toBe(0);
  });

  it('a chest value moves only that chest', () => {
    seedCrypt();
    applyPointChanges(1, [{ sourceKey: 'common 10', chestName: 'Orc Chest', points: 9 }]);
    expect(storedPoints('Level 10 Crypt', 'Orc Chest')).toEqual([9]);
    expect(storedPoints('Level 10 Crypt', 'Barbarian Chest')).toEqual([5]);
    expect(overrideRows()).toEqual([{ source_key: 'common 10', chest_name: 'Orc Chest', point_value: 9 }]);
  });

  it('putting an exception back on the source value drops its row', () => {
    seedCrypt();
    override('common 10', 'Orc Chest', 9);
    applyPointChanges(1, [{ sourceKey: 'common 10', chestName: 'Orc Chest', points: 5 }]);
    expect(overrideRows()).toEqual([]);
    expect(storedPoints('Level 10 Crypt', 'Orc Chest')).toEqual([5]);
  });

  it('a stale wildcard no longer hides behind every chest overriding it', () => {
    // The production shape: wildcard 25, the only chest pinned at 10 — the
    // board shows 10, and setting the source to 12 needs no chest row at all.
    record('Authority Rush tournament', 'Chest of Authority', 5, 10);
    override('authority rush tournament', '', 25);
    override('authority rush tournament', 'Chest of Authority', 10);
    expect(source('authority rush tournament').points).toBe(10);
    applyPointChanges(1, [{ sourceKey: 'authority rush tournament', chestName: '', points: 12 }]);
    expect(overrideRows()).toEqual([{ source_key: 'authority rush tournament', chest_name: '', point_value: 12 }]);
    expect(storedPoints('Authority Rush tournament', 'Chest of Authority')).toEqual([12]);
  });

  it('collapses spaced and spaceless override rows into one', () => {
    record('Clan wealth', 'Rare Chest of Wealth', 2, 1);
    override('clanwealth', '', 3);
    applyPointChanges(1, [{ sourceKey: 'clan wealth', chestName: '', points: 2 }]);
    expect(overrideRows()).toEqual([{ source_key: 'clan wealth', chest_name: '', point_value: 2 }]);
  });

  it('a save that changes nothing plans nothing', () => {
    seedCrypt();
    const preview = previewPointChanges(1, [{ sourceKey: 'common 10', chestName: '', points: 5 }]);
    expect(preview.edits).toEqual([]);
    expect(preview.impact.records).toBe(0);
  });

  it('rejects an unknown source, an unseen chest and a bad value', () => {
    seedCrypt();
    expect(() => previewPointChanges(1, [{ sourceKey: 'nope', chestName: '', points: 1 }])).toThrow(PointsChangeError);
    expect(() => previewPointChanges(1, [{ sourceKey: 'common 10', chestName: 'Ghost Chest', points: 1 }])).toThrow(PointsChangeError);
    expect(() => previewPointChanges(1, [{ sourceKey: 'common 10', chestName: '', points: -1 }])).toThrow(PointsChangeError);
    expect(() => previewPointChanges(1, [{ sourceKey: 'common 10', chestName: '', points: 1.5 }])).toThrow(PointsChangeError);
  });
});

describe('recalculate preview', () => {
  it('reports out-of-date records per source and clan, then nothing once fixed', async () => {
    record('Level 10 Crypt', 'Barbarian Chest', 4, 3);
    const impact = previewRecalculate(1);
    expect(impact.records).toBe(4);
    expect(impact.delta).toBe(8);
    expect(impact.clans).toEqual([expect.objectContaining({ id: 1, records: 4, delta: 8 })]);
    expect(impact.lines[0]).toMatchObject({ label: 'Common Crypt · Level 10', chests: ['Barbarian Chest'], from: [3], to: 5 });

    const { recalculatePoints } = await import('../../src/data/repositories/source-points-repo.js');
    expect(recalculatePoints(1)).toBe(4);
    expect(previewRecalculate(1).records).toBe(0);
    // Already-correct rows are not counted as updated.
    expect(recalculatePoints(1)).toBe(0);
  });
});

describe('migration v77: Tartaros crypts get their own source key', () => {
  it('moves the per-chest Tartaros overrides onto the new keys and changes no value', () => {
    record('Tartaros Crypt level 20', 'Tartaros Chest', 2, 225);
    record('Level 20 Crypt', 'Barbarian Chest', 2, 80);
    // The pre-split shape, including a spaceless key PaddleOCR produced.
    override('common 20', 'Tartaros Chest', 225);
    override('common25', 'Tartaros Chest', 450);
    override('common 20', '', 80);

    // Replay v77: the runner gates on MAX(version).
    getDb().prepare('DELETE FROM schema_version WHERE version >= 77').run();
    closeDb();
    initDatabase(dbPath);
    invalidateSourceKeySummary();

    expect(overrideRows()).toEqual([
      { source_key: 'common 20', chest_name: '', point_value: 80 },
      { source_key: 'tartaros 20', chest_name: '', point_value: 225 },
      { source_key: 'tartaros 25', chest_name: '', point_value: 450 },
    ]);
    expect(source('tartaros 20').points).toBe(225);
    expect(previewRecalculate(1).records).toBe(0);
  });
});

/** `count` clan-2 chest_records of an existing chest + source, stored at `points`. */
function recordClan2(source: string, chest: string, count: number, points: number): void {
  const db = getDb();
  const now = new Date().toISOString();
  const member = (db.prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (2, 'Bob', 'bob', ?, ?, 1) RETURNING id`,
  ).get(now, now) as { id: number }).id;
  const session = (db.prepare(
    `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
     VALUES (2, ?, ?, 'completed', 'manual') RETURNING id`,
  ).get(now, now) as { id: number }).id;
  const chestId = (db.prepare('SELECT id FROM chests WHERE name = ?').get(chest) as { id: number }).id;
  const sourceId = (db.prepare('SELECT id FROM chest_sources WHERE source = ?').get(source) as { id: number }).id;
  const insert = db.prepare(
    `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at)
     VALUES (2, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < count; i++) insert.run(session, member, chestId, sourceId, points, clock++);
  invalidateSourceKeySummary();
}

function storedPointsIn(clanId: number): number[] {
  return (getDb().prepare(
    'SELECT DISTINCT point_value AS p FROM chest_records WHERE clan_id = ? ORDER BY p',
  ).all(clanId) as { p: number }[]).map((r) => r.p);
}

describe('per-clan values', () => {
  it('a save moves only its own clan: values, overrides and stored records', () => {
    seedTwoClans();
    record('Level 10 Crypt', 'Barbarian Chest', 3, 5);
    recordClan2('Level 10 Crypt', 'Barbarian Chest', 2, 5);

    const result = applyPointChanges(1, [{ sourceKey: 'common 10', chestName: '', points: 40 }]);
    expect(result.updated).toBe(3);
    expect(result.impact.clans).toEqual([expect.objectContaining({ id: 1, records: 3 })]);

    expect(storedPointsIn(1)).toEqual([40]);
    expect(storedPointsIn(2)).toEqual([5]);
    expect(getPointsBoard(1).sources.find((s) => s.key === 'common 10')?.points).toBe(40);
    expect(getPointsBoard(2).sources.find((s) => s.key === 'common 10')?.points).toBe(5);
    expect(getPointsBoard(2).clan).toEqual({ id: 2, name: 'Clan #2' });
    expect(getDb().prepare('SELECT DISTINCT clan_id FROM source_point_overrides').all()).toEqual([{ clan_id: 1 }]);
    // Clan 2 is not "out of date" just because clan 1 now pays more.
    expect(previewRecalculate(2).records).toBe(0);
  });
});

describe('copy values from another clan', () => {
  it('makes the clan an exact copy of the other, previews it, and leaves the other alone', () => {
    seedTwoClans();
    record('Level 10 Crypt', 'Barbarian Chest', 3, 5);
    recordClan2('Level 10 Crypt', 'Barbarian Chest', 2, 5);
    // Clan 1: a source value plus one of its own; clan 2: a different source value.
    override('common 10', '', 40);
    override('arena', '', 7);
    applyPointChanges(2, [{ sourceKey: 'common 10', chestName: '', points: 60 }]);

    const preview = previewCopyFrom(2, 1);
    expect(preview.from).toEqual({ id: 1, name: 'Clan #1' });
    expect(preview.values).toBe(2);
    expect(preview.edits).toEqual([expect.objectContaining({ key: 'common 10', chestName: '', from: 60, to: 40 })]);
    expect(preview.impact).toMatchObject({ records: 2, delta: -40 });
    expect(storedPointsIn(2)).toEqual([60]);

    const result = applyCopyFrom(2, 1);
    expect(result.updated).toBe(2);
    expect(storedPointsIn(2)).toEqual([40]);
    const rows = (clanId: number) => getDb().prepare(
      'SELECT source_key, chest_name, point_value FROM source_point_overrides WHERE clan_id = ? ORDER BY source_key',
    ).all(clanId);
    expect(rows(2)).toEqual(rows(1));
    expect(rows(1)).toEqual([
      { source_key: 'arena', chest_name: '', point_value: 7 },
      { source_key: 'common 10', chest_name: '', point_value: 40 },
    ]);
    expect(previewRecalculate(2).records).toBe(0);
  });

  it('refuses copying a clan onto itself or from a clan that does not exist', () => {
    seedTwoClans();
    expect(() => previewCopyFrom(1, 1)).toThrow(PointsChangeError);
    expect(() => applyCopyFrom(1, 99)).toThrow(PointsChangeError);
  });
});

describe('migration v86: chest points become per clan', () => {
  it('copies the global table to every clan, so no clan scores differently', () => {
    seedTwoClans();
    record('Level 10 Crypt', 'Barbarian Chest', 2, 40);
    const db = getDb();
    // The v43–v85 shape: one global table.
    db.exec(`
      DROP TABLE source_point_overrides;
      CREATE TABLE source_point_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_key TEXT NOT NULL,
        chest_name TEXT NOT NULL DEFAULT '',
        point_value INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_key, chest_name)
      );
    `);
    db.prepare(
      "INSERT INTO source_point_overrides (source_key, chest_name, point_value, updated_at) VALUES ('common 10', '', 40, ?)",
    ).run(new Date().toISOString());

    db.prepare('DELETE FROM schema_version WHERE version >= 86').run();
    closeDb();
    initDatabase(dbPath);
    invalidateSourceKeySummary();

    expect(getDb().prepare(
      'SELECT clan_id, source_key, chest_name, point_value FROM source_point_overrides ORDER BY clan_id',
    ).all()).toEqual([
      { clan_id: 1, source_key: 'common 10', chest_name: '', point_value: 40 },
      { clan_id: 2, source_key: 'common 10', chest_name: '', point_value: 40 },
    ]);
    expect(previewRecalculate(1).records).toBe(0);
  });
});
