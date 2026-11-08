import { Router } from 'express';
import fs from 'fs';
import {
  listResourceTypes,
  UNTRACKED_RESOURCE_SLUGS,
  listTransactions,
  updateTransaction,
  getResourceSummary,
  getResourceDailySeries,
  listBatches,
  deleteBatch,
  clearCaptureCursor,
  getBatchSource,
  getRowCropPath,
} from '../../data/repositories/resource-repo.js';
import { logAction } from '../../data/repositories/user-repo.js';
import { resolveAllowedCropPath } from '../../utils/crop-dirs.js';
import { requireAdmin } from '../middleware/auth.js';

export function createResourcesDataRouter(): Router {
  const router = Router();

  // The GET routes below are read-only clan resource data and are available to
  // any authenticated clan member (the Overview + Totals dashboards). The two
  // mutating routes (edit transaction / delete batch) each guard with
  // requireAdmin so only admins can change data.
  //
  // Rows arrive only from the daily Clan Capital history read
  // (scheduler/resource-capture-phase.ts). The screenshot upload that used to
  // sit beside it was removed in Nov 2026: the read does the same job as well.

  /** List the trackable resource types (excludes clan-wide/untracked ones). */
  router.get('/types', (_req, res) => {
    const types = listResourceTypes().filter((t) => !UNTRACKED_RESOURCE_SLUGS.has(t.slug));
    res.json({ types });
  });

  /**
   * List resource transactions for this clan with optional filters.
   * Query params: memberId, resourceTypeId, direction (1|-1), from, to,
   *               sortBy (date|amount|member|resource), sortDir (asc|desc),
   *               limit (default 25), offset (default 0).
   */
  router.get('/transactions', (req, res) => {
    const clanId = req.clanId!;
    const q = req.query as Record<string, string>;

    const limit = Math.min(200, Math.max(1, Number.parseInt(q.limit ?? '25', 10) || 25));
    const offset = Math.max(0, Number.parseInt(q.offset ?? '0', 10) || 0);
    const memberId = q.memberId ? Number.parseInt(q.memberId, 10) : undefined;
    const batchId = q.batchId ? Number.parseInt(q.batchId, 10) : undefined;
    // 'unknown' is a sentinel meaning "resource_type_id IS NULL" (unmatched OCR).
    const wantsUnknown = q.resourceTypeId === 'unknown';
    const resourceTypeId = (!wantsUnknown && q.resourceTypeId) ? Number.parseInt(q.resourceTypeId, 10) : undefined;
    const rawDir = Number.parseInt(q.direction ?? '', 10);
    const direction = rawDir === 1 || rawDir === -1 ? rawDir : undefined;

    const { rows, total } = listTransactions({
      clanId,
      memberId: Number.isFinite(memberId ?? NaN) ? memberId : undefined,
      batchId: Number.isFinite(batchId ?? NaN) ? batchId : undefined,
      resourceTypeId: Number.isFinite(resourceTypeId ?? NaN) ? resourceTypeId : undefined,
      resourceTypeIsNull: wantsUnknown,
      direction,
      from: q.from || undefined,
      to: q.to || undefined,
      sortBy: ['date', 'amount', 'member', 'resource'].includes(q.sortBy)
        ? q.sortBy as 'date' | 'amount' | 'member' | 'resource'
        : 'date',
      sortDir: q.sortDir === 'asc' ? 'asc' : 'desc',
      limit,
      offset,
    });

    res.json({ rows, total, limit, offset });
  });

  /**
   * Aggregated resource summary grouped by member × resource type.
   * Query params: from, to (ISO date strings).
   */
  router.get('/summary', (req, res) => {
    const clanId = req.clanId!;
    const q = req.query as Record<string, string>;
    const rows = getResourceSummary({
      clanId,
      from: q.from || undefined,
      to: q.to || undefined,
    });
    res.json({ rows });
  });

  /**
   * Daily donation series (sent/took summed per resource type per day) for the
   * over-time charts. Query params: resourceTypeId, memberId, from, to.
   * Returns raw daily rows; the client buckets to week/month and gap-fills.
   */
  router.get('/daily', (req, res) => {
    const clanId = req.clanId!;
    const q = req.query as Record<string, string>;
    const resourceTypeId = q.resourceTypeId ? Number.parseInt(q.resourceTypeId, 10) : undefined;
    const memberId = q.memberId ? Number.parseInt(q.memberId, 10) : undefined;
    const rows = getResourceDailySeries({
      clanId,
      resourceTypeId: Number.isFinite(resourceTypeId ?? NaN) ? resourceTypeId : undefined,
      memberId: Number.isFinite(memberId ?? NaN) ? memberId : undefined,
      from: q.from || undefined,
      to: q.to || undefined,
    });
    res.json({ rows });
  });

  /** List upload batches for this clan (most recent first). */
  router.get('/batches', (req, res) => {
    res.json({ batches: listBatches(req.clanId!) });
  });

  /**
   * Update a single transaction's editable fields.
   * member_id is never changed here — only resource type, direction, amount, date.
   */
  router.patch('/transactions/:txId', requireAdmin, (req, res) => {
    const clanId = req.clanId!;
    const txId = Number.parseInt(String(req.params.txId), 10);
    if (!Number.isFinite(txId)) {
      res.status(400).json({ error: 'Invalid txId' });
      return;
    }

    const body = req.body ?? {};
    const rawDir = Number(body.direction);
    if (rawDir !== 1 && rawDir !== -1) {
      res.status(400).json({ error: 'direction must be 1 or -1' });
      return;
    }
    const rawAmount = Number(body.amount);
    if (!Number.isFinite(rawAmount) || rawAmount <= 0 || !Number.isInteger(rawAmount)) {
      res.status(400).json({ error: 'amount must be a positive integer' });
      return;
    }
    const date = String(body.transactionDate ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'transactionDate must be YYYY-MM-DD' });
      return;
    }
    const rtRaw = body.resourceTypeId;
    const rtId = rtRaw == null || rtRaw === '' ? null : Number.parseInt(String(rtRaw), 10);
    if (rtId !== null && !Number.isFinite(rtId)) {
      res.status(400).json({ error: 'Invalid resourceTypeId' });
      return;
    }

    try {
      updateTransaction(txId, clanId, {
        resourceTypeId: rtId,
        direction: rawDir as 1 | -1,
        amount: rawAmount,
        transactionDate: date,
      });
    } catch (err: unknown) {
      const sqliteErr = err as { code?: string };
      if (sqliteErr?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({ error: 'A transaction with these values already exists (duplicate).' });
        return;
      }
      throw err;
    }

    logAction(req.user!.id, 'resources.transaction.update', { clanId, txId });
    res.json({ ok: true });
  });

  /**
   * GET /transactions/:txId/crop — stream the saved screenshot row for a
   * transaction the importer left unresolved, for the admin hover preview.
   *
   * Same shape as the chest-side crop endpoint: the stored path is resolved and
   * then confined to UNRESOLVED_CROP_DIR, so a maliciously stored path can't be
   * used to read arbitrary files. Clan scoping happens in getRowCropPath.
   */
  router.get('/transactions/:txId/crop', requireAdmin, (req, res) => {
    const txId = Number.parseInt(String(req.params.txId), 10);
    if (!Number.isFinite(txId) || txId < 1) {
      res.status(400).json({ error: 'Invalid txId' });
      return;
    }
    const storedPath = getRowCropPath(txId, req.clanId!);
    if (!storedPath) {
      res.status(404).json({ error: 'No row crop recorded for this transaction' });
      return;
    }
    const resolved = resolveAllowedCropPath(storedPath);
    if (!resolved) {
      res.status(403).json({ error: 'Crop path is outside the allowed directory' });
      return;
    }
    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: 'Row crop file missing on disk' });
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(resolved).pipe(res);
  });

  /**
   * Delete a batch and all its transactions (clan-scoped).
   * The deleteBatch repo function includes clan_id in the WHERE clause.
   *
   * Deleting an AUTOMATED batch also forgets the capture's marker, and that pairing
   * is not optional. The marker means "everything below this was recorded"; deleting
   * the batch makes that false while the rows are still sitting in the game. Without
   * clearing it the next run stops at the marker, treats the deleted rows as already
   * held, and they are gone from the database for good once they age off the list
   * ~14 days later. Clearing it makes the next run read the whole visible window,
   * and the write-side withhold stops that re-read duplicating anything still held.
   *
   * Done HERE and not inside deleteBatch, deliberately: the capture phase calls
   * deleteBatch itself to clean up its own empty batch when a write fails, and that
   * runs BEFORE it saves the cursor — so a repo-level hook would throw away a
   * perfectly good marker on every write failure.
   */
  router.delete('/batches/:batchId', requireAdmin, (req, res) => {
    const clanId = req.clanId!;
    const batchId = Number.parseInt(String(req.params.batchId), 10);
    if (!Number.isFinite(batchId)) {
      res.status(400).json({ error: 'Invalid batchId' });
      return;
    }
    const wasScan = getBatchSource(batchId, clanId) === 'scan';
    deleteBatch(batchId, clanId);
    if (wasScan) clearCaptureCursor(clanId);
    logAction(req.user!.id, 'resources.batch.delete', { clanId, batchId, cursorCleared: wasScan });
    res.json({ ok: true, cursorCleared: wasScan });
  });

  return router;
}
