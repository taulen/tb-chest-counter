"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configSchema = void 0;
const zod_1 = require("zod");
const enums_js_1 = require("../models/enums.js");
const chestPointValuesSchema = zod_1.z.record(zod_1.z.nativeEnum(enums_js_1.ChestType), zod_1.z.number().int().min(0)).default({
    [enums_js_1.ChestType.COMMON]: 1,
    [enums_js_1.ChestType.UNCOMMON]: 2,
    [enums_js_1.ChestType.RARE]: 5,
    [enums_js_1.ChestType.EPIC]: 10,
    [enums_js_1.ChestType.LEGENDARY]: 25,
    [enums_js_1.ChestType.ARENA]: 15,
    [enums_js_1.ChestType.EVENT]: 10,
    [enums_js_1.ChestType.UNKNOWN]: 0,
});
exports.configSchema = zod_1.z.object({
    // gameUrl was historically configurable; it's hardcoded now in
    // src/config/game-url.ts because clan switching happens inside the
    // game's canvas, not via different URLs.
    scanIntervalMs: zod_1.z.coerce.number().int().min(30_000).default(7_200_000),
    headless: zod_1.z.preprocess((v) => v === 'true' || v === true, zod_1.z.boolean().default(true)),
    dbPath: zod_1.z.string().default('./data/tb-chests.db'),
    storageStatePath: zod_1.z.string().default('./data/auth/storage-state.json'),
    screenshotRetentionDays: zod_1.z.coerce.number().int().min(0).default(3),
    webPort: zod_1.z.coerce.number().int().min(1).max(65535).default(3000),
    webExternalUrl: zod_1.z.string().default(''),
    webEnabled: zod_1.z.preprocess((v) => v === 'true' || v === true || v === undefined, zod_1.z.boolean().default(true)),
    gameDayRolloverUtcHour: zod_1.z.coerce.number().int().min(0).max(23).default(17),
    memberInactivityDays: zod_1.z.coerce.number().int().min(0).default(7),
    chestPointValues: zod_1.z.preprocess((v) => typeof v === 'string' ? JSON.parse(v) : v, chestPointValuesSchema),
    logLevel: zod_1.z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    // When PaddleOCR reads a player/member name region as empty or non-Latin
    // garbage, re-OCR that region with the bundled Cyrillic/Arabic (PP-OCRv5
    // eslav/arabic) models. Only fires on failed Latin reads, so the ~99% Latin
    // path pays nothing.
    scanNonLatinFallback: zod_1.z.preprocess((v) => v === 'true' || v === true || v === undefined, zod_1.z.boolean().default(true)),
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
    mightTrackingEnabled: zod_1.z.preprocess((v) => v === 'true' || v === true, zod_1.z.boolean().default(true)),
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
    resourceCaptureEnabled: zod_1.z.preprocess((v) => v === 'true' || v === true, zod_1.z.boolean().default(true)),
    // Hard ceiling on how many chests one sweep of a tab may open. Exists
    // purely as a runaway-loop guard: a healthy sweep stops when the Gifts
    // tab runs dry, never on this. It is rounded UP to a whole batch of 4
    // clicks by the pipeline, and the capture-phase time budget scales with
    // it so raising the cap doesn't just move the real limit to the clock.
    scanMaxChests: zod_1.z.coerce.number().int().min(100).max(10_000).default(2000),
    scanDebugFirstN: zod_1.z.coerce.number().int().min(0).max(100).default(10),
    // Forensic toggle: when on, the scan pipeline persists the raw OCR'd
    // player name alongside the resolved member_id on each chest record.
    // Off by default — the column otherwise balloons the DB with one
    // TEXT value per scanned chest.
    enableRawOcrCapture: zod_1.z.preprocess((v) => v === 'true' || v === true, zod_1.z.boolean().default(false)),
    // 0 means uncalibrated. Operator must use the admin Calibrate button
    // before the scanner will run.
    scanOpenButtonXPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    scanOpenButtonYPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    // Canvas-relative crop region for the topmost gift's text. All four
    // 0 means uncalibrated. The same calibration overlay captures both
    // the click point and the crop rectangle.
    // Bumped every time an operator saves calibration Stage 4. 0 means the
    // member-list rectangle predates might tracking (or was never set), which is
    // the gate might capture checks — see the Stage 4 save handler in api.ts.
    memberListCropRevision: zod_1.z.coerce.number().int().min(0).default(0),
    scanCropLeftPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    scanCropTopPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    scanCropRightPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    scanCropBottomPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    // UI navigation calibration. 0 = uncalibrated; relevant operation refuses.
    // Stage 1
    uiClanButtonXPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    uiClanButtonYPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    // The MAP/CITY toggle in the bottom nav. Only the resource-history capture
    // needs it, so it stays optional: a clan that never turns resource capture on
    // is fully calibrated without it (see isFullyCalibrated).
    uiWorldMapButtonXPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    uiWorldMapButtonYPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    // Stage 2
    uiGiftsSidebarXPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    uiGiftsSidebarYPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    uiGiftsTabXPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    uiGiftsTabYPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    uiTriumphalTabXPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    uiTriumphalTabYPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    uiMembersSidebarXPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    uiMembersSidebarYPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    // Stage 3
    memberListCropLeftPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    memberListCropTopPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    memberListCropRightPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    memberListCropBottomPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    // Stage 5 — world map. Two clicks: the "show clan capital" icon in the strip
    // above the minimap (which recentres the view on the capital), then the capital
    // itself. The second is a fixed canvas position because the recentre is
    // deterministic, which also means it is only valid if it was marked on an
    // already-recentred screenshot — hence Stage 5's two-pass capture.
    uiClanCapitalButtonXPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    uiClanCapitalButtonYPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    uiClanCapitalMarkerXPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    uiClanCapitalMarkerYPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    // Stage 6 — Clan Capital dialog. "History" in the left rail, plus the
    // rectangle around the resource-history rows that gets OCR'd.
    uiCapitalHistorySidebarXPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    uiCapitalHistorySidebarYPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    resourceHistoryCropLeftPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    resourceHistoryCropTopPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    resourceHistoryCropRightPct: zod_1.z.coerce.number().min(0).max(1).default(0),
    resourceHistoryCropBottomPct: zod_1.z.coerce.number().min(0).max(1).default(0),
});
//# sourceMappingURL=schema.js.map