/**
 * Avatars: the small round picture next to a signed-in account (v128) and the
 * picture each game player shows (v130: photos belong to PLAYERS).
 *
 * What an account shows, in order (resolveAccountAvatar — the ONE place that
 * decides, used by every route that hands an account to the UI):
 *   1. its main player in the clan being viewed (account-invite-repo.mainLink):
 *      that player's photo (player_avatars), else its hero portrait;
 *   2. an account with no player at all (old, unlinked): its own photo
 *      (user_avatars), else its name's first letter.
 * A member shows its own photo, else its hero, else its initial
 * (resolveMemberAvatar). Photos are framed in the browser, 512×512.
 *
 * Photos live in the database, not on disk, so a backup or a restore carries
 * them. They are served to signed-in viewers only at an extensionless /api path
 * (/api/avatars/<sha256>, routes/avatars.ts) that Cloudflare never stores, and
 * the hash makes every new photo a new URL the browser can keep for good. See
 * docs/account-avatars.md.
 */
import crypto from 'crypto';
import { getDb } from '../database.js';
import { heroAvatarUrl } from './game-profile-repo.js';
import { linksForUser, mainLink } from './account-invite-repo.js';
import { sniffImage, type SniffedImage } from '../../utils/image-sniff.js';

/** Largest upload the route accepts. The browser sends a 512×512 WebP/JPEG, well under it. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** Accepted pixel size: square, between these. */
export const AVATAR_MIN_PX = 64;
export const AVATAR_MAX_PX = 1024;
/** The Content-Types the upload route reads a body for. */
export const AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;

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

/**
 * The URL of a stored photo: signed-in viewers only, extensionless under /api
 * so Cloudflare never stores it (routes/avatars.ts).
 */
