/**
 * The rows the clan's joins & leaves are built from (data/roster-changes.ts),
 * all already kept by other features: the members (first_seen, left_at, the
 * game link), the game's players (joined_at, in_clan) and the audit rows the
 * member sync and the admins write (member.left_clan, restore_member). Every
 * read is clan-scoped; a clan is a few hundred rows of each.
 */
import { getDb } from '../database.js';
import type { RosterAudit, RosterMember, RosterPlayer, RosterSources } from '../roster-changes.js';

type MemberRow = {
  id: number; name: string; normalized_name: string; aliases: string | null; first_seen: string; last_seen: string;
  is_active: number; left_at: string | null; game_player_id: number | null;
};

function parseAliases(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw || '[]') as unknown;
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export function loadRosterSources(clanId: number): RosterSources {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, name, normalized_name, aliases, first_seen, last_seen, is_active, left_at, game_player_id
       FROM members WHERE clan_id = ? ORDER BY id`,
  ).all(clanId) as MemberRow[];
  const members: RosterMember[] = rows.map((r) => ({
    id: r.id, name: r.name, normalizedName: r.normalized_name, aliases: parseAliases(r.aliases),
    firstSeen: r.first_seen, lastSeen: r.last_seen, isActive: r.is_active === 1, leftAt: r.left_at,
  }));
  const byPlayer = new Map(rows.filter((r) => r.game_player_id !== null).map((r) => [r.game_player_id as number, r.id]));

  // A player no member is linked to is a newcomer whose name a linked member
  // already owns, which stays on its own.
  const players: RosterPlayer[] = (db.prepare(
    'SELECT player_id, name, joined_at, in_clan FROM game_players WHERE clan_id = ? ORDER BY player_id',
  ).all(clanId) as Array<{ player_id: number; name: string; joined_at: number | null; in_clan: number }>).map((p) => {
    const linked = byPlayer.get(p.player_id);
    const memberId = linked ?? null;
    return { playerId: p.player_id, name: p.name, joinedAt: p.joined_at, inClan: p.in_clan === 1, memberId, linked: linked !== undefined };
  });

  // Departures are logged by the sync with the clan; a restore before the
  // audit log carried the clan (Oct 2026) has none, and is matched by name.
  const audit: RosterAudit[] = [];
  for (const r of db.prepare(
    `SELECT created_at AS at, action, details FROM audit_log
      WHERE (action = 'member.left_clan' AND clan_id = ?)
         OR (action = 'restore_member' AND (clan_id = ? OR clan_id IS NULL))
      ORDER BY created_at, id`,
  ).all(clanId, clanId) as Array<{ at: string; action: string; details: string | null }>) {
    try {
      audit.push({ at: r.at, action: r.action, details: r.details ? JSON.parse(r.details) as Record<string, unknown> : {} });
    } catch { /* unreadable details: skipped */ }
  }
  return { members, players, audit };
}

/**
 * The game's first read of the clan's roster (game_players.first_seen): join
 * times exist for everyone in the clan from then on. Null before any.
 */
export function rosterReadSince(clanId: number): string | null {
  const r = getDb().prepare('SELECT MIN(first_seen) AS at FROM game_players WHERE clan_id = ?').get(clanId) as { at: string | null };
  return r.at;
}

/** One in-game rank change: the player's role went from `from` to `to` at `at`. */
export interface RankChange {
  playerId: number;
  memberId: number | null;
  name: string;
  at: string;
  from: number;
  to: number;
  /** Ranks count down (1 Leader … 5 Soldier), so a smaller number is a promotion. */
  promoted: boolean;
}

/**
 * The clan's in-game rank changes since `sinceIso`, newest first: every
 * history row whose role differs from that player's previous recorded role
 * (game_player_history keeps the rank since v-history; the member timeline
 * reads the same change per member). The previous role is looked up per row
 * through the (clan_id, player_id, captured_at) key, so a rank held for months
 * before the window is still the "from".
 */
export function recentRankChanges(clanId: number, sinceIso: string, limit = 20): RankChange[] {
  const rows = getDb().prepare(`
    SELECT h.player_id, h.captured_at, h.name, h.role,
           (SELECT p.role FROM game_player_history p
             WHERE p.clan_id = h.clan_id AND p.player_id = h.player_id
               AND p.captured_at < h.captured_at AND p.role IS NOT NULL
             ORDER BY p.captured_at DESC LIMIT 1) AS prev_role,
           (SELECT m.id FROM members m
             WHERE m.clan_id = h.clan_id AND m.game_player_id = h.player_id
             ORDER BY m.is_active DESC, m.id DESC LIMIT 1) AS member_id
      FROM game_player_history h
     WHERE h.clan_id = ? AND h.captured_at >= ? AND h.role IS NOT NULL
     ORDER BY h.captured_at DESC
  `).all(clanId, sinceIso) as Array<{
    player_id: number; captured_at: string; name: string; role: number; prev_role: number | null; member_id: number | null;
  }>;
  const out: RankChange[] = [];
  for (const r of rows) {
    if (r.prev_role === null || r.prev_role === r.role) continue;
    out.push({
      playerId: r.player_id,
      memberId: r.member_id,
      name: r.name,
      at: r.captured_at,
      from: r.prev_role,
      to: r.role,
      promoted: r.role < r.prev_role,
    });
    if (out.length >= limit) break;
  }
  return out;
}
