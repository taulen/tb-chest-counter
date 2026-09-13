import { getDb } from '../database.js';
import { childLogger } from '../../utils/logger.js';
import { cached, invalidate } from '../../utils/ttl-cache.js';
import { isHardcodedChestName } from '../../vision/chest-names.js';
import { isHardcodedSource } from '../../vision/source-names.js';

const log = childLogger('review-queue-repo');

// The nav-status review badge only needs the three counts, not the full
// entry lists. It is polled on every navigation, so we memoize the
// count-only computation per clan and tolerate ~60s of staleness; explicit
// invalidation on acknowledge / scan-complete / reassignment keeps it fresh.
const REVIEW_QUEUE_COUNT_TTL_MS = 60000;

/** Drop the cached review-queue count so the next nav-status read recomputes. */
export function invalidateReviewQueueCount(clanId?: number): void {
  invalidate(clanId === undefined ? 'reviewQueueCount:' : `reviewQueueCount:${clanId}`);
}

export type ReviewCategory = 'chest_name' | 'chest_source' | 'member';

export interface ReviewEntry {
  value: string;
  firstSeen: string;
  count: number;
  /** Members only: the member row's id, so the UI can link to its evidence crop. */
  memberId?: number;
  /**
   * Members only: true when some row that introduced this member kept a screenshot
   * crop, so an admin can verify a name OCR may have mangled. See
   * memberRepo.getMemberEvidenceCropPath.
   */
  hasCrop?: boolean;
}

export interface ReviewQueue {
  chestNames: { acknowledgedAt: string | null; entries: ReviewEntry[] };
  chestSources: { acknowledgedAt: string | null; entries: ReviewEntry[] };
  members: { acknowledgedAt: string | null; entries: ReviewEntry[] };
  // Triumphal (Bank) chests the clan has scanned that have no configured
  // package value in the global triumphal_chest_points table. Unlike the
  // three above, this category has no acknowledgment cutoff: it's
  // "resolved" by a superadmin assigning the chest a value on the
  // Triumphal Chest Points page (which removes it from this list).
  triumphalChests: { entries: ReviewEntry[] };
}

function getAck(category: ReviewCategory, clanId: number): string | null {
  const db = getDb();
  const row = db
    .prepare('SELECT acknowledged_at FROM review_acknowledgments WHERE clan_id = ? AND category = ?')
    .get(clanId, category) as { acknowledged_at: string } | undefined;
  return row?.acknowledged_at ?? null;
}

