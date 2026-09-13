import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { getSingleDayRecords, notifyChestDataChanged } from '../../src/data/repositories/chest-summary-repo.js';
import { makeTestDb, seedManyChests } from '../helpers/test-db.js';

// Query-plan regression guard. Seeds a production-shaped volume of rows and
// asserts the hot aggregates still resolve through their covering indexes
// rather than degrading to a full table scan as the dataset grows. On a few
// rows SQLite may pick a scan regardless of indexes, so we seed ~18k rows and
// ANALYZE first — the same conditions under which the planner behaves like it
// does in production. These assertions mirror the repo SQL; if an index is
// dropped/renamed (migration regression) or the planner stops using it, the
// specific index name disappears from the plan and the test fails.

let cleanup: () => void;

function plan(sql: string, ...params: unknown[]): string {
  return getDb().prepare('EXPLAIN QUERY PLAN ' + sql).all(...params)
    .map((r) => (r as { detail: string }).detail).join(' | ');
}

beforeAll(() => {
  ({ cleanup } = makeTestDb());
  seedManyChests({ clanId: 1, members: 100, days: 60, perMemberPerDay: 3 });
  // Build the daily-summary rollup so its plan can be inspected.
  notifyChestDataChanged(1);
  getSingleDayRecords(1);
  getDb().exec('ANALYZE');
});
afterAll(() => cleanup());

describe('schema: expected performance indexes exist', () => {
  it('has the v41 covering indexes + v42 rollup', () => {
    const names = new Set(
      getDb().prepare("SELECT name FROM sqlite_master WHERE type='index'").all()
        .map((r) => (r as { name: string }).name),
    );
    for (const idx of [
      'idx_cr_clan_member_captured_pts',
      'idx_cr_clan_chest_pts',
      'idx_cr_clan_source_pts',
      'idx_cr_clan_captured_member_pts',
      'idx_cr_clan_member_effective_pts',
      'idx_cr_clan_effective_member_pts',
      'idx_scan_sessions_clan_status_completed',
    ]) {
      expect(names.has(idx), `missing index ${idx}`).toBe(true);
    }
    const tables = new Set(
      getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .map((r) => (r as { name: string }).name),
    );
    expect(tables.has('chest_daily_summary')).toBe(true);
  });
});

