import { ChestType, ChestSource, ScanStatus, ScreenState } from './enums.js';

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
  confidence: number;
  // Removed columns, all dropped via migrations and now derived in views:
  //   v20: rawText (was a JSON dump duplicating every other column)
  //   v23: quantity (always 1; SUM(quantity) became COUNT(*))
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
  confidence: number;
  /** Alternate player-name candidate from the English-only OCR pass.
   *  Tesseract's multi-language worker (used for `playerName`) handles
   *  Cyrillic/Arabic/CJK names but occasionally homoglyph-mangles
   *  Latin names; the English-only worker reads those cleanly. The
   *  scanner prefers this candidate when it resolves to a known DB
   *  member, and defaults to it as the fallback when neither candidate
   *  matches — 99% of players have Latin names. Optional because the
   *  vision provider may not run a dual pass. */
  playerNameEnglish?: string;
}

export interface GiftPageData {
  entries: GiftEntry[];
  hasMorePages: boolean;
  pageNumber: number;
  noGiftsDetected: boolean;
}

export interface VisionExtractionResult {
  gifts: GiftEntry[];
  screenState: ScreenState;
  rawResponse: string;
  tokensUsed: number;
  costEstimate: number;
}

export interface UIElementLocation {
  x: number;
  y: number;
}

export interface AppConfig {
  // Game URL is no longer per-config — it's hardcoded in
  // src/config/game-url.ts (TB_GAME_URL).

  // Scanning
  scanIntervalMs: number;
  headless: boolean;

  // Storage
  dbPath: string;
  storageStatePath: string;
  screenshotRetentionDays: number;

  // Web dashboard
  webPort: number;
  webEnabled: boolean;
  /** Public-facing URL of the dashboard (e.g. "https://chests.taul1.com").
   *  Used in Discord embeds to link to the leaderboard. Empty = no links. */
  webExternalUrl: string;

  /** Hour-of-day in UTC (0-23) when the in-game global day boundary
   *  resets. This one value drives BOTH the Discord daily digest fire
   *  time AND every "which day did this happen" grouping across the
   *  app — Analytics daily chart buckets, Clan Records best-single-day,
   *  leaderboard date picker. Default 17 UTC, which is the real in-game
   *  reset time the user confirmed. Set and forget — not DST-aware
   *  because the game itself uses a fixed UTC instant. */
  gameDayRolloverUtcHour: number;

  /** Global DEFAULT for how many days a member can go unseen (no scan
   *  sighting) before the daily inactivity sweep soft-removes them
   *  (is_active = 0). Non-destructive: the row and its chest history are
   *  kept, and the next scan that sees the name reactivates it via
   *  upsertMember. Default 7. Each clan has its own on/off toggle
   *  (clans.inactivitySweepEnabled) and may override this threshold via
   *  clans.inactivityDays (clan settings page); this value is the fallback
   *  threshold. 0 acts as a global kill switch for clans on the default. */
  memberInactivityDays: number;

  // Chest point values
  chestPointValues: Record<ChestType, number>;

  // Logging
  logLevel: string;

  /** Re-OCR name regions that read as empty/non-Latin with the bundled
   *  Cyrillic+Arabic models. Default true. */
  scanNonLatinFallback: boolean;

  /** Capture each member's might (power level) from the clan member list once
   *  per game day, after the chest scan has committed. Default false. */
  mightTrackingEnabled: boolean;

  /** Read the Clan Capital resource history from the game once per game day,
   *  after the might snapshot, instead of relying on manual screenshot uploads.
   *  Default false — see the schema comment for why it ships dark. */
  resourceCaptureEnabled: boolean;

  /** Hard ceiling on how many chests a single sweep of a tab may open,
   *  as a runaway-loop guard — a healthy sweep ends when the tab runs
   *  dry, not here. The pipeline rounds it up to a whole 4-click batch,
   *  and scales the capture-phase time budget with it so a raised cap
   *  doesn't silently hand the real limit to the clock. Default 2000. */
  scanMaxChests: number;

  // Scanner calibration (pipelined one-by-one scanner)
  /** How many of the first capture-phase iterations should save an
   *  annotated debug screenshot to data/screenshots/. Useful while
   *  validating that the calibration click target is correct. 0 to
   *  disable. Default 10 — 10 PNGs per scan, ~2MB total, harmless. */
  scanDebugFirstN: number;
  /** Forensic toggle — when on, the scan pipeline persists the raw
   *  OCR'd player name on each chest record alongside the resolved
   *  member_id. Lets the operator query "which OCR strings ended up
   *  on member X" after the fact. Off by default; the System page
   *  toggle flips it and purges the captured column on disable. */
  enableRawOcrCapture: boolean;
  /** Canvas-relative X position (0..1) of the topmost gift's "Open"
   *  button. Set via the admin UI's Calibrate button — operator clicks
   *  the button on a fresh screenshot of the Gifts panel and the
   *  click-percentage is saved here. 0 means uncalibrated and the
   *  pipelined scanner refuses to run. */
  scanOpenButtonXPct: number;
  /** Canvas-relative Y position (0..1) of the topmost gift's "Open"
   *  button. See scanOpenButtonXPct. */
  scanOpenButtonYPct: number;
  /** Canvas-relative bounds (all 0..1) of the topmost gift's text crop
   *  region — what gets fed to the OCR engine. Set via the admin UI's
   *  calibration overlay (operator drags a rectangle around the chest
   *  name, the From row INCLUDING the "Time left" countdown, and the
   *  Source row). The countdown must be inside the crop or earned_at
   *  (in-game received time) can't be derived and every chest falls
   *  back to the scan time. All four 0 means uncalibrated and the
   *  pipelined scanner refuses to run. Stored as percentages (not
   *  absolute pixels) so the same calibration works regardless of
   *  canvas size changes. */
  scanCropLeftPct: number;
  scanCropTopPct: number;
  scanCropRightPct: number;
  scanCropBottomPct: number;

