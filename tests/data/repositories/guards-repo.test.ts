import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import {
  addGuardsReport,
  deleteGuardsReport,
  getClanGuardsOverview,
  getGuardsEstimates,
  getGuardsSummaries,
  listGuardsReports,
} from '../../../src/data/repositories/guards-repo.js';
import {
  goldPassForCycle,
  getGoldPassStatuses,
  triumphalCycle,
} from '../../../src/data/repositories/gold-pass-repo.js';
import { addMergeRule } from '../../../src/data/repositories/merge-repo.js';
import { deleteBatch, insertTransactions } from '../../../src/data/repositories/resource-repo.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

const DAY = 86_400_000;
const ROLLOVER = 17;

function typeId(slug: string): number {
  return (getDb().prepare('SELECT id FROM resource_types WHERE slug = ?').get(slug) as { id: number }).id;
}

function member(clanId: number, name: string): number {
  const now = new Date().toISOString();
  return (getDb().prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (?, ?, ?, ?, ?, 1) RETURNING id`,
  ).get(clanId, name, name.toLowerCase(), now, now) as { id: number }).id;
}

function batch(clanId: number): number {
  return (getDb().prepare(
    `INSERT INTO resource_upload_batches (clan_id, uploaded_at, upload_date, source)
     VALUES (?, ?, '2026-09-01', 'scan') RETURNING id`,
  ).get(clanId, new Date().toISOString()) as { id: number }).id;
}

function donate(clanId: number, batchId: number, memberId: number, slug: string, amount: number, date: string): void {
  insertTransactions([{
    clanId, batchId, memberId, resourceTypeId: typeId(slug), direction: 1, amount,
    transactionDate: date, rawPlayerName: '',
  }]);
}

describe('guards-repo', () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
  });
  afterEach(() => cleanup());

  it('estimates each member from their own donations, clan-scoped', () => {
    const b1 = batch(1);
    const taulen = member(1, 'taulen');
    donate(1, b1, taulen, 'omen-essence', 770_000, '2026-07-18');
    donate(1, b1, taulen, 'scientific-tractates', 15_000_000, '2026-08-01');
    donate(1, b1, taulen, 'scientific-tractates', 58_000_000, '2026-08-25');
    donate(1, b1, taulen, 'omen-essence', 1_001_000, '2026-09-03');
    // Not a tier and not essence — must not count as evidence of anything.
    donate(1, b1, taulen, 'scientific-tractates', 250_000, '2026-09-23');
    donate(1, b1, taulen, 'food', 14_300_000, '2026-09-04');

    const b2 = batch(2);
    const other = member(2, 'other');
    donate(2, b2, other, 'omen-essence', 455_000, '2026-09-03');

    const clan1 = getGuardsEstimates(1);
    expect(clan1.get(taulen)?.level).toBe(8);
    expect(clan1.get(taulen)?.asOf).toBe('2026-09-03');
    expect(clan1.has(other)).toBe(false);
    expect(getGuardsEstimates(2).get(other)?.level).toBe(5);
  });

  it('marks an estimate stale once the evidence is old', () => {
    const b = batch(1);
    const m = member(1, 'old');
    donate(1, b, m, 'omen-essence', 1_001_000, '2026-07-18');
    donate(1, b, m, 'scientific-tractates', 58_000_000, '2026-08-01');
    expect(getGuardsSummaries(1, '2026-08-20').get(m)?.stale).toBe(false);
    expect(getGuardsSummaries(1, '2026-10-01').get(m)?.stale).toBe(true);
  });

  it('weighs an admin entry as evidence, and forgets it when deleted', () => {
    const b = batch(1);
    const m = member(1, 'quiet');
    donate(1, b, m, 'omen-essence', 770_000, '2026-08-11');
    expect(getGuardsEstimates(1).get(m)?.level).toBe(7);

    const id = addGuardsReport({
      clanId: 1, memberId: m, level: 8, observedDate: '2026-09-20', note: 'said so in chat', createdBy: null,
    });
    // No waiting out the cache: the write invalidates it.
    expect(getGuardsEstimates(1).get(m)?.level).toBe(8);
    expect(getGuardsSummaries(1, '2026-09-21').get(m)?.reported).toBe(true);
    expect(listGuardsReports(m, 1)).toMatchObject([{ id, level: 8, note: 'said so in chat' }]);

    expect(deleteGuardsReport(id, 2)).toBeNull();
    expect(deleteGuardsReport(id, 1)).toEqual({ memberId: m, level: 8 });
    expect(getGuardsEstimates(1).get(m)?.level).toBe(7);
  });

  it('refreshes when a resource batch is deleted', () => {
    const keep = batch(1);
    const drop = batch(1);
    const m = member(1, 'm');
    donate(1, keep, m, 'omen-essence', 770_000, '2026-08-11');
    donate(1, drop, m, 'scientific-tractates', 58_000_000, '2026-08-25');
    expect(getGuardsEstimates(1).get(m)?.level).toBe(8);
    deleteBatch(drop, 1);
    expect(getGuardsEstimates(1).get(m)?.level).toBe(7);
  });

  it('carries admin entries through a player merge', () => {
    const misread = member(1, 'Tau1en');
    const real = member(1, 'taulen');
    addGuardsReport({ clanId: 1, memberId: misread, level: 8, observedDate: '2026-09-01', note: '', createdBy: null });
    addMergeRule('player', 'Tau1en', 'taulen', 1);
    expect(listGuardsReports(real, 1)).toHaveLength(1);
    expect(getGuardsEstimates(1).get(real)?.level).toBe(8);
  });

  it('summarises the active roster for the analytics overview', () => {
    const b = batch(1);
    const a = member(1, 'a');
    const c = member(1, 'c');
    member(1, 'never-donated');
    donate(1, b, a, 'omen-essence', 770_000, '2026-08-11');
    donate(1, b, a, 'omen-essence', 1_001_000, '2026-09-03');
    donate(1, b, c, 'omen-essence', 1_001_000, '2026-09-03');

    const o = getClanGuardsOverview(1, '2026-09-10');
    expect(o.distribution).toEqual([{ level: 8, members: 2 }]);
    expect(o.estimated).toBe(2);
    expect(o.unknown).toBe(1);
    expect(o.recentLevelUps).toMatchObject([{ memberId: a, from: 7, to: 8, by: '2026-09-03' }]);
  });
});

describe('gold-pass-repo', () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
  });
  afterEach(() => cleanup());

  /** A Union Chest scanned for `memberId` at `atMs`. */
  function unionChest(clanId: number, memberId: number, atMs: number): void {
    const db = getDb();
    const now = new Date().toISOString();
    const session = db.prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
       VALUES (?, ?, ?, 'completed', 'manual') RETURNING id`,
    ).get(clanId, now, now) as { id: number };
    const chest = db.prepare(
      `INSERT INTO chests (name, chest_type) VALUES ('Union Chest', 'common')
       ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
    ).get() as { id: number };
    const source = db.prepare(
      `INSERT INTO chest_sources (source) VALUES ('Union of Triumph personal reward')
       ON CONFLICT(source) DO UPDATE SET source = excluded.source RETURNING id`,
    ).get() as { id: number };
    db.prepare(
      `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, chest_source_id, point_value, captured_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).run(clanId, session.id, memberId, chest.id, source.id, atMs);
  }

  const dayOf = (ms: number) => new Date(ms - ROLLOVER * 3_600_000).toISOString().slice(0, 10);

  it('needs both the Union Chest and the 250k line in the same cycle', () => {
    const now = Date.now();
    const cycle = triumphalCycle(now, ROLLOVER, 0)!;
    const inCycle = Date.parse(cycle.from) + 2 * 60_000;
    const b = batch(1);

    const holder = member(1, 'holder');
    unionChest(1, holder, inCycle);
    donate(1, b, holder, 'scientific-tractates', 250_000, dayOf(inCycle));

    const storeBuyer = member(1, 'store');
    unionChest(1, storeBuyer, inCycle);

    const lineOnly = member(1, 'line');
    donate(1, b, lineOnly, 'scientific-tractates', 250_000, dayOf(inCycle));

    const window = goldPassForCycle(1, cycle, now, ROLLOVER);
    expect(window.basis).toBe('union+tractates');
    expect(window.members.get(holder)).toEqual({ unionChests: 1, passDonations: 1, goldPass: true });
    expect(window.members.get(storeBuyer)?.goldPass).toBe(false);
    expect(window.members.get(lineOnly)?.goldPass).toBe(false);
    expect(window.holders).toBe(1);

    expect(getGoldPassStatuses(1, now, ROLLOVER)).toEqual(new Map([[holder, 'current']]));
  });

  it('reports last cycle\'s holders as previous until they show up again', () => {
    const now = Date.now();
    const prev = triumphalCycle(now, ROLLOVER, 1)!;
    const inPrev = Date.parse(prev.from) + DAY;
    const b = batch(1);
    const lapsed = member(1, 'lapsed');
    unionChest(1, lapsed, inPrev);
    donate(1, b, lapsed, 'scientific-tractates', 250_000, dayOf(inPrev));
    expect(getGoldPassStatuses(1, now, ROLLOVER).get(lapsed)).toBe('previous');
  });

  it('falls back to the Union Chest alone when the clan tracks no resources', () => {
    const now = Date.now();
    const cycle = triumphalCycle(now, ROLLOVER, 0)!;
    const m = member(2, 'no-resources');
    unionChest(2, m, Date.parse(cycle.from) + 60_000);
    const window = goldPassForCycle(2, cycle, now, ROLLOVER);
    expect(window.basis).toBe('union-only');
    expect(window.members.get(m)?.goldPass).toBe(true);
  });
});
