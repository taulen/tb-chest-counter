// Public read-only share page. Mounted at /<token> on a per-clan basis.
// No auth, no user/admin actions, no Discord, no settings — just
// Leaderboard + (optional) ChestTracker tab.
//
// The board is the Members board's own build (lib/ranking-board.js: podium,
// bars against the goal and pace, bands, search, sort), so a fix there
// applies here too; a member opens their chest breakdown instead of a profile.
// The data path is shared as well: both `/api/leaderboard` and
// `/api/public/:token/leaderboard` go through the same chest-repo
// `getLeaderboard()` query.

import { esc, formatDate, formatCountdown } from './lib/ui.js';
import { computeGameWindow } from './lib/period.js';
import { setGameDayRolloverUtcHour, setWeekStart, getWeekStart } from './lib/state.js';
import { copyLeaderboardData, leaderboardWindowLabel } from './lib/leaderboard-render.js';
import {
  BOARD_PERIODS, boardQuery, boardWindows, buildBoard, podiumHtml, summaryHtml, toolsHtml, listHtml, wireBoardControls,
} from './lib/ranking-board.js';
import { initLeaderboardBreakdown } from './lib/leaderboard-breakdown.js';
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
import { bindLanguageSwitcher, t, tn } from './lib/i18n.js';
import { periodScrubberHtml, wirePeriodScrubber, errorStateHtml, wireRetry, emptyHtml } from './lib/ui-kit.js';
import { avatarHtml } from './lib/avatar.js';
import { heroAvatarHtml } from './lib/game-facts.js';

// The board's sorts: the Members board's, less the join date (the game roster
// behind it is for signed-in members only).
const SORTS = ['points', 'name', 'chests', 'might'];

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
    emptyHtml(t('Invalid share link.'));
} else {
  start();
}

