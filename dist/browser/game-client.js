"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyGameClient = classifyGameClient;
exports.detectGameClient = detectGameClient;
exports.describeNavFailure = describeNavFailure;
const deadline_js_1 = require("../utils/deadline.js");
/** Classify from the page's visible text. The link names the OTHER client. */
function classifyGameClient(pageText) {
    if (/switch\s+to\s+classic\s+version/i.test(pageText))
        return 'new';
    if (/switch\s+to\s+new\s+version/i.test(pageText))
        return 'classic';
    // Another site language, or a header we have not seen. Say nothing rather
    // than guess: this only ever feeds an explanation, never a decision.
    return 'unknown';
}
const CLIENT_PROBE_DEADLINE_MS = 5_000;
/**
 * Read the client off the page DOM. The header is plain HTML in the main frame
 * (the same document `getCanvasBounds` finds the game canvas in), so this is a
 * text read, not OCR. `innerText` rather than `textContent`, so a link the
 * site renders but hides cannot answer for the visible one.
 *
 * Deadlined like every page.evaluate (a wedged renderer never answers), and
 * any failure is 'unknown' — this runs on a path that is already failing.
 */
async function detectGameClient(page) {
    const text = await (0, deadline_js_1.withDeadline)(page.evaluate(() => document.body?.innerText ?? ''), CLIENT_PROBE_DEADLINE_MS, 'game client probe').catch(() => '');
    return classifyGameClient(text);
}
/** The failure line for a navigation that could not reach the Gifts tab. */
function describeNavFailure(client) {
    const base = 'Could not verify Gifts tab after 3 attempts';
    if (client !== 'new')
        return base;
    return `${base}. This clan's game account is on Total Battle's NEW client `
        + '(the game page offers "Switch to classic version"), and the scanner\'s click '
        + 'positions are calibrated on the classic client. Log in to the account and '
        + 'switch it back to the classic version.';
}
//# sourceMappingURL=game-client.js.map