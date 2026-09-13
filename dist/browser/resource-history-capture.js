"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sweepRowKey = exports.rowFingerprint = exports.looseSweepKey = exports.looseRowKey = exports.fingerprintsAlign = void 0;
exports.stitchPage = stitchPage;
exports.pruneUnreferencedCrops = pruneUnreferencedCrops;
exports.dedupeNearbyRepeats = dedupeNearbyRepeats;
exports.collapseUnresolvedTwins = collapseUnresolvedTwins;
exports.findCursorIndex = findCursorIndex;
exports.describeCursorNearMiss = describeCursorNearMiss;
exports.isOnWorldMap = isOnWorldMap;
exports.advanceDateLabel = advanceDateLabel;
exports.daysAgoFromLabel = daysAgoFromLabel;
exports.captureResourceHistory = captureResourceHistory;
const sharp_1 = __importDefault(require("sharp"));
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = require("fs");
const path_1 = require("path");
const screenshotter_js_1 = require("./screenshotter.js");
const member_capture_js_1 = require("./member-capture.js");
const navigator_js_1 = require("./navigator.js");
const human_delay_js_1 = require("../utils/human-delay.js");
const input_js_1 = require("./input.js");
const logger_js_1 = require("../utils/logger.js");
const calibration_js_1 = require("../config/calibration.js");
const game_day_js_1 = require("../utils/game-day.js");
const paddle_service_js_1 = require("../vision/paddle-service.js");
const resource_ocr_js_1 = require("../vision/resource-ocr.js");
const resource_sweep_rules_js_1 = require("./resource-sweep-rules.js");
// Re-exported so the many existing importers (and tests) don't have to know these
// moved. resource-sweep-rules.ts is where they live and where they are guarded.
var resource_sweep_rules_js_2 = require("./resource-sweep-rules.js");
Object.defineProperty(exports, "fingerprintsAlign", { enumerable: true, get: function () { return resource_sweep_rules_js_2.fingerprintsAlign; } });
Object.defineProperty(exports, "looseRowKey", { enumerable: true, get: function () { return resource_sweep_rules_js_2.looseRowKey; } });
Object.defineProperty(exports, "looseSweepKey", { enumerable: true, get: function () { return resource_sweep_rules_js_2.looseSweepKey; } });
Object.defineProperty(exports, "rowFingerprint", { enumerable: true, get: function () { return resource_sweep_rules_js_2.rowFingerprint; } });
Object.defineProperty(exports, "sweepRowKey", { enumerable: true, get: function () { return resource_sweep_rules_js_2.sweepRowKey; } });
const log = (0, logger_js_1.childLogger)('resource-capture');
/**
 * Hard backstop on scroll pages, not the expected stop condition.
 *
 * Sized from a measured full sweep, not a guess: ~205 rows/day on a busy clan, and
 * the rectangle advances the list by 5-9 NEW rows per page (18-19 read with ~65%
 * overlap). Fourteen days is therefore ~2,900 rows and 330-440 pages.
 *
 * 700 leaves real headroom above that, because every previous value was set too low
 * and truncated silently: 150 would have cut a full backfill off at a third, and 400
 * sat just under the observed requirement — the worst kind of limit, one that only
 * bites on the clans with the most data. A page costs ~6.5s, so this bounds a
 * runaway sweep at ~75 minutes. Long, but a full backfill is a rare manual
 * operation; the daily run stops at the cursor within a few pages.
 */
const MAX_PAGES = 700;
/** Consecutive pages that add no new row before we call it the end of the list. */
const DRY_PAGES_TO_STOP = 3;
/**
 * How many times to re-look at an empty rectangle, and how long to wait between
 * looks, before accepting that the list has really ended.
 *
 * This is the lazy-load allowance. Scrolling past the loaded chunk empties the
 * rectangle while the game fetches the next batch, and the old code — three
 * ordinary pages, ~9s, each one also scrolling FURTHER past the end — read that as
 * the end of the list and stopped at 503 rows while the game still had a fortnight
 * of history. The retries here deliberately do NOT scroll: the point is to hold
 * position and give the fetch time to land.
 *
 * 6 x 2.5s is ~15s of patience against a fetch that normally takes under a second,
 * and against an overlay that closes on the first Escape. Paid at most once per
 * sweep (at the true end of the list), which is trivial next to reading a fifth of
 * the data.
 */
const BLANK_RETRIES = 6;
const BLANK_RETRY_WAIT_MS = 2_500;
/**
 * How often to also keep the FULL page screenshot, not just the OCR crop.
 *
 * The crop is the artifact that matters for accuracy — it is literally what the
 * OCR reads — so every page gets one. A full screenshot answers a different and
 * much less frequent question: is the calibrated rectangle in the right place on
 * the panel. One in ten (plus the first page and wherever the sweep stopped)
 * answers that, where one per page would add ~150MB to a 400-page run for no
 * extra information.
 */
const FULL_SHOT_EVERY = 10;
/**
 * Wheel notches per scroll step.
 *
 * Measured: at 4 notches the rectangle showed 18-19 rows and advanced by only 5-9 of
 * them, so roughly two thirds of every page was re-reading rows already held. That
 * made a full 14-day backfill 330-440 pages and 35-50 minutes.
 *
 * Raising it to 8 (advancing ~13 of the ~18 visible rows) looked safe on that
 * arithmetic and was reverted before shipping, because replaying a real 39-page
 * export revealed that 11 of those pages ALREADY failed to align with their
 * predecessor at 4 notches. Whatever causes that — most likely OCR rendering a
 * player's name differently between two frames, which changes the row's key and
 * breaks the contiguous run the stitch needs — a bigger step can only make it worse,
 * and the failure mode is rows that are never photographed at all.
 *
 * So the speed-up stays parked until those zero-overlap pages are explained. The
 * limit that matters is rows-VISIBLE, not overlap: advancing more than a full
 * rectangle skips rows, and no later stage can detect or repair that. The stitch now
 * reports a zero-overlap page and the sweep warns, which is the instrument for
 * deciding this number rather than guessing at it again.
 */
const WHEEL_NOTCHES = 4;
/**
 * Whether two reads describe the same physical row.
 *
 * Exact match, or the same row where one read failed to identify the resource. The
 * wildcard is deliberately one-sided: two reads that BOTH resolved, to different
 * resources, are different rows and never align.
 *
 * Deliberately does NOT compare the transaction DATE, and that is the opposite of what
 * sweepRowKey exists for, so it needs justifying.
 *
 * A page has a date only because a "N DAYS AGO" header was seen somewhere above the row.
 * Once the header scrolls off the top, a page inherits the label in effect at the END of
 * the previous page — and the rows at the top of the new page are the previous page's
 * MIDDLE rows, which come BEFORE that point. So any page whose overlap straddles a
 * header dates that part of the overlap one day too new. Measured, pages 186/187 of a
 * real sweep:
 *
 *     page 186   14 rows dated 07-22, then 2 dated 07-21   <- header seen, placed right
 *     page 187   all 17 rows dated 07-21                   <- header gone, label inherited
 *
 * Seven rows (Feli, Pallas Athena, Queen of Chaos, …) are 07-22 in one read and 07-21 in
 * the next, identical in every other field. With the date in the comparison they cannot
 * align, so the stitch found NO overlap, warned, and appended the whole page — putting a
 * second, mis-dated copy of those rows in the database. That accounted for 10 of the 12
 * "shares no rows with the previous page" warnings in one 269-page sweep; only 2 were a
 * scroll that actually skipped rows.
 *
 * Dropping the date here is safe for the same reason the stitch itself is: alignment is a
 * RUN of rows in order, at least 4 of them and 60% of a longer window, not a single row.
 * The warning in sweepRowKey is about de-duplicating a whole sweep by content, where one
 * player's day-3 and day-7 rows really can be identical and really did get merged. A run
 * of four consecutive (name, direction, amount) triples repeating across two days in the
 * same order is a different proposition entirely.
 *
 * The mis-dated reads are always overlap rows, i.e. re-reads, so once they align they are
 * discarded in favour of the accumulated copy — which is why fixing the alignment also
 * fixes the dates. See the reconciliation in stitchPage for which date survives.
 */
