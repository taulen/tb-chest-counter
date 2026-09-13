// Resources — Overview dashboard (the landing tab).
//
// Elegant, at-a-glance view of what the clan has donated over time, both
// clan-wide and per member. The hard constraint that shapes everything:
// the 16 resource types have INCOMPATIBLE units (food in millions,
// clan-speedups in hours, fragments in single digits), so we never sum
// across types or share a chart axis. The page is therefore per-resource:
// a grid of one-card-per-resource small multiples (each in its own unit +
// a sparkline) drives a single-resource over-time chart and top-donors
// leaderboard. "Donated" = Sent (direction 1); Took is a recessive
// secondary series.
//
// Interaction is handled locally (listeners attached after each paint)
// rather than through app.js's global action delegation: selecting a
// resource / bucket / donors page repaints from cached data with no
// refetch; only changing scope (clan vs member) or the date range refetches.

import { api } from '../lib/api.js';
import { esc, memberLink } from '../lib/ui.js';
import { readToken } from '../lib/theme.js';
import { computeGameWindowDates } from '../lib/period.js';
import { renderPeriodNav } from '../lib/period-nav.js';
import {
  formatResourceAmount, resourceIconOnly, resourceTabsHtml,
  resourceSparklineSvg, isResourcesEnabledForActiveClan,
} from '../lib/resource-format.js';

const DONORS_PAGE_SIZE = 25;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Selection state — survives repaints (theme change, resource pick, etc.).
const view = {
  memberId: '',          // '' = whole clan
  period: 'weekly',      // same period system as the Leaderboard
  periodOffset: 0,       // 0 = current period, 1 = previous, …
  from: '',              // derived from computeGameWindow() on each fetch
  to: '',
  resourceTypeId: null,  // selected resource for the main chart/leaderboard
  bucket: 'day',         // 'day' | 'week' | 'month' — chart granularity
  donorsPage: 1,
  nonDonorsPage: 1,
};

// Raw data cached from the last fetch so resource/bucket/page changes can
// repaint without hitting the network.
let cache = null; // { types, members, summary, daily, donationCount }
let mountedEl = null;

// The one managed Chart instance (destroyed + rebuilt on repaint / theme).
let mainChart = null;
function destroyChart() {
  if (mainChart) { try { mainChart.destroy(); } catch (_) { /* gone */ } mainChart = null; }
}

// Rebuild the chart with fresh theme tokens when the user switches theme —
// Chart.js snapshots colors at construction, so a CSS-variable flip needs
// a destroy + redraw. No-op unless the overview is currently on screen.
document.addEventListener('themechange', () => {
  if (mountedEl && document.contains(mountedEl) && cache) paint();
});

// ─── Date helpers (transaction_date is a plain 'YYYY-MM-DD' calendar date) ──

