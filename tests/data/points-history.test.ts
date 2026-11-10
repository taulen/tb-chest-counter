import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../src/data/database.js';
import {
  applyCopyFrom, applyPointChanges, applyStepEdit, applyStepRemove, getPointsBoard, getPointsHistory,
  PointsChangeError, previewPointChanges, previewRecalculate, previewStepEdit, previewStepRemove,
  type PointChange,
} from '../../src/data/points-board.js';
import {
  getPointsForSourceAt, invalidateSourceKeySummary, loadPointSchedule, recalculatePoints,
} from '../../src/data/repositories/source-points-repo.js';
import { dayStartMs } from '../../src/data/point-timeline.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

/**
 * Chest points with a history (v99, docs/chest-points-history.md). What matters:
 *  - a value saved "from today on" never moves a record earned before today's
 *    game day, and every later scan and recalculation agrees with that,
 *  - a correction to all history still rescores everything, and replaces any
 *    dated value of the same chests,
 *  - a dated change can be moved, re-valued and removed, each previewed
 *    exactly, and the History view describes it against the day before.
 */

const ROLLOVER = 17;
const TODAY = '2026-11-10';
const NOW = Date.UTC(2026, 10, 10, 20, 0, 0); // 20:00 UTC — game day 2026-11-10
const at = (day: string, hours: number): number => dayStartMs(day, ROLLOVER) + hours * 3_600_000;

