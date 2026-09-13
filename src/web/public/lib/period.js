// Game-day / leaderboard-period math helpers.
//
// The "period" abstraction is a (period, offset) pair where period is
// one of 'daily' | 'weekly' | 'monthly' | 'yearly' | 'all', and
// offset is a non-negative integer (0 = current period, 1 = previous,
// etc.). These helpers convert between that abstraction and concrete
// half-open [from, to) ISO timestamp windows, snapped to the game's
// shifted-UTC coordinate system (subtract gameDayRolloverUtcHour from
// real UTC).
//
// Single source of truth — used by the authenticated Leaderboard,
// Dashboard ("Weekly Top Contributors" card), Analytics, AND the
// public-share page so all four stay aligned to the same game-week
// definition. If you change the math, change it once here.

import { getGameDayRolloverUtcHour } from './state.js';
import { formatUtcDateKey } from './ui.js';

// `rolloverHrOverride` is for the public-share page, which wires its
// rollover hour through state.js the same way the auth app does — but
// kept as an optional arg so a caller can pass it explicitly without
// going through shared state if that's ever useful.
function resolveRolloverHr(override) {
  return Number.isFinite(override) ? override : getGameDayRolloverUtcHour();
}

/**
 * The game day (YYYY-MM-DD) an epoch-ms timestamp falls in: game day N runs
 * [N 17:00 UTC, N+1 17:00 UTC), so it's the shifted-UTC date at "ms -
 * rolloverHours". Use this instead of raw calendar/24h math so day counts snap
 * to the 17:00 reset like the rest of the site.
 */
export function gameDayKeyFor(ms, rolloverHrOverride) {
  const rolloverHr = resolveRolloverHr(rolloverHrOverride);
  return formatUtcDateKey(new Date(ms - rolloverHr * 60 * 60 * 1000));
}

/**
 * Today's game day as a YYYY-MM-DD string. Game day N is the
 * shifted-UTC date at "now - rolloverHours". The default period
 * anchor when the URL doesn't specify one.
 */
export function getCurrentGameDayKey(rolloverHrOverride) {
  return gameDayKeyFor(Date.now(), rolloverHrOverride);
}

/**
 * Whole game-days from now until an epoch-ms timestamp (negative if past),
 * counted by 17:00-reset boundaries — e.g. an event starting at the next reset
 * is "1", regardless of the wall-clock hours until then.
 */
export function gameDaysUntil(ms, rolloverHrOverride) {
  const from = Date.parse(getCurrentGameDayKey(rolloverHrOverride));
  const to = Date.parse(gameDayKeyFor(ms, rolloverHrOverride));
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

/**
 * Compute a half-open [fromIso, toIso) window for a (period, offset)
 * pair, in the game's shifted-UTC coordinate system. Returns null for
 * 'all' (meaning no filter).
 *
 * The math mirrors the previous server-side computeLeaderboardWindow:
 * subtract rolloverHours from now to get the shifted-UTC coordinate,
 * snap + calendar-navigate in UTC, then shift back to real UTC bounds.
 */
export function computeGameWindow(period, offset, rolloverHrOverride) {
  if (period === 'all') return null;
  const rolloverHr = resolveRolloverHr(rolloverHrOverride);
  const rolloverMs = rolloverHr * 60 * 60 * 1000;
  const shifted = new Date(Date.now() - rolloverMs);
  shifted.setUTCHours(0, 0, 0, 0);

  const shiftBack = (startShiftedMs, endShiftedMs) => ({
    from: new Date(startShiftedMs + rolloverMs).toISOString(),
    to: new Date(endShiftedMs + rolloverMs).toISOString(),
  });

  if (period === 'daily') {
    shifted.setUTCDate(shifted.getUTCDate() - offset);
    const startMs = shifted.getTime();
    return shiftBack(startMs, startMs + 24 * 60 * 60 * 1000);
  }
  if (period === 'weekly') {
    const dow = shifted.getUTCDay();
    // Game-week starts on Sunday at the rollover hour, matching the
    // upstream chesttracker convention (see chesttracker-client.ts).
    const daysBackToSunday = dow;
    shifted.setUTCDate(shifted.getUTCDate() - daysBackToSunday - offset * 7);
    const startMs = shifted.getTime();
    return shiftBack(startMs, startMs + 7 * 24 * 60 * 60 * 1000);
  }
  if (period === 'monthly') {
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth() - offset;
    const startMs = Date.UTC(year, month, 1, 0, 0, 0, 0);
    const endMs = Date.UTC(year, month + 1, 1, 0, 0, 0, 0);
    return shiftBack(startMs, endMs);
  }
  if (period === 'yearly') {
    const year = shifted.getUTCFullYear() - offset;
    const startMs = Date.UTC(year, 0, 1, 0, 0, 0, 0);
    const endMs = Date.UTC(year + 1, 0, 1, 0, 0, 0, 0);
    return shiftBack(startMs, endMs);
  }
  return null;
}

/**
 * Inclusive [from, to] window as game-day DATE strings (YYYY-MM-DD) for a
 * (period, offset) slot. Unlike computeGameWindow (which returns real-UTC
 * timestamps for filtering time-stamped scans), this anchors on the current
 * *game day* — getCurrentGameDayKey() already subtracts the rollover hour —
 * and does plain calendar-date math. Use it to filter date-only values like
 * resource transaction_date, which are already game-day dates. Returns null
 * for 'all'. Weeks start on Sunday, matching formatPeriodLabel/computeGameWindow.
 */
export function computeGameWindowDates(period, offset, rolloverHrOverride) {
  if (period === 'all') return null;
  const today = new Date(getCurrentGameDayKey(rolloverHrOverride) + 'T00:00:00Z');
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

  if (period === 'daily') {
    const d = addDays(today, -offset);
    return { from: iso(d), to: iso(d) };
  }
  if (period === 'weekly') {
    const start = addDays(today, -today.getUTCDay() - offset * 7);
    return { from: iso(start), to: iso(addDays(start, 6)) };
  }
  if (period === 'monthly') {
    const y = today.getUTCFullYear();
    const m = today.getUTCMonth() - offset;
    return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) };
  }
  if (period === 'yearly') {
    const y = today.getUTCFullYear() - offset;
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
  return null;
}

