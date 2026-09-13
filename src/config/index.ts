import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { configSchema } from './schema.js';
import type { AppConfig } from '../models/types.js';

function getEnvFilePaths(): string[] {
  const configured = process.env.APP_CONFIG_PATH?.trim();
  const persistentPath = configured ? path.resolve(configured) : path.resolve('data', 'app.env');
  return [path.resolve('.env'), persistentPath];
}

function loadEnvFiles(override: boolean): void {
  for (const envPath of getEnvFilePaths()) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override, quiet: true });
    }
  }
}

loadEnvFiles(false);

let cachedConfig: AppConfig | null = null;

function envToConfigInput(): Record<string, unknown> {
  return {
    scanIntervalMs: process.env.SCAN_INTERVAL_MS,
    headless: process.env.HEADLESS,

    dbPath: process.env.DB_PATH,
    storageStatePath: process.env.STORAGE_STATE_PATH,
    screenshotRetentionDays: process.env.SCREENSHOT_RETENTION_DAYS,

    webPort: process.env.WEB_PORT,
    webExternalUrl: process.env.WEB_EXTERNAL_URL,
    webEnabled: process.env.WEB_ENABLED,

    gameDayRolloverUtcHour: process.env.GAME_DAY_ROLLOVER_UTC_HOUR,

    memberInactivityDays: process.env.MEMBER_INACTIVITY_DAYS,

    chestPointValues: process.env.CHEST_POINT_VALUES,

    logLevel: process.env.LOG_LEVEL,
    scanNonLatinFallback: process.env.SCAN_NON_LATIN_FALLBACK,
    mightTrackingEnabled: process.env.MIGHT_TRACKING_ENABLED,
    resourceCaptureEnabled: process.env.RESOURCE_CAPTURE_ENABLED,

    scanMaxChests: process.env.SCAN_MAX_CHESTS,
    scanDebugFirstN: process.env.SCAN_DEBUG_FIRST_N,
    enableRawOcrCapture: process.env.ENABLE_RAW_OCR_CAPTURE,
    scanOpenButtonXPct: process.env.SCAN_OPEN_BUTTON_X_PCT,
    scanOpenButtonYPct: process.env.SCAN_OPEN_BUTTON_Y_PCT,
    memberListCropRevision: process.env.MEMBER_LIST_CROP_REVISION,
    scanCropLeftPct: process.env.SCAN_CROP_LEFT_PCT,
    scanCropTopPct: process.env.SCAN_CROP_TOP_PCT,
    scanCropRightPct: process.env.SCAN_CROP_RIGHT_PCT,
    scanCropBottomPct: process.env.SCAN_CROP_BOTTOM_PCT,

    uiClanButtonXPct: process.env.UI_CLAN_BUTTON_X_PCT,
    uiClanButtonYPct: process.env.UI_CLAN_BUTTON_Y_PCT,
    uiWorldMapButtonXPct: process.env.UI_WORLD_MAP_BUTTON_X_PCT,
    uiWorldMapButtonYPct: process.env.UI_WORLD_MAP_BUTTON_Y_PCT,
    uiGiftsSidebarXPct: process.env.UI_GIFTS_SIDEBAR_X_PCT,
    uiGiftsSidebarYPct: process.env.UI_GIFTS_SIDEBAR_Y_PCT,
    uiGiftsTabXPct: process.env.UI_GIFTS_TAB_X_PCT,
    uiGiftsTabYPct: process.env.UI_GIFTS_TAB_Y_PCT,
    uiTriumphalTabXPct: process.env.UI_TRIUMPHAL_TAB_X_PCT,
    uiTriumphalTabYPct: process.env.UI_TRIUMPHAL_TAB_Y_PCT,
    uiMembersSidebarXPct: process.env.UI_MEMBERS_SIDEBAR_X_PCT,
    uiMembersSidebarYPct: process.env.UI_MEMBERS_SIDEBAR_Y_PCT,
    memberListCropLeftPct: process.env.MEMBER_LIST_CROP_LEFT_PCT,
    memberListCropTopPct: process.env.MEMBER_LIST_CROP_TOP_PCT,
    memberListCropRightPct: process.env.MEMBER_LIST_CROP_RIGHT_PCT,
    memberListCropBottomPct: process.env.MEMBER_LIST_CROP_BOTTOM_PCT,

    uiClanCapitalButtonXPct: process.env.UI_CLAN_CAPITAL_BUTTON_X_PCT,
    uiClanCapitalButtonYPct: process.env.UI_CLAN_CAPITAL_BUTTON_Y_PCT,
    uiClanCapitalMarkerXPct: process.env.UI_CLAN_CAPITAL_MARKER_X_PCT,
    uiClanCapitalMarkerYPct: process.env.UI_CLAN_CAPITAL_MARKER_Y_PCT,
    uiCapitalHistorySidebarXPct: process.env.UI_CAPITAL_HISTORY_SIDEBAR_X_PCT,
    uiCapitalHistorySidebarYPct: process.env.UI_CAPITAL_HISTORY_SIDEBAR_Y_PCT,
    resourceHistoryCropLeftPct: process.env.RESOURCE_HISTORY_CROP_LEFT_PCT,
    resourceHistoryCropTopPct: process.env.RESOURCE_HISTORY_CROP_TOP_PCT,
    resourceHistoryCropRightPct: process.env.RESOURCE_HISTORY_CROP_RIGHT_PCT,
    resourceHistoryCropBottomPct: process.env.RESOURCE_HISTORY_CROP_BOTTOM_PCT,
  };
}

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  // Re-read env files so runtime setup changes are picked up without requiring
  // a process restart. Persistent app.env is loaded after legacy .env.
  loadEnvFiles(true);

  const raw = envToConfigInput();

  // Strip undefined values so Zod defaults kick in
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined),
  );

  const result = configSchema.safeParse(cleaned);

  if (!result.success) {
    console.error('Configuration validation failed:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  cachedConfig = result.data as AppConfig;
  return cachedConfig;
}

export function getConfig(): AppConfig {
  return cachedConfig ?? loadConfig();
}

export function resetConfig(): void {
  cachedConfig = null;
}
