import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import {
  applyPointChanges, getPointsBoard, PointsChangeError, previewPointChanges, previewRecalculate,
  type BoardSource,
} from '../../src/data/points-board.js';
import { invalidateSourceKeySummary } from '../../src/data/repositories/source-points-repo.js';
import { makeTestDb } from '../helpers/test-db.js';

/**
 * The Chest Points admin board. What matters:
 *  - one line per source, valued at what its chests actually score, with the
 *    odd ones out as exceptions — and ladders in level order, not string order,
 *  - a save is a target state: the source's chests move, its exceptions don't,
 *    and the override table ends up with no row that restates a fallback,
 *  - a preview predicts exactly what the save then does, and writes nothing.
 */

let cleanup: () => void;
let memberId = 0;
let sessionId = 0;
let clock = Date.UTC(2026, 8, 1);

beforeEach(() => {
  ({ cleanup } = makeTestDb());
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
    `INSERT INTO source_point_overrides (source_key, chest_name, point_value, updated_at) VALUES (?, ?, ?, ?)`,
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
  const s = getPointsBoard().sources.find((x) => x.key === key);
  if (!s) throw new Error(`no source ${key}`);
  return s;
}

/** Common 10 pays 5 (seeded), Tartaros from the same crypt pays 8 (seeded per chest). */
function seedCrypt(): void {
  record('Level 10 Crypt', 'Barbarian Chest', 6, 5);
  record('Level 10 Crypt', 'Orc Chest', 4, 5);
  record('Tartaros Crypt level 10', 'Tartaros Chest', 3, 8);
}

describe('board', () => {
  it('one line per source, valued at its chests, exceptions listed', () => {
    seedCrypt();
    const s = source('common 10');
    expect(s.label).toBe('Common Crypt · Level 10');
    expect(s.category).toBe('crypts');
    expect(s.points).toBe(5);
    expect(s.records).toBe(13);
    expect(s.chests.filter((c) => c.points !== s.points).map((c) => c.name)).toEqual(['Tartaros Chest']);
    expect(s.staleRecords).toBe(0);
  });

  it('orders a ladder by level, not as strings', () => {
    record('Level 5 Crypt', 'Barbarian Chest', 1, 1);
    record('Level 25 Crypt', 'Barbarian Chest', 1, 275);
    record('Level 10 Crypt', 'Barbarian Chest', 1, 5);
    record('Level 10 epic Crypt', 'Barbarian Chest', 1, 10);
    const crypts = getPointsBoard().sources.filter((s) => s.category === 'crypts').map((s) => s.label);
    expect(crypts).toEqual([
      'Common Crypt · Level 5', 'Common Crypt · Level 10', 'Common Crypt · Level 25', 'Epic Crypt · Level 10',
    ]);
  });

  it('a source OCR-read with and without spaces is one line', () => {
    record('Clan wealth', 'Rare Chest of Wealth', 2, 1);
    record('ClanWealth', 'Rare Chest of Wealth', 3, 1);
    const wealth = getPointsBoard().sources.filter((s) => s.category === 'other');
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
    expect(getPointsBoard().staleRecords).toBe(4);
  });
});

describe('saving', () => {
  it('a source value moves its chests and keeps its exceptions', () => {
    seedCrypt();
    const preview = previewPointChanges([{ sourceKey: 'common 10', chestName: '', points: 6 }]);
    expect(preview.edits).toEqual([
      { key: 'common 10', label: 'Common Crypt · Level 10', chestName: '', from: 5, to: 6 },
    ]);
    expect(preview.impact.records).toBe(10);
    expect(preview.impact.delta).toBe(10);
    // The preview wrote nothing.
    expect(overrideRows()).toEqual([]);
    expect(storedPoints('Level 10 Crypt', 'Barbarian Chest')).toEqual([5]);

    const result = applyPointChanges([{ sourceKey: 'common 10', chestName: '', points: 6 }]);
    expect(result.updated).toBe(preview.impact.records);
    expect(storedPoints('Level 10 Crypt', 'Barbarian Chest')).toEqual([6]);
    // Tartaros was seeded per chest; the new wildcard outranks a seed, so it
    // is pinned at its own value rather than swept along.
    expect(storedPoints('Tartaros Crypt level 10', 'Tartaros Chest')).toEqual([8]);
    expect(overrideRows()).toEqual([
      { source_key: 'common 10', chest_name: '', point_value: 6 },
      { source_key: 'common 10', chest_name: 'Tartaros Chest', point_value: 8 },
    ]);
    const s = source('common 10');
    expect(s.points).toBe(6);
    expect(s.chests.find((c) => c.name === 'Tartaros Chest')?.points).toBe(8);
  });

  it('a chest value moves only that chest', () => {
    seedCrypt();
    applyPointChanges([{ sourceKey: 'common 10', chestName: 'Orc Chest', points: 9 }]);
    expect(storedPoints('Level 10 Crypt', 'Orc Chest')).toEqual([9]);
    expect(storedPoints('Level 10 Crypt', 'Barbarian Chest')).toEqual([5]);
    expect(overrideRows()).toEqual([{ source_key: 'common 10', chest_name: 'Orc Chest', point_value: 9 }]);
  });

  it('putting an exception back on the source value drops its row', () => {
    seedCrypt();
    override('common 10', 'Orc Chest', 9);
    applyPointChanges([{ sourceKey: 'common 10', chestName: 'Orc Chest', points: 5 }]);
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
    applyPointChanges([{ sourceKey: 'authority rush tournament', chestName: '', points: 12 }]);
    expect(overrideRows()).toEqual([{ source_key: 'authority rush tournament', chest_name: '', point_value: 12 }]);
    expect(storedPoints('Authority Rush tournament', 'Chest of Authority')).toEqual([12]);
  });

  it('collapses spaced and spaceless override rows into one', () => {
    record('Clan wealth', 'Rare Chest of Wealth', 2, 1);
    override('clanwealth', '', 3);
    applyPointChanges([{ sourceKey: 'clan wealth', chestName: '', points: 2 }]);
    expect(overrideRows()).toEqual([{ source_key: 'clan wealth', chest_name: '', point_value: 2 }]);
  });

  it('a save that changes nothing plans nothing', () => {
    seedCrypt();
    const preview = previewPointChanges([{ sourceKey: 'common 10', chestName: '', points: 5 }]);
    expect(preview.edits).toEqual([]);
    expect(preview.impact.records).toBe(0);
  });

  it('rejects an unknown source, an unseen chest and a bad value', () => {
    seedCrypt();
    expect(() => previewPointChanges([{ sourceKey: 'nope', chestName: '', points: 1 }])).toThrow(PointsChangeError);
    expect(() => previewPointChanges([{ sourceKey: 'common 10', chestName: 'Ghost Chest', points: 1 }])).toThrow(PointsChangeError);
    expect(() => previewPointChanges([{ sourceKey: 'common 10', chestName: '', points: -1 }])).toThrow(PointsChangeError);
    expect(() => previewPointChanges([{ sourceKey: 'common 10', chestName: '', points: 1.5 }])).toThrow(PointsChangeError);
  });
});

describe('recalculate preview', () => {
  it('reports out-of-date records per source and clan, then nothing once fixed', async () => {
    record('Level 10 Crypt', 'Barbarian Chest', 4, 3);
    const impact = previewRecalculate();
    expect(impact.records).toBe(4);
    expect(impact.delta).toBe(8);
    expect(impact.clans).toEqual([expect.objectContaining({ id: 1, records: 4, delta: 8 })]);
    expect(impact.lines[0]).toMatchObject({ label: 'Common Crypt · Level 10', chests: ['Barbarian Chest'], from: [3], to: 5 });

    const { recalculateAllPoints } = await import('../../src/data/repositories/source-points-repo.js');
    expect(recalculateAllPoints()).toBe(4);
    expect(previewRecalculate().records).toBe(0);
    // Already-correct rows are not counted as updated.
    expect(recalculateAllPoints()).toBe(0);
  });
});
