/**
 * Bring our members in line with what the game says, keyed on the game's
 * permanent player id (members.game_player_id, v103).
 *
 * For every member of the clan record (name first run through the clan's
 * player merge rules, like every OCR read path):
 *   1. already linked → that member;
 *   2. else link an unlinked member whose name matches exactly (accent- and
 *      space-insensitive, aliases included — exactMatchMember);
 *   3. else link an unlinked ACTIVE member that fuzzy-matches (OCR damage) AND
 *      whose latest might is within ±15 % of the game's — the might check is
 *      what makes a fuzzy link safe enough to do automatically;
 *   4. else create the member under its exact game name and link it.
 * Then: the member takes the game's exact name (old name kept as an alias,
 * rename audited), is marked seen, gets the day's might/hero snapshot, and
 * members linked to players no longer in the clan record are marked as left.
 *
 * The snapshot replaces the OCR might capture: that phase skips a game day that
 * already has a snapshot. markMembersSeen + snapshots also keep the inactivity
 * sweeps working (they key on both).
 */
import { getDb } from '../data/database.js';
import {
  addAlias,
  getAllMembers,
  markMembersSeen,
  removeMember,
  renameMember,
  upsertMember,
} from '../data/repositories/member-repo.js';
import { loadPlayerNameCanonicaliser } from '../data/repositories/merge-repo.js';
import { saveSnapshots } from '../data/repositories/might-repo.js';
import { logSystemAction } from '../data/repositories/user-repo.js';
import { exactMatchMember, fuzzyMatchMember } from '../utils/fuzzy.js';
import { childLogger } from '../utils/logger.js';
import type { ClanMember } from '../models/types.js';
import type { ClanMember as GameClanMember, PlayerRecord } from './messages.js';

const log = childLogger('member-sync');

const MIGHT_TOLERANCE = 0.15;
/** The scan's placeholder for unreadable senders; never a clan member to retire. */
const UNKNOWN_MEMBER_NAME = '[Unknown]';
/** Never treat a member list this short as the whole clan (a bad read must not retire everyone). */
const MIN_ROSTER_FOR_DEPARTURES = 5;

export interface MemberSyncResult {
  linked: number;
  newlyLinked: number;
  created: number;
  renamed: number;
  departed: number;
  /** Players an admin merge rule folds into a member another player owns (alts). */
  mergedByRule: number;
  /** game player id → our member id, for every current clan member. */
  memberIds: Map<number, number>;
}

function linkedMembers(clanId: number): Map<number, number> {
  return new Map(
    (getDb().prepare('SELECT game_player_id, id FROM members WHERE clan_id = ? AND game_player_id IS NOT NULL').all(clanId) as
      Array<{ game_player_id: number; id: number }>).map((r) => [r.game_player_id, r.id]),
  );
}

function latestMight(clanId: number): Map<number, number> {
  return new Map(
    (getDb().prepare(
      `SELECT s.member_id, s.power FROM member_snapshots s
        JOIN (SELECT member_id, MAX(captured_at) AS at FROM member_snapshots WHERE clan_id = ? GROUP BY member_id) l
          ON l.member_id = s.member_id AND l.at = s.captured_at
       WHERE s.clan_id = ? AND s.power > 0`,
    ).all(clanId, clanId) as Array<{ member_id: number; power: number }>).map((r) => [r.member_id, r.power]),
  );
}

function link(clanId: number, memberId: number, playerId: number): boolean {
  try {
    getDb().prepare('UPDATE members SET game_player_id = ? WHERE id = ? AND clan_id = ? AND game_player_id IS NULL').run(playerId, memberId, clanId);
    return true;
  } catch (err) {
    log.warn({ noAlert: true }, `Clan #${clanId}: could not link member ${memberId} to game player ${playerId}: ${String(err)}`);
    return false;
  }
}

