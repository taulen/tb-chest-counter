/**
 * Daily Clan Capital resource-history capture phase.
 *
 * It never writes a row the game can still change, so there is never a stale
 * amount to supersede later: a game day is written exactly once, in full, by the
 * first run after that day closes. The cost is that the newest day's donations
 * appear a run late; the alternative was storing every day as a partial and then
 * either freezing it or counting it twice. See the header of
 * browser/resource-history-capture.ts for the measurements behind that.
 *
 * Runs at most once per game day per clan, after the might snapshot, which is
 * itself after the chest scan has been finalised. That ordering is the safety
 * argument, exactly as it is for might: by the time this runs the gift sweeps
 * have committed and the scan_sessions row is written, so nothing this phase does
 * or fails to do can cost chest data.
 *
 * What it does NOT do:
 *
 *   - it never deletes a resource_transactions row. The capture is insert-only,
 *     which is why a manual upload and an automated run covering the same date
 *     are reported as an overlap for an admin to resolve rather than one silently
 *     overwriting the other;
 *   - it never creates a scan_sessions row, touches the state machine, or sets
 *     lastScanError, so a failure here cannot present as a scan failure;
 *   - it never throws out of its call site (the caller swallows), so the worst
 *     case is a logged no-op and a day that gets picked up on the next run —
 *     harmless, because the in-game list keeps about 14 days.
 *
 * A name that doesn't resolve to a roster member IS created here, unlike in might
 * capture. That's deliberate and matches the manual upload path: a resource
 * contribution is evidence the player exists and the row carries a real amount,
 * so dropping it would lose data. The new member lands in the review queue with
 * a crop attached.
 */
import type { Page } from 'playwright';
import type { AppConfig, ClanMember } from '../models/types.js';
import { childLogger } from '../utils/logger.js';
import { currentGameDate, daysBetweenGameDates } from '../utils/game-day.js';
import {
  isResourceHistoryCalibrated,
  missingResourceHistoryTargets,
} from '../config/calibration.js';
import { captureResourceHistory, pruneUnreferencedCrops } from '../browser/resource-history-capture.js';
import type { ResourceHistoryRow } from '../browser/resource-history-capture.js';
import {
  CURSOR_MIN_RUN,
  maxDaysBackFor,
  withholdAlreadyRecorded,
} from '../browser/resource-sweep-rules.js';
import { getAllMembers, upsertMember } from '../data/repositories/member-repo.js';
import { loadPlayerNameCanonicaliser } from '../data/repositories/merge-repo.js';
import { getClanById } from '../data/repositories/clan-repo.js';
import {
  createBatch,
  updateBatchCounts,
  insertTransactions,
  listResourceTypes,
  getCaptureCursor,
  saveCaptureCursor,
  deleteBatch,
  listRecordedScanRows,
} from '../data/repositories/resource-repo.js';
import { logSystemAction } from '../data/repositories/user-repo.js';
import { invalidateReviewQueueCount } from '../data/repositories/review-queue-repo.js';

const log = childLogger('resource-capture');

/** How many names to list in a log line before truncating. */
const NAME_SAMPLE_LIMIT = 10;

/**
 * Say why the sweep stopped in words, not in a code.
 *
 * The raw values are terse enough to be read as something else — `stopped on
 * "cursor"` beside `reached back to "YESTERDAY"` was read as the day label
 * being the stop condition, which sent a real investigation after a bug that
 * did not exist. The Clans page has always spelled these out (see the STOP map
 * in clans.js); the log had no reason not to.
 */
function describeStopReason(reason: string | undefined): string {
  switch (reason) {
    case 'cursor': return 'it reached the previous run\'s position — everything below was already recorded';
    case 'date-floor': return 'it hit the date backstop — the previous run\'s position was never '
      + 'found and the sweep had already read further back than this run should need';
    case 'end-of-list': return 'the list ended';
    case 'blank': return 'the rows stopped appearing (an overlay that would not close, or the list ended)';
    case 'no-new-rows': return 'the list kept scrolling but stopped producing new rows — the read may be incomplete';
    case 'page-limit': return 'it hit the page limit — the read is truncated';
    case 'crashed': return 'the browser crashed mid-sweep — the read is partial';
    case 'error': return 'an error ended the sweep';
    default: return `of "${reason ?? 'unknown'}"`;
  }
}

