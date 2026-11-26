/**
 * Read side of the game-protocol tables for the member profile and member
 * lists: what the game says about a player (game_players), their city
 * (game_city_snapshots), research + hero talents (game_player_techs) and how
 * those changed (game_player_tech_history). Members link to players through
 * members.game_player_id (v103).
 */
import { getDb } from '../database.js';
import { avatarFrameImage, gameArtUrl, heroAvatarImage } from '../../game-art/index.js';
import { HERO_ENTRY_ID } from '../../game-protocol/equipment.js';
import type { CitySpeeds } from '../../game-protocol/city-speeds.js';

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
  /** Gold Ingots (402 field 17, public in the game); null before v110 read it. */
  goldIngots: number | null;
  /** The city's shield bubble on the map (v112); null until the map was read. */
  shielded: boolean | null;
  /** Walls down: the city burns on the map (v112); null until the map was read. */
  burning: boolean | null;
  /** When the map last showed the city. */
  mapSeenAt: string | null;
  heroAvatar: number | null;
  /** The hero's portrait from the game's art (/game-art/…), or null before the art is extracted. */
  avatarUrl: string | null;
  /** The player's portrait frame (402 f6, a T52 customization id); null before it was read. */
  avatarFrame: number | null;
  /** The frame the game draws the portrait in (theirs, else the game's default), or null. */
  frameUrl: string | null;
  /** Their city look (402 f5, a T52 customization id; lib/game-art.js cityLookUrl); null before it was read. */
  cityAppearance: number | null;
  lastSeen: string;
}

export interface GameCitySnapshot {
  gameDate: string;
  capturedAt: string;
  techCount: number;
  buildings: Record<string, { type: number; level: number }>;
  /**
   * City field 26 — the player's dragon, not the hero (column `hero`, named
   * before that was known). Stage and name are stored since Nov 2026; older
   * snapshots have level and XP only (`{}` when no dragon was read).
   */
  dragon: { level?: number | null; xp?: number | null; stage?: number | null; name?: string | null };
}

type PlayerRow = {
  player_id: number; name: string; role: number | null; joined_at: number | null; in_clan: number;
  might: number | null; hero_level: number | null; city_level: number | null; vip: number | null;
  gold_pass: number | null; hero_avatar: number | null; gold_ingots?: number | null;
  shielded?: number | null; burning?: number | null; map_seen_at?: string | null;
  avatar_frame?: number | null; city_appearance?: number | null; last_seen: string;
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
  goldIngots: r.gold_ingots ?? null,
  shielded: r.shielded == null ? null : r.shielded === 1,
  burning: r.burning == null ? null : r.burning === 1,
  mapSeenAt: r.map_seen_at ?? null,
  heroAvatar: r.hero_avatar,
  avatarUrl: heroAvatarUrl(r.hero_avatar),
  avatarFrame: r.avatar_frame ?? null,
  frameUrl: avatarFrameUrl(r.avatar_frame),
  cityAppearance: r.city_appearance ?? null,
  lastSeen: r.last_seen,
});

/** URL of a hero portrait by the game's avatar id, or null. */
export function heroAvatarUrl(heroAvatar: number | null | undefined): string | null {
  const name = heroAvatarImage(heroAvatar);
  return name ? gameArtUrl(name) : null;
}

/** URL of the frame a portrait is drawn in, by the player's frame id (the game's default when unknown), or null. */
export function avatarFrameUrl(frameId: number | null | undefined): string | null {
  const name = avatarFrameImage(frameId);
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
    dragon: JSON.parse(r.hero || '{}'),
  };
}

/**
 * A player's city speeds (city-speeds.ts), one per game day the city was read
 * and worked out, oldest first.
 */
