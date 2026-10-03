"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidateGoldPassCache = invalidateGoldPassCache;
exports.triumphalCycle = triumphalCycle;
exports.goldPassForWindow = goldPassForWindow;
exports.goldPassForCycle = goldPassForCycle;
exports.getGoldPassStatuses = getGoldPassStatuses;
/**
 * Who holds a Gold Pass — the paid track of the Triumphal event.
 *
 * Nothing in the game says so directly, but a pass leaves two traces we already
 * record, and a member is counted as a holder for a Triumphal cycle when BOTH
 * appear in it:
 *
 *  - Union Chests from "Union of Triumph personal reward" — the same chests,
 *    counted the same way, as the Events → Triumphal tab (getEventBreakdown over
 *    the cycle window), so the two pages can never disagree about who got one.
 *  - An exact 250,000 Scientific Tractates line in the clan history. Opening a
 *    pass-reward Union Chest donates exactly that, on the day the chest arrives
 *    — taulen, Fosida and Joone line up day for day.
 *
 * Either on its own is not enough. Union Chests are also sold in the store, and
 * a 250k line without a chest is most likely a chest the scan has not claimed
 * yet. On the 2026-09-28 backup the pair separated cleanly: in clan 1's
 * 2026-07-24 cycle 49 members had both, 2 a chest only and none a line only.
 *
 * A clan that does not capture resources at all cannot show the 250k line, so
 * there the chest alone counts — and says so (`basis: 'union-only'`).
 *
 * Windows follow the catalog's Triumphal cycle (rolling 30 days on the 17:00 UTC
 * reset). Resource rows carry a game DAY rather than an instant, so the 250k
 * line is matched on the cycle's first through last game day inclusive.
 */
const database_js_1 = require("../database.js");
const ttl_cache_js_1 = require("../../utils/ttl-cache.js");
const event_catalog_js_1 = require("../../config/event-catalog.js");
const guards_ladder_js_1 = require("../../config/guards-ladder.js");
const game_day_js_1 = require("../../utils/game-day.js");
const event_repo_js_1 = require("./event-repo.js");
const DAY_MS = 86_400_000;
const CACHE_PREFIX = 'goldpass:';
/** The cycle in progress changes with every scan; a closed one barely does. */
const CURRENT_TTL_MS = 60_000;
const CLOSED_TTL_MS = 10 * 60_000;
/** How far back a clan must have resource rows for the 250k check to apply. */
const RESOURCE_COVERAGE_LOOKBACK_DAYS = 7;
const TRIUMPHAL_EVENT_KEY = 'triumphal';
function invalidateGoldPassCache(clanId) {
    (0, ttl_cache_js_1.invalidate)(clanId === undefined ? CACHE_PREFIX : `${CACHE_PREFIX}${clanId}:`);
}
/** The Triumphal cycle `offset` cycles before the one holding `nowMs` (0 = current). */
function triumphalCycle(nowMs, rolloverUtcHour, offset = 0) {
    const cycle = (0, event_catalog_js_1.getEventDef)(TRIUMPHAL_EVENT_KEY)?.cycle;
    if (!cycle)
        return null;
    const anchorMs = Date.parse(cycle.anchor);
    const lenMs = cycle.days * DAY_MS;
    if (!Number.isFinite(anchorMs) || lenMs <= 0)
        return null;
    const index = Math.floor((nowMs - anchorMs) / lenMs) - offset;
    const fromMs = anchorMs + index * lenMs;
    const toMs = fromMs + lenMs;
    return {
        index,
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        firstDay: (0, game_day_js_1.gameDateFor)(fromMs, rolloverUtcHour),
        lastDay: (0, game_day_js_1.gameDateFor)(toMs - 1, rolloverUtcHour),
    };
}
function passDonationsByMember(clanId, firstDay, lastDay) {
    const rows = (0, database_js_1.getDb)().prepare(`
    SELECT rt.member_id AS memberId, COUNT(*) AS n
    FROM resource_transactions rt
    JOIN resource_types t ON t.id = rt.resource_type_id
    WHERE rt.clan_id = ? AND rt.direction = 1 AND t.slug = ? AND rt.amount = ?
      AND rt.transaction_date >= ? AND rt.transaction_date <= ?
    GROUP BY rt.member_id
  `).all(clanId, guards_ladder_js_1.TRACTATE_RESOURCE_SLUG, guards_ladder_js_1.GOLD_PASS_TRACTATE_AMOUNT, firstDay, lastDay);
    return new Map(rows.map((r) => [r.memberId, r.n]));
}
function hasResourceCoverage(clanId, firstDay) {
    const from = new Date(Date.parse(`${firstDay}T00:00:00Z`) - RESOURCE_COVERAGE_LOOKBACK_DAYS * DAY_MS)
        .toISOString().slice(0, 10);
    const hit = (0, database_js_1.getDb)().prepare('SELECT 1 AS ok FROM resource_transactions WHERE clan_id = ? AND transaction_date >= ? LIMIT 1').get(clanId, from);
    return hit !== undefined;
}
/**
 * Gold-pass status for every member over an arbitrary window — the Events page
 * passes the occurrence it is showing. Returns a SHARED cached object.
 */