describe('query plans: hot aggregates use covering indexes, not full scans', () => {
  it('leaderboard aggregate uses a covering member index (captured or effective)', () => {
    const p = plan(
      'SELECT member_id, COUNT(*), SUM(point_value) FROM chest_records WHERE clan_id=? GROUP BY member_id',
      1,
    );
    // After phase 2c the effective_at sibling exists; the all-time aggregate
    // may pick either — both are (clan_id, member_id, <ts>, point_value)
    // COVERING indexes, so it's index-only either way. What must NOT happen is
    // a full table scan.
    expect(p, p).toMatch(/idx_cr_clan_member_(captured|effective)_pts/);
    expect(p, p).toContain('COVERING INDEX');
  });

  it('leaderboard aggregate still rides the index once clan rewards are excluded', () => {
    // computeLeaderboard now appends `AND chest_id NOT IN (…)` so an
    // end-of-event clan reward isn't credited to its recipient. chest_id is in
    // none of the covering indexes, so this DELIBERATELY gives up index-only
    // coverage: measured on the 185k-record production backup, all-time went
    // 27ms → 90ms and the windowed form 69ms → 101ms, both behind the 15s
    // analytics TTL. Recovering COVERING would cost a fifth index on the hot
    // insert path. What must still not happen is a full table scan.
    const p = plan(
      'SELECT member_id, COUNT(*), SUM(point_value) FROM chest_records'
        + ' WHERE clan_id=? AND chest_id NOT IN (1,2,3) GROUP BY member_id',
      1,
    );
    expect(p, p).toMatch(/idx_cr_clan_member_(captured|effective)_pts/);
    expect(p, p).not.toMatch(/SCAN chest_records(?! USING)/);
  });

  it('WINDOWED leaderboard range-scans the effective_at index (no full scan)', () => {
    // The hot path phase 2c switched: clan + earn-time window, grouped by
    // member. Must ride an effective_at index, not scan every clan row.
    const p = plan(
      'SELECT member_id, COUNT(*), SUM(point_value) FROM chest_records WHERE clan_id=? AND effective_at>=? AND effective_at<=? GROUP BY member_id',
      1, 0, 9e15,
    );
    expect(p, p).toMatch(/idx_cr_clan_(member_effective_pts|effective_member_pts)/);
    expect(p, p).not.toMatch(/SCAN chest_records(?! USING)/);
  });

  it('analytics byName uses the covering chest index', () => {
    const p = plan(
      'SELECT ch.name, COUNT(*), SUM(cr.point_value) FROM chest_records cr JOIN chests ch ON ch.id=cr.chest_id WHERE cr.clan_id=? GROUP BY cr.chest_id',
      1,
    );
    expect(p, p).toContain('idx_cr_clan_chest_pts');
  });

  it('analytics bySource uses the covering source index', () => {
    const p = plan(
      "SELECT COALESCE(cs.source,'') , COUNT(*), SUM(cr.point_value) FROM chest_records cr LEFT JOIN chest_sources cs ON cs.id=cr.chest_source_id WHERE cr.clan_id=? GROUP BY cr.chest_source_id",
      1,
    );
    expect(p, p).toContain('idx_cr_clan_source_pts');
  });

  it('WINDOWED analytics byName keeps the covering chest index', () => {
    // getChestBreakdowns adds an effective_at predicate to the same GROUP BY.
    // The planner keeps idx_cr_clan_chest_pts and simply stops being COVERING
    // (effective_at is a VIRTUAL generated column, in none of these indexes),
    // which is a far cheaper plan than range-scanning the effective_at index.
    // What must never happen is a full pass over the clan's rows.
    const p = plan(
      'SELECT ch.name, COUNT(*), SUM(cr.point_value) FROM chest_records cr JOIN chests ch ON ch.id=cr.chest_id'
        + ' WHERE cr.clan_id=? AND cr.effective_at>=? AND cr.effective_at<? GROUP BY cr.chest_id',
      1, 0, 9e15,
    );
    expect(p, p).toContain('idx_cr_clan_chest_pts');
    expect(p, p).not.toContain('SCAN cr');
  });

  it('WINDOWED analytics bySource keeps the covering source index', () => {
    const p = plan(
      "SELECT COALESCE(cs.source,''), COUNT(*), SUM(cr.point_value) FROM chest_records cr"
        + ' LEFT JOIN chest_sources cs ON cs.id=cr.chest_source_id'
        + ' WHERE cr.clan_id=? AND cr.effective_at>=? AND cr.effective_at<? GROUP BY cr.chest_source_id',
      1, 0, 9e15,
    );
    expect(p, p).toContain('idx_cr_clan_source_pts');
    expect(p, p).not.toContain('SCAN cr');
  });

  it('grouping a WINDOWED breakdown by chest_type would full-scan — why byType is derived', () => {
    // This is the plan getChestBreakdowns deliberately does NOT run. Grouping
    // on a column of the JOINED table (ch.chest_type) rather than on
    // cr.chest_id makes SQLite abandon chest_records' indexes entirely once an
    // effective_at predicate is present. byType is folded up from byName in JS
    // instead. If a future SQLite learns to plan this well the assertion below
    // flips and the derivation can be revisited — that is a deliberate
    // tripwire, not a guarantee about SQLite.
    const p = plan(
      'SELECT ch.chest_type, COUNT(*), SUM(cr.point_value) FROM chest_records cr JOIN chests ch ON ch.id=cr.chest_id'
        + ' WHERE cr.clan_id=? AND cr.effective_at>=? AND cr.effective_at<? GROUP BY ch.chest_type',
      1, 0, 9e15,
    );
    expect(p, p).toContain('SCAN cr');
  });

  it('recent-chests ordering uses the captured_at index (no scan+sort)', () => {
    const p = plan('SELECT * FROM chest_records WHERE clan_id=? ORDER BY captured_at DESC LIMIT 10', 1);
    expect(p, p).toContain('idx_cr_clan_captured_member_pts');
    expect(p, p).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  it('single-day records read the rollup, never chest_records', () => {
    // earned_chests, not chests: the podium is served from the reward-excluded
    // column pair (v70). Mirrors getSingleDayRecords.
    const p = plan(`
      WITH best AS (SELECT member_id, MAX(earned_chests) value FROM chest_daily_summary WHERE clan_id=? GROUP BY member_id)
      SELECT b.member_id, m.name, b.value FROM best b JOIN members m ON m.id=b.member_id
      WHERE b.value>0 ORDER BY b.value DESC LIMIT 3`, 1);
    expect(p, p).toContain('chest_daily_summary');
    expect(p, p).not.toMatch(/\bchest_records\b/);
  });
});
