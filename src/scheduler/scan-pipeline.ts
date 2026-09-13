// Pipelined scanner — opens gifts one-by-one by clicking the topmost
// Open button, batches 4 clicks per screenshot to minimise the
// expensive Chromium compositor flush, then OCRs every captured crop
// and inserts each card as a DB row.
//
// Two phases:
//
//   CAPTURE PHASE — fast loop that screenshots, crops the topmost
//   card region, clicks the Open button N times, repeats. Every batch
//   it OCRs the latest crop as a probe; if the probe returns no card
//   we exit (the list is empty, a popup appeared, or OCR transiently
//   failed). All saved crops stay in memory until phase 2.
//
//   OCR PHASE — process every captured crop in order, run the
//   normalization pipeline, insert each as a DB row. Failures here
//   drop one chest, not the whole scan.
//
// Refuses to run if calibration hasn't been done — pipelined mode
// requires the operator to have clicked the Open button location and
// dragged the card-crop rectangle via the admin Calibrate UI first.

import type { Page } from 'playwright';
import type { AppConfig, VisionExtractionResult, ChestRecord } from '../models/types.js';
import type { VisionProvider } from '../vision/provider.js';
import { getCanvasBounds } from '../browser/navigator.js';
import { mouseDown, mouseMove, mouseUp } from '../browser/input.js';
import { captureFullPage, captureRegion, saveScreenshot } from '../browser/screenshotter.js';
import * as chestRepo from '../data/repositories/chest-repo.js';
import * as triumphalChestRepo from '../data/repositories/triumphal-chest-repo.js';
import * as triumphalPointsRepo from '../data/repositories/triumphal-points-repo.js';
import * as memberRepo from '../data/repositories/member-repo.js';
import * as clanRepo from '../data/repositories/clan-repo.js';
import { applyMergeRulesCached, loadMergeRules, loadChestTypeOverrides } from '../data/repositories/merge-repo.js';
import { loadOverrides as loadSourcePointOverrides, getPointsForSourceCached } from '../data/repositories/source-points-repo.js';
import { correctChestName, correctTriumphalChestName, getChestRarity, isKnownChestName } from '../vision/chest-names.js';
import { cleanPlayerName, matchKnownPlayer, isLikelyNonLatinName } from '../vision/player-names.js';
import { cleanSource } from '../vision/source-names.js';
import { childLogger } from '../utils/logger.js';
import { createCoalescedWarner } from '../utils/log-throttle.js';
import { memorySnapshot } from '../utils/memory-snapshot.js';
import { giftEarnedAtMs } from '../utils/gift-time.js';
import { cropRegion, annotateScreenshot } from '../utils/image.js';
import { MISSING_NAME_CROP_DIR } from '../utils/crop-dirs.js';

const log = childLogger('scanner');

/**
 * Sentinel player name for rows where OCR failed to read the player-name
 * region. Brackets ensure it can't collide with a real in-game name (the
 * cleanPlayerName regex strips brackets from real input). All rows
 * sharing this sentinel group under one synthetic member so the operator
 * can find and correct them from the members UI while correlating with
 * the debug screenshots saved to data/screenshots/ocr_missing_name/.
 */
export const UNKNOWN_PLAYER_NAME = '[Unknown]';

/** Placeholder that replaces a batch crop once the OCR phase has finished with
 *  it, so the buffer can be collected while `crops` keeps its indices (crop N
 *  is still crop N for every log line and filename). */
const EMPTY_CROP = Buffer.alloc(0);

export interface TabScanResult {
  gifts: VisionExtractionResult['gifts'];
  chestsFound: number;
  newChests: number;
  errors: number;
  screenshots: number;
  /** Count of inserted rows where OCR produced an empty player name and we
   *  fell back to UNKNOWN_PLAYER_NAME. Surfaced on the session as an error
   *  banner so the operator knows to review the saved debug crops. */
  unknownNames: number;
  /**
   * Why the capture phase gave up early, or null if it ran to the end of the
   * list. Carried out of the sweep because an abandoned sweep is otherwise
   * indistinguishable from a short one: the 2026-08-04 stall went into the
   * books as a plain COMPLETED session with 232 chests, and the five hours,
   * the OOM kills and the browser crash left no mark on the row at all. The
   * finalizer turns this into the session's errorMessage/errorPhase.
   */
  stallReason: string | null;
}

/**
 * Caller-supplied context. ScanLoop owns the long-lived state
 * (config, vision provider, active clan, progress reporter, monotonic
 * captured-at counter, live chest count); the pipeline is a pure-ish
 * function that reads/writes through these handles without owning any
 * of them.
 */
export interface ScanPipelineContext {
  config: AppConfig;
  vision: VisionProvider;
  clanId: number;
  reportProgress: (phase: 'scan', message: string) => void;
  /** Monotonic ISO captured-at generator. See ScanLoop.nextCapturedAt
   *  for why this needs to be strictly-monotonic across inserts. */
  nextCapturedAt: () => string;
  /** Increment the in-flight chest counter shown in the admin header.
   *  Only called for gifts-tab inserts; triumphal sweeps are
   *  bookkeeping only and don't move the counter. */
  incrementLiveChestCount: () => void;
}

