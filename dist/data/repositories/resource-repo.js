"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNTRACKED_RESOURCE_SLUGS = void 0;
exports.listResourceTypes = listResourceTypes;
exports.getIconTemplate = getIconTemplate;
exports.setIconTemplate = setIconTemplate;
exports.deleteIconTemplate = deleteIconTemplate;
exports.listIconTemplateStatus = listIconTemplateStatus;
exports.createBatch = createBatch;
exports.updateBatchCounts = updateBatchCounts;
exports.insertTransactions = insertTransactions;
exports.listTransactions = listTransactions;
exports.listBatches = listBatches;
exports.getCaptureCursor = getCaptureCursor;
exports.saveCaptureCursor = saveCaptureCursor;
exports.listSourceOverlapDates = listSourceOverlapDates;
exports.listRecordedScanRows = listRecordedScanRows;
exports.clearCaptureCursor = clearCaptureCursor;
exports.getBatchSource = getBatchSource;
exports.countUnresolvedTransactions = countUnresolvedTransactions;
exports.deleteBatch = deleteBatch;
exports.getRowCropPath = getRowCropPath;
exports.updateTransaction = updateTransaction;
exports.getResourceSummary = getResourceSummary;
exports.getResourceDailySeries = getResourceDailySeries;
const fs_1 = __importDefault(require("fs"));
const database_js_1 = require("../database.js");
const logger_js_1 = require("../../utils/logger.js");
const log = (0, logger_js_1.childLogger)('resource-repo');
/**
 * Resource types that exist in the game but are NOT tracked per member —
 * they're clan-wide, so attributing them to individual members is noise.
 * Kept in resource_types (so OCR can still recognise and skip them, and
 * historical rows resolve their name), but hidden from the /types endpoint
 * and dropped during OCR extraction.
 */