function rowsAlign(a, b) {
    // Sweep keys, not fingerprints: two pages of ONE sweep must distinguish the same
    // player's identical rows on different days, or alignment drifts (see sweepRowKey).
    if ((0, resource_sweep_rules_js_1.sweepRowKey)(a) === (0, resource_sweep_rules_js_1.sweepRowKey)(b))
        return true;
    const oneIsUnresolved = a.resourceTypeId == null || b.resourceTypeId == null;
    return oneIsUnresolved && (0, resource_sweep_rules_js_1.looseSweepKey)(a) === (0, resource_sweep_rules_js_1.looseSweepKey)(b);
}
/**
 * The same test with the DATE removed — the fallback for a page whose overlap straddles a
 * date header (see the note on rowsAlign for what goes wrong and why).
 *
 * Only ever reached after the strict rule has found nothing, and only for a window of at
 * least MIN_DATE_TOLERANT_OVERLAP rows, because on its own this rule is genuinely unsafe:
 * a Loyalty Level "+1" is byte-identical every time a player earns one, so on a one-row
 * window it would merge that player's Monday row into their Friday row and delete a real
 * transaction. Length is what makes it safe — a run of four consecutive
 * (name, direction, amount, resource) tuples repeating in the same order on two different
 * days is not something that happens.
 */
function rowsAlignIgnoringDate(a, b) {
    if (`${(0, resource_sweep_rules_js_1.looseRowKey)(a)}|${a.resourceTypeId ?? 'x'}` === `${(0, resource_sweep_rules_js_1.looseRowKey)(b)}|${b.resourceTypeId ?? 'x'}`)
        return true;
    const oneIsUnresolved = a.resourceTypeId == null || b.resourceTypeId == null;
    return oneIsUnresolved && (0, resource_sweep_rules_js_1.looseRowKey)(a) === (0, resource_sweep_rules_js_1.looseRowKey)(b);
}
/**
 * Shortest window the date-tolerant rule may consider.
 *
 * With requiredMatches at 60% above 4, a window of 6 needs 4 rows to actually match, which
 * is the same weight of evidence the strict rule demands of its shortest exact windows. All
 * ten date-drift failures measured over a 269-page sweep had best candidates of 9-12 rows,
 * so this floor costs nothing real and keeps the rule away from the short windows where
 * content alone proves nothing.
 */
const MIN_DATE_TOLERANT_OVERLAP = 6;
/**
 * How many of an `overlap`-length window must align for it to count as the overlap.
 *
 * Not all of them, which is the important part. Requiring a perfect match made the
 * stitch far more brittle than it looks: for a candidate overlap of 10, ONE garbled
 * row anywhere in the window rejects it, and the next candidate (9) compares a
 * SHIFTED window that cannot match either — so a single OCR wobble in an 18-row page
 * destroyed every alignment and the page was appended wholesale. Measured at 11 of 39
 * pages on a real export, which is also what made a larger scroll step look unsafe.
 *
 * Scaled rather than a flat allowance: a short window has to be exact, because 2 of 3
 * rows agreeing is weak evidence, while a long window can afford a couple of bad reads
 * and is still unambiguous — rows carry a player name and a large amount, so six
 * agreeing in sequence is not something that happens by chance.
 */
function requiredMatches(overlap) {
    if (overlap <= 4)
        return overlap;
    return Math.max(4, Math.ceil(overlap * 0.6));
}
/**
 * Longest suffix of `acc` that is a prefix of `page` under `align`, or null.
 *
 * `minOverlap` exists for the date-tolerant rule, which needs a long run to be trustworthy
 * (see rowsAlignIgnoringDate). The strict rule passes 1 and so behaves exactly as before.
 */
function findOverlap(acc, page, align, minOverlap) {
    const maxOverlap = Math.min(acc.length, page.length);
    for (let overlap = maxOverlap; overlap >= minOverlap; overlap--) {
        let matched = 0;
        for (let i = 0; i < overlap; i++) {
            if (align(acc[acc.length - overlap + i], page[i]))
                matched++;
        }
        if (matched >= requiredMatches(overlap))
            return overlap;
    }
    return null;
}
function stitchPage(acc, page) {
    if (acc.length === 0)
        return { rows: [...page], overlap: -1 };
    if (page.length === 0)
        return { rows: acc, overlap: -1 };
    // Strict first, so every page that aligned before still aligns identically. Only a page
    // that would otherwise have been appended whole — with a "shares no rows" warning and a
    // duplicate copy of its overlap — gets the second, date-tolerant attempt.
    let align = rowsAlign;
    let overlap = findOverlap(acc, page, align, 1);
    if (overlap == null) {
        align = rowsAlignIgnoringDate;
        overlap = findOverlap(acc, page, align, MIN_DATE_TOLERANT_OVERLAP);
    }
    if (overlap == null) {
        // No alignment under either rule. Reported rather than swallowed: it is the ONLY
        // observable symptom of a scroll step large enough to jump clean over rows, which
        // is the one way this sweep can lose data silently. The caller warns.
        return { rows: [...acc, ...page], overlap: 0 };
    }
    // Upgrade any overlapped row the earlier page could not resolve. Without this
    // the FIRST read wins, and the first sighting of a row is often the one clipped
    // by an edge — so the list would keep the unresolved version and discard the
    // clean one, which is precisely backwards. Only positions that actually aligned
    // are touched; a mismatch tolerated by requiredMatches is left as it was read.
    //
    // Takes the resource and its crop, and KEEPS the accumulated row's date. The two reads
    // can disagree about the date when the tolerant rule matched them, and the earlier one
    // is the one to trust: it saw this row while the header above it was still on screen,
    // where the later page has lost the header and inherited a label belonging to rows
    // further down the list. Replacing the row wholesale would import that drift.
    const merged = acc.slice();
    for (let i = 0; i < overlap; i++) {
        const at = merged.length - overlap + i;
        if (!align(merged[at], page[i]))
            continue;
        if (merged[at].resourceTypeId == null && page[i].resourceTypeId != null) {
            merged[at] = {
                ...merged[at],
                resourceTypeId: page[i].resourceTypeId,
                rowCropPath: page[i].rowCropPath,
                fingerprint: page[i].fingerprint,
            };
        }
    }
    return { rows: [...merged, ...page.slice(overlap)], overlap };
}
/**
 * Delete the row crops this sweep wrote that no surviving row points at.
 *
 * A row is photographed on ~4 consecutive pages and each read that could not identify
 * the resource writes its own crop, so one unknown row can leave four files behind while
 * the database keeps one. Most leave four and keep NONE, because a boundary read pairs
 * with a clean one and the resolved version is what survives the stitch. Measured on one
 * 269-page sweep: 236 crops written, 22 rows still unknown at the end.
 *
 * This has to run after the stitch, the cursor cut AND the insert, because only then is
 * it known which paths a database row actually holds. Doing it earlier — skipping the
 * write for rows that look likely to be superseded — is what broke it the first time:
 * the rows that stay unknown are precisely the ones no clean read rescued, so they are
 * the ones whose crop an admin needs, and they lost it.
 *
 * Best-effort by design. A file that will not delete is disk noise; a throw here would
 * fail a capture whose rows are already committed.
 */
async function pruneUnreferencedCrops(written, keptRows) {
    if (written.length === 0)
        return 0;
    const kept = new Set(keptRows.map((r) => r.rowCropPath).filter((p) => !!p));
    let removed = 0;
    for (const file of new Set(written)) {
        if (kept.has(file))
            continue;
        try {
            await fs_1.promises.unlink(file);
            removed++;
        }
        catch {
            // Already gone, or not ours to remove. Either way there is nothing to do.
        }
    }
    return removed;
}
/**
 * Positions apart at which an identical pair is certainly ONE row read twice.
 *
 * A row's identity is content AND position together — neither alone works. Content
 * alone cannot tell a re-read from a genuine repeat: the same player earning "+1"
 * Loyalty Level twice in a day produces two byte-identical rows, and collapsing them
 * deletes a real transaction (which is exactly what the old value-keyed pass did,
 * silently, while leaving the totals looking plausible). Position alone cannot
 * identify anything, because a row's index shifts as the list scrolls — which is
 * precisely why the stitch matches on content.
 *
 * Exactly 1 — immediately adjacent — and that comes from a fact about the game rather
 * than a tuned threshold: the list NEVER shows the same line twice in a row, because
 * two identical same-day entries are merged into one before it is drawn. So an
 * identical pair with nothing between them cannot be two events; it is certainly one
 * row caught by two overlapping screenshots. With even a single row between them, the
 * pair could be genuine, and collapsing it would delete a transaction.
 *
 * Deliberately NOT widened to a full page (~19) to also mop up after a stitch that
 * failed to align. Those two jobs want opposite numbers and are not equally important:
 * a failed stitch leaves DUPLICATE rows, which show up in the totals, are reported by
 * the zero-overlap warning, and can be removed by deleting the batch — whereas a
 * window wide enough to catch them would silently delete same-day repeats, which
 * cannot be recovered or even noticed. Preventing duplicates is the stitch's job, not
 * this pass's.
 */
