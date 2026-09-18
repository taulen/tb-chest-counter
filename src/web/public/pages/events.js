// Events — per-event chest participation.
//
// One sub-tab per in-game event (Ancients, Ragnarok, Olympus, Dark Omens,
// Triumphal, Citadels, Runics, Heroics — driven by GET /api/events). Each event
// shows summary stat cards, an optional level-distribution card (vaults), and a
// per-player matrix: one column per chest in the event, or one per source level
// (Citadels) / per declared level tier (Heroics), plus Total / Points / Last
// Seen. Every column is sortable; Rank is canonical.
//
// A cell whose column aggregates several things carries its split as a hover
// tooltip — component chests for Dark Omens' Minor/Major/Epic, individual
// levels for a Heroics tier. Both arrive the same way (column.parts +
// row.breakdown) and render through columnBreakdownTip.
//
// Opening the page without a key (#events, i.e. the nav link) selects the event
// that is LIVE right now per the calendar feed — see defaultEventKey().
//
// Timeframe: most events are feed-driven and show a per-OCCURRENCE selector —
// one event run = one selectable window (← older / → newer + "All time"),
// sourced from GET /events/:key/occurrences. This fixes sub-weekly events
// (e.g. Runics) that would otherwise show twice inside one weekly bucket.
// Triumphal uses the same selector over its rolling 30-day cycles (mode:'cycle').
// Events with no schedule at all (Citadels and Heroics, both 24/7 ongoing) —
// and any event when the calendar feed is unavailable — fall back to the classic
// Weekly/Monthly/Yearly/All game-window selector (same as Leaderboard/Resources).
// Timeframe state is module-local and repaints in place, so changing it never
// changes the selected event sub-tab (the sub-tab is the hash route). Mirrors
// pages/resources-totals.js.

import { api } from '../lib/api.js';
import { esc, memberLink, formatDate } from '../lib/ui.js';
import { computeGameWindow, gameDaysUntil } from '../lib/period.js';
import { renderPeriodNav } from '../lib/period-nav.js';
import {
  formatResourceAmount, formatResourceCompact,
  isResourcesEnabledForActiveClan,
} from '../lib/resource-format.js';

const PAGE_SIZE = 25;
const PERIODS = ['weekly', 'monthly', 'yearly', 'all'];

// Dark Omens gets an extra informational "Essence" column, auto-filled from the
// Resources tab (Omen Essence donated). It's purely informational — never part
// of the event's Total or Points. Only this event; only when the clan tracks
// resources.
const ESSENCE_EVENT_KEY = 'dark-omens';
const ESSENCE_SLUG = 'omen-essence';

let period = 'weekly';   // same game-week system as the rest of the site
let periodOffset = 0;    // 0 = current period, 1 = previous, …
// Per-occurrence selector. `occurrences` is a non-empty array only for events
// that have windows (calendar feed, or a rolling cycle) AND they loaded;
// otherwise it's [] and we render the fixed period selector above. `occSel` is
// the selected index (0 = most recent) or the string 'all' for the
// aggregate-across-runs view. `occMode` is 'occurrences' (discrete feed runs) or
// 'cycle' (Triumphal's rolling 30 days) — the latter skips the per-window "live"
// marker, since a cycle that restarts on reset is always the live one.
let occurrences = [];
let occMode = 'occurrences';
let eventSeries = null;   // this event, run over run
let occSel = 0;
let page = 1;
let sort = { key: 'points', dir: 'desc' };
let currentEventKey = null;
let catalog = null;      // [{ key, name, order, description }]
let cache = null;        // current EventBreakdown from the API
// Separate breakdown for the info-card (Finish Reward) recipients. Finish
// rewards are awarded at day-end and scanned AFTER the occurrence's clamped
// window, so the card is computed over a WIDER window — this run's start up to
// the next run's start — while the participation table keeps the clamped
// window. Falls back to `cache` when no widening is needed.
let finishCache = null;
// Omen Essence donated per member (memberId → amount) for the current window,
// or null when not applicable (non-Dark-Omens event, or resources disabled).
let essenceByMember = null;
let activeMembers = [];  // all active clan members (for the non-participants list)
let nonParticipantsOpen = false;  // collapsed by default; remembered across repaints
let mountedEl = null;
let navigateFn = null;
// Ticks the tab schedule tags (countdown + live flip) without a page reload.
let scheduleTimer = null;

