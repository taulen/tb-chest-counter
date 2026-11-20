// The ranking board: every member's chest points for a window as a bar against
// the clan's goal line and a pace line, banded ✓ Reached / ◐ On pace / ↓ Behind,
// with the top three as a podium above it. One build for both places it shows:
//
//  - Members (pages/members-board.js, signed in) — a member opens their
//    profile; the game roster adds pictures, in-game rank and "you".
//  - The public share page (public-share.js) — no profile to open, so a member
//    opens their chest breakdown (lib/leaderboard-breakdown.js), and hovering a
//    row previews it.
//
// The page fetches (it knows its own API and auth) and owns the state object
// `{ period, offset, band, sort, query }`; this module turns the rows into the
// board and keeps its controls (bands, search, sort) redrawing in place.
//
// Goal judging is lib/leaderboard-render.js's, the same code Analytics, the
// profile and Copy data use: green at the goal, amber on pace, red behind; an
// ended window has no pace left, so it is green or red.
//
// Keep the imports to what the share page can load (no session, no router).

import { esc } from './ui.js';
import { t, tn } from './i18n.js';
import { computeGameWindow } from './period.js';
import {
  scaleGoalForPeriod, formatMightCompact, goalStatusFor, pacePointsFor, paceFractionForWindow,
} from './leaderboard-render.js';
import { weeklyGoalForWindow } from './weekly-goal.js';
import { goldPassBadgeHtml } from './guards-format.js';
import { BANDS as BAND_TEXT } from './ui-kit.js';
import { gameRankName } from './game-facts.js';

export const BOARD_PERIODS = ['daily', 'weekly', 'monthly', 'yearly', 'all'];
export const BOARD_BANDS = ['all', 'ok', 'pace', 'behind'];

const SORT_LABEL = {
  points: () => t('Points'), name: () => t('Name'), chests: () => t('Chests'), might: () => t('Might'), joined: () => t('Joined'),
};
const DELTA_LABEL = {
  daily: { now: () => t('vs yesterday by now'), past: () => t('vs the day before') },
  weekly: { now: () => t('vs last week by now'), past: () => t('vs the week before') },
  monthly: { now: () => t('vs last month by now'), past: () => t('vs the month before') },
  yearly: { now: () => t('vs last year by now'), past: () => t('vs the year before') },
};

/** `<base>?includeAll=1&from=…&to=…` — the leaderboard read for a window (no window: All Time). */
export function boardQuery(base, from, to) {
  const p = new URLSearchParams({ includeAll: '1' });
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  return `${base}?${p}`;
}

/**
 * The window on screen and the one before it, for the "vs last week" delta —
 * cut at the same point of its week while this one still runs, so it compares
 * like with like. `prev` is null for All Time.
 */
export function boardWindows({ period, offset, rolloverHr, weekStart, now = Date.now() }) {
  const win = computeGameWindow(period, offset, rolloverHr, weekStart);
  const running = !!win && offset === 0;
  let prev = null;
  if (win) {
    const p = computeGameWindow(period, offset + 1, rolloverHr, weekStart);
    const elapsed = now - Date.parse(win.from);
    const to = running ? new Date(Math.min(Date.parse(p.from) + elapsed, Date.parse(p.to))).toISOString() : p.to;
    prev = { from: p.from, to };
  }
  return { win, running, prev, now };
}

/**
 * The board for one window. `entries` are /leaderboard rows (canonical rank);
 * `prevEntries` the window before (null: no delta); `goal` the
 * /leaderboard/goal shape. `extra(entry)` adds a page's own fields to a row
 * (avatar, role, isYou, … from the game roster).
 */
