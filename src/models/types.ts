import { ChestType, ScanStatus } from './enums.js';

export interface ChestRecord {
  id: number;
  sessionId: number;
  /** Display name of the player. Sourced via JOIN to members in the
   *  read-side views post-D4 — the underlying chest_records table no
   *  longer carries a duplicate player_name column. */
  playerName: string;
  /** Always set post-D4 (NOT NULL on the underlying table). The type
   *  is kept loose for in-memory record construction during scans
   *  before the row hits the DB, but persisted reads always have an
   *  id. */
  memberId: number | null;
  chestName: string;
  chestType: ChestType;
  chestSource: string;
  pointValue: number;
  /** When the scan recorded the chest (scan clock). Operational. */
  capturedAt: string;
  /** Best-effort in-game *received* time (earn time), falling back to
   *  capturedAt for rows scanned before earn-time capture existed. This is
   *  the timestamp shown to users; see src/utils/gift-time.ts. Read-side only. */
  effectiveAt?: string;
  // Removed columns, all dropped via migrations and now derived in views:
  //   v20: rawText (was a JSON dump duplicating every other column)
  //   v23: quantity (always 1; SUM(quantity) became COUNT(*))
  // Not read any more:
  //   confidence — the OCR parser's hard-coded 0.6, never a measurement;
  //     the column keeps its old values but left the views at v126.
}

export interface ClanMember {
  id: number;
  name: string;
  normalizedName: string;
  aliases: string[];
  firstSeen: string;
  lastSeen: string;
  isActive: boolean;
}

export type ScanTriggerSource = 'scheduled' | 'manual' | 'import';

export interface ScanSession {
  id: number;
  startedAt: string;
  completedAt: string | null;
  status: ScanStatus;
  chestsFound: number;
  triumphalChestsFound?: number;
  /** Clan Capital ledger rows the scan recorded (Scan History's list only). */
  resourceRows?: number;
  screenshotsTaken: number;
  errorsEncountered: number;
  triggerSource: ScanTriggerSource;
  errorMessage: string | null;
  errorPhase: string | null;
}

export interface GiftEntry {
  playerName: string;
  chestName: string;
  chestType: ChestType;
  source: string;
  timeLeft: string;
  giftTab: 'gifts' | 'triumphal';
  quantity: number;
}

export interface AppConfig {
  // Game URL is no longer per-config — it's hardcoded in
  // src/config/game-url.ts (TB_GAME_URL).

  // Scanning
  scanIntervalMs: number;

  // Storage
  dbPath: string;
  storageStatePath: string;

  // Web dashboard
  webPort: number;
  webEnabled: boolean;
  /** Public-facing URL of the dashboard (e.g. "https://chests.taul1.com").
   *  Used in Discord embeds to link to the leaderboard. Empty = no links.
   *  A clan on its own domain overrides it (clans.public_url). */
  webExternalUrl: string;

  /** Hour-of-day in UTC (0-23) when the in-game global day boundary
   *  resets. This one value drives BOTH the Discord daily digest fire
   *  time AND every "which day did this happen" grouping across the
   *  app — Analytics daily chart buckets, Clan Records best-single-day,
   *  leaderboard date picker. Default 17 UTC, which is the real in-game
   *  reset time the user confirmed. Set and forget — not DST-aware
   *  because the game itself uses a fixed UTC instant. */
  gameDayRolloverUtcHour: number;

  // Chest point values
  chestPointValues: Record<ChestType, number>;

  // Logging
  logLevel: string;
}

export interface MemberStats {
  memberId: number;
  memberName: string;
  totalChests: number;
  totalPoints: number;
  chestsByType: Partial<Record<ChestType, number>>;
  lastSeen: string;
}

export interface LeaderboardEntry {
  rank: number;
  memberId: number;
  memberName: string;
  totalChests: number;
  totalPoints: number;
  /**
   * Latest might reading and the hero level the member's history supports,
   * decorated onto the row by queryLeaderboard — NOT by the chest query, which
   * stays purely about chests.
   *
   * Both are null when no scan has read this member yet. Null rather than 0 so
   * the UI can print "—": a zero would sort like a real reading and put a
   * never-captured member above nobody.
   */
  might?: number | null;
  heroLevel?: number | null;
  /**
   * Guards level — the Guardsmen tier from the member's research, as the game
   * reports it (guards-repo.ts) — and when it was read, also decorated on by
   * queryLeaderboard. Null until their research has been read.
   */
  guardsLevel?: number | null;
  guardsAsOf?: string | null;
  guardsStale?: boolean;
  /** 'current' = the game reports a Gold Pass now; 'previous' = last Triumphal cycle only. */
  goldPass?: 'current' | 'previous' | null;
}

export interface ScanStats {
  totalSessions: number;
  totalChests: number;
  totalPoints: number;
  totalMembers: number;
  lastScanAt: string | null;
  lastScanChests: number | null;
  lastScanCompletedAt: string | null;
  avgChestsPerScan: number;
  /**
   * The UTC hour when the in-game global day rolls over. Included in the
   * stats response so any page that fetches /api/stats (which is almost
   * every page) gets the clan's game-day boundary without a separate
   * round trip. Frontend uses this to compute "today's game day" for
   * buttons like the leaderboard's Today shortcut.
   */
  gameDayRolloverUtcHour: number;
}