  // UI navigation calibration (operator-marked via the calibration wizard).
  // All canvas-relative percentages 0..1; 0 means uncalibrated and the
  // relevant operation refuses to run with an error pointing at the stage.
  // Stage 1 — main map:
  uiClanButtonXPct: number;
  uiClanButtonYPct: number;
  /** The MAP/CITY toggle in the bottom nav bar. One slot that swaps label
   *  depending on which view you're in, so clicking it from the world map goes
   *  back to the city — the resource capture therefore verifies which view it
   *  landed in rather than assuming. Optional: only resource-history capture
   *  needs it. */
  uiWorldMapButtonXPct: number;
  uiWorldMapButtonYPct: number;
  // Stage 2 — My Clan / Gifts panel:
  /** Left-rail "Gifts" sidebar item inside the My Clan dialog. Distinct
   *  from `uiGiftsTab` which is the top sub-tab toggling Gifts vs
   *  Triumphal. Both clicks are needed for the navigation chain. */
  uiGiftsSidebarXPct: number;
  uiGiftsSidebarYPct: number;
  uiGiftsTabXPct: number;
  uiGiftsTabYPct: number;
  /** Triumphal tab is optional. 0 = skipped (clan has no Triumphal tab). */
  uiTriumphalTabXPct: number;
  uiTriumphalTabYPct: number;
  uiMembersSidebarXPct: number;
  uiMembersSidebarYPct: number;
  // Stage 3 — My Clan / Members list:
  /** Canvas-relative bounds (all 0..1) of the member-list rows. Set via the
   *  calibration wizard. All four 0 means uncalibrated and member capture
   *  refuses to run.
   *
   *  Both readers of this panel share this one rectangle, so each edge decides
   *  what can be captured:
   *
   *    RIGHT  must reach past the might number. Name capture anchors on each
   *           row's "(K:… X:… Y:…)" marker and ignores everything to the right
   *           of it, so including the number costs it nothing — but a rectangle
   *           that stops short silently disables might tracking entirely.
   *    BOTTOM should reach the bottom of the panel. A row's number sits lower
   *           than its name, so a short rectangle clips the last visible row's
   *           value — harmless mid-list (the next scroll page re-reads it) but
   *           permanent for the final member, where no further page exists.
   *    LEFT   optionally covers the avatars, which captures each member's level
   *           from the gold badge. Not required; the badge lands in the name's
   *           text row and is split off structurally (see might-capture.ts).
   */
  memberListCropLeftPct: number;
  memberListCropTopPct: number;
  memberListCropRightPct: number;
  memberListCropBottomPct: number;
  /** Incremented each time Stage 4 is saved. 0 means the rectangle predates
   *  might tracking, which is why might capture refuses to run until it's ≥ 1 —
   *  an old rectangle is drawn around the names only and can never contain a
   *  power number. */
  memberListCropRevision: number;

  // Stage 5 — world map (resource-history capture only):
  /** The "show clan capital" icon in the strip above the minimap. Clicking it
   *  recentres the world map on the clan capital. */
  uiClanCapitalButtonXPct: number;
  uiClanCapitalButtonYPct: number;
  /** The clan capital itself, as it sits AFTER the recentre above.
   *
   *  A fixed canvas position works because the recentre is deterministic — but
   *  only if it was marked against a recentred frame, which is why Stage 5 is
   *  captured twice (the second capture clicks the icon first). Marked against the
   *  pre-recentre view it is a guess at where the camera will land. */
  uiClanCapitalMarkerXPct: number;
  uiClanCapitalMarkerYPct: number;

  // Stage 6 — Clan Capital dialog (resource-history capture only):
  /** "History" in the Clan Capital dialog's left rail. */
  uiCapitalHistorySidebarXPct: number;
  uiCapitalHistorySidebarYPct: number;
  /** Canvas-relative bounds (all 0..1) of the resource-history rows inside the
   *  Clan Capital dialog. This is the rectangle OCR reads, and it's also where
   *  the capture aims the scroll wheel, so it must be on the rows themselves.
   *  All four 0 means uncalibrated and resource capture refuses to run. */
  resourceHistoryCropLeftPct: number;
  resourceHistoryCropTopPct: number;
  resourceHistoryCropRightPct: number;
  resourceHistoryCropBottomPct: number;
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
   * Both are null when might tracking is off, uncalibrated, or has simply never
   * seen this member. Null rather than 0 so the UI can print "—": a zero would
   * sort like a real reading and put a never-captured member above nobody.
   */
  might?: number | null;
  heroLevel?: number | null;
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
