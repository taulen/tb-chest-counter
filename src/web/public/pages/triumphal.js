// Triumphal Chests (My Clan → Triumphal Chests, #triumphal) — bookkeeping view
// for in-game package purchases. Each row is a per-member tally with a
// presentation-only points total (computed in triumphal-chest-repo per
// individual chest). Points stay separate from the main leaderboard.
//
// Built on the UI kit: the kit's period scrubber (daily/weekly/monthly/yearly/
// all, the absolute URL anchors of lib/period.js the Members board uses too),
// stat tiles, then the shared table core (leaderboardTablePartsHtml: same sort
// + pagination) in a table card, as on the public share page.
// Recent chests sit in a collapsed table card at the bottom.

import { api } from '../lib/api.js';
import { buildHash, esc, formatDate, memberLink } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { loadGameArt, chestLabelHtml } from '../lib/game-art.js';
import { computeGameWindow, periodAnchorFromOffset } from '../lib/period.js';
import { sortLeaderboardEntries, leaderboardTablePartsHtml } from '../lib/leaderboard-render.js';
import {
  periodScrubberHtml, wirePeriodScrubber, statTileHtml, statTilesHtml, emptyHtml,
  errorStateHtml, refusalText, wireRetry, asList,
} from '../lib/ui-kit.js';
import {
  getGameDayRolloverUtcHour,
  getWeekStart,
  getCurrentPeriod,
  setCurrentPeriod,
  getCurrentPeriodOffset,
  setCurrentPeriodOffset,
} from '../lib/state.js';
// Period anchors (periodAnchorFromOffset) live in lib/period.js, shared with
// the Members board's addresses.

const PAGE_SIZE = 25;
const RECENT_LIMIT = 1000;
const PERIODS = ['daily', 'weekly', 'monthly', 'yearly', 'all'];
let sortState = { key: 'points', dir: 'desc' };
let currentBoardPage = 1;
let currentRecentPage = 1;

const ACTIONS = {
  setPeriod: 'triumphal-set-period',
  periodPrev: 'triumphal-period-prev',
  periodNext: 'triumphal-period-next',
  pagePrev: 'triumphal-page-prev',
  pageNext: 'triumphal-page-next',
  sort: 'sort-triumphal',
};

/**
 * The scrubber changes the address (#triumphal?period=…&w=…); the router
 * reads it into the shared period state and redraws this panel in place
 * (My Clan's switchClanTab).
 */
function goToWindow() {
  const period = getCurrentPeriod() || 'all';
  const params = { period };
  if (period !== 'all') {
    const anchor = periodAnchorFromOffset(period, getCurrentPeriodOffset());
    if (anchor) params[anchor.key] = anchor.value;
  }
  window.location.hash = buildHash('triumphal', params);
}

