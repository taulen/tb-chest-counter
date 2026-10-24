"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePublicUrl = normalizePublicUrl;
/**
 * Normalise an admin-entered public URL to a bare origin ("https://sinful.day").
 * Accepts a missing scheme ("sinful.day" → https) and drops any path, query or
 * trailing slash, since links are built as `${origin}/${path}`.
 * Returns '' for blank input and null when it isn't a usable http(s) URL.
 */
function normalizePublicUrl(raw) {
    if (raw === null || raw === undefined)
        return '';
    if (typeof raw !== 'string')
        return null;
    const trimmed = raw.trim();
    if (!trimmed)
        return '';
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url;
    try {
        url = new URL(withScheme);
    }
    catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost')
        return null;
    return url.origin;
}
//# sourceMappingURL=public-url.js.map