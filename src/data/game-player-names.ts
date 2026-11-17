import { getDb } from './database.js';

/**
 * Display names for game players of a clan: the linked member's name (what the
 * admins call them) when there is one, else the game's own spelling.
 */
export function gamePlayerNames(clanId: number, playerIds: number[]): Map<number, { name: string; memberId: number | null }> {
  const out = new Map<number, { name: string; memberId: number | null }>();
  if (!playerIds.length) return out;
  const db = getDb();
  const ph = playerIds.map(() => '?').join(',');
  const players = db.prepare(`SELECT player_id, name FROM game_players WHERE clan_id = ? AND player_id IN (${ph})`)
    .all(clanId, ...playerIds) as Array<{ player_id: number; name: string }>;
  const members = db.prepare(`SELECT id, name, game_player_id FROM members WHERE clan_id = ? AND game_player_id IN (${ph})`)
    .all(clanId, ...playerIds) as Array<{ id: number; name: string; game_player_id: number }>;
  for (const id of playerIds) out.set(id, { name: '', memberId: null });
  for (const p of players) out.set(p.player_id, { name: p.name, memberId: null });
  for (const m of members) out.set(m.game_player_id, { name: m.name, memberId: m.id });
  return out;
}
