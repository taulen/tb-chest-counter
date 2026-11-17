"use strict";
/**
 * The browser timezone for the login bridge's game client, derived from the
 * game's own day.
 *
 * Everything that matters in Total Battle — the reset, event windows, the chest
 * week — runs on its fixed global boundary of 17:00 UTC
 * (`gameDayRolloverUtcHour`). A zone whose local midnight IS that reset is a
 * principled default for a game client, and it costs one line. Fixed-offset
 * `Etc/GMT±N` rather than a city, because those are DST-free by definition — a
 * city zone moves its midnight twice a year.
 *
 * Guarded by tests/config/game-timezone.test.ts, which runs as part of
 * `npm run build`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.gameDayUtcOffsetHours = gameDayUtcOffsetHours;
exports.gameDayTimezoneId = gameDayTimezoneId;
/**
 * UTC offset (in hours) of a zone whose local midnight falls at
 * `rolloverUtcHour`:00 UTC.
 *
 * Local midnight happens at `(24 - offset) mod 24` UTC, so any offset with
 * `offset ≡ -rolloverUtcHour (mod 24)` works. Two representations satisfy that —
 * `-rolloverUtcHour` and `24 - rolloverUtcHour` — and only one of them lands
 * inside the ±14h range real zones cover, so pick by which half of the day the
 * rollover is in. The default (17) gives +7; midnight (0) gives UTC.
 */
function gameDayUtcOffsetHours(rolloverUtcHour) {
    const hour = ((Math.trunc(rolloverUtcHour) % 24) + 24) % 24;
    return hour <= 12 ? -hour : 24 - hour;
}
/**
 * IANA zone id to launch the login bridge browser with, given the configured rollover.
 *
 * `Etc/GMT±N` inverts the sign of the offset it names — a POSIX inheritance —
 * so `Etc/GMT-7` is UTC+7. Getting this backwards would put the boundary 14
 * hours out, which is why the test asserts the resolved midnight rather than the
 * string.
 */
function gameDayTimezoneId(rolloverUtcHour) {
    const offset = gameDayUtcOffsetHours(rolloverUtcHour);
    if (offset === 0)
        return 'UTC';
    return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}
//# sourceMappingURL=game-timezone.js.map