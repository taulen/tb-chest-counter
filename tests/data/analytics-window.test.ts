import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { getChestBreakdowns } from '../../src/data/repositories/chest-repo.js';
import {
  getConcentration,
  getMemberDailySeries,
  getTopContributors,
  getWindowContributors,
  getWindowDailySeries,
  getWindowTotals,
  notifyChestDataChanged,
} from '../../src/data/repositories/chest-summary-repo.js';
import { gameDateFor } from '../../src/utils/game-day.js';
import { makeTestDb } from '../helpers/test-db.js';

// The rollover the app defaults to; the rollup buckets on it and these tests
// place rows either side of it deliberately.
const ROLLOVER = 17;
const DAY = 86_400_000;

let cleanup: () => void;

// A fixed instant well clear of "now" so nothing here depends on the clock.
// 12:00 UTC is BEFORE the 17:00 rollover, so it lands on the PREVIOUS game
// day — which is exactly the case a naive ISO-slice would get wrong.
const BASE = Date.UTC(2026, 5, 10, 12, 0, 0);

interface SeedRow {
  member: number; chest: string; type: string; source: string; pts: number; at: number;
}

function seed(rows: SeedRow[]): void {
  const db = getDb();
  const nowIso = new Date(BASE).toISOString();
  const session = db.prepare(
    `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
     VALUES (1, ?, ?, 'completed', 'manual') RETURNING id`,
  ).get(nowIso, nowIso) as { id: number };

  const chestId = (name: string, type: string): number => (db.prepare(
    `INSERT INTO chests (name, chest_type) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET chest_type = excluded.chest_type RETURNING id`,
  ).get(name, type) as { id: number }).id;

  const sourceId = (s: string): number => (db.prepare(
    `INSERT INTO chest_sources (source) VALUES (?)
     ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
  ).get(s) as { id: number }).id;

  const memberId = (n: number): number => {
    const existing = db.prepare('SELECT id FROM members WHERE clan_id = 1 AND name = ?')
      .get(`M${n}`) as { id: number } | undefined;
    if (existing) return existing.id;
    return (db.prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (1, ?, ?, ?, ?, 1) RETURNING id`,
    ).get(`M${n}`, `m${n}`, nowIso, nowIso) as { id: number }).id;
  };

  const ins = db.prepare(
    `INSERT INTO chest_records
       (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, confidence)
     VALUES (1, ?, ?, ?, ?, ?, ?, 90)`,
  );
  for (const r of rows) {
    ins.run(session.id, memberId(r.member), chestId(r.chest, r.type), sourceId(r.source), r.pts, r.at);
  }
  notifyChestDataChanged(1);
}

interface TypeRow { chest_type: string; count: number; points: number }

// The byType query getChestBreakdowns used to run. Kept here as the oracle so
// the derived-from-byName version can never quietly drift from what it
// replaced — the reason it was replaced is a query plan, not a result.
function byTypeViaSql(fromMs?: number, toMs?: number): TypeRow[] {
  const windowed = fromMs !== undefined && toMs !== undefined;
  const range = windowed ? ' AND cr.effective_at >= ? AND cr.effective_at < ?' : '';
  const params: unknown[] = windowed ? [1, fromMs, toMs] : [1];
  return getDb().prepare(`
    SELECT ch.chest_type AS chest_type, COUNT(*) AS count, SUM(cr.point_value) AS points
    FROM chest_records cr JOIN chests ch ON ch.id = cr.chest_id
    WHERE cr.clan_id = ?${range}
    GROUP BY ch.chest_type ORDER BY count DESC
  `).all(...params) as TypeRow[];
}

const byRarity = (rows: TypeRow[]): TypeRow[] =>
  [...rows].sort((x, y) => x.chest_type.localeCompare(y.chest_type));

beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

