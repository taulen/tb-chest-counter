// Might page — clan power tracking.
//
// Three cards, top to bottom:
//   1. Clan total might over time (with the headcount behind each point, so a
//      jump from recruiting is distinguishable from a jump from growth).
//   2. Interactive comparison: pick any number of members, see their curves on
//      one chart, optionally shaded with the event windows that ran in the same
//      period so you can see what a Trials week actually did to people's might.
//      The shading and the tooltip's event lines come from the same resolved
//      spans (eventBandSpans) — a band always names itself on hover.
//   3. Ranking table — current might and its change.
//
// Data comes from /api/might, which is fed by the daily OCR snapshot of the
// in-game member list. Nothing here touches ChestTracker data.
//
// INTERACTION RULE: nothing on this page re-renders the whole page. Toggling a
// member refetches one endpoint and redraws one canvas; changing the timeframe
// redraws two; filtering the member list touches no network at all. The first
// version rebuilt every card on every click, which threw away scroll position
// and flashed the page — full re-render happens only on genuine navigation.

import { api } from '../lib/api.js';
import { $, esc, formatDate, formatDateShort, formatGameDayShort, memberLink } from '../lib/ui.js';
import { readToken } from '../lib/theme.js';

// Charts tracked individually so a redraw destroys only the one it replaces —
// Chart.js snapshots colours at construction, so they're rebuilt (not restyled)
// on themechange, same as analytics.js.
const charts = { totals: null, compare: null, member: null };

function destroyChart(key) {
  try { charts[key]?.destroy(); } catch (_) { /* already destroyed */ }
  charts[key] = null;
}

function destroyAllCharts() {
  for (const key of Object.keys(charts)) destroyChart(key);
}

/** Points behind the member-page chart, kept for a theme redraw. That chart is
 *  mounted by members.js, so it exists without this page's `state`. */
let memberChartPoints = null;

document.addEventListener('themechange', () => {
  // Handled before the state guard below: the member card is the one chart in
  // here that can be on screen while the Might page itself was never rendered.
  if (memberChartPoints && $('#memberMightChart')) drawMemberMightChart(memberChartPoints);
  if (!state) return;
  destroyChart('totals');
  destroyChart('compare');
  drawTotalsChart();
  drawCompareChart();
});

// ─── Page state ───────────────────────────────────────────────

const WINDOW_OPTIONS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
];

/**
 * Windows for the member-page chart, which shares a header line with the trend
 * pill and so needs shorter labels than the clan charts above. `0` is the
 * member's whole history.
 *
 * It used to have no selector and no window at all — it asked for everything,
 * which was fine while might tracking was days old and would quietly become a
 * multi-year line. 30 days is the default because that's the horizon a clan
 * actually acts on; the rest are there for the long view.
 */
const MEMBER_WINDOW_OPTIONS = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 0, label: 'All' },
];
let memberWindowDays = 30;
/** Set once the operator clicks a window themselves — see buildMemberMightCard. */
let memberWindowExplicit = false;

/** Ranking-table delta window. Fixed rather than tied to the chart timeframe:
 *  it matches the Members page's 7d column, and decoupling means changing the
 *  chart window doesn't have to refetch (or rebuild) the table. */
const TABLE_DELTA_DAYS = 7;

/** Members pre-selected on first open. */
const DEFAULT_SELECTION = 5;

let windowDays = 90;
let selectedIds = [];
let showEvents = true;
let memberFilter = '';

/** Fetched data + the host element, so surgical updates can find their targets. */
let state = null;
let hostEl = null;

function chartTokens() {
  return {
    grid: readToken('--chart-grid'),
    tick: readToken('--chart-tick'),
    tooltipBg: readToken('--chart-tooltip-bg'),
    tooltipText: readToken('--chart-tooltip-text'),
    tooltipBorder: readToken('--chart-tooltip-border'),
    accentGold: readToken('--accent-gold'),
    // Second series on the member chart (hero level). Blue against the gold is
    // the widest-separating pair the theme offers — ΔE 33+ under protanopia and
    // tritanopia in both light and dark, where two warm hues would collapse.
    accentBlue: readToken('--accent-blue'),
    valueLabel: readToken('--chart-value-label'),
  };
}

/**
 * Line colours for the comparison chart.
 *
 * Deliberately a fixed hue ramp rather than the theme's bar tokens: those are
 * tuned as single-series fills and only give four distinguishable options,
 * while this chart needs up to a dozen lines telling apart at a glance. Hues
 * are spread unevenly (not a flat 360/n) to keep adjacent entries apart, and
 * the fixed 65% lightness / 70% saturation reads on both the light parchment
 * and the OLED background.
 */
const SERIES_HUES = [42, 205, 145, 320, 265, 15, 175, 95, 240, 350, 60, 285];
function seriesColor(i, alpha = 1) {
  const hue = SERIES_HUES[i % SERIES_HUES.length];
  return `hsla(${hue}, 70%, 65%, ${alpha})`;
}

function formatMight(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US');
}

