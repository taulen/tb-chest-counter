"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMaintenanceDuration = parseMaintenanceDuration;
exports.looksLikeStoreOverlayText = looksLikeStoreOverlayText;
exports.classifyScreenStateText = classifyScreenStateText;
/**
 * Engine-agnostic screen-state classification from OCR text.
 *
 * Both the Tesseract and PaddleOCR providers OCR a screenshot (or a card
 * crop) and then decide which ScreenState it represents purely from the
 * recognised text + a few keyword heuristics. That decision logic lives here
 * so the two providers can't drift apart — the only per-engine difference is
 * how the text is produced.
 *
 * The heuristics are OCR-tolerant in two directions:
 *  - Tesseract mis-reads: "clan"→"dan"/"cian", "from"→"trom", "source"→"s0urce".
 *  - PaddleOCR omits inter-word spaces ("no gifts"→"nogifts",
 *    "time left"→"timeleft"), so every multi-word phrase is also tested
 *    against a space-stripped copy of the text.
 */
const enums_js_1 = require("../models/enums.js");
const chest_names_js_1 = require("./chest-names.js");
/**
 * Parse the maintenance duration from OCR text. The game shows phrases like
 * "will last for about 1 h 0 m" or "will last for about 30 m". Returns the
 * duration in milliseconds, or null if no duration could be parsed. Works on
 * both spaced (Tesseract) and space-stripped (Paddle) text since the h/m
 * anchors survive either way.
 */
function parseMaintenanceDuration(text) {
    const hoursMatch = text.match(/(\d+)\s*h\s*(?:(\d+)\s*m)?/);
    const minsOnlyMatch = text.match(/(?<![h\d])(\d+)\s*m(?:in|inutes)?/);
    if (hoursMatch) {
        const hours = Number.parseInt(hoursMatch[1] || '0', 10);
        const mins = Number.parseInt(hoursMatch[2] || '0', 10);
        if (Number.isFinite(hours)) {
            return (hours * 60 + (Number.isFinite(mins) ? mins : 0)) * 60_000;
        }
    }
    if (minsOnlyMatch) {
        const mins = Number.parseInt(minsOnlyMatch[1] || '0', 10);
        if (Number.isFinite(mins) && mins > 0) {
            return mins * 60_000;
        }
    }
    return null;
}
/**
 * True when OCR text looks like the game's STORE / special-offer overlay.
 *
 * Not a ScreenState: this is a diagnosis helper for the paths that already
 * know they failed, and its job is to stop them blaming the wrong thing. A
 * member capture that finds no member rows used to assert "Stage 2 is
 * mis-calibrated" — but on the run that prompted this, the clicks were landing
 * on an offer popup Escape wouldn't close ("hunters chests x5 / free / sale /
 * 529 nok"), and the calibration was perfect. Sending an operator to re-run a
 * stage that is already correct is worse than saying nothing.
 *
 * Three signals required. Any one alone is common in ordinary game text —
 * member might values carry thousands separators, chest names carry "chest" —
 * so a single hit must not be enough to accuse a popup.
 */
function looksLikeStoreOverlayText(rawText) {
    const text = rawText.toLowerCase();
    const compact = text.replace(/\s+/g, '');
    const has = (phrase) => text.includes(phrase) || compact.includes(phrase.replace(/\s+/g, ''));
    const signals = [
        has('sale'),
        has('offer'),
        has('discount'),
        has('bundle'),
        has('buy now') || has('purchase'),
        // Real-money pricing is the strongest tell: nothing in the clan UI is
        // denominated in a currency.
        /\b(nok|usd|eur|gbp|sek|dkk|pln|rub|czk|huf)\b/.test(text),
        /[$€£]\s?\d/.test(text),
        // Bundle quantities ("chests x5") and percentage discounts.
        /\bx\s?\d{1,2}\b/.test(text),
        /\d\s?%/.test(text),
        has('free'),
        // Price-grid amounts: "24,000  180,000  5,000  10,000". Weak on its own —
        // member might values are written the same way, which is exactly why it
        // counts as one signal rather than a verdict — but a store panel is mostly
        // made of these, so it is what carries an offer read that happens to OCR
        // without the words.
        /\d{1,3}(,\d{3})+/.test(text),
    ].filter(Boolean).length;
    return signals >= 3;
}
/**
 * Classify OCR text into a ScreenState. `rawText` is the recognised text
 * (any casing); this function lowercases it and also derives a space-stripped
 * copy so PaddleOCR's spaceless output matches the same phrase checks.
 */
function classifyScreenStateText(rawText) {
    const text = rawText.toLowerCase();
    // Space-stripped copy: PaddleOCR frequently drops inter-word spaces, so
    // "no gifts" arrives as "nogifts", "dear players" as "dearplayers", etc.
    const compact = text.replace(/\s+/g, '');
    const has = (phrase) => text.includes(phrase) || compact.includes(phrase.replace(/\s+/g, ''));
    // Maintenance FIRST so it short-circuits before other detections. The
    // maintenance overlay covers the entire canvas with very specific phrases.
    if (has('undergoing maintenance')
        || has('game is undergoing')
        || (has('maintenance') && (has('dear players') || has('started at')))) {
        return { state: enums_js_1.ScreenState.MAINTENANCE, maintenanceDurationMs: parseMaintenanceDuration(text) };
    }
    if (has('no gifts') || has('no gift')) {
        return { state: enums_js_1.ScreenState.NO_GIFTS, maintenanceDurationMs: null };
    }
    // Gifts tab: "gift" plus any clan-context signal. OCR may misread "clan"
    // as "dan"/"cian"; Paddle spells it correctly.
    const hasGifts = has('gift');
    const hasClanContext = has('clan') || has('cian') || has('triumphal')
        || has('my c') || has('members') || has('claim');
    if (hasGifts && hasClanContext)
        return { state: enums_js_1.ScreenState.GIFT_TAB, maintenanceDurationMs: null };
    if (hasGifts && (has('chest') || has('time left') || has('from'))) {
        return { state: enums_js_1.ScreenState.GIFT_TAB, maintenanceDurationMs: null };
    }
    // Panel-content fallback: chest token + a known chest name.
    if (has('chest') && (0, chest_names_js_1.containsKnownChestName)(text)) {
        return { state: enums_js_1.ScreenState.GIFT_TAB, maintenanceDurationMs: null };
    }
    // Structural fallback: every gift card carries the same "Time left / From /
    // Source" layout even when the tab header is unreadable and the gift is a
    // non-chest event reward. Require TWO independent layout markers.
    const giftLayoutSignals = [
        /time\s*le[ft]/.test(text) || compact.includes('timele'),
        /s[0o]urce/.test(text),
        /\b[ft]rom\b/.test(text) || compact.includes('from'),
    ].filter(Boolean).length;
    if (giftLayoutSignals >= 2)
        return { state: enums_js_1.ScreenState.GIFT_TAB, maintenanceDurationMs: null };
    if (has('login') || has('password') || has('sign in')) {
        return { state: enums_js_1.ScreenState.LOGIN_REQUIRED, maintenanceDurationMs: null };
    }
    if (has('loading'))
        return { state: enums_js_1.ScreenState.LOADING, maintenanceDurationMs: null };
    return { state: enums_js_1.ScreenState.UNKNOWN, maintenanceDurationMs: null };
}
//# sourceMappingURL=screen-state.js.map