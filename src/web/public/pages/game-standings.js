// Event standings read from the game (GET /api/game/events…): every running
// event's "Clan members" tab, read every scan (message 38003). Two places:
//   - the standings card on an event's page (Events → Ancients, Olympus, …),
//     for the run the selected timeframe covers;
//   - Events → In-game rankings: every event the game reported for the clan,
//     including events the site has no tab for (renderGameRankings, below).
// Names the game gives an event are official names → tGame at display.

import { api } from '../lib/api.js';
import {
  esc, memberLink, formatDate, formatDateShort, formatRelativeTime, buildHash, parseHashRoute, localDateKey,
} from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import {
  tileHtml, tileLinkHtml, foldHtml, emptyHtml, errorStateHtml, refusalText, wireRetry, asList,
  periodScrubberHtml, wirePeriodScrubber, compactRange,
} from '../lib/ui-kit.js';
import { computeGameWindow, gameDayKeyFor, periodAnchorFromOffset, periodOffsetFromAnchor, weekdayName } from '../lib/period.js';
import { getGameDayRolloverUtcHour, getWeekStart } from '../lib/state.js';

const PAGE_SIZE = 25;

/** The standings for an event page's window: { run, standings } or null. */
export async function fetchGameStandings(eventKey, from, to) {
  const qs = new URLSearchParams({ event: eventKey });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  try {
    const res = await api(`/game/events/standings?${qs}`);
    return res && res.run ? res : null;
  } catch {
    return null;
  }
}

function changeCell(row) {
  if (row.previousPoints === null || row.previousPoints === undefined) return '<span class="muted-copy">—</span>';
  const d = row.points - row.previousPoints;
  if (!d) return '<span class="muted-copy">±0</span>';
  const cls = d > 0 ? 'progress-up' : 'progress-down';
  const when = row.changedAt ? ` title="${esc(t('Since the read before {time}', { time: formatDate(row.changedAt) }))}"` : '';
  return `<span class="${cls}"${when}>${d > 0 ? '▲ +' : '▼ '}${Math.abs(d).toLocaleString()}</span>`;
}

function whoCell(row) {
  if (row.memberId) return memberLink(row.memberId, row.name);
  return esc(row.name || t('Unknown player'));
}

function liveBadgeHtml() {
  return `<span class="game-run-badge is-live"><span aria-hidden="true">●</span> ${esc(t('Live now'))}</span>`;
}

function runStatusHtml(run) {
  if (run.live) {
    return `${liveBadgeHtml()}${run.endsAt ? ` <span class="muted-copy">${esc(t('Ends {date}', { date: formatDate(run.endsAt).slice(0, 16) }))}</span>` : ''}`;
  }
  return `<span class="game-run-badge">${esc(t('Ended {date}', { date: run.endsAt ? formatDateShort(run.endsAt) : '—' }))}</span>`;
}

/** The site's pager: ← Prev · Page 2 of 4 · what is counted · Next →. `count` is plain text. */
function paginationHtml(page, pages, count) {
  if (pages <= 1) return '';
  return `<div class="pagination">
      <button class="btn btn-tight" data-gs-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
      <span class="pagination-info">${t('Page {page} of {pages}', { page, pages })} · ${esc(count)}</span>
      <button class="btn btn-tight" data-gs-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>${t('Next →')}</button>
    </div>`;
}