export interface ResourceCapturePhaseContext {
  config: AppConfig;
  clanId: number;
  reportProgress?: (message: string) => void;
  /**
   * Ignore the once-a-day gate.
   *
   * Set by the admin "Collect now" action. Safe in a way the equivalent might
   * flag isn't even required to be: the cursor means a forced re-run reads the
   * same list, re-finds its own marker from minutes ago, and inserts nothing.
   * That makes repeated runs the normal way to debug this feature.
   */
  force?: boolean;
  /**
   * Ignore the cursor and read the whole visible list (~14 days).
   *
   * The first run for a clan does this implicitly (there is no cursor yet). This
   * flag is for asking for it again on purpose — after fixing an OCR bug, say, or
   * to recover after a capture batch has been deleted.
   *
   * It used to warn that rows already recorded would be re-inserted. They are not
   * any more: the write-side withhold declines anything this clan already holds,
   * which is what makes a backfill safe to run repeatedly and makes it the
   * recovery tool rather than a way to compound the problem.
   */
  fullBackfill?: boolean;
  /** Cap on scroll pages, to keep an interactive debugging run short. */
  maxPages?: number;
  /**
   * Keep a PNG of every scroll page.
   *
   * Set for the interactive "Collect now" run and not for the scheduled one. While
   * this feature is being proved out, the questions that matter are all about
   * specific frames — is the rectangle clipping the resource icon, what did the page
   * where the sweep stopped look like — and only the pixels answer those.
   */
  debugSavePages?: boolean;
  /**
   * Read the list and report what was found, but write NOTHING.
   *
   * The mode this feature is actually iterated in. A plain forced run stops at the
   * cursor after one page (correctly — there is nothing new), so it produces one
   * page of evidence; a full backfill sweeps everything but also inserts it,
   * compounding the duplicate-date problem you were trying to diagnose. Neither
   * lets you look at a complete sweep without paying for it in data.
   *
   * A dry run creates no batch, inserts no transactions, creates no members and
   * does not move the cursor — so it can be run as often as needed, and the next
   * real run behaves exactly as if it had never happened.
   */
  dryRun?: boolean;
}

export interface ResourceCapturePhaseOutcome {
  ran: boolean;
  /** Why the phase declined to run, for logging. Absent when it ran. */
  skipped?:
    | 'disabled'
    | 'clan-disabled'
    | 'clan-auto-disabled'
    | 'not-calibrated'
    | 'page-closed'
    | 'already-captured-today'
    | 'navigation-failed'
    | 'no-rows';
  gameDate?: string;
  batchId?: number;
  /** Rows read off the list, before the cursor cut. */
  rowsSeen?: number;
  /** Rows actually written. */
  rowsInserted?: number;
  /** Rows written with no resource type — the ones an admin has to resolve. */
  unresolvedRows?: number;
  /** Rows read but held back because their day is still being written to in-game.
   *  Not lost: the next run reads them complete. */
  deferredRows?: number;
  /** Rows read that this clan already held, so they were not inserted again. */
  withheldRows?: number;
  /** transaction_date the stored marker now points at, when it moved. */
  anchorDate?: string;
  /** Roster names created from this run. */
  created?: string[];
  pagesScanned?: number;
  /** True when the previous run's position couldn't be re-found, so rows may
   *  duplicate what's already recorded. */
  cursorLost?: boolean;
  /** Why the scroll sweep ended — see ResourceHistoryCaptureResult.stopReason.
   *  Surfaced because "stopped because it reached known ground" and "stopped
   *  because the list stopped advancing" need very different responses. */
  stopReason?: string;
  /** Oldest date label the sweep reached, e.g. "6 DAYS AGO". The quickest check
   *  that a run covered what it should have. */
  oldestDateLabel?: string;
  /** True when this was a read-only diagnostic run — nothing was written. */
  dryRun?: boolean;
  /** Directory this run's debug frames went to, for copying off the box. */
  debugDir?: string;
  /** A few unresolved rows, for a dry run where they aren't in the database to
   *  look at. Enough to spot a pattern (one resource? one amount range?). */
  unresolvedSamples?: string[];
  error?: string;
}

/**
 * Run one resource-history capture for a clan.
 *
 * Returns an outcome rather than throwing for anything an operator could act on;
 * genuinely unexpected errors propagate to the caller, which swallows them.
 */
