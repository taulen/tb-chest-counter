/**
 * v134: a resource batch names the scan that wrote it. The backfill links a
 * scan-written batch to its clan's session whose window holds the batch's
 * uploaded_at (one clan's scans never overlap); an upload, another clan's
 * batch, or a capture outside every window (the OCR era's) stays NULL, and a
 * replay changes nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initDatabase } from '../../src/data/database.js';
import { makeTestDb } from '../helpers/test-db.js';

describe('v134 resource_upload_batches.session_id backfill', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  it('links each scan batch to the session it was written in, and nothing else', () => {
    const made = makeTestDb();
    cleanup = made.cleanup;
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO clans (id, name, slug, game_url, is_active, created_at) VALUES (2, 'B', 'b', 'x', 1, ?)`)
      .run(new Date().toISOString());
    const session = (clanId: number, start: string, end: string | null) => (db.prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
       VALUES (?, ?, ?, 'completed', 'scheduled') RETURNING id`,
    ).get(clanId, start, end) as { id: number }).id;
    const batch = (clanId: number, at: string, source: string) => (db.prepare(
      `INSERT INTO resource_upload_batches (clan_id, uploaded_at, upload_date, source) VALUES (?, ?, '2026-11-18', ?) RETURNING id`,
    ).get(clanId, at, source) as { id: number }).id;

    const early = session(1, '2026-11-18T10:00:00.000Z', '2026-11-18T10:00:20.000Z');
    const late = session(1, '2026-11-18T11:30:00.000Z', '2026-11-18T11:30:09.000Z');
    const otherClan = session(2, '2026-11-18T10:00:00.000Z', '2026-11-18T10:00:30.000Z');
    const inEarly = batch(1, '2026-11-18T10:00:12.000Z', 'scan');
    const inLate = batch(1, '2026-11-18T11:30:05.000Z', 'scan');
    const ocrDay = batch(1, '2026-11-18T10:45:00.000Z', 'scan'); // between scans
    const upload = batch(1, '2026-11-18T10:00:15.000Z', 'upload');
    const clan2 = batch(2, '2026-11-18T10:00:25.000Z', 'scan');

    // Replay v134: the runner gates on MAX(version).
    db.prepare('DELETE FROM schema_version WHERE version >= 134').run();
    closeDb();
    initDatabase(made.dbPath);

    const linked = () => Object.fromEntries((getDb().prepare('SELECT id, session_id FROM resource_upload_batches').all() as
      Array<{ id: number; session_id: number | null }>).map((r) => [r.id, r.session_id]));
    expect(linked()).toEqual({
      [inEarly]: early,
      [inLate]: late,
      [ocrDay]: null,
      [upload]: null,
      [clan2]: otherClan,
    });

    getDb().prepare('DELETE FROM schema_version WHERE version >= 134').run();
    closeDb();
    initDatabase(made.dbPath);
    expect(linked()[inEarly]).toBe(early);
  });
});
