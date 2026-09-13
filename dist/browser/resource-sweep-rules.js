"use strict";
/**
 * The pure rules the resource sweep is built on: row identity, cursor anchoring,
 * and the write-side withhold.
 *
 * Split out of resource-history-capture.ts so `npm run build` can guard them.
 * The guard suite is `vitest run tests/config` and nothing else, and importing
 * resource-history-capture.ts pulls onnxruntime-node in at module scope (through
 * vision/resource-ocr.ts -> vision/paddle-service.ts). That import does work in a
 * test, so this is about keeping the one guaranteed check fast and dependency-free
 * rather than about a blocker. Nothing here may import anything but types.
 *
 * WHY THESE RULES EXIST, in one paragraph, because the shape is not guessable:
 *
 * The Clan Capital history list is ~14 days of immutable rows — EXCEPT for the
 * account-calendar day the game is still writing to. On that day, and only on that
 * day, a player's contributions merge into a single line: the amount grows through
 * the day, and the merged line moves back up the list. Measured across five deep
 * re-reads in a production database, rows on a SETTLED day re-read byte-identical
 * 250 times out of 253 with zero changed amounts, while 20% of the open day's
 * Scientific Tractates rows had vanished from their slot by the next run. So the
 * top of the list — which is where the cursor used to be taken from, and which the
 * sweep used to write — is the one region of the list that cannot be relied on.
 *
 * Everything below follows from that: anchor the cursor on the newest SETTLED row,
 * never write a row the game can still change, and keep a content-level withhold
 * behind both so that losing the anchor costs a re-read instead of a duplicate.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.REREAD_OPEN_DAY_DAYS = exports.DATE_BACKSTOP_MARGIN_DAYS = exports.ANCHOR_SAFE_STOP_REASONS = exports.CURSOR_MIN_RUN = exports.CURSOR_ROWS = void 0;
exports.rowFingerprint = rowFingerprint;
exports.fingerprintsAlign = fingerprintsAlign;
exports.sweepRowKey = sweepRowKey;
exports.looseSweepKey = looseSweepKey;
exports.looseRowKey = looseRowKey;
exports.firstSettledRowIndex = firstSettledRowIndex;
exports.buildCursorFingerprints = buildCursorFingerprints;
exports.maxDaysBackFor = maxDaysBackFor;
exports.readCompleteness = readCompleteness;
exports.withholdAlreadyRecorded = withholdAlreadyRecorded;
/**
 * How many rows the cursor stores, and the minimum run length that counts as a
 * match.
 *
 * The marker has to be long enough that it can't align anywhere else in a list of a
 * couple of thousand rows, and short enough to survive one OCR wobble inside it. 12
 * stored with 4 required gives both: the match is attempted at every offset in the
 * stored sequence, so a garbled row at the top of the previous run just shifts which
 * suffix matches rather than losing the cursor.
 */
exports.CURSOR_ROWS = 12;
exports.CURSOR_MIN_RUN = 4;
/**
 * Stable identity for one history row.
 *
 * Player name, direction, amount and resource — but NOT the date, because the
 * whole point of the cursor is to re-find rows across runs on which the same row
 * has aged from "TODAY" to "YESTERDAY". The raw OCR name is used rather than the
 * resolved member id so the fingerprint doesn't shift when an admin later merges
 * or renames a player.
 */
function rowFingerprint(row) {
    return `${looseRowKey(row)}|${row.resourceTypeId ?? UNRESOLVED_RESOURCE}`;
}
/**
 * The resource field a fingerprint carries when the icon could not be read.
 *
 * A named constant only because the cursor comparison has to recognise it inside a
 * STORED fingerprint string, where the row object it came from is long gone.
 */
const UNRESOLVED_RESOURCE = 'x';
/**
 * Whether two fingerprints — one stored in the cursor, one read this run — describe
 * the same physical row.
 *
 * Exact match, or the same row where one of the two reads failed to identify the
 * resource. That one-sided wildcard is the same rule the page stitch uses (rowsAlign),
 * and the cursor needs it for a structural reason rather than an incidental one: the
 * cursor is the TOP of the list as it was read last run, and the top row of a page is
 * the one the rectangle's edge clips, so those rows are the likeliest in the whole
 * sweep to have lost their icon. Next run the same rows sit further down with new rows
 * above them, get read cleanly, and gain the resource id the stored fingerprint never
 * had. Comparing by string equality therefore discards the marker precisely when it
 * matters — which is how a clan-1 daily run ended up ten days deep in history it had
 * already recorded.
 *
 * Two reads that BOTH resolved, to different resources, are different rows and never
 * align.
 */
