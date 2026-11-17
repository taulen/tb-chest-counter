export enum ChestType {
  COMMON = 'common',
  UNCOMMON = 'uncommon',
  RARE = 'rare',
  EPIC = 'epic',
  LEGENDARY = 'legendary',
  ARENA = 'arena',
  EVENT = 'event',
  UNKNOWN = 'unknown',
}

export enum ChestSource {
  CLAN_GIFT = 'clan_gift',
  MONSTER_KILL = 'monster_kill',
  ARENA = 'arena',
  EVENT = 'event',
  UNKNOWN = 'unknown',
}

export enum ScanStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum AppState {
  IDLE = 'idle',
  SCANNING = 'scanning',
  PROCESSING = 'processing',
  EXPORTING = 'exporting',
  ERROR = 'error',
  COOLDOWN = 'cooldown',
}
