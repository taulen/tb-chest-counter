import fs from 'fs';
import { getDb } from '../database.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('resource-repo');

export interface ResourceType {
  id: number;
  name: string;
  slug: string;
}

/** Where a batch's rows came from. 'upload' = an admin dragged screenshots in;
 *  'scan' = the daily automated Clan Capital history capture. */
export type ResourceBatchSource = 'upload' | 'scan';

export interface ResourceBatch {
  id: number;
  clanId: number;
  uploadedBy: number;
  uploadedAt: string;
  uploadDate: string;
  fileCount: number;
  rowCount: number;
  errorCount: number;
  notes: string;
  source: ResourceBatchSource;
}

export interface ResourceTransaction {
  id: number;
  clanId: number;
  batchId: number;
  memberId: number;
  memberName: string;
  resourceTypeId: number | null;
  resourceTypeName: string | null;
  resourceTypeSlug: string | null;
  direction: 1 | -1;
  amount: number;
  transactionDate: string;
  rawPlayerName: string;
  createdAt: string;
  /** True when a source-row screenshot was kept for this row (hover preview). */
  hasCrop: boolean;
}

export interface ResourceSummaryRow {
  memberId: number;
  memberName: string;
  resourceTypeId: number | null;
  resourceTypeName: string | null;
  sentAmount: number;
  tookAmount: number;
  netAmount: number;
}

export interface ResourceDailyRow {
  resourceTypeId: number | null;
  date: string;
  sent: number;
  took: number;
}

export interface InsertTransactionRow {
  clanId: number;
  batchId: number;
  memberId: number;
  resourceTypeId: number | null;
  direction: 1 | -1;
  amount: number;
  transactionDate: string;
  rawPlayerName: string;
  /** On-disk PNG of the source screenshot row, for rows the importer left unresolved. */
  rowCropPath?: string | null;
  /** The Clan Capital ledger entry this row came from (v103; unique per clan). */
  gameEntryId?: number | null;
}

/**
 * Resource types that exist in the game but are NOT tracked per member —
 * they're clan-wide, so attributing them to individual members is noise.
 * Kept in resource_types (so historical rows resolve their name), but hidden
 * from the /types endpoint and skipped by the ledger import.
 */
export const UNTRACKED_RESOURCE_SLUGS = new Set<string>(['seal-of-suppression']);

export function listResourceTypes(): ResourceType[] {
  const db = getDb();
  return db.prepare('SELECT id, name, slug FROM resource_types ORDER BY id').all() as ResourceType[];
}

