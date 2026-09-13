import { describe, expect, it, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { getDb } from '../../src/data/database.js';
import { checkConfigIntegrity } from '../../src/data/config-integrity.js';
import { makeTestDb } from '../helpers/test-db.js';

/**
 * The boot-time net for name-keyed configuration.
 *
 * Every defect it looks for fails the same way in production — as a zero that
 * reads like a result — which is why the Ragnarok column went unnoticed for
 * weeks. The two properties that matter are that it FINDS each one, and that it
 * stays SILENT otherwise: a checker that always has something to say is a
 * checker nobody reads, and it would light the System nav dot forever.
 */
let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function freshDb(): Database {
  const t = makeTestDb();
  cleanup = t.cleanup;
  return getDb();
}

const NOW = new Date().toISOString();

/** A DB with real chest data, configured entirely correctly. */
function seedHealthy(db: Database): { chestId: number; sourceId: number } {
  db.prepare(
    `INSERT INTO members (id, clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (1, 1, 'Taulen', 'taulen', ?, ?, 1)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO scan_sessions (id, clan_id, started_at, status, trigger_source)
     VALUES (1, 1, ?, 'COMPLETED', 'manual')`,
  ).run(NOW);

  // Every chest the catalog declares, so the event-catalog checks are quiet.
  const names = [
    'Sapphire Chest', 'Golden Guardian Epic Chest', 'Golden Guardian Legendary Chest',
    'Golden Guardian Ascendant Chest',
    "Ancients' Chest", 'Quick March Chest', "Jörmungandr's Chest", "Fenrir's Chest",
    'Tartaros Chest', 'Olympus Chest', 'Olympus Elite Chest', 'Hermes Chest',
    'Basilisk Chest', 'Chimera Chest',
    'Briareus Chest', 'Minor Omen Chest', 'Major Omen Chest', 'Epic Omen Chest',
    'Arcane Chest', 'Spoils of Dread Chest', 'Dark Omens chest', 'Dark Omens ranking chest',
    'Union Chest', 'Elven Citadel Chest', 'Cursed Citadel Chest', 'Runic Chest',
  ];
  for (const n of names) {
    db.prepare('INSERT OR IGNORE INTO chests (name, chest_type) VALUES (?, ?)').run(n, 'common');
  }
  const chestId = (db.prepare('SELECT id FROM chests WHERE name = ?')
    .get("Jörmungandr's Chest") as { id: number }).id;

  // Every sourceContains needle in the catalog must match something. Heroics is
  // matched on its source ALONE (no chest name), so this row is the only thing
  // keeping its rule alive — the lowercase "heroic" is the game's own casing.
  db.prepare('INSERT INTO chest_sources (source) VALUES (?)').run('Lvl 35-39 Vault of the Ancients');
  db.prepare('INSERT INTO chest_sources (source) VALUES (?)').run('Level 16 heroic Monster');
  db.prepare('INSERT INTO chest_sources (source) VALUES (?)').run('Jörmungandr Shop');
  const sourceId = (db.prepare('SELECT id FROM chest_sources WHERE source = ?')
    .get('Jörmungandr Shop') as { id: number }).id;

  db.prepare(
    `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
     VALUES (1, 1, 1, ?, ?, 0, 1700000000000, 100)`,
  ).run(chestId, sourceId);

  return { chestId, sourceId };
}

const kinds = (db: Database): string[] => checkConfigIntegrity(db).map((f) => f.kind).sort();

describe('checkConfigIntegrity', () => {
  it('says nothing on a fresh install, before anything has been scanned', () => {
    // `chests` is never seeded — rows appear only when a chest is first observed —
    // so on first boot every catalog literal resolves to nothing. Reporting 24
    // problems for an app that has done nothing wrong is exactly the noise that
    // makes a warning system worthless, and pre-declaring a chest is documented
    // as supported.
    const db = freshDb();
    expect(checkConfigIntegrity(db)).toEqual([]);
  });

  it('says nothing on a healthy, populated database', () => {
    const db = freshDb();
    seedHealthy(db);
    expect(checkConfigIntegrity(db)).toEqual([]);
  });

  it('flags a catalog literal that disagrees with a name the DB really holds', () => {
    // The anchor bug: the chest exists, the catalog spells it differently.
    const db = freshDb();
    seedHealthy(db);
    db.prepare('UPDATE chests SET name = ? WHERE name = ?')
      .run("Jormungandr's Chest", "Jörmungandr's Chest");

    const findings = checkConfigIntegrity(db);
    const stale = findings.find((f) => f.kind === 'event-catalog/chest-name-stale');
    expect(stale).toBeDefined();
    expect(stale?.severity).toBe('error');
    expect(stale?.detail).toContain("Jormungandr's Chest");
  });

  it('flags a catalog literal matching nothing, but only as a warning', () => {
    // Indistinguishable from a chest the clan has never collected, so it informs
    // rather than lighting the nav dot.
    const db = freshDb();
    seedHealthy(db);
    db.prepare('DELETE FROM chests WHERE name = ?').run('Briareus Chest');

    const dead = checkConfigIntegrity(db).find((f) => f.kind === 'event-catalog/chest-name-dead');
    expect(dead).toBeDefined();
    expect(dead?.severity).toBe('warning');
  });

  it('flags a sourceContains needle that matches no source', () => {
    // Kills the whole rule, chest half included.
    const db = freshDb();
    seedHealthy(db);
    db.prepare('DELETE FROM chest_sources WHERE source = ?').run('Lvl 35-39 Vault of the Ancients');
    expect(kinds(db)).toContain('event-catalog/source-needle-dead');
  });

  it('flags a point override keyed to a chest name nothing carries', () => {
    const db = freshDb();
    seedHealthy(db);
    db.prepare(
      `INSERT INTO source_point_overrides (source_key, chest_name, point_value, updated_at)
       VALUES ('jormungandr shop', 'Jormungandr''s Chest', 50, ?)`,
    ).run(NOW);

    const f = checkConfigIntegrity(db).find((x) => x.kind === 'source-points/chest-name-orphan');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('error');
  });

  it('flags a point override on a source key nothing derives', () => {
    // Production really holds one: "rise of the anclents event", an OCR l/i
    // misread that v62 structurally could not repair.
    const db = freshDb();
    seedHealthy(db);
    db.prepare(
      `INSERT INTO source_point_overrides (source_key, chest_name, point_value, updated_at)
       VALUES ('rise of the anclents event', '', 25, ?)`,
    ).run(NOW);
    expect(kinds(db)).toContain('source-points/source-key-dead');
  });

  it('flags a merge rule pointing at a destination nothing uses', () => {
    const db = freshDb();
    seedHealthy(db);
    db.prepare(
      `INSERT INTO merge_rules (clan_id, type, from_value, to_value, created_at)
       VALUES (1, 'source', 'Level 20-24 Vault of the Ancients:', 'Lvl 20-24 Vault of the Ancients:', ?)`,
    ).run(NOW);
    expect(kinds(db)).toContain('merge-rules/dead-target');
  });

  it('flags a merged-away player spelling that is back on the roster', () => {
    // The tripwire that was missing. This sweep skipped type='player' entirely, so
    // when the daily might capture kept re-creating names an admin had already merged
    // — because nothing outside the gift scan read the rules — there was no signal at
    // all. A player rule's from_value existing as a member means the merge came undone.
    const db = freshDb();
    seedHealthy(db);
    db.prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (1, 'Ma Chaosraven', 'ma chaosraven', ?, ?, 1),
              (1, 'Mikam Chaosraven', 'mikam chaosraven', ?, ?, 1)`,
    ).run(NOW, NOW, NOW, NOW);
    db.prepare(
      `INSERT INTO merge_rules (clan_id, type, from_value, to_value, created_at)
       VALUES (1, 'player', 'Ma Chaosraven', 'Mikam Chaosraven', ?)`,
    ).run(NOW);
    expect(kinds(db)).toContain('merge-rules/player-resplit');
  });

  it('stays quiet about a player rule whose merge is still holding', () => {
    const db = freshDb();
    seedHealthy(db);
    db.prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (1, 'Mikam Chaosraven', 'mikam chaosraven', ?, ?, 1)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO merge_rules (clan_id, type, from_value, to_value, created_at)
       VALUES (1, 'player', 'Ma Chaosraven', 'Mikam Chaosraven', ?)`,
    ).run(NOW);
    expect(kinds(db)).not.toContain('merge-rules/player-resplit');
    expect(kinds(db)).not.toContain('merge-rules/dead-target');
  });

  it('flags a player rule whose destination is not on the roster', () => {
    const db = freshDb();
    seedHealthy(db);
    db.prepare(
      `INSERT INTO merge_rules (clan_id, type, from_value, to_value, created_at)
       VALUES (1, 'player', 'Ma Chaosraven', 'Mikam Chaosraven', ?)`,
    ).run(NOW);
    expect(kinds(db)).toContain('merge-rules/dead-target');
  });

  it('flags two spellings of one source, the tripwire that keeps v63 done', () => {
    const db = freshDb();
    seedHealthy(db);
    db.prepare('INSERT INTO chest_sources (source) VALUES (?)').run('Jormungandr Shop');
    expect(kinds(db)).toContain('chest-sources/duplicate-spelling');
  });

  it('flags two spellings of one chest', () => {
    // getOrCreateChestId has no canonical reuse scan (its chest_sources sibling
    // does), so this is the guard behind that deferral.
    const db = freshDb();
    seedHealthy(db);
    db.prepare('INSERT INTO chests (name, chest_type) VALUES (?, ?)').run('Runic  Chest', 'common');
    expect(kinds(db)).toContain('chests/duplicate-spelling');
  });

  it('flags a rarity override for a chest that no longer exists', () => {
    const db = freshDb();
    seedHealthy(db);
    db.prepare(
      `INSERT INTO chest_type_overrides (clan_id, chest_name, chest_type, created_at)
       VALUES (1, 'Ghost Chest', 'epic', ?)`,
    ).run(NOW);
    expect(kinds(db)).toContain('chest-types/orphan');
  });

  it('stays quiet about seeded triumphal values until a triumphal chest is scanned', () => {
    // Migration v54 seeds triumphal_chest_points unconditionally, so on any DB
    // that has never received a bank chest, every one of them is an "orphan".
    const db = freshDb();
    seedHealthy(db);
    expect(kinds(db)).not.toContain('triumphal-points/orphan');

    db.prepare(
      `INSERT INTO triumphal_chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at, confidence)
       VALUES (1, 1, 1, ?, 0, 1700000000000, 100)`,
    ).run((db.prepare("SELECT id FROM chests WHERE name = 'Runic Chest'").get() as { id: number }).id);
    expect(kinds(db)).toContain('triumphal-points/orphan');
  });
});
