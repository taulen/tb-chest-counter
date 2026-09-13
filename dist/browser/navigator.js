"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionKickedError = exports.MaintenanceModeError = exports.CalibrationMissingError = void 0;
exports.getCanvasBounds = getCanvasBounds;
exports.ensureOnGiftsTab = ensureOnGiftsTab;
exports.switchToTriumphalTab = switchToTriumphalTab;
exports.clickGiftsTab = clickGiftsTab;
const enums_js_1 = require("../models/enums.js");
const human_delay_js_1 = require("../utils/human-delay.js");
const input_js_1 = require("./input.js");
const deadline_js_1 = require("../utils/deadline.js");
const sharp_1 = __importDefault(require("sharp"));
const screenshotter_js_1 = require("./screenshotter.js");
const image_js_1 = require("../utils/image.js");
const viewport_js_1 = require("../config/viewport.js");
const logger_js_1 = require("../utils/logger.js");
const calibration_js_1 = require("../config/calibration.js");
Object.defineProperty(exports, "CalibrationMissingError", { enumerable: true, get: function () { return calibration_js_1.CalibrationMissingError; } });
const log = (0, logger_js_1.childLogger)('navigator');
/** Thrown when the game is in maintenance mode and we should skip the scan entirely. */
class MaintenanceModeError extends Error {
    /** Estimated time until maintenance ends, in ms. May be null if we couldn't parse it. */
    durationMs;
    constructor(message = 'Game is in maintenance mode', durationMs = null) {
        super(message);
        this.name = 'MaintenanceModeError';
        this.durationMs = durationMs;
    }
}
exports.MaintenanceModeError = MaintenanceModeError;
/**
 * Thrown when the game shows the "Connection lost / Someone has logged into your
 * account" overlay. The session has been kicked by another browser, so chests
 * cannot be claimed and any rows from the in-progress scan must be rolled back.
 */
class SessionKickedError extends Error {
    constructor(message = 'Session kicked: another browser logged into the game account') {
        super(message);
        this.name = 'SessionKickedError';
    }
}
exports.SessionKickedError = SessionKickedError;
/**
 * Query the game canvas's actual CSS bounding rect on the page.
 *
 * Takes the *largest* canvas, not the first. Every calibrated click in the
 * codebase is a percentage of this rect, so if the game inserts a helper
 * canvas (text metrics, minimap, a particle atlas) ahead of the real one in
 * the DOM, `document.querySelector('canvas')` hands back the wrong rect and
 * every click silently lands somewhere else — with the screenshot still
 * looking perfectly normal. The old size guard (>100px) was wide enough to
 * accept such a helper.
 *
 * Deadlined, because page.evaluate carries no timeout of its own (its wire
 * schema has no timeout field, so Playwright arms no timer) and it needs the
 * renderer's main JS thread — the one thing a wedged browser cannot give. This
 * is the first call of every sweep, so an unbounded one parks a scan before it
 * has taken a single screenshot. The existing viewport fallback below is
 * already the right answer for "the probe told us nothing".
 */
