// Members → the ranking board (redesign phase 2a, design C): every member's
// chest points for a period as a bar against the clan's goal line and a pace
// line, banded ✓ Reached / ◐ On pace / ↓ Behind. The roster table it replaced
// as the default is one toggle away (pages/members.js renders it).
//
// Data: /leaderboard for the window (all members, canonical rank) and for the
// window before it (the "vs last week" delta — cut at the same point of the
// week while this one is still running, so it compares like with like),
// /leaderboard/goal (the goal THIS window was played under), /game/roster
// (picture, in-game rank, "you", the city on the map) and
// /game/clan/roster-changes (who joined or left lately).

import { api } from '../lib/api.js';
import { esc, memberHash, formatDateShort, formatRelativeTime } from '../lib/ui.js';
import { t, tn } from '../lib/i18n.js';
import { computeGameWindow, formatPeriodLabel } from '../lib/period.js';
import { goalDaysForPeriod, scaleGoalForPeriod, formatMightCompact } from '../lib/leaderboard-render.js';
import { weeklyGoalForWindow } from '../lib/weekly-goal.js';
import { getCurrentUser, getGameDayRolloverUtcHour, getWeekStart } from '../lib/state.js';
import { gameRankName } from '../lib/game-facts.js';
import { avatarHtml } from '../lib/avatar.js';

const DAY_MS = 86_400_000;
const PERIODS = ['daily', 'weekly', 'monthly', 'all'];
const SORTS = ['points', 'name', 'might', 'joined'];
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

