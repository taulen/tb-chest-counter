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

import { esc, formatDate, formatCountdown } from './lib/ui.js';
import { computeGameWindow } from './lib/period.js';
import { weeklyGoalForWindow, amberRatioForWindow } from './lib/weekly-goal.js';
import { setGameDayRolloverUtcHour, setWeekStart } from './lib/state.js';
import {
  sortLeaderboardEntries,
  renderLeaderboardCardHtml,
  copyLeaderboardData,
} from './lib/leaderboard-render.js';
import {
  renderSnapshotDetailCardHtml,
  renderShareCodeSelect,
  renderArchivedNotice,
  formatTimeAgo,
} from './lib/chesttracker-render.js';
import { initMobileRows } from './lib/mobile-rows.js';
import { initSortableHeaders } from './lib/sort-headers.js';
import { openLeaderboardFaq } from './lib/leaderboard-faq.js';
import { bindThemeSwitcher } from './lib/theme.js';
import { bindLanguageSwitcher, t } from './lib/i18n.js';

// Mirrors SHARE_TOKEN_REGEX on the server: a generated 6-char token OR an
// admin-chosen vanity key (3-10 chars, a-z0-9). The server already refused to
// serve this page for anything that doesn't resolve, so this only has to be
// wide enough not to reject a key the server accepted.
const PATH_TOKEN_RE = /^\/([A-Za-z0-9]{3,10})\/?$/;
const tokenMatch = window.location.pathname.match(PATH_TOKEN_RE);
const token = tokenMatch ? tokenMatch[1] : null;

// The theme picker works even on a dead link. No server sync: there is no
// session here to save the choice against, so it lives in this browser.
bindThemeSwitcher(document, { syncServer: false });
bindLanguageSwitcher(document, { syncServer: false });

if (!token) {
  document.getElementById('content').innerHTML =
    `<div class="empty-state"><p>${t('Invalid share link.')}</p></div>`;
} else {
  start();
}