exports.UNTRACKED_RESOURCE_SLUGS = new Set(['seal-of-suppression']);
function listResourceTypes() {
    const db = (0, database_js_1.getDb)();
    return db.prepare('SELECT id, name, slug FROM resource_types ORDER BY id').all();
}
function getIconTemplate(clanId, resourceTypeId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT template_data FROM resource_icon_templates WHERE clan_id = ? AND resource_type_id = ?').get(clanId, resourceTypeId);
    return row ? row.template_data : null;
}
function setIconTemplate(clanId, resourceTypeId, templateData) {
    const db = (0, database_js_1.getDb)();
    const now = new Date().toISOString();
    db.prepare(`
    INSERT INTO resource_icon_templates (clan_id, resource_type_id, template_data, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(clan_id, resource_type_id) DO UPDATE SET
      template_data = excluded.template_data,
      updated_at = excluded.updated_at
  `).run(clanId, resourceTypeId, templateData, now);
}
function deleteIconTemplate(clanId, resourceTypeId) {
    const db = (0, database_js_1.getDb)();
    db.prepare('DELETE FROM resource_icon_templates WHERE clan_id = ? AND resource_type_id = ?').run(clanId, resourceTypeId);
}
function listIconTemplateStatus(clanId) {
    const db = (0, database_js_1.getDb)();
    const types = listResourceTypes();
    const existing = db.prepare('SELECT resource_type_id, updated_at FROM resource_icon_templates WHERE clan_id = ?').all(clanId);
    const existingMap = new Map(existing.map((r) => [r.resource_type_id, r.updated_at]));
    return types.map((t) => ({
        resourceTypeId: t.id,
        hasTemplate: existingMap.has(t.id),
        updatedAt: existingMap.get(t.id) ?? null,
    }));
}
function createBatch(opts) {
    const db = (0, database_js_1.getDb)();
    const now = new Date().toISOString();
    const source = opts.source ?? 'upload';
    const result = db.prepare(`
    INSERT INTO resource_upload_batches
      (clan_id, uploaded_by, uploaded_at, upload_date, file_count, row_count,
       error_count, notes, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(opts.clanId, opts.uploadedBy, now, opts.uploadDate, opts.fileCount, opts.rowCount, opts.errorCount, opts.notes, source);
    return {
        id: result.lastInsertRowid,
        clanId: opts.clanId,
        uploadedBy: opts.uploadedBy,
        uploadedAt: now,
        uploadDate: opts.uploadDate,
        fileCount: opts.fileCount,
        rowCount: opts.rowCount,
        errorCount: opts.errorCount,
        notes: opts.notes,
        source,
    };
}
/** Update a batch's counters after the fact. The automated capture creates its
 *  batch up front (rows need a batch_id to reference) and only knows the final
 *  totals once every scroll page has been read. */
function updateBatchCounts(batchId, counts) {
    const db = (0, database_js_1.getDb)();
    db.prepare(`
    UPDATE resource_upload_batches
    SET file_count = ?, row_count = ?, error_count = ?, notes = ?
    WHERE id = ?
  `).run(counts.fileCount, counts.rowCount, counts.errorCount, counts.notes, batchId);
}
function insertTransactions(rows) {
    if (rows.length === 0)
        return { inserted: 0, skipped: 0 };
    const db = (0, database_js_1.getDb)();
    const now = new Date().toISOString();
    const stmt = db.prepare(`
    INSERT INTO resource_transactions
      (clan_id, batch_id, member_id, resource_type_id, direction, amount,
       transaction_date, raw_player_name, created_at, row_crop_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const tx = db.transaction(() => {
        for (const r of rows) {
            stmt.run(r.clanId, r.batchId, r.memberId, r.resourceTypeId ?? null, r.direction, r.amount, r.transactionDate, r.rawPlayerName, now, r.rowCropPath ?? null);
        }
    });
    tx();
    return { inserted: rows.length, skipped: 0 };
}
function listTransactions(opts) {
    const db = (0, database_js_1.getDb)();
    const conditions = ['rt.clan_id = ?'];
    const params = [opts.clanId];
    if (opts.memberId !== undefined) {
        conditions.push('rt.member_id = ?');
        params.push(opts.memberId);
    }
    if (opts.batchId !== undefined) {
        conditions.push('rt.batch_id = ?');
        params.push(opts.batchId);
    }
    if (opts.resourceTypeIsNull) {
        conditions.push('rt.resource_type_id IS NULL');
    }
    else if (opts.resourceTypeId !== undefined) {
        conditions.push('rt.resource_type_id = ?');
        params.push(opts.resourceTypeId);
    }
    if (opts.direction !== undefined) {
        conditions.push('rt.direction = ?');
        params.push(opts.direction);
    }
    if (opts.from) {
        conditions.push('rt.transaction_date >= ?');
        params.push(opts.from);
    }
    if (opts.to) {
        conditions.push('rt.transaction_date <= ?');
        params.push(opts.to);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const validSorts = {
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
    const total = db.prepare(`SELECT COUNT(*) as c ${base}`).get(...params).c;
    const rows = db.prepare(`
    SELECT rt.id, rt.clan_id, rt.batch_id, rt.member_id, m.name as member_name,
           rt.resource_type_id, rtype.name as resource_type_name, rtype.slug as resource_type_slug,
           rt.direction, rt.amount, rt.transaction_date, rt.raw_player_name, rt.created_at,
           rt.row_crop_path
    ${base}
    ${order}
    LIMIT ? OFFSET ?
  `).all(...params, opts.limit, opts.offset);
    return {
        total,
        rows: rows.map((r) => ({
            id: r.id,
            clanId: r.clan_id,
            batchId: r.batch_id,
            memberId: r.member_id,
            memberName: r.member_name,
            resourceTypeId: r.resource_type_id ?? null,
            resourceTypeName: r.resource_type_name ?? null,
            resourceTypeSlug: r.resource_type_slug ?? null,
            direction: r.direction,
            amount: r.amount,
            transactionDate: r.transaction_date,
            rawPlayerName: r.raw_player_name,
            createdAt: r.created_at,
            hasCrop: Boolean(r.row_crop_path),
        })),
    };
}
function listBatches(clanId) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare('SELECT * FROM resource_upload_batches WHERE clan_id = ? ORDER BY uploaded_at DESC').all(clanId);
    return rows.map((r) => ({
        id: r.id,
        clanId: r.clan_id,
        uploadedBy: r.uploaded_by,
        uploadedAt: r.uploaded_at,
        uploadDate: r.upload_date,
        fileCount: r.file_count ?? 1,
        rowCount: r.row_count,
        errorCount: r.error_count,
        notes: r.notes,
        source: (r.source ?? 'upload'),
    }));
}
function getCaptureCursor(clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT * FROM resource_capture_cursor WHERE clan_id = ?').get(clanId);
    if (!row)
        return null;
    let topRows = [];
    try {
        const parsed = JSON.parse(row.top_rows);
        if (Array.isArray(parsed))
            topRows = parsed.filter((v) => typeof v === 'string');
    }
    catch {
        // A corrupt cursor must not wedge the capture: an empty marker degrades to
        // "read the whole window", which is the safe direction (it re-reads rather
        // than skipping) and the caller reports it as a lost cursor.
        log.warn(`resource-repo: capture cursor for clan #${clanId} is not valid JSON; ignoring it.`);
    }
    return {
        clanId,
        topRows,
        gameDate: row.game_date,
        capturedAt: row.captured_at,
        newestDate: row.newest_date ?? '',
        rowsInserted: row.rows_inserted ?? 0,
    };
}
function saveCaptureCursor(cursor) {
    const db = (0, database_js_1.getDb)();
    db.prepare(`
    INSERT INTO resource_capture_cursor
      (clan_id, top_rows, game_date, captured_at, newest_date, rows_inserted)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(clan_id) DO UPDATE SET
      top_rows      = excluded.top_rows,
      game_date     = excluded.game_date,
      captured_at   = excluded.captured_at,
      newest_date   = excluded.newest_date,
      rows_inserted = excluded.rows_inserted
  `).run(cursor.clanId, JSON.stringify(cursor.topRows), cursor.gameDate, new Date().toISOString(), cursor.newestDate, cursor.rowsInserted);
}
/**
 * Dates that have rows from BOTH a manual upload and the automated capture.
 *
 * Neither source is treated as authoritative — the automated capture is
 * insert-only and never touches upload rows — so an overlap means those dates
 * are double-counted until an admin deletes one of the batches. Surfaced in the
 * admin UI rather than resolved silently, because which side to drop depends on
 * which one the admin trusts, and the automated one is brand new.
 */
function listSourceOverlapDates(clanId) {
    const db = (0, database_js_1.getDb)();
    return db.prepare(`
    SELECT rt.transaction_date AS transactionDate,
           SUM(CASE WHEN b.source = 'scan' THEN 0 ELSE 1 END) AS uploadRows,
           SUM(CASE WHEN b.source = 'scan' THEN 1 ELSE 0 END) AS scanRows
      FROM resource_transactions rt
      JOIN resource_upload_batches b ON b.id = rt.batch_id
     WHERE rt.clan_id = ?
     GROUP BY rt.transaction_date
    HAVING uploadRows > 0 AND scanRows > 0
     ORDER BY rt.transaction_date DESC
  `).all(clanId);
}
/**
 * Every scan-written row for this clan from `fromDate` onwards, as identity fields.
 *
 * Feeds the capture's write-side withhold: rows read again that this clan already
 * holds are declined rather than inserted, so losing the sweep's marker costs a
 * re-read instead of a duplicate batch an admin has to find and delete.
 *
 * `source = 'scan'` is a hard boundary, not an optimisation. A manual upload must
 * never suppress a scan read: the two sources are deliberately independent and their
 * overlap is REPORTED for an admin to resolve (see listSourceOverlapDates above), so
 * silently resolving it in the upload's favour here would delete that decision.
 *
 * Keys are built in JS rather than SQL because they despace and lowercase the name,
 * and SQLite's LOWER is ASCII-only — v66 made a despaced key the identity everywhere.
 * Served by idx_resource_transactions_date(clan_id, transaction_date); a 14-day
 * window is a couple of thousand rows.
 */
function listRecordedScanRows(clanId, fromDate) {
    const db = (0, database_js_1.getDb)();
    return db.prepare(`
    SELECT rt.raw_player_name  AS rawPlayerName,
           rt.direction        AS direction,
           rt.amount           AS amount,
           rt.transaction_date AS transactionDate,
           rt.resource_type_id AS resourceTypeId
      FROM resource_transactions rt
      JOIN resource_upload_batches b ON b.id = rt.batch_id
     WHERE rt.clan_id = ? AND rt.transaction_date >= ? AND b.source = 'scan'
  `).all(clanId, fromDate);
}
/**
 * Forget where the capture got to, so the next run reads the whole visible list.
 *
 * The recovery move after a capture batch is deleted. The marker points at rows that
 * ARE in the game but are no longer in the database, so leaving it would make the
 * next run stop there and treat the deleted rows as already recorded — losing them
 * from the database while they sit readable in the game for another fortnight.
 *
 * Safe to call at any time: a missing cursor means "read everything, no date backstop
 * armed", which re-reads rather than skips, and the write-side withhold stops that
 * re-read duplicating anything still held.
 */
function clearCaptureCursor(clanId) {
    (0, database_js_1.getDb)().prepare('DELETE FROM resource_capture_cursor WHERE clan_id = ?').run(clanId);
}
/** The `source` of one batch, or null when it isn't this clan's. */
function getBatchSource(batchId, clanId) {
    const row = (0, database_js_1.getDb)().prepare('SELECT source FROM resource_upload_batches WHERE id = ? AND clan_id = ?').get(batchId, clanId);
    return row?.source ?? null;
}
/** How many rows in this clan are still missing a resource type — the standing
 *  "unresolved" count the admin card and nav dot read. */
function countUnresolvedTransactions(clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT COUNT(*) AS n FROM resource_transactions WHERE clan_id = ? AND resource_type_id IS NULL').get(clanId);
    return row.n;
}
function deleteBatch(batchId, clanId) {
    const db = (0, database_js_1.getDb)();
    // Collect the row-crop files before the rows go, otherwise the paths are lost and
    // the PNGs stay on disk forever. Deleted after the transaction commits: a failed
    // unlink must not roll back the delete, and an orphaned file is far cheaper than
    // a DB row pointing at a file that's already gone.
    const cropPaths = db.prepare('SELECT row_crop_path FROM resource_transactions WHERE batch_id = ? AND clan_id = ? AND row_crop_path IS NOT NULL').all(batchId, clanId).map((r) => r.row_crop_path);
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM resource_transactions WHERE batch_id = ? AND clan_id = ?').run(batchId, clanId);
        db.prepare('DELETE FROM resource_upload_batches WHERE id = ? AND clan_id = ?').run(batchId, clanId);
    });
    tx();
    for (const p of cropPaths) {
        try {
            fs_1.default.rmSync(p, { force: true });
        }
        catch (err) {
            log.debug(`resource-repo: could not remove row crop ${p}: ${String(err)}`);
        }
    }
}
/**
 * On-disk path of the row-crop PNG for one transaction, or null. Clan-scoped so an
 * admin in clan A can't read clan B's crops by guessing transaction ids.
 */
function getRowCropPath(txId, clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT row_crop_path FROM resource_transactions WHERE id = ? AND clan_id = ?').get(txId, clanId);
    return row?.row_crop_path ?? null;
}
function updateTransaction(id, clanId, updates) {
    const db = (0, database_js_1.getDb)();
    db.prepare(`
    UPDATE resource_transactions
    SET resource_type_id = ?, direction = ?, amount = ?, transaction_date = ?
    WHERE id = ? AND clan_id = ?
  `).run(updates.resourceTypeId ?? null, updates.direction, updates.amount, updates.transactionDate, id, clanId);
}
function getResourceSummary(opts) {
    const db = (0, database_js_1.getDb)();
    const conditions = ['rt.clan_id = ?'];
    const params = [opts.clanId];
    if (opts.from) {
        conditions.push('rt.transaction_date >= ?');
        params.push(opts.from);
    }
    if (opts.to) {
        conditions.push('rt.transaction_date <= ?');
        params.push(opts.to);
    }
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
  `).all(...params);
    return rows.map((r) => ({
        memberId: r.member_id,
        memberName: r.member_name,
        resourceTypeId: r.resource_type_id ?? null,
        resourceTypeName: r.resource_type_name ?? null,
        sentAmount: r.sent_amount || 0,
        tookAmount: r.took_amount || 0,
        netAmount: (r.sent_amount || 0) - (r.took_amount || 0),
    }));
}
/**
 * Daily donation series: sent/took summed per (resource type, day) for the
 * over-time charts. Returns one row per resource-type-and-date so the client
 * can either plot a single resource or draw per-resource sparklines from one
 * response. Bucketing to week/month and gap-filling happen client-side.
 */
function getResourceDailySeries(opts) {
    const db = (0, database_js_1.getDb)();
    const conditions = ['rt.clan_id = ?'];
    const params = [opts.clanId];
    if (opts.resourceTypeId !== undefined) {
        conditions.push('rt.resource_type_id = ?');
        params.push(opts.resourceTypeId);
    }
    if (opts.memberId !== undefined) {
        conditions.push('rt.member_id = ?');
        params.push(opts.memberId);
    }
    if (opts.from) {
        conditions.push('rt.transaction_date >= ?');
        params.push(opts.from);
    }
    if (opts.to) {
        conditions.push('rt.transaction_date <= ?');
        params.push(opts.to);
    }
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
  `).all(...params);
    return rows.map((r) => ({
        resourceTypeId: r.resource_type_id ?? null,
        date: r.transaction_date,
        sent: r.sent || 0,
        took: r.took || 0,
    }));
}
//# sourceMappingURL=resource-repo.js.map