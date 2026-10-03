import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { buildPointsGuide, placeChest, type PointsGuideSection } from '../../src/data/points-guide.js';
import { invalidateSourceKeySummary } from '../../src/data/repositories/source-points-repo.js';
import { makeTestDb } from '../helpers/test-db.js';

/**
 * The leaderboard FAQ's points table. What matters:
 *  - values come from the live scoring stack (an override in the DB wins),
 *  - every observed chest lands in a sensible box, ladders read as ranges,
 *  - OCR strays and end-of-event clan rewards stay out,
 *  - observation counts never leave the server (the public page serves this).
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

/** `count` chest_records of `chest` from `source`. */
function record(source: string, chest: string, count: number): void {
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
     VALUES (1, ?, ?, ?, ?, 0, ?)`,
  );
  for (let i = 0; i < count; i++) insert.run(sessionId, memberId, chestId, sourceId, clock++);
}

function section(sections: PointsGuideSection[], key: string): PointsGuideSection | undefined {
  return sections.find((s) => s.key === key);
}

function seedRealisticMix(): void {
  record('Level 5 Crypt', 'Barbarian Chest', 10);
  record('Level 10 Crypt', 'Barbarian Chest', 10);
  record('Level 10 rare Crypt', 'Rare Dragon Chest', 10);
  record('Tartaros Crypt level 10', 'Tartaros Chest', 10);
  record('Level 15 Citadel', 'Elven Citadel Chest', 10);
  record('Level 20 Citadel', 'Elven Citadel Chest', 10);
  record('Level 20 Citadel', 'Cursed Citadel Chest', 10);
  record('Level 16 heroic Monster', 'Undead Chest', 2);
  record('Level 17 heroic Monster', 'Elven Chest', 2);
  record('Level 18 heroic Monster', 'Cursed Chest', 2);
  record('Level 19 heroic Monster', 'Barbarian Chest', 2);
  record('Level 20 heroic Monster', 'Inferno Chest', 2);
  record('Lvl 20-24 Raid Runic squad', 'Runic Chest', 3);
  record('Lvl 10-14 Vault of the Ancients', 'Sapphire Chest', 3);
  record('Alchemy tournament', 'Prepared alchemical cauldron', 600);
  record('Alchemy tournament', 'Fire Chest', 1); // an OCR stray
  record('Sacred Rituals tournament', 'Sacred Rituals Chest', 1); // rare but real
  record('Event "Trials of Olympus"', 'Olympus Elite Chest', 5); // clan reward
  record('Epic Chimera squad', 'Chimera Chest', 3);
  record('Summoning Dark Omens', 'Minor Omen Chest', 3);
  record('Jörmungandr Shop', "Jörmungandr's Chest", 3);
  record('Arena', "Gladiator's Chest", 3);
}

describe('buildPointsGuide', () => {
  it('lays crypts and citadels out as a type × level matrix', () => {
    seedRealisticMix();
    const crypts = section(buildPointsGuide().sections, 'crypts');
    expect(crypts?.kind).toBe('matrix');
    if (crypts?.kind !== 'matrix') return;
    expect(crypts.levels).toEqual([5, 10, 15, 20]);
    const byLabel = Object.fromEntries(crypts.rows.map((r) => [r.label, r.cells]));
    expect(byLabel).toEqual({
      'Common Crypt': [1, 5, null, null],
      'Rare Crypt': [null, 8, null, null],
      // Same key as a common crypt, its own ladder.
      'Tartaros Crypt': [null, 8, null, null],
      'Elven Citadel': [null, null, 20, 60],
      // The source reads "Level 20 Citadel" for both; the chest tells them apart.
      'Cursed Citadel': [null, null, null, 60],
    });
  });

  it('merges adjacent ladder levels that pay the same', () => {
    seedRealisticMix();
    const { sections } = buildPointsGuide();
    expect(section(sections, 'heroic')).toMatchObject({
      kind: 'tiers',
      rows: [{ from: 16, to: 19, points: 20 }, { from: 20, to: 20, points: 60 }],
    });
    expect(section(sections, 'runic')).toMatchObject({ rows: [{ from: 20, to: 24, points: 20 }] });
    expect(section(sections, 'vault')).toMatchObject({ rows: [{ from: 10, to: 14, points: 5 }] });
  });

  it('files named chests by kind of source', () => {
    seedRealisticMix();
    const { sections } = buildPointsGuide();
    const names = (key: string) => {
      const s = section(sections, key);
      return s?.kind === 'chests' ? s.rows.map((r) => `${r.chest}=${r.points}`) : [];
    };
    expect(names('squads')).toEqual(['Chimera Chest=500']);
    expect(names('events')).toEqual(['Minor Omen Chest=50']);
    expect(names('shops')).toEqual(["Jörmungandr's Chest=500"]);
    expect(names('other')).toEqual(["Gladiator's Chest=1"]);
    expect(names('tournaments')).toEqual([
      'Prepared alchemical cauldron=25',
      'Sacred Rituals Chest=125',
    ]);
  });

  it('drops OCR strays but keeps a rare chest that is all its source drops', () => {
    seedRealisticMix();
    const raw = JSON.stringify(buildPointsGuide());
    expect(raw).not.toContain('Fire Chest');
    expect(raw).toContain('Sacred Rituals Chest');
  });

  it('leaves clan rewards out of the table and names them as not counted', () => {
    seedRealisticMix();
    const guide = buildPointsGuide();
    expect(guide.notCounted).toEqual(['Olympus Elite Chest']);
    expect(JSON.stringify(guide.sections)).not.toContain('Olympus');
  });

  it('reads the value from the scoring table, so an override wins', () => {
    seedRealisticMix();
    getDb().prepare(
      `INSERT INTO source_point_overrides (source_key, chest_name, point_value, updated_at)
       VALUES ('arena', 'Gladiator''s Chest', 3, ?)`,
    ).run(new Date().toISOString());
    invalidateSourceKeySummary();
    const other = section(buildPointsGuide().sections, 'other');
    expect(other?.kind === 'chests' && other.rows[0].points).toBe(3);
  });

  it('exposes no observation counts', () => {
    seedRealisticMix();
    for (const s of buildPointsGuide().sections) {
      if (s.kind === 'chests') {
        for (const r of s.rows) expect(Object.keys(r).sort()).toEqual(['chest', 'points', 'source']);
      } else if (s.kind === 'tiers') {
        for (const r of s.rows) expect(Object.keys(r).sort()).toEqual(['from', 'points', 'to']);
      }
    }
  });

  it('is empty, not broken, before the first scan', () => {
    expect(buildPointsGuide()).toEqual({ sections: [], notCounted: [] });
  });
});

describe('placeChest', () => {
  it('recognises a heroic key PaddleOCR read without spaces', () => {
    expect(placeChest('level16heroicmonster', 'Level16heroicMonster', 'Undead Chest'))
      .toEqual({ section: 'heroic', from: 16, to: 16 });
  });

  it('sends an unknown source to Other rather than dropping it', () => {
    expect(placeChest('brand new thing', 'Brand New Thing', 'Mystery Chest')).toEqual({ section: 'other' });
  });
});
