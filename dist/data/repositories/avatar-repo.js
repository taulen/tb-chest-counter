"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AVATAR_REJECTION_MESSAGES = exports.AVATAR_MIMES = exports.AVATAR_MAX_PX = exports.AVATAR_MIN_PX = exports.AVATAR_MAX_BYTES = void 0;
exports.validateAvatarUpload = validateAvatarUpload;
exports.avatarUrl = avatarUrl;
exports.avatarInitial = avatarInitial;
exports.setUserAvatar = setUserAvatar;
exports.removeUserAvatar = removeUserAvatar;
exports.hasUserAvatar = hasUserAvatar;
exports.getAvatarBytes = getAvatarBytes;
exports.resolveAccountAvatar = resolveAccountAvatar;
/**
 * Account avatars (v128): the small round picture next to a signed-in account.
 *
 * What an account shows, in order (resolveAccountAvatar — the ONE place that
 * decides, used by every route that hands an account to the UI):
 *   1. the photo the account uploaded itself (framed in the browser, 512×512);
 *   2. else the hero portrait of the game player the account is, in that clan
 *      (the invite link, account-invite-repo.linkedGamePlayerId →
 *      game_players.hero_avatar);
 *   3. else the account name's first letter.
 *
 * Photos live in the database, not on disk, so a backup or a restore carries
 * them. They are served to signed-in viewers only at an extensionless /api path
 * (/api/avatars/<sha256>, routes/avatars.ts) that Cloudflare never stores, and
 * the hash makes every new photo a new URL the browser can keep for good. See
 * docs/account-avatars.md.
 */
const crypto_1 = __importDefault(require("crypto"));
const database_js_1 = require("../database.js");
const game_profile_repo_js_1 = require("./game-profile-repo.js");
const account_invite_repo_js_1 = require("./account-invite-repo.js");
const image_sniff_js_1 = require("../../utils/image-sniff.js");
/** Largest upload the route accepts. The browser sends a 512×512 WebP/JPEG, well under it. */
exports.AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** Accepted pixel size: square, between these. */
exports.AVATAR_MIN_PX = 64;
exports.AVATAR_MAX_PX = 1024;
/** The Content-Types the upload route reads a body for. */
exports.AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
/** Why an upload is refused, in words the API returns. */
exports.AVATAR_REJECTION_MESSAGES = {
    'empty': 'No image received',
    'too-large': 'The image is larger than 2 MB',
    'not-an-image': 'Only PNG, JPEG or WebP images are accepted',
    'not-square': 'The image must be square',
    'too-small': `The image must be at least ${exports.AVATAR_MIN_PX}×${exports.AVATAR_MIN_PX} pixels`,
    'too-big': `The image must be at most ${exports.AVATAR_MAX_PX}×${exports.AVATAR_MAX_PX} pixels`,
};
/** Check an upload: the sniffed image, or why it is refused. */
function validateAvatarUpload(bytes) {
    if (!bytes || bytes.length === 0)
        return { ok: false, reason: 'empty' };
    if (bytes.length > exports.AVATAR_MAX_BYTES)
        return { ok: false, reason: 'too-large' };
    const image = (0, image_sniff_js_1.sniffImage)(bytes);
    if (!image)
        return { ok: false, reason: 'not-an-image' };
    if (image.width !== image.height)
        return { ok: false, reason: 'not-square' };
    if (image.width < exports.AVATAR_MIN_PX)
        return { ok: false, reason: 'too-small' };
    if (image.width > exports.AVATAR_MAX_PX)
        return { ok: false, reason: 'too-big' };
    return { ok: true, image };
}
/**
 * The URL of a stored photo: signed-in viewers only, extensionless under /api
 * so Cloudflare never stores it (routes/avatars.ts).
 */
function avatarUrl(sha256) {
    return `/api/avatars/${sha256}`;
}
/** First letter of the account name, upper-cased ('?' for an empty name). */
function avatarInitial(username) {
    return (Array.from(String(username ?? '').trim())[0] ?? '?').toUpperCase();
}
/**
 * Store (or replace) an account's photo. The row is keyed by the account, so
 * the previous photo's bytes go in the same write.
 */
function setUserAvatar(userId, bytes, image) {
    const sha256 = crypto_1.default.createHash('sha256').update(bytes).digest('hex');
    (0, database_js_1.getDb)().prepare(`INSERT INTO user_avatars (user_id, sha256, mime, width, height, bytes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       sha256 = excluded.sha256, mime = excluded.mime, width = excluded.width,
       height = excluded.height, bytes = excluded.bytes, updated_at = excluded.updated_at`).run(userId, sha256, image.mime, image.width, image.height, bytes, new Date().toISOString());
    return { url: avatarUrl(sha256), sha256 };
}
/** Drop an account's photo. True when there was one. */
function removeUserAvatar(userId) {
    return (0, database_js_1.getDb)().prepare('DELETE FROM user_avatars WHERE user_id = ?').run(userId).changes > 0;
}
/** Whether the account has uploaded a photo. */
function hasUserAvatar(userId) {
    return !!(0, database_js_1.getDb)().prepare('SELECT 1 FROM user_avatars WHERE user_id = ?').get(userId);
}
/** A stored photo by its content hash, for serving; null when no account has it. */
function getAvatarBytes(sha256) {
    const row = (0, database_js_1.getDb)().prepare('SELECT mime, bytes FROM user_avatars WHERE sha256 = ? LIMIT 1').get(sha256);
    return row ?? null;
}
/** The hero portrait of the game player this account is in that clan, or null. */
function heroPortraitUrl(userId, clanId) {
    if (clanId === null)
        return null;
    const playerId = (0, account_invite_repo_js_1.linkedGamePlayerId)(userId, clanId);
    if (playerId === null)
        return null;
    const row = (0, database_js_1.getDb)().prepare('SELECT hero_avatar FROM game_players WHERE clan_id = ? AND player_id = ?').get(clanId, playerId);
    return (0, game_profile_repo_js_1.heroAvatarUrl)(row?.hero_avatar ?? null);
}
/**
 * What an account shows as its picture: its own photo, else the hero portrait
 * of its game player in `clanId` (the clan being viewed), else its initial.
 */
function resolveAccountAvatar(user, clanId) {
    const initial = avatarInitial(user.username);
    const photo = (0, database_js_1.getDb)().prepare('SELECT sha256, mime FROM user_avatars WHERE user_id = ?').get(user.id);
    if (photo)
        return { kind: 'photo', url: avatarUrl(photo.sha256), initial };
    const hero = heroPortraitUrl(user.id, clanId);
    if (hero)
        return { kind: 'hero', url: hero, initial };
    return { kind: 'initial', url: null, initial };
}
//# sourceMappingURL=avatar-repo.js.map