// Public read-only share page. Mounted at /<token> on a per-clan basis.
// No auth, no user/admin actions, no Discord, no settings — just
// Leaderboard + (optional) ChestTracker tab.
//
// Leaderboard rendering, period math, sort logic and label formatting
// all flow through the same shared lib/* modules used by the
// authenticated app — so a fix on the auth side automatically applies
// here too. The data path is also shared: both `/api/leaderboard` and
// `/api/public/:token/leaderboard` go through the same chest-repo
// `getLeaderboard()` query.

import { esc } from './lib/ui.js';
import { computeGameWindow } from './lib/period.js';
import { setGameDayRolloverUtcHour } from './lib/state.js';
import {
  sortLeaderboardEntries,
  renderLeaderboardCardHtml,
} from './lib/leaderboard-render.js';
import {
  renderSnapshotDetailCardHtml,
  renderShareCodeSelect,
  renderArchivedNotice,
} from './lib/chesttracker-render.js';
import { initMobileRows } from './lib/mobile-rows.js';

const PATH_TOKEN_RE = /^\/([A-Za-z0-9]{6})\/?$/;
const tokenMatch = window.location.pathname.match(PATH_TOKEN_RE);
const token = tokenMatch ? tokenMatch[1] : null;

if (!token) {
  document.getElementById('content').innerHTML =
    '<div class="empty-state"><p>Invalid share link.</p></div>';
} else {
  start();
}