let cleanup: () => void;
let memberId = 0;
let sessionId = 0;
let unique = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ({ cleanup } = makeTestDb());
  const db = getDb();
  const now = new Date().toISOString();
  memberId = (db.prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (1, 'Alice', 'alice', ?, ?, 1) RETURNING id`,
  ).get(now, now) as { id: number }).id;
  sessionId = (db.prepare(
    `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
     VALUES (1, ?, ?, 'completed', 'manual') RETURNING id`,
  ).get(now, now) as { id: number }).id;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** `count` records of `chest` from `source`, earned at `earnedMs`, stored at `points`. */
function record(source: string, chest: string, earnedMs: number, points: number, count = 1, clanId = 1, member = memberId, session = sessionId): void {
  const db = getDb();
  const chestId = (db.prepare(
    `INSERT INTO chests (name, chest_type) VALUES (?, 'common')
     ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
  ).get(chest) as { id: number }).id;
  const sourceId = (db.prepare(
    `INSERT INTO chest_sources (source) VALUES (?)
     ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
  ).get(source) as { id: number }).id;
  const insert = db.prepare(
    `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at, earned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // captured_at must be unique per (session, member, chest); earned_at is the clock that counts.
  for (let i = 0; i < count; i++) insert.run(clanId, session, member, chestId, sourceId, points, NOW + ++unique, earnedMs);
  invalidateSourceKeySummary();
}

/** Stored points of every record of (source, chest), oldest first. */
function stored(source: string, chest: string, clanId = 1): number[] {
  return (getDb().prepare(`
    SELECT cr.point_value AS p FROM chest_records cr
      JOIN chest_sources cs ON cs.id = cr.chest_source_id
      JOIN chests ch ON ch.id = cr.chest_id
     WHERE cs.source = ? AND ch.name = ? AND cr.clan_id = ?
     ORDER BY cr.effective_at, cr.id`).all(source, chest, clanId) as { p: number }[]).map((r) => r.p);
}

function rows(): { source_key: string; chest_name: string; point_value: number | null; effective_from: string }[] {
  return getDb().prepare(
    'SELECT source_key, chest_name, point_value, effective_from FROM source_point_overrides WHERE clan_id = 1 ORDER BY effective_from, source_key, chest_name',
  ).all() as { source_key: string; chest_name: string; point_value: number | null; effective_from: string }[];
}

const crypt = (points: number): PointChange[] => [{ sourceKey: 'common 10', chestName: '', points }];

/** Common 10 pays 5 (seeded): two chests last week, one yesterday, one today. */
function seedCrypt(): void {
  record('Level 10 Crypt', 'Orc Chest', at('2026-11-03', 2), 5, 2);
  record('Level 10 Crypt', 'Orc Chest', at('2026-11-09', 3), 5);
  record('Level 10 Crypt', 'Orc Chest', at(TODAY, 1), 5);
}

describe('from today on', () => {
  it('rescores only chests earned from today\'s reset on; the board shows the new value', () => {
    seedCrypt();
    const preview = previewPointChanges(1, crypt(0));
    expect(preview.today).toBe(TODAY);
    expect(preview.edits).toEqual([expect.objectContaining({ key: 'common 10', chestName: '', from: 5, to: 0 })]);
    expect(preview.forward.impact).toMatchObject({ records: 1, delta: -5 });
    expect(preview.history.impact).toMatchObject({ records: 4, delta: -20 });
    expect(preview.forward.joinsStep).toBe(false);

    const result = applyPointChanges(1, crypt(0), { mode: 'forward', note: 'Common 10 no longer counts', user: 'leader' });
    expect(result).toMatchObject({ mode: 'forward', effectiveFrom: TODAY, updated: 1 });
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([5, 5, 5, 0]);
    expect(rows()).toEqual([{ source_key: 'common 10', chest_name: '', point_value: 0, effective_from: TODAY }]);

    const board = getPointsBoard(1);
    expect(board.sources.find((s) => s.key === 'common 10')?.points).toBe(0);
    expect(board.staleRecords).toBe(0);
    expect(board.historySteps).toBe(1);
    expect(previewRecalculate(1).records).toBe(0);
  });

  it('a later scan scores each chest by the day it was earned', () => {
    seedCrypt();
    applyPointChanges(1, crypt(0), { mode: 'forward' });
    const schedule = loadPointSchedule(1);
    expect(getPointsForSourceAt(schedule, 'Level 10 Crypt', 'Orc Chest', at('2026-11-09', 23))).toBe(5);
    expect(getPointsForSourceAt(schedule, 'Level 10 Crypt', 'Orc Chest', at(TODAY, 0))).toBe(0);
  });

  it('a second save the same day joins the first; setting it back leaves nothing behind', () => {
    seedCrypt();
    applyPointChanges(1, crypt(0), { mode: 'forward', note: 'first' });
    expect(previewPointChanges(1, crypt(2)).forward.joinsStep).toBe(true);
    applyPointChanges(1, crypt(2), { mode: 'forward' });
    expect(rows()).toEqual([{ source_key: 'common 10', chest_name: '', point_value: 2, effective_from: TODAY }]);
    const history = getPointsHistory(1);
    expect(history.steps).toHaveLength(1);
    expect(history.steps[0]).toMatchObject({ effectiveFrom: TODAY, note: 'first' });
    expect(history.steps[0].lines).toEqual([expect.objectContaining({ chestName: '', from: 5, to: 2 })]);

    applyPointChanges(1, crypt(5), { mode: 'forward' });
    expect(rows()).toEqual([]);
    expect(getPointsHistory(1).steps).toEqual([]);
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([5, 5, 5, 5]);
  });

  it('never touches a past record that was already out of line — only a correction or Recalculate does', () => {
    // Prod has these: clan 1's Common 20 chests stored at 80 while its value
    // says 130. A dated change must not quietly rewrite them.
    seedCrypt();
    record('Level 10 Crypt', 'Orc Chest', at('2026-10-20', 1), 80);
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([80, 5, 5, 5, 5]);
    expect(getPointsBoard(1).staleRecords).toBe(1);

    const preview = previewPointChanges(1, crypt(0));
    expect(preview.forward.impact).toMatchObject({ records: 1, delta: -5 });
    // All history counts it: a correction does settle it.
    expect(preview.history.impact).toMatchObject({ records: 5, delta: -100 });
    applyPointChanges(1, crypt(0), { mode: 'forward' });
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([80, 5, 5, 5, 0]);

    const step = getPointsHistory(1).steps[0];
    const keep = step.lines.map((l) => ({ sourceKey: l.key, chestName: l.chestName, points: l.to }));
    expect(previewStepEdit(1, step.id, { effectiveFrom: '2026-10-25', changes: keep }).impact).toMatchObject({ records: 3, delta: -15 });
    applyStepEdit(1, step.id, { effectiveFrom: '2026-10-25', changes: keep });
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([80, 0, 0, 0, 0]);
    applyStepRemove(1, step.id);
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([80, 5, 5, 5, 5]);
    expect(getPointsBoard(1).staleRecords).toBe(1);

    expect(recalculatePoints(1)).toBe(1);
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([5, 5, 5, 5, 5]);
  });

  it('a recalculation keeps every record on the value of its own day', () => {
    seedCrypt();
    applyPointChanges(1, crypt(0), { mode: 'forward' });
    getDb().prepare('UPDATE chest_records SET point_value = 99').run();
    invalidateSourceKeySummary();
    expect(getPointsBoard(1).staleRecords).toBe(4);
    expect(recalculatePoints(1)).toBe(4);
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([5, 5, 5, 0]);
  });
});

describe('all history', () => {
  it('rescores every record and logs the correction', () => {
    seedCrypt();
    const result = applyPointChanges(1, crypt(8), { mode: 'history', note: 'was always 8', user: 'leader' });
    expect(result).toMatchObject({ mode: 'history', effectiveFrom: '', updated: 4 });
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([8, 8, 8, 8]);
    const history = getPointsHistory(1);
    expect(history.steps).toEqual([]);
    expect(history.log).toEqual([expect.objectContaining({
      kind: 'correction', note: 'was always 8', createdBy: 'leader',
      lines: [expect.objectContaining({ key: 'common 10', from: 5, to: 8 })],
    })]);
  });

  it('replaces a dated value of the same chests, and says so first', () => {
    seedCrypt();
    applyPointChanges(1, crypt(0), { mode: 'forward' });
    const preview = previewPointChanges(1, crypt(3));
    expect(preview.history.replacesSteps).toEqual([TODAY]);
    expect(preview.history.impact).toMatchObject({ records: 4 });
    applyPointChanges(1, crypt(3), { mode: 'history' });
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([3, 3, 3, 3]);
    expect(rows()).toEqual([{ source_key: 'common 10', chest_name: '', point_value: 3, effective_from: '' }]);
    expect(getPointsHistory(1).steps).toEqual([]);
  });

  it('leaves a dated value of other sources alone', () => {
    seedCrypt();
    record('Summoning Dark Omens', 'Minor Omen Chest', at('2026-11-03', 1), 50);
    applyPointChanges(1, crypt(0), { mode: 'forward' });
    expect(previewPointChanges(1, [{ sourceKey: 'summoning dark omens', chestName: '', points: 60 }]).history.replacesSteps).toEqual([]);
    applyPointChanges(1, [{ sourceKey: 'summoning dark omens', chestName: '', points: 60 }], { mode: 'history' });
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([5, 5, 5, 0]);
    expect(getPointsHistory(1).steps).toHaveLength(1);
  });
});

describe('editing a dated change', () => {
  function stepId(): number {
    return getPointsHistory(1).steps[0].id;
  }

  it('moves to an earlier day, rescoring the days in between', () => {
    seedCrypt();
    applyPointChanges(1, crypt(0), { mode: 'forward' });
    const lines = getPointsHistory(1).steps[0].lines.map((l) => ({ sourceKey: l.key, chestName: l.chestName, points: l.to }));
    const edit = { effectiveFrom: '2026-11-05', changes: lines };
    expect(previewStepEdit(1, stepId(), edit)).toMatchObject({ effectiveFrom: '2026-11-05', removes: false, impact: { records: 1, delta: -5 } });
    const result = applyStepEdit(1, stepId(), edit, { user: 'leader' });
    expect(result.updated).toBe(1);
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([5, 5, 0, 0]);
    expect(getPointsHistory(1).steps[0]).toMatchObject({ effectiveFrom: '2026-11-05', updatedBy: 'leader' });
  });

  it('changes the value it sets', () => {
    seedCrypt();
    applyPointChanges(1, crypt(0), { mode: 'forward' });
    applyStepEdit(1, stepId(), { effectiveFrom: TODAY, changes: crypt(1) });
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([5, 5, 5, 1]);
    expect(getPointsHistory(1).steps[0].lines).toEqual([expect.objectContaining({ from: 5, to: 1 })]);
  });

  it('is deleted when it no longer changes anything', () => {
    seedCrypt();
    applyPointChanges(1, crypt(0), { mode: 'forward' });
    expect(applyStepEdit(1, stepId(), { effectiveFrom: TODAY, changes: crypt(5) }).removes).toBe(true);
    expect(getPointsHistory(1).steps).toEqual([]);
  });

  it('refuses a day after today, a day another change holds, and a move past a change of the same source', () => {
    seedCrypt();
    vi.setSystemTime(at('2026-11-05', 1));
    applyPointChanges(1, crypt(1), { mode: 'forward' });
    vi.setSystemTime(NOW);
    applyPointChanges(1, crypt(0), { mode: 'forward' });
    const [today, older] = getPointsHistory(1).steps;
    expect(today.effectiveFrom).toBe(TODAY);
    expect(older.effectiveFrom).toBe('2026-11-05');
    const keep = { changes: today.lines.map((l) => ({ sourceKey: l.key, chestName: l.chestName, points: l.to })) };
    expect(() => previewStepEdit(1, today.id, { ...keep, effectiveFrom: '2026-11-11' })).toThrow(PointsChangeError);
    expect(() => previewStepEdit(1, today.id, { ...keep, effectiveFrom: '2026-11-05' })).toThrow(PointsChangeError);
    expect(() => previewStepEdit(1, today.id, { ...keep, effectiveFrom: '2026-11-01' })).toThrow(/move past/);
    expect(() => previewStepEdit(1, today.id, { ...keep, effectiveFrom: 'yesterday' })).toThrow(PointsChangeError);
    expect(previewStepEdit(1, today.id, { ...keep, effectiveFrom: '2026-11-07' }).effectiveFrom).toBe('2026-11-07');
  });

  it('removing one gives its days back to the values before it', () => {
    seedCrypt();
    vi.setSystemTime(at('2026-11-05', 1));
    applyPointChanges(1, crypt(1), { mode: 'forward' });
    vi.setSystemTime(NOW);
    applyPointChanges(1, crypt(0), { mode: 'forward' });
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([5, 5, 1, 0]);

    const older = getPointsHistory(1).steps[1];
    expect(previewStepRemove(1, older.id)).toMatchObject({ removes: true, impact: { records: 1, delta: 4 } });
    applyStepRemove(1, older.id);
    expect(stored('Level 10 Crypt', 'Orc Chest')).toEqual([5, 5, 5, 0]);
    const steps = getPointsHistory(1).steps;
    expect(steps).toHaveLength(1);
    // Described against the day before it, as the timeline now stands.
    expect(steps[0].lines).toEqual([expect.objectContaining({ from: 5, to: 0 })]);
  });

  it('a removed change can\'t be edited again', () => {
    seedCrypt();
    applyPointChanges(1, crypt(0), { mode: 'forward' });
    const id = stepId();
    applyStepRemove(1, id);
    expect(() => previewStepRemove(1, id)).toThrow(PointsChangeError);
  });
});

describe('per clan', () => {
  it('a dated change is the clan\'s own; a copy replaces the target\'s history and is logged', () => {
    seedTwoClans();
    seedCrypt();
    const member2 = (getDb().prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (2, 'Bob', 'bob', '', '', 1) RETURNING id`,
    ).get() as { id: number }).id;
    const session2 = (getDb().prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
       VALUES (2, '', '', 'completed', 'manual') RETURNING id`,
    ).get() as { id: number }).id;
    record('Level 10 Crypt', 'Orc Chest', at('2026-11-03', 2), 5, 1, 2, member2, session2);
    record('Level 10 Crypt', 'Orc Chest', at(TODAY, 2), 5, 1, 2, member2, session2);

    applyPointChanges(2, crypt(0), { mode: 'forward' });
    expect(stored('Level 10 Crypt', 'Orc Chest', 2)).toEqual([5, 0]);
    expect(stored('Level 10 Crypt', 'Orc Chest', 1)).toEqual([5, 5, 5, 5]);
    expect(getPointsHistory(1).steps).toEqual([]);

    applyPointChanges(1, crypt(7), { mode: 'history' });
    const result = applyCopyFrom(2, 1, { user: 'leader' });
    expect(result.dropsSteps).toBe(1);
    expect(stored('Level 10 Crypt', 'Orc Chest', 2)).toEqual([7, 7]);
    const history = getPointsHistory(2);
    expect(history.steps).toEqual([]);
    expect(history.log).toEqual([expect.objectContaining({ kind: 'copy', createdBy: 'leader' })]);
  });
});
