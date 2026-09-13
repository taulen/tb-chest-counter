/**
 * Two properties that every timeframe on this site quietly depends on.
 *
 * 1. Analytical windows are HALF-OPEN, [from, to). computeGameWindow produces
 *    adjacent slots that share an instant — this week's `from` IS last week's
 *    `to` — so an inclusive upper bound counts a chest landing exactly on a
 *    rollover in BOTH weeks. Every per-period total is then one chest heavy on
 *    one side and the two never reconcile.
 *
 * 2. The server's game week is the same week the client draws. The member
 *    page's "this week vs last week" box used `now - 7 days`, a rolling 168
 *    hours that snaps to nothing, so a member comparing their profile against
 *    their own leaderboard row was comparing two different windows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import {
  getLeaderboard,
  getMemberAggregateInRange,
  getMemberStats,
} from '../../src/data/repositories/chest-repo.js';
import { notifyChestDataChanged } from '../../src/data/repositories/chest-summary-repo.js';
import { gameWeekWindow } from '../../src/utils/game-day.js';
import { makeTestDb } from '../helpers/test-db.js';

const ROLLOVER = 17;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

function seedChestAt(atMs: number, points = 10): number {
  const db = getDb();
  const iso = new Date(atMs).toISOString();
  const session = db.prepare(
    `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
     VALUES (1, ?, ?, 'completed', 'manual') RETURNING id`,
  ).get(iso, iso) as { id: number };
  const chest = db.prepare(
    `INSERT INTO chests (name, chest_type) VALUES ('Boundary Chest', 'rare')
     ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
  ).get() as { id: number };
  const source = db.prepare(
    `INSERT INTO chest_sources (source) VALUES ('Crypt')
     ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
  ).get() as { id: number };
  const existing = db.prepare("SELECT id FROM members WHERE clan_id = 1 AND name = 'Edge'")
    .get() as { id: number } | undefined;
  const member = existing ?? (db.prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (1, 'Edge', 'edge', ?, ?, 1) RETURNING id`,
  ).get(iso, iso) as { id: number });
  db.prepare(
    `INSERT INTO chest_records
       (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
     VALUES (1, ?, ?, ?, ?, ?, ?, 90)`,
  ).run(session.id, member.id, chest.id, source.id, points, atMs);
  notifyChestDataChanged(1);
  return member.id;
}

describe('gameWeekWindow: the server draws the same week as the client', () => {
  it('produces a window exactly seven days long', () => {
    const w = gameWeekWindow(0, ROLLOVER);
    expect(Date.parse(w.to) - Date.parse(w.from)).toBe(WEEK);
  });

  it('abuts the previous week exactly, with no gap and no overlap', () => {
    const cur = gameWeekWindow(0, ROLLOVER);
    const prev = gameWeekWindow(1, ROLLOVER);
    expect(prev.to).toBe(cur.from);
  });

  it('starts on a Sunday at the rollover hour', () => {
    const start = new Date(gameWeekWindow(0, ROLLOVER).from);
    expect(start.getUTCHours()).toBe(ROLLOVER);
    expect(start.getUTCMinutes()).toBe(0);
    expect(start.getUTCDay()).toBe(0); // Sunday
  });

  it('contains "now" in the current slot', () => {
    const w = gameWeekWindow(0, ROLLOVER);
    const now = Date.now();
    expect(Date.parse(w.from)).toBeLessThanOrEqual(now);
    expect(Date.parse(w.to)).toBeGreaterThan(now);
  });

  it('honours a different rollover hour', () => {
    const start = new Date(gameWeekWindow(0, 0).from);
    expect(start.getUTCHours()).toBe(0);
  });
});

describe('analytical windows are half-open, so adjacent periods cannot double-count', () => {
  // A chest sitting exactly on a boundary is the whole point: it is the only
  // value that an inclusive upper bound puts in two windows at once.
  const boundary = Date.UTC(2026, 5, 14, ROLLOVER, 0, 0);
  const before = { from: new Date(boundary - WEEK).toISOString(), to: new Date(boundary).toISOString() };
  const after = { from: new Date(boundary).toISOString(), to: new Date(boundary + WEEK).toISOString() };

  beforeEach(() => { seedChestAt(boundary, 42); });

  it('getLeaderboard counts it in the later window only', () => {
    const earlier = getLeaderboard(1, before.from, before.to);
    const later = getLeaderboard(1, after.from, after.to);
    expect(earlier.reduce((s, r) => s + r.totalChests, 0)).toBe(0);
    expect(later.reduce((s, r) => s + r.totalChests, 0)).toBe(1);
  });

  it('getMemberStats counts it in the later window only', () => {
    const memberId = (getDb().prepare("SELECT id FROM members WHERE name = 'Edge'")
      .get() as { id: number }).id;
    expect(getMemberStats(memberId, 1, before.from, before.to)?.totalChests ?? 0).toBe(0);
    expect(getMemberStats(memberId, 1, after.from, after.to)?.totalChests ?? 0).toBe(1);
  });

  it('agrees with getMemberAggregateInRange, which was already half-open', () => {
    const memberId = (getDb().prepare("SELECT id FROM members WHERE name = 'Edge'")
      .get() as { id: number }).id;
    // This one never had the bug; the point is that everything else now matches
    // it rather than it being the odd one out.
    expect(getMemberAggregateInRange(memberId, 1, before.from, before.to).chests).toBe(0);
    expect(getMemberAggregateInRange(memberId, 1, after.from, after.to).chests).toBe(1);
  });

  it('a chest one millisecond before the boundary lands in the earlier window', () => {
    seedChestAt(boundary - 1, 7);
    expect(getLeaderboard(1, before.from, before.to).reduce((s, r) => s + r.totalChests, 0)).toBe(1);
  });
});
