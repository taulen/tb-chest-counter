import { getDb } from '../database.js';
import { invalidate } from '../../utils/ttl-cache.js';
import { despace } from '../../vision/ocr-normalize.js';
import type { ClanMember } from '../../models/types.js';

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Find a member by the despaced key when `normalized_name` didn't match.
 *
 * `normalized_name` keeps single spaces, so it treats every OCR spacing variant of
 * one player as a different person: a member written letter-by-letter in game
 * ("J I Z Z I C A") gained a fresh row for "JIZZICA", another for "JI ZZICA", and
 * another for "JIZZI C A", each one a separate leaderboard entry the admin had to
 * merge by hand. `despaced_name` (v66) is the same name with spacing and punctuation
 * removed, so all of those resolve to the row that already exists.
 *
 * Ordered rather than `LIMIT 1` on whatever SQLite hands back, because on a database
 * that already accumulated variants there is more than one candidate until the admin
 * merges them: prefer an active row over a soft-removed one, then the oldest id — the
 * original the duplicates split off from.
 *
 * Runs only as a fallback. An exact `normalized_name` hit still wins, so nothing that
 * matched before can change target.
 */
function findByDespacedKey(
  db: ReturnType<typeof getDb>,
  clanId: number,
  key: string,
): Record<string, unknown> | undefined {
  if (!key) return undefined;
  return db.prepare(
    `SELECT * FROM members WHERE clan_id = ? AND despaced_name = ?
     ORDER BY is_active DESC, id ASC LIMIT 1`,
  ).get(clanId, key) as Record<string, unknown> | undefined;
}

/**
 * Drop the nav-badge caches that depend on the member set. A member rename
 * can move a row in or out of the blank/[Unknown]/inactive sentinel set
 * (changing the unknown-chest count), and create/remove/restore changes the
 * review-queue member list. We invalidate by key prefix directly rather than
 * importing the chest-repo / review-queue-repo invalidators to avoid an
 * import cycle (those repos already import this module's siblings).
 */
function invalidateMemberDerivedCaches(clanId: number): void {
  invalidate(`reviewQueueCount:${clanId}`);
  invalidate(`unknownChestsCount:${clanId}`);
}

function rowToMember(row: Record<string, unknown>): ClanMember {
  return {
    id: row.id as number,
    name: row.name as string,
    normalizedName: row.normalized_name as string,
    aliases: JSON.parse((row.aliases as string) || '[]'),
    firstSeen: row.first_seen as string,
    lastSeen: row.last_seen as string,
    isActive: !!(row.is_active as number),
  };
}