/** Compact form for axis ticks: 1.2B / 340M / 12M. */
function formatMightShort(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function formatDelta(delta) {
  if (delta === null || delta === undefined) return { text: '—', cls: 'progress-flat', arrow: '' };
  if (delta === 0) return { text: '±0', cls: 'progress-flat', arrow: '—' };
  if (delta > 0) return { text: `+${formatMight(delta)}`, cls: 'progress-up', arrow: '▲' };
  return { text: formatMight(delta), cls: 'progress-down', arrow: '▼' };
}

/**
 * Members with a reading, strongest first.
 *
 * /might/overview returns the roster in name order (it's built from
 * getAllMembers, which is `ORDER BY name`), so "Top 5" and the default
 * selection have to sort here — slicing the raw array gave the first five
 * members alphabetically, which looked like the feature was picking at random.
 */
function rankedRows() {
  const rows = state?.overview?.rows ?? [];
  return rows.filter((r) => r.might !== null).sort((a, b) => b.might - a.might);
}

// ─── Fetching ─────────────────────────────────────────────────

function fetchCompare() {
  if (selectedIds.length === 0) return Promise.resolve({ series: [] });
  return api(`/might/compare?memberIds=${selectedIds.join(',')}&days=${windowDays}`)
    .catch(() => ({ series: [] }));
}

function fetchEvents() {
  if (!showEvents) return Promise.resolve({ windows: [] });
  return api(`/might/events?days=${windowDays}`).catch(() => ({ windows: [] }));
}

// ─── Full render (navigation only) ────────────────────────────

export async function renderMight(el) {
  hostEl = el;
  // Destroy before the innerHTML swap: replacing the markup removes the
  // canvases out from under any live Chart instances.
  destroyAllCharts();
  el.innerHTML = '<div class="card"><div class="card-body"><div class="empty-state"><p>Loading might data…</p></div></div></div>';

  const [overview, totals, events] = await Promise.all([
    api(`/might/overview?deltaDays=${TABLE_DELTA_DAYS}`),
    api(`/might/totals?days=${windowDays}`),
    fetchEvents(),
  ]);

  state = {
    overview,
    totals: Array.isArray(totals?.totals) ? totals.totals : [],
    events: Array.isArray(events?.windows) ? events.windows : [],
    series: [],
  };

  const rows = Array.isArray(overview?.rows) ? overview.rows : [];
  const ranked = rankedRows();

  // Default to the strongest few so the chart says something on first open.
  // Only when nothing is selected, so it never fights the user's own picks.
  if (selectedIds.length === 0 && ranked.length > 0) {
    selectedIds = ranked.slice(0, DEFAULT_SELECTION).map((r) => r.memberId);
  }
  // Drop ids that no longer resolve (member removed, clan switched).
  const valid = new Set(rows.map((r) => r.memberId));
  selectedIds = selectedIds.filter((id) => valid.has(id));

  if (ranked.length === 0) {
    el.innerHTML = renderEmptyState(overview);
    return;
  }

  const compare = await fetchCompare();
  state.series = Array.isArray(compare?.series) ? compare.series : [];

  el.innerHTML = `
    ${renderHeaderCard()}
    ${renderTotalsCard()}
    ${renderCompareCard()}
    ${renderTableCard(rows)}
  `;

  drawTotalsChart();
  drawCompareChart();
  wireControls(el);
}

function renderEmptyState(overview) {
  const reasons = [];
  if (overview?.enabled !== true) {
    reasons.push('Might tracking is currently <strong>off</strong>. A superadmin can enable it on the System page.');
  }
  if (overview?.calibrated !== true) {
    reasons.push('The member-list crop is not calibrated. Run Admin → Scanner Mode → Calibrate, Stage 4.');
  } else if (overview?.cropIncludesMight !== true) {
    // The gate that applies to every instance calibrated before this feature:
    // the saved rectangle was drawn around the names only.
    reasons.push(
      'The saved member-list rectangle predates might tracking, so capture is <strong>blocked</strong>. '
      + 'Re-run Admin → Scanner Mode → Calibrate, <strong>Stage 4</strong>, and drag the rectangle '
      + 'right so it includes the might number next to the shield icon. Capture starts on the next '
      + 'scan cycle after you save the stage.',
    );
  }
  if (reasons.length === 0) {
    reasons.push(
      'No snapshot has been recorded yet. The first one lands on the next scan cycle after the '
      + `${overview?.rolloverUtcHour ?? 17}:00 UTC game-day rollover — check the scan log if it doesn't appear.`,
    );
    reasons.push(
      'If the scan log says member rows were read but no power number was found, the Stage 4 rectangle '
      + 'is still cutting off the might column — widen it further right and save the stage again.',
    );
  }
  return `<div class="card">
    <div class="card-header"><h2>Member Might</h2></div>
    <div class="card-body card-body-padded">
      <div class="empty-state"><p>No might history yet.</p></div>
      <ul class="muted-copy">${reasons.map((r) => `<li>${r}</li>`).join('')}</ul>
    </div>
  </div>`;
}

// ─── Cards ────────────────────────────────────────────────────

/** Window-dependent, so it's re-rendered in place when the timeframe changes. */
function headerStatsHtml() {
  const totals = state.totals;
  const newest = totals.length > 0 ? totals[totals.length - 1] : null;
  const oldest = totals.length > 0 ? totals[0] : null;
  const clanDelta = newest && oldest && totals.length > 1
    ? newest.totalMight - oldest.totalMight
    : null;
  const d = formatDelta(clanDelta);
  const days = state.overview?.daysCollected ?? 0;

  return `<div class="stats-grid">
    <div class="stat-card">
      <div class="label">Clan Might</div>
      <div class="value">${newest ? formatMight(newest.totalMight) : '—'}</div>
      <div class="sub">${newest ? `${newest.memberCount} member${newest.memberCount === 1 ? '' : 's'} counted` : ''}</div>
    </div>
    <div class="stat-card">
      <div class="label">Change over window</div>
      <div class="value ${d.cls}">${d.arrow} ${d.text}</div>
      <div class="sub">${oldest && newest && totals.length > 1 ? `${esc(oldest.gameDate)} → ${esc(newest.gameDate)}` : 'Needs two or more days'}</div>
    </div>
    <div class="stat-card">
      <div class="label">Days Collected</div>
      <div class="value">${days.toLocaleString()}</div>
      <div class="sub">one snapshot per game day</div>
    </div>
  </div>`;
}

function renderHeaderCard() {
  const last = state.overview?.lastCapture;
  return `<div class="card">
    <div class="card-header">
      <h2>Member Might</h2>
      <span class="card-header-hint">
        ${last ? `Last read ${esc(formatDate(last.capturedAt))} · game day ${esc(last.gameDate)}` : 'Never captured'}
      </span>
    </div>
    <div class="card-body card-body-padded" id="mightHeaderStats">${headerStatsHtml()}</div>
  </div>`;
}

function windowSelectorHtml() {
  return WINDOW_OPTIONS
    .map((o) => `<button class="btn ${o.days === windowDays ? 'active' : ''}" data-might-days="${o.days}">${o.label}</button>`)
    .join('');
}

function renderTotalsCard() {
  return `<div class="card">
    <div class="card-header leaderboard-header">
      <h2>Clan Might Over Time</h2>
      <div class="period-selector" id="mightWindow">${windowSelectorHtml()}</div>
    </div>
    <div class="card-body card-body-padded">
      <div class="chart-container"><canvas id="mightTotalsChart"></canvas></div>
    </div>
  </div>`;
}

/** Chip list only — rewritten in place on filter/selection changes. */
function chipsHtml() {
  const filter = memberFilter.trim().toLowerCase();
  const pickable = rankedRows()
    .filter((r) => !filter || (r.name || '').toLowerCase().includes(filter));
  if (pickable.length === 0) return '<span class="muted-copy">No members match.</span>';

  return pickable.map((r) => {
    const idx = selectedIds.indexOf(r.memberId);
    const on = idx >= 0;
    // Inline colour ties the chip to its line so the legend and the picker
    // agree without the user matching names twice.
    const style = on
      ? ` style="border-color:${seriesColor(idx)};box-shadow:inset 3px 0 0 ${seriesColor(idx)}"`
      : '';
    return `<button class="btn btn-tight might-chip${on ? ' active' : ''}"
      data-might-toggle="${r.memberId}"${style}>${esc(r.name)}</button>`;
  }).join('');
}

function compareChartHtml() {
  return selectedIds.length === 0
    ? '<div class="empty-state"><p>Select one or more members above.</p></div>'
    : '<canvas id="mightCompareChart"></canvas>';
}

function renderCompareCard() {
  return `<div class="card">
    <div class="card-header leaderboard-header">
      <h2>Compare Members</h2>
      <div class="might-compare-controls">
        <label class="might-toggle-label"
               title="Shade the days a clan-calendar event was running, behind the curves. Hover any point to see which.">
          <input type="checkbox" id="mightShowEvents" ${showEvents ? 'checked' : ''}>
          Highlight event days
        </label>
        <button class="btn btn-tight" data-might-action="clear">Clear</button>
        <button class="btn btn-tight" data-might-action="top">Top ${DEFAULT_SELECTION}</button>
      </div>
    </div>
    <div class="card-body card-body-padded">
      <p class="muted-copy mb-12">
        Pick any members to overlay their might curves. The gold bands are days a clan-calendar
        event was running — hover any point to see which ones. A curve that steepens inside a
        band tells you that event moved the needle.
      </p>
      <input type="text" id="mightMemberFilter" class="input members-filter mb-12"
             placeholder="Filter members…" value="${esc(memberFilter)}">
      <div class="might-chips" id="mightChips">${chipsHtml()}</div>
      <div class="chart-container might-compare-chart" id="mightCompareHost">${compareChartHtml()}</div>
    </div>
  </div>`;
}

function renderTableCard(rows) {
  const ranked = [...rows].sort((a, b) => {
    if (a.might === null && b.might === null) return (a.name || '').localeCompare(b.name || '');
    if (a.might === null) return 1;
    if (b.might === null) return -1;
    return b.might - a.might;
  });

  // Hero level needs the calibrated crop to reach the avatars, which most instances
  // don't do — so the column only appears once something has actually been read,
  // rather than sitting there full of dashes.
  const showHero = rows.some((r) => r.heroLevel);

  return `<div class="card">
    <div class="card-header">
      <h2>Might Ranking</h2>
      <span class="card-header-hint">Change measured over ~${TABLE_DELTA_DAYS} days</span>
    </div>
    <div class="card-body">
      <table class="table-responsive might-table"><colgroup>
        <col class="col-rank">
        <col class="col-member">
        <col class="col-metric">
        <col class="col-metric">
        ${showHero ? '<col class="col-metric">' : ''}
        <col class="col-date">
      </colgroup><thead><tr>
        <th>Rank</th><th>Member</th><th class="num">Might</th><th class="num">Change</th>
        ${showHero ? '<th class="num">Hero Level</th>' : ''}
        <th>Last Seen</th>
      </tr></thead><tbody>
        ${ranked.map((r, i) => {
          const d = formatDelta(r.delta);
          return `<tr>
            <td data-label="Rank" data-role="lead">${r.might === null ? '—' : i + 1}</td>
            <td data-label="Member" data-role="primary"><span class="mrow-name">${memberLink(r.memberId, r.name)}</span></td>
            ${/* The reading's own game day qualifies the number, not the member, so
                  it rides on the Might cell instead of occupying a column — on a
                  daily sweep it's the same date for the whole roster, and the header
                  card already states it once. */''}
            <td data-label="Might" data-role="metric" class="num"${r.gameDate ? ` title="Read on game day ${esc(r.gameDate)}"` : ''}>${formatMight(r.might)}</td>
            ${/* Change, Hero Level and Last Seen stay unmarked so the mobile
                  compact-row engine reveals them in the expand panel. */''}
            <td data-label="Change" class="num ${d.cls}">${d.arrow} ${d.text}</td>
            ${showHero ? `<td data-label="Hero Level" class="num">${r.heroLevel ? r.heroLevel.toLocaleString('en-US') : '—'}</td>` : ''}
            ${/* Date only — the time never carried information here and it wrapped
                  the whole row onto two lines. */''}
            <td data-label="Last Seen">${formatDateShort(r.lastSeen)}</td>
          </tr>`;
        }).join('')}
      </tbody></table>
    </div>
  </div>`;
}

// ─── Charts ───────────────────────────────────────────────────

function baseLineOptions(t, yTitle) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: t.tooltipBg,
        titleColor: t.tooltipText,
        bodyColor: t.tooltipText,
        borderColor: t.tooltipBorder,
        borderWidth: 1,
        callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatMight(ctx.parsed.y)}` },
      },
    },
    scales: {
      x: { ticks: { color: t.tick, maxRotation: 0, autoSkipPadding: 16 }, grid: { color: t.grid } },
      y: {
        title: { display: !!yTitle, text: yTitle, color: t.tick },
        ticks: { color: t.tick, callback: (v) => formatMightShort(v) },
        grid: { color: t.grid },
      },
    },
  };
}

function drawTotalsChart() {
  const canvas = $('#mightTotalsChart');
  if (!canvas || !state || state.totals.length === 0) return;
  const t = chartTokens();
  const labels = state.totals.map((d) => d.gameDate);
  const opts = baseLineOptions(t, 'Total might');
  // Headcount rides along in the tooltip: the same total means something very
  // different at 48 members than at 52.
  opts.plugins.tooltip.callbacks.afterBody = (items) => {
    const point = state.totals[items[0].dataIndex];
    return point ? `${point.memberCount} member(s) counted` : '';
  };

  destroyChart('totals');
  charts.totals = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Clan might',
        data: state.totals.map((d) => d.totalMight),
        borderColor: t.accentGold,
        backgroundColor: t.accentGold,
        borderWidth: 2,
        pointRadius: labels.length > 60 ? 0 : 2,
        tension: 0.2,
        fill: false,
      }],
    },
    options: opts,
  });
}

function drawCompareChart() {
  destroyChart('compare');
  const host = $('#mightCompareHost');
  if (!host || !state) return;
  // Swap between canvas and empty state in place rather than re-rendering the card.
  host.innerHTML = compareChartHtml();
  const canvas = $('#mightCompareChart');
  if (!canvas || state.series.length === 0) return;

  const t = chartTokens();
  // Union of every date any selected member has a reading for, so a member who
  // joined mid-window lines up correctly instead of being shifted left.
  const allDates = [...new Set(state.series.flatMap((s) => s.points.map((p) => p.gameDate)))].sort();
  const datasets = state.series.map((s, i) => {
    const byDate = new Map(s.points.map((p) => [p.gameDate, p.might]));
    return {
      label: s.name,
      // null (not 0) for a missing day — spanGaps joins across it rather than
      // drawing a cliff down to zero that never happened.
      data: allDates.map((d) => (byDate.has(d) ? byDate.get(d) : null)),
      borderColor: seriesColor(i),
      backgroundColor: seriesColor(i),
      borderWidth: 2,
      pointRadius: allDates.length > 60 ? 0 : 2,
      tension: 0.2,
      spanGaps: true,
      fill: false,
    };
  });

  const opts = baseLineOptions(t, 'Might');
  opts.plugins.legend = { display: true, labels: { color: t.tick, usePointStyle: true, boxWidth: 8 } };

  const spans = showEvents ? eventBandSpans(allDates, state.events) : [];
  // Name the bands on hover. Shading alone told you *that* something ran, never
  // what — which made the bands read as decoration rather than as the reason a
  // curve bends. Empty string (not an empty array) on a day with no event, so
  // Chart.js adds no blank line.
  opts.plugins.tooltip.callbacks.afterBody = (items) => {
    const lines = eventsAtIndex(spans, items[0]?.dataIndex);
    return lines.length === 0
      ? ''
      : ['', lines.length === 1 ? 'Event this day:' : 'Events this day:', ...lines.map((l) => `  ${l}`)];
  };

  charts.compare = new Chart(canvas, {
    type: 'line',
    data: { labels: allDates, datasets },
    options: opts,
    plugins: spans.length > 0 ? [eventBandsPlugin(spans)] : [],
  });
}

/**
 * Event windows resolved to x-axis category indices, ascending by start.
 *
 * The single source of truth for both the shading and the tooltip's event
 * lines, which is the point of it existing: whatever gets painted is exactly
 * what gets named, so a band can never sit under a hovered point that claims no
 * event ran. Computed once per draw rather than per frame — the plugin redraws
 * on every hover.
 *
 * `fromDay`/`toDay` arrive as game-day strings already snapped to the 17:00
 * reset (see the /might/events route), and the x axis is a list of game days,
 * so this is a string comparison rather than timestamp math. YYYY-MM-DD sorts
 * lexicographically, hence the plain `>=` / `<=` scan.
 *
 * A window overhanging either end of the chart clamps to that edge instead of
 * vanishing. One falling entirely between two sampled days (possible only where
 * the snapshot has a gap) is dropped — there is no point to attach it to, and a
 * band with nothing to hover is worse than none.
 */
function eventBandSpans(dates, windows) {
  if (!Array.isArray(windows) || windows.length === 0 || dates.length === 0) return [];
  const spans = [];
  for (const w of windows) {
    const fromDay = typeof w.fromDay === 'string' ? w.fromDay : '';
    const toDay = typeof w.toDay === 'string' ? w.toDay : '';
    if (!fromDay || !toDay) continue;
    let i0 = -1;
    let i1 = -1;
    for (let i = 0; i < dates.length; i++) {
      if (i0 < 0 && dates[i] >= fromDay) i0 = i;
      if (dates[i] <= toDay) i1 = i;
    }
    if (i0 < 0 || i1 < i0) continue;
    spans.push({ name: w.name || 'Event', label: w.label || '', i0, i1 });
  }
  return spans;
}

/** Distinct events covering one x-axis index, in chart order. Two different
 *  events can overlap on a day, so this is a list, not a lookup. */
function eventsAtIndex(spans, index) {
  // An index-mode tooltip over a chart with gaps can hand back no items at all;
  // without this every span would match, since `undefined` loses both comparisons.
  if (!Number.isFinite(index)) return [];
  const seen = new Set();
  const out = [];
  for (const s of spans) {
    if (index < s.i0 || index > s.i1) continue;
    const line = s.label ? `${s.name} · ${s.label}` : s.name;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * Inline Chart.js plugin that shades resolved event spans behind the lines.
 *
 * Written as a plugin rather than pulling in chartjs-plugin-annotation because
 * the offline Docker image rules out fetching another library, and this needs
 * exactly one shape.
 */
function eventBandsPlugin(spans) {
  return {
    id: 'mightEventBands',
    beforeDatasetsDraw(chart) {
      if (spans.length === 0) return;
      const { ctx, chartArea, scales } = chart;
      const x = scales.x;

      ctx.save();
      for (const s of spans) {
        const left = x.getPixelForValue(s.i0);
        const right = x.getPixelForValue(s.i1);
        // A single-day event collapses to zero width; give it a visible sliver.
        const width = Math.max(3, right - left);

        ctx.fillStyle = 'hsla(42, 70%, 55%, 0.10)';
        ctx.fillRect(left, chartArea.top, width, chartArea.bottom - chartArea.top);
        ctx.fillStyle = 'hsla(42, 70%, 55%, 0.55)';
        ctx.fillRect(left, chartArea.top, 1, chartArea.bottom - chartArea.top);
      }
      ctx.restore();
    },
  };
}

// ─── Surgical updates ─────────────────────────────────────────

function repaintChips() {
  const host = $('#mightChips');
  if (host) host.innerHTML = chipsHtml();
}

/** Selection changed: refetch just the series, redraw just that chart. */
async function refreshCompare() {
  repaintChips();
  const compare = await fetchCompare();
  state.series = Array.isArray(compare?.series) ? compare.series : [];
  drawCompareChart();
}

/** Timeframe changed: totals + events + series are all window-scoped. The
 *  ranking table is not (it uses a fixed delta), so it stays untouched. */
async function changeWindow(days) {
  if (days === windowDays) return;
  windowDays = days;

  const selector = $('#mightWindow');
  if (selector) selector.innerHTML = windowSelectorHtml();

  const [totals, events, compare] = await Promise.all([
    api(`/might/totals?days=${windowDays}`).catch(() => ({ totals: [] })),
    fetchEvents(),
    fetchCompare(),
  ]);
  state.totals = Array.isArray(totals?.totals) ? totals.totals : [];
  state.events = Array.isArray(events?.windows) ? events.windows : [];
  state.series = Array.isArray(compare?.series) ? compare.series : [];

  const stats = $('#mightHeaderStats');
  if (stats) stats.innerHTML = headerStatsHtml();
  drawTotalsChart();
  drawCompareChart();
}

function wireControls(el) {
  // Delegated to the page container, which SURVIVES an innerHTML swap — so it
  // must be attached exactly once or every render would stack another listener
  // and one chip click would fire repeatedly.
  if (el.dataset.mightWired !== '1') {
    el.dataset.mightWired = '1';

    el.addEventListener('click', (ev) => {
      const days = ev.target.closest('button[data-might-days]')?.dataset.mightDays;
      if (days) return void changeWindow(Number.parseInt(days, 10));

      const chip = ev.target.closest('button[data-might-toggle]');
      if (chip) {
        const id = Number.parseInt(chip.dataset.mightToggle, 10);
        if (!Number.isFinite(id)) return;
        selectedIds = selectedIds.includes(id)
          ? selectedIds.filter((x) => x !== id)
          : [...selectedIds, id];
        return void refreshCompare();
      }

      const action = ev.target.closest('button[data-might-action]')?.dataset.mightAction;
      if (action === 'clear') {
        selectedIds = [];
        return void refreshCompare();
      }
      if (action === 'top') {
        selectedIds = rankedRows().slice(0, DEFAULT_SELECTION).map((r) => r.memberId);
        return void refreshCompare();
      }
    });

    el.addEventListener('change', (ev) => {
      if (ev.target.id !== 'mightShowEvents') return;
      showEvents = ev.target.checked === true;
      // Bands need the windows; fetch them the first time they're switched on.
      if (showEvents && state.events.length === 0) {
        fetchEvents().then((events) => {
          state.events = Array.isArray(events?.windows) ? events.windows : [];
          drawCompareChart();
        });
      } else {
        drawCompareChart();
      }
    });

    el.addEventListener('input', (ev) => {
      if (ev.target.id !== 'mightMemberFilter') return;
      memberFilter = ev.target.value;
      // Chips only — no network, and the input keeps focus.
      repaintChips();
    });
  }
}

/**
 * Might data for one member's page: headline stat cards plus, when there's enough
 * history, a trend chart with its own window selector. The chart carries hero
 * level as a second series whenever the window holds one — see
 * drawMemberMightChart for why that shares this card instead of getting its own.
 *
 * Returns `{ statsHtml, html, draw }`. `statsHtml` holds Might / Hero Level stat
 * cards for the top strip and appears from the very FIRST capture — a single reading
 * is a perfectly good current value even though it can't be charted. `html` is the
 * chart card and is empty until there are two points, since a one-point line is
 * worse than no chart. `draw` must run after the HTML is mounted (Chart.js needs a
 * live canvas) and is a no-op when there's no chart.
 *
 * Returns null only when the member has no might data at all.
 */
export async function buildMemberMightCard(memberId) {
  const first = await fetchMemberMight(memberId, memberWindowDays);
  if (!first) return null;
  const current = first.latest ?? first.points[first.points.length - 1] ?? null;
  if (!current) return null;

  // Hero level only shows when it has actually been read — it needs the calibrated
  // crop to reach the avatars, so on most instances there is nothing to show and an
  // empty card would just be noise.
  // Compact headline, exact figure underneath. A stat card is min 160px wide with
  // 18px padding, so ~124px of room — and "1,310,381,155" at the 28px headline size
  // needs closer to 220px. Scaling the headline keeps it consistent with every other
  // stat card on the page while the 11px sub line carries full precision.
  const statsHtml = `
    <div class="stat-card">
      <div class="label">Might</div>
      <div class="value" title="${formatMight(current.might)}">${formatMightShort(current.might)}</div>
      <div class="sub stat-sub-exact" title="${formatMight(current.might)}${current.gameDate ? ` · game day ${esc(current.gameDate)}` : ''}">${formatMight(current.might)}${current.gameDate ? ` · ${esc(formatGameDayShort(current.gameDate))}` : ''}</div>
    </div>
    ${current.heroLevel ? `
    <div class="stat-card">
      <div class="label">Hero Level</div>
      <div class="value">${current.heroLevel.toLocaleString('en-US')}</div>
      <div class="sub">from the member list</div>
    </div>` : ''}`;
  const statsOnly = { statsHtml, html: '', draw: () => {} };

  // Fewer than two readings in the selected window. Two very different causes,
  // so find out which before deciding what to show: a member who simply has no
  // history yet gets no card (a one-point line is worse than no chart), while
  // one whose readings all predate the window keeps the card — otherwise the
  // window selector disappears along with it and there's no way back to a
  // wider one. Until the operator picks a window themselves, that case widens
  // silently; once they have, an explicit choice is honoured even when empty.
  let points = first.points;
  let days = memberWindowDays;
  let emptyWindow = false;
  if (points.length < 2 && days !== 0) {
    const all = await fetchMemberMight(memberId, 0);
    if (!all || all.points.length < 2) return statsOnly;
    if (memberWindowExplicit) emptyWindow = true;
    else { points = all.points; days = 0; }
  } else if (points.length < 2) {
    return statsOnly;
  }

  const html = `<div class="card" id="memberMightCard">${memberMightCardInner(points, current, days, emptyWindow)}</div>`;
  const draw = () => {
    drawMemberMightChart(points);
    wireMemberMightWindow(memberId);
    // members.js re-renders the whole member view when the operator flips a
    // history tab, which remounts this card's original HTML. If they had
    // changed the window since, that render is stale — refresh it in place.
    // Guarded on `explicit` so the silent widen above can't re-trigger itself.
    if (memberWindowExplicit && memberWindowDays !== days) {
      refreshMemberMightCard(memberId, memberWindowDays);
    }
  };
  return { statsHtml, html, draw };
}

/** One member's history for a window. `days` of 0 asks for everything. */
async function fetchMemberMight(memberId, days) {
  try {
    const res = await api(`/might/member/${memberId}${days > 0 ? `?days=${days}` : ''}`);
    return {
      points: Array.isArray(res?.points) ? res.points : [],
      latest: res?.latest ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Header + body of the member might card, for a given set of points. Split out
 * of buildMemberMightCard so a window change can re-render the card in place
 * instead of re-rendering the member page around it.
 *
 * `current` is the member's latest reading regardless of window (that's what
 * "now" means); the trend is measured between the ENDS OF THE WINDOW, so it
 * always describes exactly the line that's drawn.
 */
function memberMightCardInner(points, current, days, emptyWindow) {
  const oldest = points[0];
  const newest = points[points.length - 1];
  const changed = emptyWindow ? null : newest.might - oldest.might;
  const d = formatDelta(changed);

  // The trend used to be one muted grey line, which buried the number the card
  // exists to show. It's now a tinted up/down pill carrying the absolute delta
  // plus the percentage it represents — might figures are large enough that
  // "+4,467,650" alone gives no sense of scale. A flat reading gets no
  // percentage: "±0 · ±0.0%" says the same thing twice.
  const pct = changed && oldest.might > 0
    ? `${changed > 0 ? '+' : '−'}${(Math.abs(changed) / oldest.might * 100).toFixed(1)}%`
    : null;
  const trendTitle = emptyWindow
    ? 'No readings in this window'
    : `${d.text} from ${oldest.gameDate} to ${newest.gameDate}`;

  // Span of what is actually drawn, not the window that was asked for. Might
  // tracking is young on most installs, so a 30-day window routinely holds four
  // days of readings — and the chart's category axis plots only the days that
  // exist, so claiming "30 days" over five points would be a plain lie.
  const spanDays = emptyWindow ? 0
    : Math.round((Date.parse(`${newest.gameDate}T00:00:00Z`) - Date.parse(`${oldest.gameDate}T00:00:00Z`)) / 86_400_000);
  const spanLabel = emptyWindow
    ? 'no readings in this window'
    : `last ${spanDays} day${spanDays === 1 ? '' : 's'}`;

  const windowButtons = MEMBER_WINDOW_OPTIONS
    .map((o) => `<button class="btn btn-tight ${o.days === days ? 'active' : ''}" data-member-might-days="${o.days}">${o.label}</button>`)
    .join('');

  return `
    <div class="card-header">
      <h2>${hasHeroLevel(points) ? 'Might &amp; Hero Level' : 'Might'}</h2>
      <div class="might-trend">
        <span class="might-trend-pill ${d.cls}" title="${esc(trendTitle)}">
          <span class="might-trend-arrow">${d.arrow}</span>
          <span class="might-trend-amount">${d.text}</span>
          ${pct ? `<span class="might-trend-pct">${pct}</span>` : ''}
        </span>
        <span class="card-header-hint">${formatMight(current.might)} now · ${esc(spanLabel)}</span>
        <div class="period-selector" id="memberMightWindow">${windowButtons}</div>
      </div>
    </div>
    <div class="card-body card-body-padded">
      ${emptyWindow
        ? '<div class="empty-state"><p>No readings in this window. Pick a wider one.</p></div>'
        : `<div class="chart-container chart-container--compact${hasHeroLevel(points) ? ' chart-container--legend' : ''}"><canvas id="memberMightChart"></canvas></div>`}
    </div>`;
}

/** True when at least one reading in the window carries a hero level. */
function hasHeroLevel(points) {
  return points.some((p) => p.heroLevel !== null && p.heroLevel !== undefined);
}

/**
 * The member chart: might over time, with hero level layered on a second scale
 * when it has been read.
 *
 * Two y-scales on one plot is normally the wrong answer — it lets the reader
 * infer meaning from where the lines cross, which is an artefact of the two
 * ranges and nothing else. It is deliberate here because the alternative was a
 * second card for a series that is a handful of integers, and two things defuse
 * the usual failure: hero level is drawn STEPPED and dashed, so it reads as
 * "held this level from here to here" rather than as a slope that could track
 * the might curve, and the legend names the axis each line belongs to instead of
 * leaving the mapping to be guessed. If a third measure ever wants in, that's
 * the point to split the card rather than add a third scale.
 */
function drawMemberMightChart(points) {
  const canvas = $('#memberMightChart');
  if (!canvas) return;
  memberChartPoints = points;
  const t = chartTokens();
  const withHero = hasHeroLevel(points);
  const opts = baseLineOptions(t, '');

  const datasets = [{
    label: withHero ? 'Might (left)' : 'Might',
    data: points.map((p) => p.might),
    borderColor: t.accentGold,
    backgroundColor: t.accentGold,
    borderWidth: 2,
    pointRadius: points.length > 60 ? 0 : 2,
    tension: 0.2,
    fill: false,
    yAxisID: 'y',
  }];

  if (withHero) {
    datasets.push({
      label: 'Hero level (right)',
      // Missing readings stay null and are spanned, not zeroed: the hero level
      // comes off the avatar in the member-list crop, so a day the OCR couldn't
      // read it is a gap in knowledge — plotting 0 would draw a cliff down to
      // level zero and back.
      data: points.map((p) => (p.heroLevel ?? null)),
      borderColor: t.accentBlue,
      backgroundColor: t.accentBlue,
      borderWidth: 2,
      borderDash: [4, 3],
      pointRadius: points.length > 60 ? 0 : 2,
      stepped: true,
      spanGaps: true,
      fill: false,
      yAxisID: 'y1',
    });

    // With two series identity can't be colour-only, and with two scales the
    // reader also has to know which line is measured against which side — both
    // are carried by the dataset labels above.
    opts.plugins.legend = {
      display: true,
      position: 'top',
      align: 'end',
      labels: { color: t.tick, boxWidth: 22, boxHeight: 2, font: { size: 11 } },
    };

    opts.scales.y1 = {
      position: 'right',
      // A hero level is a small integer, so the auto range routinely lands on
      // half-steps ("41.5"). Drop anything fractional rather than rounding, which
      // would print the same level on two adjacent ticks.
      ticks: { color: t.tick, precision: 0, callback: (v) => (Number.isInteger(v) ? v : '') },
      // Only the might axis draws gridlines. A second grid can never line up with
      // the first, so it reads as noise the chart didn't need.
      grid: { drawOnChartArea: false },
    };

    // formatMight abbreviates and thousands-separates, which is right for might
    // and wrong for a level. Also drop the entry entirely on a day whose hero
    // level was never read, instead of showing "Hero level: —" next to a real
    // might figure.
    opts.plugins.tooltip.filter = (item) => item.parsed.y !== null && item.parsed.y !== undefined;
    opts.plugins.tooltip.callbacks.label = (ctx) => (
      ctx.dataset.yAxisID === 'y1'
        ? `Hero level: ${ctx.parsed.y}`
        : `Might: ${formatMight(ctx.parsed.y)}`
    );
  }

  destroyChart('member');
  charts.member = new Chart(canvas, {
    type: 'line',
    data: { labels: points.map((p) => p.gameDate), datasets },
    options: opts,
  });
}

/** Swap the card's contents for another window. One fetch, one redraw — the
 *  member page around it is left alone (see this file's INTERACTION RULE). */
async function refreshMemberMightCard(memberId, days) {
  const card = $('#memberMightCard');
  if (!card) return;
  card.classList.add('is-loading');
  const data = await fetchMemberMight(memberId, days);
  card.classList.remove('is-loading');
  if (!data) return;
  const current = data.latest ?? data.points[data.points.length - 1] ?? null;
  if (!current) return;
  const emptyWindow = data.points.length < 2;
  card.innerHTML = memberMightCardInner(data.points, current, days, emptyWindow);
  if (!emptyWindow) drawMemberMightChart(data.points);
  wireMemberMightWindow(memberId);
}

function wireMemberMightWindow(memberId) {
  // The bar is recreated by every render, so this attaches exactly one
  // listener to the live element rather than accumulating them.
  const bar = $('#memberMightWindow');
  bar?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-member-might-days]');
    if (!btn) return;
    const next = Number.parseInt(btn.dataset.memberMightDays, 10);
    if (!Number.isFinite(next) || next === memberWindowDays) return;
    memberWindowDays = next;
    memberWindowExplicit = true;
    refreshMemberMightCard(memberId, next);
  });
}
