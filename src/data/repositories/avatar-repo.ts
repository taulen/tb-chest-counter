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
 * them. They are served publicly at a content-hash path (/avatars/<sha256>.<ext>,
 * routes/avatars.ts): static files never sit behind auth here (Cloudflare caches
 * by extension — docs/cloudflare-caching.md), and the hash makes every new photo
 * a new URL that can be cached for good. See docs/account-avatars.md.
 */
import crypto from 'crypto';
import { getDb } from '../database.js';
import { heroAvatarUrl } from './game-profile-repo.js';
import { linkedGamePlayerId } from './account-invite-repo.js';
import { sniffImage, type SniffedImage } from '../../utils/image-sniff.js';

/** Largest upload the route accepts. The browser sends a 512×512 WebP/JPEG, well under it. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** Accepted pixel size: square, between these. */
export const AVATAR_MIN_PX = 64;
export const AVATAR_MAX_PX = 1024;
/** The Content-Types the upload route reads a body for. */
export const AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;

const EXT_BY_MIME: Record<string, 'png' | 'jpg' | 'webp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export type AvatarKind = 'photo' | 'hero' | 'initial';

export interface AccountAvatar {
  kind: AvatarKind;
  /** The picture's URL; null for the initial. */
  url: string | null;
  /** The account name's first letter, upper-cased — what shows without a picture. */
  initial: string;
}

export type AvatarRejection =
  | 'empty'
  | 'too-large'
  | 'not-an-image'
  | 'not-square'
  | 'too-small'
  | 'too-big';

/** Why an upload is refused, in words the API returns. */
export const AVATAR_REJECTION_MESSAGES: Record<AvatarRejection, string> = {
  'empty': 'No image received',
  'too-large': 'The image is larger than 2 MB',
  'not-an-image': 'Only PNG, JPEG or WebP images are accepted',
  'not-square': 'The image must be square',
  'too-small': `The image must be at least ${AVATAR_MIN_PX}×${AVATAR_MIN_PX} pixels`,
  'too-big': `The image must be at most ${AVATAR_MAX_PX}×${AVATAR_MAX_PX} pixels`,
};

/** Check an upload: the sniffed image, or why it is refused. */
export function validateAvatarUpload(bytes: Buffer | null | undefined): { ok: true; image: SniffedImage } | { ok: false; reason: AvatarRejection } {
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > AVATAR_MAX_BYTES) return { ok: false, reason: 'too-large' };
  const image = sniffImage(bytes);
  if (!image) return { ok: false, reason: 'not-an-image' };
  if (image.width !== image.height) return { ok: false, reason: 'not-square' };
  if (image.width < AVATAR_MIN_PX) return { ok: false, reason: 'too-small' };
  if (image.width > AVATAR_MAX_PX) return { ok: false, reason: 'too-big' };
  return { ok: true, image };
}

/** The public URL of a stored photo. */
export function avatarUrl(sha256: string, mime: string): string {
  return `/avatars/${sha256}.${EXT_BY_MIME[mime] ?? 'png'}`;
}

/** First letter of the account name, upper-cased ('?' for an empty name). */
export function avatarInitial(username: string | null | undefined): string {
  return (Array.from(String(username ?? '').trim())[0] ?? '?').toUpperCase();
}

/**
 * Store (or replace) an account's photo. The row is keyed by the account, so
 * the previous photo's bytes go in the same write.
 */
export function setUserAvatar(userId: number, bytes: Buffer, image: SniffedImage): { url: string; sha256: string } {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  getDb().prepare(
    `INSERT INTO user_avatars (user_id, sha256, mime, width, height, bytes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       sha256 = excluded.sha256, mime = excluded.mime, width = excluded.width,
       height = excluded.height, bytes = excluded.bytes, updated_at = excluded.updated_at`,
  ).run(userId, sha256, image.mime, image.width, image.height, bytes, new Date().toISOString());
  return { url: avatarUrl(sha256, image.mime), sha256 };
}

/** Drop an account's photo. True when there was one. */
export function removeUserAvatar(userId: number): boolean {
  return getDb().prepare('DELETE FROM user_avatars WHERE user_id = ?').run(userId).changes > 0;
}

/** Whether the account has uploaded a photo. */
export function hasUserAvatar(userId: number): boolean {
  return !!getDb().prepare('SELECT 1 FROM user_avatars WHERE user_id = ?').get(userId);
}

/**
 * A stored photo by its content hash and extension, for serving. The
 * extension must be the one its type is served under; anything else is null.
 */
export function getAvatarBytes(sha256: string, ext: string): { mime: string; bytes: Buffer } | null {
  const row = getDb().prepare('SELECT mime, bytes FROM user_avatars WHERE sha256 = ? LIMIT 1').get(sha256) as
    { mime: string; bytes: Buffer } | undefined;
  if (!row || EXT_BY_MIME[row.mime] !== ext) return null;
  return row;
}

/** The hero portrait of the game player this account is in that clan, or null. */
function heroPortraitUrl(userId: number, clanId: number | null): string | null {
  if (clanId === null) return null;
  const playerId = linkedGamePlayerId(userId, clanId);
  if (playerId === null) return null;
  const row = getDb().prepare('SELECT hero_avatar FROM game_players WHERE clan_id = ? AND player_id = ?').get(clanId, playerId) as
    { hero_avatar: number | null } | undefined;
  return heroAvatarUrl(row?.hero_avatar ?? null);
}

/**
 * What an account shows as its picture: its own photo, else the hero portrait
 * of its game player in `clanId` (the clan being viewed), else its initial.
 */
export function resolveAccountAvatar(user: { id: number; username: string }, clanId: number | null): AccountAvatar {
  const initial = avatarInitial(user.username);
  const photo = getDb().prepare('SELECT sha256, mime FROM user_avatars WHERE user_id = ?').get(user.id) as
    { sha256: string; mime: string } | undefined;
  if (photo) return { kind: 'photo', url: avatarUrl(photo.sha256, photo.mime), initial };
  const hero = heroPortraitUrl(user.id, clanId);
  if (hero) return { kind: 'hero', url: hero, initial };
  return { kind: 'initial', url: null, initial };
}