export async function renderEvents(el, navigate, eventKey) {
  mountedEl = el;
  navigateFn = navigate;

  const wanted = (eventKey || '').trim();
  // Refetch the catalog on first mount, and again whenever no event key was
  // given: the `live` flags decide which tab opens, and the module-level cache
  // only self-refreshes while the page is mounted — so a cached catalog can be
  // hours stale by the time someone clicks the Events nav link again. The
  // endpoint is feed-cached server-side, so this is cheap.
  if (!catalog || !wanted) {
    try {
      const res = await api('/events');
      if (Array.isArray(res?.events) && res.events.length) catalog = res.events;
    } catch { /* keep the last-known catalog (possibly null → handled below) */ }
    if (!catalog) catalog = [];
  }
  if (!catalog.length) {
    el.innerHTML = '<div class="card"><div class="card-body"><p>No events configured.</p></div></div>';
    return;
  }

  // Resolve the requested event. With no key in the hash (i.e. arriving via the
  // Events nav link) default to whatever is running right now — the first
  // catalog event flagged `live` by the calendar feed — so the page opens on the
  // event people are actually playing. Nothing live (rare quiet days, or a feed
  // outage) falls back to the first event in catalog order (Ancients).
  const match = catalog.find((e) => e.key === wanted);
  currentEventKey = match ? match.key : defaultEventKey();

  page = 1;
  sort = { key: 'points', dir: 'desc' };  // columns differ per event → fresh sort
  el.innerHTML = `${eventTabsHtml(currentEventKey)}<div class="empty-state"><p>Loading…</p></div>`;

  // Load this event's occurrence windows. mode:'occurrences' (feed runs) or
  // 'cycle' (Triumphal's rolling 30 days) with a non-empty list → occurrence
  // selector, defaulting to the most recent window. mode:'fixed' (Citadels) or
  // an empty list (feed down) → fixed period selector.
  occurrences = [];
  occMode = 'occurrences';
  occSel = 0;
  try {
    const occRes = await api(`/events/${encodeURIComponent(currentEventKey)}/occurrences`);
    const list = Array.isArray(occRes?.occurrences) ? occRes.occurrences : [];
    if ((occRes?.mode === 'occurrences' || occRes?.mode === 'cycle') && list.length) {
      occurrences = list;
      occMode = occRes.mode;
    }
  } catch {
    occurrences = [];
  }

  await reload();
  startScheduleRefresh();
}

// Keep the tab schedule tags live: every minute re-pull the (feed-cached, cheap)
// catalog so `live`/next-occurrence stay current, and re-render the tab bar so
// the countdown ticks down. Self-cleans once the Events page is unmounted (the
// router swaps the container contents, so the .events-tabs bar disappears).
function startScheduleRefresh() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = setInterval(refreshScheduleTags, 60_000);
}

async function refreshScheduleTags() {
  if (!mountedEl || !mountedEl.querySelector('.events-tabs')) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
    return;
  }
  try {
    const res = await api('/events');
    if (Array.isArray(res?.events) && res.events.length) catalog = res.events;
  } catch { /* keep last-known catalog; tab still re-renders the countdown */ }
  const bar = mountedEl && mountedEl.querySelector('.events-tabs');
  if (bar) bar.outerHTML = eventTabsHtml(currentEventKey);
}

// Which event a bare #events resolves to: the first live one in catalog order
// (two concurrent runs → the earlier tab wins), else the first event overall.
function defaultEventKey() {
  const live = catalog.find((e) => e.live);
  return (live || catalog[0]).key;
}

