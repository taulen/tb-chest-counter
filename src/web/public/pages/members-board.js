// Members → the ranking board (redesign phase 2a, design C): every member's
// chest points for a period as a bar against the clan's goal line and a pace
// line, banded ✓ Reached / ◐ On pace / ↓ Behind. The roster table it replaced
// as the default is one toggle away (pages/members.js renders it).
//
// Since Nov 20 2026 it is also THE leaderboard: the separate Leaderboard page
// (podium + ranked table) folded into it at the clan's request, bringing the
// Yearly timeframe, chest counts, Guards and the Gold Pass mark, and FAQ /
// Export CSV / Copy data beside the page title. The window rides in the URL
// (#members?period=weekly&week=…, the same absolute anchors the Leaderboard
// used), and old #leaderboard links land here on the window they named.
//
// Data: /leaderboard for the window (all members, canonical rank) and for the
// window before it (the "vs last week" delta — cut at the same point of the
// week while this one is still running, so it compares like with like),
// /leaderboard/goal (the goal THIS window was played under), /game/roster
// (picture, in-game rank, "you", the city on the map) and
// /game/clan/roster-changes (who joined or left lately).

import { api } from '../lib/api.js';
import { esc, memberHash, formatDateShort, formatRelativeTime, buildHash } from '../lib/ui.js';
import { t, tn } from '../lib/i18n.js';
import { computeGameWindow, periodAnchorFromOffset } from '../lib/period.js';
import {
  scaleGoalForPeriod, formatMightCompact, goalStatusFor, pacePointsFor, paceFractionForWindow, copyLeaderboardData,
} from '../lib/leaderboard-render.js';
import { openLeaderboardFaq } from '../lib/leaderboard-faq.js';
import { goldPassBadgeHtml } from '../lib/guards-format.js';
import {
  BANDS as KIT_BANDS, segHtml, periodScrubberHtml, wirePeriodScrubber, errorStateHtml, refusalText, wireRetry,
  setPageActions,
} from '../lib/ui-kit.js';
import { weeklyGoalForWindow } from '../lib/weekly-goal.js';
import { getCurrentUser, getGameDayRolloverUtcHour, getWeekStart } from '../lib/state.js';
import { gameRankName } from '../lib/game-facts.js';
import { avatarHtml } from '../lib/avatar.js';

const DAY_MS = 86_400_000;
export const BOARD_PERIODS = ['daily', 'weekly', 'monthly', 'yearly', 'all'];
const PERIODS = BOARD_PERIODS;
const SORTS = ['points', 'name', 'chests', 'might', 'joined'];
const BANDS = ['all', 'ok', 'pace', 'behind'];
const VIEW_KEY = 'tb.members.view';
const NOTE_DAYS = 7;
const NOTE_NAMES = 5;

const state = { period: 'weekly', offset: 0, band: 'all', sort: 'points', query: '' };
/** The last load, so search / sort / band only redraw the list. */
let board = null;

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
  if (BANDS.includes(band)) state.band = band;
  if (PERIODS.includes(period)) state.period = period;
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
  if (!PERIODS.includes(period) || !Number.isInteger(offset) || offset < 0) return;
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

const SORT_LABEL = {
  points: () => t('Points'), name: () => t('Name'), chests: () => t('Chests'), might: () => t('Might'), joined: () => t('Joined'),
};
const BAND_TEXT = KIT_BANDS;
const DELTA_LABEL = {
  daily: { now: () => t('vs yesterday by now'), past: () => t('vs the day before') },
  weekly: { now: () => t('vs last week by now'), past: () => t('vs the week before') },
  monthly: { now: () => t('vs last month by now'), past: () => t('vs the month before') },
  yearly: { now: () => t('vs last year by now'), past: () => t('vs the year before') },
};

