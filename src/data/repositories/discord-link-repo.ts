/**
 * Which clan member a Discord account belongs to.
 *
 * Exists so /me needs telling who you are exactly once. Rival tools rate their
 * private self-lookup as the single most-praised thing they ship, and the
 * reason is mundane: it stops officers being asked "how many do I need" fifteen
 * times a week by people who could have looked.
 *
 * Keyed by (clan_id, discord_user_id) rather than by the Discord id alone. One
 * bot token can serve several clans, findClanByChannel already resolves which
 * clan a command came from, and the same person can legitimately be a different
 * member in two of them.
 */

import { getDb } from '../database.js';

/** The member this Discord user is linked to in this clan, or null. */
export function getLinkedMemberId(clanId: number, discordUserId: string): number | null {
  const row = getDb().prepare(
    'SELECT member_id FROM discord_member_links WHERE clan_id = ? AND discord_user_id = ?',
  ).get(clanId, discordUserId) as { member_id: number } | undefined;
  return row ? row.member_id : null;
}

/**
 * Remember (or re-point) the link.
 *
 * Upsert rather than insert-if-absent: naming a different player is how
 * somebody corrects a link they got wrong, and refusing the second one would
 * leave them stuck with no way to fix it from Discord.
 */
export function linkDiscordUser(
  clanId: number,
  discordUserId: string,
  memberId: number,
): void {
  getDb().prepare(`
    INSERT INTO discord_member_links (clan_id, discord_user_id, member_id, linked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(clan_id, discord_user_id)
    DO UPDATE SET member_id = excluded.member_id, linked_at = excluded.linked_at
  `).run(clanId, discordUserId, memberId, new Date().toISOString());
}