// Event sub-tab bar — reuses the generic .resources-tabs segmented control.
// Every tab links to #events/<key>, including the first: a bare #events means
// "whatever is live", so the first event needs its own explicit route to stay
// selectable while something else is running. Plain hash links, so clicking one
// navigates (hashchange → renderEvents) — the only path that changes the
// selected event.
function eventTabsHtml(activeKey) {
  return `<div class="resources-tabs events-tabs" role="tablist">${catalog
    .map((e) => {
      const href = `#events/${e.key}`;
      const active = e.key === activeKey ? 'is-active' : '';
      return `<a class="resources-tab ${active}" href="${href}"><span class="event-tab-name">${esc(e.name)}</span>${eventScheduleTag(e)}</a>`;
    })
    .join('')}</div>`;
}

// Small schedule sub-line under an event tab: "Live now" while a run is in
// progress, else "<date> · in Nd" for the next upcoming run. A rolling-cycle
// event (Triumphal) is always running, so a "live" badge would say nothing —
// it gets the countdown to its next reset instead. Nothing for events with no
// schedule at all (Citadels) or a down feed.
function eventScheduleTag(e) {
  if (e.endsAt) return `<span class="event-tab-next">Resets in ${esc(timeLeftUntil(e.endsAt))}</span>`;
  if (e.live) return '<span class="event-tab-next is-live">Live now</span>';
  if (!e.nextFrom || !e.nextLabel) return '';
  return `<span class="event-tab-next">${esc(e.nextLabel)} · ${esc(relativeUntil(e.nextFrom))}</span>`;
}

// Compact countdown to an upcoming ISO timestamp, single unit, stepping down as
// it nears: game-DAYS while ≥ a day out (17:00-reset aligned, like the date
// label — an event starts on a reset, so "in 2d" = two resets away), then
// wall-clock hours in the final day, then minutes in the final hour.
function relativeUntil(iso) {
  const startMs = Date.parse(iso);
  if (!Number.isFinite(startMs)) return '';
  const wallMs = startMs - Date.now();
  const HOUR = 60 * 60 * 1000;
  if (wallMs <= 0) return 'now';
  if (wallMs < 24 * HOUR) {
    if (wallMs >= HOUR) return `in ${Math.floor(wallMs / HOUR)}h`;
    const mins = Math.floor(wallMs / (60 * 1000));
    return mins < 1 ? 'now' : `in ${mins}m`;
  }
  return `in ${gameDaysUntil(startMs)}d`;
}

// Time left until a reset, two units, mirroring the in-game timer — which counts
// real hours down ("26d 6h left"), not reset boundaries like relativeUntil.
function timeLeftUntil(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (ms <= 0) return 'moments';
  if (ms >= DAY) return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`;
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MIN)}m`;
  return `${Math.max(1, Math.floor(ms / MIN))}m`;
}

// Real-UTC ISO [from, to] window for the current selection (empty → all-time).
// Occurrence mode uses the selected run's window (already scan-tail-adjusted by
// the backend); 'all' and the fixed selector's "all" both mean no bounds.
function periodWindow() {
  if (occurrences.length) {
    if (occSel === 'all') return { from: '', to: '' };
    const occ = occurrences[occSel] || occurrences[0];
    return { from: occ.from, to: occ.to };
  }
  const win = computeGameWindow(period, periodOffset);
  return win ? { from: win.from, to: win.to } : { from: '', to: '' };
}

async function reload() {
  const { from, to } = periodWindow();
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  try {
    const [breakdown, membersRes] = await Promise.all([
      api(`/events/${encodeURIComponent(currentEventKey)}?${qs}`),
      api('/members'),  // active members only — for the non-participants list
    ]);
    cache = breakdown;
    activeMembers = Array.isArray(membersRes) ? membersRes : [];
  } catch {
    cache = null;
  }
  await loadFinishReward(from, to);
  await loadEssence(from, to);
  // Run-over-run history. Independent of the selected occurrence — it is
  // always "the last N runs of this event" — so it is fetched here rather than
  // recomputed per timeframe change.
  eventSeries = await api(`/events/${encodeURIComponent(currentEventKey)}/series`)
    .catch(() => null);
  paint();
}

// Finish Reward (info card) window. A run's end-of-event ranking chest is
// awarded at day-end and captured in a scan that often lands after the
// occurrence's clamped upper bound — so the clamped window misses it. Recompute
// the info-card recipients over the run's FULL span: [this occurrence's start,
// next occurrence's start). Occurrences are newest-first, so the next
// chronological run is at occSel-1; the most-recent run stays open-ended (to
// "now"). Only meaningful for a single selected occurrence — "All time" and the
// fixed period selector are already wide enough, so we reuse the main breakdown.
async function loadFinishReward(from, to) {
  finishCache = null;
  if (!cache) return;
  const hasInfoCard = (cache.columns || []).some((c) => c.infoCard);
  if (!hasInfoCard) return;                       // no info card → nothing to widen
  if (!occurrences.length || occSel === 'all') { finishCache = cache; return; }

  const occ = occurrences[occSel] || occurrences[0];
  const nextOcc = occSel > 0 ? occurrences[occSel - 1] : null;  // newer run, or none
  const fFrom = occ.from || '';
  const fTo = nextOcc ? (nextOcc.from || '') : '';             // open-ended for latest run
  // Same bounds as the participation window → nothing gained, reuse it.
  if (fFrom === (from || '') && fTo === (to || '')) { finishCache = cache; return; }

  try {
    const q = new URLSearchParams();
    if (fFrom) q.set('from', fFrom);
    if (fTo) q.set('to', fTo);
    finishCache = await api(`/events/${encodeURIComponent(currentEventKey)}?${q}`);
  } catch {
    finishCache = cache;  // fall back to the clamped window rather than blank
  }
}

// Dark Omens' informational Essence column. Pulls each member's Omen Essence
// donated (Sent) for the current window from the Resources tab and keys it by
// memberId. Leaves essenceByMember null (→ no column) for other events, when
// the clan doesn't track resources, or on any error — it's a nice-to-have that
// must never break the event table. Resource dates are day-granular, so the
// event window's ISO bounds are sliced to YYYY-MM-DD (same as Resources Totals).
async function loadEssence(from, to) {
  essenceByMember = null;
  if (currentEventKey !== ESSENCE_EVENT_KEY) return;
  try {
    if (!(await isResourcesEnabledForActiveClan())) return;
    const eqs = new URLSearchParams();
    if (from) eqs.set('from', from.slice(0, 10));
    if (to) eqs.set('to', to.slice(0, 10));
    const [typesRes, summaryRes] = await Promise.all([
      api('/resources/types'),
      api(`/resources/summary?${eqs}`),
    ]);
    const types = Array.isArray(typesRes) ? typesRes : (typesRes?.types ?? []);
    const essenceType = types.find((t) => t.slug === ESSENCE_SLUG);
    if (!essenceType) return;  // clan/type not present → no column
    const summary = Array.isArray(summaryRes?.rows) ? summaryRes.rows : [];
    const map = new Map();
    for (const r of summary) {
      if (r.resourceTypeId === essenceType.id && r.sentAmount > 0) {
        map.set(r.memberId, (map.get(r.memberId) || 0) + r.sentAmount);
      }
    }
    essenceByMember = map;
  } catch {
    essenceByMember = null;
  }
}

// Canonical rank: countable points desc, then countable Total desc, then
// name — matches the default sort so the initial view's ranks read in order.
// Assigned before the user's chosen sort so Rank stays stable across re-sorts.
function rankPlayers(players) {
  const ranked = [...players];
  ranked.sort(
    (a, b) =>
      (b.countablePoints - a.countablePoints) ||
      (b._ctotal - a._ctotal) ||
      (a.memberName || '').localeCompare(b.memberName || ''),
  );
  ranked.forEach((p, i) => { p._rank = i + 1; });
  return ranked;
}

function sortedForDisplay(players, columns) {
  const arr = [...players];
  const { key, dir } = sort;
  const mul = dir === 'asc' ? 1 : -1;
  // A stale column sort (level columns can vanish across timeframes) → Total.
  const colKey = key.startsWith('col:') ? key.slice(4) : null;
  const colValid = colKey !== null && columns.some((c) => c.key === colKey);
  arr.sort((a, b) => {
    if (key === 'name') return (a.memberName || '').localeCompare(b.memberName || '') * mul;
    let av;
    let bv;
    if (key === 'rank') { av = a._rank; bv = b._rank; }
    else if (key === 'points') { av = a.countablePoints; bv = b.countablePoints; }
    else if (key === 'essence') {
      av = essenceByMember?.get(a.memberId) || 0;
      bv = essenceByMember?.get(b.memberId) || 0;
    }
    else if (colValid) { av = a.counts[colKey] || 0; bv = b.counts[colKey] || 0; }
    else { av = a._ctotal; bv = b._ctotal; }  // default 'total' (countable)
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return 0;
  });
  return arr;
}

// Tooltip text for an aggregated column's cell — "Minor Omen: 2 · Major Omen: 3
// · Epic Omen: 1", in the column's declared part order. Returns '' for
// single-chest columns or when this player has no split for it.
function columnBreakdownTip(column, row) {
  const parts = Array.isArray(column.parts) ? column.parts : null;
  if (!parts || !parts.length) return '';
  const split = (row.breakdown && row.breakdown[column.key]) || {};
  return parts
    .map((name) => `${name.replace(/\s*Chest$/i, '')}: ${(split[name] || 0).toLocaleString()}`)
    .join(' · ');
}

// Fixed Weekly/Monthly/Yearly/All selector — the fallback for events with no
// calendar schedule (Triumphal, Citadels) or when the feed is unavailable.
function fixedControlsHtml() {
  const periodBtns = PERIODS.map(
    (p) => `<button class="btn ${period === p ? 'active' : ''}" data-tperiod="${p}">${p.charAt(0).toUpperCase()}${p.slice(1)}</button>`,
  ).join('');
  return `
    <div class="period-selector">${periodBtns}</div>
    ${renderPeriodNav({
      period,
      offset: periodOffset,
      prevAttr: 'data-tperiod-nav="prev"',
      nextAttr: 'data-tperiod-nav="next"',
      navClass: 'events-nav',
    })}`;
}

// Per-occurrence selector — one event run per step (← older / → newer), plus an
// "All time" toggle that aggregates across every run. `occSel` is the index or
// 'all'. ← moves to an older run (higher index, list is newest-first).
function occurrenceControlsHtml() {
  const len = occurrences.length;
  const isAll = occSel === 'all';
  const occ = isAll ? null : (occurrences[occSel] || occurrences[0]);
  const label = isAll ? 'All time' : (occ ? occ.label : '');
  // "live" reads as part of the label ("Jul 26–30 · live") rather than as a
  // separate badge floating in the nav's fixed-width slot. Skipped in cycle mode:
  // the newest cycle is always the live one, so the flag carries no information —
  // the window's hover text gives the reset countdown instead.
  const isCurrent = !isAll && occ && occ.isCurrent;
  const live = isCurrent && occMode !== 'cycle'
    ? '<span class="events-occ-live" title="Event in progress">· live</span>'
    : '';
  // Runs older than the calendar feed's ~1-month reach have dates projected
  // from the event's cadence, not read from the feed. The totals are still the
  // clan's own chests — only the window's edges are inferred — so this is a
  // quiet footnote on the label, not a warning.
  const est = !isAll && occ && occ.estimated
    ? '<span class="events-occ-est" title="Dates projected from this event\'s schedule — the calendar feed only carries about a month of history">· est.</span>'
    : '';
  const labelTitle = isCurrent && occMode === 'cycle' && occ.to
    ? ` title="Current cycle — resets in ${esc(timeLeftUntil(occ.to))}"`
    : '';
  // In "All time" the arrows stay ENABLED and act as the way back into the
  // occurrence list (← → the oldest / newest run) — otherwise the only exit is
  // re-clicking the highlighted toggle, which isn't discoverable.
  const prevDisabled = !isAll && occSel >= len - 1;
  const nextDisabled = !isAll && occSel <= 0;
  // Cycle mode steps through 30-day cycles, not discrete runs — say so in the
  // arrow tooltips rather than calling them "occurrences".
  const unit = occMode === 'cycle' ? 'cycle' : 'occurrence';
  return `
    <div class="period-nav events-nav">
      <button class="btn btn-tight" data-occ-nav="prev" ${prevDisabled ? 'disabled' : ''} title="${isAll ? `Oldest ${unit}` : `Older ${unit}`}">←</button>
      <span class="period-nav-label"${labelTitle}>${esc(label)}${live}${est}</span>
      <button class="btn btn-tight" data-occ-nav="next" ${nextDisabled ? 'disabled' : ''} title="${isAll ? `Newest ${unit}` : `Newer ${unit}`}">→</button>
    </div>
    <button class="btn ${isAll ? 'active' : ''}" data-occ-all title="${isAll ? `Showing all ${unit}s — pick a single one with the arrows` : `Aggregate across all ${unit}s`}">All time</button>`;
}

/**
 * The same event, run over run.
 *
 * "How does this cycle compare to the last one" is the question a leader
 * actually has about an event, and every calendar-window delta answers it with
 * noise: a week containing Ragnarok against a week that doesn't is a
 * coincidence of the calendar, not a comparison. Only occurrence-to-occurrence
 * is honest.
 *
 * A run with no data at all draws as a GAP rather than a zero — the event may
 * simply predate this clan's history, and a zero bar says the clan turned up
 * and scored nothing.
 */
function eventSeriesCardHtml() {
  const runs = (eventSeries?.runs || []).filter(Boolean);
  // Two points is a line, not a trend; three is the least that shows a shape.
  if (runs.filter((r) => r.points !== null).length < 3) return '';

  const peak = Math.max(1, ...runs.map((r) => r.points || 0));
  const bars = runs.map((r) => {
    // Runs older than the calendar feed's reach carry projected dates (see
    // `estimated`), so the hover text says so rather than presenting them as read.
    const est = r.estimated ? ' (estimated dates)' : '';
    if (r.points === null) {
      return `<span class="evseries-col" title="${esc(r.label)}${est}: no data">
          <span class="evseries-gap"></span>
        </span>`;
    }
    const h = Math.max(2, Math.round((r.points / peak) * 100));
    return `<span class="evseries-col" title="${esc(r.label)}${est}: ${r.points.toLocaleString()} pts · ${(r.chests ?? 0).toLocaleString()} chests · ${(r.participants ?? 0).toLocaleString()} players">
        <span class="evseries-bar${r.isCurrent ? ' is-current' : ''}" style="height: ${h}%"></span>
      </span>`;
  }).join('');

  const withData = runs.filter((r) => r.points !== null);
  const latest = withData[withData.length - 1];
  const prior = withData[withData.length - 2];
  const delta = latest && prior && prior.points > 0
    ? Math.round(((latest.points - prior.points) / prior.points) * 100)
    : null;

  return `
    <div class="card mt-24">
      <div class="card-header">
        <h2>Run over run</h2>
        <span class="card-header-hint">Points per occurrence · newest on the right</span>
      </div>
      <div class="card-body card-body-padded">
        <div class="evseries-chart">${bars}</div>
        <div class="evseries-labels">
          <span>${esc(runs[0]?.label || '')}</span>
          <span>${esc(runs[runs.length - 1]?.label || '')}</span>
        </div>
        ${delta !== null ? `<p class="muted-copy evseries-note">
          The latest run is ${delta === 0 ? 'level with' : `${Math.abs(delta)}% ${delta > 0 ? 'above' : 'below'}`} the one before it${latest.isCurrent ? ', and is still in progress' : ''}.
        </p>` : ''}
      </div>
    </div>`;
}

function paint() {
  if (!mountedEl) return;
  const el = mountedEl;

  if (!cache) {
    el.innerHTML = `${eventTabsHtml(currentEventKey)}<div class="card"><div class="card-body"><p>Failed to load event data.</p></div></div>`;
    wireTabsOnly();
    return;
  }

  const columns = Array.isArray(cache.columns) ? cache.columns : [];
  // infoCard columns (e.g. Dark Omens' leader "Finish Reward") render as a
  // top-of-page summary box, not a matrix column — keep them out of the matrix.
  const matrixColumns = columns.filter((c) => !c.infoCard);
  // Info-card recipients come from the WIDER finish-reward window (see
  // loadFinishReward), so a day-end reward scanned after the occurrence's
  // clamped bound still attributes to the right run. Falls back to `cache`.
  const fc = finishCache || cache;
  const fcPlayers = Array.isArray(fc.players) ? fc.players : [];
  const infoCards = (Array.isArray(fc.columns) ? fc.columns : []).filter((c) => c.infoCard);
  // Dark Omens informational Essence column — only when we actually loaded it.
  const showEssence = essenceByMember !== null;
  const players = Array.isArray(cache.players) ? cache.players : [];
  // Alias the backend's countable chest total (used for cells, rank, the
  // "total" sort, and the Avg/Participant summary).
  players.forEach((p) => { p._ctotal = p.countableChests || 0; });
  const ranked = rankPlayers(players);
  const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
  const countableCols = matrixColumns.filter((c) => c.countInTotal !== false);
  const totalTitle = `Sum of: ${countableCols.map((c) => c.label).join(', ') || '—'}`;

  const all = sortedForDisplay(ranked, matrixColumns);
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  const start = (page - 1) * PAGE_SIZE;
  const pageRows = all.slice(start, start + PAGE_SIZE);

  // ── timeframe controls ──
  // Occurrence selector for feed-driven events; otherwise the fixed
  // Weekly/Monthly/Yearly/All selector (verbatim from resources-totals).
  const controlsHtml = occurrences.length
    ? occurrenceControlsHtml()
    : fixedControlsHtml();

  // ── stat cards ──
  // "Total from the table below" = sum of the countable Total column, so
  // Avg/Participant matches what the table shows (lower than grand total
  // for Ancients, where Vault + Golden Guardian don't count as participation).
  const tableTotal = players.reduce((s, p) => s + (p._ctotal || 0), 0);
  const avgPer = cache.uniqueParticipants > 0
    ? Math.round((tableTotal / cache.uniqueParticipants) * 10) / 10
    : 0;
  // Optional lead card, e.g. Ancients "Vaults Taken Down" — every leveled
  // (vault) chest is one vault kill, so sum the level-card chest counts.
  const vaultsCard = cache.levelSummaryLabel
    ? `<div class="stat-card stat-card-lead"><div class="label">${esc(cache.levelSummaryLabel)}</div><div class="value">${(Array.isArray(cache.levelCard) ? cache.levelCard.reduce((s, l) => s + (l.chests || 0), 0) : 0).toLocaleString()}</div></div>`
    : '';
  // Info-card lead boxes for rarely-awarded chests (e.g. Dark Omens' leader
  // "Finish Reward"): show who received it in this timeframe, not a column.
  const finishCards = infoCards.map((ic) => {
    const recips = fcPlayers
      .filter((p) => (p.counts[ic.key] || 0) > 0)
      .map((p) => ({ name: p.memberName || '—', count: p.counts[ic.key] || 0 }))
      .sort((a, b) => b.count - a.count);
    const totalCount = recips.reduce((s, r) => s + r.count, 0);
    const chestsLabel = `${totalCount.toLocaleString()} chest${totalCount === 1 ? '' : 's'}`;
    let value;   // hero — the chest count is what matters
    let sub;     // secondary — who received them
    let cardTitle;
    if (!recips.length) {
      value = '—';
      sub = 'Not awarded';
      cardTitle = 'Not awarded in this timeframe';
    } else if (recips.length === 1) {
      value = chestsLabel;
      sub = esc(recips[0].name);
      cardTitle = `${recips[0].name} — ${chestsLabel}`;
    } else {
      value = chestsLabel;
      sub = `${esc(recips[0].name)} +${recips.length - 1}`;
      cardTitle = recips.map((r) => `${r.name}: ${r.count}`).join(' · ');
    }
    return `<div class="stat-card stat-card-lead" title="${esc(cardTitle)}">
      <div class="label">🏆 ${esc(ic.label)}</div>
      <div class="value">${value}</div>
      <div class="events-finish-sub">${sub}</div>
    </div>`;
  }).join('');
  // ── catalog-vs-data mismatches ──
  // A rule that resolves to nothing renders as a column of zeros, which is
  // indistinguishable from a week nobody played — that is exactly how the
  // Ragnarok/Jörmungandr rename went unnoticed. Say so out loud instead.
  const configErrors = Array.isArray(cache.configErrors) ? cache.configErrors : [];
  const configWarnHtml = configErrors.length
    ? `<div class="events-config-warning">
        <div class="events-config-warning-title">⚠ This event's chest list doesn't match the data</div>
        <ul>${configErrors
          .map((e) => {
            if (e.kind === 'source') {
              return `<li>Source filter <code>${esc(e.declared)}</code> matches no chest source, so the rule using it is switched off.</li>`;
            }
            if (e.resolvedTo) {
              return `<li><code>${esc(e.declared)}</code> is a stale spelling of <strong>${esc(e.resolvedTo)}</strong> — the chests below <em>are</em> counted, but the catalog entry should be corrected.</li>`;
            }
            return `<li><code>${esc(e.declared)}</code> matches no chest, so its column reads 0. Either the name is wrong or the chest has never been scanned.</li>`;
          })
          .join('')}</ul>
      </div>`
    : '';

  const statCards = `
    ${configWarnHtml}
    <div class="stats-grid">
      ${finishCards}
      ${vaultsCard}
      <div class="stat-card"><div class="label">Total Chests</div><div class="value">${(cache.totalChests || 0).toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Participants</div><div class="value">${(cache.uniqueParticipants || 0).toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Total Points</div><div class="value">${(cache.totalPoints || 0).toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Avg / Participant</div><div class="value">${avgPer.toLocaleString()}</div></div>
    </div>`;

  // ── optional level-distribution card (vaults) ──
  let levelCardHtml = '';
  if (cache.showLevelCard && Array.isArray(cache.levelCard) && cache.levelCard.length) {
    const levelHeader = cache.levelCardLabel || 'Vault';
    const rows = cache.levelCard
      .map(
        (r) => `<tr>
          <td data-label="${esc(levelHeader)}" data-role="primary"><span class="mrow-name">${esc(r.label)}</span><span class="mrow-sub">${(r.participants || 0).toLocaleString()} players</span></td>
          <td data-label="Players" class="col-num" data-role="hidden">${(r.participants || 0).toLocaleString()}</td>
          <td data-label="Chests" class="col-num">${(r.chests || 0).toLocaleString()}</td>
          <td data-label="Points" class="col-num" data-role="metric">${(r.points || 0).toLocaleString()}</td>
        </tr>`,
      )
      .join('');
    levelCardHtml = `
      <div class="card">
        <div class="card-header"><h2>By level</h2></div>
        <div class="card-body">
          <div class="events-scroll">
            <table class="table-responsive events-level-table">
              <colgroup><col class="col-level"><col class="col-num"><col class="col-num"><col class="col-num"></colgroup>
              <thead><tr><th>${esc(levelHeader)}</th><th class="num">Players</th><th class="num">Chests</th><th class="num">Points</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  // ── per-player matrix ──
  const colGroup = `<colgroup>
    <col class="col-caret"><col class="col-rank"><col class="col-member">
    ${matrixColumns.map(() => '<col class="col-num">').join('')}
    ${showEssence ? '<col class="col-num">' : ''}
    <col class="col-num"><col class="col-num">
  </colgroup>`;

  const unresolvedTitle = (c) =>
    c.unresolvedReason === 'source'
      ? `${c.label}: its source filter matches nothing, so this column is a config error, not a result.`
      : `${c.label}: no chest in the database matches this column's name, so its zeros are a config error, not a result.`;

  const headCols = matrixColumns
    .map((c) => {
      const key = `col:${c.key}`;
      const title = c.unresolved ? unresolvedTitle(c) : c.label;
      const mark = c.unresolved ? '<span class="events-unresolved-mark">!</span>' : '';
      return `<th class="sortable num ${sort.key === key ? 'is-sorted' : ''}" data-sort-key="${esc(key)}" title="${esc(title)}">${esc(c.label)}${mark}${arrow(key)}</th>`;
    })
    .join('');

  // Informational Essence column header (Dark Omens only). Not a point column —
  // the title spells that out so nobody mistakes it for participation.
  const essenceHead = showEssence
    ? `<th class="sortable num ${sort.key === 'essence' ? 'is-sorted' : ''}" data-sort-key="essence" title="Omen Essence donated (from Resources) — informational, not counted in Points">Essence${arrow('essence')}</th>`
    : '';

  const colspan = matrixColumns.length + 5 + (showEssence ? 1 : 0);
  const body = pageRows.length === 0
    ? `<tr><td colspan="${colspan}" class="empty-state-cell">No participation in this timeframe.</td></tr>`
    : pageRows
        .map((row) => {
          const cells = matrixColumns
            .map((c) => {
              const v = row.counts[c.key] || 0;
              // Unmarked: on mobile these per-chest-type columns are exactly
              // what the compact-row engine reveals in the tap-to-expand
              // panel (the richer native drill-down below is desktop-only).
              if (v <= 0) {
                // An unresolved column is always 0. Show "?" rather than the
                // em-dash so it can't be read as "this player earned none".
                const zero = c.unresolved
                  ? `<span class="events-unresolved" title="${esc(unresolvedTitle(c))}">?</span>`
                  : '<span class="events-zero">—</span>';
                return `<td data-label="${esc(c.label)}" class="col-num">${zero}</td>`;
              }
              // Aggregated columns (e.g. Dark Omens' Minor/Major/Epic) carry a
              // per-chest split — surface it as a hover tooltip so the combined
              // number stays explainable without expanding the row.
              const tip = columnBreakdownTip(c, row);
              const cell = tip
                ? `<span class="events-combined" title="${esc(tip)}">${v.toLocaleString()}</span>`
                : v.toLocaleString();
              return `<td data-label="${esc(c.label)}" class="col-num">${cell}</td>`;
            })
            .join('');
          let essenceCell = '';
          if (showEssence) {
            const ev = essenceByMember.get(row.memberId) || 0;
            essenceCell = ev <= 0
              ? '<td data-label="Essence" class="col-num"><span class="events-zero">—</span></td>'
              : `<td data-label="Essence" class="col-num" title="${esc(formatResourceAmount(ESSENCE_SLUG, ev))}">${esc(formatResourceCompact(ESSENCE_SLUG, ev))}</td>`;
          }
          return `<tr class="events-row" data-member-id="${row.memberId ?? ''}" data-member-name="${esc(row.memberName)}">
            <td class="caret-col" data-role="hidden"><span class="caret">▸</span></td>
            <td data-label="Rank" data-role="lead">${row._rank}</td>
            <td data-label="Player" data-role="primary"><span class="mrow-name">${memberLink(row.memberId, row.memberName)}</span><span class="mrow-sub">${(row._ctotal || 0).toLocaleString()} chests</span></td>
            ${cells}
            ${essenceCell}
            <td data-label="Total" class="col-num" data-role="hidden">${(row._ctotal || 0).toLocaleString()}</td>
            <td data-label="Points" class="col-num" data-role="metric">${(row.countablePoints || 0).toLocaleString()}</td>
          </tr>`;
        })
        .join('');

  const pagination = total > PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-events-page="prev" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
        <span class="pagination-info">Page ${page} of ${totalPages} · ${total} participants</span>
        <button class="btn btn-tight" data-events-page="next" ${page >= totalPages ? 'disabled' : ''}>Next →</button>
      </div>`
    : '';

  // ── did-not-participate: active members with no chests in this event/window ──
  const participantIds = new Set(players.map((p) => p.memberId));
  const nonParticipants = activeMembers.filter((m) => !participantIds.has(m.id));
  const npBody = nonParticipants.length
    ? `<div class="events-np-list">${nonParticipants
        .map((m) => `<span class="events-np-item">${memberLink(m.id, m.name)}</span>`)
        .join('')}</div>`
    : '<p class="empty-state">Every active member participated.</p>';
  // Collapsed by default; data-section-key keeps its open state stable across
  // re-renders, and nonParticipantsOpen preserves it across in-place repaints.
  const nonParticipantsHtml = `
    <details class="card card-collapsible" data-section-key="events-nonparticipants"${nonParticipantsOpen ? ' open' : ''}>
      <summary class="card-header"><h2>Did not participate (${nonParticipants.length})</h2></summary>
      <div class="card-body">${npBody}</div>
    </details>`;

  el.innerHTML = `
    ${eventTabsHtml(currentEventKey)}
    <div class="card">
      <div class="card-header events-header">
        <div class="events-title">
          <h2>${esc(cache.name)}</h2>
          <span class="card-header-hint">${esc(cache.description || '')}</span>
        </div>
        <div class="events-controls">${controlsHtml}</div>
      </div>
      <div class="card-body">${statCards}</div>
    </div>
    ${eventSeriesCardHtml()}
    ${levelCardHtml}
    <div class="card">
      <div class="card-header"><h2>Participants (${cache.uniqueParticipants || 0})</h2></div>
      <div class="card-body">
        <div class="events-scroll">
          <table class="table-responsive events-table">
            ${colGroup}
            <thead><tr>
              <th class="caret-col"></th>
              <th class="sortable" data-sort-key="rank">Rank${arrow('rank')}</th>
              <th class="sortable" data-sort-key="name">Player${arrow('name')}</th>
              ${headCols}
              ${essenceHead}
              <th class="sortable num" data-sort-key="total" title="${esc(totalTitle)}">Total${arrow('total')}</th>
              <th class="sortable num" data-sort-key="points">Points${arrow('points')}</th>
            </tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        ${pagination}
      </div>
    </div>
    ${nonParticipantsHtml}`;

  wire(el);
}

function wire(el) {
  // Remember the non-participants section's open state across in-place
  // repaints (timeframe/sort/pagination don't go through the router).
  const np = el.querySelector('details[data-section-key="events-nonparticipants"]');
  if (np) np.addEventListener('toggle', () => { nonParticipantsOpen = np.open; });

  // Expandable participant rows — click anywhere on a row (except the member
  // link) to drill into exactly which chests that member collected.
  el.querySelectorAll('tr.events-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;  // let the member link navigate
      // On phones the compact-row engine reveals this member's per-chest-type
      // counts in a clean inline panel; the wide native drill-down table below
      // overflows the viewport, so it stays desktop-only.
      if (window.matchMedia('(max-width: 640px)').matches) return;
      toggleParticipantRow(row);
    });
  });

  el.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (sort.key === key) {
        sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sort.key = key;
        // Name/rank default ascending; numeric/date columns descending.
        sort.dir = (key === 'name' || key === 'rank') ? 'asc' : 'desc';
      }
      page = 1;
      paint();
    });
  });

  el.querySelectorAll('[data-events-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      page += btn.dataset.eventsPage === 'next' ? 1 : -1;
      if (page < 1) page = 1;
      paint();
    });
  });

  el.querySelectorAll('[data-tperiod]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      period = btn.dataset.tperiod;
      periodOffset = 0;
      page = 1;
      await reload();
    });
  });

  el.querySelectorAll('[data-tperiod-nav]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      periodOffset += btn.dataset.tperiodNav === 'next' ? -1 : 1;
      if (periodOffset < 0) periodOffset = 0;
      page = 1;
      await reload();
    });
  });

  // Occurrence selector: ← older (index+1), → newer (index-1); newest-first.
  // From "All time" the arrows drop back into the list — → newest, ← oldest.
  el.querySelectorAll('[data-occ-nav]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.occNav === 'next';
      if (occSel === 'all') {
        occSel = next ? 0 : occurrences.length - 1;
      } else {
        occSel += next ? -1 : 1;
        if (occSel < 0) occSel = 0;
        if (occSel > occurrences.length - 1) occSel = occurrences.length - 1;
      }
      page = 1;
      await reload();
    });
  });

  const occAll = el.querySelector('[data-occ-all]');
  if (occAll) {
    occAll.addEventListener('click', async () => {
      occSel = occSel === 'all' ? 0 : 'all';
      page = 1;
      await reload();
    });
  }
}

// When we can only render the tab bar (load error), the tabs are plain hash
// links so no wiring is strictly needed — kept for symmetry/future use.
function wireTabsOnly() {}

// Expand/collapse a participant row to show that member's chest breakdown for
// the current event + timeframe (grouped by chest name + source), mirroring
// the chest-detail drill-down. One row open at a time.
async function toggleParticipantRow(row) {
  const tbody = row.parentElement;
  if (!tbody) return;
  const caret = row.querySelector('.caret');

  if (row.classList.contains('expanded')) {
    const next = row.nextElementSibling;
    if (next && next.classList.contains('events-detail-row')) next.remove();
    row.classList.remove('expanded');
    if (caret) caret.textContent = '▸';
    return;
  }

  // Collapse any other open row first.
  tbody.querySelectorAll('tr.events-detail-row').forEach((el) => el.remove());
  tbody.querySelectorAll('tr.events-row.expanded').forEach((el) => {
    el.classList.remove('expanded');
    const c = el.querySelector('.caret');
    if (c) c.textContent = '▸';
  });

  row.classList.add('expanded');
  if (caret) caret.textContent = '▾';

  const memberId = row.dataset.memberId || '';
  const memberName = row.dataset.memberName || '';
  const detail = document.createElement('tr');
  detail.className = 'events-detail-row';
  detail.innerHTML = `<td colspan="${row.cells.length}"><div class="events-detail-inner">Loading…</div></td>`;
  row.after(detail);

  const { from, to } = periodWindow();
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);

  let resp;
  try {
    resp = await api(`/events/${encodeURIComponent(currentEventKey)}/member/${encodeURIComponent(memberId)}?${qs}`);
  } catch {
    resp = null;
  }
  const inner = detail.querySelector('.events-detail-inner');
  if (!inner) return;
  const rows = resp && Array.isArray(resp.rows) ? resp.rows : [];
  if (!rows.length) {
    inner.innerHTML = '<div class="empty-state"><p>No chests in this timeframe.</p></div>';
    return;
  }
  const bodyHtml = rows
    .map((r) => `<tr>
      <td>${esc(r.chestName)}</td>
      <td>${esc(r.source || '—')}</td>
      <td class="num">${(r.chests || 0).toLocaleString()}</td>
      <td class="num">${(r.points || 0).toLocaleString()}</td>
      <td class="history-date">${r.lastSeen ? formatDate(r.lastSeen) : '—'}</td>
    </tr>`)
    .join('');
  inner.innerHTML = `
    <div class="chest-history-header">What ${esc(memberName)} collected</div>
    <table class="chest-history-table">
      <thead><tr><th>Chest</th><th>Source</th><th class="num">Count</th><th class="num">Points</th><th>Last received</th></tr></thead>
      <tbody>${bodyHtml}</tbody>
    </table>`;
}