export async function runResourceCapturePhase(
  ctx: ResourceCapturePhaseContext,
  page: Page,
): Promise<ResourceCapturePhaseOutcome> {
  const {
    config, clanId, reportProgress, force = false, fullBackfill = false, dryRun = false,
  } = ctx;

  if (!config.resourceCaptureEnabled && !force) {
    return { ran: false, skipped: 'disabled' };
  }

  const clan = getClanById(clanId);
  if (!clan?.resourcesEnabled) {
    log.info(
      `Resource capture skipped for clan #${clanId} — resource tracking is turned off for this `
      + 'clan. Enable it on the clan\'s settings before the daily capture can run.',
    );
    return { ran: false, skipped: 'clan-disabled' };
  }

  // Per-clan opt-out of the DAILY read, honoured only for scheduled runs: `force`
  // means a human just pressed a button for this clan, and refusing that because the
  // schedule is off would be obtuse — the button is how you test a clan you have
  // deliberately excluded.
  if (!clan.resourceAutoCapture && !force) {
    log.info(
      `Resource capture skipped for clan #${clanId} — this clan is excluded from the daily read `
      + '(Clans → Resource Tracking). Manual "Collect now" still works.',
    );
    return { ran: false, skipped: 'clan-auto-disabled' };
  }

  if (!isResourceHistoryCalibrated()) {
    log.warn(
      { noAlert: true },
      `Resource capture skipped for clan #${clanId} — calibration is incomplete. Outstanding: `
      + `${missingResourceHistoryTargets().join('; ')}.`,
    );
    return { ran: false, skipped: 'not-calibrated' };
  }

  if (page.isClosed()) {
    log.info(`Resource capture skipped for clan #${clanId} — the browser was already closed.`);
    return { ran: false, skipped: 'page-closed' };
  }

  const gameDate = currentGameDate(config.gameDayRolloverUtcHour);
  const cursor = getCaptureCursor(clanId);

  if (!force && !dryRun && cursor?.gameDate === gameDate) {
    log.info(
      `Resource capture skipped for clan #${clanId} — already captured for game day ${gameDate} `
      + `(at ${cursor.capturedAt}). Use "Collect now" to re-read it before the next rollover.`,
    );
    return { ran: false, skipped: 'already-captured-today', gameDate };
  }

  // Note on the dates below, which the capture derives for itself.
  //
  // The list's day headers follow the game ACCOUNT's calendar day, not the 17:00 UTC
  // reset, and expose no time at all — so some rows near the boundary land on the
  // game day next to the one they truly belong to. Measured against a per-clan
  // timezone setting and judged not worth the knob (migration v65): these rows are
  // read for per-member totals over weeks, where a few rows moving between adjacent
  // days changes nothing, and no setting could do better than approximate it anyway.
  // What matters is that every row lands on exactly one real day.
  //
  // The one place it DOES matter is which day is still open, because a row on an open
  // day is one the game can still change. The capture answers that from the labels it
  // reads per page rather than from anything computed here — see `openDates`.
  const members = getAllMembers(false, clanId);
  const allTypes = listResourceTypes();
  // Deliberately absent on a dry run. Per-row crops live in a directory that the
  // retention sweep skips on purpose (their lifetime is the DB row that points at
  // them) — so writing them with no row to own them would leak files forever. The
  // per-page screenshots are the better evidence for this anyway.
  const cropToken = dryRun
    ? undefined
    : `scan${clanId}_${gameDate.replace(/-/g, '')}_${Date.now().toString(36)}`;

  // A dry run always reads the whole list: its entire purpose is to see a complete
  // sweep, and stopping at the cursor after one page is what made the last diagnostic
  // attempt useless.
  const cursorRows = (fullBackfill || dryRun) ? [] : (cursor?.topRows ?? []);

  // How far back this run could conceivably need to read, from the one thing known
  // outside the list itself: when the last capture ran. The capture uses it only as a
  // backstop behind the cursor — see the check in captureResourceHistory's scroll loop.
  //
  // Null whenever there is no cursor to fall behind (first run, backfill, dry run) or
  // the stored game day won't parse, and never negative: a cursor whose game day is in
  // the future means the clock or the setting moved, and clamping a nonsense number
  // into a stop condition is worse than leaving the sweep unbounded.
  //
  // Measured from `newestDate` — the day the stored MARKER rows are dated — not from
  // `gameDate`, which is only when the phase last ran. Those used to be the same
  // thing. They are not any more: a run that reads nothing settled leaves the marker
  // where it was while still closing the once-a-day gate, so the marker can be three
  // days old on a run whose gate date is one day old. Sizing the backstop from the
  // gate date then stops the sweep BEFORE it reaches the marker it is hunting for,
  // which declares the cursor lost and re-reads the whole window — the failure feeding
  // itself. Falls back to gameDate for a cursor written before this column meant this.
  const markerDate = cursor?.newestDate || cursor?.gameDate;
  const daysSinceCapture = cursorRows.length > 0 && markerDate
    ? daysBetweenGameDates(markerDate, gameDate)
    : null;
  const maxDaysBack = daysSinceCapture != null && daysSinceCapture >= 0
    ? maxDaysBackFor(daysSinceCapture)
    : undefined;

  log.info(
    `Resource capture starting for clan #${clanId} (game day ${gameDate}, `
    + `${members.length} roster member(s), `
    + `${cursorRows.length > 0 ? `cursor of ${cursorRows.length} row(s)` : 'no cursor — full read'}`
    + (maxDaysBack != null
      ? `, last captured ${daysSinceCapture === 0 ? 'today' : `${daysSinceCapture} day(s) ago`} so `
        + `the sweep stops if it gets past ${maxDaysBack} day(s) back`
      : '')
    + ').',
  );

  const capture = await captureResourceHistory(page, {
    members,
    allTypes,
    rolloverUtcHour: config.gameDayRolloverUtcHour,
    cursor: cursorRows,
    // Always the stored marker, even when `cursor` above is deliberately empty for a
    // backfill or a dry run: this one is only ever used to check that dates still mean
    // what they meant last run. See the withhold's gate below.
    verifyCursor: cursor?.topRows ?? [],
    maxDaysBack,
    cropToken,
    maxPages: ctx.maxPages,
    debugSavePages: ctx.debugSavePages,
    reportProgress,
  });

  if (capture.navigationFailed) {
    log.warn(
      `Resource capture could not reach the history list for clan #${clanId}: `
      + capture.navigationError,
    );
    return {
      ran: false,
      skipped: 'navigation-failed',
      gameDate,
      error: capture.navigationError,
      pagesScanned: capture.pagesScanned,
    };
  }

  // Whether the marker this sweep produced may replace the stored one.
  //
  // The capture already refuses to hand one back when the sweep stopped somewhere
  // that leaves unread rows below it; this catches the other case, a marker too short
  // to be re-findable. Below CURSOR_MIN_RUN the matcher will not even attempt a
  // needle, so storing one would silently arm a full-window duplicate sweep next run.
  const anchorUsable = capture.cursorRows.length >= CURSOR_MIN_RUN;

  /**
   * Does a date still mean this run what it meant last run?
   *
   * The withhold compares rows by (name, direction, amount, resource, DATE), so it is
   * only sound while that last field is a stable identity — and it is not
   * unconditionally. A row's date is `gameDate(run) - labelDaysAgo`, and the two
   * clocks differ: `gameDate` ticks at 17:00 UTC, the "N DAYS AGO" label ticks at the
   * game ACCOUNT's calendar midnight. A run on the other side of that midnight from
   * the previous one therefore dates every row it reads a day differently.
   *
   * That matters here far more than it does anywhere else the drift is discussed. A
   * shifted read lines the newly-settled day up against the PREVIOUS day's stored
   * rows, and 10.9% of this clan's rows share their exact key with a row on the
   * adjacent date — so the withhold would decline genuine rows as already-recorded,
   * and the marker would then advance past them. That is silent, permanent loss, in a
   * feature whose entire purpose is to avoid it.
   *
   * The check is exact and needs no migration: the stored marker points at a physical
   * row, and `newest_date` is the date it was stored under. If that same row reads
   * back with a different date, the mapping has moved and no date-keyed comparison is
   * valid this run. Scheduled runs are stable (all 35 real batches align at offset 0);
   * an operator pressing "Collect now" at another hour is what moves it.
   *
   * Unproven means the withhold is simply off, which re-inserts rows already held —
   * visible in the batch list and deletable. Failing the other way is not recoverable.
   */
  const dateMappingProven = !!cursor?.newestDate
    && capture.cursorMatchDate != null
    && capture.cursorMatchDate === cursor.newestDate;

  /**
   * Rows this clan already holds, declined rather than inserted.
   *
   * Computed BEFORE the dry-run return so a dry run can report what a real run would
   * write — that report is the whole reason the mode exists, and the recovery
   * procedure for a lost marker reads it before deciding whether to backfill.
   * Guarded on an empty read: `fromDate` would be undefined and better-sqlite3
   * refuses an undefined binding, which would throw out of the phase on the most
   * ordinary outcome there is (a forced re-run inside the same day reads nothing new).
   */
  const withheld = capture.rows.length === 0 || !dateMappingProven
    ? { rows: capture.rows, withheld: 0, byDate: {} as Record<string, number> }
    : withholdAlreadyRecorded(
      capture.rows,
      listRecordedScanRows(
        clanId,
        capture.rows.reduce((min, r) => (r.transactionDate < min ? r.transactionDate : min),
          capture.rows[0].transactionDate),
      ),
      new Set(capture.completeDates),
    );
  const writeRows = withheld.rows;
  if (!dateMappingProven && capture.rows.length > 0 && (cursor?.topRows.length ?? 0) > 0) {
    log.warn(
      { noAlert: true },
      `Resource capture for clan #${clanId}: not comparing this read against rows already `
      + 'recorded, because the marker row '
      + (capture.cursorMatchDate == null
        ? 'could not be located, so there is nothing to date-check against.'
        : `now reads as ${capture.cursorMatchDate} but was stored as ${cursor?.newestDate} — the `
          + 'day labels have shifted relative to the 17:00 UTC game day, so every date this run '
          + 'read is offset and matching on it would decline genuine rows.')
      + ' Rows already held may therefore be written again; they are visible on the batch and '
      + 'can be deleted, which is the recoverable direction.',
    );
  }
  if (withheld.withheld > 0) {
    const perDate = Object.entries(withheld.byDate)
      .map(([d, n]) => `${d}: ${n}`).join(', ');
    log.warn(
      { noAlert: capture.cursorLost ? undefined : true },
      `Resource capture: ${withheld.withheld} of ${capture.rows.length} row(s) read for clan `
      + `#${clanId} are already recorded, so they were not written again (${perDate}). `
      + (capture.cursorLost
        ? 'This run lost the previous marker and re-read ground it already held — that is what '
        + 'the withhold is for, and no duplicates were created. The marker is still the thing to fix.'
        : 'Expected on a full backfill or a re-run; unexpected on a routine daily run.'),
    );
  }

  // Dry run: report and stop, before anything can be written. Placed here — after
  // the capture, before the first mutation — so there is exactly one place where a
  // diagnostic run could ever start touching data, rather than a flag checked at
  // each of the four write sites where one could later be missed.
  if (dryRun) {
    const unresolved = capture.rows.filter((r) => r.resourceTypeId == null);
    const samples = unresolved.slice(0, NAME_SAMPLE_LIMIT).map(
      (r) => `${r.rawPlayerName} ${r.direction > 0 ? '+' : '-'}${r.amount.toLocaleString('en-US')}`
        + ` (${r.transactionDate})`,
    );
    const pct = capture.rows.length > 0
      ? Math.round((unresolved.length / capture.rows.length) * 100)
      : 0;
    log.info(
      `Resource capture DRY RUN for clan #${clanId}: read ${capture.rows.length} row(s) across `
      + `${capture.pagesScanned} page(s), stopped because ${describeStopReason(capture.stopReason)}; `
      + `oldest row read was labelled "${capture.oldestDateLabel}". `
      + `${unresolved.length} row(s) (${pct}%) had no identifiable `
      + `resource icon. Nothing was written.`
      + ` Of the ${capture.rows.length} writable row(s), ${withheld.withheld} are already `
      + `recorded and ${writeRows.length} would be new. ${capture.deferredRows} more were held `
      + `back as belonging to a day still in progress (${capture.openDates.join(', ')}). `
      + `The marker ${anchorUsable ? `would move to ${capture.cursorAnchorDate}` : 'would NOT move'}.`
      + (samples.length > 0 ? ` Unresolved examples: ${samples.join('; ')}.` : ''),
    );
    if (capture.unmatchedNames.length > 0) {
      log.info(
        `Resource capture DRY RUN: ${capture.unmatchedNames.length} name(s) not on the roster `
        + `(no members were created): ${capture.unmatchedNames.slice(0, NAME_SAMPLE_LIMIT).join(', ')}.`,
      );
    }
    return {
      ran: true,
      dryRun: true,
      gameDate,
      rowsSeen: capture.totalRowsSeen,
      rowsInserted: 0,
      unresolvedRows: unresolved.length,
      unresolvedSamples: samples,
      pagesScanned: capture.pagesScanned,
      deferredRows: capture.deferredRows,
      withheldRows: withheld.withheld,
      anchorDate: anchorUsable ? capture.cursorAnchorDate ?? undefined : undefined,
      stopReason: capture.stopReason,
      oldestDateLabel: capture.oldestDateLabel,
      cursorLost: capture.cursorLost,
      debugDir: capture.debugDir,
    };
  }

  /**
   * Write the cursor row, on every path where the phase actually ran.
   *
   * Two independent decisions, and conflating them is a trap worth naming:
   *
   *  - `gameDate` ALWAYS advances. It is the once-a-day gate, nothing more. Leaving
   *    it behind because the marker could not move re-runs a full sweep after every
   *    scan cycle for the rest of the day.
   *  - `topRows` / `newestDate` move only when this sweep produced a marker worth
   *    keeping. Otherwise the previous one is preserved UNCHANGED — including its
   *    date, which is what `daysSinceCapture` measures, so the backstop keeps widening
   *    to reach a marker that is getting older. That pairing is what stops a run of
   *    unusable reads from stranding the days in between.
   */
  const persistCursor = (rowsInserted: number): void => {
    saveCaptureCursor({
      clanId,
      topRows: anchorUsable ? capture.cursorRows : (cursor?.topRows ?? []),
      gameDate,
      newestDate: anchorUsable
        ? (capture.cursorAnchorDate ?? gameDate)
        : (cursor?.newestDate ?? ''),
      rowsInserted,
    });
  };

  if (!anchorUsable) {
    log.warn(
      { noAlert: true },
      `Resource capture for clan #${clanId}: keeping the previous marker — this sweep produced no `
      + 'settled anchor worth storing (it read '
      + `${capture.deferredRows} row(s) on a day still in progress and stopped on `
      + `"${capture.stopReason}"). Rows read are still written; the next run re-reads from the old `
      + 'marker, and anything already recorded is withheld rather than duplicated.',
    );
  }

  if (writeRows.length === 0) {
    // Not a failure: the expected result of a second run inside the same day, of a
    // quiet clan, or of a run whose every row was either still-open or already held.
    // The gate still closes so the phase doesn't re-sweep on the next scan cycle.
    //
    // Nothing was written, so nothing points at any crop this sweep saved. This path
    // used to be a rarity and now it is the routine outcome of a deferred day, so
    // skipping the prune would leak every unresolved-row crop of every such run into
    // a directory the retention sweep deliberately skips.
    await pruneUnreferencedCrops(capture.cropPathsWritten, []);
    persistCursor(0);
    log.info(
      `Resource capture found no new rows to write for clan #${clanId} (read `
      + `${capture.totalRowsSeen} row(s) across ${capture.pagesScanned} page(s); `
      + `${capture.deferredRows} held back as still-open, ${withheld.withheld} already recorded).`,
    );
    return {
      ran: true,
      skipped: 'no-rows',
      gameDate,
      rowsSeen: capture.totalRowsSeen,
      rowsInserted: 0,
      deferredRows: capture.deferredRows,
      withheldRows: withheld.withheld,
      anchorDate: anchorUsable ? capture.cursorAnchorDate ?? undefined : undefined,
      pagesScanned: capture.pagesScanned,
      cursorLost: capture.cursorLost,
      stopReason: capture.stopReason,
      oldestDateLabel: capture.oldestDateLabel,
      debugDir: capture.debugDir,
    };
  }

  // Resolve names the OCR couldn't tie to a roster member by creating them,
  // exactly as the manual upload and the chest scan do. They surface in the New
  // Members review queue, and each row keeps its crop so an admin can see the
  // original and rename or merge from there.
  //
  // Through the clan's player merge rules, which the fuzzy match inside the OCR
  // pass has no access to — it is handed a member list, not a database. A rule is
  // the admin saying "this reading IS that player", so applying it here is what
  // stops a name they have already merged away being minted as a fresh member on
  // every capture. `upsertMember` resolves the rule's destination by name (and by
  // alias), so a rule pointing at a live member attaches the rows to them instead
  // of creating anything.
  //
  // A rule OVERRIDES the match the OCR pass already made, rather than only filling
  // in for a miss. It has to: while a duplicate member row still exists for the
  // misread spelling, the fuzzy match finds it, `row.memberId` comes back set, and a
  // rule consulted only on the null path would never be reached — so the rows would
  // keep landing on the duplicate for as long as it survives, which is exactly the
  // state an admin writes the rule to end. The gift scan applies rules over its own
  // match result the same way (scan-pipeline.ts).
  //
  // `row.rawPlayerName` itself is deliberately left alone: it is what the sweep's
  // ordered cursor fingerprints are built from (see sweepRowKey in
  // resource-history-capture.ts), and rewriting it would silently invalidate the
  // stored cursor and re-read days already held.
  const canonicalisePlayerName = loadPlayerNameCanonicaliser(clanId);
  const createdMembers = new Map<string, number>();
  const ruleResolved = new Map<string, number>();
  const resolved: Array<ResourceHistoryRow & { memberId: number }> = [];
  for (const row of writeRows) {
    let memberId = row.memberId;
    const name = canonicalisePlayerName(row.rawPlayerName);
    const viaRule = name !== row.rawPlayerName;
    if (viaRule || memberId == null) {
      const cache = viaRule ? ruleResolved : createdMembers;
      const existing = cache.get(name);
      if (existing !== undefined) {
        memberId = existing;
      } else {
        memberId = upsertMember(name, clanId).id;
        cache.set(name, memberId);
      }
    }
    resolved.push({ ...row, memberId });
  }
  if (ruleResolved.size > 0) {
    log.info(
      `Resource capture resolved ${ruleResolved.size} name(s) through a player merge rule for `
      + `clan #${clanId}: ${[...ruleResolved.keys()].slice(0, NAME_SAMPLE_LIMIT)
        .map((n) => JSON.stringify(n)).join(', ')}`
      + `${ruleResolved.size > NAME_SAMPLE_LIMIT ? ', …' : ''}.`,
    );
  }
  if (createdMembers.size > 0) {
    invalidateReviewQueueCount(clanId);
    log.info(
      `Resource capture created ${createdMembers.size} new member(s) for clan #${clanId} from `
      + `names not on the roster: ${[...createdMembers.keys()]
        .slice(0, NAME_SAMPLE_LIMIT)
        .map((n) => JSON.stringify(n))
        .join(', ')}${createdMembers.size > NAME_SAMPLE_LIMIT ? ', …' : ''}.`,
    );
  }

  const unresolvedRows = resolved.filter((r) => r.resourceTypeId == null).length;
  const notes = [
    `Automated capture · game day ${gameDate}`,
    `${capture.pagesScanned} page(s), ${capture.totalRowsSeen} row(s) read`,
    capture.cursorLost ? 'previous position not re-found — rows may duplicate earlier ones' : '',
    capture.deferredRows > 0
      ? `${capture.deferredRows} row(s) deferred — ${capture.openDates.join(', ')} still in progress`
      : '',
    withheld.withheld > 0 ? `${withheld.withheld} row(s) already recorded, not written again` : '',
    // Says on the batch that the read was cut short, so a short row count reads as a
    // truncated sweep rather than as a quiet clan.
    ['blank', 'no-new-rows', 'error'].includes(capture.stopReason)
      ? `sweep ended early on "${capture.stopReason}" — read may be partial` : '',
    anchorUsable ? '' : 'marker not advanced — next run re-reads from the previous position',
    // Says on the batch itself that the sweep was cut short deliberately, so an admin
    // deciding whether to delete it knows the overlap was bounded rather than open-ended.
    capture.stopReason === 'date-floor' ? 'stopped at the date backstop' : '',
    capture.truncated ? 'page limit reached — read may be partial' : '',
    // Says so on the batch itself, so an admin looking at a short row count later
    // knows it was cut off rather than that the clan went quiet.
    capture.stopReason === 'crashed' ? 'browser crashed mid-sweep — partial read' : '',
  ].filter(Boolean).join(' · ');

  const batch = createBatch({
    clanId,
    // No user behind an automated run. v55 made this column nullable for exactly
    // this class of ownerless batch.
    uploadedBy: null,
    uploadDate: gameDate,
    // A scroll sweep isn't "files"; count pages so the admin batch list shows
    // something meaningful rather than a hardcoded 1.
    fileCount: capture.pagesScanned,
    rowCount: resolved.length,
    errorCount: capture.errors.length,
    notes,
    source: 'scan',
  });

  try {
    insertTransactions(resolved.map((r) => ({
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
  } catch (err) {
    // The batch row is already committed at this point, so leaving it would show
    // an admin a capture that claims rows it doesn't have. Drop it and report
    // nothing captured — the list is persistent, so the next run re-reads these
    // same rows from the same cursor.
    log.error(
      { err },
      `Resource capture failed to write ${resolved.length} row(s) for clan #${clanId}; removing the `
      + 'empty batch. The rows are still in the game and will be re-read on the next run.',
    );
    try {
      deleteBatch(batch.id, clanId);
    } catch (cleanupErr) {
      log.warn(`Resource capture could not remove batch #${batch.id}: ${String(cleanupErr)}`);
    }
    // Nothing was written, so nothing points at any of this sweep's crops.
    await pruneUnreferencedCrops(capture.cropPathsWritten, []);
    return {
      ran: false,
      gameDate,
      error: `Writing rows failed: ${String(err instanceof Error ? err.message : err)}`,
      rowsSeen: capture.totalRowsSeen,
      pagesScanned: capture.pagesScanned,
    };
  }

  // Now — and only now — is it known which crops a database row actually holds. Every
  // unknown row is photographed on several pages and gets a crop each time, so most of
  // them belong to reads that a clean read superseded and nothing references. See
  // pruneUnreferencedCrops for why this cannot be decided while reading.
  const prunedCrops = await pruneUnreferencedCrops(capture.cropPathsWritten, resolved);
  if (prunedCrops > 0) {
    log.info(
      `Resource capture removed ${prunedCrops} row crop(s) belonging to reads that a later page `
      + `resolved; ${capture.cropPathsWritten.length - prunedCrops} kept for the row(s) still unknown.`,
    );
  }

  updateBatchCounts(batch.id, {
    fileCount: capture.pagesScanned,
    rowCount: resolved.length,
    errorCount: capture.errors.length,
    notes,
  });

  // Cursor moves only after the rows are safely written, so a crash between the
  // two re-reads rather than skips.
  persistCursor(resolved.length);

  logSystemAction(clanId, 'resources.capture', {
    batchId: batch.id,
    gameDate,
    rowsSeen: capture.totalRowsSeen,
    rowsInserted: resolved.length,
    unresolvedRows,
    pagesScanned: capture.pagesScanned,
    newMembers: createdMembers.size,
    cursorLost: capture.cursorLost,
    deferredRows: capture.deferredRows,
    withheldRows: withheld.withheld,
    anchorDate: anchorUsable ? capture.cursorAnchorDate : null,
  });

  if (unresolvedRows > 0) {
    log.warn(
      { noAlert: true },
      `Resource capture wrote ${unresolvedRows} row(s) for clan #${clanId} whose resource could not `
      + 'be identified from the icon. They are listed under Resources → Admin → Unresolved rows, '
      + 'each with a crop of the original row.',
    );
  }

  log.info(
    `Resource capture done for clan #${clanId}: ${resolved.length} row(s) written from `
    + `${capture.totalRowsSeen} read across ${capture.pagesScanned} page(s) (batch #${batch.id}, `
    // Worded to keep these two apart. They sat side by side as
    // `stopped on "cursor", reached back to "YESTERDAY"` and read as though the
    // day label were the stop condition — it never is. Where a sweep stops is
    // decided only by the cursor (or by running out of list); the label just
    // says how far back the rows it read go.
    + `stopped because ${describeStopReason(capture.stopReason)}; oldest row read was `
    + `labelled "${capture.oldestDateLabel}")`
    + (unresolvedRows > 0 ? `, ${unresolvedRows} unresolved` : '')
    + (createdMembers.size > 0 ? `, ${createdMembers.size} new member(s)` : '')
    + '.'
    + (capture.deferredRows > 0
      ? ` ${capture.deferredRows} row(s) were held back because `
        + `${capture.openDates.join(', ')} is still being written to in-game; the next run reads `
        + 'that day complete.'
      : '')
    + (withheld.withheld > 0
      ? ` ${withheld.withheld} row(s) read were already recorded and were not written again.`
      : ''),
  );

  return {
    ran: true,
    gameDate,
    batchId: batch.id,
    deferredRows: capture.deferredRows,
    withheldRows: withheld.withheld,
    anchorDate: anchorUsable ? capture.cursorAnchorDate ?? undefined : undefined,
    rowsSeen: capture.totalRowsSeen,
    rowsInserted: resolved.length,
    unresolvedRows,
    created: [...createdMembers.keys()],
    pagesScanned: capture.pagesScanned,
    cursorLost: capture.cursorLost,
    stopReason: capture.stopReason,
    oldestDateLabel: capture.oldestDateLabel,
    debugDir: capture.debugDir,
  };
}
