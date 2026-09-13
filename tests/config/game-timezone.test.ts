/**
 * Pins the game-day browser timezone against the rollover hour it claims to encode.
 *
 * The load-bearing assertion is NOT the string. It's that the zone's local
 * midnight, resolved through the same ICU database Chromium uses, lands on the
 * configured rollover hour. That catches the two ways this breaks: the inverted
 * sign of `Etc/GMT±N` (a POSIX inheritance — `Etc/GMT-7` is UTC+7), and an
 * offset outside the ±14h range real zones cover, which would produce a name
 * `Intl` rejects at launch rather than here.
 *
 * The name also reaches Playwright, which refuses to start the browser on an id
 * it doesn't recognise — so a bad value stops a clan being scanned at all, not
 * merely mis-dates a row.
 *
 * Pure — no browser, no DB — so it runs in `npm run guards` as part of the build.
 */

import { describe, it, expect } from 'vitest';
import {
  gameDayTimezoneId,
  gameDayUtcOffsetHours,
  expectedBrowserTimezoneOffsetMinutes,
  zoneOffsetMinutesBehindUtc,
} from '../../src/config/game-timezone.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

/**
 * The UTC hour at which local midnight falls in `timeZone`, read back out of
 * ICU rather than recomputed — the point is to check the zone NAME resolves to
 * the offset we think it does, so re-deriving it from our own math would prove
 * nothing.
 *
 * Formats a known instant in the zone and measures the shift. A fixed-offset
 * zone has no DST, so any instant gives the same answer; January is used so a
 * regression that reintroduces a city zone shows up as a mismatch here rather
 * than passing half the year.
 */
function localMidnightUtcHour(timeZone: string): number {
  const instant = new Date('2026-01-15T00:00:00Z');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(instant);
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // 'en-US' renders midnight as hour 24 under hour12:false; normalise it.
  const localHour = at('hour') % 24;
  // Offset in hours = local hour - UTC hour, wrapped into (-12, 12].
  let offset = localHour - instant.getUTCHours();
  if (at('day') !== instant.getUTCDate()) offset += at('day') > instant.getUTCDate() ? 24 : -24;
  // Local midnight is `offset` hours before 00:00 UTC, i.e. at (24 - offset) UTC.
  return ((24 - offset) % 24 + 24) % 24;
}

describe('gameDayTimezoneId', () => {
  it('resolves to a zone whose local midnight is the rollover hour', () => {
    const wrong: string[] = [];
    for (let rollover = 0; rollover < 24; rollover++) {
      const zone = gameDayTimezoneId(rollover);
      let midnight: number;
      try {
        midnight = localMidnightUtcHour(zone);
      } catch (err) {
        wrong.push(`rollover ${rollover}: "${zone}" is not a zone Intl accepts (${String(err)})`);
        continue;
      }
      if (midnight !== rollover) {
        wrong.push(`rollover ${rollover}: "${zone}" has local midnight at ${midnight}:00 UTC`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('puts the shipped 17:00 rollover on UTC+7', () => {
    // Spelled out because this is the value that actually ships, and the whole
    // fix rests on it: Etc/GMT-7 is UTC+7, whose midnight is 17:00 UTC.
    expect(DEFAULT_CONFIG.gameDayRolloverUtcHour).toBe(17);
    expect(gameDayTimezoneId(17)).toBe('Etc/GMT-7');
    expect(gameDayUtcOffsetHours(17)).toBe(7);
    // getTimezoneOffset() counts minutes BEHIND UTC — the launcher's probe
    // compares against this, so an inverted sign here would make the probe pass
    // on exactly the broken configuration it exists to catch.
    expect(expectedBrowserTimezoneOffsetMinutes(17)).toBe(-420);
  });

  it('maps a midnight rollover to UTC rather than an offset zone', () => {
    expect(gameDayTimezoneId(0)).toBe('UTC');
    expect(expectedBrowserTimezoneOffsetMinutes(0)).toBe(0);
  });
});

describe('zoneOffsetMinutesBehindUtc', () => {
  it('agrees with the rollover math on the fixed-offset zones', () => {
    for (let rollover = 0; rollover < 24; rollover++) {
      expect(zoneOffsetMinutesBehindUtc(gameDayTimezoneId(rollover), new Date('2026-08-02T12:00:00Z')))
        .toBe(expectedBrowserTimezoneOffsetMinutes(rollover));
    }
  });

  it('follows a city zone across its DST change', () => {
    // The launcher compares this against the live browser, so a standard-time
    // constant would raise a false alarm for half the year.
    expect(zoneOffsetMinutesBehindUtc('Europe/Berlin', new Date('2026-01-15T12:00:00Z'))).toBe(-60);
    expect(zoneOffsetMinutesBehindUtc('Europe/Berlin', new Date('2026-07-15T12:00:00Z'))).toBe(-120);
  });
});
