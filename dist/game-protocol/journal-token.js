"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.journalTokenPayload = journalTokenPayload;
exports.findJournalToken = findJournalToken;
exports.journalTokenExpiry = journalTokenExpiry;
/** The token's payload, or null when it isn't a readable JWT. */
function journalTokenPayload(token) {
    const part = token.split('.')[1];
    if (!part)
        return null;
    try {
        const b64 = decodeURIComponent(part).replace(/-/g, '+').replace(/_/g, '/');
        const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
    }
    catch {
        return null;
    }
}
/** The journal token in a login reply's root: the string that is a JWT for the "Journal" audience. */
function findJournalToken(root) {
    if (!Array.isArray(root))
        return null;
    for (const v of root) {
        if (typeof v === 'string' && v.startsWith('eyJ') && v.split('.').length === 3 && journalTokenPayload(v)?.aud === 'Journal')
            return v;
    }
    return null;
}
/** Unix seconds when the token stops working, or null when it doesn't say. */
function journalTokenExpiry(token) {
    const exp = journalTokenPayload(token)?.exp;
    return typeof exp === 'number' ? exp : null;
}
//# sourceMappingURL=journal-token.js.map