function standingsTableHtml(rows, page) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, page), pages);
  const slice = rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  // A rank of null: a member outside the top 100 of a run ranked across its
  // matchup (Sealed in Flame) — no place and no points the game shows.
  const none = '<span class="muted-copy">—</span>';
  const body = slice.map((r) => `<tr>
      <td data-label="${t('Rank')}" data-role="lead">${r.rank ? `<span class="rank rank-${r.rank}">#${r.rank}</span>` : none}</td>
      <td data-label="${t('Member')}" data-role="primary"><span class="mrow-name">${whoCell(r)}</span></td>
      <td data-label="${t('Points')}" class="num" data-role="metric">${r.rank ? Number(r.points).toLocaleString() : none}</td>
      <td data-label="${t('Change')}" class="num" data-role="hidden">${r.rank ? changeCell(r) : none}</td>
    </tr>`).join('');
  return `<div class="ui-table-card">
      <table class="table-responsive ui-table game-standings-table">
        <colgroup><col class="col-rank"><col><col class="col-points"><col class="col-change"></colgroup>
        <thead><tr>
          <th scope="col">${t('Rank')}</th><th scope="col">${t('Member')}</th>
          <th scope="col" class="num">${t('Points')}</th><th scope="col" class="num">${t('Change')}</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
      ${paginationHtml(p, pages, tn(rows.length, '{n} member', '{n} members', { n: rows.length }))}
    </div>`;
}

/** What the standings are: the Clan members tab, or (a run ranked across its matchup) our members' places in the Ranking tab. */
function standingsCopy(run) {
  return run.matchupRanked
    ? t("The event window's Ranking tab, read from the game every scan: our members' official places among every clan of the matchup. Members outside its top 100 have no rank.")
    : t("The event window's Clan members tab, read from the game every scan. The change is since the read before the points last moved.");
}

/** The standings card for an event page; nothing when the game gave no standings for that window. */
export function mountGameStandings(el, data) {
  if (!el) return;
  if (!data?.run) { el.innerHTML = ''; return; }
  let page = 1;
  const draw = () => {
    const { run } = data;
    const standings = asList(data.standings);
    el.innerHTML = `<section class="ev-section game-standings-card" aria-labelledby="gs-title">
        <div class="ev-section-head">
          <h2 class="ev-section-title" id="gs-title">${esc(t('Standings from the game'))}</h2>
          <span class="ui-sub" title="${esc(formatDate(run.readAt))}">${esc(t('Read {time}', { time: formatRelativeTime(run.readAt) }))}</span>
        </div>
        <p class="ui-sub">${esc(tGame(run.title || ''))} · ${runStatusHtml(run)}</p>
        <p class="ui-copy">${esc(standingsCopy(run))}</p>
        ${standingsTableHtml(standings, page)}
      </section>`;
    el.querySelectorAll('[data-gs-page]').forEach((b) => b.addEventListener('click', () => {
      page = Number(b.dataset.gsPage) || 1;
      draw();
    }));
  };
  draw();
}

// ─── Events → In-game rankings ──────────────────────────────────────────────
// Around 40 events and a few hundred runs a month, so never one tile each.
// Three views, each its own address so a link, a bookmark or Back lands on it:
//   #events/in-game?period=weekly&week=…   the window's runs (Week or Day, the
//       kit scrubber): live now first, then by the game day they started; the
//       short rotating tournaments (2–5 h, several a day) folded, one row each;
//   #events/in-game?event=<group>          every run of one event, newest first;
//   #events/in-game?run=<type>-<run>-<occ> one run's full standings.
// The event picker (every event the game reported) sits on all three.

const ROUTE = 'events/in-game';
const RANKING_PERIODS = ['daily', 'weekly'];
// The window on screen, kept while the reader moves between the views.
let rkPeriod = 'weekly';
let rkOffset = 0;
let rkLoad = 0;               // the newest window fetch; a late older answer is dropped
let tournamentsOpen = false;  // the folded tournaments, remembered across repaints

const runParam = (r) => `${r.type}-${r.run}-${r.occurrence}`;

function parseRunParam(value) {
  const m = /^(\d+)-(\d+)-(\d+)$/.exec(value || '');
  return m ? { type: m[1], run: m[2], occurrence: m[3] } : null;
}

/** The window as address params: `{ period, week: '2026-11-22' }`, absolute so a copied link keeps its week. */
function windowParams() {
  const params = { period: rkPeriod };
  const anchor = periodAnchorFromOffset(rkPeriod, rkOffset);
  if (anchor) params[anchor.key] = anchor.value;
  return params;
}

/** Write the window into the address without a navigation, only while this view is on screen. */
function syncAddress() {
  if (!window.location.hash.startsWith(`#${ROUTE}`)) return;
  const next = buildHash(ROUTE, windowParams());
  if (window.location.hash === next) return;
  try {
    history.replaceState(history.state, '', next);
  } catch { /* a sandboxed frame: the view works, the address just lags */ }
}

/** A run's or an event's name: the game's (official → tGame), or its type for the few the game leaves unnamed. */
function eventName(title, type) {
  return title ? tGame(title) : t('Event {type}', { type });
}
const runName = (r) => eventName(r.title, r.type);
const groupName = (g) => eventName(g.title, g.eventType);

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * When a run ran: a tournament by the reader's clock ("2026-11-24 18:30–20:30"),
 * anything longer by game days ("2026-11-23", "2026-11-22 → 28").
 */
function whenText(r) {
  const s = r.startsAt ? Date.parse(r.startsAt) : NaN;
  const e = r.endsAt ? Date.parse(r.endsAt) : NaN;
  if (!Number.isFinite(s)) return '';
  if (r.short && Number.isFinite(e)) return `${localDateKey(new Date(s))} ${hhmm(s)}–${hhmm(e)}`;
  const first = gameDayKeyFor(s);
  if (!Number.isFinite(e)) return `${first} →`;
  const last = gameDayKeyFor(e - 1);
  return first === last ? first : compactRange(`${first} → ${last}`);
}

