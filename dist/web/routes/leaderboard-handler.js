"use strict";
// Shared leaderboard query logic. Used by both the authenticated
// /api/leaderboard and the public-share /api/public/:token/leaderboard
// route — keeping the query/filter/re-rank semantics in one place so
// the two endpoints can never disagree about what the leaderboard
// looks like for a given window.
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseLeaderboardQuery = parseLeaderboardQuery;
exports.queryLeaderboard = queryLeaderboard;
exports.resolveWeeklyGoalPoints = resolveWeeklyGoalPoints;
const chest_repo_js_1 = require("../../data/repositories/chest-repo.js");
const might_repo_js_1 = require("../../data/repositories/might-repo.js");
function isValidIso(s) {
    return !!s && !Number.isNaN(new Date(s).getTime());
}
/**
 * Parse the standard leaderboard query params out of a Request:
 *  - includeAll=1|true  → return one row per active member (otherwise
 *    only those with chests, capped at 25)
 *  - from=ISO, to=ISO   → half-open [from, to) UTC window
 *
 * Anything else is ignored. Invalid ISO strings fall back to the
 * unfiltered view so a typo in a shared link still loads.
 */
function parseLeaderboardQuery(req) {
    const includeAllMembers = req.query.includeAll === '1' || req.query.includeAll === 'true';
    const fromParam = typeof req.query.from === 'string' ? req.query.from : undefined;
    const toParam = typeof req.query.to === 'string' ? req.query.to : undefined;
    return {
        from: isValidIso(fromParam) ? fromParam : undefined,
        to: isValidIso(toParam) ? toParam : undefined,
        includeAllMembers,
    };
}
/**
 * Run the leaderboard query for `clanId` with the parsed params.
 * Always includes all active members (zero-point members appear at the
 * bottom) and re-ranks 1..N so displayed ranks are gap-free.
 *
 * Each row is then decorated with the member's latest might + hero level. That
 * happens HERE rather than inside getLeaderboard() on purpose: the chest query is
 * about chests, its result is cached under a chest-shaped key, and might data
 * changes on a completely different schedule (once a day, from the OCR snapshot).
 * Joining them in SQL would tie one cache's lifetime to the other's and put a
 * might read on the Discord digest and CSV export paths that never asked for it.
 *
 * getLatestMightByMember returns a SHARED, cached Map — never mutate it here.
 * Rows are rebuilt rather than assigned into, because getLeaderboard's own array
 * is cached too and writing to those objects would poison every later reader.
 */
function queryLeaderboard(clanId, params) {
    const { from, to } = params;
    const rows = (0, chest_repo_js_1.getLeaderboard)(clanId, from, to, {
        includeAllMembers: true,
    });
    const might = (0, might_repo_js_1.getLatestMightByMember)(clanId);
    if (might.size === 0)
        return rows;
    return rows.map((row) => {
        const hit = might.get(row.memberId);
        return {
            ...row,
            might: hit ? hit.might : null,
            heroLevel: hit ? hit.heroLevel : null,
        };
    });
}
/**
 * The clan's WEEKLY points goal, or null when there isn't one.
 *
 * A goal exists only when the admin both switched the colouring on and left a
 * positive number in the field — the two are stored separately so toggling the
 * feature off for a week doesn't discard the target, and a blank number with the
 * flag on is "not configured yet", not "goal of zero" (which would paint the
 * whole board green).
 *
 * Every other timeframe is derived from this one number on the client, by
 * scaleGoalForPeriod() in lib/leaderboard-render.js — shared by the authenticated
 * page and the public share page so the two can't disagree about what a daily
 * goal is.
 */
function resolveWeeklyGoalPoints(clan) {
    if (!clan || !clan.leaderboardGoalEnabled)
        return null;
    const n = clan.leaderboardWeeklyGoalPoints;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}
//# sourceMappingURL=leaderboard-handler.js.map