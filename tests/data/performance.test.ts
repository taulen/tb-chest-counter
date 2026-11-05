import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The event calendar reads a live feed; no event runs here keeps the test
// offline and leaves the events signal out of the scores below.
vi.mock('../../src/external/event-calendar.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/external/event-calendar.js')>()),
  getEventOccurrences: vi.fn(async () => []),
}));

import { getDb } from '../../src/data/database.js';
import { getPerformanceReport } from '../../src/data/performance.js';
import { addMergeRule } from '../../src/data/repositories/merge-repo.js';
import { makeTestDb } from '../helpers/test-db.js';

const CLAN = 1;
const ROLLOVER = 17;
// Thursday 2026-11-05, after the rollover: today's game day is the 5th. The
// clan's Sunday weeks that closed in the last 30 days are Oct 4–10, 11–17,
// 18–24 and 25–31.
const NOW = Date.parse('2026-11-05T18:00:00Z');
const WEEK_MONDAYS = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];

let cleanup: () => void;
let sessionId: number;
let chestId: number;

function member(name: string, firstSeen: string): number {
  return (getDb().prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (?, ?, ?, ?, ?, 1) RETURNING id`,
  ).get(CLAN, name, name.toLowerCase(), firstSeen, firstSeen) as { id: number }).id;
}

let tick = 0;
function chest(memberId: number, day: string, points: number): void {
  // 18:00 UTC is after the rollover, so the chest lands on `day`'s game day.
  getDb().prepare(
    `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at, confidence)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(CLAN, sessionId, memberId, chestId, points, Date.parse(`${day}T18:00:00Z`) + tick++);
}

function report(timeframe = 'month') {
  return getPerformanceReport({
    clanId: CLAN, timeframe, weeklyGoal: 12_000, weekStart: 'sunday', rolloverUtcHour: ROLLOVER, nowMs: NOW,
  });
}

beforeEach(() => {
  cleanup = makeTestDb().cleanup;
  const db = getDb();
  sessionId = (db.prepare(
    `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
     VALUES (?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 'completed', 'manual') RETURNING id`,
  ).get(CLAN) as { id: number }).id;
  chestId = (db.prepare(
    `INSERT INTO chests (name, chest_type) VALUES ('Common Chest', 'common') RETURNING id`,
  ).get() as { id: number }).id;
});

afterEach(() => cleanup());

describe('performance report', () => {
  it('scores closed weeks against the goal and names the over- and underachievers', async () => {
    const steady = member('Steady', '2026-09-01T18:00:00Z');
    const slacker = member('Slacker', '2026-09-01T18:00:00Z');
    chest(steady, '2026-09-02', 100); // the clan's data starts here
    for (const day of WEEK_MONDAYS) {
      chest(steady, day, 30_000);
      chest(slacker, day, 2_000);
    }

    const r = await report();
    expect(r.windowFrom).toBe('2026-10-06');
    expect(r.units.weeks).toBe(4);
    const s = r.members.find((m) => m.memberId === steady)!;
    expect(s.signals.goalHits).toMatchObject({ units: 4, hits: 4, value: 1 });
    expect(s.signals.goalPoints.value).toBe(2); // 250%, capped
    expect(s.score).toBeCloseTo((0.3 * 1 + 0.2 * 2) / 0.5);
    expect(s.status).toBe('over');
    const l = r.members.find((m) => m.memberId === slacker)!;
    expect(l.signals.goalHits.hits).toBe(0);
    expect(l.status).toBe('under');
  });

  it('dates tenure from the earliest evidence, so a renamed player keeps their history', async () => {
    member('Anchor', '2026-09-01T18:00:00Z');
    // The surviving row of a rename: first_seen is the NEW nick's day, but the
    // merge repointed the old nick's chests, which go back to September.
    const renamed = member('Renamed', '2026-10-28T18:00:00Z');
    chest(renamed, '2026-09-02', 12_000);
    for (const day of WEEK_MONDAYS) chest(renamed, day, 12_000);
    const newbie = member('Newbie', '2026-10-30T18:00:00Z');
    chest(newbie, '2026-11-02', 50_000);

    const r = await report();
    const row = r.members.find((m) => m.memberId === renamed);
    expect(row?.tenureStart).toBe('2026-09-02');
    expect(row?.signals.goalHits).toMatchObject({ units: 4, hits: 4 });
    expect(r.tooNew.map((m) => m.memberId)).toContain(newbie);
    expect(r.members.some((m) => m.memberId === newbie)).toBe(false);
  });

  it('never holds a member to a week they joined part-way through', async () => {
    const early = member('Early', '2026-09-01T18:00:00Z');
    chest(early, '2026-09-02', 1);
    // Joined on the Wednesday of the Oct 11–17 week: only the last two weeks count.
    const midweek = member('Midweek', '2026-10-14T18:00:00Z');
    for (const day of WEEK_MONDAYS.slice(2)) chest(midweek, day, 12_000);

    const r = await report('all');
    const row = r.members.find((m) => m.memberId === midweek)!;
    expect(row.signals.goalHits).toMatchObject({ units: 2, hits: 2 });
  });

  it('measures finished Tin Man runs against the target for the guards tier', async () => {
    const steady = member('Steady', '2026-09-01T18:00:00Z');
    const slacker = member('Slacker', '2026-09-01T18:00:00Z');
    const absent = member('Absent', '2026-09-01T18:00:00Z');
    chest(steady, '2026-09-02', 1);
    const db = getDb();
    const upload = (db.prepare(
      `INSERT INTO tinman_uploads (clan_id, event_key, tinman_date, summon, uploaded_by, uploaded_at)
       VALUES (?, 'ancients', '2026-10-29', 1, 'admin', '2026-10-29T20:00:00Z') RETURNING id`,
    ).get(CLAN) as { id: number }).id;
    const score = db.prepare(
      `INSERT INTO tinman_scores (upload_id, clan_id, rank, raw_name, member_id, match_kind, points)
       VALUES (?, ?, ?, ?, ?, 'exact', ?)`,
    );
    score.run(upload, CLAN, 1, 'Steady', steady, 5_000);
    score.run(upload, CLAN, 2, 'Slacker', slacker, 100);
    // Nobody's guards level is known, so everyone is held to the G7 target.
    db.prepare(
      `INSERT INTO tinman_targets (clan_id, tinman_date, tiers, saved_by, saved_at)
       VALUES (?, '2026-10-29', '{"g7":4000,"g8":8000}', 'admin', '2026-10-29T20:00:00Z')`,
    ).run(CLAN);

    const r = await report();
    expect(r.units).toMatchObject({ tinmanRuns: 1, tinmanRunsWithTargets: 1 });
    const by = (id: number) => r.members.find((m) => m.memberId === id)!.signals.tinman;
    expect(by(steady)).toMatchObject({ units: 1, hits: 1, value: 1.25 });
    expect(by(slacker).value).toBeCloseTo(0.025);
    expect(by(absent)).toMatchObject({ units: 1, hits: 0, value: 0 });
  });
});

describe('player merge', () => {
  it('keeps the earlier first_seen of the two rows', () => {
    const oldNick = member('OldNick', '2026-05-01T10:00:00Z');
    const newNick = member('NewNick', '2026-10-28T10:00:00Z');
    addMergeRule('player', 'OldNick', 'NewNick', CLAN);
    const db = getDb();
    expect(db.prepare('SELECT id FROM members WHERE id = ?').get(oldNick)).toBeUndefined();
    expect((db.prepare('SELECT first_seen AS f FROM members WHERE id = ?').get(newNick) as { f: string }).f)
      .toBe('2026-05-01T10:00:00Z');
  });
});