/** The figure on a row's right: the clan's #1 in the run, their points over their name. */
function leaderHtml(leader) {
  if (!leader) return '';
  return `<span class="ui-row-n">${Number(leader.points).toLocaleString()}<span class="ui-row-sub gr-leader">#1 ${esc(leader.name || t('Unknown player'))}</span></span>`;
}

/** A row that opens `href`: the whole row is the link (its name's ::after covers it). */
function linkRowHtml(href, name, sub, leader) {
  return `<li class="ui-row gr-row">
      <span class="ui-row-main">
        <a class="ui-row-name gr-row-link" href="${esc(href)}">${esc(name)}</a>
        <span class="ui-row-sub">${sub}</span>
      </span>
      ${leaderHtml(leader)}
      <span class="gr-chev" aria-hidden="true">›</span>
    </li>`;
}

/** A row's sub-line: facts that wrap between each other, never inside one ("2 / members with points"). */
const factsHtml = (facts) => facts.filter(Boolean).map((f) => `<span class="gr-fact">${f}</span>`).join(' · ');

/**
 * One run as a row. `named` false (one event's history): the dates lead
 * instead of the event's name. `badge` false under Live now, which says it.
 */
function runRowHtml(r, { named = true, badge = true } = {}) {
  const when = whenText(r);
  return linkRowHtml(buildHash(ROUTE, { run: runParam(r) }), named ? runName(r) : (when || runName(r)), factsHtml([
    badge && r.live ? liveBadgeHtml() : '',
    named && when ? esc(when) : '',
    esc(tn(r.withPoints, '{n} member with points', '{n} members with points', { n: r.withPoints })),
  ]), r.leader);
}

const rowsHtml = (runs, opts) => `<ul class="ui-rows gr-rows">${runs.map((r) => runRowHtml(r, opts)).join('')}</ul>`;
const byRunName = (a, b) => runName(a).localeCompare(runName(b));

/** The picker: All events, then every event the game reported — events, then tournaments, each by name. */
function pickerHtml(events, selected) {
  const byName = (a, b) => groupName(a).localeCompare(groupName(b));
  const opt = (g) => `<option value="${esc(g.key)}"${g.key === selected ? ' selected' : ''}>${esc(groupName(g))} (${Number(g.runs).toLocaleString()})</option>`;
  const long = events.filter((g) => !g.short).sort(byName);
  const short = events.filter((g) => g.short).sort(byName);
  return `<select class="input gr-select" data-gr-event>
      <option value="">${esc(t('All events'))}</option>
      ${long.length ? `<optgroup label="${esc(t('Events'))}">${long.map(opt).join('')}</optgroup>` : ''}
      ${short.length ? `<optgroup label="${esc(t('Tournaments'))}">${short.map(opt).join('')}</optgroup>` : ''}
    </select>`;
}

function headHtml(events, selected, whenHtml = '') {
  return `<section class="ev-head gr-head">
      <label class="gr-pick"><span class="ui-stat-label">${esc(t('Event'))}</span>${pickerHtml(events, selected)}</label>
      ${whenHtml ? `<div class="ev-when">${whenHtml}</div>` : ''}
    </section>`;
}

/** Picking an event opens its history; All events goes back to the window. */
function wirePicker(el) {
  el.querySelector('[data-gr-event]')?.addEventListener('change', (e) => {
    const key = e.target.value;
    window.location.hash = buildHash(ROUTE, key ? { event: key } : windowParams());
  });
}

/** `/game/events?…` → { ok, events, runs } or { ok: false, why }. */
async function fetchRankings(query) {
  let res = null;
  try { res = await api(`/game/events?${query}`); } catch { res = null; }
  if (!res || !Array.isArray(res.runs)) return { ok: false, why: refusalText(res) };
  return { ok: true, events: asList(res.events), runs: res.runs };
}

function showError(el, why, again) {
  el.innerHTML = errorStateHtml(t('Could not load the standings.'), why);
  wireRetry(el, again);
}

/**
 * Events → In-game rankings. The address picks the view (see above); a new
 * view starts at the top, since a row clicked far down a week is a navigation
 * within the same page and the router leaves the scroll where it was.
 */
