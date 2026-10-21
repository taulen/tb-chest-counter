import { getDb } from '../database.js';

// Event schedule state the calendar feed can't hold for us (migration v76):
// the runs it has already shown (it forgets them after ~a month) and the hand
// corrections for runs it has wrong. Both are GLOBAL — the feed is one
// game-wide schedule, so there is no clan_id. Instants are stored as ISO UTC
// strings from toISOString(), so they compare correctly as text.

export interface CalendarRun {
  eventKey: string;
  /** epoch ms */
  start: number;
  /** epoch ms */
  end: number;
}

export interface ScheduleCorrection {
  id: number;
  eventKey: string;
  /** ISO UTC — the start of the run as the feed lists it. */
  feedStartAt: string;
  /** ISO UTC — when that run really starts. */
  actualStartAt: string;
  createdAt: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Archived runs of one event, ascending, as epoch ms. */
export function listArchivedRuns(eventKey: string): Array<{ start: number; end: number }> {
  const rows = getDb()
    .prepare(
      `SELECT start_at, end_at FROM event_calendar_runs
        WHERE event_key = ? ORDER BY start_at`,
    )
    .all(eventKey) as { start_at: string; end_at: string }[];
  return rows.map((r) => ({ start: Date.parse(r.start_at), end: Date.parse(r.end_at) }));
}

/**
 * Mirror the feed into the archive for every run it shows as already started.
 *
 * Inside the feed's reach (`horizonMs` → `nowMs`) the archive is REPLACED by
 * what the feed says now, so a run the portal later moves or deletes doesn't
 * linger as a phantom beside its corrected copy. Older rows — the ones the
 * feed has forgotten — are never touched; that is the whole point of keeping
 * them. Future runs are never stored: they can still move.
 */
export function syncArchivedRuns(horizonMs: number, nowMs: number, runs: CalendarRun[]): void {
  const db = getDb();
  const del = db.prepare(
    'DELETE FROM event_calendar_runs WHERE start_at >= ? AND start_at <= ?',
  );
  const ins = db.prepare(
    `INSERT OR REPLACE INTO event_calendar_runs (event_key, start_at, end_at)
     VALUES (?, ?, ?)`,
  );
  db.transaction(() => {
    del.run(iso(horizonMs), iso(nowMs));
    for (const r of runs) {
      if (r.start < horizonMs || r.start > nowMs) continue;
      ins.run(r.eventKey, iso(r.start), iso(r.end));
    }
  })();
}

export function listCorrections(): ScheduleCorrection[] {
  const rows = getDb()
    .prepare(
      `SELECT id, event_key, feed_start_at, actual_start_at, created_at
         FROM event_schedule_corrections ORDER BY feed_start_at DESC`,
    )
    .all() as {
    id: number;
    event_key: string;
    feed_start_at: string;
    actual_start_at: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    eventKey: r.event_key,
    feedStartAt: r.feed_start_at,
    actualStartAt: r.actual_start_at,
    createdAt: r.created_at,
  }));
}

/** Insert or replace the correction for one feed run. */
export function setCorrection(
  eventKey: string,
  feedStartMs: number,
  actualStartMs: number,
  userId: number | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO event_schedule_corrections
         (event_key, feed_start_at, actual_start_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (event_key, feed_start_at) DO UPDATE SET
         actual_start_at = excluded.actual_start_at,
         created_by = excluded.created_by,
         created_at = excluded.created_at`,
    )
    .run(eventKey, iso(feedStartMs), iso(actualStartMs), userId, new Date().toISOString());
}

/** Returns true when a row was removed. */
export function deleteCorrection(id: number): boolean {
  return getDb().prepare('DELETE FROM event_schedule_corrections WHERE id = ?').run(id).changes > 0;
}
