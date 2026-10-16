"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TB_GAME_URL = void 0;
exports.isTotalBattleHost = isTotalBattleHost;
exports.totalBattleUrlOrNull = totalBattleUrlOrNull;
/**
 * The Total Battle game URL is the same for every clan and every
 * deployment — clan switching happens inside the game's canvas, not
 * via different domains. We hardcode it here rather than expose a
 * GAME_URL env var or a per-clan field so there's exactly one value
 * to maintain.
 *
 * If TB ever changes the canonical URL, edit this constant.
 */
exports.TB_GAME_URL = 'https://totalbattle.com';
const TB_HOST = 'totalbattle.com';
/** True for totalbattle.com itself or any subdomain of it. */
function isTotalBattleHost(hostname) {
    const host = hostname.toLowerCase();
    return host === TB_HOST || host.endsWith('.' + TB_HOST);
}
/**
 * The normalised href when `raw` is an https URL on totalbattle.com (or a
 * subdomain of it), otherwise null.
 *
 * The login bridge's browser is signed in to the shared game account, so it
 * is the gate on where an admin may send it — bonus links like
 * `?present=dragonroulette100` are the use case, and anything off the game's
 * own domain has no business being opened there. Parsed rather than
 * prefix-matched: `https://totalbattle.com.evil.example` and
 * `https://totalbattle.com@evil.example` both start with the right text.
 */
function totalBattleUrlOrNull(raw) {
    if (typeof raw !== 'string')
        return null;
    let url;
    try {
        url = new URL(raw.trim());
    }
    catch {
        return null;
    }
    if (url.protocol !== 'https:')
        return null;
    if (url.username || url.password || url.port)
        return null;
    if (!isTotalBattleHost(url.hostname))
        return null;
    return url.href;
}
//# sourceMappingURL=game-url.js.map