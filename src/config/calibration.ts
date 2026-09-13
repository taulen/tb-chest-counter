import { loadConfig, resetConfig, getConfig } from './index.js';
import { updateEnvValue } from './persistent-env.js';

/**
 * Per-clan calibration accessor. Today every clan shares one global
 * calibration (chest "Open" button position + OCR crop region) — the
 * user explicitly chose that, with the option to upgrade to per-clan
 * later. All call sites pass clanId through this accessor so the
 * upgrade is a one-table change later (add a `clan_calibration` table
 * keyed on clanId; flip the body of get/save to read/write that row;
 * no call-site churn).
 *
 * The clanId param is intentionally unused today and kept positional so
 * future per-clan code can pass it in without breaking signatures.
 */

export interface Calibration {
  scanOpenButtonXPct: number;
  scanOpenButtonYPct: number;
  scanCropLeftPct: number;
  scanCropTopPct: number;
  scanCropRightPct: number;
  scanCropBottomPct: number;
}

export function getCalibration(_clanId?: number): Calibration {
  const cfg = loadConfig();
  return {
    scanOpenButtonXPct: cfg.scanOpenButtonXPct,
    scanOpenButtonYPct: cfg.scanOpenButtonYPct,
    scanCropLeftPct: cfg.scanCropLeftPct,
    scanCropTopPct: cfg.scanCropTopPct,
    scanCropRightPct: cfg.scanCropRightPct,
    scanCropBottomPct: cfg.scanCropBottomPct,
  };
}

export function saveCalibration(values: Calibration, _clanId?: number): void {
  updateEnvValue('SCAN_OPEN_BUTTON_X_PCT', String(values.scanOpenButtonXPct));
  updateEnvValue('SCAN_OPEN_BUTTON_Y_PCT', String(values.scanOpenButtonYPct));
  updateEnvValue('SCAN_CROP_LEFT_PCT', String(values.scanCropLeftPct));
  updateEnvValue('SCAN_CROP_TOP_PCT', String(values.scanCropTopPct));
  updateEnvValue('SCAN_CROP_RIGHT_PCT', String(values.scanCropRightPct));
  updateEnvValue('SCAN_CROP_BOTTOM_PCT', String(values.scanCropBottomPct));
  // Bust the in-memory cache so the next loadConfig() picks up the new values.
  resetConfig();
}

/**
 * True when both the click target and the OCR crop rectangle are
 * non-zero. Until the operator runs the wizard's calibrate step the
 * scanner refuses to run.
 */
export function isCalibrated(c?: Calibration): boolean {
  const v = c ?? getCalibration();
  const click = v.scanOpenButtonXPct > 0 && v.scanOpenButtonYPct > 0;
  const crop = v.scanCropLeftPct > 0 && v.scanCropTopPct > 0
    && v.scanCropRightPct > v.scanCropLeftPct
    && v.scanCropBottomPct > v.scanCropTopPct;
  return click && crop;
}

/**
 * True only when *every* calibration target the runtime path can throw
 * `CalibrationMissingError` for has been set. This is the gate the
 * /scan endpoint, the onboarding endpoints, and the scheduler all
 * consult before letting any browser session reach the
 * `requireUiPosition(...)` checks deep inside member-capture.ts and
 * navigator.ts. The triumphal-tab position is deliberately optional —
 * clans without that tab leave it at 0, and the navigator only
 * requires it when scanning Triumphal Gifts specifically.
 *
 * Stages 5 and 6 (world map → clan capital → History) are optional for the same
 * class of reason: nothing on the chest-scanning path clicks them. They gate the
 * daily resource-history capture only, via
 * `isResourceHistoryCalibrated()` — so an instance that never turns resource
 * capture on stays "fully calibrated" without ever opening those stages, and
 * requiring them here would have blocked every existing deployment's scans the
 * moment this shipped.
 */
export function isFullyCalibrated(): boolean {
  return (
    isCalibrated() &&
    isUiPositionSet('clanButton') &&
    isUiPositionSet('giftsSidebar') &&
    isUiPositionSet('giftsTab') &&
    isUiPositionSet('membersSidebar') &&
    isMemberListCropSet()
  );
}

// -----------------------------------------------------------------------------
// UI navigation calibration
// -----------------------------------------------------------------------------
//
// The calibration wizard adds operator-marked positions for every UI element
// the bot clicks during navigation. Each position is stored as a canvas-
// relative percentage; 0 = uncalibrated. Public navigation helpers must call
// `requireUiPosition()` (or check `isUiPositionSet()` for optional targets
// like the Triumphal tab) before clicking, so a half-completed calibration
// fails loud with an actionable message instead of clicking random pixels.