export async function renderTriumphal(el) {
  const period = getCurrentPeriod() || 'all';
  const offset = getCurrentPeriodOffset();
  const rolloverHr = getGameDayRolloverUtcHour();
  const weekStart = getWeekStart();
  const win = computeGameWindow(period, offset);
  const params = new URLSearchParams();
  if (win) {
    params.set('from', win.from);
    params.set('to', win.to);
  }
  const qs = params.toString();
  const suffix = qs ? `?${qs}` : '';

  const recentParams = new URLSearchParams(params);
  recentParams.set('limit', String(RECENT_LIMIT));

  const scrubber = periodScrubberHtml({
    periods: PERIODS, period, offset, rolloverHr, weekStart,
    win: computeGameWindow(period, offset, rolloverHr, weekStart),
  });
  const wire = () => wirePeriodScrubber(el, {
    onPeriod: (p) => {
      setCurrentPeriod(p);
      setCurrentPeriodOffset(0);
      currentBoardPage = 1;
      currentRecentPage = 1;
      goToWindow();
    },
    onStep: (delta) => {
      const next = getCurrentPeriodOffset() + delta;
      if (next < 0) return;
      setCurrentPeriodOffset(next);
      currentBoardPage = 1;
      currentRecentPage = 1;
      goToWindow();
    },
  });

  let stats;
  let leaderboard;
  let recent;
  try {
    [stats, leaderboard, recent] = await Promise.all([
      api(`/triumphal/stats${suffix}`),
      api(`/triumphal/leaderboard${suffix}`),
      api(`/triumphal/chests?${recentParams.toString()}`),
      // The chests' pictures in Recent chests (never rejects).
      loadGameArt(),
    ]);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    leaderboard = null;
  }
  // The board is the panel's main data: a refusal (a 429, a 500's
  // { error, ref }) or a failed read says so, with Try again.
  if (!Array.isArray(leaderboard)) {
    el.innerHTML = `<div class="trc">${scrubber}
        <div class="ui-tile span-12">${errorStateHtml(t('The Triumphal Chests could not be loaded.'), refusalText(leaderboard))}</div>
      </div>`;
    wire();
    wireRetry(el, () => renderTriumphal(el));
    return;
  }
  const recentRows = asList(recent);

  // Total points within the window — derived client-side from the same
  // leaderboard the table below is about to consume, so the headline stat
  // and the per-member rows can never disagree.
  const totalPoints = leaderboard.reduce((sum, e) => sum + (e.totalPoints || 0), 0);

  // The board shows the raw chest count — every triumphal chest scores on its
  // own now (no more groups of 3), so the shared renderer's `totalChests` slot
  // maps straight through.
  const sorted = sortLeaderboardEntries(leaderboard, sortState.key, sortState.dir);

  const totalEntries = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalEntries / PAGE_SIZE));
  if (currentBoardPage > totalPages) currentBoardPage = totalPages;
  if (currentBoardPage < 1) currentBoardPage = 1;
  const startIdx = (currentBoardPage - 1) * PAGE_SIZE;
  const pageEntries = sorted.slice(startIdx, startIdx + PAGE_SIZE);

  const statTiles = statTilesHtml([
    statTileHtml({ label: t('Total triumphal chests'), value: (stats?.totalChests ?? 0).toLocaleString() }),
    statTileHtml({ label: t('Members with triumphals'), value: (stats?.uniqueMembers ?? 0).toLocaleString() }),
    statTileHtml({ label: t('Total points'), value: totalPoints.toLocaleString() }),
  ]);

  const { tableHtml, paginationHtml } = leaderboardTablePartsHtml({
    countLabel: t('Chests'),
    pageEntries,
    totalEntries,
    currentPage: currentBoardPage,
    totalPages,
    period,
    sortState,
    pageSize: PAGE_SIZE,
    playerCellHtml: (e) => memberLink(e.memberId, e.memberName),
    actions: ACTIONS,
    tableClass: 'ui-table',
  });

  // Recent list — site-wide table conventions (locked widths via the
  // leaderboard-table colgroup, 25/page, date column on the right), in a
  // collapsed card: the per-member board above is the primary view.
  const recentTotal = recentRows.length;
  const recentTotalPages = Math.max(1, Math.ceil(recentTotal / PAGE_SIZE));
  if (currentRecentPage > recentTotalPages) currentRecentPage = recentTotalPages;
  if (currentRecentPage < 1) currentRecentPage = 1;
  const recentStart = (currentRecentPage - 1) * PAGE_SIZE;
  const recentPageRows = recentRows.slice(recentStart, recentStart + PAGE_SIZE);

  const recentPagination = recentTotal > PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-action="triumphal-recent-page-prev" ${currentRecentPage <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
        <span class="pagination-info">${t('Page {page} of {pages}', { page: currentRecentPage, pages: recentTotalPages })} · ${tn(recentTotal, '{n} chest', '{n} chests', { n: recentTotal })}</span>
        <button class="btn btn-tight" data-action="triumphal-recent-page-next" ${currentRecentPage >= recentTotalPages ? 'disabled' : ''}>${t('Next →')}</button>
      </div>`
    : '';

  const recentBody = recentTotal === 0
    ? emptyHtml(t('No triumphal chests in this period.'))
    : `<table class="table-responsive ui-table leaderboard-table"><colgroup>
        <col class="col-player">
        <col class="col-player">
        <col class="col-num">
        <col class="col-num">
      </colgroup><thead><tr>
        <th>${t('Player')}</th>
        <th>${t('Chest')}</th>
        <th>${t('Source')}</th>
        <th>${t('Received')}</th>
      </tr></thead><tbody>
      ${recentPageRows.map((r) => `<tr>
        <td data-label="${t('Player')}" data-role="primary"><span class="mrow-name">${memberLink(r.memberId, r.playerName)}</span><span class="mrow-sub">${chestLabelHtml(r.chestName, esc(tGame(r.chestName)), { size: 16 })}</span></td>
        <td data-label="${t('Chest')}">${chestLabelHtml(r.chestName, esc(tGame(r.chestName)))}</td>
        <td data-label="${t('Source')}">${esc(tGame(r.chestSource || ''))}</td>
        <td data-label="${t('Received')}" data-role="metric">${formatDate(r.effectiveAt)}</td>
      </tr>`).join('')}
    </tbody></table>${recentPagination}`;

  el.innerHTML = `<div class="trc">
      ${scrubber}
      ${statTiles}
      <p class="ui-copy trc-about">${t('Triumphal chests come from in-game package purchases. Each chest is worth one third of its package value, shown rounded to a whole number — Magic ≈83, Precious ≈33, Golden ≈17, Silver ≈7, Bronze ≈3, Wooden ≈2 — so a full set of three sums back to the package value (3 Golden = 50). These points are tracked separately from the main leaderboard.')}</p>
      <section class="ui-table-card" aria-labelledby="trcBoardTitle">
        <div class="ui-card-head"><h2 class="ui-tile-title" id="trcBoardTitle">${t('Triumphal Chests')}</h2></div>
        ${totalEntries ? tableHtml : emptyHtml(t('No triumphal chests in this period.'))}
        ${totalEntries ? paginationHtml : ''}
      </section>
      <details class="ui-table-card card-collapsible trc-recent" data-section-key="triumphal-recent">
        <summary class="card-header ui-card-head"><h2 class="ui-tile-title">${t('Recent chests')}</h2>${recentTotal > 0 ? `<span class="ui-sub">${tn(recentTotal, '{n} chest', '{n} chests', { n: recentTotal.toLocaleString() })}</span>` : ''}</summary>
        ${recentBody}
      </details>
    </div>`;
  wire();
}

// ─── Action handlers ───
//
// Each one mutates module-local state and asks the caller to re-render
// the page. Taking `rerender` as an argument (instead of importing
// loadPage from app.js) keeps this module a leaf — no circular imports
// and trivially mockable in tests.

export function changeTriumphalPage(delta, rerender) {
  currentBoardPage = Math.max(1, currentBoardPage + delta);
  rerender('triumphal');
}

export function changeTriumphalRecentPage(delta, rerender) {
  currentRecentPage = Math.max(1, currentRecentPage + delta);
  rerender('triumphal');
}

export function setTriumphalSort(key, rerender) {
  if (sortState.key === key) {
    sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    sortState.key = key;
    sortState.dir = (key === 'name' || key === 'rank') ? 'asc' : 'desc';
  }
  currentBoardPage = 1;
  rerender('triumphal');
}

// ─── Period selector ──────────────────────────────────────────
// The kit scrubber above drives the window (goToWindow). These stay for the
// shell's data-action handlers (app.js), which still route the classic
// period buttons here. Period state is shared (lib/state.js, persisted to
// localStorage) so a user's choice carries between Leaderboard and
// Triumphal, but the URL anchor is encoded per page so a shared link lands
// on the right page in the right window.

export function setTriumphalPeriod(period, navigate) {
  setCurrentPeriod(period);
  setCurrentPeriodOffset(0);
  currentBoardPage = 1;
  currentRecentPage = 1;
  navigateToTriumphal(navigate);
}

export function changeTriumphalPeriodOffset(delta, navigate) {
  const next = getCurrentPeriodOffset() + delta;
  if (next < 0) return;
  setCurrentPeriodOffset(next);
  currentBoardPage = 1;
  currentRecentPage = 1;
  navigateToTriumphal(navigate);
}

export function navigateToTriumphal(navigate) {
  const period = getCurrentPeriod() || 'all';
  const params = { period };
  if (period !== 'all') {
    const anchor = periodAnchorFromOffset(period, getCurrentPeriodOffset());
    if (anchor) params[anchor.key] = anchor.value;
  }
  navigate('triumphal', params);
}
