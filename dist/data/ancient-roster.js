"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECENT_WINDOW_DAYS = exports.MIGHT_ROSTER_MAX_AGE_DAYS = exports.MAX_ROSTER = void 0;
exports.getAncientRoster = getAncientRoster;
/**
 * The roster the Ancient planner (Tools page) prefills from: who is in the clan
 * right now, and each member's estimated guards level.
 *
 * Source, in order of preference:
 *  1. The newest might capture, when it is at most MIGHT_ROSTER_MAX_AGE_DAYS
 *     game days old. It reads the in-game member list, so it is the closest
 *     thing to "the clan as it is today" — and it is capped by the game at 100.
 *  2. Otherwise the members any scan has seen in the last RECENT_WINDOW_DAYS,
 *     most recently seen first, capped at MAX_ROSTER — a clan never holds more,
 *     so anything past 100 is a departure the inactivity sweep hasn't caught.
 *
 * Guards levels are the estimator's (guards-repo), never stored. A member with
 * no usable donation evidence comes back with a null level; the planner decides
 * how to count them.
 */
const might_repo_js_1 = require("./repositories/might-repo.js");
const member_repo_js_1 = require("./repositories/member-repo.js");
const guards_repo_js_1 = require("./repositories/guards-repo.js");
const game_day_js_1 = require("../utils/game-day.js");
/** A clan holds at most 100 members. */
exports.MAX_ROSTER = 100;
/** Older than this, the newest might capture no longer stands for today's clan. */
exports.MIGHT_ROSTER_MAX_AGE_DAYS = 2;
/** Fallback window for "seen recently". */
exports.RECENT_WINDOW_DAYS = 7;
function getAncientRoster(clanId, today, nowMs = Date.now()) {
    const capture = (0, might_repo_js_1.getLatestCaptureRoster)(clanId, exports.MAX_ROSTER);
    const mightAgeDays = capture ? (0, game_day_js_1.daysBetweenGameDates)(capture.gameDate, today) : null;
    const captureFresh = capture !== null && capture.members.length > 0
        && mightAgeDays !== null && mightAgeDays <= exports.MIGHT_ROSTER_MAX_AGE_DAYS;
    let source;
    let picked;
    if (captureFresh) {
        source = 'might';
        picked = capture.members;
    }
    else {
        const since = new Date(nowMs - exports.RECENT_WINDOW_DAYS * 86_400_000).toISOString();
        picked = (0, member_repo_js_1.getRecentlySeenMembers)(clanId, since, exports.MAX_ROSTER);
        source = picked.length > 0 ? 'recent' : 'none';
    }
    const guards = (0, guards_repo_js_1.getGuardsSummaries)(clanId, today);
    const members = picked.map((m) => {
        const g = guards.get(m.memberId);
        return {
            memberId: m.memberId,
            name: m.name,
            guardsLevel: g?.level ?? null,
            guardsStale: g?.stale ?? false,
        };
    });
    return {
        source,
        mightGameDate: capture?.gameDate ?? null,
        mightAgeDays,
        maxAgeDays: exports.MIGHT_ROSTER_MAX_AGE_DAYS,
        windowDays: exports.RECENT_WINDOW_DAYS,
        maxMembers: exports.MAX_ROSTER,
        members,
    };
}
//# sourceMappingURL=ancient-roster.js.map