describe('getChestBreakdowns: byType is derived, and equals the query it replaced', () => {
  beforeEach(() => {
    // Two chest NAMES share a rarity, so folding byName up is a real
    // reduction rather than a relabelling.
    seed([
      { member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 10, at: BASE },
      { member: 1, chest: 'Wooden Chest', type: 'common', source: 'Crypt', pts: 5, at: BASE + 1000 },
      { member: 2, chest: 'Epic Chest', type: 'epic', source: 'Raid', pts: 90, at: BASE + 2000 },
      { member: 2, chest: 'Epic Chest', type: 'epic', source: 'Arena', pts: 90, at: BASE - DAY },
    ]);
  });

  it('matches the SQL oracle over all time', () => {
    const derived = getChestBreakdowns(1).byType;
    expect(byRarity(derived)).toEqual(byRarity(byTypeViaSql()));
    expect(derived.find((t) => t.chest_type === 'common')).toEqual({
      chest_type: 'common', count: 2, points: 15,
    });
  });

  it('matches the SQL oracle over a window', () => {
    const from = BASE - 60_000;
    const to = BASE + 60_000;
    const derived = getChestBreakdowns(1, from, to).byType;
    expect(byRarity(derived)).toEqual(byRarity(byTypeViaSql(from, to)));
    expect(derived.find((t) => t.chest_type === 'epic')?.count).toBe(1);
  });

  it('byType totals always reconcile with byName totals', () => {
    const b = getChestBreakdowns(1);
    const sum = (rows: Array<{ count: number; points: number }>) =>
      rows.reduce((a, r) => ({ count: a.count + r.count, points: a.points + r.points }),
        { count: 0, points: 0 });
    expect(sum(b.byType)).toEqual(sum(b.byName));
  });
});

describe('breakdown windows are half-open', () => {
  it('includes a chest at the start instant and excludes one at the end instant', () => {
    const from = BASE;
    const to = BASE + DAY;
    seed([
      { member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 10, at: from },
      { member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 10, at: to - 1 },
      { member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 10, at: to },
    ]);
    expect(getChestBreakdowns(1, from, to).byName[0].count).toBe(2);
    // The boundary row belongs to the NEXT window, and to only one of them.
    expect(getChestBreakdowns(1, to, to + DAY).byName[0].count).toBe(1);
  });
});

describe('rollup window aggregates', () => {
  const dayOf = (ms: number): string => gameDateFor(ms, ROLLOVER);

  beforeEach(() => {
    seed([
      { member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 10, at: BASE - DAY },
      { member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 20, at: BASE },
      { member: 2, chest: 'Epic Chest', type: 'epic', source: 'Raid', pts: 70, at: BASE },
      { member: 3, chest: 'Epic Chest', type: 'epic', source: 'Raid', pts: 90, at: BASE + 3 * DAY },
    ]);
  });

  it('totals cover only the requested game days', () => {
    const d = dayOf(BASE);
    const t = getWindowTotals(1, d, d);
    expect(t.chests).toBe(2);
    expect(t.points).toBe(90);
    expect(t.activeMembers).toBe(2);
  });

  it('all-time totals include every day', () => {
    const t = getWindowTotals(1);
    expect(t.chests).toBe(4);
    expect(t.activeMembers).toBe(3);
  });

  it('the daily series omits days with no activity rather than zero-filling', () => {
    const days = getWindowDailySeries(1, dayOf(BASE - DAY), dayOf(BASE + 3 * DAY));
    expect(days.map((r) => r.day)).toEqual([dayOf(BASE - DAY), dayOf(BASE), dayOf(BASE + 3 * DAY)]);
    expect(days.every((r) => r.chests > 0)).toBe(true);
  });

  it('top contributors respect the window and drop zero-scorers', () => {
    const d = dayOf(BASE);
    const { topPoints } = getTopContributors(1, 10, d, d);
    expect(topPoints.map((r) => r.name)).toEqual(['M2', 'M1']);
    expect(topPoints[0].points).toBe(70);
    // M3 only earned outside the window, so it is absent rather than a 0 row.
    expect(topPoints.some((r) => r.name === 'M3')).toBe(false);
  });
});

describe('getWindowContributors: one ranked list carrying both figures', () => {
  const dayOf = (ms: number): string => gameDateFor(ms, ROLLOVER);

  beforeEach(() => {
    // M1 leads on CHESTS, M2 leads on POINTS. Two separate top-N lists would
    // rank these members differently and neither would carry the other figure;
    // one list has to pick an order and still report both.
    seed([
      { member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 10, at: BASE },
      { member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 10, at: BASE + 1 },
      { member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 10, at: BASE + 2 },
      { member: 2, chest: 'Epic Chest', type: 'epic', source: 'Raid', pts: 90, at: BASE + 3 },
      { member: 3, chest: 'Epic Chest', type: 'epic', source: 'Raid', pts: 70, at: BASE + 4 * DAY },
    ]);
  });

  it('ranks by points and still reports each member chest count', () => {
    const d = dayOf(BASE);
    const rows = getWindowContributors(1, 10, d, d);
    expect(rows.map((r) => r.name)).toEqual(['M2', 'M1']);
    expect(rows[0]).toMatchObject({ name: 'M2', chests: 1, points: 90 });
    // The member who leads on chests is still on the list, with both numbers.
    expect(rows[1]).toMatchObject({ name: 'M1', chests: 3, points: 30 });
  });

  it('honours the window', () => {
    const d = dayOf(BASE);
    expect(getWindowContributors(1, 10, d, d).some((r) => r.name === 'M3')).toBe(false);
    expect(getWindowContributors(1, 10).some((r) => r.name === 'M3')).toBe(true);
  });

  it('respects the limit', () => {
    expect(getWindowContributors(1, 1).length).toBe(1);
  });
});