function leaderboardQuery(from, to) {
  const p = new URLSearchParams({ includeAll: '1' });
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  return `/leaderboard?${p}`;
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
  const win = computeGameWindow(period, offset, rolloverHr, weekStart);
  const now = Date.now();
  const running = !!win && offset === 0;
  // The window before, cut at the same point while this one is still running.
  let prevQuery = null;
  if (win) {
    const prev = computeGameWindow(period, offset + 1, rolloverHr, weekStart);
    const elapsed = now - Date.parse(win.from);
    const prevTo = running ? new Date(Math.min(Date.parse(prev.from) + elapsed, Date.parse(prev.to))).toISOString() : prev.to;
    prevQuery = leaderboardQuery(prev.from, prevTo);
  }
  let [entries, prevEntries, goal, roster, changes] = await Promise.all([
    api(leaderboardQuery(win?.from, win?.to)),
    prevQuery ? api(prevQuery).catch(() => []) : Promise.resolve([]),
    api('/leaderboard/goal').catch(() => null),
    api('/game/roster').catch(() => ({ members: {} })),
    api(`/game/clan/roster-changes?limit=40`).catch(() => ({ entries: [] })),
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
  if (!Array.isArray(prevEntries)) prevEntries = [];

  const weekly = period === 'all' ? null : weeklyGoalForWindow(goal, period, offset, rolloverHr, weekStart);
  const goalPts = period === 'all' ? null : scaleGoalForPeriod(weekly, period, weekStart);
  // The pace mark, the same one the share board, Analytics and the profile
  // colour by (lib/leaderboard-render.js); null once the window has ended.
  const paceFraction = running ? paceFractionForWindow(win, now) : null;
  const pacePts = pacePointsFor(goalPts, paceFraction);

  const prevByMember = new Map((prevEntries || []).map((e) => [e.memberId, e.totalPoints || 0]));
  const game = roster?.members || {};
  const rows = (entries || []).map((e) => {
    const g = game[e.memberId] || {};
    const points = e.totalPoints || 0;
    // An ended window has no pace: below the goal there is "behind".
    const status = goalStatusFor(points, goalPts, { pace: pacePts });
    const band = !status ? null : status === 'low' ? 'behind' : status;
    return {
      id: e.memberId,
      name: e.memberName,
      rank: e.rank,
      points,
      chests: e.totalChests || 0,
      delta: win ? points - (prevByMember.get(e.memberId) || 0) : null,
      band,
      might: g.might ?? e.might ?? null,
      guards: e.guardsLevel ?? null,
      goldPass: e.goldPass ?? null,
      role: g.role ?? null,
      joinedAt: g.joinedAt ? g.joinedAt * 1000 : null,
      burning: g.burning === true,
      mapSeenAt: g.mapSeenAt ?? null,
      isYou: g.isYou === true,
      avatar: g.avatar ?? null,
    };
  });

  board = {
    el, rows, goalPts, pacePts, running, win, rerender,
    // For Copy data: every member in rank order, with the goal and pace the
    // rows were judged by.
    copy: { entries, period, offset, rolloverHr, goalWeeklyPoints: weekly, paceFraction },
    // With a goal the bar spans up to twice it, so one runaway total doesn't
    // squash everyone else's bar to a sliver (the number shows the real total).
    scaleMax: goalPts
      ? Math.max(goalPts * 1.25, Math.min(Math.max(...rows.map((r) => r.points), 0), goalPts * 2))
      : Math.max(...rows.map((r) => r.points), 1),
    changes: Array.isArray(changes?.entries) ? changes.entries : [],
  };

  el.innerHTML = `${tabsHtml}<section class="mboard" aria-label="${esc(t('Ranking board'))}">
    ${headHtml(rows.length)}
    ${periodScrubberHtml({ periods: PERIODS, period: state.period, offset: state.offset, rolloverHr, weekStart, win: board.win })}
    ${notesHtml()}
    ${summaryHtml()}
    <div class="mboard-tools">
      <label class="mboard-search"><span class="visually-hidden">${t('Find a member')}</span>
        <input type="search" id="membersBoardSearch" class="input" placeholder="${esc(t('Find a member'))}" value="${esc(state.query)}" autocomplete="off"></label>
      <div class="mboard-sort" role="group" aria-label="${esc(t('Sort by'))}">
        <span class="ui-eyebrow" aria-hidden="true">${t('Sort by')}</span>
        ${SORTS.map((s) => `<button type="button" class="ui-chip${state.sort === s ? ' is-active' : ''}" aria-pressed="${state.sort === s}" data-mb-sort="${s}">${SORT_LABEL[s]()}</button>`).join('')}
      </div>
      ${/* The phone's sort: one compact select beside the search (style.css swaps them). */''}
      <label class="mboard-sort-pick" title="${esc(t('Sort by'))}">
        <span class="mboard-sort-icon" aria-hidden="true">⇅</span><span class="visually-hidden">${t('Sort by')}</span>
        <select class="input" data-mb-sort-select>
          ${SORTS.map((s) => `<option value="${s}"${state.sort === s ? ' selected' : ''}>${SORT_LABEL[s]()}</option>`).join('')}
        </select>
      </label>
    </div>
    <div data-mb-list>${listHtml()}</div>
  </section>`;
  setPageActions(pageActionsHtml(`/api${leaderboardQuery(win?.from, win?.to)}&format=csv`, rows.length > 0));
  wire(el);
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

/** The page header already says "Members": this line is the count + the view toggle. */
function headHtml(count) {
  return `<div class="mboard-head">
      <p class="mboard-sub">${tn(count, '{n} member', '{n} members', { n: count })}<span class="mboard-hint"> · ${t('select a member for their profile')}</span></p>
      ${membersViewToggleHtml('board')}
    </div>`;
}

/** Plain facts, never alerts: who burns on the map, who joined, who left. */
function notesHtml() {
  const lines = [];
  const names = (list) => {
    const shown = list.slice(0, NOTE_NAMES).join(', ');
    return list.length > NOTE_NAMES ? t('{names} and {n} more', { names: shown, n: list.length - NOTE_NAMES }) : shown;
  };
  const burning = board.rows.filter((r) => r.burning);
  if (burning.length) {
    const seen = burning.map((r) => r.mapSeenAt).filter(Boolean).sort().pop();
    lines.push(`<li><span aria-hidden="true">🔥</span> ${t('Burning on the map: {names}', { names: esc(names(burning.map((r) => r.name))) })}${seen ? ` <span class="ui-note-when">· ${esc(t('map read {when}', { when: formatRelativeTime(seen) }))}</span>` : ''}</li>`);
  }
  const since = Date.now() - NOTE_DAYS * DAY_MS;
  const recent = board.changes.filter((c) => Date.parse(c.at) >= since);
  const fmt = (c) => `${c.name} (${formatDateShort(c.at)})`;
  const joined = recent.filter((c) => c.kind === 'joined' || c.kind === 'returned' || c.kind === 'restored').map(fmt);
  const left = recent.filter((c) => c.kind === 'left').map(fmt);
  if (joined.length) lines.push(`<li><span aria-hidden="true">→</span> ${t('Joined in the last 7 days: {names}', { names: esc(names(joined)) })}</li>`);
  if (left.length) lines.push(`<li><span aria-hidden="true">←</span> ${t('Left in the last 7 days: {names}', { names: esc(names(left)) })}</li>`);
  return lines.length ? `<ul class="ui-notes">${lines.join('')}</ul>` : '';
}

/** The band chips with counts, and the goal / pace numbers they are measured against. */
function summaryHtml() {
  if (!board.goalPts) {
    return `<p class="mboard-goal-line">${board.win ? t('No points goal is set for this clan, so the board ranks by points only.') : t('All time: ranked by points, no goal applies.')}</p>`;
  }
  const count = (b) => (b === 'all' ? board.rows.length : board.rows.filter((r) => r.band === b).length);
  const bands = BANDS.filter((b) => b !== 'pace' || board.pacePts !== null);
  const chip = (b) => {
    const s = BAND_TEXT[b];
    const label = s ? `<span aria-hidden="true">${s.glyph}</span> ${s.label()}` : t('All');
    return `<button type="button" class="ui-chip ui-band-chip band-${b}${state.band === b ? ' is-active' : ''}" aria-pressed="${state.band === b}" data-mb-band="${b}">${label} <span class="ui-chip-n">${count(b)}</span></button>`;
  };
  const goalText = t('Goal {n}', { n: board.goalPts.toLocaleString() });
  const pace = board.pacePts !== null
    ? `<span class="ui-key-sep" aria-hidden="true">·</span><span class="ui-key ui-key-pace" aria-hidden="true"></span>${esc(t('pace now {n}', { n: board.pacePts.toLocaleString() }))}`
    : '';
  return `<div class="mboard-summary">
      <div class="mboard-bands" role="group" aria-label="${esc(t('Show'))}">${bands.map(chip).join('')}</div>
      <p class="mboard-goal-line"><span class="ui-key ui-key-goal" aria-hidden="true"></span>${esc(goalText)}${pace}</p>
    </div>`;
}

function sortRows(rows) {
  const by = {
    points: (a, b) => a.rank - b.rank,
    name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    chests: (a, b) => b.chests - a.chests || a.rank - b.rank,
    // Unknown sorts last, never like a zero.
    might: (a, b) => (b.might ?? -1) - (a.might ?? -1) || a.rank - b.rank,
    joined: (a, b) => (b.joinedAt ?? -1) - (a.joinedAt ?? -1) || a.rank - b.rank,
  }[state.sort];
  return [...rows].sort(by);
}

function listHtml() {
  const q = state.query.trim().toLowerCase();
  const shown = sortRows(board.rows.filter((r) => (state.band === 'all' || r.band === state.band) && (!q || r.name.toLowerCase().includes(q))));
  // Every one of your players (alts, v130), in board order.
  const pinYou = getCurrentUser()?.role === 'user' ? board.rows.filter((r) => r.isYou) : [];
  if (!board.rows.length) return `<p class="ui-empty">${t('No members yet.')}</p>`;
  const you = pinYou.length ? `<div class="mboard-you"><h3 class="mboard-group">${t('You')}</h3><ol class="mboard-list">${pinYou.map(rowHtml).join('')}</ol></div>` : '';
  if (!shown.length) return `${you}<p class="ui-empty">${t('Nobody matches this filter.')}</p>`;
  // Grouped under the band headings when ranked by points against a goal.
  if (state.sort === 'points' && board.goalPts && state.band === 'all') {
    const groups = ['ok', 'pace', 'behind'].map((b) => [b, shown.filter((r) => r.band === b)]).filter(([, list]) => list.length);
    return you + groups.map(([b, list]) => `<h3 class="mboard-group band-${b}"><span aria-hidden="true">${BAND_TEXT[b].glyph}</span> ${BAND_TEXT[b].label()} <span class="ui-chip-n">${list.length}</span></h3>
      <ol class="mboard-list">${list.map(rowHtml).join('')}</ol>`).join('');
  }
  return `${you}<ol class="mboard-list">${shown.map(rowHtml).join('')}</ol>`;
}

function deltaHtml(r) {
  if (r.delta === null) return '';
  const label = DELTA_LABEL[state.period]?.[board.running ? 'now' : 'past']?.() ?? '';
  const cls = r.delta > 0 ? 'is-up' : r.delta < 0 ? 'is-down' : 'is-flat';
  const glyph = r.delta > 0 ? '▲' : r.delta < 0 ? '▼' : '±';
  const n = r.delta === 0 ? '0' : Math.abs(r.delta).toLocaleString();
  return `<span class="mboard-delta ${cls}" title="${esc(label)}"><span aria-hidden="true">${glyph}</span> ${n}<span class="visually-hidden"> ${esc(label)}</span></span>`;
}

function rowHtml(r) {
  const pct = (v) => `${Math.min(100, (v / board.scaleMax) * 100).toFixed(2)}%`;
  const band = r.band ? BAND_TEXT[r.band] : null;
  // The chest count first: it is what the points are made of, and on a phone
  // the line is cut from the end.
  const meta = [
    r.role ? esc(gameRankName(r.role)) : '',
    esc(tn(r.chests, '{n} chest', '{n} chests', { n: r.chests.toLocaleString() })),
    r.guards != null ? esc(t('G{level}', { level: r.guards })) : '',
    r.might != null ? esc(t('{n} might', { n: formatMightCompact(r.might) })) : '',
  ].filter(Boolean).join(' · ');
  const marks = `${goldPassBadgeHtml(r.goldPass)}${r.isYou ? `<span class="mboard-tag is-you">${t('You')}</span>` : ''}${r.burning ? `<span class="mboard-tag is-burning"><span aria-hidden="true">🔥</span> ${t('Burning')}</span>` : ''}`;
  return `<li class="mboard-item${r.isYou ? ' is-you' : ''}"><a class="mboard-row" href="${memberHash(r.id)}">
      <span class="mboard-rank">#${r.rank}</span>
      ${avatarHtml({ username: r.name, avatar: r.avatar }, { size: 'md' })}
      <span class="mboard-who"><span class="mboard-name-line"><span class="mboard-name">${esc(r.name)}</span>${marks}</span>${meta ? `<span class="mboard-meta">${meta}</span>` : ''}</span>
      <span class="ui-bar" aria-hidden="true">
        <span class="ui-bar-fill${r.band ? ` band-${r.band}` : ''}" style="--w:${pct(r.points)}"></span>
        ${board.pacePts !== null ? `<span class="ui-bar-tick is-pace" style="--x:${pct(board.pacePts)}"></span>` : ''}
        ${board.goalPts ? `<span class="ui-bar-tick is-goal" style="--x:${pct(board.goalPts)}"></span>` : ''}
      </span>
      <span class="mboard-pts"><span class="mboard-pts-n">${r.points.toLocaleString()}</span><span class="visually-hidden"> ${t('points')}</span>${deltaHtml(r)}</span>
      <span class="ui-band${r.band ? ` band-${r.band}` : ''}">${band ? `<span aria-hidden="true">${band.glyph}</span> ${band.label()}` : ''}</span>
    </a></li>`;
}

function redrawList() {
  const list = board?.el.querySelector('[data-mb-list]');
  if (list) list.innerHTML = listHtml();
}

function redrawAll() {
  const summary = board.el.querySelector('.mboard-summary');
  if (summary) summary.outerHTML = summaryHtml();
  for (const b of board.el.querySelectorAll('[data-mb-sort]')) {
    const on = b.dataset.mbSort === state.sort;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const pick = board.el.querySelector('[data-mb-sort-select]');
  if (pick && pick.value !== state.sort) pick.value = state.sort;
  redrawList();
}

function wire(el) {
  const root = el.querySelector('.mboard');
  wireMembersViewToggle(root, () => board.rerender?.());
  root.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest('button') : null;
    if (!target || !root.contains(target)) return;
    if (target.dataset.mbSort) {
      state.sort = target.dataset.mbSort;
      redrawAll();
    } else if (target.dataset.mbBand) {
      state.band = target.dataset.mbBand;
      redrawAll();
    }
  });
  const redraw = () => renderMembersBoard(el, { tabsHtml: el.querySelector('.view-tabs')?.outerHTML ?? '', rerender: board.rerender });
  wirePeriodScrubber(root, {
    onPeriod: (p) => { state.period = p; state.offset = 0; state.band = 'all'; void redraw(); },
    onStep: (delta) => { state.offset = Math.max(0, state.offset + delta); state.band = 'all'; void redraw(); },
  });
  root.querySelector('[data-mb-sort-select]')?.addEventListener('change', (e) => {
    state.sort = SORTS.includes(e.target.value) ? e.target.value : 'points';
    redrawAll();
  });
  root.querySelector('#membersBoardSearch')?.addEventListener('input', (e) => {
    state.query = e.target.value;
    redrawList();
  });
}
