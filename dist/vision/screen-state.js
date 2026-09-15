"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMaintenanceDuration = parseMaintenanceDuration;
exports.looksLikeStoreOverlayText = looksLikeStoreOverlayText;
exports.describeSessionKickText = describeSessionKickText;
exports.looksLikeSessionKickedText = looksLikeSessionKickedText;
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
 * Diagnose the game's "Connection lost" dialog from OCR text.
 *
 * The dialog reads "Connection lost / Someone has logged into your account
 * from another device. Would you like to reconnect?" and it is drawn OVER
 * whatever panel was open, so a card crop taken while it is up contains both
 * the real gift cards and the dialog's prose. That prose is what makes it
 * dangerous rather than merely unhelpful: "...from another device" satisfies
 * the gift parser's From-line matcher, so the dialog parses as a gift whose
 * player is "another" and whose chest is "Connection lost". Both got written
 * to clan #2 on 2026-09-15 (and "another" had already been sitting in clan
 * #1's roster), because nothing downstream ever looked at this text — the
 * capture loop only consults the screen state when a batch yields ZERO cards,
 * and this dialog yields one.
 *
 * Returns a short reason for logs/the thrown error, or null when the text
 * shows no dialog. Two tiers, because the two readings differ in what they
 * justify claiming:
 *  - the account sentence is a verdict on its own, and survives OCR well (the
 *    real read lost "So" from "Someone" and "de" from "device" but kept
 *    "logged into your account" intact);
 *  - the bare banner means the socket dropped without saying why, which still
 *    aborts the scan but must not be reported as a second login.
 *
 * Tolerant of Paddle's dropped spaces (checked against a space-stripped copy)
 * and of o↔0 / l↔1 confusions in the two anchor phrases.
 */
function describeSessionKickText(rawText) {
    const text = rawText.toLowerCase();
    const compact = text.replace(/\s+/g, '');
    const has = (phrase) => text.includes(phrase) || compact.includes(phrase.replace(/\s+/g, ''));
    if (/[l1][o0]gged\s*int[o0]?\s*[yv][o0]ur\s*acc/.test(text)
        || /[l1][o0]ggedint[o0]?[yv][o0]uracc/.test(compact)) {
        return 'the game reported another device logged into this game account';
    }
    if (has('connection lost') || has('connection was lost')) {
        return 'the game showed its "Connection lost" dialog';
    }
    return null;
}
/** Boolean form of describeSessionKickText, for the parser's fast guard. */
function looksLikeSessionKickedText(rawText) {
    return describeSessionKickText(rawText) !== null;
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
    // Kick dialog SECOND, for the same short-circuit reason as maintenance: it
    // is an overlay, so the panel underneath still supplies "gifts"/"clan"
    // keywords and would otherwise win the GIFT_TAB branch below.
    if (describeSessionKickText(rawText) !== null) {
        return { state: enums_js_1.ScreenState.SESSION_KICKED, maintenanceDurationMs: null };
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