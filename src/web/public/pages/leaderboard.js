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
import { esc, memberLink, memberHash } from '../lib/ui.js';
import { t, tn } from '../lib/i18n.js';
import {
  computeGameWindow, formatPeriodLabel, periodAnchorFromOffset,
} from '../lib/period.js';
import { sortLeaderboardEntries, leaderboardTablePartsHtml, copyLeaderboardData } from '../lib/leaderboard-render.js';
import { openLeaderboardFaq } from '../lib/leaderboard-faq.js';
import { weeklyGoalForWindow, amberRatioForWindow } from '../lib/weekly-goal.js';
import { avatarHtml } from '../lib/avatar.js';
import {
  periodScrubberHtml, wirePeriodScrubber, setPageActions, errorStateHtml, refusalText, wireRetry,
} from '../lib/ui-kit.js';
import {
  getGameDayRolloverUtcHour,
  getCurrentPeriod,
  setCurrentPeriod,
  getCurrentPeriodOffset,
  setCurrentPeriodOffset,
  getWeekStart,
} from '../lib/state.js';

const PAGE_SIZE = 25;
const PERIODS = ['daily', 'weekly', 'monthly', 'yearly', 'all'];
let currentPage = 1;
let sortState = { key: 'points', dir: 'desc' };

const ACTIONS = {
  setPeriod: 'set-period',
  periodPrev: 'leaderboard-period-prev',
  periodNext: 'leaderboard-period-next',
  pagePrev: 'leaderboard-page-prev',
  pageNext: 'leaderboard-page-next',
  sort: 'sort-leaderboard',
  openFaq: 'open-leaderboard-faq',
  copyData: 'leaderboard-copy-data',
};

// What the last render showed, for the Copy data button: the whole sorted
// roster, not just the page on screen.
let lastCopy = null;

/**
 * The signed-in Leaderboard (redesign wave 1, the UI kit's reference page):
 * the period scrubber, the top three as a podium, the line naming the goal
 * this window is judged against, then the ranked table in the kit's table
 * card. FAQ, Export CSV and Copy data sit in the page header. The table core
 * is lib/leaderboard-render.js's, shared with the public share page and
 * Triumphal (which keep the classic card), so the boards can never disagree.
 * The Members board is its sibling: bars against the goal there, the ranked
 * table and podium here.
 *
 * `navigate` is the router's navigateTo (period changes go through the URL).
 */
export async function renderLeaderboard(el, { navigate } = {}) {
  // The goal is a separate call because /leaderboard answers with a bare
  // array that Home also consumes — see the route comment. Fetched in
  // parallel, and a failure there is non-fatal: the board renders without
  // colouring rather than not at all. /game/roster gives the podium pictures.
  const [leaderboard, goal, roster] = await Promise.all([
    api(buildLeaderboardQuery()),
    api('/leaderboard/goal').catch(() => null),
    api('/game/roster').catch(() => null),
  ]);

  // A refusal (429, a 500's { error, ref }) arrives as an object, not a list.
  if (!Array.isArray(leaderboard)) {
    setPageActions('');
    el.innerHTML = errorStateHtml(t('The leaderboard could not be loaded.'), refusalText(leaderboard));
    wireRetry(el, () => renderLeaderboard(el, { navigate }));
    return;
  }

  // Backend returns rows in canonical "true rank" order (points DESC,
  // chests DESC, name ASC) — keep e.rank pinned to that even when the
  // user re-sorts.
  const sorted = sortLeaderboardEntries(leaderboard, sortState.key, sortState.dir);

  // Decided across the whole roster, not the visible page: a clan where only
  // the newest joiners lack a snapshot would otherwise gain and lose the two
  // columns as you page through it.
  const showMight = leaderboard.some((e) => e.might != null || e.heroLevel != null);
  const showGuards = leaderboard.some((e) => e.guardsLevel != null);

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

  // The goal THIS window was played under: last week keeps last week's goal
  // after the clan raises it.
  const goalWeeklyPoints = weeklyGoalForWindow(goal, getCurrentPeriod(), getCurrentPeriodOffset());
  const goalWarnRatio = amberRatioForWindow(goal, getCurrentPeriod(), getCurrentPeriodOffset());

  lastCopy = {
    entries: sorted,
    period: getCurrentPeriod(),
    offset: getCurrentPeriodOffset(),
    rolloverHr: getGameDayRolloverUtcHour(),
    goalWeeklyPoints,
    goalWarnRatio,
  };

  const period = getCurrentPeriod() || 'all';
  const offset = getCurrentPeriodOffset();
  const rolloverHr = getGameDayRolloverUtcHour();
  const weekStart = getWeekStart();
  const { goalHintHtml, tableHtml, paginationHtml } = leaderboardTablePartsHtml({
    pageEntries,
    totalEntries,
    currentPage,
    totalPages,
    period,
    sortState,
    pageSize: PAGE_SIZE,
    playerCellHtml: (e) => memberLink(e.memberId, e.memberName),
    actions: ACTIONS,
    showMight,
    showGuards,
    goalWeeklyPoints,
    goalWarnRatio,
    tableClass: 'ui-table',
  });

  setPageActions(pageActionsHtml(exportHref, totalEntries > 0));
  el.innerHTML = `<div class="lb">
      ${periodScrubberHtml({
        periods: PERIODS, period, offset, rolloverHr, weekStart,
        win: computeGameWindow(period, offset, rolloverHr, weekStart),
      })}
      ${podiumHtml(leaderboard, roster?.members || {})}
      ${goalHintHtml}
      <div class="ui-table-card">
        ${tableHtml}
        ${paginationHtml}
      </div>
    </div>`;
  wirePeriodScrubber(el, {
    onPeriod: (p) => setPeriod(p, navigate),
    onStep: (delta) => changePeriodOffset(delta, navigate),
  });
}

