/**
 * The rows the clan's joins & leaves are built from (data/roster-changes.ts),
 * all already kept by other features: the members (first_seen, left_at, the
 * game link), the game's players (joined_at, in_clan) and the audit rows the
 * member sync and the admins write (member.left_clan, restore_member). Every
 * read is clan-scoped; a clan is a few hundred rows of each.
 */
import { getDb } from '../database.js';
import { loadPlayerNameCanonicaliser } from './merge-repo.js';
import { exactMatchMember } from '../../utils/fuzzy.js';
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

  // A player no member is linked to is an alt an admin's merge rule folds into
  // a main (the member sync counts it there and never links it) — or a
  // newcomer whose name a linked member already owns, which stays on its own.
  const canonical = loadPlayerNameCanonicaliser(clanId);
  const players: RosterPlayer[] = (db.prepare(
    'SELECT player_id, name, joined_at, in_clan FROM game_players WHERE clan_id = ? ORDER BY player_id',
  ).all(clanId) as Array<{ player_id: number; name: string; joined_at: number | null; in_clan: number }>).map((p) => {
    const linked = byPlayer.get(p.player_id);
    let memberId = linked ?? null;
    if (memberId === null) {
      const ruled = canonical(p.name);
      if (ruled !== p.name) memberId = exactMatchMember(ruled, members)?.id ?? null;
    }
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