export function avatarUrl(sha256: string): string {
  return `/api/avatars/${sha256}`;
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
  return { url: avatarUrl(sha256), sha256 };
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
 * A stored photo by its content hash, for serving; null when none has it. A
 * player's photo (v130) or an unlinked account's own photo.
 */
export function getAvatarBytes(sha256: string): { mime: string; bytes: Buffer } | null {
  const db = getDb();
  const row = (db.prepare('SELECT mime, bytes FROM player_avatars WHERE sha256 = ? LIMIT 1').get(sha256)
    ?? db.prepare('SELECT mime, bytes FROM user_avatars WHERE sha256 = ? LIMIT 1').get(sha256)) as
    { mime: string; bytes: Buffer } | undefined;
  return row ?? null;
}

// ── Photos per player (v130) ────────────────────────────────────────────────

/**
 * Store (or replace) a game player's photo, uploaded by the account linked to
 * it. One row per player: the previous photo's bytes go in the same write.
 */
export function setPlayerAvatar(playerId: number, uploadedBy: number, bytes: Buffer, image: SniffedImage): { url: string; sha256: string } {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  getDb().prepare(
    `INSERT INTO player_avatars (player_id, sha256, mime, width, height, bytes, uploaded_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(player_id) DO UPDATE SET
       sha256 = excluded.sha256, mime = excluded.mime, width = excluded.width, height = excluded.height,
       bytes = excluded.bytes, uploaded_by = excluded.uploaded_by, updated_at = excluded.updated_at`,
  ).run(playerId, sha256, image.mime, image.width, image.height, bytes, uploadedBy, new Date().toISOString());
  return { url: avatarUrl(sha256), sha256 };
}

/** Drop a game player's photo. True when there was one. */
export function removePlayerAvatar(playerId: number): boolean {
  return getDb().prepare('DELETE FROM player_avatars WHERE player_id = ?').run(playerId).changes > 0;
}

/** A game player's own photo URL, or null. */
export function photoUrlForPlayer(playerId: number): string | null {
  const row = getDb().prepare('SELECT sha256 FROM player_avatars WHERE player_id = ?').get(playerId) as { sha256: string } | undefined;
  return row ? avatarUrl(row.sha256) : null;
}

/** The hero portrait of a game player in a clan, or null. */
function heroPortraitUrl(clanId: number, playerId: number): string | null {
  const row = getDb().prepare('SELECT hero_avatar FROM game_players WHERE clan_id = ? AND player_id = ?').get(clanId, playerId) as
    { hero_avatar: number | null } | undefined;
  return heroAvatarUrl(row?.hero_avatar ?? null);
}

/**
 * The photos of a clan's players: game player id → photo URL. A member list
 * uses it so each player — alts included — shows its own picture.
 */
export function linkedPhotoUrlsForClan(clanId: number): Map<number, string> {
  const rows = getDb().prepare(
    `SELECT pa.player_id, pa.sha256 FROM player_avatars pa
       WHERE pa.player_id IN (SELECT player_id FROM game_players WHERE clan_id = ?)`,
  ).all(clanId) as Array<{ player_id: number; sha256: string }>;
  return new Map(rows.map((r) => [r.player_id, avatarUrl(r.sha256)]));
}

/** What a MEMBER (a game player) shows: its own photo, else the hero portrait, else the initial. */
export function resolveMemberAvatar(name: string, heroUrl: string | null, photoUrl: string | null): AccountAvatar {
  const initial = avatarInitial(name);
  if (photoUrl) return { kind: 'photo', url: photoUrl, initial };
  if (heroUrl) return { kind: 'hero', url: heroUrl, initial };
  return { kind: 'initial', url: null, initial };
}

/**
 * What an account shows as its picture: its MAIN player in `clanId` (the clan
 * being viewed) — that player's photo, else its hero portrait; an account not
 * linked there uses its home clan's main player. An account with no player at
 * all (old, unlinked) shows its own photo, else its initial.
 */
export function resolveAccountAvatar(user: { id: number; username: string; clanId?: number | null }, clanId: number | null): AccountAvatar {
  const initial = avatarInitial(user.username);
  const main = (clanId !== null ? mainLink(user.id, clanId) : null)
    ?? (user.clanId != null ? mainLink(user.id, user.clanId) : null)
    ?? linksForUser(user.id)[0] ?? null;
  if (main) {
    const photo = photoUrlForPlayer(main.playerId);
    if (photo) return { kind: 'photo', url: photo, initial };
    const hero = heroPortraitUrl(main.clanId, main.playerId);
    if (hero) return { kind: 'hero', url: hero, initial };
    return { kind: 'initial', url: null, initial };
  }
  const own = getDb().prepare('SELECT sha256 FROM user_avatars WHERE user_id = ?').get(user.id) as { sha256: string } | undefined;
  if (own) return { kind: 'photo', url: avatarUrl(own.sha256), initial };
  return { kind: 'initial', url: null, initial };
}

export interface AccountPlayer {
  playerId: number;
  clanId: number;
  clanName: string;
  playerName: string;
  rank: number | null;
  onRoster: boolean;
  /** The player this account plays as in that clan. */
  isMain: boolean;
  avatar: AccountAvatar;
}

/** Every player the account is linked to, with its clan and picture — the photo dialog's picker and "Playing as". */
export function accountPlayers(userId: number): AccountPlayer[] {
  const db = getDb();
  const links = linksForUser(userId);
  const mains = new Map<number, number>();
  for (const l of links) if (!mains.has(l.clanId)) mains.set(l.clanId, mainLink(userId, l.clanId)?.playerId ?? l.playerId);
  return links.map((l) => {
    const clan = db.prepare('SELECT name, short_code FROM clans WHERE id = ?').get(l.clanId) as { name: string; short_code: string | null } | undefined;
    const code = String(clan?.short_code ?? '').trim();
    return {
      playerId: l.playerId,
      clanId: l.clanId,
      clanName: clan ? (code ? `${code} - ${clan.name}` : clan.name) : `#${l.clanId}`,
      playerName: l.playerName,
      rank: l.rank,
      onRoster: l.onRoster,
      isMain: mains.get(l.clanId) === l.playerId,
      avatar: resolveMemberAvatar(l.playerName, heroPortraitUrl(l.clanId, l.playerId), photoUrlForPlayer(l.playerId)),
    };
  });
}
