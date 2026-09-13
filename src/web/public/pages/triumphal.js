// Triumphal Chests page — bookkeeping view for in-game package
// purchases. Each row is a per-member tally with a presentation-only
// points total (computed in triumphal-chest-repo per individual chest).
// Points stay separate from the main leaderboard.
//
// UI mirrors the main /#leaderboard page: same period selector
// (daily/weekly/monthly/yearly/all), same period-nav arrows, same
// sort + pagination, same URL anchor scheme. The shared renderer in
// lib/leaderboard-render.js is parametrized with title + count label.
// Recent chests sit in a collapsed <details> at the bottom.

import { api } from '../lib/api.js';
import { esc, formatDate, memberLink } from '../lib/ui.js';
import { computeGameWindow, periodAnchorFromOffset } from '../lib/period.js';
import { sortLeaderboardEntries, renderLeaderboardCardHtml } from '../lib/leaderboard-render.js';
import {
  getGameDayRolloverUtcHour,
  getCurrentPeriod,
  setCurrentPeriod,
  getCurrentPeriodOffset,
  setCurrentPeriodOffset,
} from '../lib/state.js';
// Period anchor helpers live with the leaderboard page since both
// surfaces share the same URL-encoding scheme — see pages/leaderboard.js.

const PAGE_SIZE = 25;
const RECENT_LIMIT = 1000;
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

export async function renderTriumphal(el) {
  const window = computeGameWindow(getCurrentPeriod(), getCurrentPeriodOffset());
  const params = new URLSearchParams();
  if (window) {
    params.set('from', window.from);
    params.set('to', window.to);
  }
  const qs = params.toString();
  const suffix = qs ? `?${qs}` : '';

  const recentParams = new URLSearchParams(params);
  recentParams.set('limit', String(RECENT_LIMIT));

  const [stats, leaderboard, recent] = await Promise.all([
    api(`/triumphal/stats${suffix}`),
    api(`/triumphal/leaderboard${suffix}`),
    api(`/triumphal/chests?${recentParams.toString()}`),
  ]);

  // Total points within the window — derived client-side from the same
  // leaderboard the renderer below is about to consume, so the headline
  // stat and the per-member rows can never disagree.
  const totalPoints = leaderboard.reduce((sum, e) => sum + (e.totalPoints || 0), 0);

  // The leaderboard column shows the raw chest count — every triumphal
  // chest scores on its own now (no more groups of 3), so the shared
  // renderer's `totalChests` slot maps straight through.
  const sorted = sortLeaderboardEntries(leaderboard, sortState.key, sortState.dir);

  const totalEntries = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalEntries / PAGE_SIZE));
  if (currentBoardPage > totalPages) currentBoardPage = totalPages;
  if (currentBoardPage < 1) currentBoardPage = 1;
  const startIdx = (currentBoardPage - 1) * PAGE_SIZE;
  const pageEntries = sorted.slice(startIdx, startIdx + PAGE_SIZE);

  const headerStats = `
    <div class="stats-grid">
      <div class="stat-card"><div class="label">Total triumphal chests</div><div class="value">${(stats.totalChests ?? 0).toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Members with triumphals</div><div class="value">${(stats.uniqueMembers ?? 0).toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Total points</div><div class="value">${totalPoints.toLocaleString()}</div></div>
    </div>`;

  const boardCardHtml = renderLeaderboardCardHtml({
    title: 'Triumphal Chests',
    countLabel: 'Chests',
    pageEntries,
    totalEntries,
    currentPage: currentBoardPage,
    totalPages,
    period: getCurrentPeriod(),
    offset: getCurrentPeriodOffset(),
    sortState,
    rolloverHr: getGameDayRolloverUtcHour(),
    pageSize: PAGE_SIZE,
    playerCellHtml: (e) => memberLink(e.memberId, e.memberName),
    actions: ACTIONS,
  });

  // Recent list — site-wide table conventions (locked widths via the
  // leaderboard-table colgroup, 25/page, date column on the right).
  // Wrapped in <details> so the section stays collapsed by default —
  // the per-member board above is the primary view.
  const recentTotal = recent.length;
  const recentTotalPages = Math.max(1, Math.ceil(recentTotal / PAGE_SIZE));
  if (currentRecentPage > recentTotalPages) currentRecentPage = recentTotalPages;
  if (currentRecentPage < 1) currentRecentPage = 1;
  const recentStart = (currentRecentPage - 1) * PAGE_SIZE;
  const recentPageRows = recent.slice(recentStart, recentStart + PAGE_SIZE);

  const recentPagination = recentTotal > PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-action="triumphal-recent-page-prev" ${currentRecentPage <= 1 ? 'disabled' : ''}>← Prev</button>
        <span class="pagination-info">Page ${currentRecentPage} of ${recentTotalPages} · ${recentTotal} chests</span>
        <button class="btn btn-tight" data-action="triumphal-recent-page-next" ${currentRecentPage >= recentTotalPages ? 'disabled' : ''}>Next →</button>
      </div>`
    : '';

  const recentBody = recentTotal === 0
    ? '<p class="muted-copy">No triumphal chests in this period.</p>'
    : `<table class="table-responsive leaderboard-table"><colgroup>
        <col class="col-player">
        <col class="col-player">
        <col class="col-num">
        <col class="col-num">
      </colgroup><thead><tr>
        <th>Player</th>
        <th>Chest</th>
        <th>Source</th>
        <th>Received</th>
      </tr></thead><tbody>
      ${recentPageRows.map((r) => `<tr>
        <td data-label="Player" data-role="primary"><span class="mrow-name">${memberLink(r.memberId, r.playerName)}</span><span class="mrow-sub">${esc(r.chestName)}</span></td>
        <td data-label="Chest">${esc(r.chestName)}</td>
        <td data-label="Source">${esc(r.chestSource || '')}</td>
        <td data-label="Received" data-role="metric">${formatDate(r.effectiveAt)}</td>
      </tr>`).join('')}
    </tbody></table>${recentPagination}`;

  el.innerHTML = `
    <div class="card"><div class="card-header"><h2>About triumphal chests</h2></div><div class="card-body card-body-padded">
      <p class="muted-copy">Triumphal chests come from in-game package purchases. Each chest is worth one third of its package value, shown rounded to a whole number — Magic ≈83, Precious ≈33, Golden ≈17, Silver ≈7, Bronze ≈3, Wooden ≈2 — so a full set of three sums back to the package value (3 Golden = 50). These points are tracked separately from the main leaderboard.</p>
      ${headerStats}
    </div></div>
    ${boardCardHtml}
    <div class="card"><div class="card-header"><h2>Recent chests</h2></div><div class="card-body card-body-padded">
      <details>
        <summary class="collapse-toggle">Show recent chests${recentTotal > 0 ? ` (${recentTotal.toLocaleString()})` : ''}</summary>
        <div class="details-content">${recentBody}</div>
      </details>
    </div></div>
  `;
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
// Mirrors the matching helpers on the leaderboard page. Period state
// is shared (lib/state.js, persisted to localStorage) so a user's
// choice carries between the two pages, but the URL anchor is encoded
// per-page so a shared link lands on the right page in the right window.

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
