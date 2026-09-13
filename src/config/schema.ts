import { z } from 'zod';
import { ChestType } from '../models/enums.js';

const chestPointValuesSchema = z.record(
  z.nativeEnum(ChestType),
  z.number().int().min(0),
).default({
  [ChestType.COMMON]: 1,
  [ChestType.UNCOMMON]: 2,
  [ChestType.RARE]: 5,
  [ChestType.EPIC]: 10,
  [ChestType.LEGENDARY]: 25,
  [ChestType.ARENA]: 15,
  [ChestType.EVENT]: 10,
  [ChestType.UNKNOWN]: 0,
});

export const configSchema = z.object({
  // gameUrl was historically configurable; it's hardcoded now in
  // src/config/game-url.ts because clan switching happens inside the
  // game's canvas, not via different URLs.

  scanIntervalMs: z.coerce.number().int().min(30_000).default(7_200_000),
  headless: z.preprocess(
    (v) => v === 'true' || v === true,
    z.boolean().default(true),
  ),
  dbPath: z.string().default('./data/tb-chests.db'),
  storageStatePath: z.string().default('./data/auth/storage-state.json'),
  screenshotRetentionDays: z.coerce.number().int().min(0).default(3),

  webPort: z.coerce.number().int().min(1).max(65535).default(3000),
  webExternalUrl: z.string().default(''),
  webEnabled: z.preprocess(
    (v) => v === 'true' || v === true || v === undefined,
    z.boolean().default(true),
  ),

  gameDayRolloverUtcHour: z.coerce.number().int().min(0).max(23).default(17),

  memberInactivityDays: z.coerce.number().int().min(0).default(7),

  chestPointValues: z.preprocess(
    (v) => typeof v === 'string' ? JSON.parse(v) : v,
    chestPointValuesSchema,
  ),

  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // When PaddleOCR reads a player/member name region as empty or non-Latin
  // garbage, re-OCR that region with the bundled Cyrillic/Arabic (PP-OCRv5
  // eslav/arabic) models. Only fires on failed Latin reads, so the ~99% Latin
  // path pays nothing.
  scanNonLatinFallback: z.preprocess(
    (v) => v === 'true' || v === true || v === undefined,
    z.boolean().default(true),
  ),

  // Daily "might" (power level) snapshot from the clan member list. Opt-in and
  // ON by default since the capture became fully automated. It shipped dark
  // while it could only be exercised against the live game, but that caution
  // has outlived its usefulness: the daily snapshot is now a normal part of
  // what this app does, and a default of false meant every new install
  // collected nothing until someone found the switch — invisibly, since a
  // feature that was never on looks exactly like one with no data yet.
  //
  // Safe to default on because the phase gates itself: it refuses to run until
  // Stage 4 has been re-saved with the might column inside the rectangle
  // (isMemberListCropRecalibrated), so an uncalibrated install skips with a log
  // line rather than OCR'ing twenty pages of nothing.
  mightTrackingEnabled: z.preprocess(
    (v) => v === 'true' || v === true,
    z.boolean().default(true),
  ),

  // Daily automated read of the Clan Capital resource history, replacing the
  // manual screenshot upload. ON by default for the same reason might tracking
  // is: it is the normal way this data arrives now, and shipping it dark only
  // meant a new install silently never collected any.
  //
  // Three gates stand between this and a pointless run, which is what makes a
  // default of true safe: Stages 5+6 must be calibrated
  // (isResourceHistoryCalibrated), the clan must have resource tracking on, and
  // that clan must not be excluded from the daily read. An uncalibrated install
  // skips with a noAlert warning instead of clicking empty pixels.
  resourceCaptureEnabled: z.preprocess(
    (v) => v === 'true' || v === true,
    z.boolean().default(true),
  ),

  // Hard ceiling on how many chests one sweep of a tab may open. Exists
  // purely as a runaway-loop guard: a healthy sweep stops when the Gifts
  // tab runs dry, never on this. It is rounded UP to a whole batch of 4
  // clicks by the pipeline, and the capture-phase time budget scales with
  // it so raising the cap doesn't just move the real limit to the clock.
  scanMaxChests: z.coerce.number().int().min(100).max(10_000).default(2000),

  scanDebugFirstN: z.coerce.number().int().min(0).max(100).default(10),
  // Forensic toggle: when on, the scan pipeline persists the raw OCR'd
  // player name alongside the resolved member_id on each chest record.
  // Off by default — the column otherwise balloons the DB with one
  // TEXT value per scanned chest.
  enableRawOcrCapture: z.preprocess(
    (v) => v === 'true' || v === true,
    z.boolean().default(false),
  ),
  // 0 means uncalibrated. Operator must use the admin Calibrate button
  // before the scanner will run.
  scanOpenButtonXPct: z.coerce.number().min(0).max(1).default(0),
  scanOpenButtonYPct: z.coerce.number().min(0).max(1).default(0),
  // Canvas-relative crop region for the topmost gift's text. All four
  // 0 means uncalibrated. The same calibration overlay captures both
  // the click point and the crop rectangle.
  // Bumped every time an operator saves calibration Stage 4. 0 means the
  // member-list rectangle predates might tracking (or was never set), which is
  // the gate might capture checks — see the Stage 4 save handler in api.ts.
  memberListCropRevision: z.coerce.number().int().min(0).default(0),

  scanCropLeftPct: z.coerce.number().min(0).max(1).default(0),
  scanCropTopPct: z.coerce.number().min(0).max(1).default(0),
  scanCropRightPct: z.coerce.number().min(0).max(1).default(0),
  scanCropBottomPct: z.coerce.number().min(0).max(1).default(0),

  // UI navigation calibration. 0 = uncalibrated; relevant operation refuses.
  // Stage 1
  uiClanButtonXPct: z.coerce.number().min(0).max(1).default(0),
  uiClanButtonYPct: z.coerce.number().min(0).max(1).default(0),
  // The MAP/CITY toggle in the bottom nav. Only the resource-history capture
  // needs it, so it stays optional: a clan that never turns resource capture on
  // is fully calibrated without it (see isFullyCalibrated).
  uiWorldMapButtonXPct: z.coerce.number().min(0).max(1).default(0),
  uiWorldMapButtonYPct: z.coerce.number().min(0).max(1).default(0),
  // Stage 2
  uiGiftsSidebarXPct: z.coerce.number().min(0).max(1).default(0),
  uiGiftsSidebarYPct: z.coerce.number().min(0).max(1).default(0),
  uiGiftsTabXPct: z.coerce.number().min(0).max(1).default(0),
  uiGiftsTabYPct: z.coerce.number().min(0).max(1).default(0),
  uiTriumphalTabXPct: z.coerce.number().min(0).max(1).default(0),
  uiTriumphalTabYPct: z.coerce.number().min(0).max(1).default(0),
  uiMembersSidebarXPct: z.coerce.number().min(0).max(1).default(0),
  uiMembersSidebarYPct: z.coerce.number().min(0).max(1).default(0),
  // Stage 3
  memberListCropLeftPct: z.coerce.number().min(0).max(1).default(0),
  memberListCropTopPct: z.coerce.number().min(0).max(1).default(0),
  memberListCropRightPct: z.coerce.number().min(0).max(1).default(0),
  memberListCropBottomPct: z.coerce.number().min(0).max(1).default(0),

  // Stage 5 — world map. Two clicks: the "show clan capital" icon in the strip
  // above the minimap (which recentres the view on the capital), then the capital
  // itself. The second is a fixed canvas position because the recentre is
  // deterministic, which also means it is only valid if it was marked on an
  // already-recentred screenshot — hence Stage 5's two-pass capture.
  uiClanCapitalButtonXPct: z.coerce.number().min(0).max(1).default(0),
  uiClanCapitalButtonYPct: z.coerce.number().min(0).max(1).default(0),
  uiClanCapitalMarkerXPct: z.coerce.number().min(0).max(1).default(0),
  uiClanCapitalMarkerYPct: z.coerce.number().min(0).max(1).default(0),

  // Stage 6 — Clan Capital dialog. "History" in the left rail, plus the
  // rectangle around the resource-history rows that gets OCR'd.
  uiCapitalHistorySidebarXPct: z.coerce.number().min(0).max(1).default(0),
  uiCapitalHistorySidebarYPct: z.coerce.number().min(0).max(1).default(0),
  resourceHistoryCropLeftPct: z.coerce.number().min(0).max(1).default(0),
  resourceHistoryCropTopPct: z.coerce.number().min(0).max(1).default(0),
  resourceHistoryCropRightPct: z.coerce.number().min(0).max(1).default(0),
  resourceHistoryCropBottomPct: z.coerce.number().min(0).max(1).default(0),
});

export type ConfigInput = z.input<typeof configSchema>;