export function buildBoard({
  entries, prevEntries = /** @type {Array<{ memberId: number, totalPoints?: number }> | null} */ (null),
  goal, period, offset, rolloverHr, weekStart, windows, extra = (/** @type {any} */ _e) => ({}),
}) {
  const { win, running, now } = windows;
  const weekly = period === 'all' ? null : weeklyGoalForWindow(goal, period, offset, rolloverHr, weekStart);
  const goalPts = period === 'all' ? null : scaleGoalForPeriod(weekly, period, weekStart);
  // The pace mark; null once the window has ended.
  const paceFraction = running ? paceFractionForWindow(win, now) : null;
  const pacePts = pacePointsFor(goalPts, paceFraction);
  const prevBy = Array.isArray(prevEntries) ? new Map(prevEntries.map((e) => [e.memberId, e.totalPoints || 0])) : null;

  const rows = entries.map((e) => {
    const points = e.totalPoints || 0;
    // An ended window has no pace: below the goal is "behind".
    const status = goalStatusFor(points, goalPts, { pace: pacePts });
    return {
      id: e.memberId,
      name: e.memberName,
      rank: e.rank,
      points,
      chests: e.totalChests || 0,
      delta: win && prevBy ? points - (prevBy.get(e.memberId) || 0) : null,
      band: !status ? null : status === 'low' ? 'behind' : status,
      might: e.might ?? null,
      guards: e.guardsLevel ?? null,
      goldPass: e.goldPass ?? null,
      role: null,
      joinedAt: null,
      burning: false,
      isYou: false,
      avatar: null,
      ...extra(e),
    };
  });

  return {
    rows,
    period,
    win,
    running,
    goalPts,
    pacePts,
    // With a goal the bar spans up to twice it, so one runaway total doesn't
    // squash everyone else's bar to a sliver (the number shows the real total).
    scaleMax: goalPts
      ? Math.max(goalPts * 1.25, Math.min(Math.max(...rows.map((r) => r.points), 0), goalPts * 2))
      : Math.max(...rows.map((r) => r.points), 1),
    // For Copy data: every member in rank order, judged as the rows are.
    copy: { entries, period, offset, rolloverHr, goalWeeklyPoints: weekly, paceFraction },
  };
}

// ─── Pieces ───────────────────────────────────────────────────
//
// `look` says how a member opens and looks, per page:
//   { tag: 'a' | 'button', attrs: (row) => '…', pic: (row, 'md' | 'lg') => html }

/**
 * The top three of the window by canonical rank, whatever the list's sort or
 * filter: picture, name, chests, points. Nothing until somebody has points.
 */
export function podiumHtml(board, look) {
  const top = board.rows.filter((r) => r.points > 0 && r.rank <= 3).sort((a, b) => a.rank - b.rank).slice(0, 3);
  if (!top.length) return '';
  return `<ol class="lb-podium" aria-label="${esc(t('Top three'))}">
      ${top.map((r) => `<li class="lb-podium-place place-${r.rank}">
        <${look.tag} class="lb-podium-card" ${look.attrs(r)}>
          <span class="rank rank-${r.rank} lb-podium-rank">#${r.rank}</span>
          ${look.pic(r, 'lg')}
          <span class="lb-podium-who">
            <span class="lb-podium-name">${esc(r.name)}</span>
            <span class="lb-podium-sub">${esc(tn(r.chests, '{n} chest', '{n} chests', { n: r.chests.toLocaleString() }))}</span>
          </span>
          <span class="lb-podium-pts"><span class="lb-podium-n">${r.points.toLocaleString()}</span> <span class="lb-podium-unit">${esc(t('points'))}</span></span>
        </${look.tag}>
      </li>`).join('')}
    </ol>`;
}

