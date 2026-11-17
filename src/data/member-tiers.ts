/**
 * Every linked member's troop tiers (G/S/E/M and crypt level), computed from
 * their research as the game reports it (game_player_techs) and the game's
 * research trees. Replaces the levels clans used to post by hand; see
 * game-protocol/troop-tiers.ts for the rules and how they were checked.
 *
 * Also when each tier was reached: game_player_tech_history keeps a row per
 * research change, so walking the unlock techs' rows in time order gives every
 * tier change seen AFTER the member's first read. A tier held at the first
 * read has no date — it was reached at some point before we started looking.
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

const FAMILIES: TroopFamily[] = ['guardsmen', 'specialists', 'engineers', 'monsters', 'crypts'];

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

/** One tier change, as the read that saw it. */
export interface TierChange {
  /** The tier before; null when the family had none. */
  from: number | null;
  to: number;
  /** When the read that first saw the new tier happened (ISO). */
  at: string;
}

export interface MemberTiers {
  tiers: TroopTiers;
  /** When the member's research was last read (ISO). */
  readAt: string;
  /** When it was first read (ISO). A tier held then was reached before it. */
  firstReadAt: string;
  /** Per family, the tier changes seen after the first read, oldest first. */
  changes: Record<TroopFamily, TierChange[]>;
}

function noChanges(): Record<TroopFamily, TierChange[]> {
  return { guardsmen: [], specialists: [], engineers: [], monsters: [], crypts: [] };
}

/** memberId → tiers, for every member linked to a game player whose research has been read. */
export function getMemberTiers(clanId: number): Map<number, MemberTiers> {
  return cached(`member-tiers:${clanId}`, CACHE_TTL_MS, () => {
    const out = new Map<number, MemberTiers>();
    const ix = index();
    if (!ix || !ix.ids.length) return out;
    const db = getDb();
    const idList = ix.ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT m.id AS memberId, t.tech_id AS techId, t.level
        FROM members m
        JOIN game_player_techs t ON t.clan_id = m.clan_id AND t.player_id = m.game_player_id
       WHERE m.clan_id = ? AND t.tech_id IN (${idList})
    `).all(clanId, ...ix.ids) as Array<{ memberId: number; techId: number; level: number }>;
    // Members whose research was read at all (any tech), for "read but has no
    // unlocks yet", with the first and last read.
    const readRows = db.prepare(`
      SELECT m.id AS memberId, MIN(t.first_seen) AS firstRead, MAX(t.last_seen) AS seen
        FROM members m JOIN game_player_techs t ON t.clan_id = m.clan_id AND t.player_id = m.game_player_id
       WHERE m.clan_id = ? GROUP BY m.id
    `).all(clanId) as Array<{ memberId: number; firstRead: string; seen: string }>;
    const history = db.prepare(`
      SELECT m.id AS memberId, h.tech_id AS techId, h.level, h.changed_at AS at
        FROM members m
        JOIN game_player_tech_history h ON h.clan_id = m.clan_id AND h.player_id = m.game_player_id
       WHERE m.clan_id = ? AND h.tech_id IN (${idList})
       ORDER BY m.id, h.changed_at
    `).all(clanId, ...ix.ids) as Array<{ memberId: number; techId: number; level: number; at: string }>;

    const levels = new Map<number, Record<string, number>>();
    for (const r of rows) {
      const l = levels.get(r.memberId) ?? {};
      l[r.techId] = r.level;
      levels.set(r.memberId, l);
    }
    const historyBy = new Map<number, typeof history>();
    for (const h of history) {
      const list = historyBy.get(h.memberId);
      if (list) list.push(h);
      else historyBy.set(h.memberId, [h]);
    }
    for (const r of readRows) {
      // An empty map would read as "not read"; a placeholder key keeps crypts at I.
      const l = levels.get(r.memberId) ?? { 0: 0 };
      out.set(r.memberId, {
        tiers: troopTiers(l, ix.index),
        readAt: r.seen,
        firstReadAt: r.firstRead,
        changes: tierChanges(historyBy.get(r.memberId) ?? [], r.firstRead, ix.index),
      });
    }
    return out;
  });
}

/**
 * Replay one member's unlock-tech history (time order) and keep every tier
 * change after the first read. Rows at or before `firstReadAt` are the
 * baseline: what the member already had when we started looking.
 */
export function tierChanges(
  rows: ReadonlyArray<{ techId: number; level: number; at: string }>,
  firstReadAt: string,
  idx: Record<TroopFamily, Map<number, number>>,
): Record<TroopFamily, TierChange[]> {
  const changes = noChanges();
  const levels: Record<string, number> = { 0: 0 };
  let prev = troopTiers(levels, idx);
  for (let i = 0; i < rows.length;) {
    const at = rows[i].at;
    for (; i < rows.length && rows[i].at === at; i++) levels[rows[i].techId] = rows[i].level;
    const now = troopTiers(levels, idx);
    if (at > firstReadAt) {
      for (const f of FAMILIES) {
        const to = now[f];
        if (to !== null && to !== prev[f]) changes[f].push({ from: prev[f], to, at });
      }
    }
    prev = now;
  }
  return changes;
}