export async function renderGameRankings(el) {
  const params = parseHashRoute().params;
  const run = parseRunParam(params.get('run'));
  const event = params.get('event');
  if (run || event) window.scrollTo(0, 0);
  if (run) return renderRunView(el, run);
  if (event) return renderEventHistory(el, event);
  const period = params.get('period');
  if (RANKING_PERIODS.includes(period)) {
    rkPeriod = period;
    rkOffset = periodOffsetFromAnchor(period, params);
  }
  el.innerHTML = emptyHtml(t('Loading…'));
  return renderWindow(el);
}

/** The window's runs: live now, the tournaments folded, then each game day's, newest day first. */
async function renderWindow(el) {
  const rolloverHr = getGameDayRolloverUtcHour();
  const weekStart = getWeekStart();
  const win = computeGameWindow(rkPeriod, rkOffset, rolloverHr, weekStart);
  syncAddress();
  const token = ++rkLoad;
  el.setAttribute('aria-busy', 'true');
  const res = await fetchRankings(new URLSearchParams({ from: win.from, to: win.to }).toString());
  if (token !== rkLoad || !el.isConnected) return;
  el.removeAttribute('aria-busy');
  if (!res.ok) { showError(el, res.why, () => renderWindow(el)); return; }
  const scrubber = periodScrubberHtml({ periods: RANKING_PERIODS, period: rkPeriod, offset: rkOffset, rolloverHr, weekStart, win });
  el.innerHTML = `<div class="gr">
      ${headHtml(res.events, '', scrubber)}
      ${res.events.length
        ? windowBodyHtml(res.runs, win)
        : emptyHtml(t('No in-game rankings read yet. Every scan reads the standings of the events running in the game.'))}
    </div>`;
  wirePeriodScrubber(el, {
    onPeriod: (p) => { rkPeriod = p; rkOffset = 0; void renderWindow(el); },
    onStep: (delta) => { rkOffset = Math.max(0, rkOffset + delta); void renderWindow(el); },
  });
  wirePicker(el);
  el.querySelector('.gr-tournaments')?.addEventListener('toggle', (e) => { tournamentsOpen = e.currentTarget.open; });
}

function windowBodyHtml(runs, win) {
  if (!runs.length) return emptyHtml(t('No event standings were read in this timeframe.'));
  // Live only means something in the window that holds now; a month-long run
  // overlapping an older week is listed under the day it started, badge and all.
  const current = rkOffset === 0;
  const live = current ? runs.filter((r) => r.live) : [];
  const rest = current ? runs.filter((r) => !r.live) : runs;
  const tiles = [];
  if (live.length) {
    const endMs = (r) => (r.endsAt ? Date.parse(r.endsAt) : Infinity);
    tiles.push(tileHtml('gr-live', esc(t('Live now')), rowsHtml([...live].sort((a, b) => endMs(a) - endMs(b)), { badge: false }), { span: 12 }));
  }
  const short = rest.filter((r) => r.short);
  if (short.length) tiles.push(tournamentsFoldHtml(short));
  const fromMs = Date.parse(win.from);
  const days = new Map();
  const earlier = [];
  for (const r of rest.filter((x) => !x.short)) {
    const s = r.startsAt ? Date.parse(r.startsAt) : NaN;
    if (!Number.isFinite(s) || s < fromMs) { earlier.push(r); continue; }
    const day = gameDayKeyFor(s);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(r);
  }
  for (const day of [...days.keys()].sort().reverse()) {
    tiles.push(tileHtml(`gr-${day}`, esc(weekdayName(day)), rowsHtml(days.get(day).sort(byRunName)), {
      span: 12, link: `<span class="ui-sub">${esc(day)}</span>`,
    }));
  }
  if (earlier.length) tiles.push(tileHtml('gr-earlier', esc(t('Started earlier')), rowsHtml(earlier.sort(byRunName)), { span: 12 }));
  return `<div class="gr-list">${tiles.join('')}</div>`;
}

/** The window's tournaments, one row per tournament: how many ran and the best #1 among them. */
function tournamentsFoldHtml(runs) {
  const groups = new Map();
  for (const r of runs) {
    const g = groups.get(r.group) ?? { run: r, runs: 0, best: null };
    g.runs++;
    if (r.leader && (!g.best || r.leader.points > g.best.points)) g.best = r.leader;
    groups.set(r.group, g);
  }
  const rows = [...groups.values()]
    .sort((a, b) => byRunName(a.run, b.run))
    .map((g) => linkRowHtml(buildHash(ROUTE, { event: g.run.group }), runName(g.run), factsHtml([esc(tn(g.runs, '{n} run', '{n} runs', { n: g.runs }))]), g.best))
    .join('');
  return foldHtml({
    key: 'game-rankings-tournaments',
    title: `${esc(t('Tournaments'))} <span class="gr-fold-n">${esc(tn(runs.length, '{n} run', '{n} runs', { n: runs.length }))}</span>`,
    body: `<p class="ui-sub">${esc(t('The short rotating tournaments, a few hours each. Pick one to see all its runs.'))}</p>
      <ul class="ui-rows gr-rows">${rows}</ul>`,
    open: tournamentsOpen,
    cls: 'gr-tournaments',
  });
}