export type UiPositionName =
  | 'clanButton'             // Stage 1
  | 'worldMapButton'         // Stage 1 — optional (resource capture only)
  | 'giftsSidebar'           // Stage 2
  | 'giftsTab'               // Stage 2
  | 'triumphalTab'           // Stage 2 — optional (0 = clan has no Triumphal tab)
  | 'membersSidebar'         // Stage 2
  | 'clanCapitalButton'      // Stage 5 — optional (resource capture only)
  | 'clanCapitalMarker'      // Stage 5 — optional (resource capture only)
  | 'capitalHistorySidebar'; // Stage 6 — optional (resource capture only)

const STAGE_BY_POSITION: Record<UiPositionName, number> = {
  clanButton: 1,
  worldMapButton: 1,
  giftsSidebar: 2,
  giftsTab: 2,
  triumphalTab: 2,
  membersSidebar: 2,
  clanCapitalButton: 5,
  clanCapitalMarker: 5,
  capitalHistorySidebar: 6,
};

const LABEL_BY_POSITION: Record<UiPositionName, string> = {
  clanButton: 'Clan button (bottom nav)',
  worldMapButton: 'MAP button (bottom nav)',
  giftsSidebar: 'Gifts sidebar item (left rail of My Clan)',
  giftsTab: 'Gifts tab (top of My Clan dialog)',
  triumphalTab: 'Triumphal Gifts tab (top of My Clan dialog)',
  membersSidebar: 'Members sidebar item (left rail of My Clan)',
  clanCapitalButton: 'Show-clan-capital icon (above the minimap)',
  clanCapitalMarker: 'Clan capital on the recentred world map',
  capitalHistorySidebar: 'History sidebar item (left rail of Clan Capital)',
};

/**
 * Thrown when navigation needs a UI position that the operator hasn't
 * calibrated yet. The message names the exact wizard stage and target so
 * the operator can fix it without guessing.
 */
export class CalibrationMissingError extends Error {
  stage: number;
  positionName: UiPositionName | 'memberListCrop' | 'resourceHistoryCrop';

  constructor(
    positionName: UiPositionName | 'memberListCrop' | 'resourceHistoryCrop',
    stage: number,
    label: string,
  ) {
    super(
      `Calibration missing: ${label}. ` +
      `Open Admin → Scanner Mode → Calibrate and complete Stage ${stage}.`,
    );
    this.name = 'CalibrationMissingError';
    this.stage = stage;
    this.positionName = positionName;
  }
}

/** Read a UI position from config. Returns the raw percentages even if 0. */
export function getUiPosition(name: UiPositionName): { xPct: number; yPct: number } {
  const cfg = getConfig();
  switch (name) {
    case 'clanButton':     return { xPct: cfg.uiClanButtonXPct,     yPct: cfg.uiClanButtonYPct };
    case 'worldMapButton': return { xPct: cfg.uiWorldMapButtonXPct, yPct: cfg.uiWorldMapButtonYPct };
    case 'giftsSidebar':   return { xPct: cfg.uiGiftsSidebarXPct,   yPct: cfg.uiGiftsSidebarYPct };
    case 'giftsTab':       return { xPct: cfg.uiGiftsTabXPct,       yPct: cfg.uiGiftsTabYPct };
    case 'triumphalTab':   return { xPct: cfg.uiTriumphalTabXPct,   yPct: cfg.uiTriumphalTabYPct };
    case 'membersSidebar': return { xPct: cfg.uiMembersSidebarXPct, yPct: cfg.uiMembersSidebarYPct };
    case 'clanCapitalButton':
      return { xPct: cfg.uiClanCapitalButtonXPct, yPct: cfg.uiClanCapitalButtonYPct };
    case 'clanCapitalMarker':
      return { xPct: cfg.uiClanCapitalMarkerXPct, yPct: cfg.uiClanCapitalMarkerYPct };
    case 'capitalHistorySidebar':
      return { xPct: cfg.uiCapitalHistorySidebarXPct, yPct: cfg.uiCapitalHistorySidebarYPct };
  }
}

/** True when both axes of a position are non-zero. */
export function isUiPositionSet(name: UiPositionName): boolean {
  const { xPct, yPct } = getUiPosition(name);
  return xPct > 0 && yPct > 0;
}

