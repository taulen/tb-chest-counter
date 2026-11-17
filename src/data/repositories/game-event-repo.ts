/**
 * Event standings read from the game (v121): every running event's "Clan
 * members" tab (message 38003), per run. A run is (event_type, run,
 * occurrence) — the occurrence changes each time the event comes round, so a
 * finished run keeps its standings. History rows only when a player's points
 * move; the first read of a run is its baseline (stored, never a "change").
 */
import { getDb } from '../database.js';
import type { GameEventEntry, GameEventStanding } from '../../game-protocol/messages.js';

export interface EventRunKey {
  eventType: number;
  run: number;
  occurrence: number;
}

export interface StoredEventRun extends EventRunKey {
  code: string;
  title: string;
  startsAt: number | null;
  endsAt: number | null;
  firstSeen: string;
  lastRead: string;
}

const OPEN_ENDED = 4294967295;

/** Record (or refresh) a run the list showed running. */
export function saveEventRun(clanId: number, e: GameEventEntry, meta: { code: string; title: string }, now = new Date().toISOString()): void {
  getDb().prepare(
    `INSERT INTO game_event_runs (clan_id, event_type, run, occurrence, code, title, starts_at, ends_at, first_seen, last_read)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, event_type, run, occurrence) DO UPDATE SET
       code = CASE WHEN excluded.code != '' THEN excluded.code ELSE game_event_runs.code END,
       title = CASE WHEN excluded.title != '' THEN excluded.title ELSE game_event_runs.title END,
       starts_at = excluded.starts_at, ends_at = excluded.ends_at, last_read = excluded.last_read`,
  ).run(
    clanId, e.type, e.run, e.occurrence, meta.code, meta.title,
    e.startsAt, e.endsAt === OPEN_ENDED ? null : e.endsAt, now, now,
  );
}

/** A run read again between scans: only its last-read time moves. */
export function touchEventRun(clanId: number, key: EventRunKey, now = new Date().toISOString()): void {
  getDb().prepare(
    'UPDATE game_event_runs SET last_read = ? WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?',
  ).run(now, clanId, key.eventType, key.run, key.occurrence);
}

export interface EventStandingsSaved {
  /** Players already in the run whose points moved. */
  moved: number;
  /** Players whose points moved since the run's previous read, a newcomer with points included; 0 = a flat read. */
  changed: number;
}

/**
 * The run's standings as read now. Upserts every player's latest points/rank;
 * a history row when the player is new to the run or the points moved.
 */