const DEDUPE_ADJACENT_ONLY = 1;
/**
 * Collapse re-reads of the same row while keeping genuinely repeated transactions.
 *
 * Replaces a global "one row per key" pass, which could not tell a re-read from a
 * repeat and therefore quietly deleted the latter. Keeps the RESOLVED copy of a pair
 * when only one of them managed to read its icon.
 */
function dedupeNearbyRepeats(rows, windowRows = DEDUPE_ADJACENT_ONLY) {
    const out = [];
    const lastSeenAt = new Map();
    let dropped = 0;
    for (const row of rows) {
        const key = (0, resource_sweep_rules_js_1.sweepRowKey)(row);
        const at = lastSeenAt.get(key);
        if (at !== undefined && out.length - at <= windowRows) {
            // Adjacent identical rows cannot be two events, since the game merges those
            // before drawing the list. So this is one row seen through two overlapping
            // screenshots; keep whichever read managed to identify the resource.
            if (out[at].resourceTypeId == null && row.resourceTypeId != null)
                out[at] = row;
            dropped++;
            continue;
        }
        lastSeenAt.set(key, out.length);
        out.push(row);
    }
    return { rows: out, dropped };
}
/**
 * Drop unresolved rows that are really just a second, worse read of a row resolved
 * elsewhere in the sweep.
 *
 * The stitch already merges such pairs when they land in the same overlap window,
 * but that misses any pair whose two sightings didn't line up contiguously — 18 of
 * the 22 survivors on a replayed 41-page run. Each survivor is a row written twice:
 * once correctly and once as "unknown", double-counting its amount and asking an
 * admin to fix something that was never broken.
 *
 * The trap is that name+direction+amount is NOT a unique identity — a player can
 * send the same amount of two different resources on the same day, and both rows are
 * real ("Clau +2,000,000" twice, observed live). Collapsing blindly would silently
 * delete the second one whenever its icon failed.
 *
 * `maxPerPage` is the discriminator, and it is exact rather than heuristic: two
 * genuinely distinct transactions are adjacent rows on ONE screenshot, so a single
 * page's read contains both. The same row seen twice never appears twice in one
 * page. So the number of rows a single page ever showed for a key is the true
 * multiplicity, and anything above it is a duplicate read.
 *
 * Only ever drops UNRESOLVED copies, and never takes a key below that multiplicity —
 * so Clau's unreadable second row survives as an unknown for an admin, which is the
 * designed behaviour, while a phantom is removed.
 */
function collapseUnresolvedTwins(rows, maxPerPage) {
    const byKey = new Map();
    rows.forEach((r, i) => {
        const key = (0, resource_sweep_rules_js_1.looseSweepKey)(r);
        const list = byKey.get(key);
        if (list)
            list.push(i);
        else
            byKey.set(key, [i]);
    });
    const drop = new Set();
    for (const [key, indexes] of byKey) {
        if (indexes.length < 2)
            continue;
        const allowed = Math.max(1, maxPerPage.get(key) ?? 1);
        if (indexes.length <= allowed)
            continue;
        // Only pairs adjacent in the list. An unresolved row any further away could be a
        // genuine same-day repeat whose icon failed to read, and dropping that loses a real
        // transaction — see DEDUPE_ADJACENT_ONLY.
        const unresolved = indexes.filter((i) => {
            if (rows[i].resourceTypeId != null)
                return false;
            return indexes.some((j) => j !== i && Math.abs(j - i) <= DEDUPE_ADJACENT_ONLY);
        });
        const resolvedCount = indexes.length - indexes.filter((i) => rows[i].resourceTypeId == null).length;
        const keepUnresolved = Math.max(0, allowed - resolvedCount);
        for (const i of unresolved.slice(keepUnresolved))
            drop.add(i);
    }
    if (drop.size === 0)
        return { rows, dropped: 0 };
    return { rows: rows.filter((_, i) => !drop.has(i)), dropped: drop.size };
}
/**
 * Score every alignment of the stored cursor against the list.
 *
 * Returns the best window that meets the threshold and, separately, the best window
 * overall — the near miss is what makes a lost cursor diagnosable afterwards instead
 * of being reported as a bare failure.
 *
 * Two things changed here after a daily run swept ten days it had already recorded,
 * and both are the same idea the stitch's requiredMatches encodes:
 *
 *   - **Gaps inside a window are tolerated.** The old rule needed CURSOR_MIN_RUN
 *     CONSECUTIVE exact fingerprints, so one garbled row rejected the whole window —
 *     and every following candidate window is SHIFTED, so it could not match either.
 *     A single OCR wobble among the twelve marker rows therefore lost the cursor
 *     completely.
 *   - **Candidates are scored, not first-past-the-post.** With gaps allowed, a
 *     coincidental four-row alignment must now out-score a twelve-row one to win,
 *     where before whichever was tried first simply won.
 *
 * A gap in the middle of an aligned window is safe here in a way it is not in the
 * stitch, and this fact licenses the whole approach: history rows are immutable and new
 * ones only ever appear at the TOP of the list, so a row sitting between two rows the
 * previous run recorded must also have been recorded by it — it cannot be something
 * that arrived in between. A mismatch inside the window is always a bad read, never a
 * missed row.
 *
 * Ties go to the SMALLEST `at`, i.e. the occurrence nearest the top. The marker rows
 * were the newest rows in the game when they were stored, so everything below them is
 * older; a second occurrence further down is the same content repeating on an older
 * day, and the topmost plausible match is the real marker.
 */
function scanCursorCandidates(prints, cursor) {
    let passing = null;
    let best = null;
    for (let start = 0; start + resource_sweep_rules_js_1.CURSOR_MIN_RUN <= cursor.length; start++) {
        const needle = cursor.slice(start);
        for (let at = 0; at + resource_sweep_rules_js_1.CURSOR_MIN_RUN <= prints.length; at++) {
            const window = Math.min(needle.length, prints.length - at);
            let matched = 0;
            for (let i = 0; i < window; i++) {
                if ((0, resource_sweep_rules_js_1.fingerprintsAlign)(prints[at + i], needle[i]))
                    matched++;
            }
            if (best == null || matched > best.matched)
                best = { at, matched, window, start };
            if (matched >= requiredMatches(window) && (passing == null || matched > passing.matched)) {
                passing = { at, matched, window, start };
            }
        }
    }
    return { passing, best };
}
/**
 * Index in `rows` where the previous run's cursor begins, or -1 if not found.
 *
 * Everything BEFORE that index is new. Tries the stored sequence at each of its
 * own offsets, longest first, so a cursor whose leading rows read differently this
 * time still anchors on its tail. See scanCursorCandidates for the matching rule.
 */
function findCursorIndex(rows, cursor, opts = {}) {
    if (cursor.length === 0 || rows.length === 0)
        return -1;
    const prints = rows.map((r) => r.fingerprint);
    const { passing } = scanCursorCandidates(prints, cursor);
    if (!passing)
        return -1;
    // `quiet` is for the date-mapping probe, which locates the stored marker on a run
    // that deliberately ignored it (a backfill or a dry run). Announcing "re-found the
    // previous cursor" there would describe a stop that did not happen.
    if (!opts.quiet) {
        log.info(`Resource capture: re-found the previous cursor at row ${passing.at} — `
            + `${passing.matched} of ${passing.window} marker row(s) aligned from cursor offset `
            + `${passing.start}, so the ${passing.at} row(s) above it are new.`);
    }
    return passing.at;
}
/**
 * How close the cursor came, for the log line that reports losing it.
 *
 * A lost cursor costs a full-fortnight sweep and a batch of duplicate rows, so the
 * thing worth knowing afterwards is HOW close the marker got: "11 of 12 aligned" is a
 * threshold to revisit, "1 of 12" means the marker rows are genuinely not in the list
 * any more, and the two call for opposite responses. The old log said only that it had
 * failed, which is why the last investigation had nothing to go on.
 */
function describeCursorNearMiss(rows, cursor) {
    if (cursor.length === 0 || rows.length === 0)
        return 'nothing to compare';
    const prints = rows.map((r) => r.fingerprint);
    const { best } = scanCursorCandidates(prints, cursor);
    if (!best)
        return 'no window long enough to compare';
    const needed = requiredMatches(best.window);
    let text = `the closest window aligned ${best.matched} of ${best.window} marker row(s) at row `
        + `${best.at} (from cursor offset ${best.start}), where ${needed} were needed`;
    // Third case: the marker rows are all THERE, in that window, but shuffled — so the
    // positional score fails while the content is intact. That is exactly what
    // 2026-09-03 was (12 of 12 present and byte-identical, 4 aligned in place, cursor
    // declared lost), and the old wording reported it as "genuinely gone", which sends
    // an investigation in precisely the wrong direction. Greedy multiset match over the
    // one best window only, so this stays O(CURSOR_ROWS^2) on a diagnostic path.
    const needle = cursor.slice(best.start, best.start + best.window);
    const pool = prints.slice(best.at, best.at + best.window).map((p) => ({ p, used: false }));
    let setScore = 0;
    for (const want of needle) {
        const hit = pool.find((c) => !c.used && (0, resource_sweep_rules_js_1.fingerprintsAlign)(c.p, want));
        if (hit) {
            hit.used = true;
            setScore++;
        }
    }
    if (setScore > best.matched) {
        text += `; ${setScore} of them ARE in that window but out of order`;
        if (setScore >= needed) {
            text += ' — enough to match on content alone, so this is the list re-ordering rows '
                + 'rather than the marker being gone';
        }
    }
    return text;
}
/** Read the text of a screenshot region through PaddleOCR. Used only for the
 *  "am I on the right screen?" checks, where a joined blob of text is enough. */