export function getReviewQueue(clanId: number): ReviewQueue {
  const db = getDb();

  const chestNameAck = getAck('chest_name', clanId);
  const chestSourceAck = getAck('chest_source', clanId);
  const memberAck = getAck('member', clanId);

  // Post-v30: captured_at is INTEGER ms. The ack column is still ISO
  // TEXT, so when comparing MIN(captured_at) > ack we convert the
  // ack to ms before binding, and convert the resulting MIN(...) value
  // back to ISO before returning to the caller.
  const chestNameAckMs = chestNameAck ? Date.parse(chestNameAck) : null;
  const chestSourceAckMs = chestSourceAck ? Date.parse(chestSourceAck) : null;

  // Group by the FK id (chest_id) on the base table — index-friendly —
  // then join chests for the display name. chests.name is UNIQUE so this
  // is semantically identical to grouping by the joined text column. The
  // inner MIN(captured_at) is the per-chest first-seen; HAVING filters
  // those groups against the ack the same way the old query did.
  const chestNameRows = db
    .prepare(
      `SELECT ch.name AS value, g.firstSeen AS firstSeen, g.cnt
       FROM (
         SELECT chest_id, MIN(captured_at) AS firstSeen, COUNT(*) AS cnt
         FROM chest_records
         WHERE clan_id = ?
         GROUP BY chest_id
         ${chestNameAckMs !== null ? 'HAVING MIN(captured_at) > ?' : ''}
       ) g
       JOIN chests ch ON ch.id = g.chest_id
       WHERE ch.name != ''
       ORDER BY g.firstSeen DESC`,
    )
    .all(...[clanId, ...(chestNameAckMs !== null ? [chestNameAckMs] : [])]) as {
      value: string;
      firstSeen: number;
      cnt: number;
    }[];

  const chestSourceRows = db
    .prepare(
      `SELECT cs.source AS value, g.firstSeen AS firstSeen, g.cnt
       FROM (
         SELECT chest_source_id, MIN(captured_at) AS firstSeen, COUNT(*) AS cnt
         FROM chest_records
         WHERE clan_id = ? AND chest_source_id IS NOT NULL
         GROUP BY chest_source_id
         ${chestSourceAckMs !== null ? 'HAVING MIN(captured_at) > ?' : ''}
       ) g
       JOIN chest_sources cs ON cs.id = g.chest_source_id
       WHERE cs.source != ''
       ORDER BY g.firstSeen DESC`,
    )
    .all(...[clanId, ...(chestSourceAckMs !== null ? [chestSourceAckMs] : [])]) as {
      value: string;
      firstSeen: number;
      cnt: number;
    }[];

  // Member counts via a LEFT JOIN aggregate over chest_records grouped by
  // member_id (uses idx_chest_records_clan_member), instead of a per-row
  // correlated subquery. Two leading clanId binds: the inner aggregate and
  // the outer WHERE.
  // hasCrop: does any row that introduced this member still have its screenshot?
  // Three possible sources — a member-list row from a might capture, an unresolved
  // resource-import row, or a scanned chest row (see getMemberEvidenceCropPath,
  // which resolves the same three in the same order).
  // EXISTS rather than a join so a member with many rows is still one lookup, and
  // only on this full-list path; the count-only variant that backs the nav badge is
  // deliberately left alone.
  const memberRows = db
    .prepare(
      `SELECT m.id AS memberId, m.name AS value, m.first_seen AS firstSeen,
              COALESCE(cc.cnt, 0) AS cnt,
              (EXISTS (SELECT 1 FROM member_snapshots ms
                        WHERE ms.member_id = m.id AND ms.clan_id = m.clan_id
                          AND ms.row_crop_path IS NOT NULL)
               OR EXISTS (SELECT 1 FROM resource_transactions rt
                        WHERE rt.member_id = m.id AND rt.clan_id = m.clan_id
                          AND rt.row_crop_path IS NOT NULL)
               OR EXISTS (SELECT 1 FROM chest_records cr
                        WHERE cr.member_id = m.id AND cr.clan_id = m.clan_id
                          AND cr.debug_crop_path IS NOT NULL)) AS hasCrop
       FROM members m
       LEFT JOIN (
         SELECT member_id, COUNT(*) AS cnt
         FROM chest_records
         WHERE clan_id = ?
         GROUP BY member_id
       ) cc ON cc.member_id = m.id
       WHERE m.clan_id = ?
       ${memberAck ? 'AND m.first_seen > ?' : ''}
       ORDER BY m.first_seen DESC`,
    )
    .all(...[clanId, clanId, ...(memberAck ? [memberAck] : [])]) as {
      memberId: number;
      value: string;
      firstSeen: string;
      cnt: number;
      hasCrop: number;
    }[];

  const mapMs = (rows: { value: string; firstSeen: number; cnt: number }[]): ReviewEntry[] =>
    rows.map((r) => ({
      value: r.value,
      firstSeen: new Date(r.firstSeen).toISOString(),
      count: r.cnt,
    }));
  const mapMembers = (
    rows: { memberId: number; value: string; firstSeen: string; cnt: number; hasCrop: number }[],
  ): ReviewEntry[] =>
    rows.map((r) => ({
      value: r.value,
      firstSeen: r.firstSeen,
      count: r.cnt,
      memberId: r.memberId,
      hasCrop: Boolean(r.hasCrop),
    }));

  // Strip out chest names and sources that are already part of the
  // hardcoded catalog. A new clan whose first scan picks up only
  // known content shouldn't be greeted with a 50-row "needs review"
  // list — reviewing is for things the system doesn't recognize yet.
  const filteredChestNameEntries = mapMs(chestNameRows).filter((e) => !isHardcodedChestName(e.value));
  const filteredChestSourceEntries = mapMs(chestSourceRows).filter((e) => !isHardcodedSource(e.value));

  // New triumphal chests: names in this clan's triumphal_chest_records
  // with no row in the global points table (never dropped at scan time
  // anymore — surfaced here so a superadmin assigns a package value).
  const triumphalRows = db
    .prepare(
      `SELECT ch.name AS value, g.firstSeen AS firstSeen, g.cnt
       FROM (
         SELECT chest_id, MIN(captured_at) AS firstSeen, COUNT(*) AS cnt
         FROM triumphal_chest_records
         WHERE clan_id = ?
         GROUP BY chest_id
       ) g
       JOIN chests ch ON ch.id = g.chest_id
       WHERE ch.name != ''
         AND ch.name NOT IN (SELECT chest_name FROM triumphal_chest_points)
       ORDER BY g.firstSeen DESC`,
    )
    .all(clanId) as { value: string; firstSeen: number; cnt: number }[];

  return {
    chestNames: { acknowledgedAt: chestNameAck, entries: filteredChestNameEntries },
    chestSources: { acknowledgedAt: chestSourceAck, entries: filteredChestSourceEntries },
    members: { acknowledgedAt: memberAck, entries: mapMembers(memberRows) },
    triumphalChests: { entries: mapMs(triumphalRows) },
  };
}

