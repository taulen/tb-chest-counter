"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHARE_TOKEN_REGEX = void 0;
exports.generateShareToken = generateShareToken;
exports.generateUniqueShareToken = generateUniqueShareToken;
const crypto_1 = require("crypto");
const clan_repo_js_1 = require("../data/repositories/clan-repo.js");
const share_link_repo_js_1 = require("../data/repositories/share-link-repo.js");
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_LENGTH = 6;
exports.SHARE_TOKEN_REGEX = /^[A-Za-z0-9]{6}$/;
/**
 * 6 chars from a 62-char alphabet. crypto.randomBytes + rejection sampling
 * keeps the distribution uniform — naive `byte % 62` would over-sample the
 * first four letters by ~2%.
 */
function generateShareToken() {
    let out = '';
    while (out.length < TOKEN_LENGTH) {
        const buf = (0, crypto_1.randomBytes)(TOKEN_LENGTH * 2);
        for (let i = 0; i < buf.length && out.length < TOKEN_LENGTH; i++) {
            const b = buf[i];
            if (b < 248)
                out += ALPHABET[b % ALPHABET.length];
        }
    }
    return out;
}
/**
 * Generate a token guaranteed unique against both the live clans column and
 * the share_links ledger. Collision probability at 6 chars over 62^6 ≈ 56B is
 * negligible, but the ledger's unique index means a duplicate insert would
 * throw — and we never want to reissue a previously-revoked (recoverable)
 * token to a different clan. Retry a few times for safety.
 */
function generateUniqueShareToken() {
    for (let attempt = 0; attempt < 8; attempt++) {
        const token = generateShareToken();
        if (!(0, clan_repo_js_1.getClanByPublicShareToken)(token) && !(0, share_link_repo_js_1.shareLinkTokenExists)(token))
            return token;
    }
    throw new Error('Failed to generate a unique share token');
}
//# sourceMappingURL=share-token.js.map