export async function scanCardsPipelined(
  ctx: ScanPipelineContext,
  page: Page,
  sessionId: number,
  target: 'gifts' | 'triumphal' = 'gifts',
): Promise<TabScanResult> {
  const { config, vision, clanId, reportProgress, nextCapturedAt, incrementLiveChestCount } = ctx;
  const tabResult: TabScanResult = {
    gifts: [], chestsFound: 0, newChests: 0, errors: 0, screenshots: 0, unknownNames: 0, stallReason: null,
  };

  // Refuse if not calibrated. Should already be blocked at the
  // admin-settings save endpoint, but defensive double-check in case
  // someone edits app.env directly.
  const xPct = config.scanOpenButtonXPct;
  const yPct = config.scanOpenButtonYPct;
  const cropLeftPct = config.scanCropLeftPct;
  const cropTopPct = config.scanCropTopPct;
  const cropRightPct = config.scanCropRightPct;
  const cropBottomPct = config.scanCropBottomPct;
  if (!(xPct > 0 && yPct > 0)) {
    log.error('pipelined: click target is not calibrated. Open the admin Scanner Mode card and click Calibrate.');
    tabResult.errors++;
    return tabResult;
  }
  if (!(cropLeftPct > 0 && cropTopPct > 0 && cropRightPct > 0 && cropBottomPct > 0)
      || cropRightPct <= cropLeftPct || cropBottomPct <= cropTopPct) {
    log.error('pipelined: OCR crop region is not calibrated. Open the admin Scanner Mode card, run Calibrate, and drag a rectangle around the gift card text.');
    tabResult.errors++;
    return tabResult;
  }

  // Refuse if the active vision provider doesn't support card OCR.
  if (typeof vision.extractCardsFromCrop !== 'function') {
    log.error(`pipelined: vision provider "${vision.name}" does not support extractCardsFromCrop. Use Tesseract Only mode for now.`);
    tabResult.errors++;
    return tabResult;
  }
  const extractCards = vision.extractCardsFromCrop.bind(vision);

  // Caches: load once per scan, not per chest. The DISTANCE tier is restricted to
  // active members so an OCR'd name from a new player can't fuzzy-match a departed
  // member (e.g. "Niien" rounding to "Biin" because their Levenshtein distance
  // happens to be 2).
  //
  // Inactive members are passed separately as exact-only candidates, because the old
  // claim that this filter was "safe since upsertMember reactivates a returning
  // player" had a hole that cost real data. It only holds if the reading falls
  // through unmatched — and an inactive member with an active neighbour within 2
  // edits never does. On the live roster, "Bardin" (inactive) sat 2 edits from
  // "Bain" (active), so every Bardin chest was filed under Bain and the name never
  // reached upsertMember('Bardin') to bring him back. Self-perpetuating, and it ran
  // for months. See matchKnownPlayer for the asymmetry this restores.
  const knownMembers = memberRepo.getAllMembers(true, clanId).map((m) => m.name);
  const inactiveMemberNames = memberRepo.getAllMembers(false, clanId)
    .filter((m) => !m.isActive)
    .map((m) => m.name);
  // Give the vision provider the roster up front: PaddleOCR uses it to skip the
  // non-Latin recovery pass for names that already resolve to a known member,
  // and to pre-warm its language models so the first real recovery doesn't
  // stall mid-scan. No-op for the Tesseract provider.
  vision.setScanContext?.(knownMembers);
  const playerMergeCache = loadMergeRules('player', clanId);
  const chestMergeCache = loadMergeRules('chest', clanId);
  const sourceMergeCache = loadMergeRules('source', clanId);
  const sourcePointOverrides = loadSourcePointOverrides();
  const chestTypeOverrides = loadChestTypeOverrides(clanId);
  // Chest names this clan has already stored in a prior scan. A new chest
  // defaulting to COMMON with no override is by design — overriding is
  // optional — so the "unrecognised chest" review warning must fire only
  // the FIRST time a genuinely-new name appears, then stay quiet on every
  // subsequent scan. This mirrors how `knownMembers` gates the new-member
  // warning below; without it, every un-catalogued chest re-warns forever
  // merely for lacking an override. The warning's real job is catching
  // brand-new types / OCR garbage on first sight, not nagging about
  // already-known chests.
  const knownChestNames = new Set(
    chestRepo.getDistinctChestNames(clanId).map((c) => c.name),
  );
  // Live set of known triumphal (Bank Gifts) chest names — the global,
  // superadmin-managed catalog (triumphal_chest_points). Loaded only for
  // a triumphal sweep. The scan resolves OCR against this so newly-added
  // bank chests are recognised, and anything NOT in it is a brand-new
  // chest: stored (never dropped) and surfaced for review. Empty only if
  // the seed somehow didn't run — correctTriumphalChestName then falls
  // back to its built-in defaults.
  const triumphalKnownNames = target === 'triumphal'
    ? triumphalPointsRepo.getKnownChestNames()
    : [];
  const triumphalKnownSet = new Set(triumphalKnownNames);

  // Compute the VIEWPORT click target. Playwright's page.mouse.click()
  // uses viewport CSS pixels, and canvasBounds is reported in viewport
  // pixels too, so this part is straightforward. clickX/clickY are
  // what the game receives.
  const canvasBounds = await getCanvasBounds(page);
  const viewportClickX = Math.round(canvasBounds.x + canvasBounds.width * xPct);
  const viewportClickY = Math.round(canvasBounds.y + canvasBounds.height * yPct);

  // Crop region for the topmost card text. The four percentages were
  // saved by the operator using the calibration overlay — they
  // dragged a rectangle around the chest name / From (incl. the "Time
  // left" countdown) / Source rows on a real screenshot, so we trust
  // them blindly and don't compute offsets from the click point. The
  // countdown must be inside the crop or earned_at can't be derived.
  const viewportCrop = {
    left: Math.round(canvasBounds.x + canvasBounds.width * cropLeftPct),
    top: Math.round(canvasBounds.y + canvasBounds.height * cropTopPct),
    width: Math.round(canvasBounds.width * (cropRightPct - cropLeftPct)),
    height: Math.round(canvasBounds.height * (cropBottomPct - cropTopPct)),
  };

  log.info(
    `pipelined: starting capture phase. viewportClick=(${viewportClickX},${viewportClickY}) viewportCrop=${JSON.stringify(viewportCrop)}`,
  );

  // ─── CAPTURE PHASE (batch: 4 cards per screenshot) ───
  // The gift panel shows ~4 cards at a time. Instead of screenshotting
  // after every click (which triggers a ~3s Chromium compositor flush
  // each time), we screenshot once to capture all 4 visible cards,
  // then click the top Open button 4 times (each click opens one card
  // and the next slides up), then screenshot again. This cuts the
  // number of expensive screenshots by ~4x.
  //
  // The operator calibrates the crop rectangle to cover all 4 visible
  // card rows (same calibration UI, bigger rectangle). parseGiftText
  // already handles multi-card OCR text.
  //
  // We probe (OCR) every screenshot since they're already 3+ seconds
  // apart — adding ~100ms of OCR is negligible and lets us detect the
  // empty state immediately without wasting screenshots.
  const CLICKS_PER_BATCH = 4;
  const CLICK_DELAY_MIN_MS = 80;
  const CLICK_DELAY_MAX_MS = 140;
  // After the 4th click in a batch, give the game time to populate the
  // next set of cards before we screenshot. Without this delay the top
  // card's player-name region is often still rendering and OCR catches
  // the placeholder "Inactive Player" label instead of the real name.
  const BATCH_SETTLE_MIN_MS = 250;
  const BATCH_SETTLE_MAX_MS = 400;
  // Runaway-loop guard, not an expected ending: a healthy sweep stops when the
  // tab runs dry (`empty`), and hitting this cap is logged as exit=cap. Set by
  // the superadmin on the System page (config.scanMaxChests, default 2000) and
  // rounded UP to a whole batch, so the effective ceiling is a multiple of 4.
  const MAX_BATCHES = Math.ceil(config.scanMaxChests / CLICKS_PER_BATCH);

  // ─── Liveness bounds on the capture phase ───
  //
  // MAX_BATCHES caps how MANY batches a sweep takes. Nothing capped how LONG
  // they could take, and on 2026-08-04 that cost five hours. The host — not
  // this container, whose cgroup sat at 914MB of a 5120MB ceiling — ran out of
  // memory and the kernel started OOM-killing Chromium's children. The renderer
  // that survived stayed alive but wedged, so every batch crawled: 58 batches
  // in 4h59m37s, ~310s each against a healthy ~4s. Nothing was wrong with the
  // data (all 232 chests landed) and nothing logged a word for the whole five
  // hours, because every individual step still eventually returned. Meanwhile
  // the scan-in-progress guard held off every scheduled cycle for both clans,
  // and it ended only when the renderer finally died outright.
  //
  // Bounding the individual calls is necessary but not sufficient — input is
  // bounded now (browser/input.ts) and screenshots always were, yet a browser
  // answering everything 80× slow violates no per-call deadline. So the sweep
  // watches its own throughput, cheapest signal first.
  //
  // Note what deliberately is NOT deadlined: the OCR calls. onnxruntime-node's
  // run() is a synchronous native call (its own binding.d.ts calls it "a simple
  // synchronized inference session object wrap") behind a cosmetic
  // setImmediate, so it holds the Node event loop for its whole duration — that
  // is also why the admin UI went dead for five hours rather than merely
  // reporting a stuck scan. A Promise.race around it could never fire: the
  // timer cannot run while the thread is inside the inference. Measuring the
  // batch afterwards, which is what happens below, is the only bound available
  // without moving OCR to a worker thread.

  /**
   * A batch slower than this is evidence the browser is wedged rather than
   * busy. Healthy is ~4s — a ~3s compositor flush plus OCR, four clicks and
   * the settle delay — which also means the default 500-batch cap (2000 chests)
   * is ~33 min at a working pace. 60s is better than 10× slack over anything a
   * live browser produces, including software rendering.
   */
  const SLOW_BATCH_MS = 60_000;
  /** Consecutive slow batches before the sweep gives up. ~3 min of evidence. */
  const SLOW_BATCH_LIMIT = 3;
  /**
   * Backstop for a degradation gradual enough to stay under SLOW_BATCH_MS.
   * Generous on purpose: a first-ever scan against a big backlog is
   * legitimately long, and truncating one costs real chests, whereas being
   * late to abandon a wedged one costs a scan cycle.
   *
   * Scaled off MAX_BATCHES rather than fixed, because the batch cap is now
   * operator-settable: at the historical 400 batches a flat 45 min allowed
   * ~6.75s per batch, so that per-batch allowance is what is preserved, with
   * 45 min kept as the floor for small caps. A fixed budget would mean raising
   * the chest cap didn't raise the ceiling at all — it would just hand the real
   * limit to the clock, and a legitimately long sweep would be abandoned as
   * "stalled" instead of finishing.
   */
  const BUDGET_MS_PER_BATCH = 6_750;
  const CAPTURE_BUDGET_MS = Math.max(45 * 60_000, MAX_BATCHES * BUDGET_MS_PER_BATCH);

  type ProbeResult = Awaited<ReturnType<typeof extractCards>>['entries'];
  const crops: Buffer[] = [];
  // Wall-clock (epoch ms) each crop's screenshot was taken — the moment its
  // "time left" countdowns were true. earned_at is derived from this, not the
  // much-later insert time (a scan screenshots over many minutes but inserts
  // all rows at the end of the OCR phase). Kept in lockstep with `crops`.
  const cropTimes: number[] = [];
  const probeResults: (ProbeResult | null)[] = [];
  let captureExitReason: 'empty' | 'popup' | 'cap' | 'stalled' = 'cap';
  let totalClicks = 0;

  const captureStartedAt = Date.now();
  const oomKillsAtStart = memorySnapshot().oomKills;
  let consecutiveSlowBatches = 0;
  // Coalesced: when a sweep crawls, EVERY batch trips the slow warning, and the
  // System page's ring buffer holds 20 entries total — an uncoalesced burst
  // would evict the OOM-kill and crash lines that give it its meaning.
  const slowWarner = createCoalescedWarner((m) => log.warn(m), 60_000);

  /**
   * Why (if at all) this sweep should stop before taking another batch, or null
   * to carry on. Consulted at the batch boundary rather than mid-batch: the
   * point is to avoid spending another screenshot + OCR + four clicks on a
   * browser that has already shown it isn't answering, and every crop already
   * collected is kept either way.
   */
  const captureStallReason = (): string | null => {
    if (consecutiveSlowBatches >= SLOW_BATCH_LIMIT) {
      return `${consecutiveSlowBatches} consecutive batches each took over ${Math.round(SLOW_BATCH_MS / 1000)}s ` +
        '(healthy is ~4s) — the browser is wedged, not busy';
    }
    const elapsedMs = Date.now() - captureStartedAt;
    if (elapsedMs > CAPTURE_BUDGET_MS) {
      return `the capture phase has run ${Math.round(elapsedMs / 60_000)} min, past its ` +
        `${Math.round(CAPTURE_BUDGET_MS / 60_000)} min budget`;
    }
    // An OOM kill DURING the sweep is the one signal that needs no threshold:
    // the kernel has already destroyed a process in this container, and if it
    // was one of Chromium's then whatever is still answering us is a survivor
    // of a dying browser. Reading it per batch (~every 4s) is one small cgroup
    // file. Null on non-cgroup hosts, where this check simply never fires.
    const oomKillsNow = memorySnapshot().oomKills;
    if (oomKillsAtStart !== null && oomKillsNow !== null && oomKillsNow > oomKillsAtStart) {
      return `the kernel OOM-killed ${oomKillsNow - oomKillsAtStart} process(es) in this container since ` +
        'the sweep started — the browser cannot be trusted to finish';
    }
    return null;
  };

  // Outer try/catch around each iteration so any unexpected throw
  // (tesseract timeout, browser hiccup, screenshot failure, etc.)
  // exits the capture phase gracefully and lets the OCR phase
  // process whatever crops we already collected — instead of
  // bubbling up and triggering a full-session rollback.
  for (let batch = 1; batch <= MAX_BATCHES; batch++) {
    const stall = captureStallReason();
    if (stall) {
      // Same partial-keep rule as the throw path below: the clicks already made
      // CLAIMED their chests in-game, and the OCR phase needs no browser to
      // record them. Counted as an error so the session surfaces it rather than
      // reading like a clean sweep that happened to find fewer chests.
      tabResult.errors++;
      tabResult.stallReason = stall;
      log.warn(
        `pipelined: abandoning capture at batch ${batch} — ${stall}. ${crops.length} crop(s) from ` +
          `${totalClicks} click(s) still go through OCR, so their chests are recorded; anything clicked ` +
          `after the last screenshot is claimed in-game but unrecorded, and the next scan takes whatever ` +
          `is left on the Gifts tab. [${memorySnapshot().summary}]`,
      );
      captureExitReason = 'stalled';
      break;
    }

    const isDebugIteration = config.scanDebugFirstN > 0 && batch <= config.scanDebugFirstN;
    let stopAfterIter = false;
    // Per-phase timing, so a slow batch says WHICH part was slow. The five-hour
    // sweep left no way to tell a wedged compositor from a starved OCR thread
    // pool from unacknowledged input, and that ambiguity was most of the
    // diagnosis. Declared out here so the timing block after the catch can read
    // them even when the batch threw partway through.
    const batchStartedAt = Date.now();
    let screenshotMs = 0;
    let probeMs = 0;
    let clickMs = 0;

    try {
      // ── Screenshot ──
      let batchCrop: Buffer;
      let fullScreenshot: Buffer | null = null;

      const screenshotStartedAt = Date.now();
      if (isDebugIteration) {
        fullScreenshot = await captureFullPage(page);
        tabResult.screenshots++;
        batchCrop = await cropRegion(fullScreenshot, viewportCrop);
      } else {
        batchCrop = await captureRegion(page, {
          x: viewportCrop.left,
          y: viewportCrop.top,
          width: viewportCrop.width,
          height: viewportCrop.height,
        });
        tabResult.screenshots++;
      }
      screenshotMs = Date.now() - screenshotStartedAt;

      crops.push(batchCrop);
      cropTimes.push(Date.now()); // ≈ when this screenshot was taken (countdowns true now)

      // Probe OCR — wrapped so a tesseract timeout doesn't kill the
      // scan. On failure assume "still has cards" and keep clicking;
      // the OCR phase will re-process the crop later.
      let probeCards: ProbeResult = [];
      let probeRawText = '';
      let probeOk = true;
      const probeStartedAt = Date.now();
      try {
        const probe = await extractCards(batchCrop);
        probeCards = probe.entries;
        probeRawText = probe.rawText;
      } catch (err) {
        probeOk = false;
        // Probe OCR failure on a single batch is recoverable — the OCR
        // phase re-processes the same crop later. Only the aggregate
        // outcome (no usable cards from any batch) is worth a warning.
        log.debug(`pipelined: probe OCR failed at batch ${batch}: ${String(err)} — continuing capture`);
      }
      probeMs = Date.now() - probeStartedAt;
      probeResults.push(probeOk ? probeCards : null);

      // Debug: save annotated PNGs of the first N batches.
      if (isDebugIteration && fullScreenshot) {
        try {
          const ocrSummary = !probeOk
            ? '(probe ocr failed)'
            : probeCards.length > 0
              ? probeCards.map((c) => `${c.playerName} | ${c.chestName}`).join(' /// ')
              : '(no cards)';
          const annotated = await annotateScreenshot(fullScreenshot, {
            cropRegion: viewportCrop,
            clickPoint: { x: viewportClickX, y: viewportClickY },
            label: `batch ${batch} (${probeCards.length} cards)`,
            ocrResult: ocrSummary,
          });
          await saveScreenshot(annotated, './data/screenshots', `pipelined_iter_${String(batch).padStart(3, '0')}`, { force: true });
          await saveScreenshot(batchCrop, './data/screenshots', `pipelined_crop_${String(batch).padStart(3, '0')}`, { force: true });
        } catch (err) {
          log.debug(`pipelined: failed to save debug screenshot at batch ${batch}: ${String(err)}`);
        }
      }

      if (probeOk && probeCards.length === 0) {
        // No cards visible — list is empty. Decide whether to confirm
        // via a full-page detectScreenState:
        //   - If the card-crop OCR text already contains "no gifts",
        //     we have direct evidence the list is empty. Skip the
        //     ~4 s screen-state OCR entirely — it can't tell us anything
        //     new and we already have a popup-detection backstop below
        //     for the ambiguous case.
        //   - Otherwise (probe returned 0 cards but no "no gifts" text)
        //     we fall through to the full-page check to distinguish
        //     end-of-list from popup/login/maintenance interruptions.
        let screenState: string | null = null;
        if (/no\s*gifts?/i.test(probeRawText)) {
          screenState = 'no_gifts';
          log.info(`pipelined: batch ${batch} card crop saw "no gifts" — skipping full-page screen-state confirmation`);
        } else {
          if (!fullScreenshot) {
            fullScreenshot = await captureFullPage(page);
          }
          try {
            screenState = await vision.detectScreenState(fullScreenshot);
          } catch (err) {
            // Caught and handled below — `screenState` falls through
            // to the benign-states branch and we exit cleanly. Not an
            // operator concern.
            log.debug(`pipelined: detectScreenState failed at batch ${batch}: ${String(err)} — assuming popup, exiting capture`);
          }
        }
        // Decide log level based on what we ended up looking at:
        //   no_gifts | gift_tab | unknown / null  → routine end of list
        //     The classifier returns "unknown" any time the bottom of
        //     the scrollable area is mostly blank (very common); the
        //     gift tab itself is also a normal landing point. None of
        //     these warrant a warning.
        //   popup | main_game | login_required | maintenance | …
        //     → scanner ended up somewhere it shouldn't, that's a
        //     warning worth surfacing.
        const benignStates = new Set(['no_gifts', 'gift_tab', 'unknown', null, '']);
        const isBenign = benignStates.has(screenState ?? null);
        if (screenState === 'no_gifts') {
          log.info(`pipelined: batch ${batch} found 0 cards and screen is NO_GIFTS — list emptied, exiting normally`);
          captureExitReason = 'empty';
        } else if (isBenign) {
          log.info(`pipelined: batch ${batch} found 0 cards (screenState=${screenState ?? 'unknown'}) — end of list, exiting capture`);
          captureExitReason = 'empty';
        } else {
          log.warn(`pipelined: batch ${batch} found 0 cards (screenState=${screenState}) — scanner ended up off the gifts list, exiting capture`);
          captureExitReason = 'popup';
        }
        crops.pop(); // last crop has no cards; drop it
        cropTimes.pop();
        probeResults.pop();
        stopAfterIter = true;
      } else {
        reportProgress('scan', `Capturing chests… ${totalClicks + probeCards.length} chests seen (${crops.length} screenshots)`);

        // Click the top Open button once per visible card. Bounded input
        // (browser/input.ts): raw page.mouse.* takes no timeout, and this is
        // the exact spot the 2026-08-04 sweep parked in for five hours. A
        // deadline here surfaces as a throw into the catch below, which already
        // exits the capture phase with every collected crop intact.
        const clickStartedAt = Date.now();
        await mouseMove(page, viewportClickX, viewportClickY);
        for (let c = 0; c < CLICKS_PER_BATCH; c++) {
          await mouseDown(page);
          await mouseUp(page);
          const delay = CLICK_DELAY_MIN_MS + Math.random() * (CLICK_DELAY_MAX_MS - CLICK_DELAY_MIN_MS);
          await new Promise((r) => setTimeout(r, delay));
        }
        const settle = BATCH_SETTLE_MIN_MS + Math.random() * (BATCH_SETTLE_MAX_MS - BATCH_SETTLE_MIN_MS);
        await new Promise((r) => setTimeout(r, settle));
        clickMs = Date.now() - clickStartedAt;
        totalClicks += CLICKS_PER_BATCH;
      }
    } catch (err) {
      // Count it. Without this a sweep that died on batch 1 — browser crash,
      // popup, screenshot failure — returned errors=0 and looked to the
      // finalizer exactly like a clean scan that found nothing, so the session
      // went down as a success with 0 chests and no indication anything broke.
      tabResult.errors++;
      log.warn(
        `pipelined: capture iteration ${batch} threw — exiting capture phase with ${crops.length} crop(s) ` +
          `collected from ${totalClicks} click(s). Those crops still go through OCR, so their chests are ` +
          `recorded; anything clicked after the last screenshot is claimed in-game but unrecorded. ` +
          `${String(err)}`,
      );
      captureExitReason = 'popup';
      stopAfterIter = true;
    }

    // ── Throughput check ──
    // The counter, not the log line, is the load-bearing part: it feeds
    // captureStallReason on the next iteration. The warning exists because five
    // hours passed with nothing on the System page — every step was returning,
    // just 80× slow, and a per-step failure log had nothing to say about that.
    const batchMs = Date.now() - batchStartedAt;
    if (batchMs > SLOW_BATCH_MS) {
      consecutiveSlowBatches++;
      slowWarner.warn(
        'slow-capture-batch',
        `pipelined: capture batch ${batch} took ${Math.round(batchMs / 1000)}s — healthy is ~4s ` +
          `(screenshot ${screenshotMs}ms, probe OCR ${probeMs}ms, clicks+settle ${clickMs}ms). ` +
          `${consecutiveSlowBatches} slow in a row; the sweep is abandoned at ${SLOW_BATCH_LIMIT}. ` +
          `[${memorySnapshot().summary}]`,
      );
    } else {
      consecutiveSlowBatches = 0;
    }

    if (stopAfterIter) break;
  }

  // Report the tail of any slow-batch burst here, next to the capture summary it
  // belongs with, rather than letting the window close seconds later beside
  // unrelated OCR-phase lines.
  slowWarner.flush();

  log.info(
    `pipelined: capture phase done. ${crops.length} batch crops collected (${totalClicks} clicks), exit=${captureExitReason}`,
  );
  reportProgress('scan', `Pipelined capture done — ${crops.length} batch crops, OCR phase starting...`);

  // ─── OCR PHASE ───
  // Process every batch crop. Each crop yields 0-4 cards.
  // For crops where the probe OCR succeeded during capture, reuse those
  // results directly — same function on the same buffer would just
  // produce the same output. Only re-OCR crops whose probe failed.
  //
  // Deliberately NOT subject to the capture phase's deadline or stall guard,
  // and that asymmetry is the point. Every crop here stands for chests already
  // CLAIMED in-game by a click, so abandoning one is unrecoverable loss, where
  // abandoning a capture batch only postpones chests that are still sitting on
  // the Gifts tab. This phase also touches no browser, so the wedged-renderer
  // failure that motivated those guards cannot reach it. Bounding the capture
  // phase bounds this one indirectly anyway: its cost is proportional to the
  // number of crops capture was allowed to collect.
  let ocrFailures = 0;
  let chestsInserted = 0;
  // How many inserted cards had a readable "time left" countdown (earn_time
  // captured) vs fell back to scan time — a per-scan health signal for the
  // earn-time feature. All-fallback means the OCR isn't yielding the countdown.
  let earnTimeParsed = 0;
  let reOcrCount = 0;
  // Surface two silent-fall-through paths so the operator can review:
  //   - Players that didn't fuzzy-match any active member and got
  //     written as a new (potentially ghost) member from raw OCR.
  //   - Chest names that didn't match KNOWN_CHESTS or any merge rule
  //     and got stored as brand-new entries in the chest catalog.
  // Both are routine for real new members / new event chests, but
  // also the natural exit point for OCR garbage, so a per-scan
  // summary lets the operator skim and catch pollution early.
  let newMembersFromOcr = 0;
  const newMembersSamples: string[] = [];
  let unknownChestNames = 0;
  const unknownChestSamples: string[] = [];
  // Brand-new triumphal chests seen this sweep (not in the global points
  // catalog). Counted for the end-of-scan review warning — mirrors the
  // normal-tab unknown-chest counters above.
  const newTriumphalNamesSeen = new Set<string>();
  const newTriumphalSamples: string[] = [];
  for (let i = 0; i < crops.length; i++) {
    reportProgress('scan', `Processing… ${i + 1}/${crops.length} crops (${chestsInserted} chests, ${reOcrCount} re-OCRs)`);

    // Every crop in this list represents chests ALREADY CLAIMED in-game by the
    // capture phase's clicks. The OCR phase is the only thing standing between
    // them and the database, and it needs no browser — so nothing that goes
    // wrong on one crop may be allowed to abandon the ones behind it. The
    // per-crop OCR call was already guarded; this wraps the rest of the body
    // (name/chest resolution, member upsert, insert) which was not, and where
    // a single throw used to unwind the whole sweep and strand every remaining
    // crop's chests as unrecorded loot.
    try {
      let cards: ProbeResult;
      const probe = probeResults[i];
      if (probe !== null) {
        cards = probe;
      } else {
        reOcrCount++;
        try {
          cards = (await extractCards(crops[i])).entries;
        } catch (err) {
          ocrFailures++;
          // Per-crop OCR failure during the post-capture phase is
          // recoverable — `ocrFailures` is checked at the end and a
          // warning is raised at the aggregate level if the rate is
          // significant.
          log.debug(`pipelined: OCR phase crop ${i + 1}/${crops.length} threw: ${String(err)} — skipping crop`);
          continue;
        }
        if (cards.length === 0) {
          ocrFailures++;
          log.debug(`pipelined: OCR phase crop ${i + 1}/${crops.length} produced no parseable cards on re-OCR`);
          continue;
        }
      }

      // Screenshot time of THIS crop — the reference for earned_at (see below).
      const cropCapturedMs = cropTimes[i];
      let savedCropPathForCrop: string | null = null;
      let cropSaveAttempted = false;
      /**
       * Persist this batch crop the first time any row in it needs review evidence —
       * an unreadable player name, or a member seen for the first time. At most one
       * write per crop: it's a single screenshot covering every card in it, so the
       * second caller just reuses the path. `reason` only picks the filename prefix;
       * whichever trigger fires first names the file.
       */
      const ensureCropSaved = async (reason: 'missing_name' | 'new_member'): Promise<void> => {
        if (cropSaveAttempted) return;
        cropSaveAttempted = true;
        try {
          savedCropPathForCrop = await saveScreenshot(
            crops[i],
            MISSING_NAME_CROP_DIR,
            `${reason}_s${sessionId}_crop${String(i + 1).padStart(3, '0')}`,
            { force: true },
          );
        } catch (err) {
          log.debug(`pipelined: failed to save ${reason} debug crop: ${String(err)}`);
        }
      };
      for (const card of cards) {
        // Set when this row needs its screenshot kept — drives debugCropPath below.
        let rowNeedsCrop = false;
        // Resolve the player name from two OCR passes: `playerName` from
        // the multi-language worker (reads Arabic/Cyrillic/CJK correctly)
        // and `playerNameEnglish` from the English-only worker (reads
        // Latin names cleanly but transliterates non-Latin names into
        // garbage — "أوزيريس" comes out as "gs sow").
        //
        //  - If the multi-lang reading is predominantly non-Latin script
        //    the player genuinely has a non-Latin name; trust multi-lang
        //    outright (the English pass is garbage).
        //  - Otherwise both passes are Latin: apply an English bias
        //    (~99% of members have Latin names, and the multi-lang worker
        //    occasionally homoglyph-mangles them). Prefer the English
        //    candidate when it resolves to a known member; fall back to
        //    multi-lang only when English doesn't resolve but multi-lang
        //    does; default to the English guess when neither resolves so
        //    brand-new Latin players aren't imported with stray Cyrillic.
        const cleanedPlayerMulti = cleanPlayerName(card.playerName);
        const cleanedPlayerEng = card.playerNameEnglish
          ? cleanPlayerName(card.playerNameEnglish)
          : '';
        let cleanedPlayer: string;
        let matchedPlayer: string;
        if (!cleanedPlayerEng || isLikelyNonLatinName(cleanedPlayerMulti)) {
          cleanedPlayer = cleanedPlayerMulti;
          matchedPlayer = matchKnownPlayer(cleanedPlayerMulti, knownMembers, inactiveMemberNames);
        } else {
          const matchedEng = matchKnownPlayer(cleanedPlayerEng, knownMembers, inactiveMemberNames);
          if (matchedEng !== cleanedPlayerEng) {
            cleanedPlayer = cleanedPlayerEng;
            matchedPlayer = matchedEng;
          } else {
            const matchedMulti = matchKnownPlayer(cleanedPlayerMulti, knownMembers, inactiveMemberNames);
            if (matchedMulti !== cleanedPlayerMulti) {
              cleanedPlayer = cleanedPlayerMulti;
              matchedPlayer = matchedMulti;
            } else {
              cleanedPlayer = cleanedPlayerEng;
              matchedPlayer = matchedEng;
            }
          }
        }
        const cleanedSource = applyMergeRulesCached(sourceMergeCache, cleanSource(card.source));
        let correctedPlayer = applyMergeRulesCached(playerMergeCache, matchedPlayer);

        // Chest-name resolution. Triumphal chests resolve against the global
        // triumphal catalog (correcting OCR noise), never the 50-entry
        // KNOWN_CHESTS catalog or the clan's merge rules, so a triumphal row
        // can never be stored as a non-triumphal chest (e.g. "Runic Chest").
        // A name that matches nothing is a BRAND-NEW bank chest: it's cleaned
        // and stored (scores 0 until a superadmin assigns a value) rather
        // than silently dropped. Only truly-empty OCR is skipped.
        let correctedChest: string;
        let finalType: string;
        if (target === 'triumphal') {
          const triumphal = correctTriumphalChestName(
            card.chestName,
            triumphalKnownNames.length ? triumphalKnownNames : undefined,
          );
          if (!triumphal) {
            log.debug(`pipelined: triumphal card has empty/unreadable chest name (raw=${JSON.stringify(card.chestName)}) — skipping row`);
            continue;
          }
          correctedChest = triumphal;
          finalType = getChestRarity(triumphal);
          // Flag a genuinely-new triumphal chest (not in the catalog) for
          // review. It's still stored below — just surfaced so a superadmin
          // assigns its package value on the Triumphal Chest Points page.
          if (!triumphalKnownSet.has(correctedChest) && !newTriumphalNamesSeen.has(correctedChest)) {
            newTriumphalNamesSeen.add(correctedChest);
            if (newTriumphalSamples.length < 10) {
              newTriumphalSamples.push(`"${card.chestName}" → "${correctedChest}"`);
            }
          }
        } else {
          const cleanedChest = correctChestName(card.chestName);
          correctedChest = applyMergeRulesCached(chestMergeCache, cleanedChest);
          finalType = chestTypeOverrides.get(correctedChest) ?? card.chestType;
        }

        // OCR occasionally reads the player-name region as pure junk and
        // returns an empty string, or reads the game's "Inactive Player"
        // label where the real name would be. Never accept either —
        // substitute a sentinel, log the raw card, persist the batch
        // crop, and remember the saved path on the row so the admin UI
        // can show it as a hover preview for manual reassignment.
        const isInactiveLabel = correctedPlayer.toLowerCase().trim() === 'inactive player';
        if (!correctedPlayer || isInactiveLabel) {
          tabResult.unknownNames++;
          // Empty OCR results are routine (the chest card layout sometimes
          // hides the name region). The "Inactive Player" label, however,
          // means the scanner picked up a row in a different game state
          // and is worth surfacing.
          const message = `pipelined: unreadable player name in session ${sessionId}, crop ${i + 1}/${crops.length} ` +
            `(raw=${JSON.stringify(card.playerName)}, chest=${JSON.stringify(correctedChest)}, ` +
            `reason=${isInactiveLabel ? '"Inactive Player" label' : 'empty'}) ` +
            `— inserting as "${UNKNOWN_PLAYER_NAME}" for manual review`;
          if (isInactiveLabel) {
            log.warn(message);
          } else {
            log.debug(message);
          }
          await ensureCropSaved('missing_name');
          rowNeedsCrop = true;
          correctedPlayer = UNKNOWN_PLAYER_NAME;
        }
        const member = memberRepo.upsertMember(correctedPlayer, clanId);
        if (!knownMembers.includes(correctedPlayer)) {
          knownMembers.push(correctedPlayer);
          // [Unknown] is its own counter (tabResult.unknownNames); a
          // genuinely-new member name reaching this branch means either
          // a real new joiner or OCR fell through every fuzzy-match
          // tier and is about to mint a ghost member.
          if (correctedPlayer !== UNKNOWN_PLAYER_NAME) {
            newMembersFromOcr++;
            if (newMembersSamples.length < 10) {
              newMembersSamples.push(`"${correctedPlayer}" (raw="${card.playerName}")`);
            }
            // Keep the screenshot behind a first-ever sighting. This is the name an
            // admin most needs to eyeball in the Review Queue: either a real joiner or
            // OCR about to mint a ghost member, and the two are indistinguishable from
            // the name alone. Reuses the same batch crop as the missing-name path — one
            // file per crop serves every row in it.
            await ensureCropSaved('new_member');
            rowNeedsCrop = true;
          }
        }
        // Detect a chest name appearing in this clan's catalog for the
        // FIRST time — i.e. the final corrected+merged name doesn't resolve
        // to a canonical chest, has no operator override, AND has never been
        // stored for this clan before. Such a name is either a real new
        // chest type or OCR garbage, so it's worth a one-time review. Names
        // already seen in a prior scan are intentionally silent: defaulting
        // them to COMMON and leaving them un-overridden is by design, not an
        // error. Triumphal rows enforce a closed set upstream, so this check
        // doesn't apply to them.
        if (target !== 'triumphal'
            && !isKnownChestName(correctedChest)
            && !chestTypeOverrides.has(correctedChest)
            && !knownChestNames.has(correctedChest)) {
          knownChestNames.add(correctedChest);
          unknownChestNames++;
          if (unknownChestSamples.length < 10) {
            unknownChestSamples.push(`"${card.chestName}" → "${correctedChest}"`);
          }
        }
        // Triumphals are bookkeeping only — never grant points.
        const pointValue = target === 'triumphal'
          ? 0
          : getPointsForSourceCached(sourcePointOverrides, cleanedSource, correctedChest);

        tabResult.chestsFound++;
        chestsInserted++;

        // captured_at is the SCAN clock (monotonic, keeps distinct gifts from
        // colliding); earned_at is the best-effort in-game received time derived
        // from the card's "time left" countdown, falling back to the scan time
        // when the countdown isn't a clean read. Both computed off the same
        // reference so a clean read is exactly (scanTime + timeLeft − 20h).
        const capturedAt = nextCapturedAt();
        const capturedMs = Date.parse(capturedAt);
        // earned_at is derived from this crop's SCREENSHOT time (when its "time
        // left" countdown was true), NOT this insert time — the scan screenshots
        // over many minutes but inserts every row here at the end. The fallback
        // stays on the insert clock so a fell-back row reads earned_at ==
        // captured_at (how the health signals tell "captured" from "fell back").
        const earnedAt = giftEarnedAtMs(card.timeLeft, cropCapturedMs, capturedMs);
        // earnedAt < capturedMs only when a countdown actually parsed (received
        // before the scan); equal means it fell back to scan time.
        if (earnedAt < capturedMs) earnTimeParsed++;
        const insertArgs = {
          sessionId,
          clanId,
          playerName: correctedPlayer,
          memberId: member.id,
          chestName: correctedChest,
          chestType: finalType as ChestRecord['chestType'],
          chestSource: cleanedSource,
          pointValue,
          capturedAt,
          earnedAt,
          confidence: card.confidence,
          debugCropPath: rowNeedsCrop ? savedCropPathForCrop : null,
          // Forensic capture (toggleable). card.playerName is the literal
          // OCR string before cleanPlayerName / matchKnownPlayer / merge
          // rules ran — i.e. what the operator needs to see when asking
          // "why did this scan end up on member X". When the toggle is
          // off, persist NULL so the column stays cheap.
          rawPlayerOcr: config.enableRawOcrCapture ? card.playerName : null,
        };

        const inserted = target === 'triumphal'
          ? triumphalChestRepo.insertChest(insertArgs)
          : chestRepo.insertChest(insertArgs);

        if (inserted) {
          tabResult.newChests++;
          // Live progress widget is points-leaderboard contextualized;
          // never inflate it with bookkeeping rows.
          if (target === 'gifts') {
            incrementLiveChestCount();
          }
          tabResult.gifts.push({
            ...card,
            playerName: correctedPlayer,
            chestName: correctedChest,
            source: cleanedSource,
          });
        }
      }
    } catch (err) {
      tabResult.errors++;
      log.warn(
        `pipelined: OCR phase crop ${i + 1}/${crops.length} threw outside the OCR call — ` +
          `skipping it and continuing with the remaining ${crops.length - i - 1} crop(s) so their ` +
          `already-claimed chests still get recorded: ${String(err)}`,
      );
    } finally {
      // Drop the screenshot now that it's processed. The capture phase holds
      // every batch crop for the whole sweep (up to MAX_BATCHES of them) so
      // that a browser crash can't cost us the chests they represent — but
      // once a crop is in the database its buffer is dead weight, and these
      // are PNG buffers outside the V8 heap that GC won't reclaim while the
      // array still references them. ensureCropSaved for this crop has
      // already run by here.
      crops[i] = EMPTY_CROP;
    }
  }

  log.info(
    `pipelined: OCR phase done. ${tabResult.newChests} chests inserted, ${reOcrCount} re-OCRs, ${ocrFailures} OCR failures`,
  );
  // Earn-time health: how often the gift "time left" countdown was readable.
  if (chestsInserted > 0) {
    const msg = `pipelined: earn-time capture — ${earnTimeParsed}/${chestsInserted} cards had a readable "time left" (rest stored scan time as earned_at)`;
    if (earnTimeParsed === 0) {
      log.warn(`${msg}. ALL fell back — the OCR engine isn't yielding the gift countdown; check the "Vision engine" line and the "card-crop OCR" text for a "Time left" value.`);
    } else {
      log.info(msg + '.');
    }
  }
  // Both of these are already surfaced on the Admin tab's review queue
  // (per-clan), so they carry noAlert: they stay in the System warnings
  // list but don't light a second red dot on the System tab. They also
  // name the clan they came from, since the log buffer is instance-wide.
  if (newMembersFromOcr > 0 || unknownChestNames > 0 || newTriumphalNamesSeen.size > 0) {
    const clan = clanRepo.getClanById(clanId);
    const clanLabel = clan ? `${clan.name} (#${clanId})` : `clan #${clanId}`;
    if (newMembersFromOcr > 0) {
      log.warn(
        { noAlert: true },
        `pipelined: ${newMembersFromOcr} new member(s) introduced from OCR during this scan into ${clanLabel} — review for legit joiners vs OCR ghosts. Samples: ${newMembersSamples.join(', ')}`,
      );
    }
    if (unknownChestNames > 0) {
      log.warn(
        { noAlert: true },
        `pipelined: ${unknownChestNames} new unrecognised chest name(s) seen for the first time in ${clanLabel} — review for new chest types vs OCR garbage. Samples: ${unknownChestSamples.join(', ')}`,
      );
    }
    if (newTriumphalNamesSeen.size > 0) {
      log.warn(
        { noAlert: true },
        `pipelined: ${newTriumphalNamesSeen.size} new triumphal (Bank) chest(s) seen in ${clanLabel} — stored but scoring 0 until a superadmin assigns a package value on the Triumphal Chest Points page. Samples: ${newTriumphalSamples.join(', ')}`,
      );
    }
  }
  const skippedInserts = tabResult.chestsFound - tabResult.newChests;
  if (skippedInserts > 0) {
    log.warn(
      `pipelined: ${skippedInserts} insert(s) were skipped as duplicates (chestsFound=${tabResult.chestsFound}, newChests=${tabResult.newChests}). Per-collision details at debug level in chest-repo.`,
    );
  }

  // No bulk Claim — every Open click already claimed its chest.
  return tabResult;
}
