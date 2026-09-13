// Leaderboard page. Daily / weekly / monthly / yearly / all-time
// rankings with absolute-anchor URL params so a shared link points at
// the same window forever. Owns its sort + pagination state
// internally; the URL hash carries the period selection so refreshes
// preserve it.
//
// All rendering and period math goes through lib/leaderboard-render.js
// + lib/period.js — the SAME modules used by the public-share page —
// so the two surfaces can never drift apart.

import { api } from '../lib/api.js';
import { memberLink, formatUtcDateKey } from '../lib/ui.js';
import {
  computeGameWindow, formatPeriodLabel, periodAnchorFromOffset, periodOffsetFromAnchor,
} from '../lib/period.js';
import { sortLeaderboardEntries, renderLeaderboardCardHtml } from '../lib/leaderboard-render.js';
import {
  getGameDayRolloverUtcHour,
  getCurrentPeriod,
  setCurrentPeriod,
  getCurrentPeriodOffset,
  setCurrentPeriodOffset,
} from '../lib/state.js';

const PAGE_SIZE = 25;
let currentPage = 1;
let sortState = { key: 'points', dir: 'desc' };

const ACTIONS = {
  setPeriod: 'set-period',
  periodPrev: 'leaderboard-period-prev',
  periodNext: 'leaderboard-period-next',
  pagePrev: 'leaderboard-page-prev',
  pageNext: 'leaderboard-page-next',
  sort: 'sort-leaderboard',
};

export async function renderLeaderboard(el) {
  // The goal is a separate call because /leaderboard answers with a bare
  // array that the Dashboard also consumes — see the route comment. Fetched
  // in parallel, and a failure there is non-fatal: the board renders without
  // colouring rather than not at all.
  const [leaderboard, goal] = await Promise.all([
    api(buildLeaderboardQuery()),
    api('/leaderboard/goal').catch(() => null),
  ]);

  // Backend returns rows in canonical "true rank" order (points DESC,
  // chests DESC, name ASC) — keep e.rank pinned to that even when the
  // user re-sorts.
  const sorted = sortLeaderboardEntries(leaderboard, sortState.key, sortState.dir);

  // Decided across the whole roster, not the visible page: a clan where only
  // the newest joiners lack a snapshot would otherwise gain and lose the two
  // columns as you page through it.
  const showMight = leaderboard.some((e) => e.might != null || e.heroLevel != null);

  const totalEntries = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalEntries / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageEntries = sorted.slice(startIdx, startIdx + PAGE_SIZE);

  // Export the window on screen. Same query the board just ran, plus
  // format=csv, so the spreadsheet and the page can never disagree about what
  // "this week" meant. An anchor rather than a fetch: the browser handles the
  // download, and Content-Disposition names the file.
  const exportHref = `/api${buildLeaderboardQuery()}&format=csv`;

  el.innerHTML = renderLeaderboardCardHtml({
    pageEntries,
    totalEntries,
    currentPage,
    totalPages,
    period: getCurrentPeriod(),
    offset: getCurrentPeriodOffset(),
    exportHref,
    sortState,
    rolloverHr: getGameDayRolloverUtcHour(),
    pageSize: PAGE_SIZE,
    playerCellHtml: (e) => memberLink(e.memberId, e.memberName),
    actions: ACTIONS,
    showMight,
    goalWeeklyPoints: goal?.weeklyPoints ?? null,
  });
}

function buildLeaderboardQuery() {
  const params = new URLSearchParams({ includeAll: '1' });
  const window = computeGameWindow(getCurrentPeriod(), getCurrentPeriodOffset());
  if (window) {
    params.set('from', window.from);
    params.set('to', window.to);
  }
  return `/leaderboard?${params.toString()}`;
}

/**
 * Re-export for callers that want the period label without depending
 * on lib/period.js directly. Kept so any external usage (e.g. tests,
 * other pages) doesn't break.
 */
export function formatLeaderboardPeriodLabel(period, offset) {
  return formatPeriodLabel(period, offset, getGameDayRolloverUtcHour());
}

// ─── Action handlers ──────────────────────────────────────────

export function setLeaderboardSort(key, rerender) {
  if (sortState.key === key) {
    sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    sortState.key = key;
    sortState.dir = (key === 'name' || key === 'rank') ? 'asc' : 'desc';
  }
  currentPage = 1;
  rerender('leaderboard');
}

export function changeLeaderboardPage(delta, rerender) {
  currentPage = Math.max(1, currentPage + delta);
  rerender('leaderboard');
}

/**
 * Period selector. Resets offset + page to 0/1 and navigates so the
 * URL hash gets the ABSOLUTE anchor encoded — see
 * periodAnchorFromOffset.
 */
export function setPeriod(period, navigate) {
  setCurrentPeriod(period);
  setCurrentPeriodOffset(0);
  currentPage = 1;
  navigateToLeaderboard(navigate);
}

export function changePeriodOffset(delta, navigate) {
  const next = getCurrentPeriodOffset() + delta;
  // Clamp: 0 = current period (forward arrow disabled at 0), no max
  // cap since arriving at an empty window just shows the empty state.
  if (next < 0) return;
  setCurrentPeriodOffset(next);
  currentPage = 1;
  navigateToLeaderboard(navigate);
}

/**
 * Navigate to /#leaderboard with the current (period, offset) encoded
 * as URL params using the absolute-anchor scheme. `navigate` is the
 * router's navigateTo function injected by the caller so this module
 * stays a leaf.
 */
export function navigateToLeaderboard(navigate) {
  const period = getCurrentPeriod() || 'all';
  const params = { period };
  if (period !== 'all') {
    const anchor = periodAnchorFromOffset(period, getCurrentPeriodOffset());
    if (anchor) params[anchor.key] = anchor.value;
  }
  navigate('leaderboard', params);
}

/** Reset internal pagination state — called by app.js on page nav. */
export function resetLeaderboardPage() {
  currentPage = 1;
}
