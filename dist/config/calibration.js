"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESOURCE_HISTORY_POSITIONS = exports.CalibrationMissingError = void 0;
exports.getCalibration = getCalibration;
exports.saveCalibration = saveCalibration;
exports.isCalibrated = isCalibrated;
exports.isFullyCalibrated = isFullyCalibrated;
exports.getUiPosition = getUiPosition;
exports.isUiPositionSet = isUiPositionSet;
exports.requireUiPosition = requireUiPosition;
exports.isMemberListCropSet = isMemberListCropSet;
exports.isMemberListCropRecalibrated = isMemberListCropRecalibrated;
exports.getMemberListCropRevision = getMemberListCropRevision;
exports.requireMemberListCrop = requireMemberListCrop;
exports.isResourceHistoryCropSet = isResourceHistoryCropSet;
exports.requireResourceHistoryCrop = requireResourceHistoryCrop;
exports.calibrationStageStatus = calibrationStageStatus;
exports.requiredCalibrationProgress = requiredCalibrationProgress;
exports.isResourceHistoryCalibrated = isResourceHistoryCalibrated;
exports.missingResourceHistoryTargets = missingResourceHistoryTargets;
const index_js_1 = require("./index.js");
const persistent_env_js_1 = require("./persistent-env.js");
function getCalibration(_clanId) {
    const cfg = (0, index_js_1.loadConfig)();
    return {
        scanOpenButtonXPct: cfg.scanOpenButtonXPct,
        scanOpenButtonYPct: cfg.scanOpenButtonYPct,
        scanCropLeftPct: cfg.scanCropLeftPct,
        scanCropTopPct: cfg.scanCropTopPct,
        scanCropRightPct: cfg.scanCropRightPct,
        scanCropBottomPct: cfg.scanCropBottomPct,
    };
}
function saveCalibration(values, _clanId) {
    (0, persistent_env_js_1.updateEnvValue)('SCAN_OPEN_BUTTON_X_PCT', String(values.scanOpenButtonXPct));
    (0, persistent_env_js_1.updateEnvValue)('SCAN_OPEN_BUTTON_Y_PCT', String(values.scanOpenButtonYPct));
    (0, persistent_env_js_1.updateEnvValue)('SCAN_CROP_LEFT_PCT', String(values.scanCropLeftPct));
    (0, persistent_env_js_1.updateEnvValue)('SCAN_CROP_TOP_PCT', String(values.scanCropTopPct));
    (0, persistent_env_js_1.updateEnvValue)('SCAN_CROP_RIGHT_PCT', String(values.scanCropRightPct));
    (0, persistent_env_js_1.updateEnvValue)('SCAN_CROP_BOTTOM_PCT', String(values.scanCropBottomPct));
    // Bust the in-memory cache so the next loadConfig() picks up the new values.
    (0, index_js_1.resetConfig)();
}
/**
 * True when both the click target and the OCR crop rectangle are
 * non-zero. Until the operator runs the wizard's calibrate step the
 * scanner refuses to run.
 */