/** The band chips with counts, and the goal / pace numbers they are measured against. */
export function summaryHtml(board, state) {
  if (!board.goalPts) {
    return `<p class="mboard-goal-line">${board.win ? t('No points goal is set for this clan, so the board ranks by points only.') : t('All time: ranked by points, no goal applies.')}</p>`;
  }
  const count = (b) => (b === 'all' ? board.rows.length : board.rows.filter((r) => r.band === b).length);
  const bands = BOARD_BANDS.filter((b) => b !== 'pace' || board.pacePts !== null);
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

// The sort's direction: ↓ is each sort's natural order (most points, A→Z,
// most chests, most might, newest first), ↑ that order turned on its head.
const dirGlyph = (state) => (state.reverse ? '↑' : '↓');

/** The desktop's sort chips; the active one carries its direction and flips on a second click. */
function sortChipsHtml(state, sorts) {
  return `<div class="mboard-sort" role="group" aria-label="${esc(t('Sort by'))}">
      <span class="ui-eyebrow" aria-hidden="true">${t('Sort by')}</span>
      ${sorts.map((s) => {
        const on = state.sort === s;
        return `<button type="button" class="ui-chip${on ? ' is-active' : ''}" aria-pressed="${on}" data-mb-sort="${s}"${on ? ` title="${esc(t('Click again to reverse the order'))}"` : ''}>${SORT_LABEL[s]()}${on
          ? ` <span class="mboard-sort-arrow" aria-hidden="true">${dirGlyph(state)}</span>${state.reverse ? `<span class="visually-hidden"> ${t('(reversed)')}</span>` : ''}`
          : ''}</button>`;
      }).join('')}
    </div>`;
}

/** The phone's direction button beside its sort select (a select can't be "clicked again"). */
function sortDirHtml(state) {
  return `<button type="button" class="ui-chip mboard-sort-dir" data-mb-sort-dir aria-pressed="${state.reverse}" title="${esc(t('Reverse the order'))}"><span aria-hidden="true">${dirGlyph(state)}</span><span class="visually-hidden">${t('Reverse the order')}</span></button>`;
}

/** Search + sort: chips on a desktop, one compact select + a direction button on a phone (style.css swaps them). */
export function toolsHtml(state, sorts) {
  return `<div class="mboard-tools">
      <label class="mboard-search"><span class="visually-hidden">${t('Find a member')}</span>
        <input type="search" class="input" data-mb-search placeholder="${esc(t('Find a member'))}" value="${esc(state.query)}" autocomplete="off"></label>
      ${sortChipsHtml(state, sorts)}
      <div class="mboard-sort-pick">
        <label class="mboard-sort-select" title="${esc(t('Sort by'))}">
          <span class="mboard-sort-icon" aria-hidden="true">⇅</span><span class="visually-hidden">${t('Sort by')}</span>
          <select class="input" data-mb-sort-select>
            ${sorts.map((s) => `<option value="${s}"${state.sort === s ? ' selected' : ''}>${SORT_LABEL[s]()}</option>`).join('')}
          </select>
        </label>
        ${sortDirHtml(state)}
      </div>
    </div>`;
}

/**
 * Rows in the chosen order. `reverse` turns it on its head — ties included, so
 * the list really is upside down — except that an unknown might or join date
 * stays at the bottom either way: it is missing, not the smallest.
 */
function sortRows(rows, sort, reverse = false) {
  const dir = reverse ? -1 : 1;
  const byRank = (a, b) => dir * (a.rank - b.rank);
  const known = (field) => (a, b) => Number(a[field] == null) - Number(b[field] == null);
  const by = {
    points: byRank,
    name: (a, b) => dir * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || byRank(a, b),
    chests: (a, b) => dir * (b.chests - a.chests) || byRank(a, b),
    might: (a, b) => known('might')(a, b) || dir * ((b.might ?? 0) - (a.might ?? 0)) || byRank(a, b),
    joined: (a, b) => known('joinedAt')(a, b) || dir * ((b.joinedAt ?? 0) - (a.joinedAt ?? 0)) || byRank(a, b),
  }[sort] || byRank;
  return [...rows].sort(by);
}

/**
 * The list: grouped under the band headings when ranked by points against a
 * goal, else one list. `pinned` rows (your own players, signed in) sit on top
 * under "You" whatever the filter.
 */
export function listHtml(board, state, look, { pinned = [] } = {}) {
  if (!board.rows.length) return `<p class="ui-empty">${t('No members yet.')}</p>`;
  const q = state.query.trim().toLowerCase();
  const shown = sortRows(board.rows.filter((r) => (state.band === 'all' || r.band === state.band) && (!q || r.name.toLowerCase().includes(q))), state.sort, state.reverse);
  const row = (r) => rowHtml(r, board, look);
  const you = pinned.length ? `<div class="mboard-you"><h3 class="mboard-group">${t('You')}</h3><ol class="mboard-list">${pinned.map(row).join('')}</ol></div>` : '';
  if (!shown.length) return `${you}<p class="ui-empty">${t('Nobody matches this filter.')}</p>`;
  if (state.sort === 'points' && board.goalPts && state.band === 'all') {
    // Turned on its head, the bands come bottom-up too: Behind first.
    const order = state.reverse ? ['behind', 'pace', 'ok'] : ['ok', 'pace', 'behind'];
    const groups = order.map((b) => [b, shown.filter((r) => r.band === b)]).filter(([, list]) => list.length);
    return you + groups.map(([b, list]) => `<h3 class="mboard-group band-${b}"><span aria-hidden="true">${BAND_TEXT[b].glyph}</span> ${BAND_TEXT[b].label()} <span class="ui-chip-n">${list.length}</span></h3>
      <ol class="mboard-list">${list.map(row).join('')}</ol>`).join('');
  }
  return `${you}<ol class="mboard-list">${shown.map(row).join('')}</ol>`;
}

function deltaHtml(r, board) {
  if (r.delta === null) return '';
  const label = DELTA_LABEL[board.period]?.[board.running ? 'now' : 'past']?.() ?? '';
  const cls = r.delta > 0 ? 'is-up' : r.delta < 0 ? 'is-down' : 'is-flat';
  const glyph = r.delta > 0 ? '▲' : r.delta < 0 ? '▼' : '±';
  const n = r.delta === 0 ? '0' : Math.abs(r.delta).toLocaleString();
  return `<span class="mboard-delta ${cls}" title="${esc(label)}"><span aria-hidden="true">${glyph}</span> ${n}<span class="visually-hidden"> ${esc(label)}</span></span>`;
}

function rowHtml(r, board, look) {
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
  return `<li class="mboard-item${r.isYou ? ' is-you' : ''}"><${look.tag} class="mboard-row" ${look.attrs(r)}>
      <span class="mboard-rank">#${r.rank}</span>
      ${look.pic(r, 'md')}
      <span class="mboard-who"><span class="mboard-name-line"><span class="mboard-name">${esc(r.name)}</span>${marks}</span>${meta ? `<span class="mboard-meta">${meta}</span>` : ''}</span>
      <span class="ui-bar" aria-hidden="true">
        <span class="ui-bar-fill${r.band ? ` band-${r.band}` : ''}" style="--w:${pct(r.points)}"></span>
        ${board.pacePts !== null ? `<span class="ui-bar-tick is-pace" style="--x:${pct(board.pacePts)}"></span>` : ''}
        ${board.goalPts ? `<span class="ui-bar-tick is-goal" style="--x:${pct(board.goalPts)}"></span>` : ''}
      </span>
      <span class="mboard-pts"><span class="mboard-pts-n">${r.points.toLocaleString()}</span><span class="visually-hidden"> ${t('points')}</span>${deltaHtml(r, board)}</span>
      <span class="ui-band${r.band ? ` band-${r.band}` : ''}">${band ? `<span aria-hidden="true">${band.glyph}</span> ${band.label()}` : ''}</span>
    </${look.tag}></li>`;
}

/**
 * Keep the board's own controls live: band chips, sort chips / select /
 * direction and the search redraw the summary and list in place (no refetch).
 * `get()` returns `{ board, look, pinned }` for the board currently on screen.
 * The state carries `reverse` (the order turned on its head) beside `sort`.
 */
export function wireBoardControls(root, { state, sorts, get }) {
  const redraw = (all) => {
    const { board, look, pinned } = get();
    if (!board) return;
    if (all) {
      const summary = root.querySelector('.mboard-summary');
      if (summary) summary.outerHTML = summaryHtml(board, state);
      const chips = root.querySelector('.mboard-sort');
      if (chips) chips.outerHTML = sortChipsHtml(state, sorts);
      const dir = root.querySelector('[data-mb-sort-dir]');
      if (dir) dir.outerHTML = sortDirHtml(state);
      const pick = root.querySelector('[data-mb-sort-select]');
      if (pick && pick.value !== state.sort) pick.value = state.sort;
    }
    const list = root.querySelector('[data-mb-list]');
    if (list) list.innerHTML = listHtml(board, state, look, { pinned });
  };
  // A new sort starts in its natural order; the same one again turns it over.
  const pickSort = (sort) => {
    if (sort === state.sort) state.reverse = !state.reverse;
    else {
      state.sort = sort;
      state.reverse = false;
    }
    redraw(true);
  };
  root.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest('button') : null;
    if (!target || !root.contains(target)) return;
    if (target.dataset.mbSort) {
      pickSort(target.dataset.mbSort);
    } else if (target.hasAttribute('data-mb-sort-dir')) {
      state.reverse = !state.reverse;
      redraw(true);
    } else if (target.dataset.mbBand) {
      state.band = target.dataset.mbBand;
      redraw(true);
    }
  });
  root.querySelector('[data-mb-sort-select]')?.addEventListener('change', (e) => {
    state.sort = sorts.includes(e.target.value) ? e.target.value : 'points';
    state.reverse = false;
    redraw(true);
  });
  root.querySelector('[data-mb-search]')?.addEventListener('input', (e) => {
    state.query = e.target.value;
    redraw(false);
  });
}