function goldPassForWindow(clanId, fromIso, toIso, rolloverUtcHour, ttlMs = CURRENT_TTL_MS) {
    return (0, ttl_cache_js_1.cached)(`${CACHE_PREFIX}${clanId}:${fromIso}:${toIso}`, ttlMs, () => {
        const fromMs = Date.parse(fromIso);
        const toMs = Date.parse(toIso);
        const firstDay = (0, game_day_js_1.gameDateFor)(fromMs, rolloverUtcHour);
        const lastDay = (0, game_day_js_1.gameDateFor)(toMs - 1, rolloverUtcHour);
        const union = new Map();
        const breakdown = (0, event_repo_js_1.getEventBreakdown)(TRIUMPHAL_EVENT_KEY, clanId, fromIso, toIso);
        for (const p of breakdown?.players ?? []) {
            if (p.memberId !== null && p.totalChests > 0)
                union.set(p.memberId, p.totalChests);
        }
        const donations = passDonationsByMember(clanId, firstDay, lastDay);
        const basis = hasResourceCoverage(clanId, firstDay) ? 'union+tractates' : 'union-only';
        const members = new Map();
        let holders = 0;
        for (const id of new Set([...union.keys(), ...donations.keys()])) {
            const unionChests = union.get(id) ?? 0;
            const passDonations = donations.get(id) ?? 0;
            const goldPass = unionChests > 0 && (basis === 'union-only' || passDonations > 0);
            if (goldPass)
                holders++;
            members.set(id, { unionChests, passDonations, goldPass });
        }
        return { members, basis, holders };
    });
}
/** Gold-pass status for one whole Triumphal cycle. */
function goldPassForCycle(clanId, cycle, nowMs, rolloverUtcHour) {
    const closed = Date.parse(cycle.to) <= nowMs;
    return goldPassForWindow(clanId, cycle.from, cycle.to, rolloverUtcHour, closed ? CLOSED_TTL_MS : CURRENT_TTL_MS);
}
/**
 * memberId → 'current' for a holder in the cycle running now, 'previous' for one
 * who held it last cycle and has not shown up in this one yet. Members with
 * neither are absent.
 */
function getGoldPassStatuses(clanId, nowMs, rolloverUtcHour) {
    const out = new Map();
    const current = triumphalCycle(nowMs, rolloverUtcHour, 0);
    const previous = triumphalCycle(nowMs, rolloverUtcHour, 1);
    if (!current || !previous)
        return out;
    for (const [id, e] of goldPassForCycle(clanId, previous, nowMs, rolloverUtcHour).members) {
        if (e.goldPass)
            out.set(id, 'previous');
    }
    for (const [id, e] of goldPassForCycle(clanId, current, nowMs, rolloverUtcHour).members) {
        if (e.goldPass)
            out.set(id, 'current');
    }
    return out;
}
//# sourceMappingURL=gold-pass-repo.js.map