/** FAQ, Export CSV (the window on screen) and Copy data, beside the page title. */
function pageActionsHtml(exportHref, hasRows) {
  return `<button type="button" class="btn" data-action="${ACTIONS.openFaq}" title="${esc(t('What each chest is worth, and how the board works'))}">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.1 6.3a1.95 1.95 0 1 1 2.7 1.8c-.52.22-.8.62-.8 1.18v.32" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.7" r=".9" fill="currentColor"/></svg>
      ${esc(t('FAQ'))}
    </button>
    <a class="btn" href="${esc(exportHref)}" download title="${esc(t('Download this timeframe as CSV'))}">${esc(t('Export CSV'))}</a>
    ${hasRows ? `<button type="button" class="btn" data-action="${ACTIONS.copyData}" title="${esc(t('Copy every player in this timeframe as text'))}">${esc(t('Copy data'))}</button>` : ''}`;
}

/**
 * The top three of the window, by canonical rank whatever the table's sort:
 * picture, name, points and chests. Nothing when nobody has points yet.
 */
function podiumHtml(entries, game) {
  const top = entries.filter((e) => (e.totalPoints || 0) > 0 && e.rank <= 3).sort((a, b) => a.rank - b.rank).slice(0, 3);
  if (!top.length) return '';
  return `<ol class="lb-podium" aria-label="${esc(t('Top three'))}">
      ${top.map((e) => `<li class="lb-podium-place place-${e.rank}">
        <a class="lb-podium-card" href="${memberHash(e.memberId)}">
          <span class="rank rank-${e.rank} lb-podium-rank">#${e.rank}</span>
          ${avatarHtml({ username: e.memberName, avatar: game[e.memberId]?.avatar ?? null }, { size: 'lg' })}
          <span class="lb-podium-who">
            <span class="lb-podium-name">${esc(e.memberName)}</span>
            <span class="lb-podium-sub">${esc(tn(e.totalChests || 0, '{n} chest', '{n} chests', { n: (e.totalChests || 0).toLocaleString() }))}</span>
          </span>
          <span class="lb-podium-pts"><span class="lb-podium-n">${(e.totalPoints || 0).toLocaleString()}</span> <span class="lb-podium-unit">${esc(t('points'))}</span></span>
        </a>
      </li>`).join('')}
    </ol>`;
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

export function openLeaderboardFaqModal() {
  openLeaderboardFaq({
    // signal: null — the modal is not a page load, so it must not ride the
    // router's navigation abort signal (api() attaches it to every GET that
    // doesn't bring its own). With it, any navigation while the FAQ was
    // loading turned the modal into "Couldn't load the FAQ".
    load: () => api('/leaderboard/faq', { signal: null }),
    mode: 'member',
    rolloverHr: getGameDayRolloverUtcHour(),
  });
}

export function copyLeaderboardToClipboard(btn) {
  if (lastCopy) return copyLeaderboardData(btn, lastCopy);
}

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