function fingerprintsAlign(a, b) {
    if (a === b)
        return true;
    const cut = a.lastIndexOf('|');
    // Equal bodies imply an equal separator position, so a mismatch here is already a
    // different row and rejecting it costs nothing.
    if (cut < 0 || cut !== b.lastIndexOf('|'))
        return false;
    const aResource = a.slice(cut + 1);
    const bResource = b.slice(cut + 1);
    if (aResource !== UNRESOLVED_RESOURCE && bResource !== UNRESOLVED_RESOURCE)
        return false;
    return a.slice(0, cut) === b.slice(0, cut);
}
/**
 * Identity of a row WITHIN ONE SWEEP: everything, including the date.
 *
 * The date is the crucial difference from rowFingerprint, which omits it so the
 * cursor can re-find a row across runs as it ages from TODAY to YESTERDAY. That
 * omission is right for the cursor and catastrophic for de-duplicating a single
 * sweep, because plenty of rows repeat verbatim on different days — a player sending
 * "+1" Loyalty Level is identical every time they do it. Keying a sweep on the
 * date-free fingerprint therefore merged one player's day-3 and day-7 rows into one
 * (losing a real transaction), and worse, deleting rows out of the accumulated
 * list's TAIL meant its last N rows no longer lined up with the next page's first N,
 * so alignment collapsed and the sweep reported "shares no rows with the previous
 * page" on pages that plainly shared half their rows.
 *
 * Within one sweep a row's date label never changes, so including it is free.
 */
function sweepRowKey(row) {
    return `${looseSweepKey(row)}|${row.resourceTypeId ?? 'x'}`;
}
/** Sweep identity minus the resource, for pairing a resolved read with an
 *  icon-less one. Still date-scoped — see sweepRowKey. */
function looseSweepKey(row) {
    return `${looseRowKey(row)}|${row.transactionDate}`;
}
/**
 * The same row's identity WITHOUT its resource.
 *
 * Needed because the resource is the one field that can legitimately differ between
 * two reads of the SAME physical row: a row sliced by the top or bottom edge of the
 * rectangle keeps its name and amount but loses its icon, so it reads as
 * `feli|-1|5000|x` where the clean read on the neighbouring page gave
 * `feli|-1|5000|5`. Treating those as two different rows is what put ~2 spurious
 * "unknown" rows per page into the database — 117 of 503 on a real import — each one
 * also double-counting the amount.
 *
 * NOT usable as an identity on its own, which is why this is a separate function
 * rather than a change to rowFingerprint: a player really can send the same amount
 * of two DIFFERENT resources on the same day, and those adjacent rows ("Clau
 * +2,000,000" twice, observed) must stay distinct. So this is only ever used to
 * recognise a resolved/unresolved PAIR — see the alignment rule in stitchPage.
 */
function looseRowKey(row) {
    const name = row.rawPlayerName.trim().toLowerCase().replace(/\s+/g, '');
    return `${name}|${row.direction}|${row.amount}`;
}
/* ------------------------------------------------------------------ *
 *  Anchoring: which row the cursor is allowed to point at
 * ------------------------------------------------------------------ */
/**
 * Index of the first row the game has finished writing, or -1 if there is none.
 *
 * Deliberately "first row not on an open date" and NOT "skip the first block".
 * When nobody has donated yet on the current account-calendar day the list starts
 * with a settled block and must be anchored on directly — measured, 4 of the last
 * 35 clan-1 runs had an open block of zero rows.
 *
 * `openDates` is collected per page while sweeping rather than derived from the
 * finished list, because the stitch drops rows afterwards and a date whose only
 * surviving row was dropped must still count as open.
 */
function firstSettledRowIndex(rows, openDates) {
    for (let i = 0; i < rows.length; i++) {
        if (!openDates.has(rows[i].transactionDate))
            return i;
    }
    return -1;
}
/**
 * The fingerprints the next run will hunt for, taken from the newest SETTLED row.
 *
 * The old rule was `stitched.slice(0, CURSOR_ROWS)` — the top of the list — which is
 * by construction the block the game is still merging into. That is why the marker
 * kept evaporating: on 2026-09-05 exactly 2 of its 12 rows were still findable,
 * because the other ten had grown an amount or moved up the list. Replaying the same
 * matcher against a settled anchor re-found it in every measurable case at 11-12 of
 * 12.
 *
 * Returns an EMPTY array rather than a short one when there are fewer than
 * CURSOR_MIN_RUN rows below the anchor: the matcher will not attempt a needle shorter
 * than that, so a 1-3 row marker is guaranteed unmatchable next run and would silently
 * arm a full-window duplicate sweep. Empty means "read everything", which is the safe
 * direction.
 *
 * Spilling out of a short settled block into the next-older one is intended — those
 * rows are settled too, and a marker that spans a day boundary is still immutable.
 */