export function createBatch(opts: {
  clanId: number;
  /** null for the automated capture — there is no user behind it, and v55 made
   *  the column nullable precisely so attribution could be absent. */
  uploadedBy: number | null;
  uploadDate: string;
  fileCount: number;
  rowCount: number;
  errorCount: number;
  notes: string;
  /** Defaults to 'upload' so every existing call site keeps its meaning. */
  source?: ResourceBatchSource;
  /** The scan session that read these rows (v134); Scan History counts them per scan. */
  sessionId?: number | null;
}): ResourceBatch {
  const db = getDb();
  const now = new Date().toISOString();
  const source = opts.source ?? 'upload';
  const result = db.prepare(`
    INSERT INTO resource_upload_batches
      (clan_id, uploaded_by, uploaded_at, upload_date, file_count, row_count,
       error_count, notes, source, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.clanId,
    opts.uploadedBy,
    now,
    opts.uploadDate,
    opts.fileCount,
    opts.rowCount,
    opts.errorCount,
    opts.notes,
    source,
    opts.sessionId ?? null,
  );
  return {
    id: result.lastInsertRowid as number,
    clanId: opts.clanId,
    uploadedBy: opts.uploadedBy as number,
    uploadedAt: now,
    uploadDate: opts.uploadDate,
    fileCount: opts.fileCount,
    rowCount: opts.rowCount,
    errorCount: opts.errorCount,
    notes: opts.notes,
    source,
  };
}

export function insertTransactions(rows: InsertTransactionRow[]): { inserted: number; skipped: number } {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO resource_transactions
      (clan_id, batch_id, member_id, resource_type_id, direction, amount,
       transaction_date, raw_player_name, created_at, row_crop_path, game_entry_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(
        r.clanId, r.batchId, r.memberId, r.resourceTypeId ?? null,
        r.direction, r.amount, r.transactionDate, r.rawPlayerName, now,
        r.rowCropPath ?? null, r.gameEntryId ?? null,
      );
    }
  });
  tx();
  return { inserted: rows.length, skipped: 0 };
}

export interface ListTransactionsOpts {
  clanId: number;
  memberId?: number;
  /** Restrict to a single upload batch (used by the post-import "resolve unknowns" modal). */
  batchId?: number;
  resourceTypeId?: number;
  /** When true, match only rows whose resource_type_id IS NULL (rows the old screenshot reader could not match). */
  resourceTypeIsNull?: boolean;
  direction?: 1 | -1;
  from?: string;
  to?: string;
  sortBy?: 'date' | 'amount' | 'member' | 'resource';
  sortDir?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export function listTransactions(opts: ListTransactionsOpts): { rows: ResourceTransaction[]; total: number } {
  const db = getDb();
  const conditions: string[] = ['rt.clan_id = ?'];
  const params: unknown[] = [opts.clanId];

  if (opts.memberId !== undefined) { conditions.push('rt.member_id = ?'); params.push(opts.memberId); }
  if (opts.batchId !== undefined) { conditions.push('rt.batch_id = ?'); params.push(opts.batchId); }
  if (opts.resourceTypeIsNull) { conditions.push('rt.resource_type_id IS NULL'); }
  else if (opts.resourceTypeId !== undefined) { conditions.push('rt.resource_type_id = ?'); params.push(opts.resourceTypeId); }
  if (opts.direction !== undefined) { conditions.push('rt.direction = ?'); params.push(opts.direction); }
  if (opts.from) { conditions.push('rt.transaction_date >= ?'); params.push(opts.from); }
  if (opts.to) { conditions.push('rt.transaction_date <= ?'); params.push(opts.to); }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const validSorts: Record<string, string> = {
    date: 'rt.transaction_date',
    amount: 'rt.amount',
    member: 'm.name',
    resource: 'rtype.name',
  };
  const orderCol = validSorts[opts.sortBy ?? 'date'] ?? 'rt.transaction_date';
  const orderDir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';
  // Tie-break so rows within one day come out in the order the GAME lists them, newest
  // at the top. The row id is the only record of that order, and it runs BACKWARDS
  // relative to recency: both importers read the list newest-first, so the newest row of
  // a day is inserted first and gets the LOWEST id. `id DESC` therefore put each day
  // upside down, with the day's newest entry at the bottom of its group.
  //
  // Hence the inverse of the primary direction when sorting by date: `date DESC, id ASC`
  // is newest day first, newest row first. Sorting by anything else keeps its own
  // ordering and falls back to that same most-recent-first rule.
  const dateTie = `rt.transaction_date DESC, rt.id ASC`;
  const order = (opts.sortBy ?? 'date') === 'date'
    ? `ORDER BY ${orderCol} ${orderDir}, rt.id ${orderDir === 'DESC' ? 'ASC' : 'DESC'}`
    : `ORDER BY ${orderCol} ${orderDir}, ${dateTie}`;

  const base = `
    FROM resource_transactions rt
    JOIN members m ON m.id = rt.member_id
    LEFT JOIN resource_types rtype ON rtype.id = rt.resource_type_id
    ${where}
  `;

  const total = (db.prepare(`SELECT COUNT(*) as c ${base}`).get(...params) as { c: number }).c;
  const rows = db.prepare(`
    SELECT rt.id, rt.clan_id, rt.batch_id, rt.member_id, m.name as member_name,
           rt.resource_type_id, rtype.name as resource_type_name, rtype.slug as resource_type_slug,
           rt.direction, rt.amount, rt.transaction_date, rt.raw_player_name, rt.created_at,
           rt.row_crop_path
    ${base}
    ${order}
    LIMIT ? OFFSET ?
  `).all(...params, opts.limit, opts.offset) as Array<Record<string, unknown>>;

  return {
    total,
    rows: rows.map((r) => ({
      id: r.id as number,
      clanId: r.clan_id as number,
      batchId: r.batch_id as number,
      memberId: r.member_id as number,
      memberName: r.member_name as string,
      resourceTypeId: (r.resource_type_id as number | null) ?? null,
      resourceTypeName: (r.resource_type_name as string | null) ?? null,
      resourceTypeSlug: (r.resource_type_slug as string | null) ?? null,
      direction: r.direction as 1 | -1,
      amount: r.amount as number,
      transactionDate: r.transaction_date as string,
      rawPlayerName: r.raw_player_name as string,
      createdAt: r.created_at as string,
      hasCrop: Boolean(r.row_crop_path),
    })),
  };
}

/** One scan's Clan Capital ledger rows, per resource and direction (Scan History's scan page). */
export interface SessionLedgerSummary {
  rows: number;
  members: number;
  byResource: Array<{ slug: string | null; name: string | null; direction: 1 | -1; rows: number; amount: number }>;
}

/**
 * What a scan recorded from the Clan Capital ledger: the rows of the batches
 * it wrote (v134 session_id), counted and summed per resource and direction —
 * Sent (member → clan) before Took (clan → member) — in resource-type order.
 */
export function getSessionLedgerSummary(sessionId: number, clanId: number): SessionLedgerSummary {
  const db = getDb();
  const from = `
    FROM resource_upload_batches b
    JOIN resource_transactions rt ON rt.batch_id = b.id AND rt.clan_id = b.clan_id
    LEFT JOIN resource_types rtype ON rtype.id = rt.resource_type_id
    WHERE b.session_id = ? AND b.clan_id = ?`;
  const totals = db.prepare(`SELECT COUNT(*) AS rows, COUNT(DISTINCT rt.member_id) AS members ${from}`)
    .get(sessionId, clanId) as { rows: number; members: number };
  const byResource = db.prepare(`
    SELECT rtype.slug AS slug, rtype.name AS name, rt.direction AS direction,
           COUNT(*) AS rows, SUM(rt.amount) AS amount
    ${from}
    GROUP BY rt.resource_type_id, rt.direction
    ORDER BY rt.direction DESC, rt.resource_type_id
  `).all(sessionId, clanId) as SessionLedgerSummary['byResource'];
  return { rows: totals.rows, members: totals.members, byResource };
}

export function listBatches(clanId: number): ResourceBatch[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM resource_upload_batches WHERE clan_id = ? ORDER BY uploaded_at DESC',
  ).all(clanId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    clanId: r.clan_id as number,
    uploadedBy: r.uploaded_by as number,
    uploadedAt: r.uploaded_at as string,
    uploadDate: r.upload_date as string,
    fileCount: (r.file_count as number | null) ?? 1,
    rowCount: r.row_count as number,
    errorCount: r.error_count as number,
    notes: r.notes as string,
    source: ((r.source as string | null) ?? 'upload') as ResourceBatchSource,
  }));
}

export function deleteBatch(batchId: number, clanId: number): void {
  const db = getDb();
  // Collect the row-crop files before the rows go, otherwise the paths are lost and
  // the PNGs stay on disk forever. Deleted after the transaction commits: a failed
  // unlink must not roll back the delete, and an orphaned file is far cheaper than
  // a DB row pointing at a file that's already gone.
  const cropPaths = (db.prepare(
    'SELECT row_crop_path FROM resource_transactions WHERE batch_id = ? AND clan_id = ? AND row_crop_path IS NOT NULL',
  ).all(batchId, clanId) as { row_crop_path: string }[]).map((r) => r.row_crop_path);

  const tx = db.transaction(() => {
    db.prepare(
      'DELETE FROM resource_transactions WHERE batch_id = ? AND clan_id = ?',
    ).run(batchId, clanId);
    db.prepare(
      'DELETE FROM resource_upload_batches WHERE id = ? AND clan_id = ?',
    ).run(batchId, clanId);
  });
  tx();

  for (const p of cropPaths) {
    try {
      fs.rmSync(p, { force: true });
    } catch (err) {
      log.debug(`resource-repo: could not remove row crop ${p}: ${String(err)}`);
    }
  }
}

/**
 * On-disk path of the row-crop PNG for one transaction, or null. Clan-scoped so an
 * admin in clan A can't read clan B's crops by guessing transaction ids.
 */
export function getRowCropPath(txId: number, clanId: number): string | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT row_crop_path FROM resource_transactions WHERE id = ? AND clan_id = ?',
  ).get(txId, clanId) as { row_crop_path: string | null } | undefined;
  return row?.row_crop_path ?? null;
}

export function updateTransaction(
  id: number,
  clanId: number,
  updates: {
    resourceTypeId: number | null;
    direction: 1 | -1;
    amount: number;
    transactionDate: string;
  },
): void {
  const db = getDb();
  db.prepare(`
    UPDATE resource_transactions
    SET resource_type_id = ?, direction = ?, amount = ?, transaction_date = ?
    WHERE id = ? AND clan_id = ?
  `).run(
    updates.resourceTypeId ?? null,
    updates.direction,
    updates.amount,
    updates.transactionDate,
    id,
    clanId,
  );
}

export function getResourceSummary(opts: {
  clanId: number;
  from?: string;
  to?: string;
}): ResourceSummaryRow[] {
  const db = getDb();
  const conditions: string[] = ['rt.clan_id = ?'];
  const params: unknown[] = [opts.clanId];
  if (opts.from) { conditions.push('rt.transaction_date >= ?'); params.push(opts.from); }
  if (opts.to) { conditions.push('rt.transaction_date <= ?'); params.push(opts.to); }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT
      rt.member_id,
      m.name as member_name,
      rt.resource_type_id,
      rtype.name as resource_type_name,
      SUM(CASE WHEN rt.direction = 1 THEN rt.amount ELSE 0 END) as sent_amount,
      SUM(CASE WHEN rt.direction = -1 THEN rt.amount ELSE 0 END) as took_amount
    FROM resource_transactions rt
    JOIN members m ON m.id = rt.member_id
    LEFT JOIN resource_types rtype ON rtype.id = rt.resource_type_id
    ${where}
    GROUP BY rt.member_id, rt.resource_type_id
    ORDER BY m.name, rtype.name
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    memberId: r.member_id as number,
    memberName: r.member_name as string,
    resourceTypeId: (r.resource_type_id as number | null) ?? null,
    resourceTypeName: (r.resource_type_name as string | null) ?? null,
    sentAmount: (r.sent_amount as number) || 0,
    tookAmount: (r.took_amount as number) || 0,
    netAmount: ((r.sent_amount as number) || 0) - ((r.took_amount as number) || 0),
  }));
}

/**
 * Daily donation series: sent/took summed per (resource type, day) for the
 * over-time charts. Returns one row per resource-type-and-date so the client
 * can either plot a single resource or draw per-resource sparklines from one
 * response. Bucketing to week/month and gap-filling happen client-side.
 */
export function getResourceDailySeries(opts: {
  clanId: number;
  resourceTypeId?: number;
  memberId?: number;
  from?: string;
  to?: string;
}): ResourceDailyRow[] {
  const db = getDb();
  const conditions: string[] = ['rt.clan_id = ?'];
  const params: unknown[] = [opts.clanId];
  if (opts.resourceTypeId !== undefined) { conditions.push('rt.resource_type_id = ?'); params.push(opts.resourceTypeId); }
  if (opts.memberId !== undefined) { conditions.push('rt.member_id = ?'); params.push(opts.memberId); }
  if (opts.from) { conditions.push('rt.transaction_date >= ?'); params.push(opts.from); }
  if (opts.to) { conditions.push('rt.transaction_date <= ?'); params.push(opts.to); }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT
      rt.resource_type_id,
      rt.transaction_date,
      SUM(CASE WHEN rt.direction = 1 THEN rt.amount ELSE 0 END) as sent,
      SUM(CASE WHEN rt.direction = -1 THEN rt.amount ELSE 0 END) as took
    FROM resource_transactions rt
    ${where}
    GROUP BY rt.resource_type_id, rt.transaction_date
    ORDER BY rt.transaction_date ASC
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    resourceTypeId: (r.resource_type_id as number | null) ?? null,
    date: r.transaction_date as string,
    sent: (r.sent as number) || 0,
    took: (r.took as number) || 0,
  }));
}
