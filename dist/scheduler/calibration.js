"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureCalibrationScreenshot = captureCalibrationScreenshot;
const enums_js_1 = require("../models/enums.js");
const logger_js_1 = require("../utils/logger.js");
const game_url_js_1 = require("../config/game-url.js");
const auth_js_1 = require("../browser/auth.js");
const navigator_js_1 = require("../browser/navigator.js");
const screenshotter_js_1 = require("../browser/screenshotter.js");
const human_delay_js_1 = require("../utils/human-delay.js");
const input_js_1 = require("../browser/input.js");
const calibration_js_1 = require("../config/calibration.js");
const log = (0, logger_js_1.childLogger)('calibration');
/**
 * Run one calibration screenshot capture for the given stage.
 *
 * Auto-navigates from the world map into the right sub-section of the
 * My Clan dialog (using either saved positions or the operator's
 * in-flight overrides), screenshots, and writes the PNG + sidecar
 * meta to `data/screenshots/calibration_<stage>.png` /
 * `calibration_<stage>.meta.json`.
 *
 * Pure with respect to ScanLoop state: takes the Page and StateMachine
 * by argument so this function can move freely. The single-flight
 * guard and the about:blank teardown that frees the WebGL canvas live
 * on ScanLoop where the rest of the session lifecycle is.
 */
