/**
 * Insert a round of event standings as they were pasted before pasting was
 * removed (Nov 2026) — the rows tinman-repo.ts still reads for runs the game
 * never read. A row's member is the clan's member of that exact name, if any.
 */
import { getDb } from '../../src/data/database.js';
import type { ScoreEventKey } from '../../src/data/repositories/tinman-repo.js';

export function insertPastedRound(opts: {
  clanId: number;
  date: string;
  summon: number;
  eventKey?: ScoreEventKey;
  rows: Array<[name: string, points: number]>;
}): void {
  const db = getDb();
  const upload = db.prepare(
    `INSERT INTO tinman_uploads (clan_id, event_key, tinman_date, summon, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, 'test', ?) RETURNING id`,
  ).get(opts.clanId, opts.eventKey ?? 'ancients', opts.date, opts.summon, new Date().toISOString()) as { id: number };
  const memberOf = db.prepare('SELECT id FROM members WHERE clan_id = ? AND name = ?');
  const insert = db.prepare(
    `INSERT INTO tinman_scores (upload_id, clan_id, rank, raw_name, member_id, match_kind, points)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  opts.rows.forEach(([name, points], i) => {
    const m = memberOf.get(opts.clanId, name) as { id: number } | undefined;
    insert.run(upload.id, opts.clanId, i + 1, name, m?.id ?? null, m ? 'exact' : 'unmatched', points);
  });
}