const CANVAS_PROBE_DEADLINE_MS = 15_000;
async function getCanvasBounds(page) {
    const probe = await (0, deadline_js_1.withDeadline)(page.evaluate(() => {
        const rects = Array.from(document.querySelectorAll('canvas')).map((canvas) => {
            const rect = canvas.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        if (rects.length === 0)
            return null;
        let largest = 0;
        for (let i = 1; i < rects.length; i++) {
            if (rects[i].width * rects[i].height > rects[largest].width * rects[largest].height) {
                largest = i;
            }
        }
        return { bounds: rects[largest], count: rects.length, wasFirst: largest === 0 };
    }), CANVAS_PROBE_DEADLINE_MS, 'canvas bounds probe').catch(() => null);
    const bounds = probe?.bounds ?? null;
    if (probe && probe.count > 1) {
        const detail = `${probe.count} canvases on the page; using the largest (${Math.round(probe.bounds.width)}x${Math.round(probe.bounds.height)})`;
        if (probe.wasFirst) {
            log.debug(`Canvas bounds: ${detail}`);
        }
        else {
            // The pre-existing querySelector('canvas') would have picked a smaller
            // one here, so every calibrated click was landing off-target.
            log.warn({ noAlert: true }, `Canvas bounds: ${detail} — it is NOT the first canvas in the DOM`);
        }
    }
    // Reject off-screen or invalid bounds (game sometimes moves canvas to x=-999999)
    if (bounds && bounds.x >= -100 && bounds.y >= -100 && bounds.width > 100 && bounds.height > 100) {
        return bounds;
    }
    if (bounds) {
        log.debug(`Canvas bounds look off-screen (x=${bounds.x}, y=${bounds.y}), using viewport fallback`);
    }
    // Fallback: use viewport size with zero offset
    const viewport = page.viewportSize();
    return {
        x: 0,
        y: 0,
        width: viewport?.width ?? viewport_js_1.DEFAULT_VIEWPORT_WIDTH,
        height: viewport?.height ?? viewport_js_1.DEFAULT_VIEWPORT_HEIGHT,
    };
}
function getCoordsFromBounds(bounds, position) {
    return {
        x: Math.round(bounds.x + bounds.width * position.xPct),
        y: Math.round(bounds.y + bounds.height * position.yPct),
    };
}
/**
 * What the browser would actually deliver a click at (x, y) to.
 *
 * `page.mouse.click` sends a real event, so it hits whatever element is
 * topmost at that point — not necessarily the game. A transparent overlay (a
 * promo iframe, a modal backdrop, a dialog whose art never loaded) swallows
 * every click while leaving the screenshot looking completely normal, so
 * "the overlay ate it" and "the coordinate is wrong" produce byte-identical
 * evidence unless we ask the DOM which it was.
 */
async function describeClickTarget(page, x, y) {
    return await page.evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py);
        if (!el)
            return 'nothing';
        const id = el.id ? `#${el.id}` : '';
        const cls = typeof el.className === 'string' && el.className.trim()
            ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
            : '';
        return `${el.tagName.toLowerCase()}${id}${cls}`;
    }, [x, y]).catch(() => 'unreadable');
}
/**
 * Click a calibrated nav target, returning what the click actually landed on
 * so a failing attempt can report it. Logged at debug on every click and
 * folded into the single failure warning rather than warning per click — the
 * System-page ring buffer only holds 20 entries.
 */
async function clickNavTarget(page, x, y, label) {
    const target = await describeClickTarget(page, x, y);
    log.debug(`${label} click at (${x}, ${y}) lands on <${target}>`);
    await (0, human_delay_js_1.humanClick)(page, x, y);
    return target;
}
async function promptUserToNavigate(instruction) {
    console.log('\n========================================');
    console.log('  NAVIGATION HELP NEEDED');
    console.log('========================================');
    console.log(instruction);
    console.log('Press Enter when ready...');
    console.log('========================================\n');
    await new Promise((resolve) => {
        process.stdin.once('data', () => resolve());
    });
    await (0, human_delay_js_1.randomDelay)(500, 1000);
}
/**
 * Verify we're on the Gifts tab by OCR'ing only the operator-calibrated
 * topmost-card region. Returns:
 *   'gifts'     — at least one chest card parsed (panel is open)
 *   'empty'     — OCR text in the crop matches "no gifts" (empty list,
 *                 still on the gifts tab)
 *   'no_chest'  — no card parsed, but the crop shows the gift-card
 *                 layout (Time left / From / Source). Happens when OCR is
 *                 too noisy for parseGiftCards to extract a clean card yet
 *                 the panel is clearly open; we're still on the Gifts
 *                 tab, so navigation must not abort.
 *   'not_gifts' — none of the above; panel is not open
 *   null        — verification unavailable (no crop calibrated or
 *                 provider can't extract cards)
 */