/** Board | Table, the same two buttons on both views. */
export function membersViewToggleHtml(active) {
  const btn = (view, label) => `<button type="button" class="mboard-seg-btn${view === active ? ' is-active' : ''}" aria-pressed="${view === active}" data-mb-view="${view}">${label}</button>`;
  return `<div class="mboard-seg" role="group" aria-label="${esc(t('View'))}">${btn('board', t('Board'))}${btn('table', t('Table'))}</div>`;
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

const PERIOD_LABEL = { daily: () => t('Day'), weekly: () => t('Week'), monthly: () => t('Month'), all: () => t('All') };
const SORT_LABEL = { points: () => t('Points'), name: () => t('Name'), might: () => t('Might'), joined: () => t('Joined') };
const BAND_TEXT = {
  ok: { glyph: '✓', label: () => t('Reached') },
  pace: { glyph: '◐', label: () => t('On pace') },
  behind: { glyph: '↓', label: () => t('Behind') },
};
const DELTA_LABEL = {
  daily: { now: () => t('vs yesterday by now'), past: () => t('vs the day before') },
  weekly: { now: () => t('vs last week by now'), past: () => t('vs the week before') },
  monthly: { now: () => t('vs last month by now'), past: () => t('vs the month before') },
};

function leaderboardQuery(from, to) {
  const p = new URLSearchParams({ includeAll: '1' });
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  return `/leaderboard?${p}`;
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
  const [entries, prevEntries, goal, roster, changes] = await Promise.all([
    api(leaderboardQuery(win?.from, win?.to)),
    prevQuery ? api(prevQuery).catch(() => []) : Promise.resolve([]),
    api('/leaderboard/goal').catch(() => null),
    api('/game/roster').catch(() => ({ members: {} })),
    api(`/game/clan/roster-changes?limit=40`).catch(() => ({ entries: [] })),
  ]);
  // A later click (another period) already started its own draw.
  if (state.period !== period || state.offset !== offset) return;

  const weekly = period === 'all' ? null : weeklyGoalForWindow(goal, period, offset, rolloverHr, weekStart);
  const goalPts = period === 'all' ? null : scaleGoalForPeriod(weekly, period, weekStart);
  const fraction = running ? Math.min(1, Math.max(0, (now - Date.parse(win.from)) / (Date.parse(win.to) - Date.parse(win.from)))) : 1;
  const pacePts = goalPts && running ? Math.round(goalPts * fraction) : null;

  const prevByMember = new Map((prevEntries || []).map((e) => [e.memberId, e.totalPoints || 0]));
  const game = roster?.members || {};
  const rows = (entries || []).map((e) => {
    const g = game[e.memberId] || {};
    const points = e.totalPoints || 0;
    const band = !goalPts ? null : points >= goalPts ? 'ok' : pacePts !== null && points >= pacePts ? 'pace' : 'behind';
    return {
      id: e.memberId,
      name: e.memberName,
      rank: e.rank,
      points,
      chests: e.totalChests || 0,
      delta: win ? points - (prevByMember.get(e.memberId) || 0) : null,
      band,
      might: g.might ?? e.might ?? null,
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
    scaleMax: Math.max(goalPts ? goalPts * 1.15 : 0, ...rows.map((r) => r.points), 1),
    changes: Array.isArray(changes?.entries) ? changes.entries : [],
  };

  el.innerHTML = `${tabsHtml}<section class="mboard" aria-labelledby="mboardTitle">
    ${headHtml(rows.length)}
    ${periodHtml(rolloverHr, weekStart)}
    ${notesHtml()}
    ${summaryHtml()}
    <div class="mboard-tools">
      <label class="mboard-search"><span class="visually-hidden">${t('Find a member')}</span>
        <input type="search" id="membersBoardSearch" class="input" placeholder="${esc(t('Find a member'))}" value="${esc(state.query)}" autocomplete="off"></label>
      <div class="mboard-sort" role="group" aria-label="${esc(t('Sort by'))}">
        <span class="mboard-label" aria-hidden="true">${t('Sort by')}</span>
        ${SORTS.map((s) => `<button type="button" class="mboard-chip${state.sort === s ? ' is-active' : ''}" aria-pressed="${state.sort === s}" data-mb-sort="${s}">${SORT_LABEL[s]()}</button>`).join('')}
      </div>
    </div>
    <div data-mb-list>${listHtml()}</div>
  </section>`;
  wire(el);
}

function headHtml(count) {
  return `<header class="mboard-head">
      <div class="mboard-heading">
        <h2 id="mboardTitle">${t('Members')}</h2>
        <p class="mboard-sub">${tn(count, '{n} member', '{n} members', { n: count })} · ${t('select a member for their profile')}</p>
      </div>
      ${membersViewToggleHtml('board')}
    </header>`;
}

/** Day / Week / Month / All, the arrows, and where in the window we are. */
function periodHtml(rolloverHr, weekStart) {
  const { period, offset } = state;
  let where = '';
  if (board.running) {
    const reset = new Date(Date.UTC(2000, 0, 1, rolloverHr));
    const local = reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const resetText = t('resets {utc} UTC ({local} your time)', { utc: `${String(rolloverHr).padStart(2, '0')}:00`, local });
    if (period === 'weekly') {
      const days = goalDaysForPeriod('weekly', weekStart);
      const day = Math.min(days, Math.floor((Date.now() - Date.parse(board.win.from)) / DAY_MS) + 1);
      where = `${t('Game day {day} of {days}', { day, days })} · ${resetText}`;
    } else {
      where = resetText;
    }
  }
  return `<div class="mboard-period">
      <div class="mboard-seg" role="group" aria-label="${esc(t('Period'))}">
        ${PERIODS.map((p) => `<button type="button" class="mboard-seg-btn${period === p ? ' is-active' : ''}" aria-pressed="${period === p}" data-mb-period="${p}">${PERIOD_LABEL[p]()}</button>`).join('')}
      </div>
      ${period === 'all' ? '' : `<div class="mboard-step">
        <button type="button" class="mboard-arrow" data-mb-step="1" aria-label="${esc(t('Earlier'))}">‹</button>
        <div class="mboard-when"><span class="mboard-when-label">${esc(formatPeriodLabel(period, offset, rolloverHr, weekStart))}</span>${where ? `<span class="mboard-when-sub">${esc(where)}</span>` : ''}</div>
        <button type="button" class="mboard-arrow" data-mb-step="-1" aria-label="${esc(t('Later'))}"${offset === 0 ? ' disabled' : ''}>›</button>
      </div>`}
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
    lines.push(`<li><span aria-hidden="true">🔥</span> ${t('Burning on the map: {names}', { names: esc(names(burning.map((r) => r.name))) })}${seen ? ` <span class="mboard-note-when">· ${esc(t('map read {when}', { when: formatRelativeTime(seen) }))}</span>` : ''}</li>`);
  }
  const since = Date.now() - NOTE_DAYS * DAY_MS;
  const recent = board.changes.filter((c) => Date.parse(c.at) >= since);
  const fmt = (c) => `${c.name} (${formatDateShort(c.at)})`;
  const joined = recent.filter((c) => c.kind === 'joined' || c.kind === 'returned' || c.kind === 'restored').map(fmt);
  const left = recent.filter((c) => c.kind === 'left').map(fmt);
  if (joined.length) lines.push(`<li><span aria-hidden="true">→</span> ${t('Joined in the last 7 days: {names}', { names: esc(names(joined)) })}</li>`);
  if (left.length) lines.push(`<li><span aria-hidden="true">←</span> ${t('Left in the last 7 days: {names}', { names: esc(names(left)) })}</li>`);
  return lines.length ? `<ul class="mboard-notes">${lines.join('')}</ul>` : '';
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
    return `<button type="button" class="mboard-chip mboard-band-chip band-${b}${state.band === b ? ' is-active' : ''}" aria-pressed="${state.band === b}" data-mb-band="${b}">${label} <span class="mboard-chip-n">${count(b)}</span></button>`;
  };
  const goalText = t('Goal {n}', { n: board.goalPts.toLocaleString() });
  const paceText = board.pacePts !== null ? ` · ${t('pace now {n}', { n: board.pacePts.toLocaleString() })}` : '';
  return `<div class="mboard-summary">
      <div class="mboard-bands" role="group" aria-label="${esc(t('Show'))}">${bands.map(chip).join('')}</div>
      <p class="mboard-goal-line"><span class="mboard-key mboard-key-goal" aria-hidden="true"></span>${esc(goalText)}${board.pacePts !== null ? `<span class="mboard-key mboard-key-pace" aria-hidden="true"></span>` : ''}${esc(paceText)}</p>
    </div>`;
}

function sortRows(rows) {
  const by = {
    points: (a, b) => a.rank - b.rank,
    name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    // Unknown sorts last, never like a zero.
    might: (a, b) => (b.might ?? -1) - (a.might ?? -1) || a.rank - b.rank,
    joined: (a, b) => (b.joinedAt ?? -1) - (a.joinedAt ?? -1) || a.rank - b.rank,
  }[state.sort];
  return [...rows].sort(by);
}

function listHtml() {
  const q = state.query.trim().toLowerCase();
  const shown = sortRows(board.rows.filter((r) => (state.band === 'all' || r.band === state.band) && (!q || r.name.toLowerCase().includes(q))));
  const pinYou = getCurrentUser()?.role === 'user' ? board.rows.find((r) => r.isYou) : null;
  if (!board.rows.length) return `<p class="mboard-empty">${t('No members yet.')}</p>`;
  const you = pinYou ? `<div class="mboard-you"><h3 class="mboard-group">${t('You')}</h3><ol class="mboard-list">${rowHtml(pinYou)}</ol></div>` : '';
  if (!shown.length) return `${you}<p class="mboard-empty">${t('Nobody matches this filter.')}</p>`;
  // Grouped under the band headings when ranked by points against a goal.
  if (state.sort === 'points' && board.goalPts && state.band === 'all') {
    const groups = ['ok', 'pace', 'behind'].map((b) => [b, shown.filter((r) => r.band === b)]).filter(([, list]) => list.length);
    return you + groups.map(([b, list]) => `<h3 class="mboard-group band-${b}"><span aria-hidden="true">${BAND_TEXT[b].glyph}</span> ${BAND_TEXT[b].label()} <span class="mboard-chip-n">${list.length}</span></h3>
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
  const meta = [
    r.role ? esc(gameRankName(r.role)) : '',
    r.might != null ? esc(t('{n} might', { n: formatMightCompact(r.might) })) : '',
  ].filter(Boolean).join(' · ');
  const marks = `${r.isYou ? `<span class="mboard-tag is-you">${t('You')}</span>` : ''}${r.burning ? `<span class="mboard-tag is-burning"><span aria-hidden="true">🔥</span> ${t('Burning')}</span>` : ''}`;
  return `<li class="mboard-item${r.isYou ? ' is-you' : ''}"><a class="mboard-row" href="${memberHash(r.id)}">
      <span class="mboard-rank">#${r.rank}</span>
      ${avatarHtml({ username: r.name, avatar: r.avatar }, { size: 'md' })}
      <span class="mboard-who"><span class="mboard-name-line"><span class="mboard-name">${esc(r.name)}</span>${marks}</span>${meta ? `<span class="mboard-meta">${meta}</span>` : ''}</span>
      <span class="mboard-bar" aria-hidden="true">
        <span class="mboard-fill${r.band ? ` band-${r.band}` : ''}" style="--w:${pct(r.points)}"></span>
        ${board.pacePts !== null ? `<span class="mboard-tick is-pace" style="--x:${pct(board.pacePts)}"></span>` : ''}
        ${board.goalPts ? `<span class="mboard-tick is-goal" style="--x:${pct(board.goalPts)}"></span>` : ''}
      </span>
      <span class="mboard-pts"><span class="mboard-pts-n">${r.points.toLocaleString()}</span><span class="visually-hidden"> ${t('points')}</span>${deltaHtml(r)}</span>
      <span class="mboard-band${r.band ? ` band-${r.band}` : ''}">${band ? `<span aria-hidden="true">${band.glyph}</span> ${band.label()}` : ''}</span>
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
  redrawList();
}

function wire(el) {
  const root = el.querySelector('.mboard');
  wireMembersViewToggle(root, () => board.rerender?.());
  root.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest('button') : null;
    if (!target || !root.contains(target)) return;
    if (target.dataset.mbPeriod) {
      if (target.dataset.mbPeriod === state.period) return;
      state.period = target.dataset.mbPeriod;
      state.offset = 0;
      state.band = 'all';
      void renderMembersBoard(el, { tabsHtml: el.querySelector('.view-tabs')?.outerHTML ?? '', rerender: board.rerender });
    } else if (target.dataset.mbStep) {
      state.offset = Math.max(0, state.offset + Number(target.dataset.mbStep));
      state.band = 'all';
      void renderMembersBoard(el, { tabsHtml: el.querySelector('.view-tabs')?.outerHTML ?? '', rerender: board.rerender });
    } else if (target.dataset.mbSort) {
      state.sort = target.dataset.mbSort;
      redrawAll();
    } else if (target.dataset.mbBand) {
      state.band = target.dataset.mbBand;
      redrawAll();
    }
  });
  root.querySelector('#membersBoardSearch')?.addEventListener('input', (e) => {
    state.query = e.target.value;
    redrawList();
  });
}