async function ocrRegionText(screenshot, region) {
    try {
        const { data, info } = await (0, sharp_1.default)(screenshot)
            .extract(region)
            .raw()
            .toBuffer({ resolveWithObject: true });
        const ocr = await (0, paddle_service_js_1.getPaddleOcr)();
        const results = await ocr.recognize({
            width: info.width,
            height: info.height,
            data: new Uint8Array(data),
        });
        return results.map((r) => r.text).join(' ');
    }
    catch (err) {
        log.debug(`Resource capture: region OCR failed: ${String(err)}`);
        return '';
    }
}
/**
 * True when the screenshot shows the world map rather than the city.
 *
 * Detected from the coordinate readout under the minimap ("K: 302 X: 176 Y:
 * 280"), which exists only on the world map. This check is not optional
 * bookkeeping: MAP and CITY are the SAME nav slot with a swapped label, so
 * clicking it blind toggles whichever view we happen to be in — and after a
 * chest scan and a might capture, which view that is isn't knowable.
 */
async function isOnWorldMap(screenshot) {
    const meta = await (0, sharp_1.default)(screenshot).metadata();
    const width = meta.width ?? 1920;
    const height = meta.height ?? 1080;
    // Bottom-left corner, generously sized: the readout sits directly under the
    // minimap and the minimap's size varies with the UI scale.
    const region = {
        left: 0,
        top: Math.round(height * 0.88),
        width: Math.min(width, Math.round(width * 0.22)),
        height: Math.max(1, height - Math.round(height * 0.88)),
    };
    const text = await ocrRegionText(screenshot, region);
    const found = /K\s*[:.]?\s*\d/i.test(text) || /X\s*[:.]?\s*\d+\s*Y\s*[:.]?\s*\d/i.test(text);
    log.debug(`Resource capture: world-map probe read "${text.slice(0, 80)}" → ${found}`);
    return found;
}
/** True when the crop shows resource-history rows — a date header or a
 *  sent/took line. Both are unique to this list. */
function looksLikeHistory(text) {
    return (/\b(TODAY|YESTERDAY|DAYS?\s*AGO)\b/i.test(text) ||
        /(sent|took)\s*resources/i.test(text) ||
        /speeded/i.test(text));
}
/**
 * Drive the game from wherever it is to the Clan Capital → History list.
 *
 * Returns null on success, or an operator-readable reason on failure. Every
 * click target is `requireUiPosition`'d up front so a half-finished calibration
 * fails naming the stage instead of clicking scenery.
 */
async function navigateToCapitalHistory(page, reportProgress, debugDir) {
    const mapButton = (0, calibration_js_1.requireUiPosition)('worldMapButton');
    const capitalButton = (0, calibration_js_1.requireUiPosition)('clanCapitalButton');
    const capitalMarker = (0, calibration_js_1.requireUiPosition)('clanCapitalMarker');
    const historySidebar = (0, calibration_js_1.requireUiPosition)('capitalHistorySidebar');
    const cropPct = (0, calibration_js_1.requireResourceHistoryCrop)();
    const bounds = await (0, navigator_js_1.getCanvasBounds)(page);
    const clickAt = async (pos, label, settleMin, settleMax) => {
        const x = Math.round(bounds.x + bounds.width * pos.xPct);
        const y = Math.round(bounds.y + bounds.height * pos.yPct);
        log.info(`Resource capture: clicking ${label} at (${x}, ${y})`);
        await (0, human_delay_js_1.humanClick)(page, x, y);
        await (0, human_delay_js_1.randomDelay)(settleMin, settleMax);
    };
    // Clear whatever dialog the previous phase left open.
    for (let i = 0; i < 2; i++) {
        await (0, input_js_1.keyPress)(page, 'Escape');
        await (0, human_delay_js_1.randomDelay)(250, 400);
    }
    await (0, human_delay_js_1.randomDelay)(800, 1200);
    // Get onto the world map. Two attempts, because the nav slot is a toggle: if
    // the first click went the wrong way (we were already on the map) the second
    // brings us back. Verifying rather than counting clicks is what makes this
    // robust to whatever state the scan left behind.
    reportProgress?.('Resources: opening the world map');
    let onMap = await isOnWorldMap(await (0, screenshotter_js_1.captureFullPage)(page));
    for (let attempt = 0; attempt < 2 && !onMap; attempt++) {
        await clickAt(mapButton, attempt === 0 ? 'MAP' : 'MAP (retry)', 2000, 3000);
        // Entering the world map raises a promo overlay of its own, and it does not
        // exist until this click lands — so neither the Escapes above nor the twelve
        // dismissPopups() pressed during navigateToGame can have cleared it.
        //
        // This has to happen BEFORE the probe below, not merely before the
        // screenshot: the overlay covers the coordinate readout the probe looks for,
        // so a probe run first would report "not on the map" and send the retry into
        // clicking MAP again — which, since MAP and CITY are one toggling slot, would
        // bounce us back to the city and fail the whole phase with a misleading
        // reason.
        await (0, input_js_1.keyPress)(page, 'Escape');
        await (0, human_delay_js_1.randomDelay)(1200, 1800);
        onMap = await isOnWorldMap(await (0, screenshotter_js_1.captureFullPage)(page));
    }
    if (!onMap) {
        return 'Could not get to the world map: the coordinate readout under the minimap never '
            + 'appeared after clicking the calibrated MAP position twice (with a promo-dismissing '
            + 'Escape after each). Re-check the MAP mark in calibration Stage 1.';
    }
    // Recentre on the capital, then open it. The recentre animates, so the marker
    // click has to wait for the camera to settle or it lands on terrain.
    reportProgress?.('Resources: opening the clan capital');
    await clickAt(capitalButton, 'show-clan-capital', 3000, 4000);
    await clickAt(capitalMarker, 'clan capital', 2500, 3500);
    await clickAt(historySidebar, 'History', 2000, 3000);
    // Confirm the rows are actually on screen before scrolling and OCR'ing 70
    // pages of something else.
    const screenshot = await (0, screenshotter_js_1.captureFullPage)(page);
    const meta = await (0, sharp_1.default)(screenshot).metadata();
    const screenshotSize = { width: meta.width ?? 1920, height: meta.height ?? 1080 };
    const canvasRect = await (0, member_capture_js_1.getCanvasRect)(page);
    const cropPx = (0, member_capture_js_1.cropPctToPixels)(cropPct, canvasRect, screenshotSize);
    const text = await ocrRegionText(screenshot, cropPx);
    if (!looksLikeHistory(text)) {
        // The failed frame is the only way to tell "clicked the wrong thing" from
        // "clicked the right thing but the panel hadn't drawn yet".
        await (0, screenshotter_js_1.saveScreenshot)(screenshot, debugDir ?? './data/screenshots', debugDir ? 'nav-fail' : 'resource_nav_fail', { force: true }).catch(() => '');
        return 'Reached the Clan Capital but the calibrated rectangle does not contain resource '
            + `history rows (OCR read: "${text.slice(0, 120)}"). Re-run calibration Stage 6 — a debug `
            + 'screenshot was saved to data/screenshots/.';
    }
    return null;
}
/**
 * Age a date label by exactly one day, the way the game does at midnight.
 *
 * "TODAY" → "YESTERDAY" → "2 DAYS AGO" → "3 DAYS AGO" … Needed only when the
 * account's day turns over mid-sweep: the label carried from the previous page
 * describes rows the game has just re-labelled, so re-anchoring the base date
 * without also ageing that carried label would date the top of the next page a
 * day out — the very error the re-anchor exists to prevent.
 *
 * An unrecognised label is returned unchanged. It can only come from an OCR
 * misread, and inventing a day for it would be worse than leaving the sweep to
 * carry on with what it had.
 */
