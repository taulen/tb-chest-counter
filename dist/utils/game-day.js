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
exports.TINMAN_CADENCES = exports.SK_CYCLE_DAYS = exports.SK_TINMAN_ANCHOR = exports.ANCIENTS_CYCLE_DAYS = exports.ANCIENTS_TINMAN_ANCHOR = exports.SUNDAY_ANCHOR = exports.CUSTOM_WEEK_MAX_DAYS = exports.CUSTOM_WEEK_MIN_DAYS = exports.WEEK_PRESETS = void 0;
exports.gameDateFor = gameDateFor;
exports.currentGameDate = currentGameDate;
exports.daysBetweenGameDates = daysBetweenGameDates;
exports.parseCustomWeek = parseCustomWeek;
exports.customWeekStart = customWeekStart;
exports.isWeekStart = isWeekStart;
exports.isTinmanWeek = isTinmanWeek;
exports.weekCadence = weekCadence;
exports.weekLengthDays = weekLengthDays;
exports.canonicalWeekStart = canonicalWeekStart;
exports.gameWindow = gameWindow;
exports.gameWeekWindow = gameWeekWindow;
exports.closedWeekAt = closedWeekAt;
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
exports.WEEK_PRESETS = ['sunday', 'ancients', 'ancients-sk'];
/** Bounds on a custom week's length, in game days. Mirrored in lib/week-shape.js. */
exports.CUSTOM_WEEK_MIN_DAYS = 2;
exports.CUSTOM_WEEK_MAX_DAYS = 28;
/** A Sunday: the 'sunday' shape is the cadence of 7 days from here. */
exports.SUNDAY_ANCHOR = '1970-01-04';
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
/**
 * The same for a Seasonal Kingdom, read off its own feed (feed.ics?realm=season):
 * SK 2026 had Tinman on 2026-11-17 and every 5 days after it, to the season's
 * end on 2027-02-08. Its first Tinman (Nov 13) came 4 days before that, so the
 * season's first few days sit in a week that opens a day early; every week from
 * Nov 17 on is exact. The anchor is therefore the FIRST Tinman of the cadence,
 * not just any one: the cadence check ignores days before it. A NEW SEASON
 * brings its own dates: event-calendar.ts checks the SK feed's upcoming Tinman
 * days against this pair and warns when they stop fitting, and the fix is
 * moving both constants here and in lib/period.js.
 */
exports.SK_TINMAN_ANCHOR = '2026-11-17';
exports.SK_CYCLE_DAYS = 5;
/** Each Tinman week shape's anchor day and length. */
exports.TINMAN_CADENCES = {
    ancients: { anchor: exports.ANCIENTS_TINMAN_ANCHOR, days: exports.ANCIENTS_CYCLE_DAYS },
    'ancients-sk': { anchor: exports.SK_TINMAN_ANCHOR, days: exports.SK_CYCLE_DAYS },
};
/**
 * A custom week's first day and length, or null when `v` isn't a well-formed
 * one: a real calendar date, and a whole length within bounds written without a
 * leading zero (so one week has exactly one spelling).
 */
function parseCustomWeek(v) {
    if (typeof v !== 'string')
        return null;
    const m = /^custom:(\d{4}-\d{2}-\d{2}):([1-9]\d?)$/.exec(v);
    if (!m)
        return null;
    const days = Number(m[2]);
    if (days < exports.CUSTOM_WEEK_MIN_DAYS || days > exports.CUSTOM_WEEK_MAX_DAYS)
        return null;
    const ms = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== m[1])
        return null;
    return { anchor: m[1], days };
}
/** The custom week of `days` days, one of which starts on game day `anchor`. */
function customWeekStart(anchor, days) {
    return `custom:${anchor}:${days}`;
}
function isWeekStart(v) {
    return (typeof v === 'string' && exports.WEEK_PRESETS.includes(v)) || parseCustomWeek(v) !== null;
}
/** True for either Tinman-to-Tinman shape. */
function isTinmanWeek(weekStart) {
    return weekStart === 'ancients' || weekStart === 'ancients-sk';
}
/**
 * Every week shape is one cadence: a game day some week starts on, and the
 * week's length. The presets are fixed cadences; a custom week carries its own.
 */