function start() {
  const API = `/api/public/${token}`;
  const PAGE_SIZE = 25;

  let ctEnabled = false;
  // The clan's weekly points goal and its earlier values, from /clan, in the
  // /api/leaderboard/goal shape. weeklyPoints null when they haven't set one,
  // in which case the board renders exactly as it did before the feature.
  let goalInfo = null;
  let clanName = '';
  let rolloverHr = 17;
  // Bumped by every render of #content. A render that awaited its fetch and
  // finds the number moved on is stale and must not write: without this, a
  // slower response landed last and won — an earlier period's numbers painted
  // under the label just clicked, or the tab the visitor left overwriting the
  // one they picked. The authenticated router guards the same way (navToken).
  let renderSeq = 0;
  // Whether this browser has opened the FAQ before. Until it has, the tab
  // row's FAQ link carries a "new" dot. One flag for every share link — the FAQ
  // reads the same from all of them apart from the clan's names.
  const FAQ_SEEN_KEY = 'tbcc_faq_seen';
  let faqSeen = (() => {
    try {
      return !!localStorage.getItem(FAQ_SEEN_KEY);
    } catch {
      // Storage blocked: show the dot; it just won't be remembered.
      return false;
    }
  })();
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
    openFaq: 'open-faq',
    copyData: 'copy-data',
  };
  // What the last leaderboard render showed, for the Copy data button.
  let lastCopy = null;

  async function fetchJson(url) {
    const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }

  // ── Last scan / next scan strip ───────────────────────────────────
  // /scan-status is polled (it isn't counted as an API hit); the strip's
  // numbers tick every second in between, by touching only the two <strong>s
  // so a hover tooltip on either item isn't torn down under the pointer.
  // Every 15 s while a scan is running or due, so the board picks up the new
  // chests soon after it ends; every minute otherwise.
  const SCAN_POLL_MS = 60_000;
  const SCAN_POLL_BUSY_MS = 15_000;
  const ICON_LAST_SCAN = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.85" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2.4 2.5v2.8h2.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 5.2v3l2 1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_NEXT_SCAN = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.5 2h7M4.5 14h7M5.2 2c0 2.9 2.8 3.9 2.8 6s-2.8 3.1-2.8 6M10.8 2c0 2.9-2.8 3.9-2.8 6s2.8 3.1 2.8 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // The last /scan-status answer — { lastScanAt, scanning, due, nextScanInMs }
  // — plus receivedAt, this browser's clock when it arrived.
  let scanStatus = null;
  // Whether the strip last rendered "Next scan in …" (vs "soon"), so the tick
  // knows when the countdown ran out and the wording has to change.
  let scanCountingDown = false;
  let scanPollTimer = null;

  // The server sends time REMAINING, so the countdown runs on this browser's
  // clock from the moment the answer arrived: a device whose clock is off
  // still counts down to the right moment, and never reads "due" as a
  // second-long countdown (the server says due outright).
  function stampScanStatus(s) {
    return { ...s, receivedAt: Date.now() };
  }

  function nextScanRemainingMs(s) {
    return s.receivedAt + s.nextScanInMs - Date.now();
  }

  function renderScanStatus() {
    const el = document.getElementById('scanStatus');
    const s = scanStatus;
    const items = [];
    if (s?.lastScanAt) {
      items.push(`<span class="public-share-scan-item" title="${esc(formatDate(s.lastScanAt))}">${ICON_LAST_SCAN}<span>${t('Last scan {when}', { when: `<strong data-scan-ago>${esc(formatTimeAgo(s.lastScanAt))}</strong>` })}</span></span>`);
    }
    scanCountingDown = false;
    if (s?.scanning) {
      items.push(`<span class="public-share-scan-item is-scanning"><span class="public-share-scan-dot" aria-hidden="true"></span><strong>${t('Scanning…')}</strong></span>`);
    } else if (s && (s.due || s.nextScanInMs != null)) {
      const remainingMs = s.nextScanInMs != null ? nextScanRemainingMs(s) : 0;
      scanCountingDown = remainingMs > 0;
      const text = scanCountingDown
        ? t('Next scan in {time}', { time: `<strong data-scan-countdown>${esc(formatCountdown(remainingMs))}</strong>` })
        : t('Next scan: soon');
      const title = scanCountingDown ? ` title="${esc(formatDate(s.receivedAt + s.nextScanInMs))}"` : '';
      items.push(`<span class="public-share-scan-item"${title}>${ICON_NEXT_SCAN}<span>${text}</span></span>`);
    }
    el.innerHTML = items.join('');
    // Leaderboard only: ChestTracker's numbers come from its own site, not our scans.
    el.classList.toggle('is-hidden', items.length === 0 || currentTab !== 'leaderboard');
  }

  function tickScanStatus() {
    const s = scanStatus;
    if (!s) return;
    if (scanCountingDown && nextScanRemainingMs(s) <= 0) {
      renderScanStatus();
      // The scan starts on the dot: ask again shortly instead of reading
      // "soon" for up to a whole poll interval.
      scheduleScanPoll(5_000);
      return;
    }
    const el = document.getElementById('scanStatus');
    const ago = el.querySelector('[data-scan-ago]');
    if (ago) ago.textContent = formatTimeAgo(s.lastScanAt);
    const countdown = el.querySelector('[data-scan-countdown]');
    if (countdown) countdown.textContent = formatCountdown(nextScanRemainingMs(s));
  }

  // One timer, so a visibility change or a countdown running out can pull the
  // next poll forward without starting a second chain.
  function scheduleScanPoll(ms) {
    clearTimeout(scanPollTimer);
    scanPollTimer = setTimeout(refreshScanStatus, ms);
  }

  async function refreshScanStatus() {
    clearTimeout(scanPollTimer);
    // No polling from a background tab; visibilitychange restarts it.
    if (document.visibilityState !== 'visible') return;
    let next;
    try {
      next = stampScanStatus(await fetchJson(`${API}/scan-status`));
    } catch {
      // Keep showing the last answer; try again later.
      scheduleScanPoll(SCAN_POLL_MS);
      return;
    }
    const prevLastScanAt = scanStatus?.lastScanAt ?? null;
    scanStatus = next;
    renderScanStatus();
    scheduleScanPoll(next.scanning || next.due ? SCAN_POLL_BUSY_MS : SCAN_POLL_MS);
    // A scan finished while the page was open: bring in its chests too, or the
    // strip would say "just now" over a board from before it.
    if (prevLastScanAt && next.lastScanAt && next.lastScanAt !== prevLastScanAt && currentTab === 'leaderboard') {
      renderLeaderboard({ quiet: true });
    }
  }

  // quiet: a background refresh — no "Loading…" swap, and a failed fetch
  // leaves the board on screen instead of replacing it with an error.
  async function renderLeaderboard({ quiet = false } = {}) {
    const seq = ++renderSeq;
    const el = document.getElementById('content');
    if (!quiet) el.innerHTML = `<div class="empty-state"><p>${t('Loading…')}</p></div>`;
    // The window this render fetches, kept so the label it paints is the one
    // its numbers belong to.
    const period = currentPeriod;
    const offset = currentPeriodOffset;
    const params = new URLSearchParams({ includeAll: '1' });
    const win = computeGameWindow(period, offset);
    if (win) { params.set('from', win.from); params.set('to', win.to); }

    let rows;
    try {
      rows = await fetchJson(`${API}/leaderboard?${params.toString()}`);
    } catch {
      if (seq !== renderSeq || quiet) return;
      el.innerHTML = `<div class="empty-state"><p>${t('Failed to load leaderboard.')}</p></div>`;
      return;
    }
    if (seq !== renderSeq) return;

    const sorted = sortLeaderboardEntries(rows, leaderboardSort.key, leaderboardSort.dir);
    // Whole result set, not the visible page — see the auth page's note.
    const showMight = rows.some((e) => e.might != null || e.heroLevel != null);
    const showGuards = rows.some((e) => e.guardsLevel != null);
    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const pageEntries = sorted.slice(startIdx, startIdx + PAGE_SIZE);
    // The goal this window was played under, not necessarily today's.
    const goalWeeklyPoints = weeklyGoalForWindow(goalInfo, period, offset);
    const goalWarnRatio = amberRatioForWindow(goalInfo, period, offset);
    lastCopy = { entries: sorted, period, offset, rolloverHr, goalWeeklyPoints, goalWarnRatio };

    el.innerHTML = renderLeaderboardCardHtml({
      pageEntries,
      totalEntries: sorted.length,
      currentPage,
      totalPages,
      period,
      offset,
      sortState: leaderboardSort,
      // rolloverHr defaults to whatever we pushed into shared state
      // during init() from the /clan response.
      pageSize: PAGE_SIZE,
      // Public page can't link to member detail (no auth, no router) —
      // render plain text instead of the auth memberLink helper.
      playerCellHtml: (e) => esc(e.memberName),
      // No FAQ button on the card: the tab row's "FAQ & access" is always on
      // screen, on either tab, and two of the same button read as a mistake.
      actions: { ...ACTIONS, openFaq: null },
      showMight,
      showGuards,
      goalWeeklyPoints,
      goalWarnRatio,
    });
  }

  function openFaq(initialTab) {
    if (!faqSeen) {
      faqSeen = true;
      try { localStorage.setItem(FAQ_SEEN_KEY, '1'); } catch { /* not remembered */ }
      document.querySelectorAll('.public-share-nav-faq.is-new')
        .forEach((b) => b.classList.remove('is-new'));
    }
    openLeaderboardFaq({
      load: () => fetchJson(`${API}/faq`),
      mode: 'public',
      clanName,
      rolloverHr,
      initialTab,
    });
  }

  async function renderChestTracker() {
    const seq = ++renderSeq;
    const el = document.getElementById('content');
    el.innerHTML = `<div class="empty-state"><p>${t('Loading…')}</p></div>`;
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
      if (seq !== renderSeq) return;
      el.innerHTML = `<div class="empty-state"><p>${t('Failed to load ChestTracker data.')}</p></div>`;
      return;
    }
    if (seq !== renderSeq) return;
    const shareCode = data.shareCode || '';
    selectedShareCode = shareCode || null;
    const title = shareCode
      ? t('ChestTracker.com data ({code})', { code: esc(shareCode) })
      : t('ChestTracker.com data');
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
    renderScanStatus();
  }

  function wireEvents() {
    document.getElementById('shareNav').addEventListener('click', (ev) => {
      if (ev.target.closest('[data-open-faq]')) {
        ev.preventDefault();
        openFaq();
        return;
      }
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
    initSortableHeaders(document.getElementById('content'));

    document.getElementById('content').addEventListener('click', (ev) => {
      const target = ev.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === ACTIONS.setPeriod) {
        if (target.dataset.period !== currentPeriod) changedTimeframe = true;
        currentPeriod = target.dataset.period;
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
        const key = target.dataset.sortKey;
        if (leaderboardSort.key === key) {
          leaderboardSort.dir = leaderboardSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          leaderboardSort.key = key;
          leaderboardSort.dir = (key === 'name' || key === 'rank') ? 'asc' : 'desc';
        }
        currentPage = 1;
        renderLeaderboard();
      } else if (action === ACTIONS.openFaq) {
        openFaq();
      } else if (action === ACTIONS.copyData) {
        if (lastCopy) copyLeaderboardData(target, lastCopy);
      }
    });
  }

  async function init() {
    // In parallel with /clan, and awaited before the first render, so the
    // strip is there with the board instead of popping in above it a beat later.
    const scanStatusLoad = fetchJson(`${API}/scan-status`).then(stampScanStatus).catch(() => null);
    let info;
    try {
      info = await fetchJson(`${API}/clan`);
    } catch {
      document.getElementById('content').innerHTML =
        `<div class="empty-state"><p>${t('This share link is invalid or has been revoked.')}</p></div>`;
      return;
    }
    clanName = info.clanName || '';
    document.getElementById('clanName').textContent = info.clanName || 'TB Chest Counter';
    document.title = t('{clan} · Leaderboard', { clan: info.clanName || t('Clan') });
    if (Number.isFinite(info.gameDayRolloverUtcHour)) {
      rolloverHr = info.gameDayRolloverUtcHour;
      // Push into the same shared state slot the auth app uses, so
      // computeGameWindow / formatPeriodLabel pick it up automatically.
      setGameDayRolloverUtcHour(info.gameDayRolloverUtcHour);
    }
    // Sunday or Tinman-to-Tinman weeks — same shared slot, same reason.
    setWeekStart(info.weekStart);
    ctEnabled = !!info.ctEnabled;
    goalInfo = {
      weeklyPoints: Number.isFinite(info.leaderboardWeeklyGoalPoints) ? info.leaderboardWeeklyGoalPoints : null,
      amberPct: Number.isFinite(info.leaderboardGoalAmberPct) ? info.leaderboardGoalAmberPct : null,
      history: Array.isArray(info.leaderboardGoalHistory) ? info.leaderboardGoalHistory : [],
    };
    if (ctEnabled) {
      document.getElementById('ctTab').classList.remove('is-hidden');
    }
    if (!faqSeen) document.querySelector('.public-share-nav-faq')?.classList.add('is-new');
    scanStatus = await scanStatusLoad;
    wireEvents();
    renderCurrentTab();
    setInterval(tickScanStatus, 1000);
    scheduleScanPoll(scanStatus?.scanning || scanStatus?.due ? SCAN_POLL_BUSY_MS : SCAN_POLL_MS);
    // A background tab stops polling (refreshScanStatus); catch up the moment
    // it's looked at again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshScanStatus();
    });
    // Deep links an admin can hand out: /<key>#faq opens the FAQ, /<key>#join
    // opens it straight on "Get full access".
    if (window.location.hash === '#faq') openFaq();
    else if (window.location.hash === '#join') openFaq('access');

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
