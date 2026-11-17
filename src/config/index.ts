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

    dbPath: process.env.DB_PATH,
    storageStatePath: process.env.STORAGE_STATE_PATH,

    webPort: process.env.WEB_PORT,
    webExternalUrl: process.env.WEB_EXTERNAL_URL,
    webEnabled: process.env.WEB_ENABLED,

    gameDayRolloverUtcHour: process.env.GAME_DAY_ROLLOVER_UTC_HOUR,

    chestPointValues: process.env.CHEST_POINT_VALUES,

    logLevel: process.env.LOG_LEVEL,
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