/**
 * Read a UI position and throw a `CalibrationMissingError` if it's
 * uncalibrated. Use for required positions (everything except `triumphalTab`,
 * which is optional — call `isUiPositionSet('triumphalTab')` instead).
 */
export function requireUiPosition(name: UiPositionName): { xPct: number; yPct: number } {
  const pos = getUiPosition(name);
  if (pos.xPct === 0 || pos.yPct === 0) {
    throw new CalibrationMissingError(name, STAGE_BY_POSITION[name], LABEL_BY_POSITION[name]);
  }
  return pos;
}

export interface MemberListCrop {
  leftPct: number;
  topPct: number;
  rightPct: number;
  bottomPct: number;
}

/** True when the member-list crop rectangle is fully calibrated (all four
 *  percentages non-zero AND right > left, bottom > top). */
export function isMemberListCropSet(): boolean {
  const cfg = getConfig();
  return (
    cfg.memberListCropLeftPct > 0 &&
    cfg.memberListCropTopPct > 0 &&
    cfg.memberListCropRightPct > cfg.memberListCropLeftPct &&
    cfg.memberListCropBottomPct > cfg.memberListCropTopPct
  );
}

/**
 * True once Stage 4 has been saved at least once since might tracking shipped.
 *
 * Gate for the daily might snapshot: every rectangle saved before the feature
 * existed was drawn to the old instruction ("exclude the power/icons on the
 * right"), so it cannot contain a power number and a capture against it could
 * only ever come back empty.
 *
 * Reads live config on purpose. ScanLoop holds its own AppConfig object from
 * construction and `setCalibration()` only mutates the percentage fields the
 * wizard sends, so the revision bump would otherwise be invisible to the
 * running scanner until a container restart — the operator would re-calibrate,
 * see nothing change, and reasonably conclude the gate was broken.
 * `getConfig()` re-reads data/app.env after the save route's `resetConfig()`,
 * so this opens on the very next cycle.
 */
export function isMemberListCropRecalibrated(): boolean {
  return (getConfig().memberListCropRevision ?? 0) >= 1;
}

/** Current Stage 4 save counter — surfaced in logs/UI so an operator can tell
 *  "did my save register?" from "is the gate wrong?". */
export function getMemberListCropRevision(): number {
  return getConfig().memberListCropRevision ?? 0;
}

/** Read the member-list crop rectangle, throwing if uncalibrated. */
export function requireMemberListCrop(): MemberListCrop {
  const cfg = getConfig();
  if (!isMemberListCropSet()) {
    throw new CalibrationMissingError(
      'memberListCrop',
      3,
      'Member list row rectangle (names through might)',
    );
  }
  return {
    leftPct: cfg.memberListCropLeftPct,
    topPct: cfg.memberListCropTopPct,
    rightPct: cfg.memberListCropRightPct,
    bottomPct: cfg.memberListCropBottomPct,
  };
}

// -----------------------------------------------------------------------------
// Resource-history calibration (Stages 5 + 6)
// -----------------------------------------------------------------------------

/** Rectangle around the Clan Capital → History rows. Same shape as
 *  MemberListCrop; a distinct alias so call sites read honestly. */
export type ResourceHistoryCrop = MemberListCrop;

/** True when the resource-history rectangle is fully calibrated. */
export function isResourceHistoryCropSet(): boolean {
  const cfg = getConfig();
  return (
    cfg.resourceHistoryCropLeftPct > 0 &&
    cfg.resourceHistoryCropTopPct > 0 &&
    cfg.resourceHistoryCropRightPct > cfg.resourceHistoryCropLeftPct &&
    cfg.resourceHistoryCropBottomPct > cfg.resourceHistoryCropTopPct
  );
}

/** Read the resource-history rectangle, throwing if uncalibrated. */
export function requireResourceHistoryCrop(): ResourceHistoryCrop {
  const cfg = getConfig();
  if (!isResourceHistoryCropSet()) {
    throw new CalibrationMissingError(
      'resourceHistoryCrop',
      6,
      'Resource history row rectangle (Clan Capital → History)',
    );
  }
  return {
    leftPct: cfg.resourceHistoryCropLeftPct,
    topPct: cfg.resourceHistoryCropTopPct,
    rightPct: cfg.resourceHistoryCropRightPct,
    bottomPct: cfg.resourceHistoryCropBottomPct,
  };
}