function advanceDateLabel(label) {
    const normalized = label.trim().toUpperCase();
    if (normalized === 'TODAY')
        return 'YESTERDAY';
    if (normalized === 'YESTERDAY')
        return '2 DAYS AGO';
    const daysAgo = normalized.match(/^(\d+)\s+DAYS?\s*AGO$/);
    if (daysAgo)
        return `${Number.parseInt(daysAgo[1], 10) + 1} DAYS AGO`;
    return label;
}
/**
 * How many days back a history date label points, or null when it isn't one.
 *
 * "TODAY" → 0, "YESTERDAY" → 1, "6 DAYS AGO" → 6. Null for anything unrecognised,
 * which can only be an OCR misread — and the date backstop treats that as "don't
 * know, keep going" rather than inventing a number, for the same reason
 * advanceDateLabel returns such a label unchanged.
 */
function daysAgoFromLabel(label) {
    const normalized = label.trim().toUpperCase();
    if (normalized === 'TODAY')
        return 0;
    if (normalized === 'YESTERDAY')
        return 1;
    const daysAgo = normalized.match(/^(\d+)\s+DAYS?\s*AGO$/);
    if (daysAgo)
        return Number.parseInt(daysAgo[1], 10);
    return null;
}
/**
 * Navigate to the capital history, scroll it, and return the rows added since
 * the cursor.
 */