function buildCursorFingerprints(rows, openDates) {
    const at = firstSettledRowIndex(rows, openDates);
    if (at < 0)
        return { fingerprints: [], anchorAt: -1, anchorDate: null };
    const slice = rows.slice(at, at + exports.CURSOR_ROWS);
    if (slice.length < exports.CURSOR_MIN_RUN)
        return { fingerprints: [], anchorAt: at, anchorDate: null };
    return {
        fingerprints: slice.map((r) => r.fingerprint),
        anchorAt: at,
        anchorDate: rows[at].transactionDate,
    };
}
/**
 * Stop reasons after which it is safe to move the stored marker forward.
 *
 * The marker is a promise that everything BELOW it has been recorded, so it may only
 * advance when the sweep actually read the ground between the new anchor and where it
 * stopped. Three reasons qualify:
 *
 *   'cursor'      — reached the previous marker; everything below it was recorded then.
 *   'end-of-list' — read the whole visible list; there is nothing below.
 *   'date-floor'  — stopped BELOW the anchor, deeper than this run should have needed.
 *                   Ugly, and always a symptom, but the region between the new anchor
 *                   and the stopping point WAS read, which is the only property that
 *                   matters here.
 *
 * The ones deliberately missing — 'blank', 'crashed', 'page-limit', 'no-new-rows',
 * 'error' — all stop with unread rows still below the new anchor. Advancing over
 * those would put them below every future cut, permanently: a sweep the idle overlay
 * kills after 30 rows of a 180-row day would write 30 rows, anchor above the other
 * 150, and no run would ever read them again. Today that is survivable only because
 * the volatile marker usually gets lost and forces a re-sweep — an accident this
 * change removes, so the guard has to replace it.
 */
exports.ANCHOR_SAFE_STOP_REASONS = new Set([
    'cursor',
    'end-of-list',
    'date-floor',
]);
/**
 * How far back the date backstop lets a sweep read before it gives up.
 *
 * DATE_BACKSTOP_MARGIN_DAYS moved here from resource-capture-phase.ts unchanged. The
 * history list's day headers follow the game ACCOUNT's calendar day while `gameDate`
 * follows the 17:00 UTC reset, so a row can legitimately carry a label a day either
 * side of the game day it belongs to, and a scheduled run that slips across a
 * rollover can add another. Two days absorbs both.
 *
 * REREAD_OPEN_DAY_DAYS is new and is a SEPARATE constant on purpose, so the day this
 * design deliberately re-reads stays legible and cannot be tidied away as slack. The
 * anchor now sits one settled day behind the newest rows, so every healthy run reads
 * one day deeper than "days since the marker was stored" — that is the cost of never
 * writing a row the game can still change.
 */
exports.DATE_BACKSTOP_MARGIN_DAYS = 2;
exports.REREAD_OPEN_DAY_DAYS = 1;
function maxDaysBackFor(markerAgeDays) {
    return markerAgeDays + exports.REREAD_OPEN_DAY_DAYS + exports.DATE_BACKSTOP_MARGIN_DAYS;
}
/* ------------------------------------------------------------------ *
 *  Completeness: which dates this read is entitled to reason about
 * ------------------------------------------------------------------ */
/**
 * Dates whose ENTIRE block this sweep read, and may therefore compare against the
 * database.
 *
 * This is the safety precondition for the withhold below, and it is the objection
 * that sinks every naive version of it. `insert = max(0, read - stored)` is sound
 * only when `read` covers the whole date: if the sweep saw one of a player's two
 * identical Loyalty Level "+1" rows because it stopped mid-block, subtracting a
 * stored copy deletes a real transaction.
 *
 * A date qualifies when all three hold:
 *
 *   - the read is date-monotone. Dates must be non-increasing down the list, which is
 *     true of 34 of 35 real scan batches; the one exception is a known-bad early
 *     build. A non-monotone read means a day header was misread and the blocks are
 *     interleaved, so nothing can be trusted to be bounded. Cheap, high-precision.
 *   - the date is not the OLDEST one read, unless the sweep ran to 'end-of-list'.
 *     The oldest block is the one the sweep stopped inside.
 *   - no row carrying that date sits at or below `cut`. The cut is where the previous
 *     marker was found, so a date straddling it was only partly re-read this time.
 *
 * Fails toward inserting, never toward suppressing: an empty set means the withhold
 * does nothing at all, which is the pre-existing behaviour.
 */