export function syncMembersFromGame(
  clanId: number,
  roster: GameClanMember[],
  players: PlayerRecord[],
  gameDate: string,
  now = new Date().toISOString(),
): MemberSyncResult {
  const byPlayer = new Map(players.map((p) => [p.playerId, p]));
  const linked = linkedMembers(clanId);
  const linkedIds = new Set(linked.values());
  const all = [...getAllMembers(true, clanId), ...getAllMembers(false, clanId).filter((m) => !m.isActive)];
  const unlinked = (): ClanMember[] => all.filter((m) => !linkedIds.has(m.id));
  const might = latestMight(clanId);
  const result: MemberSyncResult = { linked: 0, newlyLinked: 0, created: 0, renamed: 0, departed: 0, mergedByRule: 0, memberIds: new Map() };
  /** Players whose member is linked to them — the only ones that may rename, re-role or snapshot it. */
  const owned = new Set<number>();

  // A player merge rule is the admin saying "this name IS that member" — it
  // decides the match, exactly as on every OCR read path.
  const canonical = loadPlayerNameCanonicaliser(clanId);

  for (const rm of roster) {
    const p = byPlayer.get(rm.playerId);
    if (!p) continue;
    let memberId = linked.get(rm.playerId);
    if (memberId === undefined) {
      const name = canonical(p.name);
      const candidates = unlinked();
      let match = exactMatchMember(name, candidates);
      if (!match) {
        const fuzzy = fuzzyMatchMember(name, candidates.filter((m) => m.isActive));
        const known = fuzzy ? might.get(fuzzy.id) : undefined;
        if (fuzzy && known && p.might && Math.abs(known - p.might) / p.might <= MIGHT_TOLERANCE) match = fuzzy;
      }
      if (!match && name !== p.name) {
        // The rule points at a member another player already owns: an alt the
        // admin merged into a main. Count the alt as seen there, but never link,
        // rename, re-role or snapshot that member from the alt's record.
        const owner = exactMatchMember(name, all);
        if (owner) {
          result.memberIds.set(rm.playerId, owner.id);
          result.mergedByRule++;
          continue;
        }
      }
      if (match) {
        if (link(clanId, match.id, rm.playerId)) {
          memberId = match.id;
          result.newlyLinked++;
        }
      } else {
        const created = upsertMember(name, clanId);
        if (!linkedIds.has(created.id) && link(clanId, created.id, rm.playerId)) {
          memberId = created.id;
          // upsertMember also finds members by alias and despaced name (and
          // reactivates them) — only a row that did not exist is "created".
          if (all.some((m) => m.id === created.id)) {
            result.newlyLinked++;
          } else {
            result.created++;
            all.push(created);
          }
        } else {
          // The name (or an alias of it) belongs to a member linked to someone
          // else — e.g. a newcomer took a renamed player's old name.
          log.info(`Clan #${clanId}: game player ${rm.playerId} "${p.name}" matches a member owned by another player; left unlinked`);
        }
      }
      if (memberId !== undefined) {
        linked.set(rm.playerId, memberId);
        linkedIds.add(memberId);
      }
    }
    if (memberId === undefined) continue;
    result.memberIds.set(rm.playerId, memberId);
    owned.add(rm.playerId);

    // The game's spelling is authoritative: rename, keep the old name as an alias.
    const member = all.find((m) => m.id === memberId);
    if (member && member.name !== p.name) {
      try {
        renameMember(memberId, p.name, clanId);
        addAlias(memberId, member.name, clanId);
        logSystemAction(clanId, 'rename_member', { id: memberId, from: member.name, newName: p.name, source: 'game' });
        member.name = p.name;
        result.renamed++;
      } catch (err) {
        log.warn({ noAlert: true }, `Clan #${clanId}: kept "${member.name}" — renaming to the game's "${p.name}" collided: ${String(err)}`);
      }
    }
    getDb().prepare('UPDATE members SET clan_role = ? WHERE id = ? AND clan_id = ?').run(String(rm.role), memberId, clanId);
  }

  const ids = [...new Set(result.memberIds.values())];
  result.linked = owned.size;
  if (ids.length) markMembersSeen(clanId, ids, now);
  saveSnapshots(
    clanId,
    gameDate,
    now,
    roster
      .map((rm) => ({ rm, p: byPlayer.get(rm.playerId), id: result.memberIds.get(rm.playerId) }))
      .filter((x) => x.p && x.id !== undefined && x.p.might && owned.has(x.rm.playerId))
      .map((x) => ({ memberId: x.id as number, might: x.p!.might as number, level: x.p!.heroLevel ?? null })),
  );

  // Departures. The game's roster is the whole clan, so every active member it
  // does not account for is removed (soft delete: is_active = 0, left_at set,
  // history kept, restorable): a linked player who left, and an unlinked row —
  // a name OCR read off a gift from someone who has since gone, or an old
  // spelling. Rejoining reactivates the same member through the link.
  if (roster.length >= MIN_ROSTER_FOR_DEPARTURES) {
    const present = new Set(result.memberIds.values());
    for (const m of all) {
      if (!m.isActive || present.has(m.id) || m.name === UNKNOWN_MEMBER_NAME) continue;
      removeMember(m.id, clanId);
      const wasLinked = linkedIds.has(m.id);
      logSystemAction(clanId, 'member.left_clan', { id: m.id, name: m.name, source: 'game', linked: wasLinked });
      m.isActive = false;
      result.departed++;
    }
  }
  return result;
}

