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

export enum ScreenState {
  GIFT_TAB = 'gift_tab',
  NO_GIFTS = 'no_gifts',
  LOGIN_REQUIRED = 'login_required',
  LOADING = 'loading',
  MAIN_GAME = 'main_game',
  POPUP = 'popup',
  MAINTENANCE = 'maintenance',
  UNKNOWN = 'unknown',
}

export enum AppState {
  IDLE = 'idle',
  CHECKING_AUTH = 'checking_auth',
  NAVIGATING = 'navigating',
  SCANNING = 'scanning',
  PROCESSING = 'processing',
  EXPORTING = 'exporting',
  ERROR = 'error',
  COOLDOWN = 'cooldown',
}