/** Every run of one event, newest first, 25 to a page. */
async function renderEventHistory(el, key) {
  el.innerHTML = emptyHtml(t('Loading…'));
  const res = await fetchRankings(new URLSearchParams({ event: key }).toString());
  if (!el.isConnected) return;
  if (!res.ok) { showError(el, res.why, () => renderEventHistory(el, key)); return; }
  const group = res.events.find((g) => g.key === key) || null;
  const runs = res.runs;
  let page = 1;
  const draw = () => {
    const pages = Math.max(1, Math.ceil(runs.length / PAGE_SIZE));
    page = Math.min(Math.max(1, page), pages);
    const count = tn(runs.length, '{n} run', '{n} runs', { n: runs.length });
    const body = runs.length
      ? `<p class="ui-sub">${esc(count)}</p>
        ${rowsHtml(runs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), { named: false })}
        ${paginationHtml(page, pages, count)}`
      : emptyHtml(t('No in-game rankings read yet. Every scan reads the standings of the events running in the game.'));
    const name = group ? groupName(group) : (runs[0] ? runName(runs[0]) : t('Event'));
    const link = group?.eventKey ? tileLinkHtml(`#events/${group.eventKey}`, t('Open the event')) : '';
    el.innerHTML = `<div class="gr">
        ${headHtml(res.events, key)}
        <div class="gr-list">${tileHtml('gr-event', esc(name), body, { span: 12, link })}</div>
      </div>`;
    wirePicker(el);
    el.querySelectorAll('[data-gs-page]').forEach((b) => b.addEventListener('click', () => {
      page = Number(b.dataset.gsPage) || 1;
      draw();
    }));
  };
  draw();
}

/** One run's full standings, with the way to its event's other runs and to the event's own tab. */
async function renderRunView(el, key) {
  el.innerHTML = emptyHtml(t('Loading…'));
  let data = null;
  try {
    data = await api(`/game/events/standings?${new URLSearchParams(key)}`);
  } catch { data = null; }
  if (!el.isConnected) return;
  if (!data || refusalText(data)) { showError(el, refusalText(data), () => renderRunView(el, key)); return; }
  const run = data.run || null;
  // The picker's list; the run's event is the one picked.
  const list = run ? await fetchRankings(new URLSearchParams({ event: run.group }).toString()) : { ok: false };
  if (!el.isConnected) return;
  const events = list.ok ? list.events : [];
  if (!run) {
    el.innerHTML = `<div class="gr">${events.length ? headHtml(events, '') : ''}${emptyHtml(t('No event standings were read in this timeframe.'))}</div>`;
    wirePicker(el);
    return;
  }
  const standings = asList(data.standings);
  const when = whenText(run);
  const status = [run.live ? liveBadgeHtml() : '', when ? esc(when) : ''].filter(Boolean).join(' · ');
  const links = [
    tileLinkHtml(buildHash(ROUTE, { event: run.group }), t('All runs of this event')),
    run.eventKey ? tileLinkHtml(`#events/${run.eventKey}`, t('Open the event')) : '',
  ].join('');
  let page = 1;
  const draw = () => {
    el.innerHTML = `<div class="gr">
        ${events.length ? headHtml(events, run.group) : ''}
        <section class="ev-section game-standings-card" aria-labelledby="gr-run-title">
          <div class="ev-section-head">
            <h2 class="ev-section-title" id="gr-run-title">${esc(runName(run))}</h2>
            <span class="ui-sub" title="${esc(formatDate(run.readAt))}">${esc(t('Read {time}', { time: formatRelativeTime(run.readAt) }))}</span>
          </div>
          ${status ? `<p class="ui-sub">${status}</p>` : ''}
          <div class="gr-links">${links}</div>
          <p class="ui-copy">${esc(standingsCopy(run))}</p>
          ${standingsTableHtml(standings, page)}
        </section>
      </div>`;
    wirePicker(el);
    el.querySelectorAll('[data-gs-page]').forEach((b) => b.addEventListener('click', () => {
      page = Number(b.dataset.gsPage) || 1;
      draw();
    }));
  };
  draw();
}
