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
  dbPath: z.string().default('./data/tb-chests.db'),
  storageStatePath: z.string().default('./data/auth/storage-state.json'),

  webPort: z.coerce.number().int().min(1).max(65535).default(3000),
  webExternalUrl: z.string().default(''),
  webEnabled: z.preprocess(
    (v) => v === 'true' || v === true || v === undefined,
    z.boolean().default(true),
  ),

  gameDayRolloverUtcHour: z.coerce.number().int().min(0).max(23).default(17),

  chestPointValues: z.preprocess(
    (v) => typeof v === 'string' ? JSON.parse(v) : v,
    chestPointValuesSchema,
  ),

  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type ConfigInput = z.input<typeof configSchema>;