/**
 * Resolve the member a game player's activity belongs to — a gift's sender or a
 * ledger entry's player — including players no longer in the clan. Built once
 * per run (after syncMembersFromGame) so lookups are cheap.
 *
 * Never reactivates or renames anyone, so a gift from someone who left cannot
 * undo the departure the sync just recorded:
 *   1. current roster → the synced member;
 *   2. a member already linked to the player id → that member;
 *   3. the member with that exact name (after merge rules) → that member, and
 *      linked to the player when it has no link yet;
 *   4. else a new member under the game name, linked, and marked left when the
 *      player is not in the clan.
 * Returns null only for a player with no id link and no name.
 */
export function makeMemberResolver(
  clanId: number,
  rosterMembers: Map<number, number>,
): (playerId: number, name: string) => number | null {
  const canonical = loadPlayerNameCanonicaliser(clanId);
  const cache = new Map<number, number | null>(rosterMembers);
  const db = getDb();
  let all: ClanMember[] | null = null;
  type Status = { is_active: number; left_at: string | null; last_seen: string };
  let prior: Map<number, Status> | null = null;

  return (playerId, name) => {
    if (playerId > 0 && cache.has(playerId)) return cache.get(playerId) ?? null;
    let id: number | null = null;
    const linkedRow = playerId > 0
      ? db.prepare('SELECT id FROM members WHERE clan_id = ? AND game_player_id = ?').get(clanId, playerId) as { id: number } | undefined
      : undefined;
    if (linkedRow) {
      id = linkedRow.id;
    } else if (name) {
      const target = canonical(name);
      all ??= getAllMembers(false, clanId);
      const match = exactMatchMember(target, all);
      if (match) {
        if (playerId > 0) link(clanId, match.id, playerId);
        id = match.id;
      } else {
        prior ??= new Map((db.prepare('SELECT id, is_active, left_at, last_seen FROM members WHERE clan_id = ?')
          .all(clanId) as Array<Status & { id: number }>).map((r) => [r.id, r]));
        const found = upsertMember(target, clanId);
        const before = prior.get(found.id);
        if (before) {
          // upsertMember found an existing member (alias / despaced name) and
          // stamped it seen + active; a player outside the clan must not.
          db.prepare('UPDATE members SET is_active = ?, left_at = ?, last_seen = ? WHERE id = ?')
            .run(before.is_active, before.left_at, before.last_seen, found.id);
          if (playerId > 0) link(clanId, found.id, playerId);
        } else {
          if (playerId > 0) link(clanId, found.id, playerId);
          removeMember(found.id, clanId);
          prior.set(found.id, { is_active: 0, left_at: null, last_seen: found.lastSeen });
          all.push({ ...found, isActive: false });
        }
        id = found.id;
      }
    }
    if (playerId > 0) cache.set(playerId, id);
    return id;
  };
}