async function verifyGiftsViaCardCrop(screenshot, vision, cardCropPcts) {
    if (typeof vision.extractCardsFromCrop !== 'function')
        return null;
    try {
        const meta = await (0, sharp_1.default)(screenshot).metadata();
        const w = meta.width ?? viewport_js_1.DEFAULT_VIEWPORT_WIDTH;
        const h = meta.height ?? viewport_js_1.DEFAULT_VIEWPORT_HEIGHT;
        const region = {
            left: Math.max(0, Math.round(w * cardCropPcts.left)),
            top: Math.max(0, Math.round(h * cardCropPcts.top)),
            width: Math.max(1, Math.round(w * (cardCropPcts.right - cardCropPcts.left))),
            height: Math.max(1, Math.round(h * (cardCropPcts.bottom - cardCropPcts.top))),
        };
        if (!(await (0, image_js_1.isOCRBufferUsable)(await (0, image_js_1.cropRegion)(screenshot, region)))) {
            log.warn(`Calibration crop is too small for OCR (${region.width}x${region.height}); skipping crop verification`);
            return null;
        }
        const cardBuffer = await (0, image_js_1.cropRegion)(screenshot, region);
        const { entries: cards, rawText } = await vision.extractCardsFromCrop(cardBuffer);
        if (cards.length > 0)
            return 'gifts';
        // No chest card parsed — could be an empty list, a wrong screen, or
        // a gifts tab whose visible gifts simply aren't chests. An explicit
        // "no gifts" in the crop text means the list is empty but we're
        // still on the tab.
        if (/no\s*gifts?/i.test(rawText))
            return 'empty';
        // Fall back to the screen-state classifier on the crop. It returns
        // GIFT_TAB for the gift-card layout ("Time left / From / Source")
        // even when OCR was too noisy for parseGiftCards to extract a clean
        // card. That still means we're on the Gifts tab, so report 'no_chest'
        // rather than aborting navigation.
        const stateOnCrop = await vision.detectScreenState(cardBuffer);
        if (stateOnCrop === enums_js_1.ScreenState.NO_GIFTS)
            return 'empty';
        if (stateOnCrop === enums_js_1.ScreenState.GIFT_TAB)
            return 'no_chest';
        return 'not_gifts';
    }
    catch {
        return null;
    }
}
/** Human-readable descriptor for a successful card-crop verification,
 *  used only in the "on Gifts tab" log lines. */
