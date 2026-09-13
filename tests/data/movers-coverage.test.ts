/**
 * The two primitives behind the Movers card.
 *
 * Both exist to stop a watchlist crying wolf. getMemberWindowComparison has to
 * include people the leaderboard deliberately hides (a member swept for
 * inactivity is the single largest drop on any board, and getLeaderboard filters
 * them out) and has to carry enough context to exclude people whose "drop" is an
 * artefact (someone who joined mid-window has an empty previous window because
 * they weren't there). getScanCoverage answers the question that invalidates the
 * whole card: was the scanner actually watching?
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { getMemberWindowComparison, notifyChestDataChanged } from '../../src/data/repositories/chest-summary-repo.js';
import { getScanCoverage } from '../../src/data/repositories/session-repo.js';
import { getActivityClock } from '../../src/data/repositories/chest-repo.js';
import { gameDateFor } from '../../src/utils/game-day.js';
import { makeTestDb } from '../helpers/test-db.js';

const ROLLOVER = 17;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 5, 10, 12, 0, 0);
const dayOf = (ms: number): string => gameDateFor(ms, ROLLOVER);

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

function member(name: string, firstSeenMs: number, active = 1): number {
  const iso = new Date(firstSeenMs).toISOString();
  return (getDb().prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (1, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(name, name.toLowerCase(), iso, iso, active) as { id: number }).id;
}

function chest(memberId: number, atMs: number, points: number): void {
  const db = getDb();
  const iso = new Date(atMs).toISOString();
  const session = db.prepare(
    `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
     VALUES (1, ?, ?, 'completed', 'manual') RETURNING id`,
  ).get(iso, iso) as { id: number };
  const c = db.prepare(
    `INSERT INTO chests (name, chest_type) VALUES ('C', 'rare')
     ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
  ).get() as { id: number };
  const src = db.prepare(
    `INSERT INTO chest_sources (source) VALUES ('Crypt')
     ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
  ).get() as { id: number };
  db.prepare(
    `INSERT INTO chest_records
       (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
     VALUES (1, ?, ?, ?, ?, ?, ?, 90)`,
  ).run(session.id, memberId, c.id, src.id, points, atMs);
  notifyChestDataChanged(1);
}

describe('getMemberWindowComparison', () => {
  // Previous window is the day before BASE; current is BASE's day.
  const prevDay = dayOf(BASE - DAY);
  const curDay = dayOf(BASE);
  const compare = () => getMemberWindowComparison(1, prevDay, prevDay, curDay, curDay);

  it('puts both windows on one row', () => {
    const id = member('Steady', BASE - 90 * DAY);
    chest(id, BASE - DAY, 100);
    chest(id, BASE, 40);
    const [row] = compare();
    expect(row).toMatchObject({ name: 'Steady', points: 40, prevPoints: 100, chests: 1, prevChests: 1 });
  });

  it('includes a member who contributed ONLY in the previous window', () => {
    // The whole point: this member is invisible to any top-N of the current
    // window, and they are the drop a leader most wants to see.
    const id = member('Vanished', BASE - 90 * DAY);
    chest(id, BASE - DAY, 500);
    const [row] = compare();
    expect(row).toMatchObject({ name: 'Vanished', points: 0, prevPoints: 500 });
  });

  it('includes a member the inactivity sweep has already removed', () => {
    // getLeaderboard filters is_active = 1 even with includeAllMembers, so this
    // member would be absent from both windows there.
    const id = member('Swept', BASE - 90 * DAY, 0);
    chest(id, BASE - DAY, 300);
    const [row] = compare();
    expect(row).toMatchObject({ name: 'Swept', prevPoints: 300, isActive: 0 });
  });

  it('reports first_seen so a mid-window joiner can be excluded', () => {
    const joined = member('Newbie', BASE - 1000);
    chest(joined, BASE, 10);
    const row = compare().find((r) => r.name === 'Newbie');
    expect(Date.parse(row!.firstSeen)).toBeGreaterThan(BASE - DAY);
  });

  it('leaves out members who did nothing in either window', () => {
    member('Ghost', BASE - 90 * DAY);
    const active = member('Active', BASE - 90 * DAY);
    chest(active, BASE, 10);
    expect(compare().some((r) => r.name === 'Ghost')).toBe(false);
  });
});

describe('getScanCoverage', () => {
  function scan(atMs: number, opts: { status?: string; chests?: number } = {}): void {
    const iso = new Date(atMs).toISOString();
    getDb().prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, chests_found, trigger_source)
       VALUES (1, ?, ?, ?, ?, 'scheduled')`,
    ).run(iso, iso, opts.status ?? 'completed', opts.chests ?? 5);
  }

  const from = new Date(BASE - 5 * DAY).toISOString();
  const to = new Date(BASE).toISOString();

  it('reports no gap when scans are closer together than a gift lives', () => {
    for (let t = BASE - 5 * DAY; t <= BASE; t += 2 * HOUR) scan(t);
    const c = getScanCoverage(1, from, to);
    expect(c.gaps).toEqual([]);
    expect(c.worstGapHours).toBe(0);
  });

  it('does not flag a gap shorter than the 20h gift lifetime', () => {
    // Six missed two-hour scans in a row lose nothing: the gifts are still on
    // the tab when the next scan arrives.
    for (let t = BASE - 5 * DAY; t <= BASE; t += 2 * HOUR) {
      if (t > BASE - 3 * DAY && t < BASE - 3 * DAY + 12 * HOUR) continue;
      scan(t);
    }
    expect(getScanCoverage(1, from, to).gaps).toEqual([]);
  });

  it('flags a gap longer than the gift lifetime', () => {
    for (let t = BASE - 5 * DAY; t <= BASE; t += 2 * HOUR) {
      if (t > BASE - 3 * DAY && t < BASE - 3 * DAY + 25 * HOUR) continue;
      scan(t);
    }
    const c = getScanCoverage(1, from, to);
    expect(c.gaps.length).toBe(1);
    expect(c.worstGapHours).toBeGreaterThan(20);
  });

  it('counts a FAILED session that still stored chests as coverage', () => {
    // status is the wrong predicate in both directions; what matters is
    // whether the scan read the Gifts tab.
    for (let t = BASE - 5 * DAY; t <= BASE; t += 2 * HOUR) {
      scan(t, t === BASE - 3 * DAY ? { status: 'failed', chests: 12 } : {});
    }
    expect(getScanCoverage(1, from, to).gaps).toEqual([]);
  });

  it('ignores a failed session that stored nothing', () => {
    for (let t = BASE - 5 * DAY; t <= BASE; t += 2 * HOUR) {
      if (t > BASE - 3 * DAY && t < BASE - 3 * DAY + 25 * HOUR) {
        scan(t, { status: 'failed', chests: 0 });
        continue;
      }
      scan(t);
    }
    expect(getScanCoverage(1, from, to).gaps.length).toBe(1);
  });

  it('treats a window with no scans at all as one long gap', () => {
    const c = getScanCoverage(1, from, to);
    expect(c.scans).toBe(0);
    expect(c.gaps.length).toBe(1);
  });
});

describe('getActivityClock', () => {
  /** Insert a chest with an explicit earn time (or none, to force the fallback). */
  function timedChest(atMs: number, earnedAtMs: number | null): void {
    const db = getDb();
    const iso = new Date(atMs).toISOString();
    const session = db.prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
       VALUES (1, ?, ?, 'completed', 'manual') RETURNING id`,
    ).get(iso, iso) as { id: number };
    const c = db.prepare(
      `INSERT INTO chests (name, chest_type) VALUES ('C', 'rare')
       ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
    ).get() as { id: number };
    const src = db.prepare(
      `INSERT INTO chest_sources (source) VALUES ('Crypt')
       ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
    ).get() as { id: number };
    const m = getDb().prepare("SELECT id FROM members WHERE clan_id = 1 AND name = 'Clocked'")
      .get() as { id: number } | undefined
      ?? { id: member('Clocked', BASE - 90 * DAY) };
    db.prepare(
      `INSERT INTO chest_records
         (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence, earned_at)
       VALUES (1, ?, ?, ?, ?, 10, ?, 90, ?)`,
    ).run(session.id, m.id, c.id, src.id, atMs, earnedAtMs);
  }

  it('places a chest in the weekday and hour it was earned', () => {
    // 2026-06-10 is a Wednesday (weekday 3).
    const earned = Date.UTC(2026, 5, 10, 9, 30, 0);
    timedChest(earned + 3 * HOUR, earned);
    const clock = getActivityClock(1);
    expect(clock.grid[3][9]).toBe(1);
    expect(clock.timed).toBe(1);
  });

  it('EXCLUDES fallback rows where earned_at equals captured_at', () => {
    // This is the whole predicate. Rows whose countdown could not be read
    // store the scan clock in earned_at; counting them draws the scanner
    // schedule as if it were player behaviour.
    const at = Date.UTC(2026, 5, 10, 9, 0, 0);
    timedChest(at, at);
    const clock = getActivityClock(1);
    expect(clock.timed).toBe(0);
    expect(clock.total).toBe(1);
  });

  it('excludes rows with no earn time at all', () => {
    timedChest(Date.UTC(2026, 5, 10, 9, 0, 0), null);
    const clock = getActivityClock(1);
    expect(clock.timed).toBe(0);
    expect(clock.total).toBe(1);
  });

  it('reports total alongside timed so coverage can be stated honestly', () => {
    const earned = Date.UTC(2026, 5, 10, 9, 0, 0);
    timedChest(earned + 3 * HOUR, earned);
    timedChest(earned + 4 * HOUR, null);
    const clock = getActivityClock(1);
    expect(clock.timed).toBe(1);
    expect(clock.total).toBe(2);
  });

  it('honours the window', () => {
    const earned = Date.UTC(2026, 5, 10, 9, 0, 0);
    timedChest(earned + 3 * HOUR, earned);
    const outside = getActivityClock(1, earned - 10 * DAY, earned - 9 * DAY);
    expect(outside.timed).toBe(0);
  });

  it('always returns a full 7x24 grid', () => {
    const clock = getActivityClock(1);
    expect(clock.grid.length).toBe(7);
    expect(clock.grid.every((row) => row.length === 24)).toBe(true);
  });
});