/**
 * The wizard's stages, in the order an operator runs them, with whether the
 * scanner can run without each one.
 *
 * This exists so "which stage is outstanding" has ONE definition. The /status
 * banner, the System page checklist and the wizard's own stage buttons all
 * read it, and `required` here is the same set isFullyCalibrated() gates scans
 * on — pinned by tests/config/calibration-stages.test.ts, because the failure
 * mode is a checklist that reads "all done" beside a banner that still says
 * "calibration needed", with nothing to say which is lying.
 *
 * Stages 5 and 6 are `required: false` for the reason isFullyCalibrated()
 * ignores them: nothing on the chest-scanning path clicks them. They gate the
 * daily resource-history capture only.
 */
export interface CalibrationStageStatus {
  key: 'main' | 'sidebars' | 'gifts' | 'members' | 'worldmap' | 'capital';
  /** 1-based position, matching the "Stage N" labels in the wizard. */
  number: number;
  label: string;
  /** False for the stages only the optional resource capture needs. */
  required: boolean;
  complete: boolean;
}

export function calibrationStageStatus(): CalibrationStageStatus[] {
  const cfg = getConfig();
  const cropSet = (l: number, t: number, r: number, b: number) => l > 0 && t > 0 && r > l && b > t;

  return [
    {
      key: 'main', number: 1, label: 'Main map', required: true,
      complete: isUiPositionSet('clanButton'),
    },
    {
      key: 'sidebars', number: 2, label: 'My Clan sidebars', required: true,
      complete: isUiPositionSet('giftsSidebar') && isUiPositionSet('membersSidebar'),
    },
    {
      key: 'gifts', number: 3, label: 'Gifts panel', required: true,
      complete: isUiPositionSet('giftsTab') && isCalibrated(),
    },
    {
      key: 'members', number: 4, label: 'Members list', required: true,
      complete: isMemberListCropSet(),
    },
    {
      key: 'worldmap', number: 5, label: 'World map', required: false,
      complete: isUiPositionSet('clanCapitalButton') && isUiPositionSet('clanCapitalMarker'),
    },
    {
      key: 'capital', number: 6, label: 'Capital history', required: false,
      complete: isUiPositionSet('capitalHistorySidebar') && cropSet(
        cfg.resourceHistoryCropLeftPct, cfg.resourceHistoryCropTopPct,
        cfg.resourceHistoryCropRightPct, cfg.resourceHistoryCropBottomPct,
      ),
    },
  ];
}

/** How many of the scan-critical stages are done, and out of how many. Feeds
 *  the onboarding banner's "2 of 4" so it says how far along the operator is
 *  rather than only that something is missing. */
export function requiredCalibrationProgress(): { done: number; total: number; nextStage: string | null } {
  const required = calibrationStageStatus().filter((s) => s.required);
  const next = required.find((s) => !s.complete);
  return {
    done: required.filter((s) => s.complete).length,
    total: required.length,
    nextStage: next?.key ?? null,
  };
}

/**
 * Every target the resource-history capture clicks or crops, in navigation
 * order. Exported so the UI can tell an operator exactly which stage is
 * outstanding instead of a bare "not calibrated".
 */
export const RESOURCE_HISTORY_POSITIONS: UiPositionName[] = [
  'worldMapButton',
  'clanCapitalButton',
  'clanCapitalMarker',
  'capitalHistorySidebar',
];

/**
 * True when Stage 1's MAP button, all of Stage 5, and all of Stage 6 are set.
 *
 * The gate for the daily resource capture. Deliberately separate from
 * isFullyCalibrated(): a missing target here must disable one optional daily
 * phase, never a chest scan.
 */
export function isResourceHistoryCalibrated(): boolean {
  return (
    RESOURCE_HISTORY_POSITIONS.every((name) => isUiPositionSet(name)) &&
    isResourceHistoryCropSet()
  );
}

/** The resource-history targets still at 0, in navigation order. Empty when
 *  `isResourceHistoryCalibrated()` is true. */
export function missingResourceHistoryTargets(): string[] {
  const missing = RESOURCE_HISTORY_POSITIONS
    .filter((name) => !isUiPositionSet(name))
    .map((name) => `${LABEL_BY_POSITION[name]} (Stage ${STAGE_BY_POSITION[name]})`);
  if (!isResourceHistoryCropSet()) {
    missing.push('Resource history row rectangle (Stage 6)');
  }
  return missing;
}
