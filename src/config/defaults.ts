import { ChestType } from '../models/enums.js';
import type { AppConfig } from '../models/types.js';

export const DEFAULT_CONFIG: AppConfig = {
  scanIntervalMs: 7_200_000, // 120 minutes

  dbPath: './data/tb-chests.db',
  storageStatePath: './data/auth/storage-state.json',

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
};