/**
 * Human-readable label for a (period, offset) slot. Used between the
 * navigation arrows on the leaderboard UI (both auth and public).
 */
export function formatPeriodLabel(period, offset, rolloverHrOverride) {
  if (period === 'all') return 'All Time';
  const rolloverHr = resolveRolloverHr(rolloverHrOverride);
  const shifted = new Date(Date.now() - rolloverHr * 60 * 60 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);

  if (period === 'daily') {
    shifted.setUTCDate(shifted.getUTCDate() - offset);
    return formatUtcDateKey(shifted);
  }
  if (period === 'weekly') {
    const dow = shifted.getUTCDay();
    const daysBackToSunday = dow;
    shifted.setUTCDate(shifted.getUTCDate() - daysBackToSunday - offset * 7);
    const sunday = new Date(shifted);
    const saturday = new Date(shifted);
    saturday.setUTCDate(saturday.getUTCDate() + 6);
    return `${formatUtcDateKey(sunday)} → ${formatUtcDateKey(saturday)}`;
  }
  if (period === 'monthly') {
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth() - offset;
    const d = new Date(Date.UTC(year, month, 1));
    return d.toLocaleDateString([], { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  if (period === 'yearly') {
    const year = shifted.getUTCFullYear() - offset;
    return String(year);
  }
  return '';
}

// ─── URL anchors ───
// Encoding a timeframe into a link is a period concern, not a leaderboard one.
// These lived in pages/leaderboard.js, which meant pages/triumphal.js had to
// reach across into another page module to share them, and pages/analytics.js
// would have had to do the same. They are pure functions of (period, offset)
// plus the rollover hour, so they belong here with the rest of the window math.

/**
 * Encode a (period, offset) into an ABSOLUTE URL anchor (e.g.
 * `?period=weekly&week=2026-04-06`) so shareable links keep
 * pointing at the same window forever, not "two weeks ago" relative
 * to whenever the link was opened.
 */
export function periodAnchorFromOffset(period, offset) {
  if (period === 'all') return null;
  const rolloverHr = getGameDayRolloverUtcHour();
  const shifted = new Date(Date.now() - rolloverHr * 60 * 60 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);

  if (period === 'daily') {
    shifted.setUTCDate(shifted.getUTCDate() - offset);
    return { key: 'day', value: formatUtcDateKey(shifted) };
  }
  if (period === 'weekly') {
    const dow = shifted.getUTCDay();
    const daysBackToSunday = dow;
    shifted.setUTCDate(shifted.getUTCDate() - daysBackToSunday - offset * 7);
    return { key: 'week', value: formatUtcDateKey(shifted) };
  }
  if (period === 'monthly') {
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth() - offset;
    const d = new Date(Date.UTC(year, month, 1));
    const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    return { key: 'month', value: monthKey };
  }
  if (period === 'yearly') {
    const year = shifted.getUTCFullYear() - offset;
    return { key: 'year', value: String(year) };
  }
  return null;
}

/**
 * Inverse of periodAnchorFromOffset. Converts an absolute anchor
 * string (from the URL hash) back into a numeric offset. Returns 0
 * when the anchor is invalid or missing so the UI falls back to
 * "current period".
 */
export function periodOffsetFromAnchor(period, params) {
  if (period === 'all') return 0;
  const rolloverHr = getGameDayRolloverUtcHour();
  const shifted = new Date(Date.now() - rolloverHr * 60 * 60 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);

  if (period === 'daily') {
    const day = params.get('day');
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 0;
    const [y, m, d] = day.split('-').map(Number);
    const target = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
    const todayMs = shifted.getTime();
    const diffDays = Math.round((todayMs - target) / (24 * 60 * 60 * 1000));
    return Math.max(0, diffDays);
  }
  if (period === 'weekly') {
    const week = params.get('week');
    if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) return 0;
    const [y, m, d] = week.split('-').map(Number);
    const target = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
    const dow = shifted.getUTCDay();
    const daysBackToSunday = dow;
    shifted.setUTCDate(shifted.getUTCDate() - daysBackToSunday);
    const thisSundayMs = shifted.getTime();
    const diffWeeks = Math.round((thisSundayMs - target) / (7 * 24 * 60 * 60 * 1000));
    return Math.max(0, diffWeeks);
  }
  if (period === 'monthly') {
    const month = params.get('month');
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return 0;
    const [ty, tm] = month.split('-').map(Number);
    const diffMonths = (shifted.getUTCFullYear() - ty) * 12 + (shifted.getUTCMonth() - (tm - 1));
    return Math.max(0, diffMonths);
  }
  if (period === 'yearly') {
    const year = params.get('year');
    if (!year || !/^\d{4}$/.test(year)) return 0;
    return Math.max(0, shifted.getUTCFullYear() - Number(year));
  }
  return 0;
}
