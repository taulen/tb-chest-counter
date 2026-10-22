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
exports.ANCIENTS_CYCLE_DAYS = exports.ANCIENTS_TINMAN_ANCHOR = exports.WEEK_STARTS = void 0;
exports.gameDateFor = gameDateFor;
exports.currentGameDate = currentGameDate;
exports.daysBetweenGameDates = daysBetweenGameDates;
exports.isWeekStart = isWeekStart;
exports.weekLengthDays = weekLengthDays;
exports.gameWindow = gameWindow;
exports.gameWeekWindow = gameWeekWindow;
exports.isTinmanDay = isTinmanDay;
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
exports.WEEK_STARTS = ['sunday', 'ancients'];
/**
 * A known Tinman game day. Every Tinman day is this date plus a multiple of
 * ANCIENTS_CYCLE_DAYS — read off the tbclanportal feed (Rise of the Ancients,
 * 2026-10-23 17:00 UTC). event-calendar.ts re-checks the cadence against the
 * feed on every fetch and warns if the game ever moves it. Mirrored in
 * web/public/lib/period.js; tests/config/game-window-parity.test.ts asserts
 * the two agree.
 */
exports.ANCIENTS_TINMAN_ANCHOR = '2026-10-23';
exports.ANCIENTS_CYCLE_DAYS = 6;
function isWeekStart(v) {
    return typeof v === 'string' && exports.WEEK_STARTS.includes(v);
}
/** Length of one game week, in game days. */
function weekLengthDays(weekStart) {
    return weekStart === 'ancients' ? exports.ANCIENTS_CYCLE_DAYS : 7;
}
/**
 * Days to step back from a game day (as a UTC-midnight Date in shifted time)
 * to the first day of the week holding it.
 */
function daysIntoWeek(day, weekStart) {
    if (weekStart === 'ancients') {
        const since = Math.round((day.getTime() - Date.parse(`${exports.ANCIENTS_TINMAN_ANCHOR}T00:00:00Z`)) / 86_400_000);
        return ((since % exports.ANCIENTS_CYCLE_DAYS) + exports.ANCIENTS_CYCLE_DAYS) % exports.ANCIENTS_CYCLE_DAYS;
    }
    return day.getUTCDay();
}
/**
 * The half-open [from, to) instants of a game-period slot, as ISO strings.
 *
 * `offset` 0 is the period in progress, 1 the one before it, and so on. Weeks
 * follow `weekStart` (Sunday at the rollover unless the clan counts Tinman to
 * Tinman). This mirrors computeGameWindow() in
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
function gameWindow(period, offset, rolloverUtcHour, weekStart = 'sunday') {
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
        const len = weekLengthDays(weekStart);
        shifted.setUTCDate(shifted.getUTCDate() - daysIntoWeek(shifted, weekStart) - offset * len);
        const startMs = shifted.getTime();
        return back(startMs, startMs + len * 24 * 60 * 60 * 1000);
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
function gameWeekWindow(offset, rolloverUtcHour, weekStart = 'sunday') {
    return gameWindow('weekly', offset, rolloverUtcHour, weekStart);
}
/**
 * True when `gameDay` (YYYY-MM-DD) is a Tinman day on the ANCIENTS_TINMAN_ANCHOR
 * cadence. event-calendar.ts uses it to notice the game moving Ancients.
 */
function isTinmanDay(gameDay) {
    const d = daysBetweenGameDates(exports.ANCIENTS_TINMAN_ANCHOR, gameDay);
    return d !== null && d % exports.ANCIENTS_CYCLE_DAYS === 0;
}
//# sourceMappingURL=game-day.js.map