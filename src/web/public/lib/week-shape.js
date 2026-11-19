// A clan's week shape: which strings name one, and the cadence each stands for.
//
// Pure and import-free, so lib/state.js can validate a shape without importing
// lib/period.js (which imports state.js). Mirrors the week-shape half of
// src/utils/game-day.ts; tests/config/game-window-parity.test.ts asserts the
// two agree, constants included. See docs/clan-week.md.
//
// Shapes:
//   'sunday'        Sunday → Sunday at the rollover (the default)
//   'ancients'      Tinman → Tinman, 6 days
//   'ancients-sk'   Tinman → Tinman in a Seasonal Kingdom, 5 days (SK 2026)
//   'custom:<YYYY-MM-DD>:<days>'  the clan's own: the first game day of any one
//                   of its weeks, and how many days each lasts

export const ANCIENTS_TINMAN_ANCHOR = '2026-10-23';
export const ANCIENTS_CYCLE_DAYS = 6;
export const SK_TINMAN_ANCHOR = '2026-11-17';
export const SK_CYCLE_DAYS = 5;
/** A Sunday: the 'sunday' shape is the cadence of 7 days from here. */
export const SUNDAY_ANCHOR = '1970-01-04';
export const CUSTOM_WEEK_MIN_DAYS = 2;
export const CUSTOM_WEEK_MAX_DAYS = 28;

const TINMAN_CADENCES = {
  ancients: { anchor: ANCIENTS_TINMAN_ANCHOR, days: ANCIENTS_CYCLE_DAYS },
  'ancients-sk': { anchor: SK_TINMAN_ANCHOR, days: SK_CYCLE_DAYS },
};

/**
 * A custom week's first day and length, or null when `v` isn't a well-formed
 * one: a real calendar date, and a whole length within bounds with no leading
 * zero (one spelling per week).
 */
export function parseCustomWeek(v) {
  if (typeof v !== 'string') return null;
  const m = /^custom:(\d{4}-\d{2}-\d{2}):([1-9]\d?)$/.exec(v);
  if (!m) return null;
  const days = Number(m[2]);
  if (days < CUSTOM_WEEK_MIN_DAYS || days > CUSTOM_WEEK_MAX_DAYS) return null;
  const ms = Date.parse(`${m[1]}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== m[1]) return null;
  return { anchor: m[1], days };
}

/** The custom week of `days` days, one of which starts on game day `anchor`. */
export function customWeekStart(anchor, days) {
  return `custom:${anchor}:${days}`;
}

/** The week shapes a clan can hold. */
export function isWeekStart(v) {
  return v === 'sunday' || v === 'ancients' || v === 'ancients-sk' || parseCustomWeek(v) !== null;
}

/** True for either Tinman-to-Tinman shape. */
export function isTinmanWeek(weekStart) {
  return weekStart === 'ancients' || weekStart === 'ancients-sk';
}

/** True for a clan's own week. */
export function isCustomWeek(weekStart) {
  return parseCustomWeek(weekStart) !== null;
}

/** A day some week of this shape starts on, and the week's length. */
export function weekCadence(weekStart) {
  if (isTinmanWeek(weekStart)) return TINMAN_CADENCES[weekStart];
  return parseCustomWeek(weekStart) ?? { anchor: SUNDAY_ANCHOR, days: 7 };
}