function isCalibrated(c) {
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
function isFullyCalibrated() {
    return (isCalibrated() &&
        isUiPositionSet('clanButton') &&
        isUiPositionSet('giftsSidebar') &&
        isUiPositionSet('giftsTab') &&
        isUiPositionSet('membersSidebar') &&
        isMemberListCropSet());
}
const STAGE_BY_POSITION = {
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
const LABEL_BY_POSITION = {
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
class CalibrationMissingError extends Error {
    stage;
    positionName;
    constructor(positionName, stage, label) {
        super(`Calibration missing: ${label}. ` +
            `Open Admin → Scanner Mode → Calibrate and complete Stage ${stage}.`);
        this.name = 'CalibrationMissingError';
        this.stage = stage;
        this.positionName = positionName;
    }
}
exports.CalibrationMissingError = CalibrationMissingError;
/** Read a UI position from config. Returns the raw percentages even if 0. */
function getUiPosition(name) {
    const cfg = (0, index_js_1.getConfig)();
    switch (name) {
        case 'clanButton': return { xPct: cfg.uiClanButtonXPct, yPct: cfg.uiClanButtonYPct };
        case 'worldMapButton': return { xPct: cfg.uiWorldMapButtonXPct, yPct: cfg.uiWorldMapButtonYPct };
        case 'giftsSidebar': return { xPct: cfg.uiGiftsSidebarXPct, yPct: cfg.uiGiftsSidebarYPct };
        case 'giftsTab': return { xPct: cfg.uiGiftsTabXPct, yPct: cfg.uiGiftsTabYPct };
        case 'triumphalTab': return { xPct: cfg.uiTriumphalTabXPct, yPct: cfg.uiTriumphalTabYPct };
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
function isUiPositionSet(name) {
    const { xPct, yPct } = getUiPosition(name);
    return xPct > 0 && yPct > 0;
}
/**
 * Read a UI position and throw a `CalibrationMissingError` if it's
 * uncalibrated. Use for required positions (everything except `triumphalTab`,
 * which is optional — call `isUiPositionSet('triumphalTab')` instead).
 */
function requireUiPosition(name) {
    const pos = getUiPosition(name);
    if (pos.xPct === 0 || pos.yPct === 0) {
        throw new CalibrationMissingError(name, STAGE_BY_POSITION[name], LABEL_BY_POSITION[name]);
    }
    return pos;
}
/** True when the member-list crop rectangle is fully calibrated (all four
 *  percentages non-zero AND right > left, bottom > top). */
function isMemberListCropSet() {
    const cfg = (0, index_js_1.getConfig)();
    return (cfg.memberListCropLeftPct > 0 &&
        cfg.memberListCropTopPct > 0 &&
        cfg.memberListCropRightPct > cfg.memberListCropLeftPct &&
        cfg.memberListCropBottomPct > cfg.memberListCropTopPct);
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
function isMemberListCropRecalibrated() {
    return ((0, index_js_1.getConfig)().memberListCropRevision ?? 0) >= 1;
}
/** Current Stage 4 save counter — surfaced in logs/UI so an operator can tell
 *  "did my save register?" from "is the gate wrong?". */
function getMemberListCropRevision() {
    return (0, index_js_1.getConfig)().memberListCropRevision ?? 0;
}
/** Read the member-list crop rectangle, throwing if uncalibrated. */
function requireMemberListCrop() {
    const cfg = (0, index_js_1.getConfig)();
    if (!isMemberListCropSet()) {
        throw new CalibrationMissingError('memberListCrop', 3, 'Member list row rectangle (names through might)');
    }
    return {
        leftPct: cfg.memberListCropLeftPct,
        topPct: cfg.memberListCropTopPct,
        rightPct: cfg.memberListCropRightPct,
        bottomPct: cfg.memberListCropBottomPct,
    };
}
/** True when the resource-history rectangle is fully calibrated. */
function isResourceHistoryCropSet() {
    const cfg = (0, index_js_1.getConfig)();
    return (cfg.resourceHistoryCropLeftPct > 0 &&
        cfg.resourceHistoryCropTopPct > 0 &&
        cfg.resourceHistoryCropRightPct > cfg.resourceHistoryCropLeftPct &&
        cfg.resourceHistoryCropBottomPct > cfg.resourceHistoryCropTopPct);
}
/** Read the resource-history rectangle, throwing if uncalibrated. */
function requireResourceHistoryCrop() {
    const cfg = (0, index_js_1.getConfig)();
    if (!isResourceHistoryCropSet()) {
        throw new CalibrationMissingError('resourceHistoryCrop', 6, 'Resource history row rectangle (Clan Capital → History)');
    }
    return {
        leftPct: cfg.resourceHistoryCropLeftPct,
        topPct: cfg.resourceHistoryCropTopPct,
        rightPct: cfg.resourceHistoryCropRightPct,
        bottomPct: cfg.resourceHistoryCropBottomPct,
    };
}
function calibrationStageStatus() {
    const cfg = (0, index_js_1.getConfig)();
    const cropSet = (l, t, r, b) => l > 0 && t > 0 && r > l && b > t;
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
            complete: isUiPositionSet('capitalHistorySidebar') && cropSet(cfg.resourceHistoryCropLeftPct, cfg.resourceHistoryCropTopPct, cfg.resourceHistoryCropRightPct, cfg.resourceHistoryCropBottomPct),
        },
    ];
}
/** How many of the scan-critical stages are done, and out of how many. Feeds
 *  the onboarding banner's "2 of 4" so it says how far along the operator is
 *  rather than only that something is missing. */
function requiredCalibrationProgress() {
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
exports.RESOURCE_HISTORY_POSITIONS = [
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
function isResourceHistoryCalibrated() {
    return (exports.RESOURCE_HISTORY_POSITIONS.every((name) => isUiPositionSet(name)) &&
        isResourceHistoryCropSet());
}
/** The resource-history targets still at 0, in navigation order. Empty when
 *  `isResourceHistoryCalibrated()` is true. */
function missingResourceHistoryTargets() {
    const missing = exports.RESOURCE_HISTORY_POSITIONS
        .filter((name) => !isUiPositionSet(name))
        .map((name) => `${LABEL_BY_POSITION[name]} (Stage ${STAGE_BY_POSITION[name]})`);
    if (!isResourceHistoryCropSet()) {
        missing.push('Resource history row rectangle (Stage 6)');
    }
    return missing;
}
//# sourceMappingURL=calibration.js.map