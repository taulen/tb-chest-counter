/**
 * Read side of the game-protocol tables for the member profile and member
 * lists: what the game says about a player (game_players), their city
 * (game_city_snapshots), research + hero talents (game_player_techs) and how
 * those changed (game_player_tech_history). Members link to players through
 * members.game_player_id (v103).
 */
import { getDb } from '../database.js';
import { gameArtUrl, heroAvatarImage } from '../../game-art/index.js';

export interface GamePlayerProfile {
  playerId: number;
  name: string;
  /** Game clan rank: 1 = leader … 5. */
  role: number | null;
  joinedAt: number | null;
  inClan: boolean;
  might: number | null;
  heroLevel: number | null;
  cityLevel: number | null;
  vip: number | null;
  goldPass: boolean;
  heroAvatar: number | null;
  /** The hero's portrait from the game's art (/game-art/…), or null before the art is extracted. */
  avatarUrl: string | null;
  lastSeen: string;
}

export interface GameCitySnapshot {
  gameDate: string;
  capturedAt: string;
  techCount: number;
  buildings: Record<string, { type: number; level: number }>;
  hero: { level: number | null; xp: number | null };
}

type PlayerRow = {
  player_id: number; name: string; role: number | null; joined_at: number | null; in_clan: number;
  might: number | null; hero_level: number | null; city_level: number | null; vip: number | null;
  gold_pass: number | null; hero_avatar: number | null; last_seen: string;
};

const toProfile = (r: PlayerRow): GamePlayerProfile => ({
  playerId: r.player_id,
  name: r.name,
  role: r.role,
  joinedAt: r.joined_at,
  inClan: r.in_clan === 1,
  might: r.might,
  heroLevel: r.hero_level,
  cityLevel: r.city_level,
  vip: r.vip,
  goldPass: r.gold_pass === 1,
  heroAvatar: r.hero_avatar,
  avatarUrl: heroAvatarUrl(r.hero_avatar),
  lastSeen: r.last_seen,
});

/** URL of a hero portrait by the game's avatar id, or null. */
export function heroAvatarUrl(heroAvatar: number | null | undefined): string | null {
  const name = heroAvatarImage(heroAvatar);
  return name ? gameArtUrl(name) : null;
}

/** The game player a member is linked to, or null when not linked yet. */
export function gamePlayerIdForMember(memberId: number, clanId: number): number | null {
  const r = getDb().prepare('SELECT game_player_id AS id FROM members WHERE id = ? AND clan_id = ?').get(memberId, clanId) as
    { id: number | null } | undefined;
  return r?.id ?? null;
}

export function getGamePlayer(clanId: number, playerId: number): GamePlayerProfile | null {
  const r = getDb().prepare('SELECT * FROM game_players WHERE clan_id = ? AND player_id = ?').get(clanId, playerId) as PlayerRow | undefined;
  return r ? toProfile(r) : null;
}

/** Every member of the clan that is linked to a game player: memberId → profile. */
export function getGamePlayersByMember(clanId: number): Map<number, GamePlayerProfile> {
  const rows = getDb().prepare(
    `SELECT m.id AS member_id, g.* FROM members m
       JOIN game_players g ON g.clan_id = m.clan_id AND g.player_id = m.game_player_id
      WHERE m.clan_id = ?`,
  ).all(clanId) as Array<PlayerRow & { member_id: number }>;
  return new Map(rows.map((r) => [r.member_id, toProfile(r)]));
}

export function getLatestCity(clanId: number, playerId: number): GameCitySnapshot | null {
  const r = getDb().prepare(
    `SELECT game_date, captured_at, tech_count, buildings, hero FROM game_city_snapshots
      WHERE clan_id = ? AND player_id = ? ORDER BY game_date DESC LIMIT 1`,
  ).get(clanId, playerId) as { game_date: string; captured_at: string; tech_count: number; buildings: string; hero: string } | undefined;
  if (!r) return null;
  return {
    gameDate: r.game_date,
    capturedAt: r.captured_at,
    techCount: r.tech_count,
    buildings: JSON.parse(r.buildings || '{}'),
    hero: JSON.parse(r.hero || '{}'),
  };
}

/** techId → level, plus when the levels were last read. */
export function getPlayerTechs(clanId: number, playerId: number): { levels: Record<string, number>; readAt: string | null } {
  const rows = getDb().prepare('SELECT tech_id, level, last_seen FROM game_player_techs WHERE clan_id = ? AND player_id = ?')
    .all(clanId, playerId) as Array<{ tech_id: number; level: number; last_seen: string }>;
  const levels: Record<string, number> = {};
  let readAt: string | null = null;
  for (const r of rows) {
    levels[r.tech_id] = r.level;
    if (!readAt || r.last_seen > readAt) readAt = r.last_seen;
  }
  return { levels, readAt };
}