async function captureCalibrationScreenshot(page, stateMachine, stage = 'gifts', overrides = {}) {
    // Navigate to the game and verify auth using the same pattern as
    // runSingleScan. Single attempt — if auth fails the operator will
    // see the error and can retry; we don't want to silently relaunch
    // the browser session inside a calibration request.
    stateMachine.transition(enums_js_1.AppState.CHECKING_AUTH);
    // Reuse an already-loaded game page when there is one.
    //
    // ScanLoop now leaves the page warm for a few minutes after a capture (see
    // scheduleCalibrationTeardown), and navigateToGame is expensive by design: a
    // full page load, then a 24-30s wait for promo overlays to stream in, then
    // ~14s of dismissPopups. Paying that again to take a screenshot that differs
    // from the last one by a single in-game click is what made every step of a
    // two-pass stage cost about a minute.
    //
    // Skipped only when the page is genuinely on the game already. `about:blank`
    // (parked), a login redirect, or anything else falls through to the full load.
    //
    // Stage 1 deliberately opts out. It does no navigation of its own, so it
    // screenshots whatever view the page is already in — and a warm page left over
    // from a Stage 5 or 6 capture is sitting on the WORLD MAP, where the nav slot
    // the operator is being asked to mark as "MAP" is labelled CITY instead. They
    // would mark the wrong button and every world-map capture after it would toggle
    // the wrong way. A cold load always lands on the city, which is the state Stage
    // 1's instructions describe, and Stage 1 is captured once at the start of a run
    // so the cold cost is paid at most once.
    const stageCanReuseWarmPage = stage !== 'main';
    const warmPage = stageCanReuseWarmPage && (() => {
        try {
            const current = new URL(page.url());
            return current.host === new URL(game_url_js_1.TB_GAME_URL).host;
        }
        catch {
            return false; // about:blank and friends don't parse as absolute game URLs
        }
    })();
    let loggedIn = false;
    if (warmPage) {
        // Trust the warm page only if it still passes the same auth check a cold load
        // would. A session kicked from another browser leaves a loaded-looking page
        // that would otherwise produce a screenshot of the login screen.
        loggedIn = await (0, auth_js_1.checkLoginStatus)(page).catch(() => false);
        if (loggedIn) {
            log.info('Calibration capture: reusing the already-loaded game page (skipping a cold load).');
        }
        else {
            log.info('Calibration capture: the loaded page did not pass the auth check; reloading it.');
        }
    }
    if (!loggedIn) {
        try {
            await (0, auth_js_1.navigateToGame)(page, game_url_js_1.TB_GAME_URL);
        }
        catch (err) {
            return { ok: false, error: `Failed to load the game: ${String(err instanceof Error ? err.message : err)}` };
        }
        loggedIn = await (0, auth_js_1.checkLoginStatus)(page);
    }
    if (!loggedIn) {
        return { ok: false, error: 'Not logged in to the game. Upload a fresh storage-state file from the Browser Session card and retry.' };
    }
    // The calibration wizard is multi-stage. The browser is headless,
    // so the operator can't manually open the My Clan dialog before
    // clicking Capture — the system has to do it on their behalf, using
    // the positions calibrated by earlier stages.
    //
    //   - stage='main'     : no nav. Game loads to the world map.
    //   - stage='sidebars' : click CLAN (stage 1). Captures the My Clan
    //                        dialog on whichever sub-section is the
    //                        default — the sidebar items are visible
    //                        from any sub-section so this is enough.
    //   - stage='gifts'    : click CLAN + Gifts sidebar (stage 2).
    //                        Captures the Gifts panel for top tabs,
    //                        Open button, and card crop.
    //   - stage='members'  : click CLAN + Members sidebar (stage 2).
    //                        Captures the Members panel for the
    //                        names-column rectangle.
    //   - stage='worldmap' : click MAP (stage 1). Captures the world map,
    //                        where the minimap strip — and so the
    //                        show-clan-capital icon — is visible.
    //   - stage='capital'  : click MAP + show-clan-capital + the capital
    //                        itself (stage 5). Captures the Clan Capital
    //                        dialog for the History rail item and the
    //                        history-row rectangle.
    //
    // Each stage refuses if its required predecessors aren't calibrated
    // yet — better than producing a useless screenshot the operator
    // doesn't realize is wrong.
    stateMachine.transition(enums_js_1.AppState.NAVIGATING);
    /** Set when auto-nav couldn't confirm its destination; reported with the saved
     *  screenshot rather than instead of it. */
    let warning;
    for (let i = 0; i < 2; i++) {
        await (0, input_js_1.keyPress)(page, 'Escape');
        await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 1000));
    // Helper: in-flight override wins over saved config value, but a
    // zero/out-of-range override falls back to saved. Returns null
    // when neither source has a usable value.
    const isValidPct = (p) => !!p && p.xPct > 0 && p.xPct < 1 && p.yPct > 0 && p.yPct < 1;
    const resolvePosition = (name) => {
        const override = overrides[name];
        if (isValidPct(override)) {
            log.info(`Calibration capture (stage=${stage}): using in-flight override for ${name}.`);
            return override;
        }
        if ((0, calibration_js_1.isUiPositionSet)(name))
            return (0, calibration_js_1.getUiPosition)(name);
        return null;
    };
    // Stages 5 and 6 branch off the world map rather than the My Clan dialog, so
    // they get their own chain: MAP → show-clan-capital → the capital itself.
    if (stage === 'worldmap' || stage === 'capital') {
        const mapPct = resolvePosition('worldMapButton');
        if (!mapPct) {
            return {
                ok: false,
                error: `Stage '${stage}' capture requires the MAP button position. `
                    + 'Mark MAP in Stage 1 (and save it, or send the in-flight mark via the Capture '
                    + 'overrides). Then return to this stage.',
            };
        }
        const canvasBounds = await (0, navigator_js_1.getCanvasBounds)(page);
        const clickPct = async (pct, label, settleMinMs, settleMaxMs) => {
            const x = Math.round(canvasBounds.x + canvasBounds.width * pct.xPct);
            const y = Math.round(canvasBounds.y + canvasBounds.height * pct.yPct);
            log.info(`Calibration capture (stage=${stage}): clicking ${label} at (${x}, ${y})`);
            await (0, human_delay_js_1.humanClick)(page, x, y);
            await (0, human_delay_js_1.randomDelay)(settleMinMs, settleMaxMs);
        };
        // Reach the world map from whatever view the page is currently in.
        //
        // MAP and CITY are ONE nav slot with a swapped label, so clicking it blind
        // toggles rather than navigates. That was survivable while every capture began
        // with a cold page load (which always lands on the city), but the page is now
        // kept warm between wizard steps — and a warm page left over from a Stage 5 or
        // 6 capture is very likely already ON the world map, where a blind click would
        // take us back to the city and break the rest of the chain.
        //
        // So: probe, and click only if we need to. Returns null when the probe itself
        // is unavailable, which falls back to the old click-once behaviour rather than
        // refusing to navigate.
        const probeWorldMap = async () => {
            try {
                const { isOnWorldMap } = await import('../browser/resource-history-capture.js');
                return await isOnWorldMap(await (0, screenshotter_js_1.captureForVision)(page));
            }
            catch (err) {
                log.debug(`Calibration capture: world-map probe unavailable: ${String(err)}`);
                return null;
            }
        };
        let onMap = await probeWorldMap();
        if (onMap === null) {
            // No probe: do what the code did before, one blind click plus the promo Escape.
            await clickPct(mapPct, 'MAP', 3000, 4000);
            await (0, input_js_1.keyPress)(page, 'Escape');
            await (0, human_delay_js_1.randomDelay)(1200, 1800);
        }
        else if (onMap) {
            log.info('Calibration capture: already on the world map (warm page); no MAP click needed.');
        }
        else {
            for (let attempt = 0; attempt < 2 && onMap === false; attempt++) {
                // The world map is a big streamed scene; give it longer to settle than a
                // dialog needs, or the screenshot catches half-loaded tiles and the
                // operator marks a target against a frame that no longer matches.
                await clickPct(mapPct, attempt === 0 ? 'MAP' : 'MAP (retry)', 3000, 4000);
                // Entering the world map raises its own promo overlay ("BONUS SALES" and
                // friends). This Escape is NOT redundant with the ones above, or with the
                // twelve navigateToGame pressed via dismissPopups(): all of those fire
                // before this click, and the overlay does not exist until after it. It also
                // has to happen before the probe below, because the overlay covers the very
                // coordinate readout the probe looks for.
                await (0, input_js_1.keyPress)(page, 'Escape');
                await (0, human_delay_js_1.randomDelay)(1200, 1800);
                onMap = await probeWorldMap();
            }
            if (onMap === false) {
                // Non-fatal: the screenshot is saved either way (see
                // CalibrationCaptureResult.warning) because seeing what blocked the view is
                // how the operator fixes it.
                warning = 'The world map could not be confirmed on screen — the coordinate readout under '
                    + 'the minimap was not found after two attempts. The game most likely raised another '
                    + 'popup over it. Check the screenshot below: if it shows a promo rather than the map, '
                    + 'click Capture again.';
                log.warn({ noAlert: true }, `Calibration capture (stage=${stage}): ${warning}`);
            }
        }
        // Stage 5, second pass: once the show-clan-capital icon is marked, click it so
        // the screenshot shows the RECENTRED map.
        //
        // Without this the operator has to mark the capital on a frame taken before
        // the recentre — i.e. guess where the camera is about to put it. Same two-pass
        // shape as Stage 6's History hand-off, and for the same reason: the two
        // targets in this stage cannot both be visible in one frame.
        if (stage === 'worldmap') {
            const capitalButtonPct = resolvePosition('clanCapitalButton');
            if (capitalButtonPct) {
                // Recentring animates the camera; a short settle would screenshot it
                // mid-flight and the mark would be off by however far it still had to go.
                await clickPct(capitalButtonPct, 'show-clan-capital', 3000, 4000);
            }
            else {
                log.info("Calibration capture (stage=worldmap): the show-clan-capital icon isn't marked yet, so "
                    + 'this capture shows the map as-is. Mark the icon, then Capture again to get the '
                    + 'recentred view for the capital mark.');
            }
        }
        if (stage === 'capital') {
            const capitalButtonPct = resolvePosition('clanCapitalButton');
            const capitalMarkerPct = resolvePosition('clanCapitalMarker');
            if (!capitalButtonPct || !capitalMarkerPct) {
                return {
                    ok: false,
                    error: "Stage 'capital' capture requires both Stage 5 marks (the show-clan-capital "
                        + 'icon above the minimap, and the capital itself on the recentred map). Complete '
                        + 'Stage 5 first.',
                };
            }
            // Recentring animates the camera onto the capital; the marker click has to
            // wait for it to stop or it lands on empty terrain.
            await clickPct(capitalButtonPct, 'show-clan-capital', 3000, 4000);
            await clickPct(capitalMarkerPct, 'clan capital', 2500, 3500);
            // Second pass only: once History has been marked, open it so this capture
            // shows the rows the rectangle gets drawn around. Absent on the first pass,
            // which is exactly when the operator still needs to see the rail.
            const historyPct = resolvePosition('capitalHistorySidebar');
            if (historyPct) {
                await clickPct(historyPct, 'History', 2000, 3000);
            }
            else {
                log.info("Calibration capture (stage=capital): History isn't marked yet, so this capture stops "
                    + 'on the dialog\'s default sub-section. Mark History, then Capture again to get the '
                    + 'rows for the rectangle.');
            }
        }
    }
    else if (stage !== 'main') {
        const clanPct = resolvePosition('clanButton');
        if (!clanPct) {
            return {
                ok: false,
                error: `Stage '${stage}' capture requires the CLAN button position. ` +
                    'Mark CLAN in Stage 1 (and save it, or send the in-flight mark via the Capture overrides). ' +
                    'Then return to this stage.',
            };
        }
        const canvasBounds = await (0, navigator_js_1.getCanvasBounds)(page);
        const clanX = Math.round(canvasBounds.x + canvasBounds.width * clanPct.xPct);
        const clanY = Math.round(canvasBounds.y + canvasBounds.height * clanPct.yPct);
        log.info(`Calibration capture (stage=${stage}): clicking CLAN at (${clanX}, ${clanY})`);
        await (0, human_delay_js_1.humanClick)(page, clanX, clanY);
        await (0, human_delay_js_1.randomDelay)(2000, 3000);
        // Stages 'gifts' and 'members' need a second click into the
        // matching sidebar to land on the right sub-section. 'sidebars'
        // stage skips this — the sidebar items themselves are visible
        // from any sub-section so we capture whichever is default.
        if (stage === 'gifts' || stage === 'members') {
            const sidebarName = stage === 'gifts' ? 'giftsSidebar' : 'membersSidebar';
            const sidebarPct = resolvePosition(sidebarName);
            if (!sidebarPct) {
                return {
                    ok: false,
                    error: `Stage '${stage}' capture requires the ${sidebarName} position. ` +
                        'Complete Stage 2 (My Clan sidebars) first to mark Gifts and Members sidebar items.',
                };
            }
            const sx = Math.round(canvasBounds.x + canvasBounds.width * sidebarPct.xPct);
            const sy = Math.round(canvasBounds.y + canvasBounds.height * sidebarPct.yPct);
            log.info(`Calibration capture (stage=${stage}): clicking ${sidebarName} at (${sx}, ${sy})`);
            await (0, human_delay_js_1.humanClick)(page, sx, sy);
            await (0, human_delay_js_1.randomDelay)(1500, 2500);
        }
    }
    // Take the screenshot and save it. We deliberately use captureForVision
    // (not captureFullPage) so the saved image matches what the live
    // scanner sees during a real scan — same resize / max dimension.
    const screenshot = await (0, screenshotter_js_1.captureForVision)(page);
    const canvasBounds = await (0, navigator_js_1.getCanvasBounds)(page);
    log.info(`Calibration screenshot captured for stage: ${stage}`);
    const fs = await import('fs');
    const path = await import('path');
    const dir = path.resolve('data', 'screenshots');
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    // Per-stage filenames so the wizard can keep all four screenshots
    // around — the operator can re-run one stage without losing the
    // others, and Stage 2 (sidebars) and Stage 3 (gifts) write to
    // distinct files even though both screenshot the My Clan dialog.
    const stageFilename = `calibration_${stage}.png`;
    const screenshotPath = path.join(dir, stageFilename);
    fs.writeFileSync(screenshotPath, screenshot);
    const metaPath = path.join(dir, `calibration_${stage}.meta.json`);
    fs.writeFileSync(metaPath, JSON.stringify({ canvasBounds, savedAt: new Date().toISOString() }, null, 2));
    log.info(`Calibration screenshot saved to ${screenshotPath}`);
    stateMachine.transition(enums_js_1.AppState.IDLE);
    return {
        ok: true,
        warning,
        screenshotPath: `data/screenshots/${stageFilename}`,
        canvasBounds,
    };
}
//# sourceMappingURL=calibration.js.map