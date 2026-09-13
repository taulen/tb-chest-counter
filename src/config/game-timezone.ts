/**
 * The browser timezone for the game client, derived from the game's own day.
 *
 * Total Battle is inconsistent about what "a day" is. Everything that matters —
 * the reset, event windows, the chest week — runs on its fixed global boundary
 * of 17:00 UTC (`gameDayRolloverUtcHour`). The Clan Capital → History list is
 * the exception: its "TODAY / YESTERDAY / N DAYS AGO" headers are a calendar
 * day belonging to the game ACCOUNT (where it was registered), so a clan can
 * change history-day hours away from the reset.
 *
 * Nothing here fixes that, and nothing can. The list exposes a day label and
 * never a time, so a row's hour is unrecoverable and no amount of clock
 * arithmetic can recover which side of the reset it fell on. That was tried —
 * a per-clan account timezone, migration v64 — and removed again in v65: the
 * best it could buy was moving a handful of rows a day between adjacent dates,
 * at the price of a settings field every clan has to be told the right answer
 * for. What the capture guarantees instead is weaker and sufficient: every row
 * lands on exactly one real game day.
 *
 * What this module still does is pick the browser's zone. `America/New_York`
 * was the original pin, arbitrary and paired with `locale: en-US`; a zone whose
 * local midnight IS the game reset is at least a principled default for a game
 * client, and it costs one line. Fixed-offset `Etc/GMT±N` rather than a city,
 * because those are DST-free by definition — a city zone moves its midnight
 * twice a year.
 *
 * Guarded by tests/config/game-timezone.test.ts, which runs as part of
 * `npm run build`.
 */

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
export function gameDayUtcOffsetHours(rolloverUtcHour: number): number {
  const hour = ((Math.trunc(rolloverUtcHour) % 24) + 24) % 24;
  return hour <= 12 ? -hour : 24 - hour;
}

/**
 * IANA zone id to launch the game browser with, given the configured rollover.
 *
 * `Etc/GMT±N` inverts the sign of the offset it names — a POSIX inheritance —
 * so `Etc/GMT-7` is UTC+7. Getting this backwards would put the boundary 14
 * hours out, which is why the test asserts the resolved midnight rather than the
 * string.
 */
export function gameDayTimezoneId(rolloverUtcHour: number): string {
  const offset = gameDayUtcOffsetHours(rolloverUtcHour);
  if (offset === 0) return 'UTC';
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

/**
 * What `Date.prototype.getTimezoneOffset()` should report inside a browser
 * pinned by `gameDayTimezoneId` — minutes BEHIND UTC, so the sign is inverted
 * again. Used by the launcher's post-launch probe: Chromium accepts a timezone
 * override and then fails soft, and a browser that quietly kept UTC would
 * mis-date every resource row with nothing in the logs to say so.
 */
export function expectedBrowserTimezoneOffsetMinutes(rolloverUtcHour: number): number {
  return -gameDayUtcOffsetHours(rolloverUtcHour) * 60;
}

/**
 * A zone's current offset in the same units and sign as
 * `Date.prototype.getTimezoneOffset()` — minutes BEHIND UTC, so UTC+7 is -420.
 *
 * Exists so the launcher can compare what it asked for against what the page
 * reports without comparing zone NAMES, which ICU is free to canonicalise. Read
 * live rather than derived, so a city zone is checked at its real current
 * offset rather than its standard-time one.
 */
export function zoneOffsetMinutesBehindUtc(timeZone: string, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // 'en-US' renders midnight as hour 24 under hour12:false.
  const asIfUtc = Date.UTC(
    at('year'), at('month') - 1, at('day'), at('hour') % 24, at('minute'), at('second'),
  );
  const minutes = Math.round((asIfUtc - now.getTime()) / 60_000);
  // Negating zero yields -0, which compares UNEQUAL to 0 under Object.is while
  // behaving like 0 in arithmetic — so a UTC browser would fail the launcher's
  // equality probe and be reported as "timezone did not take".
  return minutes === 0 ? 0 : -minutes;
}