function readCompleteness(rows, cut, stopReason) {
    if (rows.length === 0)
        return { completeDates: new Set(), oldestDateRead: '', monotone: true };
    let monotone = true;
    for (let i = 1; i < rows.length; i++) {
        if (rows[i].transactionDate > rows[i - 1].transactionDate) {
            monotone = false;
            break;
        }
    }
    const oldestDateRead = rows[rows.length - 1].transactionDate;
    if (!monotone)
        return { completeDates: new Set(), oldestDateRead, monotone };
    const belowCut = new Set();
    for (let i = Math.max(0, cut); i < rows.length; i++)
        belowCut.add(rows[i].transactionDate);
    const completeDates = new Set();
    for (let i = 0; i < Math.min(cut, rows.length); i++) {
        const d = rows[i].transactionDate;
        if (belowCut.has(d))
            continue;
        if (d === oldestDateRead && stopReason !== 'end-of-list')
            continue;
        completeDates.add(d);
    }
    return { completeDates, oldestDateRead, monotone };
}
/* ------------------------------------------------------------------ *
 *  The withhold: never insert a row this clan already holds
 * ------------------------------------------------------------------ */
/**
 * Drop rows this clan already holds, so a lost anchor costs a re-read and not a
 * duplicate.
 *
 * Defence in depth, not the fix. The fix is that the anchor no longer sits on rows
 * that move; this is what makes the failure survivable when it happens anyway — and
 * it has happened roughly weekly (clan 1 batches 87, 97, 109, 133, 145, 153, 157).
 * Replayed over that clan's real history it suppresses 778 of 5,908 rows, every one
 * of them inside a batch whose notes already say "previous position not re-found",
 * and zero across the 30 healthy runs.
 *
 * MULTIPLICITY, NOT MEMBERSHIP. A player really can hold several identical rows on
 * one day — 147 such cases in production, mostly Hermes' Loyalty Level "+1" — and
 * migration v39 dropped the UNIQUE key precisely so they could. So this consumes:
 * read m copies, hold n, insert m-n. Two identical rows of which one is stored
 * insert exactly one.
 *
 * CONSUMPTION IS PER STORED ROW, not per key-count map. An earlier design kept three
 * count maps (exact / loose-resolved / loose-unresolved) built from the same rows and
 * decremented each independently, which let ONE stored row satisfy two different
 * incoming claims and silently swallow a genuine second transaction.
 *
 * THE UNRESOLVED WILDCARD IS ONE-DIRECTIONAL. An incoming row that DID read its icon
 * may consume a stored row that did not — that is the same physical row, read better
 * this time, and pairing them stops a phantom "unknown" duplicate. The reverse is
 * refused: an incoming row with no icon must never consume a stored, resolved row,
 * because "Clau +2,000,000" twice on one day with two different resources is an
 * observed live case and the icon-less read of the second one is a real transaction.
 * Erring here costs an unresolved row an admin can resolve; erring the other way
 * loses data silently.
 *
 * Surviving rows keep their original order — the list is newest-first and several
 * callers depend on that.
 */
function withholdAlreadyRecorded(rows, recorded, completeDates) {
    if (rows.length === 0 || recorded.length === 0 || completeDates.size === 0) {
        return { rows: [...rows], withheld: 0, byDate: {} };
    }
    // One bucket per loose key (name|direction|amount|date), holding the stored rows
    // themselves so a row can be consumed exactly once however it is claimed.
    const buckets = new Map();
    for (const r of recorded) {
        if (!completeDates.has(r.transactionDate))
            continue;
        const k = looseSweepKey(r);
        const bucket = buckets.get(k);
        if (bucket)
            bucket.push({ row: r, used: false });
        else
            buckets.set(k, [{ row: r, used: false }]);
    }
    /** Consume one unused stored row for `row`, exactly-matching the resource or not. */
    const take = (row, wantExact) => {
        const bucket = buckets.get(looseSweepKey(row));
        if (!bucket)
            return false;
        for (const entry of bucket) {
            if (entry.used)
                continue;
            const sameResource = (entry.row.resourceTypeId ?? null) === (row.resourceTypeId ?? null);
            if (wantExact ? !sameResource : entry.row.resourceTypeId != null)
                continue;
            entry.used = true;
            return true;
        }
        return false;
    };
    const withheldAt = new Array(rows.length).fill(false);
    const byDate = {};
    const drop = (i) => {
        withheldAt[i] = true;
        const d = rows[i].transactionDate;
        byDate[d] = (byDate[d] ?? 0) + 1;
    };
    // Pass 1, exact: same resource, including unresolved-vs-unresolved (both null).
    const pending = [];
    for (let i = 0; i < rows.length; i++) {
        if (!completeDates.has(rows[i].transactionDate))
            continue;
        if (take(rows[i], true))
            drop(i);
        else
            pending.push(i);
    }
    // Pass 2, the one-directional wildcard: an incoming row that resolved may claim a
    // stored row that did not. Runs after pass 1 so an exact match always wins the
    // stored row it belongs to.
    for (const i of pending) {
        if (rows[i].resourceTypeId != null && take(rows[i], false))
            drop(i);
    }
    const kept = rows.filter((_, i) => !withheldAt[i]);
    return { rows: kept, withheld: rows.length - kept.length, byDate };
}
//# sourceMappingURL=resource-sweep-rules.js.map