function start() {
  const API = `/api/public/${token}`;
  const PAGE_SIZE = 25;

  let ctEnabled = false;
  // The clan's weekly points goal, from /clan. null when they haven't set one,
  // in which case the board renders exactly as it did before the feature.
  let goalWeeklyPoints = null;
  let currentTab = 'leaderboard';
  let currentPeriod = 'daily';
  let currentPeriodOffset = 0;
  let currentPage = 1;
  let leaderboardSort = { key: 'rank', dir: 'asc' };
  // Which ChestTracker code the tab is showing. null = the clan's live
  // one; set when the visitor picks an archived tracker.
  let selectedShareCode = null;

  // ── Best-effort analytics beacon ──────────────────────────────────
  // We report only aggregates, no identity. "New vs returning" is decided
  // locally from a per-link localStorage flag and reported as a boolean —
  // nothing that identifies the visitor leaves the browser. The 'enter'
  // beacon fires on load; the 'leave' beacon (visit duration + whether the
  // viewer changed timeframe) fires once on pagehide.
  const visitStartedAt = Date.now();
  let changedTimeframe = false;
  let leaveSent = false;

  function isReturningVisitor() {
    const key = `tbcc_seen_${token}`;
    try {
      if (localStorage.getItem(key)) return true;
      localStorage.setItem(key, '1');
      return false;
    } catch {
      // Private mode / storage blocked — treat as a fresh visitor.
      return false;
    }
  }

  function sendBeacon(payload) {
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon(`/api/public/${token}/beacon`, blob);
    } catch {
      // sendBeacon unsupported or blocked — analytics are optional.
    }
  }

  function sendLeaveBeacon() {
    if (leaveSent) return;
    leaveSent = true;
    sendBeacon({
      event: 'leave',
      durationMs: Date.now() - visitStartedAt,
      changedTimeframe,
    });
  }

  // Action names used by the shared leaderboard renderer. The strings
  // themselves don't matter as long as the local click handler below
  // and the renderer agree on them — the auth app uses different
  // strings to keep its multi-page action dispatcher unambiguous.
  const ACTIONS = {
    setPeriod: 'set-period',
    periodPrev: 'period-prev',
    periodNext: 'period-next',
    pagePrev: 'page-prev',
    pageNext: 'page-next',
    sort: 'sort',
  };

  async function fetchJson(url) {
    const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }

  async function renderLeaderboard() {
    const el = document.getElementById('content');
    el.innerHTML = '<div class="empty-state"><p>Loading…</p></div>';
    const params = new URLSearchParams({ includeAll: '1' });
    const win = computeGameWindow(currentPeriod, currentPeriodOffset);
    if (win) { params.set('from', win.from); params.set('to', win.to); }

    let rows;
    try {
      rows = await fetchJson(`${API}/leaderboard?${params.toString()}`);
    } catch {
      el.innerHTML = '<div class="empty-state"><p>Failed to load leaderboard.</p></div>';
      return;
    }

    const sorted = sortLeaderboardEntries(rows, leaderboardSort.key, leaderboardSort.dir);
    // Whole result set, not the visible page — see the auth page's note.
    const showMight = rows.some((e) => e.might != null || e.heroLevel != null);
    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const pageEntries = sorted.slice(startIdx, startIdx + PAGE_SIZE);

    el.innerHTML = renderLeaderboardCardHtml({
      pageEntries,
      totalEntries: sorted.length,
      currentPage,
      totalPages,
      period: currentPeriod,
      offset: currentPeriodOffset,
      sortState: leaderboardSort,
      // rolloverHr defaults to whatever we pushed into shared state
      // during init() from the /clan response.
      pageSize: PAGE_SIZE,
      // Public page can't link to member detail (no auth, no router) —
      // render plain text instead of the auth memberLink helper.
      playerCellHtml: (e) => esc(e.memberName),
      actions: ACTIONS,
      showMight,
      goalWeeklyPoints,
    });
  }

  async function renderChestTracker() {
    const el = document.getElementById('content');
    el.innerHTML = '<div class="empty-state"><p>Loading…</p></div>';
    let data;
    let codes = [];
    try {
      const suffix = selectedShareCode
        ? `?shareCode=${encodeURIComponent(selectedShareCode)}`
        : '';
      // The code list is best-effort: without it we just show the current
      // tracker with no picker, exactly as this page behaved before.
      [data, codes] = await Promise.all([
        fetchJson(`${API}/external/latest${suffix}`),
        fetchJson(`${API}/external/share-codes`)
          .then((r) => r.rows || [])
          .catch(() => []),
      ]);
    } catch {
      el.innerHTML = '<div class="empty-state"><p>Failed to load ChestTracker data.</p></div>';
      return;
    }
    const shareCode = data.shareCode || '';
    selectedShareCode = shareCode || null;
    const title = shareCode
      ? `ChestTracker.com data (${esc(shareCode)})`
      : 'ChestTracker.com data';
    const codeInfo = codes.find((c) => c.shareCode === shareCode) || null;
    // Public page has no scheduler state, so fetchedAtTooltip is left
    // undefined — the shared renderer falls back to the formatted date.
    el.innerHTML = renderSnapshotDetailCardHtml({
      detail: data.snapshot,
      title,
      lastCheckedAt: data.lastCheckedAt || null,
      archiveSelect: renderShareCodeSelect(codes, shareCode),
      archivedNotice: data.isArchived ? renderArchivedNotice(codeInfo) : '',
    });
    el.querySelectorAll('[data-action="ext-select-share-code"]').forEach((sel) => {
      sel.addEventListener('change', () => {
        if (!sel.value || sel.value === selectedShareCode) return;
        selectedShareCode = sel.value;
        renderChestTracker();
      });
    });
  }

  function renderCurrentTab() {
    if (currentTab === 'chesttracker' && ctEnabled) {
      renderChestTracker();
    } else {
      currentTab = 'leaderboard';
      renderLeaderboard();
    }
    document.querySelectorAll('#shareNav a').forEach((a) => {
      a.classList.toggle('active', a.dataset.tab === currentTab);
    });
  }

  function wireEvents() {
    document.getElementById('shareNav').addEventListener('click', (ev) => {
      const a = ev.target.closest('a[data-tab]');
      if (!a) return;
      ev.preventDefault();
      const next = a.dataset.tab;
      if (next === 'chesttracker' && !ctEnabled) return;
      currentTab = next;
      renderCurrentTab();
    });

    // Mobile compact-row expand/collapse (delegated; survives re-renders).
    initMobileRows(document.getElementById('content'));

    document.getElementById('content').addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-action]');
      if (!t) return;
      const action = t.dataset.action;
      if (action === ACTIONS.setPeriod) {
        if (t.dataset.period !== currentPeriod) changedTimeframe = true;
        currentPeriod = t.dataset.period;
        currentPeriodOffset = 0;
        currentPage = 1;
        renderLeaderboard();
      } else if (action === ACTIONS.periodPrev) {
        currentPeriodOffset += 1;
        renderLeaderboard();
      } else if (action === ACTIONS.periodNext) {
        if (currentPeriodOffset > 0) {
          currentPeriodOffset -= 1;
          renderLeaderboard();
        }
      } else if (action === ACTIONS.pagePrev) {
        if (currentPage > 1) { currentPage -= 1; renderLeaderboard(); }
      } else if (action === ACTIONS.pageNext) {
        currentPage += 1;
        renderLeaderboard();
      } else if (action === ACTIONS.sort) {
        const key = t.dataset.sortKey;
        if (leaderboardSort.key === key) {
          leaderboardSort.dir = leaderboardSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          leaderboardSort.key = key;
          leaderboardSort.dir = (key === 'name' || key === 'rank') ? 'asc' : 'desc';
        }
        currentPage = 1;
        renderLeaderboard();
      }
    });
  }

  async function init() {
    let info;
    try {
      info = await fetchJson(`${API}/clan`);
    } catch {
      document.getElementById('content').innerHTML =
        '<div class="empty-state"><p>This share link is invalid or has been revoked.</p></div>';
      return;
    }
    document.getElementById('clanName').textContent = info.clanName || 'TB Chest Counter';
    document.title = `${info.clanName || 'Clan'} · Leaderboard`;
    if (Number.isFinite(info.gameDayRolloverUtcHour)) {
      // Push into the same shared state slot the auth app uses, so
      // computeGameWindow / formatPeriodLabel pick it up automatically.
      setGameDayRolloverUtcHour(info.gameDayRolloverUtcHour);
    }
    ctEnabled = !!info.ctEnabled;
    goalWeeklyPoints = Number.isFinite(info.leaderboardWeeklyGoalPoints)
      ? info.leaderboardWeeklyGoalPoints
      : null;
    if (ctEnabled) {
      document.getElementById('ctTab').classList.remove('is-hidden');
    }
    wireEvents();
    renderCurrentTab();

    // Fire the analytics beacons: 'enter' now (new vs returning), 'leave'
    // once the page is being unloaded/backgrounded. pagehide is the reliable
    // unload signal on mobile; visibilitychange→hidden covers tab-switch and
    // is the last event many browsers guarantee before discarding the page.
    sendBeacon({ event: 'enter', isReturning: isReturningVisitor() });
    window.addEventListener('pagehide', sendLeaveBeacon);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') sendLeaveBeacon();
    });
  }

  init();
}
