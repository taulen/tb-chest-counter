"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clanIntervalMs = clanIntervalMs;
exports.dueAt = dueAt;
exports.joinEarlyMs = joinEarlyMs;
exports.dueClanIds = dueClanIds;
exports.soonestDue = soonestDue;
/** A clan's interval: its own when it has one, else the global one. */
function clanIntervalMs(clanMinutes, globalMs) {
    return clanMinutes !== null && clanMinutes > 0 ? clanMinutes * 60_000 : globalMs;
}
function dueAt(clan, now) {
    return clan.lastScanAt === null ? now : clan.lastScanAt + clan.intervalMs;
}
/**
 * How early a clan may join a cycle that starts for another clan: up to a
 * minute, never more than a tenth of its own interval. Saves a second cycle
 * (and a second game login on a shared account) seconds after the first.
 */
function joinEarlyMs(intervalMs) {
    return Math.min(60_000, Math.floor(intervalMs / 10));
}
/** The clans a scheduled cycle starting now scans, in the order given. */
function dueClanIds(clans, now) {
    return clans.filter((c) => dueAt(c, now) <= now + joinEarlyMs(c.intervalMs)).map((c) => c.id);
}
/** When the next scheduled cycle should start; null when there are no clans. */
function soonestDue(clans, now) {
    let soonest = null;
    for (const c of clans) {
        const at = dueAt(c, now);
        if (soonest === null || at < soonest)
            soonest = at;
    }
    return soonest;
}
//# sourceMappingURL=scan-due.js.map