/**
 * Level changes since `sinceIso`, newest first. The first read of a player
 * records every tech at once; that baseline is left out (it is not a change),
 * by skipping rows stamped with the player's earliest history time.
 */
export function getPlayerTechChanges(clanId: number, playerId: number, sinceIso: string, limit = 200): Array<{ techId: number; level: number; changedAt: string }> {
  return getDb().prepare(
    `SELECT tech_id AS techId, level, changed_at AS changedAt FROM game_player_tech_history h
      WHERE clan_id = ? AND player_id = ? AND changed_at >= ?
        AND changed_at > (SELECT MIN(changed_at) FROM game_player_tech_history WHERE clan_id = h.clan_id AND player_id = h.player_id)
      ORDER BY changed_at DESC LIMIT ?`,
  ).all(clanId, playerId, sinceIso, limit) as Array<{ techId: number; level: number; changedAt: string }>;
}

export interface PlayerCaptain {
  captainId: number;
  level: number;
  stars: number;
  xp: number | null;
  /** 1–3 = in the active line-up, 0 = not. */
  slot: number;
  firstSeen: string;
  lastSeen: string;
}

/** A player's captains as last read, highest level first (the game's own order). */
export function getPlayerCaptains(clanId: number, playerId: number): PlayerCaptain[] {
  return getDb().prepare(
    `SELECT captain_id AS captainId, level, stars, xp, slot, first_seen AS firstSeen, last_seen AS lastSeen
       FROM game_player_captains WHERE clan_id = ? AND player_id = ?
      ORDER BY level DESC, stars DESC, captain_id`,
  ).all(clanId, playerId) as PlayerCaptain[];
}

export interface CaptainChange {
  captainId: number;
  level: number;
  stars: number;
  /** The previous read's values; null when the captain is new. */
  prevLevel: number | null;
  prevStars: number | null;
  changedAt: string;
}

/**
 * Captain level/star changes since `sinceIso`, newest first, each with the
 * values it moved from. The first read's baseline is left out: it is when we
 * started looking, not when the player got there.
 */
export function getPlayerCaptainChanges(clanId: number, playerId: number, sinceIso: string, limit = 100): CaptainChange[] {
  return getDb().prepare(
    `WITH h AS (
       SELECT captain_id, level, stars, changed_at,
              LAG(level) OVER w AS prev_level, LAG(stars) OVER w AS prev_stars
         FROM game_player_captain_history
        WHERE clan_id = ? AND player_id = ?
       WINDOW w AS (PARTITION BY captain_id ORDER BY changed_at)
     )
     SELECT captain_id AS captainId, level, stars, prev_level AS prevLevel, prev_stars AS prevStars, changed_at AS changedAt
       FROM h
      WHERE changed_at >= ?
        AND changed_at > (SELECT MIN(changed_at) FROM game_player_captain_history WHERE clan_id = ? AND player_id = ?)
      ORDER BY changed_at DESC, level DESC LIMIT ?`,
  ).all(clanId, playerId, sinceIso, clanId, playerId, limit) as CaptainChange[];
}

export interface PlayerArtifact {
  artifactType: number;
  level: number;
  star: number;
  /** Random-bonus effect ids (a repeated roll once per copy). */
  bonuses: number[];
  /** Worn by a line-up captain as of the latest city read. */
  inLineup: boolean;
  firstSeen: string;
  lastSeen: string;
}

/** The artifacts a player has been seen wearing (v112): line-up ones first, then by level. */
export function getPlayerArtifacts(clanId: number, playerId: number): PlayerArtifact[] {
  const rows = getDb().prepare(
    `SELECT artifact_type AS artifactType, level, star, bonuses, in_lineup AS inLineup, first_seen AS firstSeen, last_seen AS lastSeen
       FROM game_player_artifacts WHERE clan_id = ? AND player_id = ?
      ORDER BY in_lineup DESC, level DESC, star DESC, artifact_type`,
  ).all(clanId, playerId) as Array<Omit<PlayerArtifact, 'bonuses' | 'inLineup'> & { bonuses: string; inLineup: number }>;
  return rows.map((r) => ({ ...r, inLineup: r.inLineup === 1, bonuses: parseIds(r.bonuses) }));
}

