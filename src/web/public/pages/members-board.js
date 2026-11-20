// Members → the ranking board (redesign phase 2a, design C): the top three as a
// podium, then every member's chest points for a period as a bar against the
// clan's goal line and a pace line, banded ✓ Reached / ◐ On pace / ↓ Behind.
// The roster table it replaced as the default is one toggle away
// (pages/members.js renders it).
//
// Since Nov 20 2026 it is also THE leaderboard: the separate Leaderboard page
// folded into it at the clan's request, bringing the Year timeframe, chest
// counts, Guards, the Gold Pass mark, the podium, and FAQ / Export CSV / Copy
// data beside the page title. The window rides in the URL
// (#members?period=weekly&week=…, the same absolute anchors the Leaderboard
// used), and old #leaderboard links land here on the window they named.
//
// The board itself is lib/ranking-board.js, shared with the public share page.
// This page fetches and adds what only a signed-in member sees: /game/roster
// (picture, in-game rank, might, join date, "you", burning on the map), each
// row opening the member's profile.

import { api } from '../lib/api.js';
import { esc, memberHash, buildHash } from '../lib/ui.js';
import { t, tn } from '../lib/i18n.js';
import { periodAnchorFromOffset } from '../lib/period.js';
import { copyLeaderboardData } from '../lib/leaderboard-render.js';
import { openLeaderboardFaq } from '../lib/leaderboard-faq.js';
import {
  BOARD_PERIODS, BOARD_BANDS, boardQuery, boardWindows, buildBoard, podiumHtml, summaryHtml, toolsHtml, listHtml,
  wireBoardControls,
} from '../lib/ranking-board.js';
import {
  segHtml, periodScrubberHtml, wirePeriodScrubber, errorStateHtml, refusalText, wireRetry, setPageActions,
} from '../lib/ui-kit.js';
import { getCurrentUser, getGameDayRolloverUtcHour, getWeekStart } from '../lib/state.js';
import { avatarHtml } from '../lib/avatar.js';

export { BOARD_PERIODS };
const SORTS = ['points', 'name', 'chests', 'might', 'joined'];
const VIEW_KEY = 'tb.members.view';

const state = { period: 'weekly', offset: 0, band: 'all', sort: 'points', reverse: false, query: '' };
/** The last load, so search / sort / band only redraw the list. */
let board = null;
let rerenderPage = null;

// A member opens their profile; the picture is their account's (own photo,
// else their linked hero, else the initial).
const LOOK = {
  tag: 'a',
  attrs: (r) => `href="${memberHash(r.id)}"`,
  pic: (r, size) => avatarHtml({ username: r.name, avatar: r.avatar }, { size }),
};

/** 'board' (default) or 'table', remembered per browser. */
export function getMembersView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'board';
  } catch {
    return 'board';
  }
}

function setMembersView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view === 'table' ? 'table' : 'board');
  } catch { /* private window: the toggle still works for this page */ }
}

/**
 * Open the board on one band and period (Home's goal tile links here): the
 * next draw of Members starts on the board, filtered, for that window.
 */
export function presetMembersBoard({ band = 'all', period, offset } = {}) {
  if (BOARD_BANDS.includes(band)) state.band = band;
  if (BOARD_PERIODS.includes(period)) state.period = period;
  if (Number.isInteger(offset) && offset >= 0) state.offset = offset;
  state.query = '';
  setMembersView('board');
}

/**
 * The window the address names (#members?period=…&week=…, which only the board
 * writes): open the board on it. Search and band survive a return to the same
 * window — Back from a profile — and the band resets when the window moves.
 */
export function setMembersBoardWindow({ period, offset }) {
  if (!BOARD_PERIODS.includes(period) || !Number.isInteger(offset) || offset < 0) return;
  if (state.period !== period || state.offset !== offset) {
    state.period = period;
    state.offset = offset;
    state.band = 'all';
  }
  setMembersView('board');
}

/** The table view drops the board's window from the address: it isn't the table's. */
export function clearBoardAddress() {
  if (!window.location.hash.startsWith('#members?')) return;
  try {
    history.replaceState(history.state, '', '#members');
  } catch { /* harmless: the next board draw rewrites it */ }
}

/** Board | Table, the same two buttons on both views. */
export function membersViewToggleHtml(active) {
  return segHtml({
    label: t('View'),
    items: [{ value: 'board', label: t('Board') }, { value: 'table', label: t('Table') }],
    current: active,
    attr: 'mb-view',
  });
}

/** Wire the toggle on a freshly drawn view; `rerender` draws the page again. */
export function wireMembersViewToggle(root, rerender) {
  for (const b of root.querySelectorAll('[data-mb-view]')) {
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-pressed') === 'true') return;
      setMembersView(b.dataset.mbView);
      rerender();
    });
  }
}

/**
 * The board's window as URL params — `{ period, week: '2026-11-15' }` — the
 * absolute anchors the Leaderboard's links always used, so a copied link opens
 * the same week forever, not "last week" relative to whenever it is opened.
 */
function windowParams(period, offset) {
  const params = { period };
  const anchor = periodAnchorFromOffset(period, offset);
  if (anchor) params[anchor.key] = anchor.value;
  return params;
}

/**
 * Put the window on screen into the address bar without a navigation (no
 * hashchange, so no second render), and only while the Members page is the
 * one showing — never over a profile the user has already moved on to.
 */
