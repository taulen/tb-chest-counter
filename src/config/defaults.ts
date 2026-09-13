import { ChestType } from '../models/enums.js';
import type { AppConfig } from '../models/types.js';

export const DEFAULT_CONFIG: AppConfig = {
  scanIntervalMs: 7_200_000, // 120 minutes
  headless: true,

  dbPath: './data/tb-chests.db',
  storageStatePath: './data/auth/storage-state.json',
  screenshotRetentionDays: 3,

  webPort: 3000,
  webEnabled: true,
  webExternalUrl: '',

  gameDayRolloverUtcHour: 17, // Game's fixed global day boundary (17:00 UTC)

  memberInactivityDays: 7, // Soft-remove members unseen for this many days (0 = disabled)

  chestPointValues: {
    [ChestType.COMMON]: 1,
    [ChestType.UNCOMMON]: 2,
    [ChestType.RARE]: 5,
    [ChestType.EPIC]: 10,
    [ChestType.LEGENDARY]: 25,
    [ChestType.ARENA]: 15,
    [ChestType.EVENT]: 10,
    [ChestType.UNKNOWN]: 0,
  },

  logLevel: 'info',
  scanNonLatinFallback: true,
  // Both ON by default — see the reasoning on the schema fields. Each is
  // still gated on its own calibration, so "enabled" on a fresh install means
  // "runs as soon as it can", not "runs now".
  mightTrackingEnabled: true,
  resourceCaptureEnabled: true,

  scanMaxChests: 2000,
  scanDebugFirstN: 10,
  enableRawOcrCapture: false,
  scanOpenButtonXPct: 0,
  scanOpenButtonYPct: 0,
  memberListCropRevision: 0,
  scanCropLeftPct: 0,
  scanCropTopPct: 0,
  scanCropRightPct: 0,
  scanCropBottomPct: 0,

  uiClanButtonXPct: 0,
  uiClanButtonYPct: 0,
  uiWorldMapButtonXPct: 0,
  uiWorldMapButtonYPct: 0,
  uiGiftsSidebarXPct: 0,
  uiGiftsSidebarYPct: 0,
  uiGiftsTabXPct: 0,
  uiGiftsTabYPct: 0,
  uiTriumphalTabXPct: 0,
  uiTriumphalTabYPct: 0,
  uiMembersSidebarXPct: 0,
  uiMembersSidebarYPct: 0,
  memberListCropLeftPct: 0,
  memberListCropTopPct: 0,
  memberListCropRightPct: 0,
  memberListCropBottomPct: 0,

  uiClanCapitalButtonXPct: 0,
  uiClanCapitalButtonYPct: 0,
  uiClanCapitalMarkerXPct: 0,
  uiClanCapitalMarkerYPct: 0,
  uiCapitalHistorySidebarXPct: 0,
  uiCapitalHistorySidebarYPct: 0,
  resourceHistoryCropLeftPct: 0,
  resourceHistoryCropTopPct: 0,
  resourceHistoryCropRightPct: 0,
  resourceHistoryCropBottomPct: 0,
};