describe('getConcentration', () => {
  const dayOf = (ms: number): string => gameDateFor(ms, ROLLOVER);

  it('reports how few members carry the clan', () => {
    // One member with 900, nine with 100 each: the top five hold 900+400 of
    // 1800, and the single leader alone is half the clan.
    seed([{ member: 1, chest: 'Epic Chest', type: 'epic', source: 'Raid', pts: 900, at: BASE }]);
    for (let m = 2; m <= 10; m += 1) {
      seed([{ member: m, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 100, at: BASE + m }]);
    }
    const d = dayOf(BASE);
    const c = getConcentration(1, d, d);
    expect(c.totalPoints).toBe(1800);
    expect(c.contributors).toBe(10);
    expect(Math.round(c.topFiveShare! * 100)).toBe(72);
    expect(c.membersForHalf).toBe(1);
  });

  it('withholds the share when there are too few contributors to mean anything', () => {
    // With five or fewer members, "the top five" is everyone and the number is
    // arithmetic rather than information.
    seed([
      { member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 10, at: BASE },
      { member: 2, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 10, at: BASE + 1 },
    ]);
    const d = dayOf(BASE);
    expect(getConcentration(1, d, d).topFiveShare).toBeNull();
  });

  it('excludes end-of-event clan rewards, which would fake total dependency', () => {
    // A placement drop credited to one account must not read as one member
    // producing everything. Seeded as a normal chest here purely to show the
    // function reads the earned_* columns; the exclusion itself is v70's.
    seed([{ member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 50, at: BASE }]);
    const d = dayOf(BASE);
    expect(getConcentration(1, d, d).totalPoints).toBe(50);
  });
});

describe('consistency figures ride along on the contributor query', () => {
  const dayOf = (ms: number): string => gameDateFor(ms, ROLLOVER);

  it('separates five steady days from one enormous one', () => {
    // Same total, opposite habits. This is the distinction a points column
    // cannot make and the whole reason these two columns exist.
    for (let d = 0; d < 5; d += 1) {
      seed([{ member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 100, at: BASE + d * DAY }]);
    }
    seed([{ member: 2, chest: 'Epic Chest', type: 'epic', source: 'Raid', pts: 500, at: BASE }]);

    const rows = getWindowContributors(1, 10, dayOf(BASE), dayOf(BASE + 5 * DAY));
    const steady = rows.find((r) => r.name === 'M1')!;
    const spike = rows.find((r) => r.name === 'M2')!;

    expect(steady.points).toBe(spike.points);
    expect(steady.activeDays).toBe(5);
    expect(spike.activeDays).toBe(1);
    expect(steady.bestDayPoints).toBe(100);
    expect(spike.bestDayPoints).toBe(500);
  });
});

describe('getMemberDailySeries', () => {
  const dayOf = (ms: number): string => gameDateFor(ms, ROLLOVER);

  it('returns only the days the member actually earned on', () => {
    seed([
      { member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 10, at: BASE },
      { member: 1, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 20, at: BASE + 2 * DAY },
      { member: 2, chest: 'Common Chest', type: 'common', source: 'Crypt', pts: 99, at: BASE + DAY },
    ]);
    const id = (getDb().prepare("SELECT id FROM members WHERE name = 'M1'").get() as { id: number }).id;
    const rows = getMemberDailySeries(1, id, dayOf(BASE), dayOf(BASE + 3 * DAY));
    // The quiet day in the middle is ABSENT, not zero — the caller expands it.
    expect(rows.map((r) => r.day)).toEqual([dayOf(BASE), dayOf(BASE + 2 * DAY)]);
    // And another member's day never leaks in.
    expect(rows.every((r) => r.points !== 99)).toBe(true);
  });
});