function parseIds(json: string): number[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

export interface ArtifactChange {
  artifactType: number;
  level: number;
  star: number;
  /** The previous read's values; null when the artifact is new. */
  prevLevel: number | null;
  prevStar: number | null;
  /** The rolls changed (rerolled) since the previous read. */
  rerolled: boolean;
  changedAt: string;
}

/**
 * Artifact level / star level / roll changes since `sinceIso`, newest first.
 * The first read's baseline is left out, as for captains.
 */
export function getPlayerArtifactChanges(clanId: number, playerId: number, sinceIso: string, limit = 100): ArtifactChange[] {
  const rows = getDb().prepare(
    `WITH h AS (
       SELECT artifact_type, level, star, bonuses, changed_at,
              LAG(level) OVER w AS prev_level, LAG(star) OVER w AS prev_star, LAG(bonuses) OVER w AS prev_bonuses
         FROM game_player_artifact_history
        WHERE clan_id = ? AND player_id = ?
       WINDOW w AS (PARTITION BY artifact_type ORDER BY changed_at)
     )
     SELECT artifact_type AS artifactType, level, star, prev_level AS prevLevel, prev_star AS prevStar,
            (prev_bonuses IS NOT NULL AND prev_bonuses <> bonuses) AS rerolled, changed_at AS changedAt
       FROM h
      WHERE changed_at >= ?
        AND changed_at > (SELECT MIN(changed_at) FROM game_player_artifact_history WHERE clan_id = ? AND player_id = ?)
        -- An archive replay can leave a row equal to the one before it (the
        -- live read, replayed past): not a change.
        AND NOT (prev_level IS level AND prev_star IS star AND prev_bonuses IS bonuses)
      ORDER BY changed_at DESC, level DESC, artifact_type LIMIT ?`,
  ).all(clanId, playerId, sinceIso, clanId, playerId, limit) as Array<Omit<ArtifactChange, 'rerolled'> & { rerolled: number }>;
  return rows.map((r) => ({ ...r, rerolled: r.rerolled === 1 }));
}

export interface PlayerEquipmentItem {
  captainId: number;
  position: number;
  itemType: number;
  enchantment: number;
  gems: number[];
  /** When this item was first seen in this position. */
  firstSeen: string;
}

/** What every captain of a player wears (v112), by captain then position. */
export function getPlayerEquipment(clanId: number, playerId: number): PlayerEquipmentItem[] {
  const rows = getDb().prepare(
    `SELECT captain_id AS captainId, position, item_type AS itemType, enchantment, gems, first_seen AS firstSeen
       FROM game_player_captain_equipment WHERE clan_id = ? AND player_id = ?
      ORDER BY captain_id, position`,
  ).all(clanId, playerId) as Array<Omit<PlayerEquipmentItem, 'gems'> & { gems: string }>;
  return rows.map((r) => ({ ...r, gems: parseIds(r.gems) }));
}

export interface EquipmentChange {
  captainId: number;
  position: number;
  /** 0 = the position was emptied. */
  itemType: number;
  /** The item type before (null: the position was empty / first seen). */
  prevType: number | null;
  /** Same item, but its enchantment or gems changed. */
  reworked: boolean;
  changedAt: string;
}

/** Equipment changes since `sinceIso`, newest first; the first read's baseline is left out. */
export function getPlayerEquipmentChanges(clanId: number, playerId: number, sinceIso: string, limit = 100): EquipmentChange[] {
  const rows = getDb().prepare(
    `WITH h AS (
       SELECT captain_id, position, item_uid, item_type, enchantment, gems, changed_at,
              LAG(item_uid) OVER w AS prev_uid, LAG(item_type) OVER w AS prev_type,
              LAG(enchantment) OVER w AS prev_enchantment, LAG(gems) OVER w AS prev_gems
         FROM game_player_equipment_history
        WHERE clan_id = ? AND player_id = ?
       WINDOW w AS (PARTITION BY captain_id, position ORDER BY changed_at)
     )
     SELECT captain_id AS captainId, position, item_type AS itemType,
            CASE WHEN prev_type = 0 THEN NULL ELSE prev_type END AS prevType,
            (prev_uid IS NOT NULL AND prev_uid = item_uid) AS reworked, changed_at AS changedAt
       FROM h
      WHERE changed_at >= ?
        AND changed_at > (SELECT MIN(changed_at) FROM game_player_equipment_history WHERE clan_id = ? AND player_id = ?)
        -- A replayed read equal to the row before it is not a change.
        AND NOT (prev_uid IS item_uid AND prev_type IS item_type AND prev_enchantment IS enchantment AND prev_gems IS gems)
      ORDER BY changed_at DESC, captain_id, position LIMIT ?`,
  ).all(clanId, playerId, sinceIso, clanId, playerId, limit) as Array<Omit<EquipmentChange, 'reworked'> & { reworked: number }>;
  return rows.map((r) => ({ ...r, reworked: r.reworked === 1 }));
}