export function upsertMember(name: string, clanId: number): ClanMember {
  const db = getDb();
  const normalized = normalizeName(name);
  const despaced = despace(name);
  const now = new Date().toISOString();

  const existing = (db.prepare(
    'SELECT * FROM members WHERE clan_id = ? AND normalized_name = ?',
  ).get(clanId, normalized) as Record<string, unknown> | undefined)
    ?? findByDespacedKey(db, clanId, despaced);

  if (existing) {
    // Seeing this name again auto-reactivates a previously removed
    // member so a returning player resumes their original identity
    // (and all their historical chest records) rather than landing
    // in a fresh row that the leaderboard treats as a new person.
    // left_at is cleared on the way back in, so the column always means
    // "gone, since" rather than "was gone once".
    db.prepare('UPDATE members SET last_seen = ?, is_active = 1, left_at = NULL WHERE id = ?').run(now, existing.id);
    return rowToMember({ ...existing, last_seen: now, is_active: 1 });
  }

  // Check aliases within this clan only.
  const allMembers = db.prepare(
    'SELECT * FROM members WHERE clan_id = ?',
  ).all(clanId) as Record<string, unknown>[];
  for (const member of allMembers) {
    const aliases: string[] = JSON.parse((member.aliases as string) || '[]');
    if (aliases.some((a) => normalizeName(a) === normalized)) {
      db.prepare('UPDATE members SET last_seen = ?, is_active = 1, left_at = NULL WHERE id = ?').run(now, member.id);
      return rowToMember({ ...member, last_seen: now, is_active: 1 });
    }
  }

  const result = db.prepare(
    `INSERT INTO members (clan_id, name, normalized_name, despaced_name, aliases, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(clanId, name.trim(), normalized, despaced, '[]', now, now);

  return {
    id: result.lastInsertRowid as number,
    name: name.trim(),
    normalizedName: normalized,
    aliases: [],
    firstSeen: now,
    lastSeen: now,
    isActive: true,
  };
}

/**
 * Record that these members were sighted, by id.
 *
 * The batch, id-addressed counterpart to what `upsertMember` does when it
 * recognises a name: refresh `last_seen` and flip `is_active` back on. Needed
 * because a sighting doesn't always arrive as an exact name — the might capture
 * resolves an OCR'd name to a member through the fuzzy matcher, and feeding that
 * read back through `upsertMember` would create a near-duplicate member instead of
 * updating the one it matched.
 *
 * Why a member-list sighting counts at all: the inactivity sweep soft-removes
 * anyone not seen for their clan's threshold, and until now "seen" meant "appeared
 * in a chest or gift scan". A player can easily go a week without earning a chest
 * while plainly still being in the clan — the in-game member list says so, and that
 * list is the authoritative roster. So reading a name off it is a sighting, and
 * without this the sweep kept removing members the game still lists.
 *
 * Reactivation matches `upsertMember`'s long-standing behaviour deliberately: a
 * member who shows up again resumes their original identity (and chest history)
 * rather than being stranded as inactive.
 *
 * Returns how many rows were touched and how many of those were reactivated, so a
 * caller can report the interesting half without querying again.
 */
export function markMembersSeen(
  clanId: number,
  memberIds: number[],
  seenAtIso: string,
): { updated: number; reactivated: number } {
  if (memberIds.length === 0) return { updated: 0, reactivated: 0 };
  const db = getDb();
  const placeholders = memberIds.map(() => '?').join(',');

  const tx = db.transaction(() => {
    // Count the reactivations BEFORE the update, since afterwards they're
    // indistinguishable from members who were already active.
    const { cnt } = db.prepare(
      `SELECT COUNT(*) AS cnt FROM members
       WHERE clan_id = ? AND is_active = 0 AND id IN (${placeholders})`,
    ).get(clanId, ...memberIds) as { cnt: number };

    const res = db.prepare(
      `UPDATE members SET last_seen = ?, is_active = 1, left_at = NULL
       WHERE clan_id = ? AND id IN (${placeholders})`,
    ).run(seenAtIso, clanId, ...memberIds);

    return { updated: res.changes, reactivated: cnt };
  });

  const result = tx();
  // Reactivating moves rows into the active set, which is what the blank/unknown
  // sentinel counts and the review-queue member list key off. Only drop the caches
  // when something actually flipped — this runs daily and would otherwise clear
  // them every time for nothing.
  if (result.reactivated > 0) invalidateMemberDerivedCaches(clanId);
  return result;
}

export function findMemberByName(name: string, clanId: number): ClanMember | null {
  const db = getDb();
  const normalized = normalizeName(name);

  const row = (db.prepare(
    'SELECT * FROM members WHERE clan_id = ? AND normalized_name = ?',
  ).get(clanId, normalized) as Record<string, unknown> | undefined)
    ?? findByDespacedKey(db, clanId, despace(name));

  return row ? rowToMember(row) : null;
}

export function getAllMembers(activeOnly: boolean, clanId: number): ClanMember[] {
  const db = getDb();
  const query = activeOnly
    ? 'SELECT * FROM members WHERE clan_id = ? AND is_active = 1 ORDER BY name'
    : 'SELECT * FROM members WHERE clan_id = ? ORDER BY name';
  const rows = db.prepare(query).all(clanId) as Record<string, unknown>[];
  return rows.map(rowToMember);
}

/**
 * Look up a member by primary key, scoped to the given clan. Returns null
 * for both "id not found" and "id belongs to another clan" — callers can
 * treat the response uniformly without leaking which case occurred.
 */
export function getMemberById(id: number, clanId: number): ClanMember | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM members WHERE id = ? AND clan_id = ?',
  ).get(id, clanId) as Record<string, unknown> | undefined;
  return row ? rowToMember(row) : null;
}

/**
 * Resolve which clan a member id belongs to. Used by routes that take a
 * raw memberId from the URL and need to authorize the caller before
 * loading the member proper. Returns null if the id is unknown.
 */
export function getMemberClanId(id: number): number | null {
  const db = getDb();
  const row = db.prepare('SELECT clan_id FROM members WHERE id = ?').get(id) as { clan_id: number } | undefined;
  return row?.clan_id ?? null;
}

export function addAlias(memberId: number, alias: string, clanId: number): void {
  const db = getDb();
  const row = db.prepare(
    'SELECT aliases FROM members WHERE id = ? AND clan_id = ?',
  ).get(memberId, clanId) as { aliases: string } | undefined;
  if (!row) return;

  const aliases: string[] = JSON.parse(row.aliases || '[]');
  if (!aliases.includes(alias.trim())) {
    aliases.push(alias.trim());
    db.prepare('UPDATE members SET aliases = ? WHERE id = ? AND clan_id = ?').run(JSON.stringify(aliases), memberId, clanId);
  }
}

export function renameMember(id: number, newName: string, clanId: number): void {
  const db = getDb();
  const normalized = normalizeName(newName);
  // despaced_name moves with the rename, or the row keeps answering to its old
  // key and the very next scan that reads the corrected spelling walks straight
  // past it. That would make the one manual fix an admin is asked to do — set the
  // spelling right once — the one thing that doesn't stick.
  db.prepare(
    'UPDATE members SET name = ?, normalized_name = ?, despaced_name = ? WHERE id = ? AND clan_id = ?',
  ).run(newName.trim(), normalized, despace(newName), id, clanId);
  // Post-D4 there is no player_name column on chest_records — every
  // read resolves the display name via JOIN to members, so a rename
  // here propagates to every record that points at this member_id
  // automatically.
  //
  // A rename can also clear (or set) the blank/[Unknown]/inactive sentinel
  // name, which is exactly what the unknown-chest badge and review-queue
  // member list key off of, so drop those nav caches.
  invalidateMemberDerivedCaches(clanId);
}

/**
 * Remove a member from the active matching pool. Always soft-deletes
 * (is_active = 0) — even members with no recorded chests stay as a
 * row so the operator can recover from a misclick via the Admin →
 * "Show removed members" → Restore button. The previous behavior
 * (hard-delete when no history) was a sharp edge: an operator who
 * removed a freshly-captured member couldn't undo it from the UI.
 *
 * Soft-deleted members are excluded from `getAllMembers(true, ...)`,
 * which is what the scan pipeline uses for fuzzy name matching, so
 * a new player with a similar name to a removed one can no longer
 * collapse into the removed member's row.
 *
 * If the same name (or a stored alias) is seen again on a later
 * scan, `upsertMember()` auto-reactivates the row so a returning
 * player keeps their identity.
 */
export function removeMember(id: number, clanId: number): void {
  const db = getDb();
  // Only stamp left_at on an actual 0→1→0 transition. Removing an already
  // removed member (a double-click, a retried request) must not overwrite the
  // date they really went.
  db.prepare(
    'UPDATE members SET is_active = 0, left_at = ? WHERE id = ? AND clan_id = ? AND is_active = 1',
  ).run(new Date().toISOString(), id, clanId);
  invalidateMemberDerivedCaches(clanId);
}

/**
 * Flip a member back to active. Used by the Admin → "Show removed
 * members" → Restore button so an operator can undo a mistaken
 * removal without waiting for the player to be re-scanned.
 */
export function restoreMember(id: number, clanId: number): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE members SET is_active = 1, last_seen = ?, left_at = NULL WHERE id = ? AND clan_id = ?',
  ).run(now, id, clanId);
  invalidateMemberDerivedCaches(clanId);
}

/**
 * Soft-remove every active member of a clan whose last sighting is older
 * than `cutoffIso` (an ISO timestamp). This is the batch form of
 * `removeMember` used by the daily inactivity sweep: it flips
 * `is_active = 0` but leaves the row (and chest history) intact, so the
 * next scan that OCRs the name reactivates it via `upsertMember`.
 *
 * Returns the members that were deactivated (id + name) so the caller can
 * log exactly who was affected. Only touches rows that were still active,
 * so it's idempotent — running it twice in a row deactivates nothing the
 * second time.
 */
export function deactivateStaleMembers(
  clanId: number,
  cutoffIso: string,
): Array<{ id: number; name: string }> {
  const db = getDb();
  const stale = db.prepare(
    'SELECT id, name FROM members WHERE clan_id = ? AND is_active = 1 AND last_seen < ?',
  ).all(clanId, cutoffIso) as Array<{ id: number; name: string }>;
  if (stale.length === 0) return [];
  db.prepare(
    'UPDATE members SET is_active = 0, left_at = ? WHERE clan_id = ? AND is_active = 1 AND last_seen < ?',
  ).run(new Date().toISOString(), clanId, cutoffIso);
  invalidateMemberDerivedCaches(clanId);
  return stale;
}

/**
 * Legacy hard-delete. Kept only for callers that explicitly want to
 * destroy the row (no current callers as of the soft-delete refactor —
 * the public DELETE /api/members/:id route now goes through
 * removeMember()). Will throw on FK conflict if the member has chest
 * history.
 */
export function deleteMember(id: number, clanId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM members WHERE id = ? AND clan_id = ?').run(id, clanId);
}

export function getMemberCount(clanId: number): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM members WHERE clan_id = ? AND is_active = 1',
  ).get(clanId) as { count: number };
  return row.count;
}

/**
 * Path to a screenshot crop that shows where this member came from, or null.
 *
 * Members reach the review queue from three places, so evidence can live in any of
 * three tables. Preference order is tightest-crop first, because the whole point is
 * letting an admin read the name: a might capture keeps a single member-list row
 * (name, coordinates and power on one line — the most direct evidence of clan
 * membership there is), a resource import keeps a single outlined history row, and a
 * chest crop is a whole batch of gift cards. Within a source, the oldest row wins —
 * that's the one that introduced the member.
 *
 * Clan-scoped so an admin in clan A can't read clan B's crops by guessing member ids.
 * The caller must still confine the returned path to an allowed directory before
 * serving it; a stored path is untrusted input.
 */
export function getMemberEvidenceCropPath(memberId: number, clanId: number): string | null {
  const db = getDb();
  const mightRow = db.prepare(
    `SELECT row_crop_path AS p FROM member_snapshots
     WHERE member_id = ? AND clan_id = ? AND row_crop_path IS NOT NULL
     ORDER BY id ASC LIMIT 1`,
  ).get(memberId, clanId) as { p: string } | undefined;
  if (mightRow) return mightRow.p;

  const resourceRow = db.prepare(
    `SELECT row_crop_path AS p FROM resource_transactions
     WHERE member_id = ? AND clan_id = ? AND row_crop_path IS NOT NULL
     ORDER BY id ASC LIMIT 1`,
  ).get(memberId, clanId) as { p: string } | undefined;
  if (resourceRow) return resourceRow.p;

  const chestRow = db.prepare(
    `SELECT debug_crop_path AS p FROM chest_records
     WHERE member_id = ? AND clan_id = ? AND debug_crop_path IS NOT NULL
     ORDER BY captured_at ASC LIMIT 1`,
  ).get(memberId, clanId) as { p: string } | undefined;
  return chestRow?.p ?? null;
}
