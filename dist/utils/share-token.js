"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESERVED_SHARE_KEYS = exports.SHARE_TOKEN_REGEX = exports.VANITY_MAX_LENGTH = exports.VANITY_MIN_LENGTH = void 0;
exports.generateShareToken = generateShareToken;
exports.generateUniqueShareToken = generateUniqueShareToken;
exports.validateVanityKey = validateVanityKey;
const crypto_1 = require("crypto");
const share_link_repo_js_1 = require("../data/repositories/share-link-repo.js");
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_LENGTH = 6;
exports.VANITY_MIN_LENGTH = 3;
exports.VANITY_MAX_LENGTH = 10;
/**
 * Shape of ANY share key appearing as `/<key>` — a generated token (6
 * case-sensitive alphanumerics) or an admin-chosen vanity key (3-10
 * lowercase alphanumerics). One regex covers both because the router only
 * needs "could this segment be a share key at all?"; which kind it is, and
 * whether it resolves, is the ledger's answer.
 *
 * Widening this from the old fixed `{6}` widens what the top-level handler
 * claims, which is why RESERVED_SHARE_KEYS exists below.
 */
exports.SHARE_TOKEN_REGEX = /^[A-Za-z0-9]{3,10}$/;
/** Vanity keys are lowercase-only so the key an admin types is the key they get. */
const VANITY_REGEX = new RegExp(`^[a-z0-9]{${exports.VANITY_MIN_LENGTH},${exports.VANITY_MAX_LENGTH}}$`);
/**
 * Single-segment paths a vanity key must never claim.
 *
 * `publicShareTokenHandler` is mounted ahead of the authenticated routing
 * table, so a vanity key equal to a real path would either be shadowed by an
 * earlier route (a dead link — /login, /setup) or shadow a later one. Both
 * failure modes are silent, and the cost of a denylist is one rejected name
 * at creation time. Entries are lowercase; vanity keys are too.
 */
exports.RESERVED_SHARE_KEYS = new Set([
    // Registered before the share handler — a key here would never resolve.
    'login', 'logout', 'setup', 'robots', 'health',
    // Namespaces and static roots registered after it.
    'api', 'assets', 'vendor', 'public', 'static', 'lib', 'pages', 'img',
    'images', 'css', 'js', 'fonts', 'favicon', 'index', 'app', 'v', 'auth',
    'oauth', 'share', 'admin',
    // App surfaces. The SPA is hash-routed today, but reserving its names keeps
    // a future path-routed build from colliding with links already in the wild.
    'dashboard', 'clans', 'members', 'leaderboard', 'analytics', 'resources',
    'events', 'system', 'settings', 'discord', 'docs', 'help', 'about',
]);
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
 * Generate a token guaranteed unique against the share_links ledger, which
 * is the sole authority on what `/<key>` resolves to. Collision probability
 * at 6 chars over 62^6 ≈ 56B is negligible, but the ledger's unique index
 * means a duplicate insert would throw — and we never want to reissue a
 * previously-revoked (recoverable) token. Retry a few times for safety.
 *
 * The check is case-INSENSITIVE so a generated token can never land on a
 * vanity key an admin already holds (or vice versa).
 */
function generateUniqueShareToken() {
    for (let attempt = 0; attempt < 8; attempt++) {
        const token = generateShareToken();
        if (!(0, share_link_repo_js_1.shareLinkTokenExists)(token))
            return token;
    }
    throw new Error('Failed to generate a unique share token');
}
/**
 * Validate an admin-supplied vanity key and return it in canonical (lowercase)
 * form. Uniqueness against the ledger is checked here too, so the caller gets
 * one message for every way a key can be refused rather than a UNIQUE
 * constraint error surfacing as a 500.
 */
function validateVanityKey(raw) {
    const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!key)
        return { ok: false, error: 'Enter a custom link key.' };
    if (key.length < exports.VANITY_MIN_LENGTH || key.length > exports.VANITY_MAX_LENGTH) {
        return {
            ok: false,
            error: `A custom key must be ${exports.VANITY_MIN_LENGTH}-${exports.VANITY_MAX_LENGTH} characters.`,
        };
    }
    if (!VANITY_REGEX.test(key)) {
        return { ok: false, error: 'A custom key can only use letters a-z and digits 0-9.' };
    }
    if (exports.RESERVED_SHARE_KEYS.has(key)) {
        return { ok: false, error: `“${key}” is reserved by the app — pick another key.` };
    }
    if ((0, share_link_repo_js_1.shareLinkTokenExists)(key)) {
        return { ok: false, error: `“${key}” is already taken.` };
    }
    return { ok: true, key };
}
//# sourceMappingURL=share-token.js.map