function isoToUtc(s) { return new Date(s + 'T00:00:00Z'); }
function utcToIso(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function mondayOf(d) { const wd = (d.getUTCDay() + 6) % 7; return addDays(d, -wd); }
function monthStart(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }

// Set the inclusive [from, to] game-day date window for the current period.
// computeGameWindowDates anchors on the current game day (rollover-aware) and
// returns plain date strings, matching resource transaction_date exactly.
function applyPeriodWindow() {
  const win = computeGameWindowDates(view.period, view.periodOffset);
  view.from = win ? win.from : '';
  view.to = win ? win.to : '';
}

// Sensible chart granularity for a period so a single week isn't one bar.
function defaultBucketForPeriod(period) {
  if (period === 'monthly') return 'week';
  if (period === 'yearly' || period === 'all') return 'month';
  return 'day';
}

// ─── Bucketing + gap-fill for the over-time chart ───────────────────────────

// rows: [{date, sent, took}] for ONE resource. Returns ordered buckets
// [{label, sent, took}] across the visible range, zero-filling gaps.
function bucketSeries(rows, bucket, fromIso, toIso) {
  const dates = rows.map((r) => r.date).sort();
  const startIso = fromIso || dates[0];
  const endIso = toIso || dates[dates.length - 1] || startIso;
  if (!startIso) return [];

  const agg = new Map();
  for (const r of rows) {
    const key = bucketKey(r.date, bucket);
    const cur = agg.get(key) || { sent: 0, took: 0 };
    cur.sent += r.sent; cur.took += r.took;
    agg.set(key, cur);
  }

  const out = [];
  let cursor = bucketStart(isoToUtc(startIso), bucket);
  const end = isoToUtc(endIso);
  let guard = 0;
  while (cursor <= end && guard++ < 1200) {
    const key = bucketKeyFromDate(cursor, bucket);
    const val = agg.get(key) || { sent: 0, took: 0 };
    out.push({ label: bucketLabel(cursor, bucket), sent: val.sent, took: val.took });
    cursor = bucketNext(cursor, bucket);
  }
  return out;
}

function bucketStart(d, bucket) {
  if (bucket === 'week') return mondayOf(d);
  if (bucket === 'month') return monthStart(d);
  return d;
}
function bucketNext(d, bucket) {
  if (bucket === 'week') return addDays(d, 7);
  if (bucket === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return addDays(d, 1);
}
function bucketKeyFromDate(d, bucket) {
  if (bucket === 'month') return utcToIso(d).slice(0, 7);
  return utcToIso(d);
}
function bucketKey(dateIso, bucket) {
  if (bucket === 'month') return dateIso.slice(0, 7);
  if (bucket === 'week') return utcToIso(mondayOf(isoToUtc(dateIso)));
  return dateIso;
}
function bucketLabel(d, bucket) {
  const m = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const yy = String(d.getUTCFullYear()).slice(2);
  if (bucket === 'month') return `${m} '${yy}`;
  if (bucket === 'week') return `${m} ${day}`;
  return `${d.getUTCMonth() + 1}/${day}`;
}

// How many buckets a granularity spans across the current window (or, for
// 'all', the full data date range). Doesn't depend on any single resource —
// it's purely the window/date span — so it's stable across resource picks.
function bucketCountForWindow(bucket) {
  const dates = cache.daily.map((d) => d.date).sort();
  const startIso = view.from || dates[0];
  const endIso = view.to || dates[dates.length - 1] || startIso;
  if (!startIso) return 0;
  let cursor = bucketStart(isoToUtc(startIso), bucket);
  const end = isoToUtc(endIso);
  let n = 0;
  let guard = 0;
  while (cursor <= end && guard++ < 1200) { n += 1; cursor = bucketNext(cursor, bucket); }
  return n;
}

// Granularities strictly finer than the selected period — the only ones that
// subdivide its window into a trend rather than collapsing to (or misaligning
// across) a single bucket. 'all' has no fixed unit, so any granularity is fair
// game and the ≥2-bucket count below is what prunes it against the data span.
const FINER_BUCKETS = {
  daily: [],
  weekly: ['day'],
  monthly: ['day', 'week'],
  yearly: ['day', 'week', 'month'],
  all: ['day', 'week', 'month'],
};

// The chart granularities worth offering for the current window: finer than
// the period AND yielding a real multi-point trend (≥2 buckets). Empty when
// nothing qualifies — e.g. the Daily period is one calendar day — which is the
// signal to suppress the over-time chart entirely.
function meaningfulBuckets() {
  return (FINER_BUCKETS[view.period] || []).filter((b) => bucketCountForWindow(b) >= 2);
}

// ─── Data shaping ───────────────────────────────────────────────────────────

// Aggregate the member×type /summary rows into per-type totals, optionally
// scoped to a single member. Returns Map(resourceTypeId -> {sent, took, net}).
function perTypeTotals(summary, memberId) {
  const map = new Map();
  for (const r of summary) {
    if (memberId && String(r.memberId) !== String(memberId)) continue;
    if (r.resourceTypeId == null) continue;
    const cur = map.get(r.resourceTypeId) || { sent: 0, took: 0, net: 0 };
    cur.sent += r.sentAmount; cur.took += r.tookAmount; cur.net += r.netAmount;
    map.set(r.resourceTypeId, cur);
  }
  return map;
}

// Top donor (member with the most Sent) for a given resource type, clan-wide.
function topDonorForType(summary, resourceTypeId) {
  let best = null;
  for (const r of summary) {
    if (r.resourceTypeId !== resourceTypeId || r.sentAmount <= 0) continue;
    if (!best || r.sentAmount > best.sentAmount) best = r;
  }
  return best;
}

// Daily rows for one resource type (and current scope, already applied at
// fetch time), as [{date, sent, took}] merged across duplicate dates.
function dailyForType(daily, resourceTypeId) {
  const rows = daily.filter((d) => d.resourceTypeId === resourceTypeId);
  const byDate = new Map();
  for (const d of rows) {
    const cur = byDate.get(d.date) || { date: d.date, sent: 0, took: 0 };
    cur.sent += d.sent; cur.took += d.took;
    byDate.set(d.date, cur);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Pick the most active resource type: the one with the most distinct donors,
// tie-broken by number of days with data. Used as the default selection.
function mostActiveType(summary, daily, memberId) {
  const donors = new Map();  // typeId -> Set(memberId)
  for (const r of summary) {
    if (r.resourceTypeId == null || r.sentAmount <= 0) continue;
    if (memberId && String(r.memberId) !== String(memberId)) continue;
    if (!donors.has(r.resourceTypeId)) donors.set(r.resourceTypeId, new Set());
    donors.get(r.resourceTypeId).add(r.memberId);
  }
  const days = new Map();     // typeId -> count
  for (const d of daily) {
    if (d.resourceTypeId == null || d.sent <= 0) continue;
    days.set(d.resourceTypeId, (days.get(d.resourceTypeId) || 0) + 1);
  }
  let best = null;
  const candidates = new Set([...donors.keys(), ...days.keys()]);
  for (const id of candidates) {
    const score = { id, donors: donors.get(id)?.size || 0, days: days.get(id) || 0 };
    if (!best || score.donors > best.donors || (score.donors === best.donors && score.days > best.days)) {
      best = score;
    }
  }
  return best ? best.id : null;
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

async function fetchData() {
  applyPeriodWindow();
  const qs = new URLSearchParams();
  if (view.from) qs.set('from', view.from);
  if (view.to) qs.set('to', view.to);

  const dailyQs = new URLSearchParams(qs);
  if (view.memberId) dailyQs.set('memberId', view.memberId);

  const txQs = new URLSearchParams(qs);
  txQs.set('direction', '1');
  txQs.set('limit', '1');
  if (view.memberId) txQs.set('memberId', view.memberId);

  const [typesRes, membersRes, summaryRes, dailyRes, txRes] = await Promise.all([
    api('/resources/types'),
    api('/members'),
    api(`/resources/summary?${qs}`),
    api(`/resources/daily?${dailyQs}`),
    api(`/resources/transactions?${txQs}`),
  ]);

  cache = {
    types: Array.isArray(typesRes) ? typesRes : (typesRes?.types ?? []),
    members: Array.isArray(membersRes) ? membersRes : [],
    summary: Array.isArray(summaryRes?.rows) ? summaryRes.rows : [],
    daily: Array.isArray(dailyRes?.rows) ? dailyRes.rows : [],
    donationCount: txRes?.total ?? 0,
  };
}

// ─── Render entry point ─────────────────────────────────────────────────────

export async function renderResourcesOverview(el, navigate) {
  // Read-only dashboard — visible to any authenticated clan member. Admin-only
  // controls (upload / edit / delete) live on the separate Admin tab.

  // Bounce to the dashboard if the active clan doesn't use resources (a
  // superadmin can land here with a stale hash after switching clans).
  if (!(await isResourcesEnabledForActiveClan())) {
    if (typeof navigate === 'function') navigate('dashboard');
    return;
  }

  mountedEl = el;
  el.innerHTML = `${resourceTabsHtml('overview')}<div class="empty-state"><p>Loading resources…</p></div>`;

  await fetchData();
  ensureSelection();
  paint();
}

// Keep a valid resource selected. A tracked type stays selected across
// period changes even with zero donations; when nothing is selected (or the
// selection is no longer a tracked type) default to Silver, then the
// most-active type, then the first type so the chart/leaderboard always has
// a subject.
function ensureSelection() {
  const validIds = new Set(cache.types.map((t) => t.id));
  if (view.resourceTypeId != null && validIds.has(view.resourceTypeId)) return;
  const silverId = cache.types.find((t) => t.slug === 'silver')?.id;
  view.resourceTypeId = silverId
    ?? mostActiveType(cache.summary, cache.daily, view.memberId)
    ?? (cache.types[0]?.id ?? null);
}

// ─── Paint (full innerHTML rebuild from cache + selection) ───────────────────

function paint() {
  if (!mountedEl) return;
  const el = mountedEl;
  const { types, members, summary } = cache;
  const typeById = new Map(types.map((t) => [t.id, t]));
  const scopedTotals = perTypeTotals(summary, view.memberId);

  // Show a card for every tracked resource type (0 included), so the grid
  // is a complete, stable roster for both clan-wide and per-member scope.
  // Ones with donations sort to the front.
  const cardTypes = types
    .map((type) => ({ id: type.id, type, tot: scopedTotals.get(type.id) || { sent: 0, took: 0, net: 0 } }))
    .sort((a, b) => b.tot.sent - a.tot.sent);

  // Only the granularities that yield a multi-point trend for this window are
  // offered; an empty list (single-day window, e.g. Daily) hides the chart.
  const buckets = meaningfulBuckets();
  if (buckets.length && !buckets.includes(view.bucket)) view.bucket = buckets[buckets.length - 1];

  el.innerHTML = `
    ${resourceTabsHtml('overview')}
    ${filterBarHtml(members)}
    ${kpiRowHtml(scopedTotals)}
    ${resourceGridHtml(cardTypes)}
    ${buckets.length ? mainChartHtml(typeById, buckets) : ''}
    ${view.memberId ? '' : topDonorsHtml(typeById)}
    ${view.memberId ? '' : nonDonorsHtml(typeById)}
  `;

  wire(el);
  drawMainChart(typeById);
}

function filterBarHtml(members) {
  const memberOpts = members
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map((m) => `<option value="${m.id}" ${String(m.id) === String(view.memberId) ? 'selected' : ''}>${esc(m.name)}</option>`)
    .join('');
  const periods = ['daily', 'weekly', 'monthly', 'all'];
  const periodBtns = periods.map((p) =>
    `<button class="btn ${view.period === p ? 'active' : ''}" data-period="${p}">${p.charAt(0).toUpperCase()}${p.slice(1)}</button>`
  ).join('');
  const nav = renderPeriodNav({
    period: view.period,
    offset: view.periodOffset,
    prevAttr: 'data-period-nav="prev"',
    nextAttr: 'data-period-nav="next"',
    hideOnAll: true,
  });
  return `
    <div class="card resources-controls">
      <div class="card-body resources-controls-body">
        <select class="input resources-scope-select" id="rsvScope" aria-label="Scope">
          <option value="">Whole clan</option>
          ${memberOpts}
        </select>
        <div class="period-selector">${periodBtns}</div>
        ${nav}
      </div>
    </div>`;
}

function kpiRowHtml(scopedTotals) {
  const scopeSummary = view.memberId
    ? cache.summary.filter((r) => String(r.memberId) === String(view.memberId))
    : cache.summary;

  const donors = new Set(scopeSummary.filter((r) => r.sentAmount > 0).map((r) => r.memberId)).size;
  const clanDonors = new Set(cache.summary.filter((r) => r.sentAmount > 0).map((r) => r.memberId)).size;
  const typeCount = [...scopedTotals.values()].filter((t) => t.sent > 0).length;

  // Show the selected period's window (the normal week/month/year span),
  // not just the dates that happen to have data. 'all' has no window, so
  // fall back to the actual data range.
  const dates = cache.daily.map((d) => d.date).sort();
  const span = (view.from && view.to)
    ? `${view.from} → ${view.to}`
    : (dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : 'All time');

  const tiles = view.memberId
    ? [
        ['Donations logged', cache.donationCount.toLocaleString()],
        ['Resources donated', String(typeCount)],
        ['This member', donors > 0 ? 'Active donor' : 'No donations'],
        ['Date span', span],
      ]
    : [
        ['Donations logged', cache.donationCount.toLocaleString()],
        ['Active donors', String(clanDonors)],
        ['Resource types donated', String(typeCount)],
        ['Date span', span],
      ];

  return `<div class="stats-grid">
    ${tiles.map(([label, value]) => `<div class="stat-card"><div class="label">${label}</div><div class="value">${esc(value)}</div></div>`).join('')}
  </div>`;
}

function resourceGridHtml(cardTypes) {
  if (cardTypes.length === 0) {
    return `<div class="card"><div class="card-body"><div class="empty-state"><p>No donations recorded for this ${view.memberId ? 'member' : 'clan'} in the selected range yet.</p></div></div></div>`;
  }
  const cards = cardTypes.map(({ id, tot, type }) => {
    const series = bucketSeries(dailyForType(cache.daily, id), 'week', view.from, view.to);
    const spark = resourceSparklineSvg(series.map((b) => b.sent));
    const donor = view.memberId ? null : topDonorForType(cache.summary, id);
    const isActive = id === view.resourceTypeId;
    return `
      <button class="resource-card ${isActive ? 'is-selected' : ''}" data-resource-id="${id}" type="button">
        <div class="resource-card-head">
          ${resourceIconOnly(type.slug)}
          <span class="resource-card-name">${esc(type.name)}</span>
        </div>
        <div class="resource-card-amount">${esc(formatResourceAmount(type.slug, tot.sent))}</div>
        <div class="resource-card-sub">
          <span>Took ${esc(formatResourceAmount(type.slug, tot.took))}</span>
          <span>Net ${esc(formatResourceAmount(type.slug, tot.net))}</span>
        </div>
        ${spark}
        <div class="resource-card-donor">${donor ? `Top: ${esc(donor.memberName)}` : (view.memberId ? ' ' : 'No donors')}</div>
      </button>`;
  }).join('');
  return `
    <div class="card">
      <div class="card-header"><h2>Donated by resource</h2><span class="card-header-hint">Each in its own unit · click to chart</span></div>
      <div class="card-body"><div class="resources-cards">${cards}</div></div>
    </div>`;
}

function mainChartHtml(typeById, buckets) {
  const type = view.resourceTypeId != null ? typeById.get(view.resourceTypeId) : null;
  const title = type ? `${esc(type.name)} over time` : 'Over time';
  const labels = { day: 'Day', week: 'Week', month: 'Month' };
  const bucketBtn = (key) =>
    `<button class="btn btn-tight resources-bucket-btn ${view.bucket === key ? 'is-active' : ''}" data-bucket="${key}">${labels[key]}</button>`;
  // Only offer the granularity switch when more than one granularity gives a
  // real trend; a lone button would be a control that can't change anything.
  const group = buckets.length >= 2
    ? `<div class="resources-bucket-group">${buckets.map(bucketBtn).join('')}</div>`
    : '';
  return `
    <div class="card">
      <div class="card-header">
        <h2>${title}</h2>
        ${group}
      </div>
      <div class="card-body card-body-padded">
        <div class="resources-chart-wrap"><canvas id="rsvChart"></canvas></div>
      </div>
    </div>`;
}

function topDonorsHtml(typeById) {
  const type = view.resourceTypeId != null ? typeById.get(view.resourceTypeId) : null;
  const rows = cache.summary
    .filter((r) => r.resourceTypeId === view.resourceTypeId && r.sentAmount > 0)
    .sort((a, b) => b.sentAmount - a.sentAmount);

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / DONORS_PAGE_SIZE));
  if (view.donorsPage > totalPages) view.donorsPage = totalPages;
  const start = (view.donorsPage - 1) * DONORS_PAGE_SIZE;
  const pageRows = rows.slice(start, start + DONORS_PAGE_SIZE);

  const body = pageRows.length === 0
    ? `<tr><td colspan="3" class="empty-state-cell">No donations for this resource in range.</td></tr>`
    : pageRows.map((r, i) => {
        const rank = start + i + 1;
        const highlight = view.memberId && String(r.memberId) === String(view.memberId) ? ' class="is-me"' : '';
        return `<tr${highlight}>
          <td data-label="Rank" data-role="lead"><span class="rank rank-${rank <= 3 ? rank : ''}">#${rank}</span></td>
          <td data-label="Member" data-role="primary"><span class="mrow-name">${memberLink(r.memberId, r.memberName)}</span></td>
          <td data-label="Donated" class="col-num" data-role="metric">${esc(formatResourceAmount(type?.slug, r.sentAmount))}</td>
        </tr>`;
      }).join('');

  const pagination = total > DONORS_PAGE_SIZE ? `
    <div class="pagination">
      <button class="btn btn-tight" data-donors-page="prev" ${view.donorsPage <= 1 ? 'disabled' : ''}>← Prev</button>
      <span class="pagination-info">Page ${view.donorsPage} of ${totalPages} · ${total} donors</span>
      <button class="btn btn-tight" data-donors-page="next" ${view.donorsPage >= totalPages ? 'disabled' : ''}>Next →</button>
    </div>` : '';

  return `
    <div class="card">
      <div class="card-header"><h2>Top donors${type ? ` · ${esc(type.name)}` : ''}</h2></div>
      <div class="card-body">
        <table class="table-responsive resources-donors-table">
          <colgroup><col class="col-rank"><col class="col-player"><col class="col-num"></colgroup>
          <thead><tr><th>Rank</th><th>Member</th><th class="col-num">Donated</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
        ${pagination}
      </div>
    </div>`;
}

// Members who have NOT sent the selected resource in the current period —
// the flip side of the top-donors table, so it's easy to see who to nudge.
function nonDonorsHtml(typeById) {
  const type = view.resourceTypeId != null ? typeById.get(view.resourceTypeId) : null;
  if (!type) return '';

  const donorIds = new Set(
    cache.summary
      .filter((r) => r.resourceTypeId === view.resourceTypeId && r.sentAmount > 0)
      .map((r) => r.memberId),
  );
  const nonDonors = cache.members
    .filter((m) => !donorIds.has(m.id))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const total = nonDonors.length;
  const totalPages = Math.max(1, Math.ceil(total / DONORS_PAGE_SIZE));
  if (view.nonDonorsPage > totalPages) view.nonDonorsPage = totalPages;
  const start = (view.nonDonorsPage - 1) * DONORS_PAGE_SIZE;
  const pageRows = nonDonors.slice(start, start + DONORS_PAGE_SIZE);

  const body = pageRows.length === 0
    ? `<tr><td class="empty-state-cell">Everyone has donated ${esc(type.name)} in this period. 🎉</td></tr>`
    : pageRows.map((m) => `<tr><td data-label="Member" data-role="primary"><span class="mrow-name">${memberLink(m.id, m.name)}</span></td></tr>`).join('');

  const pagination = total > DONORS_PAGE_SIZE ? `
    <div class="pagination">
      <button class="btn btn-tight" data-nondonors-page="prev" ${view.nonDonorsPage <= 1 ? 'disabled' : ''}>← Prev</button>
      <span class="pagination-info">Page ${view.nonDonorsPage} of ${totalPages} · ${total} members</span>
      <button class="btn btn-tight" data-nondonors-page="next" ${view.nonDonorsPage >= totalPages ? 'disabled' : ''}>Next →</button>
    </div>` : '';

  return `
    <div class="card">
      <div class="card-header">
        <h2>Haven't donated${type ? ` · ${esc(type.name)}` : ''}</h2>
        <span class="card-header-hint">${total} member${total === 1 ? '' : 's'} · this period</span>
      </div>
      <div class="card-body">
        <table class="table-responsive resources-nondonors-table">
          <colgroup><col class="col-player"></colgroup>
          <thead><tr><th>Member</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
        ${pagination}
      </div>
    </div>`;
}

// ─── Chart ───────────────────────────────────────────────────────────────────

function drawMainChart(typeById) {
  destroyChart();
  const canvas = document.getElementById('rsvChart');
  if (!canvas || view.resourceTypeId == null) return;
  const type = typeById.get(view.resourceTypeId);
  const series = bucketSeries(dailyForType(cache.daily, view.resourceTypeId), view.bucket, view.from, view.to);
  if (series.length === 0) return;

  const grid = readToken('--chart-grid');
  const tick = readToken('--chart-tick');
  const green = readToken('--accent-green');
  const greenFill = readToken('--accent-green-bg');
  const red = readToken('--accent-red');
  const fmt = (v) => formatResourceAmount(type?.slug, v);

  mainChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: series.map((b) => b.label),
      datasets: [
        {
          label: 'Sent (donated)',
          data: series.map((b) => b.sent),
          borderColor: green,
          backgroundColor: greenFill,
          fill: true,
          tension: 0.3,
          borderWidth: 2,
          pointRadius: series.length > 40 ? 0 : 3,
          pointHoverRadius: 5,
        },
        {
          label: 'Took',
          data: series.map((b) => b.took),
          borderColor: red,
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          borderWidth: 2,
          borderDash: [4, 4],
          pointRadius: 0,
          pointHoverRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { color: tick, boxWidth: 12, boxHeight: 12, usePointStyle: true },
        },
        tooltip: {
          backgroundColor: readToken('--chart-tooltip-bg'),
          titleColor: readToken('--chart-tooltip-text'),
          bodyColor: readToken('--chart-tooltip-text'),
          borderColor: readToken('--chart-tooltip-border'),
          borderWidth: 1,
          cornerRadius: 8,
          padding: 10,
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: { ticks: { color: tick, font: { size: 11 }, maxRotation: 0, autoSkip: true }, grid: { color: grid } },
        y: {
          beginAtZero: true,
          ticks: { color: tick, font: { size: 11 }, callback: (v) => fmt(v) },
          grid: { color: grid },
        },
      },
    },
  });
}

// ─── Local interaction wiring ────────────────────────────────────────────────

function wire(el) {
  const scope = el.querySelector('#rsvScope');
  if (scope) scope.addEventListener('change', async () => {
    view.memberId = scope.value;
    view.donorsPage = 1;
    view.nonDonorsPage = 1;
    view.resourceTypeId = null; // re-pick the default (Silver) for the new scope
    await refetchAndPaint();
  });

  el.querySelectorAll('.period-selector .btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      view.period = btn.dataset.period;
      view.periodOffset = 0;
      view.bucket = defaultBucketForPeriod(view.period);
      view.donorsPage = 1;
      view.nonDonorsPage = 1;
      await refetchAndPaint();
    });
  });

  el.querySelectorAll('[data-period-nav]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      view.periodOffset += btn.dataset.periodNav === 'next' ? -1 : 1;
      if (view.periodOffset < 0) view.periodOffset = 0;
      view.donorsPage = 1;
      view.nonDonorsPage = 1;
      await refetchAndPaint();
    });
  });

  el.querySelectorAll('.resource-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = Number.parseInt(card.dataset.resourceId, 10);
      if (Number.isFinite(id)) { view.resourceTypeId = id; view.donorsPage = 1; view.nonDonorsPage = 1; paint(); }
    });
  });

  el.querySelectorAll('.resources-bucket-btn').forEach((btn) => {
    btn.addEventListener('click', () => { view.bucket = btn.dataset.bucket; paint(); });
  });

  el.querySelectorAll('[data-donors-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      view.donorsPage += btn.dataset.donorsPage === 'next' ? 1 : -1;
      if (view.donorsPage < 1) view.donorsPage = 1;
      paint();
    });
  });

  el.querySelectorAll('[data-nondonors-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      view.nonDonorsPage += btn.dataset.nondonorsPage === 'next' ? 1 : -1;
      if (view.nonDonorsPage < 1) view.nonDonorsPage = 1;
      paint();
    });
  });
}

async function refetchAndPaint() {
  if (!mountedEl) return;
  mountedEl.querySelector('.resources-cards')?.classList.add('is-loading');
  await fetchData();
  ensureSelection();
  paint();
}