function weekCadence(weekStart) {
    if (isTinmanWeek(weekStart))
        return exports.TINMAN_CADENCES[weekStart];
    return parseCustomWeek(weekStart) ?? { anchor: exports.SUNDAY_ANCHOR, days: 7 };
}
/** Length of one game week, in game days. */
function weekLengthDays(weekStart) {
    return weekCadence(weekStart).days;
}
/**
 * The preset a custom week is identical to, or the custom week unchanged: 7
 * days from any Sunday IS the Sunday week, and 6 days from a Tinman day is the
 * Tinman week (5 from an SK Tinman day, for a Seasonal Kingdom clan). Saving
 * through this keeps one spelling per week, so the Clans page shows the preset
 * and the Discord digest still calls a Tinman week one.
 */
function canonicalWeekStart(weekStart, seasonalKingdom) {
    const custom = parseCustomWeek(weekStart);
    if (!custom)
        return weekStart;
    const presets = ['sunday', seasonalKingdom ? 'ancients-sk' : 'ancients'];
    for (const preset of presets) {
        const { anchor, days } = weekCadence(preset);
        const since = daysBetweenGameDates(anchor, custom.anchor);
        if (days === custom.days && since !== null && ((since % days) + days) % days === 0)
            return preset;
    }
    return weekStart;
}
/**
 * Days to step back from a game day (as a UTC-midnight Date in shifted time)
 * to the first day of the week holding it.
 */
function daysIntoWeek(day, weekStart) {
    const { anchor, days } = weekCadence(weekStart);
    const since = Math.round((day.getTime() - Date.parse(`${anchor}T00:00:00Z`)) / 86_400_000);
    return ((since % days) + days) % days;
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
 * `nowMs` is the instant "the period in progress" is measured from — the clock
 * unless a caller is resolving a period relative to some other moment (the
 * Discord weekly digest, which reports the week a given rollover closed).
 * Returns null for 'all', which has no bounds.
 */
function gameWindow(period, offset, rolloverUtcHour, weekStart = 'sunday', nowMs = Date.now()) {
    if (period === 'all')
        return null;
    const rolloverMs = rolloverUtcHour * 60 * 60 * 1000;
    // Shift into "game time" so a plain UTC-midnight truncation lands on the
    // rollover, then shift back once the slot's edges are known.
    const shifted = new Date(nowMs - rolloverMs);
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
 * The game week that ended at the rollover instant `rolloverMs`, or null when
 * that rollover doesn't end one (it opens an ordinary day mid-week).
 *
 * A rollover ends a week exactly when the game day it opens is the first day
 * of a week, which follows `weekStart`: every Sunday for 'sunday', every Tinman
 * day for 'ancients'. `firstDay` / `lastDay` are the week's first and last game
 * days (YYYY-MM-DD); `firstDay` is also what the site's `?week=` anchor uses.
 */
function closedWeekAt(rolloverMs, rolloverUtcHour, weekStart) {
    const opening = gameWindow('weekly', 0, rolloverUtcHour, weekStart, rolloverMs);
    if (!opening || Date.parse(opening.from) !== rolloverMs)
        return null;
    const closed = gameWindow('weekly', 1, rolloverUtcHour, weekStart, rolloverMs);
    return {
        ...closed,
        firstDay: gameDateFor(Date.parse(closed.from), rolloverUtcHour),
        lastDay: gameDateFor(Date.parse(closed.to) - 1, rolloverUtcHour),
    };
}
/**
 * True when `gameDay` (YYYY-MM-DD) is a Tinman day on a Tinman week's cadence —
 * the normal kingdom's by default. event-calendar.ts uses it to notice the game
 * moving Ancients.
 */
function isTinmanDay(gameDay, cadence = 'ancients') {
    const { anchor, days } = exports.TINMAN_CADENCES[cadence];
    const d = daysBetweenGameDates(anchor, gameDay);
    return d !== null && ((d % days) + days) % days === 0;
}
//# sourceMappingURL=game-day.js.map