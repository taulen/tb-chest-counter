import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, closeDb, getDb } from '../../src/data/database.js';
import { getSingleDayRecords, getTopContributors, notifyChestDataChanged, verifyClanSummary } from '../../src/data/repositories/chest-summary-repo.js';
import { getLeaderboard } from '../../src/data/repositories/chest-repo.js';

// Opt-in real-data regression check. Skipped unless TB_PROD_DB points at a
// production backup (they are gitignored — real player data + tens of MB —
// so this never runs in CI). Run locally or on a schedule with e.g.:
//
//   TB_PROD_DB=data/exports/dbbackup/tb-chests-backup-2026-07-11T15-08-39-438Z.db npm run test:run
//
// It copies the backup, migrates the copy to head (exercising the migration
// path on real data), then verifies the rollup reconciles with raw on the
// real dataset and that the hot queries stay fast. Thresholds are generous on
// purpose — this catches order-of-magnitude regressions, not CI-machine jitter.
const PROD_DB = process.env.TB_PROD_DB;
const SLOW_MS = Number(process.env.TB_PROD_DB_SLOW_MS ?? 500);

describe.skipIf(!PROD_DB)('production backup regression check', () => {
  let tmpDir: string;
  let clanIds: number[] = [];

  beforeAll(() => {
    closeDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbcc-proddb-'));
    const copy = path.join(tmpDir, 'prod.db');
    fs.copyFileSync(PROD_DB as string, copy);
    initDatabase(copy); // runs migrations → head (v41/v42), builds indexes
    clanIds = getDb().prepare('SELECT id FROM clans ORDER BY id').all()
      .map((r) => (r as { id: number }).id);
  }, 120_000); // copying + migrating + ANALYZE on a large backup is slow

  afterAll(() => {
    closeDb();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('has clans with data', () => {
    expect(clanIds.length).toBeGreaterThan(0);
  });

  it('rollup reconciles with raw on real data (every clan)', () => {
    for (const clanId of clanIds) {
      notifyChestDataChanged(clanId);
      const v = verifyClanSummary(clanId);
      expect(v.ok, `clan ${clanId}: summary ${JSON.stringify(v.summary)} != raw ${JSON.stringify(v.raw)}`).toBe(true);
    }
  });

  it('hot queries stay fast on real data', () => {
    for (const clanId of clanIds) {
      const time = (label: string, fn: () => void) => {
        const t0 = performance.now();
        fn();
        const ms = performance.now() - t0;
        // eslint-disable-next-line no-console
        console.log(`clan ${clanId} ${label}: ${ms.toFixed(1)}ms`);
        expect(ms, `${label} took ${ms.toFixed(0)}ms (> ${SLOW_MS}ms)`).toBeLessThan(SLOW_MS);
      };
      time('leaderboard', () => getLeaderboard(clanId, undefined, undefined, { includeAllMembers: true }));
      time('single-day', () => getSingleDayRecords(clanId));
      time('top-contributors', () => getTopContributors(clanId, 10));
    }
  });

  it('hot query plans avoid full table scans on chest_records', () => {
    const plan = (sql: string, ...p: unknown[]): string =>
      getDb().prepare('EXPLAIN QUERY PLAN ' + sql).all(...p)
        .map((r) => (r as { detail: string }).detail).join(' | ');
    const clanId = clanIds[0];
    // Mirrors computeLeaderboard, clan-reward exclusion included — without the
    // filter this stopped mirroring the repo, and it is the filter that decides
    // whether the plan is index-only.
    const leaderboard = plan(
      'SELECT member_id, COUNT(*), SUM(point_value) FROM chest_records'
        + ' WHERE clan_id=? AND chest_id NOT IN (1,2,3) GROUP BY member_id',
      clanId,
    );
    // Either member index is fine — the captured_at one predates the
    // effective_at sibling added in v49/v50, and on a real dataset the planner
    // picks whichever its stats favour. This assertion named only the older one
    // and had been failing on any recent backup for that reason alone.
    //
    // COVERING is deliberately NOT required: chest_id is in none of the
    // covering indexes, so the reward exclusion costs a row fetch (measured on
    // the 185k-record Aug 2026 backup: 27ms → 90ms all-time, behind the 15s
    // analytics TTL). A full scan — "SCAN <table>" with no "USING ... INDEX" —
    // is what must never happen.
    expect(leaderboard, leaderboard).toMatch(/idx_cr_clan_member_(captured|effective)_pts/);
    expect(leaderboard, leaderboard).not.toMatch(/SCAN chest_records(?! USING)/);
  });
});
