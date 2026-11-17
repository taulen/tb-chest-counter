/**
 * Every linked member's troop tiers (G/S/E/M and crypt level), computed from
 * their research as the game reports it (game_player_techs) and the game's
 * research trees. Replaces the levels clans used to post by hand; see
 * game-protocol/troop-tiers.ts for the rules and how they were checked.
 *
 * Synchronous: uses the trees already loaded or cached on disk
 * (cachedTechTrees); the scan loop keeps them current. Null tiers until the
 * trees exist on this install.
 */
import { getDb } from './database.js';
import { cached } from '../utils/ttl-cache.js';
import { cachedTechTrees } from '../game-protocol/tech-trees.js';
import { troopTiers, unlockIndex, type TroopFamily, type TroopTiers } from '../game-protocol/troop-tiers.js';

const CACHE_TTL_MS = 60_000;

let built: { version: string; index: Record<TroopFamily, Map<number, number>>; ids: number[] } | null = null;

function index(): typeof built {
  const trees = cachedTechTrees();
  if (!trees) return null;
  if (built?.version !== trees.version) {
    const idx = unlockIndex(trees);
    built = { version: trees.version, index: idx, ids: [...new Set(Object.values(idx).flatMap((m) => [...m.keys()]))] };
  }
  return built;
}

export interface MemberTiers {
  tiers: TroopTiers;
  /** When the member's research was last read (ISO). */
  readAt: string;
}

/** memberId → tiers, for every member linked to a game player whose research has been read. */
export function getMemberTiers(clanId: number): Map<number, MemberTiers> {
  return cached(`member-tiers:${clanId}`, CACHE_TTL_MS, () => {
    const out = new Map<number, MemberTiers>();
    const ix = index();
    if (!ix || !ix.ids.length) return out;
    const db = getDb();
    const rows = db.prepare(`
      SELECT m.id AS memberId, t.tech_id AS techId, t.level, t.last_seen AS seen
        FROM members m
        JOIN game_player_techs t ON t.clan_id = m.clan_id AND t.player_id = m.game_player_id
       WHERE m.clan_id = ? AND t.tech_id IN (${ix.ids.map(() => '?').join(',')})
    `).all(clanId, ...ix.ids) as Array<{ memberId: number; techId: number; level: number; seen: string }>;
    // Members whose research was read at all (any tech), for "read but has no unlocks yet".
    const readRows = db.prepare(`
      SELECT m.id AS memberId, MAX(t.last_seen) AS seen
        FROM members m JOIN game_player_techs t ON t.clan_id = m.clan_id AND t.player_id = m.game_player_id
       WHERE m.clan_id = ? GROUP BY m.id
    `).all(clanId) as Array<{ memberId: number; seen: string }>;
    const levels = new Map<number, Record<string, number>>();
    for (const r of rows) {
      const l = levels.get(r.memberId) ?? {};
      l[r.techId] = r.level;
      levels.set(r.memberId, l);
    }
    for (const r of readRows) {
      // An empty map would read as "not read"; a placeholder key keeps crypts at I.
      const l = levels.get(r.memberId) ?? { 0: 0 };
      out.set(r.memberId, { tiers: troopTiers(l, ix.index), readAt: r.seen });
    }
    return out;
  });
}