async function captureResourceHistory(page, opts) {
    const { members, allTypes, rolloverUtcHour, cursor = [], verifyCursor = [], cropToken, reportProgress, debugSavePages = false, maxDaysBack, } = opts;
    /** The date the list currently calls "TODAY". Re-read every page. */
    const listDateNow = () => (0, game_day_js_1.gameDateFor)(Date.now(), rolloverUtcHour);
    const maxPages = Math.max(1, Math.min(MAX_PAGES, opts.maxPages ?? MAX_PAGES));
    const result = {
        rows: [],
        cursorRows: [],
        openDates: [],
        deferredRows: 0,
        cursorAnchorDate: null,
        completeDates: [],
        cursorMatchDate: null,
        pagesScanned: 0,
        totalRowsSeen: 0,
        cursorLost: false,
        unmatchedNames: [],
        cropPathsWritten: [],
        navigationFailed: false,
        errors: [],
        truncated: false,
        stopReason: 'page-limit',
        oldestDateLabel: 'TODAY',
    };
    // One directory per debug run, named by start time so it sorts chronologically.
    // Created before the sweep so every frame — including a nav failure's — lands in
    // it, and logged up front so the operator knows what to copy off the box without
    // waiting for the run to finish.
    let debugDir;
    if (debugSavePages) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        debugDir = (0, path_1.join)('data', 'screenshots', 'resource-debug', `run_${stamp}`);
        try {
            await fs_1.promises.mkdir(debugDir, { recursive: true });
            // Empty leftovers from earlier runs whose files the retention sweep has since
            // removed. It deletes files but not the directories they were in, so without
            // this the tree slowly fills with empty shells.
            const parent = (0, path_1.join)('data', 'screenshots', 'resource-debug');
            for (const name of await fs_1.promises.readdir(parent)) {
                const dir = (0, path_1.join)(parent, name);
                if (dir === debugDir)
                    continue;
                try {
                    if ((await fs_1.promises.readdir(dir)).length === 0)
                        await fs_1.promises.rmdir(dir);
                }
                catch { /* not a directory, or in use — leave it */ }
            }
            result.debugDir = debugDir;
            log.info(`Resource capture: saving debug frames to ${debugDir} — one crop per scroll page (what OCR `
                + `actually reads) plus a full screenshot every ${FULL_SHOT_EVERY} pages. Copy the whole `
                + `directory off with: scp -r <host>:<app>/${debugDir} .`);
        }
        catch (err) {
            log.warn(`Resource capture: could not create the debug directory: ${String(err)}`);
            debugDir = undefined;
        }
    }
    const navError = await navigateToCapitalHistory(page, reportProgress, debugDir);
    if (navError) {
        result.navigationFailed = true;
        result.navigationError = navError;
        return result;
    }
    const cropPct = (0, calibration_js_1.requireResourceHistoryCrop)();
    const firstShot = await (0, screenshotter_js_1.captureFullPage)(page);
    const firstMeta = await (0, sharp_1.default)(firstShot).metadata();
    const screenshotSize = {
        width: firstMeta.width ?? 1920,
        height: firstMeta.height ?? 1080,
    };
    const canvasRect = await (0, member_capture_js_1.getCanvasRect)(page);
    const cropPx = (0, member_capture_js_1.cropPctToPixels)(cropPct, canvasRect, screenshotSize);
    // Scroll with the cursor over the middle of the calibrated rectangle, which is
    // by definition on the rows. Screenshot pixels → CSS pixels because mouse
    // coordinates are CSS (identical at dpr 1, but not worth assuming).
    const viewport = page.viewportSize();
    const cssScaleX = viewport ? viewport.width / screenshotSize.width : 1;
    const cssScaleY = viewport ? viewport.height / screenshotSize.height : 1;
    const scrollAt = {
        x: Math.round((cropPx.left + cropPx.width / 2) * cssScaleX),
        y: Math.round((cropPx.top + cropPx.height / 2) * cssScaleY),
    };
    log.debug(`Resource capture scrolling at CSS (${scrollAt.x}, ${scrollAt.y})`);
    let stitched = [];
    // Date labels are carried across pages: page 2 onward can start mid-day with
    // no header in view, and without this every row after the first page would be
    // dated TODAY. See processResourceScreenshot's initialDateLabel.
    let dateLabel = 'TODAY';
    /**
     * The date 'TODAY' meant when the page currently being read was captured.
     *
     * Not a constant, which it used to be. A full backfill can run for over an
     * hour, and when the day turns over inside that window the game re-labels
     * every row it is showing — a row that read "YESTERDAY" on page 99 reads
     * "2 DAYS AGO" on page 101. Against a frozen anchor that row resolves to
     * two different dates in one sweep, which is both a wrong date AND a duplicate:
     * sweepRowKey includes the date, so the second reading no longer collapses into
     * the first and gets inserted alongside it.
     */
    let baseDate = new Date(`${listDateNow()}T00:00:00Z`);
    let lastHash = '';
    let sameCount = 0;
    let dryPages = 0;
    /** Latest page's cropped pixels, kept so the stop condition can save evidence. */
    let lastCropped = null;
    /** Blank episodes whose first frame has been saved. Capped so a list that
     *  fetches in many small chunks can't fill the disk with near-identical PNGs. */
    let blankEpisodeShots = 0;
    /** Pages that shared no rows with their predecessor — i.e. the scroll jumped over
     *  rows entirely. See the warning at the stitch call. */
    let noOverlapPages = 0;
    /**
     * Most rows any SINGLE page showed for a given name/direction/amount.
     *
     * The true multiplicity of that transaction: two real same-amount rows are adjacent
     * on one screenshot, whereas one row read across two screenshots never appears
     * twice in either. Consumed by collapseUnresolvedTwins.
     */
    const maxRowsPerPageByKey = new Map();
    /**
     * Every date that was "TODAY" while this sweep was running.
     *
     * The dates the game is still merging rows into, and therefore the ones this run
     * may neither write nor anchor on. Collected PER PAGE rather than derived from the
     * finished list, because dedupeNearbyRepeats and collapseUnresolvedTwins both drop
     * rows afterwards and a date whose only surviving row was dropped must still count
     * as open.
     *
     * More than one entry means the sweep crossed a rollover — a long backfill, or a
     * scheduled run that straddles it. Both leading blocks are then deferred, costing
     * one extra day of latency on that day alone and never a wrong write.
     */
    const openDates = new Set();
    /** Set once the cursor is re-found, so the sweep can stop scrolling: rows
     *  below it were all read on an earlier run. */
    let cursorIndex = -1;
    /**
     * The row `cursorIndex` pointed at when it was found.
     *
     * Kept by reference because collapseUnresolvedTwins runs AFTER the loop and removes
     * rows from anywhere in the list, including above the anchor — which silently
     * shifted the cut and re-inserted that many already-recorded rows. `filter`
     * preserves object identity, so indexOf re-finds it exactly.
     */
    let anchorRow = null;
    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
        const rowsBefore = stitched.length;
        let screenshot;
        try {
            screenshot = await (0, screenshotter_js_1.captureFullPage)(page);
        }
        catch (err) {
            // Same reasoning as the scroll step below: a dead renderer must not cost the
            // rows already gathered.
            result.stopReason = 'crashed';
            result.errors.push(`Browser crashed while screenshotting page ${pageNum + 1}: ${String(err)}`);
            log.warn({ noAlert: true }, `Resource capture: the browser crashed while screenshotting page ${pageNum + 1} — keeping `
                + `the ${stitched.length} row(s) already read. Reached back to "${dateLabel}".`);
            break;
        }
        let cropped;
        try {
            cropped = await (0, sharp_1.default)(screenshot).extract(cropPx).png().toBuffer();
        }
        catch (err) {
            // A crop that can't be taken at all is fatal to the sweep, not to the run:
            // returning what we have is better than throwing away the pages that did
            // work, and the caller reports the error.
            log.warn({ err }, 'Resource capture: could not crop the history rectangle');
            result.errors.push('Could not crop the history rectangle: ' + String(err));
            result.stopReason = 'error';
            break;
        }
        lastCropped = cropped;
        if (debugDir) {
            // Zero-padded so a directory listing sorts in scroll order — the whole point
            // is to flip through them in sequence.
            const pageLabel = `p${String(pageNum + 1).padStart(3, '0')}`;
            await (0, screenshotter_js_1.saveScreenshot)(cropped, debugDir, `${pageLabel}-crop`, { force: true })
                .catch(() => '');
            if (pageNum === 0 || (pageNum + 1) % FULL_SHOT_EVERY === 0) {
                await (0, screenshotter_js_1.saveScreenshot)(screenshot, debugDir, `${pageLabel}-full`, { force: true })
                    .catch(() => '');
            }
        }
        // Did the day turn over since the last page? Checked BEFORE this page is
        // read, so the page is dated by the labels it is actually showing.
        //
        // The carried label has to age with the anchor. It describes rows at the
        // bottom of the PREVIOUS page — rows the game has just re-labelled — so
        // leaving it alone while moving the base date would date the top of this
        // page a day out, which is the error this whole block exists to avoid.
        const pageDate = listDateNow();
        // Before the rollover comparison below, so a sweep that crosses one records BOTH
        // days as open. The rows read either side of the crossing are the ones the game
        // is still merging into on their respective days.
        openDates.add(pageDate);
        if (pageDate !== baseDate.toISOString().slice(0, 10)) {
            const aged = advanceDateLabel(dateLabel);
            log.info(`Resource capture: the day rolled over mid-sweep at page ${pageNum + 1} — "today" is now `
                + `${pageDate} (was ${baseDate.toISOString().slice(0, 10)}). Re-anchoring, and ageing the `
                + `carried label "${dateLabel}" to "${aged}" to match what the game is now showing. Rows `
                + 'already read keep the dates they were labelled with, which is correct: each was read '
                + 'under the labels in force at the time.');
            baseDate = new Date(`${pageDate}T00:00:00Z`);
            dateLabel = aged;
        }
        // One forced debug crop per run, same rationale as might capture's: every
        // interesting question about this rectangle is about its edges (is the
        // resource icon inside? is the name?) and no description answers those.
        if (pageNum === 0) {
            await (0, screenshotter_js_1.saveScreenshot)(cropped, debugDir ?? './data/screenshots', debugDir ? 'p001-crop-firstpage' : 'resource_history_crop_debug', { force: true }).catch(() => '');
        }
        let pageResult;
        try {
            pageResult = await (0, resource_ocr_js_1.processResourceScreenshot)({
                imageBuffer: cropped,
                clanId: 0, // unused by the OCR pipeline; the phase owns clan scoping
                uploadDate: baseDate,
                members,
                allTypes,
                cropToken: cropToken ? `${cropToken}_p${pageNum}` : undefined,
                initialDateLabel: dateLabel,
            });
        }
        catch (err) {
            log.warn({ err }, 'Resource capture: OCR failed for one page');
            result.errors.push(`OCR failed on page ${pageNum + 1}: ${String(err)}`);
            pageResult = null;
        }
        result.pagesScanned = pageNum + 1;
        if (pageResult) {
            dateLabel = pageResult.finalDateLabel;
            result.errors.push(...pageResult.errors);
            for (const name of pageResult.unmatchedNames) {
                if (!result.unmatchedNames.includes(name))
                    result.unmatchedNames.push(name);
            }
            const pageRows = pageResult.rows.map((row) => ({
                ...row,
                fingerprint: (0, resource_sweep_rules_js_1.rowFingerprint)(row),
            }));
            for (const row of pageRows) {
                if (row.rowCropPath)
                    result.cropPathsWritten.push(row.rowCropPath);
            }
            const seenThisPage = new Map();
            for (const row of pageRows) {
                const key = (0, resource_sweep_rules_js_1.looseSweepKey)(row);
                seenThisPage.set(key, (seenThisPage.get(key) ?? 0) + 1);
            }
            for (const [key, count] of seenThisPage) {
                if (count > (maxRowsPerPageByKey.get(key) ?? 0))
                    maxRowsPerPageByKey.set(key, count);
            }
            const stitch = stitchPage(stitched, pageRows);
            stitched = stitch.rows;
            if (stitch.overlap === 0) {
                // Consecutive pages are supposed to share rows; finding none means the list
                // advanced by at least a full page between screenshots, so rows in between
                // were never photographed. Nothing downstream can detect or repair that —
                // the stitch just appends and the result looks plausible — so it has to be
                // said out loud, and it is the signal to reduce WHEEL_NOTCHES.
                noOverlapPages++;
                log.warn({ noAlert: true }, `Resource capture page ${pageNum + 1} shares no rows with the previous page `
                    + `(${noOverlapPages} so far). Either the scroll jumped a whole rectangle — in which case `
                    + 'rows between the two pages were never photographed and WHEEL_NOTCHES is too high — or '
                    + 'the rows are there and simply failed to align. Compare the new-row count in the next '
                    + 'line against the rows read: if it is much lower, they DID overlap and this is an '
                    + 'alignment problem, not a skip.');
            }
            // Second line of defence behind the stitch: if alignment failed and the
            // overlap was appended twice, drop the repeats. Sound because the game
            // merges same-day repeats, so within one sweep an exact repeat of a
            // fingerprint at a NON-adjacent position is a re-read, not a real second
            // transaction — and an adjacent one cannot exist.
            stitched = dedupeNearbyRepeats(stitched).rows;
            const samples = pageRows.slice(0, 3)
                .map((r) => `${r.rawPlayerName}${r.direction > 0 ? '+' : '-'}${r.amount.toLocaleString('en-US')}`)
                .join(', ');
            log.info(`Resource history page ${pageNum + 1}: ${pageRows.length} row(s) read, `
                // "oldest label so far", not "date": this is how far back the read has
                // got, and reading it as a stop condition is a mistake the wording used
                // to invite.
                + `${stitched.length} distinct so far (oldest label so far: ${dateLabel})`
                + (samples ? ` · ${samples}` : ''));
            // How far BACK it has reached is the useful progress signal on a long sweep —
            // a page number tells an operator nothing about how much is left, whereas
            // "back to 6 days ago" says immediately whether a 14-day read is half done.
            reportProgress?.(`Resources: ${stitched.length.toLocaleString('en-US')} row(s), `
                + `back to ${dateLabel.toLowerCase()} (page ${pageNum + 1})`);
            // Cursor check happens per page so the sweep can stop as soon as it has
            // reached known ground — that's what keeps a routine daily run to a few pages
            // instead of re-reading the whole fortnight.
            if (cursor.length > 0 && cursorIndex < 0) {
                cursorIndex = findCursorIndex(stitched, cursor);
                if (cursorIndex >= 0) {
                    anchorRow = stitched[cursorIndex];
                    log.info(`Resource capture: reached the previous run's position after ${pageNum + 1} page(s); `
                        + 'stopping the scroll.');
                    result.stopReason = 'cursor';
                    break;
                }
            }
            // Date backstop, BEHIND the cursor and independent of it.
            //
            // The cursor is the real stop condition and it is content-based, so when it fails
            // it fails silently and completely: the sweep simply keeps scrolling into days it
            // already holds, at ~6.5s a page, and then inserts them again. That is what
            // happened on clan 1 — a daily run that should have stopped on yesterday's marker
            // was ten days deep through history it had already recorded.
            //
            // This bounds that with the one fact the cursor cannot use: a run whose previous
            // capture was N days ago has no business reading rows from much further back than
            // N days. The caller sizes it (days since the last capture, plus slack for the
            // account-calendar day labels drifting either side of the 17:00 UTC game day).
            //
            // Only armed when a cursor was supplied — a first run, a full backfill and a dry
            // run all want the whole visible list. Rows read up to this point are KEPT: they
            // were read correctly, the phase is insert-only, and stopping here says nothing
            // about them being wrong, only that reading further is waste.
            if (maxDaysBack != null && cursor.length > 0) {
                const daysBack = daysAgoFromLabel(dateLabel);
                if (daysBack != null && daysBack > maxDaysBack) {
                    result.stopReason = 'date-floor';
                    if (lastCropped) {
                        result.finalPageCropPath = await (0, screenshotter_js_1.saveScreenshot)(lastCropped, debugDir ?? './data/screenshots', `${debugDir ? '' : 'resource_history_'}final-page`, { force: true }).catch(() => '') || undefined;
                    }
                    log.warn(`Resource capture: stopped at the date backstop after ${pageNum + 1} page(s). The sweep `
                        + `has reached rows labelled "${dateLabel}", further back than the ${maxDaysBack} day(s) `
                        + `a run this recent should need, and the previous run's marker rows were never re-found `
                        + `among the ${stitched.length} row(s) read — ${describeCursorNearMiss(stitched, cursor)}. `
                        + 'Keeping what was read, so check this batch for rows that were already recorded. The '
                        + 'cursor is the thing to fix; this only stops it running away.');
                    break;
                }
            }
        }
        // No history rows in the rectangle means "something is in the way, or more is
        // loading" — NOT "the list ended". Two known causes, and the recovery below
        // handles both because they are indistinguishable from the row count alone:
        //
        //   1. The game's idle overlay. On a long sweep the game decides nobody is
        //      there and raises a purchase offer over the list. Waiting does NOTHING
        //      for this — it needs an Escape — which is why the recovery presses one on
        //      every attempt rather than only sleeping.
        //   2. The list still loading the next chunk after a scroll, where waiting is
        //      exactly right.
        //
        // Getting this wrong ended a real sweep at 503 rows / "2 DAYS AGO" with a
        // fortnight still to read, and it looked like a clean finish in the logs.
        const rowsThisPage = pageResult?.rows.length ?? 0;
        if (rowsThisPage === 0) {
            // Keep the frame that triggered this episode even when it later recovers: a
            // "we nearly stopped here" moment is the evidence for which of the two causes
            // it was, and it's gone once the list scrolls on.
            if (lastCropped && blankEpisodeShots < 5) {
                blankEpisodeShots++;
                await (0, screenshotter_js_1.saveScreenshot)(lastCropped, debugDir ?? './data/screenshots', `${debugDir ? '' : 'resource_history_'}blank-p${String(pageNum + 1).padStart(3, '0')}`, { force: true }).catch(() => '');
                // The full frame too, and it is the more useful of the pair here: the crop
                // shows only that rows are absent, while the whole screen shows WHY —
                // an offer overlay on top, versus a panel that has simply run out of rows.
                await (0, screenshotter_js_1.saveScreenshot)(screenshot, debugDir ?? './data/screenshots', `${debugDir ? '' : 'resource_history_'}blank-p${String(pageNum + 1).padStart(3, '0')}-full`, { force: true }).catch(() => '');
            }
            let recovered = false;
            for (let retry = 1; retry <= BLANK_RETRIES; retry++) {
                log.info(`Resource capture: no history rows in the rectangle (page ${pageNum + 1}); dismissing any `
                    + `overlay and waiting for rows to come back (${retry}/${BLANK_RETRIES})…`);
                reportProgress?.(`Resources: clearing a popup / waiting for more history (${retry}/${BLANK_RETRIES})`);
                // Escape first, then wait. Escape is what clears the idle overlay, and it is
                // harmless when the real cause is a pending fetch — there is no dialog for it
                // to close, and the history panel itself does not respond to it.
                await (0, input_js_1.keyPress)(page, 'Escape').catch(() => { });
                // Genuine cursor movement too: the overlay appears because the game saw no
                // activity, so clearing it without also proving we are here just invites it
                // straight back on the next page.
                await (0, input_js_1.mouseMove)(page, scrollAt.x - 10, scrollAt.y - 6, { steps: 4 }).catch(() => { });
                await (0, input_js_1.mouseMove)(page, scrollAt.x, scrollAt.y, { steps: 3 }).catch(() => { });
                await new Promise((r) => setTimeout(r, BLANK_RETRY_WAIT_MS));
                let retryCrop;
                try {
                    retryCrop = await (0, sharp_1.default)(await (0, screenshotter_js_1.captureFullPage)(page)).extract(cropPx).png().toBuffer();
                }
                catch {
                    break;
                }
                lastCropped = retryCrop;
                if (debugDir) {
                    await (0, screenshotter_js_1.saveScreenshot)(retryCrop, debugDir, `p${String(pageNum + 1).padStart(3, '0')}-wait${retry}-crop`, { force: true }).catch(() => '');
                }
                // A cheap text probe rather than the full OCR-plus-icon-matching pipeline:
                // all we need to know is whether rows are on screen again. The real read
                // happens on the next loop iteration.
                const retryText = await ocrRegionText(retryCrop, {
                    left: 0, top: 0, width: cropPx.width, height: cropPx.height,
                });
                if (looksLikeHistory(retryText)) {
                    log.info(`Resource capture: rows re-appeared after ${retry} attempt(s) — an overlay was in the `
                        + 'way or the list was still loading. Not the end of the list.');
                    recovered = true;
                    break;
                }
            }
            if (recovered) {
                // Re-read this same position properly on the next iteration instead of
                // scrolling further, so the newly-loaded rows can't be skipped past.
                continue;
            }
            result.stopReason = 'blank';
            if (lastCropped) {
                result.finalPageCropPath = await (0, screenshotter_js_1.saveScreenshot)(lastCropped, debugDir ?? './data/screenshots', `${debugDir ? '' : 'resource_history_'}final-page`, { force: true }).catch(() => '') || undefined;
            }
            log.info(`Resource capture: still no history rows after ${BLANK_RETRIES} attempt(s) at dismissing and `
                + `waiting (~${Math.round((BLANK_RETRIES * BLANK_RETRY_WAIT_MS) / 1000)}s) — treating that as `
                + `the end of the list at ${stitched.length} row(s), oldest "${dateLabel}". Both the crop and `
                + 'the full frame were saved, so an genuinely-finished list can be told apart from an overlay '
                + 'that would not close.');
            break;
        }
        // Is the rectangle frozen? Computed BEFORE the dry-page decision below, because
        // it is what separates a finished list from a stuck scroll.
        const hash = crypto_1.default.createHash('md5').update(cropped).digest('hex');
        const cropUnchanged = hash === lastHash;
        sameCount = cropUnchanged ? sameCount + 1 : 0;
        lastHash = hash;
        // No new rows. Which of two very different things this means depends on whether
        // the pixels are still moving:
        //
        //   frozen crop + rows visible  = the END of the list. The list does not go blank
        //     when it runs out — it simply stops scrolling with the last rows still on
        //     screen, scrollbar at the bottom. This is the normal, successful ending of a
        //     full sweep, confirmed against a run that reached "14 DAYS AGO".
        //   crop still changing, but nothing new = something is wrong. The list IS
        //     scrolling, yet every row is one we already hold — a stitch that stopped
        //     aligning, or a view that jumped back. That deserves a warning.
        //
        // These were the wrong way round: a completed 269-page sweep reported "the read
        // is probably incomplete" and the UI flagged it STOPPED EARLY, which is exactly
        // the sort of false alarm that trains an operator to ignore real ones.
        if (stitched.length === rowsBefore) {
            dryPages++;
            if (dryPages >= DRY_PAGES_TO_STOP) {
                if (lastCropped) {
                    result.finalPageCropPath = await (0, screenshotter_js_1.saveScreenshot)(lastCropped, debugDir ?? './data/screenshots', `${debugDir ? '' : 'resource_history_'}final-page`, { force: true }).catch(() => '') || undefined;
                }
                if (cropUnchanged) {
                    result.stopReason = 'end-of-list';
                    log.info(`Resource capture reached the end of the list: ${dryPages} page(s) with no new rows and `
                        + `an unchanging view, at ${stitched.length} row(s) (oldest "${dateLabel}").`);
                }
                else {
                    result.stopReason = 'no-new-rows';
                    log.warn({ noAlert: true }, `Resource capture stopped after ${dryPages} page(s) that still showed ${rowsThisPage} `
                        + `row(s) and were still CHANGING, yet added nothing new, at ${stitched.length} row(s) `
                        + `(oldest "${dateLabel}"). The list is scrolling but every row is already held, which `
                        + 'suggests the page stitch stopped aligning. The read may be incomplete; the final '
                        + 'page was saved for inspection.');
                }
                break;
            }
        }
        else {
            dryPages = 0;
        }
        // Backstop for a frozen view that somehow never trips the dry-page rule above.
        if (sameCount >= DRY_PAGES_TO_STOP) {
            result.stopReason = 'end-of-list';
            log.info(`Resource capture: the view stopped changing after ${pageNum + 1} page(s) at `
                + `${stitched.length} row(s) (oldest "${dateLabel}") — treating that as the end of the list.`);
            break;
        }
        // Move the cursor to a slightly DIFFERENT point each page, in several steps.
        //
        // This is the anti-idle measure, and the old code was the worst case for it: it
        // moved to the same coordinates every single page, which after the first page
        // is a zero-delta move and generates no mousemove events at all. The only input
        // the game saw for minutes on end was wheel deltas — so it concluded nobody was
        // there and raised its "still awake?" offer overlay, which covers the list. The
        // sweep then read a page with no history rows in it and called that the end of
        // the list, stopping at 503 rows with a fortnight still to read.
        //
        // A jiggle inside the calibrated rectangle is safe: it is over the list, and a
        // move on its own neither scrolls nor clicks anything. `steps` matters as much
        // as the offset — Playwright emits one mousemove per step, so this produces a
        // short stream of events rather than a single jump.
        const jiggleX = scrollAt.x + ((pageNum % 2 === 0) ? -12 : 12);
        const jiggleY = scrollAt.y + ((pageNum % 3) - 1) * 8;
        try {
            await (0, input_js_1.mouseMove)(page, jiggleX, jiggleY, { steps: 4 });
            await (0, input_js_1.mouseMove)(page, scrollAt.x, scrollAt.y, { steps: 3 });
            for (let i = 0; i < WHEEL_NOTCHES; i++) {
                await (0, input_js_1.mouseWheel)(page, 0, 100);
                await (0, human_delay_js_1.randomDelay)(20, 40);
            }
        }
        catch (err) {
            // The renderer died mid-sweep — observed as "mouse.move: Target crashed" ten
            // minutes into a full backfill, most likely memory pressure from holding a
            // WebGL canvas hot while screenshotting and OCR'ing 158 pages.
            //
            // Keep what was read. Letting this throw discarded 964 rows of completed work
            // and produced nothing at all, which is the worst possible outcome: the rows
            // had been read correctly, and the phase is insert-only so writing a partial
            // sweep is safe — the cursor advances only over what was actually seen, and the
            // next run resumes from there.
            result.stopReason = 'crashed';
            result.errors.push(`Browser crashed after ${pageNum + 1} page(s): ${String(err)}`);
            log.warn({ noAlert: true }, `Resource capture: the browser crashed after ${pageNum + 1} page(s) — keeping the `
                + `${stitched.length} row(s) already read rather than discarding them. Reached back to `
                + `"${dateLabel}". The rest of the list is still in the game and the next run picks up `
                + 'from the new cursor position.');
            break;
        }
        await (0, human_delay_js_1.randomDelay)(120, 220);
    }
    // Final pass over the whole list, catching duplicate reads the pairwise stitch
    // could not see. Runs before the cursor cut so the cursor is built from the
    // cleaned list.
    const collapsed = collapseUnresolvedTwins(stitched, maxRowsPerPageByKey);
    if (collapsed.dropped > 0) {
        stitched = collapsed.rows;
        log.info(`Resource capture: dropped ${collapsed.dropped} unresolved row(s) that were a second, `
            + 'icon-less read of a row resolved elsewhere in this sweep. They would otherwise have been '
            + 'written as duplicate "unknown" rows, each double-counting its amount.');
    }
    result.totalRowsSeen = stitched.length;
    result.oldestDateLabel = dateLabel;
    // "The loop ran out of pages", not "the loop read maxPages pages". Those differ
    // whenever a break set its own reason on the very last allowed page — and since
    // 'page-limit' is this field's initial value (see the result literal) and every
    // break assigns before it, testing the reason is both simpler and exact. It used
    // to overwrite a clean 'cursor' / 'end-of-list' with 'page-limit', which now also
    // decides whether the marker may advance.
    result.truncated = result.stopReason === 'page-limit';
    if (result.truncated) {
        log.warn(`Resource capture hit the ${maxPages}-page limit with ${stitched.length} row(s) read `
            + `(oldest "${dateLabel}") — the read is truncated. Not data loss: the rows stay in the game `
            + 'for about a fortnight and the next run picks up from the same cursor.');
    }
    // collapseUnresolvedTwins can have removed rows from ABOVE the anchor, which
    // shifts every index below it. Re-find the anchor by identity rather than
    // trusting the number latched inside the loop.
    if (anchorRow) {
        const moved = stitched.indexOf(anchorRow);
        cursorIndex = moved >= 0 ? moved : findCursorIndex(stitched, cursor);
    }
    result.openDates = [...openDates];
    // Where the previous run's marker sits. Everything above it is new to us.
    const cut = cursorIndex >= 0 ? cursorIndex : stitched.length;
    // Locate the stored marker purely to date-stamp it, even on a run that ignored it
    // as a stop condition (a backfill or a dry run passes an empty `cursor` but still
    // wants this answer). Free when the sweep already found it.
    const matchAt = cursorIndex >= 0
        ? cursorIndex
        : findCursorIndex(stitched, verifyCursor, { quiet: true });
    result.cursorMatchDate = matchAt >= 0 ? stitched[matchAt].transactionDate : null;
    /**
     * The newest row the game has finished writing — the anchor for BOTH halves of
     * the fix.
     *
     * Everything above it belongs to a day still being merged into, so it is neither
     * written now nor pointed at by the marker. The two have to move together: an
     * anchor below the open day with the open day still being written would make the
     * next run re-read and re-insert it, which is the double-count this replaces.
     */
    const anchor = (0, resource_sweep_rules_js_1.buildCursorFingerprints)(stitched, openDates);
    result.cursorAnchorDate = anchor.anchorDate;
    // The marker may only advance when the sweep actually read the ground between the
    // new anchor and where it stopped — otherwise the unread rows below it end up
    // beneath every future cut, permanently. See ANCHOR_SAFE_STOP_REASONS.
    const anchorSafe = resource_sweep_rules_js_1.ANCHOR_SAFE_STOP_REASONS.has(result.stopReason);
    result.cursorRows = anchorSafe ? anchor.fingerprints : [];
    if (!anchorSafe && anchor.fingerprints.length > 0) {
        log.warn({ noAlert: true }, 'Resource capture: not moving the marker forward — the sweep ended on '
            + `"${result.stopReason}" after ${result.pagesScanned} page(s), so there may be rows below `
            + 'the anchor it never read, and anchoring above them would put them under every future cut. '
            + 'Keeping the previous marker instead means the next run re-reads this ground, which is '
            + 'free: rows already recorded are withheld at the write.');
    }
    // Rows to write: below the open day, above the cursor. `deferFrom` is the index of
    // the first settled row, so only the CONTIGUOUS LEADING open block is deferred — a
    // row further down that carries an open date is a misread header, and writing it
    // with a date one day out is the failure mode CLAUDE.md already accepts, whereas
    // dropping it is silent loss.
    const deferFrom = anchor.anchorAt < 0 ? cut : Math.min(anchor.anchorAt, cut);
    result.rows = stitched.slice(deferFrom, cut);
    result.deferredRows = deferFrom;
    result.completeDates = [...(0, resource_sweep_rules_js_1.readCompleteness)(stitched, cut, result.stopReason).completeDates];
    if (result.deferredRows > 0) {
        log.info(`Resource capture: holding back ${result.deferredRows} row(s) dated `
            + `${[...openDates].join(', ')} — the game is still adding to that day and its lines still `
            + 'grow. They are read in full on the next run, which is what stops a day being stored as a '
            + 'partial and then counted twice.');
    }
    if (cursor.length > 0 && cursorIndex < 0) {
        // Cursor never re-found. Legitimate when the last run was more than ~14 days
        // ago (the marker rows have aged off the list), and a red flag otherwise.
        // Keep everything: with an insert-only design the cost of being wrong here is
        // duplicate rows an admin can delete, versus silently losing days of
        // contributions. The caller reports it either way, and the write-side withhold
        // now removes the ones it already holds.
        result.cursorLost = true;
        log.warn(`Resource capture: could not re-find the previous run's position among ${stitched.length} `
            + `row(s) read (oldest "${dateLabel}") — ${describeCursorNearMiss(stitched, cursor)}. Keeping `
            + 'every row, which may duplicate rows already recorded — expected if the last successful '
            + 'capture was more than about a fortnight ago, since the marker rows will have aged off the '
            + 'list. Worth investigating otherwise, and the near-miss above says which way: a window that '
            + 'nearly aligned means the marker rows ARE there and the match rule is too strict, while one '
            + 'that barely aligned at all means they are genuinely gone.');
    }
    log.info(`Resource capture finished: ${result.pagesScanned} page(s), ${stitched.length} row(s) read, `
        + `${result.rows.length} new`
        + (result.deferredRows > 0 ? `, ${result.deferredRows} held back as still-open` : '')
        + (result.unmatchedNames.length > 0
            ? `, ${result.unmatchedNames.length} name(s) not on the roster`
            : ''));
    return result;
}
//# sourceMappingURL=resource-history-capture.js.map