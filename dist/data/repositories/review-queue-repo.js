"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidateReviewQueueCount = invalidateReviewQueueCount;
exports.getReviewQueue = getReviewQueue;
exports.getReviewQueueCount = getReviewQueueCount;
/**
 * Admin → Review: what still needs a person.
 *
 * Until Nov 2026 the queue also listed new chest names, new chest sources and
 * new members for an admin to skim and "acknowledge" — the screenshot (OCR)
 * scanner could misread a name into a new chest, source or member. The scan
 * now reads the game itself: names come from the game's own static data and
 * members from the clan roster, so those lists were noise and are gone (user,
 * Nov 17 2026: "no need to acknowledge new members etc"). The
 * review_acknowledgments rows stay, unread.
 *
 * What remains: triumphal (Bank) chests the clan has received that have no
 * package value yet — they score 0 until a superadmin sets one on the
 * Triumphal Chest Points page, which also clears them from this list.
 */
const database_js_1 = require("../database.js");
const ttl_cache_js_1 = require("../../utils/ttl-cache.js");
// The nav-status badge only needs the count. It is polled on every navigation,
// so it is memoized per clan for ~60 s; scan-complete and reassignment
// invalidate it.
const REVIEW_QUEUE_COUNT_TTL_MS = 60000;
/** Drop the cached review-queue count so the next nav-status read recomputes. */
function invalidateReviewQueueCount(clanId) {
    (0, ttl_cache_js_1.invalidate)(clanId === undefined ? 'reviewQueueCount:' : `reviewQueueCount:${clanId}`);
}
function getReviewQueue(clanId) {
    const rows = (0, database_js_1.getDb)()
        .prepare(`SELECT ch.name AS value, g.firstSeen AS firstSeen, g.cnt
       FROM (
         SELECT chest_id, MIN(captured_at) AS firstSeen, COUNT(*) AS cnt
         FROM triumphal_chest_records
         WHERE clan_id = ?
         GROUP BY chest_id
       ) g
       JOIN chests ch ON ch.id = g.chest_id
       WHERE ch.name != ''
         AND ch.name NOT IN (SELECT chest_name FROM triumphal_chest_points)
       ORDER BY g.firstSeen DESC`)
        .all(clanId);
    return {
        triumphalChests: {
            entries: rows.map((r) => ({ value: r.value, firstSeen: new Date(r.firstSeen).toISOString(), count: r.cnt })),
        },
    };
}
/** Count-only variant of {@link getReviewQueue} for the nav-status badge. */
function getReviewQueueCount(clanId) {
    return (0, ttl_cache_js_1.cached)(`reviewQueueCount:${clanId}`, REVIEW_QUEUE_COUNT_TTL_MS, () => {
        const row = (0, database_js_1.getDb)()
            .prepare(`SELECT COUNT(DISTINCT ch.name) AS cnt
         FROM triumphal_chest_records t
         JOIN chests ch ON ch.id = t.chest_id
         WHERE t.clan_id = ?
           AND ch.name != ''
           AND ch.name NOT IN (SELECT chest_name FROM triumphal_chest_points)`)
            .get(clanId);
        return { triumphalChests: row.cnt };
    });
}
//# sourceMappingURL=review-queue-repo.js.map