export interface ReviewQueueCount {
  chestNames: number;
  chestSources: number;
  members: number;
  triumphalChests: number;
}

/**
 * Count-only variant of {@link getReviewQueue} for the nav-status badge.
 *
 * Returns the SAME three counts the nav dot derives from getReviewQueue()
 * (entries surviving the ack HAVING filter, the `value != ''` filter, and —
 * for chest names / sources — the isHardcoded* catalog filter), but never
 * materializes/maps/sorts the full entry arrays the way getReviewQueue does.
 * Memoized per clan; the nav badge tolerates short staleness.
 *
 * Result shape is intentionally minimal — callers that need the entry lists
 * must keep using getReviewQueue().
 */
export function getReviewQueueCount(clanId: number): ReviewQueueCount {
  return cached(`reviewQueueCount:${clanId}`, REVIEW_QUEUE_COUNT_TTL_MS, () =>
    computeReviewQueueCount(clanId),
  );
}

function computeReviewQueueCount(clanId: number): ReviewQueueCount {
  const db = getDb();

  const chestNameAck = getAck('chest_name', clanId);
  const chestSourceAck = getAck('chest_source', clanId);
  const memberAck = getAck('member', clanId);

  const chestNameAckMs = chestNameAck ? Date.parse(chestNameAck) : null;
  const chestSourceAckMs = chestSourceAck ? Date.parse(chestSourceAck) : null;

  // Chest names: same aggregate + ack HAVING + `name != ''` filter as
  // getReviewQueue, but we only fetch the name so we can apply the
  // isHardcodedChestName catalog filter in JS and count the survivors.
  const chestNameRows = db
    .prepare(
      `SELECT ch.name AS value
       FROM (
         SELECT chest_id
         FROM chest_records
         WHERE clan_id = ?
         GROUP BY chest_id
         ${chestNameAckMs !== null ? 'HAVING MIN(captured_at) > ?' : ''}
       ) g
       JOIN chests ch ON ch.id = g.chest_id
       WHERE ch.name != ''`,
    )
    .all(...[clanId, ...(chestNameAckMs !== null ? [chestNameAckMs] : [])]) as { value: string }[];

  const chestSourceRows = db
    .prepare(
      `SELECT cs.source AS value
       FROM (
         SELECT chest_source_id
         FROM chest_records
         WHERE clan_id = ? AND chest_source_id IS NOT NULL
         GROUP BY chest_source_id
         ${chestSourceAckMs !== null ? 'HAVING MIN(captured_at) > ?' : ''}
       ) g
       JOIN chest_sources cs ON cs.id = g.chest_source_id
       WHERE cs.source != ''`,
    )
    .all(...[clanId, ...(chestSourceAckMs !== null ? [chestSourceAckMs] : [])]) as { value: string }[];

  // Members: getReviewQueue returns every member row (no hardcoded filter),
  // optionally bounded by the member ack on first_seen. A COUNT(*) is
  // sufficient since there's no per-entry JS filter to apply.
  const memberCountRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM members m
       WHERE m.clan_id = ?
       ${memberAck ? 'AND m.first_seen > ?' : ''}`,
    )
    .get(...[clanId, ...(memberAck ? [memberAck] : [])]) as { cnt: number };

  const triumphalCountRow = db
    .prepare(
      `SELECT COUNT(DISTINCT ch.name) AS cnt
       FROM triumphal_chest_records t
       JOIN chests ch ON ch.id = t.chest_id
       WHERE t.clan_id = ?
         AND ch.name NOT IN (SELECT chest_name FROM triumphal_chest_points)`,
    )
    .get(clanId) as { cnt: number };

  const chestNames = chestNameRows.filter((r) => !isHardcodedChestName(r.value)).length;
  const chestSources = chestSourceRows.filter((r) => !isHardcodedSource(r.value)).length;

  return {
    chestNames,
    chestSources,
    members: memberCountRow.cnt,
    triumphalChests: triumphalCountRow.cnt,
  };
}

export function acknowledge(category: ReviewCategory, clanId: number): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO review_acknowledgments (clan_id, category, acknowledged_at) VALUES (?, ?, ?)
     ON CONFLICT(clan_id, category) DO UPDATE SET acknowledged_at = ?`,
  ).run(clanId, category, now, now);
  // The nav badge count depends on the ack cutoff — drop the cache so it
  // reflects the acknowledgment on the next poll.
  invalidateReviewQueueCount(clanId);
  log.info(`Acknowledged review queue (clan ${clanId}): ${category} at ${now}`);
}