function syncAddress(period, offset) {
  const hash = window.location.hash.replace(/^#/, '').split('?')[0];
  if (hash !== 'members') return;
  const next = buildHash('members', windowParams(period, offset));
  if (window.location.hash === next) return;
  try {
    history.replaceState(history.state, '', next);
  } catch { /* a sandboxed frame: the board works, the address just lags */ }
}

/**
 * Draw the board into `el`. `tabsHtml` is the Members / Might strip;
 * `rerender` draws the Members page again (after the view toggle).
 */
export async function renderMembersBoard(el, { tabsHtml = '', rerender } = {}) {
  const rolloverHr = getGameDayRolloverUtcHour();
  const weekStart = getWeekStart();
  const { period, offset } = state;
  const windows = boardWindows({ period, offset, rolloverHr, weekStart });
  const { win, prev } = windows;
  let [entries, prevEntries, goal, roster] = await Promise.all([
    api(boardQuery('/leaderboard', win?.from, win?.to)),
    prev ? api(boardQuery('/leaderboard', prev.from, prev.to)).catch(() => null) : Promise.resolve(null),
    api('/leaderboard/goal').catch(() => null),
    api('/game/roster').catch(() => ({ members: {} })),
  ]);
  // A later click (another period) already started its own draw.
  if (state.period !== period || state.offset !== offset) return;
  syncAddress(period, offset);

  // api() hands back whatever JSON the server sent, so a refusal (a 429 from
  // the /api rate limit, a 500's { error, ref }) arrives as an OBJECT where a
  // list was expected. A member's phone hit exactly that on Nov 18 2026 and the
  // page died on `.map`. The comparison window is optional: drop it. The
  // window itself is the board: say what happened and offer a retry.
  if (!Array.isArray(entries)) {
    setPageActions('');
    el.innerHTML = `${tabsHtml}<section class="mboard" aria-label="${esc(t('Ranking board'))}">
      ${errorStateHtml(t('The board could not be loaded.'), refusalText(entries))}
    </section>`;
    wireRetry(el, () => renderMembersBoard(el, { tabsHtml, rerender }));
    return;
  }
  if (!Array.isArray(prevEntries)) prevEntries = null;

  const game = roster?.members || {};
  board = buildBoard({
    entries, prevEntries, goal, period, offset, rolloverHr, weekStart, windows,
    extra: (e) => {
      const g = game[e.memberId] || {};
      return {
        might: g.might ?? e.might ?? null,
        role: g.role ?? null,
        joinedAt: g.joinedAt ? g.joinedAt * 1000 : null,
        burning: g.burning === true,
        isYou: g.isYou === true,
        avatar: g.avatar ?? null,
      };
    },
  });
  rerenderPage = rerender;

  el.innerHTML = `${tabsHtml}<section class="mboard" aria-label="${esc(t('Ranking board'))}">
    ${headHtml(board.rows.length)}
    ${periodScrubberHtml({ periods: BOARD_PERIODS, period, offset, rolloverHr, weekStart, win })}
    ${podiumHtml(board, LOOK)}
    ${summaryHtml(board, state)}
    ${toolsHtml(state, SORTS)}
    <div data-mb-list>${listHtml(board, state, LOOK, { pinned: pinnedRows() })}</div>
  </section>`;
  setPageActions(pageActionsHtml(`/api${boardQuery('/leaderboard', win?.from, win?.to)}&format=csv`, board.rows.length > 0));
  wire(el);
}

/** Every one of your players (alts, v130), in board order, pinned on top for a member. */
function pinnedRows() {
  return getCurrentUser()?.role === 'user' ? board.rows.filter((r) => r.isYou) : [];
}

/** The page header already says "Members": this line is the count + the view toggle. */
function headHtml(count) {
  return `<div class="mboard-head">
      <p class="mboard-sub">${tn(count, '{n} member', '{n} members', { n: count })}<span class="mboard-hint"> · ${t('select a member for their profile')}</span></p>
      ${membersViewToggleHtml('board')}
    </div>`;
}

/**
 * FAQ, Export CSV (the window on screen) and Copy data, beside the page title.
 * app.js routes the two buttons (open-leaderboard-faq, leaderboard-copy-data)
 * to openBoardFaq / copyBoardData below. Export is a plain link: the browser
 * downloads it, and Content-Disposition names the file.
 */
function pageActionsHtml(exportHref, hasRows) {
  return `<button type="button" class="btn" data-action="open-leaderboard-faq" title="${esc(t('What each chest is worth, and how the board works'))}">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.1 6.3a1.95 1.95 0 1 1 2.7 1.8c-.52.22-.8.62-.8 1.18v.32" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.7" r=".9" fill="currentColor"/></svg>
      ${esc(t('FAQ'))}
    </button>
    <a class="btn" href="${esc(exportHref)}" download title="${esc(t('Download this timeframe as CSV'))}">${esc(t('Export CSV'))}</a>
    ${hasRows ? `<button type="button" class="btn" data-action="leaderboard-copy-data" title="${esc(t('Copy every player in this timeframe as text'))}">${esc(t('Copy data'))}</button>` : ''}`;
}

/** The FAQ: what each chest is worth, and how the board works. */
export function openBoardFaq() {
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

/** Every member of the window on screen as text, for pasting into the game's chat. */
export function copyBoardData(btn) {
  if (board?.copy) return copyLeaderboardData(btn, board.copy);
}

function wire(el) {
  const root = el.querySelector('.mboard');
  wireMembersViewToggle(root, () => rerenderPage?.());
  wireBoardControls(root, { state, sorts: SORTS, get: () => ({ board, look: LOOK, pinned: pinnedRows() }) });
  const redraw = () => renderMembersBoard(el, { tabsHtml: el.querySelector('.view-tabs')?.outerHTML ?? '', rerender: rerenderPage });
  wirePeriodScrubber(root, {
    onPeriod: (p) => { state.period = p; state.offset = 0; state.band = 'all'; void redraw(); },
    onStep: (delta) => { state.offset = Math.max(0, state.offset + delta); state.band = 'all'; void redraw(); },
  });
}