function describeCropResult(result) {
    if (result === 'empty')
        return 'no gifts';
    if (result === 'no_chest')
        return 'gifts present, none are chests';
    return 'cards present';
}
async function ensureOnGiftsTab(page, vision, tab = 'gifts', opts = {}) {
    // Refuse early if any required calibration is missing — better than
    // clicking random pixels and producing garbage OCR. Triumphal tab is
    // checked only when the operator asked for it.
    const clanButton = (0, calibration_js_1.requireUiPosition)('clanButton');
    const giftsSidebar = (0, calibration_js_1.requireUiPosition)('giftsSidebar');
    if (tab === 'triumphal' && !(0, calibration_js_1.isUiPositionSet)('triumphalTab')) {
        throw new calibration_js_1.CalibrationMissingError('triumphalTab', 2, 'Triumphal Gifts tab (top of My Clan dialog)');
    }
    // Take a screenshot and check current state
    const screenshot = await (0, screenshotter_js_1.captureForVision)(page);
    const state = await vision.detectScreenState(screenshot);
    if (state === enums_js_1.ScreenState.MAINTENANCE) {
        const durationMs = vision.getLastMaintenanceDurationMs?.() ?? null;
        log.warn(`Game is in maintenance mode - aborting scan${durationMs ? ` (~${Math.round(durationMs / 60_000)} min remaining)` : ''}`);
        throw new MaintenanceModeError('Game is in maintenance mode', durationMs);
    }
    if (state === enums_js_1.ScreenState.LOGIN_REQUIRED) {
        log.warn('Login required - cannot navigate');
        return false;
    }
    // Initial "already on gifts tab?" check. When we have an
    // operator-calibrated card crop, trust that over full-page OCR —
    // full-page detectScreenState has been known to false-positive on
    // promotional popups. Only accept when card-crop verification says
    // so. If unavailable, fall back to the full-page state result.
    const initialCropCheck = opts.cardCropPcts
        ? await verifyGiftsViaCardCrop(screenshot, vision, opts.cardCropPcts)
        : null;
    if (initialCropCheck === 'gifts' || initialCropCheck === 'empty' || initialCropCheck === 'no_chest') {
        if (tab === 'triumphal') {
            return await switchToTriumphalTab(page, vision);
        }
        log.info(`Already on Gifts tab (verified via card crop: ${describeCropResult(initialCropCheck)})`);
        return true;
    }
    if (initialCropCheck === null
        && (state === enums_js_1.ScreenState.GIFT_TAB || state === enums_js_1.ScreenState.NO_GIFTS)) {
        if (tab === 'triumphal') {
            return await switchToTriumphalTab(page, vision);
        }
        log.info('Already on Gifts tab');
        return true;
    }
    // Get actual canvas bounds (differs between Windows and headless Linux)
    const canvasBounds = await getCanvasBounds(page);
    log.info(`Canvas bounds: ${canvasBounds.width}x${canvasBounds.height} at (${canvasBounds.x}, ${canvasBounds.y})`);
    // Navigate to clan gifts panel with retries.
    // Unknown state should not proceed to scanning, otherwise OCR reads random UI.
    for (let attempt = 1; attempt <= 3; attempt++) {
        log.info(`Navigating to Gifts tab (attempt ${attempt}/3)...`);
        // Clear popups/panels that can steal focus before clicking nav items.
        for (let i = 0; i < 2; i++) {
            await (0, input_js_1.keyPress)(page, 'Escape');
            await (0, human_delay_js_1.randomDelay)(200, 350);
        }
        // Step 1: Click CLAN button in bottom nav bar
        let clanTarget;
        if (vision.supportsImages) {
            const clanLoc = await vision.findUIElement(screenshot, 'CLAN button in the bottom navigation bar');
            if (clanLoc) {
                clanTarget = await clickNavTarget(page, clanLoc.x, clanLoc.y, 'CLAN (vision)');
            }
            else {
                const coords = getCoordsFromBounds(canvasBounds, clanButton);
                log.info(`Clicking CLAN at calibrated position (${coords.x}, ${coords.y})`);
                clanTarget = await clickNavTarget(page, coords.x, coords.y, 'CLAN');
            }
        }
        else {
            const coords = getCoordsFromBounds(canvasBounds, clanButton);
            log.info(`Clicking CLAN at (${coords.x}, ${coords.y})`);
            clanTarget = await clickNavTarget(page, coords.x, coords.y, 'CLAN');
        }
        await (0, human_delay_js_1.randomDelay)(2000, 3000);
        // Evidence for a failed attempt: did the My Clan dialog actually open?
        // Without this the only artefact is the post-Gifts-click verify shot,
        // which cannot tell "CLAN never opened" from "Gifts click closed it".
        // Saved only when the attempt goes on to fail.
        const afterClanShot = await (0, screenshotter_js_1.captureForVision)(page).catch(() => null);
        // Step 2: Click "Gifts" in the left sidebar
        let giftsTarget;
        if (vision.supportsImages) {
            const freshScreenshot = await (0, screenshotter_js_1.captureForVision)(page);
            const giftsLoc = await vision.findUIElement(freshScreenshot, '"Gifts" in the left sidebar');
            if (giftsLoc) {
                giftsTarget = await clickNavTarget(page, giftsLoc.x, giftsLoc.y, 'Gifts (vision)');
            }
            else {
                const coords = getCoordsFromBounds(canvasBounds, giftsSidebar);
                log.info(`Clicking Gifts at calibrated position (${coords.x}, ${coords.y})`);
                giftsTarget = await clickNavTarget(page, coords.x, coords.y, 'Gifts');
            }
        }
        else {
            const coords = getCoordsFromBounds(canvasBounds, giftsSidebar);
            log.info(`Clicking Gifts at (${coords.x}, ${coords.y})`);
            giftsTarget = await clickNavTarget(page, coords.x, coords.y, 'Gifts');
        }
        await (0, human_delay_js_1.randomDelay)(2000, 3000);
        if (tab === 'triumphal') {
            return await switchToTriumphalTab(page, vision);
        }
        const verifyScreenshot = await (0, screenshotter_js_1.captureForVision)(page);
        // Primary verification: OCR just the operator-calibrated topmost-card
        // crop. Accept "gifts" (card parsed) or "empty" (crop OCRs to "no
        // gifts" text) — both mean the panel is open. Much more reliable
        // than trying to OCR the stylized "Gifts" tab header.
        if (opts.cardCropPcts) {
            const cropResult = await verifyGiftsViaCardCrop(verifyScreenshot, vision, opts.cardCropPcts);
            if (cropResult === 'gifts' || cropResult === 'empty' || cropResult === 'no_chest') {
                log.info(`Successfully navigated to Gifts tab (verified via card crop: ${describeCropResult(cropResult)})`);
                return true;
            }
            if (cropResult === 'not_gifts') {
                log.info('Card-crop verification: no chest cards, no "no gifts" text, and no gift-card layout found; will retry after navigation');
            }
        }
        // Fallback verification: try card-crop again if available (more reliable than full-page OCR).
        // Card-crop is much cleaner signal than full-page game-canvas OCR.
        // Only resort to panel-header cropping if card-crop pcts are unavailable.
        let verifyState;
        if (opts.cardCropPcts) {
            const retryCardCrop = await verifyGiftsViaCardCrop(verifyScreenshot, vision, opts.cardCropPcts);
            if (retryCardCrop === 'gifts' || retryCardCrop === 'empty' || retryCardCrop === 'no_chest') {
                log.info(`Successfully navigated to Gifts tab (verified via card crop on retry: ${describeCropResult(retryCardCrop)})`);
                return true;
            }
            if (retryCardCrop === 'not_gifts') {
                log.info('Card-crop still shows not_gifts after navigation; falling back to panel-header OCR');
            }
        }
        // Only use panel-header cropping if card-crop pcts are unavailable.
        // Full-page OCR on a game canvas is mostly garbage; the cropped
        // region containing "Gifts" / "Triumphal Gifts" tabs gives Tesseract
        // cleaner text than full-page, but card-crop is cleaner still.
        let verifyInput;
        try {
            verifyInput = await (0, image_js_1.cropPanelHeaderRegion)(verifyScreenshot);
        }
        catch {
            verifyInput = verifyScreenshot;
        }
        verifyState = await vision.detectScreenState(verifyInput);
        if (verifyState === enums_js_1.ScreenState.GIFT_TAB || verifyState === enums_js_1.ScreenState.NO_GIFTS) {
            log.info('Successfully navigated to Gifts tab (verified)');
            return true;
        }
        if (verifyState === enums_js_1.ScreenState.MAINTENANCE) {
            const durationMs = vision.getLastMaintenanceDurationMs?.() ?? null;
            log.warn(`Game is in maintenance mode - aborting scan${durationMs ? ` (~${Math.round(durationMs / 60_000)} min remaining)` : ''}`);
            throw new MaintenanceModeError('Game is in maintenance mode', durationMs);
        }
        if (verifyState === enums_js_1.ScreenState.LOGIN_REQUIRED) {
            log.warn('Login screen detected after navigation');
            return false;
        }
        // One line, all of it: the classifier's verdict plus what the two clicks
        // actually hit. `canvas` for both means the game received them and chose
        // not to open the panel; anything else means an overlay ate them, which a
        // screenshot alone can never show.
        log.warn(`Navigation verification failed (screen state: ${verifyState}; `
            + `CLAN click hit <${clanTarget}>, Gifts click hit <${giftsTarget}>)`);
        try {
            if (afterClanShot) {
                await (0, screenshotter_js_1.saveScreenshot)(afterClanShot, './data/screenshots', `nav_verify_fail_attempt${attempt}_after_clan_click`, { force: true });
            }
            const savedPath = await (0, screenshotter_js_1.saveScreenshot)(verifyScreenshot, './data/screenshots', `nav_verify_fail_attempt${attempt}`, { force: true });
            log.info(`Saved debug screenshot: ${savedPath}`);
        }
        catch (err) {
            log.debug(`Failed to save debug screenshot: ${err.message}`);
        }
        // Reload before the last try. Escape + the same two clicks is what just
        // failed, so repeating it verbatim a third time cannot succeed against
        // anything persistent — a wedged overlay, a modal that ignores Escape, a
        // half-initialised client. A reload is the only lever here that changes
        // the page's state, and this path is already committed to aborting the
        // scan, so its cost only ever buys back a scan that was otherwise lost.
        if (attempt === 2) {
            try {
                log.info('Reloading the game before the final navigation attempt');
                const { waitForInteractiveGame } = await import('./auth.js');
                await page.reload({ waitUntil: 'domcontentloaded' });
                await waitForInteractiveGame(page);
            }
            catch (err) {
                log.warn({ noAlert: true }, `Reload before the final navigation attempt failed: ${err.message}`);
            }
        }
    }
    log.error('Could not verify Gifts tab after 3 attempts; aborting scan to avoid bad OCR data.');
    return false;
}
async function switchToTriumphalTab(page, vision) {
    // Refuse if the operator hasn't marked the Triumphal tab during stage 2.
    const triumphalTab = (0, calibration_js_1.requireUiPosition)('triumphalTab');
    if (vision.supportsImages) {
        const resized = await (0, screenshotter_js_1.captureForVision)(page);
        const loc = await vision.findUIElement(resized, '"Triumphal Gifts" tab');
        if (loc) {
            await (0, input_js_1.mouseClick)(page, loc.x, loc.y);
            await (0, human_delay_js_1.randomDelay)(1500, 2500);
            log.info('Switched to Triumphal Gifts tab (vision)');
            return true;
        }
    }
    const canvasBounds = await getCanvasBounds(page);
    const coords = getCoordsFromBounds(canvasBounds, triumphalTab);
    log.info(`Clicking Triumphal Gifts tab at (${coords.x}, ${coords.y})`);
    await (0, input_js_1.mouseClick)(page, coords.x, coords.y);
    await (0, human_delay_js_1.randomDelay)(1500, 2000);
    log.info('Switched to Triumphal Gifts tab');
    return true;
}
async function clickGiftsTab(page, vision) {
    const giftsTab = (0, calibration_js_1.requireUiPosition)('giftsTab');
    if (vision.supportsImages) {
        const screenshot = await (0, screenshotter_js_1.captureForVision)(page);
        const loc = await vision.findUIElement(screenshot, '"Gifts" tab (not Triumphal)');
        if (loc) {
            await (0, human_delay_js_1.humanClick)(page, loc.x, loc.y);
            await (0, human_delay_js_1.randomDelay)(1500, 2500);
            log.info('Switched to Gifts tab');
            return true;
        }
    }
    const canvasBounds = await getCanvasBounds(page);
    const coords = getCoordsFromBounds(canvasBounds, giftsTab);
    log.info(`Clicking Gifts tab at (${coords.x}, ${coords.y})`);
    await (0, human_delay_js_1.humanClick)(page, coords.x, coords.y);
    await (0, human_delay_js_1.randomDelay)(1500, 2500);
    log.info('Switched to Gifts tab');
    return true;
}
//# sourceMappingURL=navigator.js.map