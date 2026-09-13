"use strict";
/**
 * Server-side game-day math.
 *
 * The game's day boundary is not midnight UTC — it's the configured rollover
 * hour (17:00 UTC by default), so "game day N" runs [N 17:00 UTC, N+1 17:00
 * UTC). The frontend has owned this math since the leaderboard shipped
 * (web/public/lib/period.js, `gameDayKeyFor`); server code needed it only in
 * SQL form until now, via the `-N hours` date modifier used by the analytics
 * queries.
 *
 * The daily might snapshot needs the date as a *value* — it's the natural key
 * on member_snapshots — so this is the JS counterpart. Keep it identical to
 * gameDayKeyFor(): subtract the rollover hours, then read off the UTC date.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.gameDateFor = gameDateFor;
exports.currentGameDate = currentGameDate;
exports.daysBetweenGameDates = daysBetweenGameDates;
exports.gameWindow = gameWindow;
exports.gameWeekWindow = gameWeekWindow;
/**
 * The game day (YYYY-MM-DD) that an epoch-ms instant falls in.
 *
 * Deliberately takes `rolloverUtcHour` rather than reading the config itself,
 * so it stays a pure function that tests can drive across a boundary without
 * touching global config.
 */
function gameDateFor(ms, rolloverUtcHour) {
    const shifted = new Date(ms - rolloverUtcHour * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 10);
}
/** Today's game day as YYYY-MM-DD. */
function currentGameDate(rolloverUtcHour) {
    return gameDateFor(Date.now(), rolloverUtcHour);
}
/**
 * Whole days from one game date to another, or null if either isn't a date.
 *
 * Both arguments are game days as produced by gameDateFor, i.e. already
 * rollover-shifted, so plain UTC-midnight arithmetic is exact here — no DST and no
 * partial days to round. Negative when `to` is the earlier of the two.
 */
function daysBetweenGameDates(from, to) {
    const a = Date.parse(`${from}T00:00:00Z`);
    const b = Date.parse(`${to}T00:00:00Z`);
    if (Number.isNaN(a) || Number.isNaN(b))
        return null;
    return Math.round((b - a) / 86_400_000);
}
/**
 * The half-open [from, to) instants of a game-period slot, as ISO strings.
 *
 * `offset` 0 is the period in progress, 1 the one before it, and so on. Weeks
 * start on Sunday at the rollover hour. This mirrors computeGameWindow() in
 * web/public/lib/period.js branch for branch, and
 * tests/config/game-window-parity.test.ts asserts the two agree so a change to
 * one that isn't made to the other fails the build.
 *
 * The server needed this because three different definitions of "a week" had
 * grown up: lib/period.js for the site, chesttracker-client.ts for the import,
 * and `now - 604800000` in the Discord bot — which meant the bot's weekly
 * leaderboard was a rolling 168 hours and simply a different board from the one
 * the same command linked people to.
 *
 * Takes `rolloverUtcHour` rather than reading config, so it stays pure.
 * Returns null for 'all', which has no bounds.
 */
function gameWindow(period, offset, rolloverUtcHour) {
    if (period === 'all')
        return null;
    const rolloverMs = rolloverUtcHour * 60 * 60 * 1000;
    // Shift into "game time" so a plain UTC-midnight truncation lands on the
    // rollover, then shift back once the slot's edges are known.
    const shifted = new Date(Date.now() - rolloverMs);
    shifted.setUTCHours(0, 0, 0, 0);
    const back = (startMs, endMs) => ({
        from: new Date(startMs + rolloverMs).toISOString(),
        to: new Date(endMs + rolloverMs).toISOString(),
    });
    if (period === 'daily') {
        shifted.setUTCDate(shifted.getUTCDate() - offset);
        const startMs = shifted.getTime();
        return back(startMs, startMs + 24 * 60 * 60 * 1000);
    }
    if (period === 'weekly') {
        shifted.setUTCDate(shifted.getUTCDate() - shifted.getUTCDay() - offset * 7);
        const startMs = shifted.getTime();
        return back(startMs, startMs + 7 * 24 * 60 * 60 * 1000);
    }
    if (period === 'monthly') {
        const year = shifted.getUTCFullYear();
        const month = shifted.getUTCMonth() - offset;
        return back(Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1));
    }
    if (period === 'yearly') {
        const year = shifted.getUTCFullYear() - offset;
        return back(Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1));
    }
    return null;
}
/**
 * A game WEEK slot. Thin wrapper over gameWindow for the callers that only ever
 * want weeks (the member profile's this-week-vs-last box).
 */
function gameWeekWindow(offset, rolloverUtcHour) {
    return gameWindow('weekly', offset, rolloverUtcHour);
}
//# sourceMappingURL=game-day.js.map