export function saveEventStandings(clanId: number, key: EventRunKey, rows: GameEventStanding[], now = new Date().toISOString()): EventStandingsSaved {
  const db = getDb();
  const prev = new Map(
    (db.prepare(
      `SELECT player_id, points FROM game_event_standings
        WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?`,
    ).all(clanId, key.eventType, key.run, key.occurrence) as Array<{ player_id: number; points: number }>)
      .map((r) => [r.player_id, r.points]),
  );
  const upsert = db.prepare(
    `INSERT INTO game_event_standings (clan_id, event_type, run, occurrence, player_id, points, rank, first_seen, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, event_type, run, occurrence, player_id) DO UPDATE SET
       points = excluded.points, rank = excluded.rank, updated_at = excluded.updated_at`,
  );
  const hist = db.prepare(
    `INSERT OR IGNORE INTO game_event_standing_history (clan_id, event_type, run, occurrence, player_id, points, rank, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let moved = 0;
  let changed = 0;
  db.transaction(() => {
    for (const r of rows) {
      upsert.run(clanId, key.eventType, key.run, key.occurrence, r.playerId, r.points, r.rank, now, now);
      const before = prev.get(r.playerId);
      if (before === undefined || before !== r.points) {
        hist.run(clanId, key.eventType, key.run, key.occurrence, r.playerId, r.points, r.rank, now);
        if (before !== undefined) moved++;
        if (r.points !== (before ?? 0)) changed++;
      }
    }
  })();
  return { moved, changed };
}

export interface EventRead {
  readAt: string;
  source: 'scan' | 'poll';
  members: number;
  totalPoints: number;
  changed: number;
  summonsLeft: number | null;
  summonsMax: number | null;
  summonsUsed: number | null;
  bossId: number | null;
}

/** One read of a run's standings (v123), scan or poll. */
export function saveEventRead(clanId: number, key: EventRunKey, read: EventRead): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO game_event_reads
       (clan_id, event_type, run, occurrence, read_at, source, members, total_points, changed,
        summons_left, summons_max, summons_used, boss_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    clanId, key.eventType, key.run, key.occurrence, read.readAt, read.source, read.members, read.totalPoints, read.changed,
    read.summonsLeft, read.summonsMax, read.summonsUsed, read.bossId,
  );
}

/** Every read of a run, oldest first. */
export function listEventReads(clanId: number, key: EventRunKey): EventRead[] {
  return (getDb().prepare(
    `SELECT read_at, source, members, total_points, changed, summons_left, summons_max, summons_used, boss_id
       FROM game_event_reads
      WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?
      ORDER BY read_at`,
  ).all(clanId, key.eventType, key.run, key.occurrence) as Array<{
    read_at: string; source: string; members: number; total_points: number; changed: number;
    summons_left: number | null; summons_max: number | null; summons_used: number | null; boss_id: number | null;
  }>).map((r) => ({
    readAt: r.read_at,
    source: r.source === 'poll' ? 'poll' : 'scan',
    members: r.members,
    totalPoints: r.total_points,
    changed: r.changed,
    summonsLeft: r.summons_left,
    summonsMax: r.summons_max,
    summonsUsed: r.summons_used,
    bossId: r.boss_id,
  }));
}

/** Every points change of a run, per player in time order — a player's points at a read are their newest row at or before it. */
export function listStandingHistory(clanId: number, key: EventRunKey): Map<number, Array<{ points: number; at: string }>> {
  const rows = getDb().prepare(
    `SELECT player_id, points, changed_at FROM game_event_standing_history
      WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?
      ORDER BY player_id, changed_at`,
  ).all(clanId, key.eventType, key.run, key.occurrence) as Array<{ player_id: number; points: number; changed_at: string }>;
  const out = new Map<number, Array<{ points: number; at: string }>>();
  for (const r of rows) {
    const list = out.get(r.player_id) ?? [];
    list.push({ points: r.points, at: r.changed_at });
    out.set(r.player_id, list);
  }
  return out;
}

/** The clan's run of an event type that is on now (started, not ended), newest first; null when none. */
export function liveEventRun(clanId: number, eventType: number, nowSec = Math.floor(Date.now() / 1000)): StoredEventRun | null {
  const r = getDb().prepare(
    `SELECT * FROM game_event_runs
      WHERE clan_id = ? AND event_type = ? AND COALESCE(starts_at, 0) <= ? AND (ends_at IS NULL OR ends_at > ?)
      ORDER BY COALESCE(starts_at, 0) DESC, last_read DESC LIMIT 1`,
  ).get(clanId, eventType, nowSec, nowSec) as Parameters<typeof rowToRun>[0] | undefined;
  return r ? rowToRun(r) : null;
}

/** Every run of one event type the clan has, newest first. */
export function listRunsOfType(clanId: number, eventType: number): StoredEventRun[] {
  return (getDb().prepare(
    `SELECT * FROM game_event_runs WHERE clan_id = ? AND event_type = ?
      ORDER BY COALESCE(starts_at, 0) DESC, last_read DESC`,
  ).all(clanId, eventType) as Parameters<typeof rowToRun>[0][]).map(rowToRun);
}

const rowToRun = (r: {
  event_type: number; run: number; occurrence: number; code: string; title: string;
  starts_at: number | null; ends_at: number | null; first_seen: string; last_read: string;
}): StoredEventRun => ({
  eventType: r.event_type, run: r.run, occurrence: r.occurrence, code: r.code, title: r.title,
  startsAt: r.starts_at, endsAt: r.ends_at, firstSeen: r.first_seen, lastRead: r.last_read,
});

/** Every run of the clan that has standings, newest first. */
export function listEventRuns(clanId: number): StoredEventRun[] {
  return (getDb().prepare(
    `SELECT r.* FROM game_event_runs r
      WHERE r.clan_id = ?
        AND EXISTS (SELECT 1 FROM game_event_standings s
                     WHERE s.clan_id = r.clan_id AND s.event_type = r.event_type AND s.run = r.run AND s.occurrence = r.occurrence)
      ORDER BY COALESCE(r.starts_at, 0) DESC, r.last_read DESC`,
  ).all(clanId) as Parameters<typeof rowToRun>[0][]).map(rowToRun);
}

/** The latest run per event (same code = same event; a code-less run groups by its type). */
export function latestEventRuns(clanId: number): StoredEventRun[] {
  const seen = new Set<string>();
  const out: StoredEventRun[] = [];
  for (const r of listEventRuns(clanId)) {
    const group = r.code || `type:${r.eventType}`;
    if (seen.has(group)) continue;
    seen.add(group);
    out.push(r);
  }
  return out;
}

export interface EventStandingRow {
  playerId: number;
  points: number;
  rank: number;
  /** Points at the read before the latest change; null for the run's first read (the baseline). */
  previousPoints: number | null;
  /** When the points last moved (null: never moved since the baseline). */
  changedAt: string | null;
  updatedAt: string;
}

/** A run's standings, best first, with each player's previous points. */
export function getEventStandings(clanId: number, key: EventRunKey): EventStandingRow[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT player_id, points, rank, updated_at FROM game_event_standings
      WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?
      ORDER BY rank, points DESC`,
  ).all(clanId, key.eventType, key.run, key.occurrence) as Array<{ player_id: number; points: number; rank: number; updated_at: string }>;
  // The two newest history rows per player: [latest, previous].
  const hist = db.prepare(
    `SELECT player_id, points, changed_at FROM game_event_standing_history
      WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?
      ORDER BY player_id, changed_at DESC`,
  ).all(clanId, key.eventType, key.run, key.occurrence) as Array<{ player_id: number; points: number; changed_at: string }>;
  const latestTwo = new Map<number, Array<{ points: number; changedAt: string }>>();
  for (const h of hist) {
    const list = latestTwo.get(h.player_id) ?? [];
    if (list.length < 2) list.push({ points: h.points, changedAt: h.changed_at });
    latestTwo.set(h.player_id, list);
  }
  return rows.map((r) => {
    const h = latestTwo.get(r.player_id) ?? [];
    const previous = h.length >= 2 ? h[1] : null;
    return {
      playerId: r.player_id,
      points: r.points,
      rank: r.rank,
      previousPoints: previous ? previous.points : null,
      changedAt: previous ? h[0].changedAt : null,
      updatedAt: r.updated_at,
    };
  });
}

/** One run's stored row, or null. */
export function getEventRun(clanId: number, key: EventRunKey): StoredEventRun | null {
  const r = getDb().prepare(
    'SELECT * FROM game_event_runs WHERE clan_id = ? AND event_type = ? AND run = ? AND occurrence = ?',
  ).get(clanId, key.eventType, key.run, key.occurrence) as Parameters<typeof rowToRun>[0] | undefined;
  return r ? rowToRun(r) : null;
}
