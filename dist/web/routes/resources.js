"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createResourcesDataRouter = createResourcesDataRouter;
const express_1 = require("express");
const fs_1 = __importDefault(require("fs"));
const crypto_1 = require("crypto");
const resource_repo_js_1 = require("../../data/repositories/resource-repo.js");
const member_repo_js_1 = require("../../data/repositories/member-repo.js");
const merge_repo_js_1 = require("../../data/repositories/merge-repo.js");
const clan_repo_js_1 = require("../../data/repositories/clan-repo.js");
const index_js_1 = require("../../config/index.js");
const game_day_js_1 = require("../../utils/game-day.js");
const calibration_js_1 = require("../../config/calibration.js");
const review_queue_repo_js_1 = require("../../data/repositories/review-queue-repo.js");
const user_repo_js_1 = require("../../data/repositories/user-repo.js");
const logger_js_1 = require("../../utils/logger.js");
const resource_upload_lock_js_1 = require("../../utils/resource-upload-lock.js");
const resource_ocr_js_1 = require("../../vision/resource-ocr.js");
const crop_dirs_js_1 = require("../../utils/crop-dirs.js");
const auth_js_1 = require("../middleware/auth.js");
const log = (0, logger_js_1.childLogger)('resources-route');
const MAX_UPLOAD_BASE64_BYTES = 27_000_000; // ~20MB decoded
function createResourcesDataRouter(scanLoop) {
    const router = (0, express_1.Router)();
    // The GET routes below are read-only clan resource data and are available to
    // any authenticated clan member (the Overview + Totals dashboards). The three
    // mutating routes (upload / edit transaction / delete batch) each guard with
    // requireAdmin so only admins can change data.
    /** List the trackable resource types (excludes clan-wide/untracked ones). */
    router.get('/types', (_req, res) => {
        const types = (0, resource_repo_js_1.listResourceTypes)().filter((t) => !resource_repo_js_1.UNTRACKED_RESOURCE_SLUGS.has(t.slug));
        res.json({ types });
    });
    /**
     * List resource transactions for this clan with optional filters.
     * Query params: memberId, resourceTypeId, direction (1|-1), from, to,
     *               sortBy (date|amount|member|resource), sortDir (asc|desc),
     *               limit (default 25), offset (default 0).
     */
    router.get('/transactions', (req, res) => {
        const clanId = req.clanId;
        const q = req.query;
        const limit = Math.min(200, Math.max(1, Number.parseInt(q.limit ?? '25', 10) || 25));
        const offset = Math.max(0, Number.parseInt(q.offset ?? '0', 10) || 0);
        const memberId = q.memberId ? Number.parseInt(q.memberId, 10) : undefined;
        const batchId = q.batchId ? Number.parseInt(q.batchId, 10) : undefined;
        // 'unknown' is a sentinel meaning "resource_type_id IS NULL" (unmatched OCR).
        const wantsUnknown = q.resourceTypeId === 'unknown';
        const resourceTypeId = (!wantsUnknown && q.resourceTypeId) ? Number.parseInt(q.resourceTypeId, 10) : undefined;
        const rawDir = Number.parseInt(q.direction ?? '', 10);
        const direction = rawDir === 1 || rawDir === -1 ? rawDir : undefined;
        const { rows, total } = (0, resource_repo_js_1.listTransactions)({
            clanId,
            memberId: Number.isFinite(memberId ?? NaN) ? memberId : undefined,
            batchId: Number.isFinite(batchId ?? NaN) ? batchId : undefined,
            resourceTypeId: Number.isFinite(resourceTypeId ?? NaN) ? resourceTypeId : undefined,
            resourceTypeIsNull: wantsUnknown,
            direction,
            from: q.from || undefined,
            to: q.to || undefined,
            sortBy: ['date', 'amount', 'member', 'resource'].includes(q.sortBy)
                ? q.sortBy
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
        const clanId = req.clanId;
        const q = req.query;
        const rows = (0, resource_repo_js_1.getResourceSummary)({
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
        const clanId = req.clanId;
        const q = req.query;
        const resourceTypeId = q.resourceTypeId ? Number.parseInt(q.resourceTypeId, 10) : undefined;
        const memberId = q.memberId ? Number.parseInt(q.memberId, 10) : undefined;
        const rows = (0, resource_repo_js_1.getResourceDailySeries)({
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
        res.json({ batches: (0, resource_repo_js_1.listBatches)(req.clanId) });
    });
    /**
     * Update a single transaction's editable fields.
     * member_id is never changed here — only resource type, direction, amount, date.
     */
    router.patch('/transactions/:txId', auth_js_1.requireAdmin, (req, res) => {
        const clanId = req.clanId;
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
            (0, resource_repo_js_1.updateTransaction)(txId, clanId, {
                resourceTypeId: rtId,
                direction: rawDir,
                amount: rawAmount,
                transactionDate: date,
            });
        }
        catch (err) {
            const sqliteErr = err;
            if (sqliteErr?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                res.status(409).json({ error: 'A transaction with these values already exists (duplicate).' });
                return;
            }
            throw err;
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'resources.transaction.update', { clanId, txId });
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
    router.get('/transactions/:txId/crop', auth_js_1.requireAdmin, (req, res) => {
        const txId = Number.parseInt(String(req.params.txId), 10);
        if (!Number.isFinite(txId) || txId < 1) {
            res.status(400).json({ error: 'Invalid txId' });
            return;
        }
        const storedPath = (0, resource_repo_js_1.getRowCropPath)(txId, req.clanId);
        if (!storedPath) {
            res.status(404).json({ error: 'No row crop recorded for this transaction' });
            return;
        }
        const resolved = (0, crop_dirs_js_1.resolveAllowedCropPath)(storedPath);
        if (!resolved) {
            res.status(403).json({ error: 'Crop path is outside the allowed directory' });
            return;
        }
        if (!fs_1.default.existsSync(resolved)) {
            res.status(404).json({ error: 'Row crop file missing on disk' });
            return;
        }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        fs_1.default.createReadStream(resolved).pipe(res);
    });
    /**
     * GET /capture-status — everything the Resources admin card needs to explain
     * the state of automated collection in one request: whether the feature is on,
     * whether calibration is finished (and what's outstanding if not), when the
     * last capture ran, how many rows are waiting to be resolved, and which dates
     * are double-counted between a manual upload and a capture.
     *
     * Available to any clan member because it's all read-only status the Resources
     * page already shows adjacent data for; the actions below are admin-gated.
     */
    router.get('/capture-status', (req, res) => {
        const clanId = req.clanId;
        const cfg = (0, index_js_1.loadConfig)();
        const cursor = (0, resource_repo_js_1.getCaptureCursor)(clanId);
        const clan = (0, clan_repo_js_1.getClanById)(clanId);
        res.json({
            enabled: cfg.resourceCaptureEnabled,
            clanEnabled: !!clan?.resourcesEnabled,
            // The per-clan "Include in the daily automatic read" switch from the Clans
            // page. Reported separately from `enabled` because the two gate different
            // things and only both together mean this clan's history gets read: the
            // instance-wide schedule can be on while this clan is excluded from it.
            // Defaults true to match the column default, so a clan predating the switch
            // reads as included rather than as opted out.
            clanAutoCapture: clan?.resourceAutoCapture ?? true,
            calibrated: (0, calibration_js_1.isResourceHistoryCalibrated)(),
            missingTargets: (0, calibration_js_1.missingResourceHistoryTargets)(),
            inProgress: !!scanLoop?.isResourceCaptureInProgress(),
            scanInProgress: !!scanLoop?.isScanInProgress(),
            currentGameDate: (0, game_day_js_1.currentGameDate)(cfg.gameDayRolloverUtcHour),
            lastCapture: cursor
                ? {
                    gameDate: cursor.gameDate,
                    capturedAt: cursor.capturedAt,
                    rowsInserted: cursor.rowsInserted,
                    cursorRows: cursor.topRows.length,
                }
                : null,
            unresolvedCount: (0, resource_repo_js_1.countUnresolvedTransactions)(clanId),
            overlaps: (0, resource_repo_js_1.listSourceOverlapDates)(clanId),
        });
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
    router.delete('/batches/:batchId', auth_js_1.requireAdmin, (req, res) => {
        const clanId = req.clanId;
        const batchId = Number.parseInt(String(req.params.batchId), 10);
        if (!Number.isFinite(batchId)) {
            res.status(400).json({ error: 'Invalid batchId' });
            return;
        }
        const wasScan = (0, resource_repo_js_1.getBatchSource)(batchId, clanId) === 'scan';
        (0, resource_repo_js_1.deleteBatch)(batchId, clanId);
        if (wasScan)
            (0, resource_repo_js_1.clearCaptureCursor)(clanId);
        (0, user_repo_js_1.logAction)(req.user.id, 'resources.batch.delete', { clanId, batchId, cursorCleared: wasScan });
        res.json({ ok: true, cursorCleared: wasScan });
    });
    /**
     * Upload and process one or more history screenshots via OCR.
     *
     * Body (JSON):
     *   images      {string[]} — One or more PNG/JPEG images, base64-encoded.
     *   uploadDate  {string?}  — ISO date (YYYY-MM-DD) that the screenshot's
     *                            "Today" header refers to. That header is rendered
     *                            client-side at the capturing browser's local
     *                            midnight, so this is the uploader's own calendar
     *                            date, NOT the 17:00-UTC game day — the UI sends
     *                            it explicitly for that reason. The fallback below
     *                            can only guess the server's UTC date.
     *
     * Response: NDJSON stream. Each line is a JSON object:
     *   { type: 'progress', current: N, total: N }   — after each screenshot
     *   { type: 'done', batchId, inserted, errors }  — final summary line
     *   { type: 'error', error: string }             — on fatal early errors
     *
     * All screenshots are stored as a single batch entry.
     */
    router.post('/upload', auth_js_1.requireAdmin, async (req, res) => {
        const clanId = req.clanId;
        const body = req.body ?? {};
        if (scanLoop?.isScanInProgress()) {
            res.status(409).json({ error: 'A scan is currently running. Please wait for it to finish before uploading screenshots.' });
            return;
        }
        const rawImages = Array.isArray(body.images) ? body.images : [];
        if (rawImages.length === 0) {
            res.status(400).json({ error: 'images[] is required' });
            return;
        }
        const imageBuffers = [];
        for (const raw of rawImages) {
            if (typeof raw !== 'string' || raw.length === 0) {
                res.status(400).json({ error: 'Each entry in images[] must be a non-empty base64 string' });
                return;
            }
            if (raw.length > MAX_UPLOAD_BASE64_BYTES) {
                res.status(413).json({ error: 'One or more images exceed the 20 MB limit' });
                return;
            }
            try {
                imageBuffers.push(Buffer.from(raw.replace(/^data:[^;]+;base64,/, ''), 'base64'));
            }
            catch {
                res.status(400).json({ error: 'Invalid base64 image data' });
                return;
            }
        }
        let uploadDate;
        if (typeof body.uploadDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.uploadDate)) {
            uploadDate = new Date(body.uploadDate + 'T00:00:00Z');
        }
        else {
            uploadDate = new Date();
            uploadDate.setUTCHours(0, 0, 0, 0);
        }
        const allTypes = (0, resource_repo_js_1.listResourceTypes)();
        const members = (0, member_repo_js_1.getAllMembers)(false, clanId);
        // Switch to NDJSON streaming so the client receives per-screenshot progress.
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.flushHeaders();
        const send = (obj) => res.write(JSON.stringify(obj) + '\n');
        (0, resource_upload_lock_js_1.acquireUploadSlot)();
        const allRows = [];
        const allErrors = [];
        const allUnmatchedNames = [];
        const total = imageBuffers.length;
        // Distinguishes this upload's row-crop filenames from any other upload's.
        const cropToken = `${Date.now().toString(36)}_${(0, crypto_1.randomUUID)().slice(0, 8)}`;
        try {
            for (let i = 0; i < total; i++) {
                let result;
                try {
                    result = await (0, resource_ocr_js_1.processResourceScreenshot)({
                        imageBuffer: imageBuffers[i], clanId, uploadDate, members, allTypes,
                        cropToken: `${cropToken}_i${i}`,
                    });
                }
                catch (err) {
                    log.error({ err }, 'resources-route: OCR pipeline failed for one image');
                    allErrors.push('OCR failed for one screenshot: ' + String(err));
                    send({ type: 'progress', current: i + 1, total });
                    continue;
                }
                allRows.push(...result.rows);
                allErrors.push(...result.errors);
                allUnmatchedNames.push(...result.unmatchedNames);
                send({ type: 'progress', current: i + 1, total });
            }
        }
        finally {
            (0, resource_upload_lock_js_1.releaseUploadSlot)();
        }
        // Names OCR couldn't tie to an existing member: create the member, exactly as a
        // normal scan does when it meets a name for the first time. These rows used to be
        // thrown away, silently losing the contribution. The new members surface in the
        // member review queue (driven by members.first_seen), and each row keeps a crop so
        // an admin can see the original and rename or merge from there.
        //
        // Through the clan's player merge rules first, the same way the automated
        // capture does. The OCR pass is handed a member list rather than a database so
        // it cannot see them, and without this an upload re-creates the exact name an
        // admin has already merged away.
        //
        // A rule OVERRIDES the match the OCR pass made rather than only filling in for a
        // miss: while a duplicate member row for the misread spelling still exists the
        // fuzzy match finds it, so a rule consulted only on the null path would never be
        // reached and the rows would keep landing on the duplicate.
        const canonicalisePlayerName = (0, merge_repo_js_1.loadPlayerNameCanonicaliser)(clanId);
        const createdMembers = new Map();
        const ruleResolved = new Map();
        for (const row of allRows) {
            const key = canonicalisePlayerName(row.rawPlayerName);
            const viaRule = key !== row.rawPlayerName;
            if (!viaRule && row.memberId != null)
                continue;
            const cache = viaRule ? ruleResolved : createdMembers;
            let id = cache.get(key);
            if (id === undefined) {
                id = (0, member_repo_js_1.upsertMember)(key, clanId).id;
                cache.set(key, id);
            }
            row.memberId = id;
        }
        if (ruleResolved.size > 0) {
            log.info('resources-route: resolved ' + ruleResolved.size + ' name(s) through a player merge rule: '
                + [...ruleResolved.keys()].map((n) => JSON.stringify(n)).join(', '));
        }
        if (createdMembers.size > 0) {
            (0, review_queue_repo_js_1.invalidateReviewQueueCount)(clanId);
            log.info(`resources-route: created ${createdMembers.size} new member(s) from unmatched names: ` +
                [...createdMembers.keys()].map((n) => JSON.stringify(n)).join(', '));
        }
        const uploadDateStr = uploadDate.toISOString().slice(0, 10);
        const batch = (0, resource_repo_js_1.createBatch)({
            clanId,
            uploadedBy: req.user.id,
            uploadDate: uploadDateStr,
            fileCount: total,
            rowCount: allRows.length,
            errorCount: allErrors.length,
            notes: '',
        });
        // Every row has a member by now — the loop above resolved the nulls.
        const { inserted } = (0, resource_repo_js_1.insertTransactions)(allRows.map((r) => ({
            clanId,
            batchId: batch.id,
            memberId: r.memberId,
            resourceTypeId: r.resourceTypeId,
            direction: r.direction,
            amount: r.amount,
            transactionDate: r.transactionDate,
            rawPlayerName: r.rawPlayerName,
            rowCropPath: r.rowCropPath ?? null,
        })));
        (0, user_repo_js_1.logAction)(req.user.id, 'resources.upload', {
            clanId, batchId: batch.id, fileCount: total, inserted,
            errors: allErrors.length, newMembers: createdMembers.size,
        });
        send({ type: 'done', ok: true, batchId: batch.id, inserted, errors: allErrors });
        res.end();
    });
    return router;
}
//# sourceMappingURL=resources.js.map