export function getPlayerSpeeds(clanId: number, playerId: number): Array<{ gameDate: string; capturedAt: string; speeds: CitySpeeds }> {
  const rows = getDb().prepare(
    `SELECT game_date, captured_at, speeds FROM game_city_snapshots
      WHERE clan_id = ? AND player_id = ? AND speeds IS NOT NULL ORDER BY game_date`,
  ).all(clanId, playerId) as Array<{ game_date: string; captured_at: string; speeds: string }>;
  const out: Array<{ gameDate: string; capturedAt: string; speeds: CitySpeeds }> = [];
  for (const r of rows) {
    try {
      out.push({ gameDate: r.game_date, capturedAt: r.captured_at, speeds: JSON.parse(r.speeds) as CitySpeeds });
    } catch { /* a damaged row is skipped */ }
  }
  return out;
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

/**
 * A player's Gold Ingots per game day (game_player_daily, v110: the day's
 * latest reading), oldest first, plus the newest reading. Ingots tick up every
 * few minutes, so the day's last value is what a history needs.
 */
export function getPlayerGoldIngotsDaily(clanId: number, playerId: number, sinceGameDate = ''): {
  current: number | null;
  readAt: string | null;
  points: Array<{ gameDate: string; goldIngots: number }>;
} {
  const db = getDb();
  const points = db.prepare(
    `SELECT game_date AS gameDate, gold_ingots AS goldIngots FROM game_player_daily
      WHERE clan_id = ? AND player_id = ? AND gold_ingots IS NOT NULL AND game_date >= ?
      ORDER BY game_date`,
  ).all(clanId, playerId, sinceGameDate) as Array<{ gameDate: string; goldIngots: number }>;
  const now = db.prepare('SELECT gold_ingots AS v, last_seen AS at FROM game_players WHERE clan_id = ? AND player_id = ?')
    .get(clanId, playerId) as { v: number | null; at: string } | undefined;
  return { current: now?.v ?? null, readAt: now?.at ?? null, points };
}

/** A player's captains as last read, highest level first (the game's own order). The hero's entry is left out. */
export function getPlayerCaptains(clanId: number, playerId: number): PlayerCaptain[] {
  return getDb().prepare(
    `SELECT captain_id AS captainId, level, stars, xp, slot, first_seen AS firstSeen, last_seen AS lastSeen
       FROM game_player_captains WHERE clan_id = ? AND player_id = ? AND captain_id <> ?
      ORDER BY level DESC, stars DESC, captain_id`,
  ).all(clanId, playerId, HERO_ENTRY_ID) as PlayerCaptain[];
}

/**
 * The hero as city field 9 lists it (entry id 1: level and XP on the Heroes
 * table's own curve), or null until a city read since Nov 2026 stored it.
 */
export function getPlayerHeroEntry(clanId: number, playerId: number): PlayerCaptain | null {
  return (getDb().prepare(
    `SELECT captain_id AS captainId, level, stars, xp, slot, first_seen AS firstSeen, last_seen AS lastSeen
       FROM game_player_captains WHERE clan_id = ? AND player_id = ? AND captain_id = ?`,
  ).get(clanId, playerId, HERO_ENTRY_ID) as PlayerCaptain | undefined) ?? null;
}

export interface HeroLevelChange {
  level: number;
  prevLevel: number;
  changedAt: string;
}

/**
 * The hero's level-ups since `sinceIso`, newest first, from the player record
 * history (game_player_history.hero_level: the hero has no captain history
 * rows). The first reading is a starting point, never a change.
 */
export function getPlayerHeroLevelChanges(clanId: number, playerId: number, sinceIso: string, limit = 50): HeroLevelChange[] {
  return getDb().prepare(
    `WITH h AS (
       SELECT hero_level AS level, captured_at AS changedAt,
              LAG(hero_level) OVER (ORDER BY captured_at) AS prevLevel
         FROM game_player_history
        WHERE clan_id = ? AND player_id = ? AND hero_level IS NOT NULL
     )
     SELECT level, prevLevel, changedAt FROM h
      WHERE prevLevel IS NOT NULL AND level <> prevLevel AND changedAt >= ?
      ORDER BY changedAt DESC LIMIT ?`,
  ).all(clanId, playerId, sinceIso, limit) as HeroLevelChange[];
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
  /** The previous read's values; null when it is the artifact's first row. */
  prevLevel: number | null;
  prevStar: number | null;
  /** The rolls changed (rerolled) since the previous read. */
  rerolled: boolean;
  /**
   * The line-up move this row records (v118): 'in' — first seen after the
   * player's baseline, or back after leaving; 'out' — it left the line-up;
   * null — it stayed (level / stars / rolls moved). Only line-up captains'
   * artifacts are visible, so a first sighting is never "a new artifact".
   */
  lineup: 'in' | 'out' | null;
  changedAt: string;
}

/**
 * Artifact changes since `sinceIso`, newest first: level / star level / roll
 * moves and line-up moves. The first read's baseline is left out, as for
 * captains.
 */
export function getPlayerArtifactChanges(clanId: number, playerId: number, sinceIso: string, limit = 100): ArtifactChange[] {
  const rows = getDb().prepare(
    `WITH h AS (
       SELECT artifact_type, level, star, bonuses, in_lineup, changed_at,
              LAG(level) OVER w AS prev_level, LAG(star) OVER w AS prev_star, LAG(bonuses) OVER w AS prev_bonuses,
              LAG(in_lineup) OVER w AS prev_in_lineup
         FROM game_player_artifact_history
        WHERE clan_id = ? AND player_id = ?
       WINDOW w AS (PARTITION BY artifact_type ORDER BY changed_at)
     )
     SELECT artifact_type AS artifactType, level, star, prev_level AS prevLevel, prev_star AS prevStar,
            (prev_bonuses IS NOT NULL AND prev_bonuses <> bonuses) AS rerolled,
            in_lineup AS inLineup, prev_in_lineup AS prevInLineup, changed_at AS changedAt
       FROM h
      WHERE changed_at >= ?
        AND changed_at > (SELECT MIN(changed_at) FROM game_player_artifact_history WHERE clan_id = ? AND player_id = ?)
        -- An archive replay can leave a row equal to the one before it (the
        -- live read, replayed past): not a change.
        AND NOT (prev_level IS level AND prev_star IS star AND prev_bonuses IS bonuses AND prev_in_lineup IS in_lineup)
      ORDER BY changed_at DESC, level DESC, artifact_type LIMIT ?`,
  ).all(clanId, playerId, sinceIso, clanId, playerId, limit) as Array<
    Omit<ArtifactChange, 'rerolled' | 'lineup'> & { rerolled: number; inLineup: number; prevInLineup: number | null }>;
  return rows.map(({ inLineup, prevInLineup, ...r }) => ({
    ...r,
    rerolled: r.rerolled === 1,
    lineup: inLineup === 0 ? 'out' : prevInLineup === null || prevInLineup === 0 ? 'in' : null,
  }));
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

/** A title grant a player holds as stored (v125), with how often they received the title in all. */
export interface PlayerTitle {
  titleId: number;
  /** When the player received it (unix s, the game's own). */
  assignedAt: number;
  eventId: number | null;
  firstSeen: string;
  lastSeen: string;
  /** 402 field 20; null when no count was read. */
  times: number | null;
}

/**
 * The titles a player held at their latest read (gone_at unset). Whether a
 * title has run out since is the caller's call (titles.ts titleViews): its
 * duration is static data.
 */
export function getPlayerTitles(clanId: number, playerId: number): PlayerTitle[] {
  return getDb().prepare(
    `SELECT t.title_id AS titleId, t.assigned_at AS assignedAt, t.event_id AS eventId,
            t.first_seen AS firstSeen, t.last_seen AS lastSeen, c.times AS times
       FROM game_player_titles t
       LEFT JOIN game_player_title_counts c
         ON c.clan_id = t.clan_id AND c.player_id = t.player_id AND c.title_id = t.title_id
      WHERE t.clan_id = ? AND t.player_id = ? AND t.gone_at IS NULL
      ORDER BY t.assigned_at DESC, t.title_id`,
  ).all(clanId, playerId) as PlayerTitle[];
}