function start() {
  const API = `/api/public/${token}`;

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
  // The board's window, band, sort and search (lib/ranking-board.js's state).
  const boardState = { period: 'weekly', offset: 0, band: 'all', sort: 'points', reverse: false, query: '' };
  // The board on screen, for the controls' in-place redraws.
  let shareBoard = null;
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

  // The board's own buttons (the Copy data button, the FAQ link in the
  // ChestTracker card); the click handler below routes them.
  const ACTIONS = {
    openFaq: 'open-faq',
    copyData: 'copy-data',
  };
  // The board on screen, for the per-player breakdown: which window its rows
  // are for (a click on another period moves the state before the new rows
  // land), and each row by member id, so the card can name the member and
  // their rank before its own fetch returns.
  let boardWindow = { period: boardState.period, offset: boardState.offset };
  let boardEntries = new Map();
  // Hover card + name → modal. Set up in wireEvents.
  let breakdown = null;

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
      items.push(`<span class="share-scan-item" title="${esc(formatDate(s.lastScanAt))}">${ICON_LAST_SCAN}<span>${t('Last scan {when}', { when: `<strong data-scan-ago>${esc(formatTimeAgo(s.lastScanAt))}</strong>` })}</span></span>`);
    }
    scanCountingDown = false;
    if (s?.scanning) {
      items.push(`<span class="share-scan-item is-scanning"><span class="share-scan-dot" aria-hidden="true"></span><strong>${t('Scanning…')}</strong></span>`);
    } else if (s && (s.due || s.nextScanInMs != null)) {
      const remainingMs = s.nextScanInMs != null ? nextScanRemainingMs(s) : 0;
      scanCountingDown = remainingMs > 0;
      const text = scanCountingDown
        ? t('Next scan in {time}', { time: `<strong data-scan-countdown>${esc(formatCountdown(remainingMs))}</strong>` })
        : t('Next scan: soon');
      const title = scanCountingDown ? ` title="${esc(formatDate(s.receivedAt + s.nextScanInMs))}"` : '';
      items.push(`<span class="share-scan-item"${title}>${ICON_NEXT_SCAN}<span>${text}</span></span>`);
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

  // Hero portraits for the podium, by member id. The board's rows carry no
  // pictures, but the breakdown answer (the hover card's) does — game art,
  // public like the board. A portrait doesn't depend on the window, so each
  // member is asked once per visit; null = asked, nobody linked.
  const portraits = new Map();

  /** The member's framed hero portrait when known, else their initial. */
  function podiumPicHtml(r) {
    const game = portraits.get(r.id);
    return (game && heroAvatarHtml(game, 44)) || avatarHtml({ username: r.name, avatar: null }, { size: 'lg' });
  }

  // How a member looks and opens on this board: no profile to link to here
  // (no auth, no router), so the row and the podium card are buttons that open
  // the player's chest breakdown, and hovering a row previews it. The podium
  // fills in hero portraits (loadPodiumPortraits); rows keep the initial.
  const LOOK = {
    tag: 'button',
    attrs: (r) => `type="button" data-breakdown-member="${Number(r.id)}" aria-haspopup="dialog"`,
    pic: (r, size) => (size === 'lg'
      ? `<span class="share-podium-pic" data-podium-pic="${Number(r.id)}">${podiumPicHtml(r)}</span>`
      : avatarHtml({ username: r.name, avatar: null }, { size })),
  };

  /** Fill the podium's portraits the board doesn't carry, once per member. */
  function loadPodiumPortraits(root, win) {
    for (const slot of root.querySelectorAll('[data-podium-pic]')) {
      const id = Number(slot.dataset.podiumPic);
      if (portraits.has(id)) continue;
      portraits.set(id, null);
      const params = new URLSearchParams();
      if (win) { params.set('from', win.from); params.set('to', win.to); }
      const qs = params.toString();
      fetchJson(`${API}/leaderboard/${id}/breakdown${qs ? `?${qs}` : ''}`)
        .then((data) => {
          if (!data?.game?.avatarUrl) return;
          portraits.set(id, data.game);
          const html = heroAvatarHtml(data.game, 44);
          document.querySelectorAll(`[data-podium-pic="${id}"]`).forEach((s) => { s.innerHTML = html; });
        })
        .catch(() => { /* the initial stays */ });
    }
  }

  // quiet: a background refresh — no "Loading…" swap, and a failed fetch
  // leaves the board on screen instead of replacing it with an error.
  async function renderLeaderboard({ quiet = false } = {}) {
    const seq = ++renderSeq;
    const el = document.getElementById('content');
    if (!quiet) {
      // The rows an open breakdown card is anchored to are about to go.
      breakdown?.reset();
      el.innerHTML = emptyHtml(t('Loading…'));
    }
    // The window this render fetches, kept so the label it paints is the one
    // its numbers belong to.
    const { period, offset } = boardState;
    const weekStart = getWeekStart();
    const windows = boardWindows({ period, offset, rolloverHr, weekStart });
    const { win, prev } = windows;

    let rows;
    let prevRows = null;
    try {
      // The window before rides along for the "vs last week" delta. compare=1
      // keeps it off the link's usage figures: one view is one read.
      [rows, prevRows] = await Promise.all([
        fetchJson(boardQuery(`${API}/leaderboard`, win?.from, win?.to)),
        prev
          ? fetchJson(`${boardQuery(`${API}/leaderboard`, prev.from, prev.to)}&compare=1`).catch(() => null)
          : Promise.resolve(null),
      ]);
      // A refusal can still arrive as JSON (an object where a list belongs).
      if (!Array.isArray(rows)) throw new Error('not a list');
    } catch {
      if (seq !== renderSeq || quiet) return;
      el.innerHTML = errorStateHtml(t('Failed to load leaderboard.'));
      wireRetry(el, () => renderLeaderboard());
      return;
    }
    if (seq !== renderSeq) return;

    // New rows, maybe a new window: breakdowns fetched for the old board are
    // stale (a finished scan is one reason this ran), and so is an open card.
    boardWindow = { period, offset };
    boardEntries = new Map(rows.map((e) => [e.memberId, e]));
    breakdown?.reset();

    shareBoard = buildBoard({
      entries: rows,
      prevEntries: Array.isArray(prevRows) ? prevRows : null,
      goal: goalInfo,
      period, offset, rolloverHr, weekStart, windows,
    });

    // A background refresh mid-search keeps the visitor typing where they were.
    const searching = quiet && document.activeElement?.matches?.('[data-mb-search]');
    const copyBtn = rows.length
      ? `<button type="button" class="btn share-copy" data-action="${ACTIONS.copyData}" title="${esc(t('Copy every player in this timeframe as text'))}">${esc(t('Copy data'))}</button>`
      : '';
    el.innerHTML = `<section class="mboard share-board" aria-label="${esc(t('Ranking board'))}">
        <div class="mboard-head">
          <p class="mboard-sub">${tn(rows.length, '{n} member', '{n} members', { n: rows.length })}<span class="mboard-hint"> · ${t('select a member for their chests')}</span></p>
          ${copyBtn}
        </div>
        ${periodScrubberHtml({ periods: BOARD_PERIODS, period, offset, rolloverHr, weekStart, win })}
        ${podiumHtml(shareBoard, LOOK)}
        ${summaryHtml(shareBoard, boardState)}
        ${toolsHtml(boardState, SORTS)}
        <div data-mb-list>${listHtml(shareBoard, boardState, LOOK)}</div>
      </section>`;
    const root = el.querySelector('.mboard');
    wireBoardControls(root, { state: boardState, sorts: SORTS, get: () => ({ board: shareBoard, look: LOOK, pinned: [] }) });
    wirePeriodScrubber(root, {
      onPeriod: (p) => {
        changedTimeframe = true;
        boardState.period = p;
        boardState.offset = 0;
        boardState.band = 'all';
        renderLeaderboard();
      },
      onStep: (delta) => {
        const next = boardState.offset + delta;
        if (next < 0) return;
        boardState.offset = next;
        boardState.band = 'all';
        renderLeaderboard();
      },
    });
    if (searching) {
      const input = root.querySelector('[data-mb-search]');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
    loadPodiumPortraits(el, win);
  }

  function openFaq(initialTab) {
    if (!faqSeen) {
      faqSeen = true;
      try { localStorage.setItem(FAQ_SEEN_KEY, '1'); } catch { /* not remembered */ }
      document.querySelectorAll('.share-faq.is-new')
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
    breakdown?.reset();
    const el = document.getElementById('content');
    el.innerHTML = emptyHtml(t('Loading…'));
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
      el.innerHTML = errorStateHtml(t('Failed to load ChestTracker data.'));
      wireRetry(el, () => renderChestTracker());
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
    document.querySelectorAll('#shareNav a[data-tab]').forEach((a) => {
      if (a.dataset.tab === currentTab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
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

    // Mobile compact-row expand/collapse for the ChestTracker tab's tables
    // (delegated; survives re-renders).
    initMobileRows(document.getElementById('content'));
    initSortableHeaders(document.getElementById('content'));

    // Per-player chest breakdown: hover a row, or click / tap a member. Always
    // for the window the board on screen was fetched for.
    breakdown = initLeaderboardBreakdown(document.getElementById('content'), {
      load: (memberId) => {
        const params = new URLSearchParams();
        const win = computeGameWindow(boardWindow.period, boardWindow.offset);
        if (win) { params.set('from', win.from); params.set('to', win.to); }
        const qs = params.toString();
        return fetchJson(`${API}/leaderboard/${memberId}/breakdown${qs ? `?${qs}` : ''}`);
      },
      context: (memberId) => {
        const e = boardEntries.get(memberId);
        return {
          memberName: e?.memberName || '',
          rank: e?.rank ?? null,
          windowLabel: leaderboardWindowLabel(boardWindow.period, boardWindow.offset, rolloverHr),
        };
      },
    });

    document.getElementById('content').addEventListener('click', (ev) => {
      const target = ev.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      // Period, band, sort and search are the board's own (wireBoardControls).
      if (action === ACTIONS.openFaq) {
        openFaq();
      } else if (action === ACTIONS.copyData) {
        if (shareBoard?.copy) copyLeaderboardData(target, shareBoard.copy);
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
        emptyHtml(t('This share link is invalid or has been revoked.'));
      return;
    }
    clanName = info.clanName || '';
    document.getElementById('clanName').textContent = info.clanName || 'TB Chest Counter';
    // The clan's own in-game logo replaces the app's chest mark once a scan
    // has read it (the name beside it says whose it is, so it's decorative).
    if (info.clanLogoUrl) {
      const mark = document.querySelector('.share-brand .brand-logo');
      const logo = document.createElement('img');
      logo.className = 'brand-logo share-clan-logo';
      logo.src = info.clanLogoUrl;
      logo.alt = '';
      logo.width = 36;
      logo.height = 36;
      logo.decoding = 'async';
      mark?.replaceWith(logo);
    }
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
      history: Array.isArray(info.leaderboardGoalHistory) ? info.leaderboardGoalHistory : [],
    };
    if (ctEnabled) {
      document.getElementById('ctTab').classList.remove('is-hidden');
    }
    if (!faqSeen) document.querySelector('.share-faq')?.classList.add('is-new');
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
