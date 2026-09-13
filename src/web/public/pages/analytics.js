// Analytics — what the clan did in a chosen timeframe: headline stats with
// period-over-period deltas, daily activity, chest-type and source breakdowns,
// top contributors, and the "All Chest Types" table that drills down into the
// per-chest collectors page.
//
// TIMEFRAME. Every number below the selector comes from one request to
// /api/analytics/window, which returns the chosen window and the equal-length
// window before it. That endpoint exists because this page used to have no
// timeframe at all: /analytics/summary and /analytics/top-contributors take no
// period, so on 185k records every headline was a statement about the whole
// history of the clan — not a question anyone asks.
//
// The period lives in THIS module, not in lib/state.js. That module's
// currentPeriod is shared by the Leaderboard and Triumphal pages, so routing
// through it would make picking "Monthly" here silently retune two other pages,
// and would make an All Time default impossible. pages/events.js keeps its
// timeframe page-local for the same reason.
//
// Switching period repaints in place rather than going through navigateTo().
// Re-entering renderAnalytics would re-run /stats and /might/totals?days=90 —
// neither of which is period-scoped — and destroy and rebuild every Chart.js
// instance to show the same picture. The URL is still kept in step via
// history.replaceState, so copying it reproduces the view; it just doesn't
// stack a history entry per click on an arrow.
//
// The chest drill-down sub-page (renderChestDetail) lives here too because its
// data flow (sort + expand collector rows + period filter) depends on state
// that's only meaningful while you're on the chest page — colocating keeps the
// sort cache and the renderer in one file.

import { api } from '../lib/api.js';
import {
  $, esc, formatDate, formatDateShort, formatRelativeTime,
  memberLink, chestHash, formatUtcDateKey, parseHashRoute, restoreDetailsState,
} from '../lib/ui.js';
import {
  computeGameWindow, periodAnchorFromOffset, periodOffsetFromAnchor,
} from '../lib/period.js';
import { renderPeriodNav } from '../lib/period-nav.js';
import {
  scaleGoalForPeriod, goalWarnThreshold, goalStatusClassFor,
} from '../lib/leaderboard-render.js';
import { readToken } from '../lib/theme.js';

const PERIODS = ['daily', 'weekly', 'monthly', 'yearly', 'all'];

// What the previous window is called in a delta caption, per period.
const MEMBER_PERIOD_NOUN_ANALYTICS = {
  daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year',
};

const PREVIOUS_LABEL = {
  daily: 'previous day',
  weekly: 'previous week',
  monthly: 'previous month',
  yearly: 'previous year',
};

// Below this many chests/points in the PREVIOUS window, a percentage is noise
// dressed as a signal — three chests becoming six is not "+100% activity". Show
// the absolute change instead.
const MIN_BASELINE_FOR_PERCENT = 20;

// All Time has no bounded window, so the daily chart would otherwise draw one
// bar per game day since the clan was created. Show the tail instead.
const ALL_TIME_CHART_DAYS = 60;

// Past this many bars, one per game day stops being readable and the series is
// bucketed. ~13 weeks of daily bars, so a Monthly window is never bucketed and a
// Yearly one always is.
const MAX_ACTIVITY_BARS = 92;


// ─── Page state ───
// Module-level and page-local by design; see the header note.

let mountedEl = null;
let period = 'all';
let periodOffset = 0;
let windowData = null;   // /analytics/window payload
let staticData = null;   // { stats, mightTotals } — not period-scoped
let activityMetric = 'chests';   // which series the Clan Activity bars show
let breakdownDim = 'type';       // Breakdown card: type | source | chest
let breakdownShowAll = false;
let breakdownFilter = '';
let weeklyGoalPoints = null;  // clan's per-member weekly points target, or null
let contributorsSustainedOnly = false;

// "Sustained" means turning up on most days. That is the whole definition.
//
// It briefly also required that no single day carried too much of a member's
// total, on the theory that one big sitting is not a habit. That theory does
// not survive contact with how this game is actually played: events, crypt
// cycles and coordinated runs all concentrate a week's effort into a day or
// two, and plenty of committed members deliberately play that way. The filter
// was excluding people who were active SEVEN days out of seven because they
// also had one good evening — punishing exactly the effort it was meant to find.
//
// Best-day share stays as a COLUMN, because "where did their points come from"
// is genuinely useful context. It just isn't a judgement, so it no longer
// excludes anybody.
const SUSTAINED_MIN_ACTIVE_RATIO = 0.6;

// Charts created on the analytics page. Held in a module-level set so the
// themechange listener (registered once below) can call destroy() + rebuild
// them whenever the user picks a different theme — Chart.js snapshots colors at
// construction time and won't pick up CSS variable changes otherwise.
const activeCharts = new Set();

function destroyActiveCharts() {
  for (const chart of activeCharts) {
    try { chart.destroy(); } catch (_) { /* already destroyed */ }
  }
  activeCharts.clear();
}

function chartTokens() {
  return {
    grid: readToken('--chart-grid'),
    tick: readToken('--chart-tick'),
    tooltipBg: readToken('--chart-tooltip-bg'),
    tooltipText: readToken('--chart-tooltip-text'),
    tooltipBorder: readToken('--chart-tooltip-border'),
    barBlue: readToken('--chart-bar-blue'),
    barBlueHover: readToken('--chart-bar-blue-hover'),
    barGold: readToken('--chart-bar-gold'),
    barGoldHover: readToken('--chart-bar-gold-hover'),
    accentGold: readToken('--accent-gold'),
    accentGreen: readToken('--accent-green'),
  };
}

// One global listener — when the theme changes, rebuild whatever charts are
// currently on screen so axis ticks, grid lines, and bar fills pick up the new
// tokens. No-op when the analytics page hasn't rendered yet.
document.addEventListener('themechange', () => {
  if (!mountedEl || !windowData) return;
  destroyActiveCharts();
  drawAnalyticsCharts();
});

// ─── Entry point ───

export async function renderAnalytics(el) {
  mountedEl = el;

  // /stats first and on its own: it is what populates the cached game-day
  // rollover hour in lib/state.js, and every window computed below is keyed on
  // it. Reading the URL anchor needs it too.
  const stats = await api('/stats');

  const route = parseHashRoute();
  const requested = route.params.get('period');
  period = PERIODS.includes(requested) ? requested : 'all';
  periodOffset = period === 'all' ? 0 : periodOffsetFromAnchor(period, route.params);

  // Optional data from the opt-in might tracker, so it's fetched separately and
  // the card is simply absent when there's nothing to plot. Analytics must
  // never fail to render because of it.
  const [mightTotals, goal] = await Promise.all([
    api('/might/totals?days=90')
      .then((r) => (Array.isArray(r?.totals) ? r.totals : []))
      .catch(() => []),
    // Null when the clan hasn't configured one, which is a real state, not an
    // error — the contributor table simply carries no colour.
    api('/leaderboard/goal').catch(() => null),
  ]);
  weeklyGoalPoints = Number.isFinite(goal?.weeklyPoints) ? goal.weeklyPoints : null;

  staticData = { stats, mightTotals };
  await reload();
}

/** Fetch the current window (and the one before it) and repaint. */
async function reload() {
  const params = new URLSearchParams({ limit: '10', compare: '1' });
  if (period !== 'all') {
    const w = computeGameWindow(period, periodOffset);
    if (w) {
      params.set('from', w.from);
      params.set('to', w.to);
    }
  }
  windowData = await api(`/analytics/window?${params.toString()}`);
  paint();
}

/**
 * Keep the address bar in step with the page without re-routing.
 *
 * The anchor is absolute (?period=weekly&week=2026-04-06), not an offset, so a
 * copied link still points at the same week tomorrow. replaceState rather than
 * assigning location.hash: assigning it fires the router, which would re-enter
 * renderAnalytics and refetch the two things on this page that never change
 * with the period.
 */
function syncUrl() {
  const params = { period };
  const anchor = periodAnchorFromOffset(period, periodOffset);
  if (anchor) params[anchor.key] = anchor.value;
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
  const next = `#analytics?${search.toString()}`;
  if (window.location.hash !== next) {
    window.history.replaceState(null, '', next);
  }
}

// ─── Rendering ───

function periodControlsHtml() {
  const buttons = PERIODS.map((p) =>
    `<button class="btn ${period === p ? 'active' : ''}" data-aperiod="${p}">${p.charAt(0).toUpperCase()}${p.slice(1)}</button>`,
  ).join('');
  return `
    <div class="card analytics-controls">
      <div class="card-body analytics-controls-body">
        <div class="period-selector">${buttons}</div>
        ${renderPeriodNav({
          period,
          offset: periodOffset,
          prevAttr: 'data-aperiod-nav="prev"',
          nextAttr: 'data-aperiod-nav="next"',
          navClass: 'analytics-nav',
        })}
      </div>
    </div>`;
}

/**
 * The "▲ 12% vs previous week" line under a stat card.
 *
 * Returns nothing at all rather than a zero when there is no honest comparison
 * to make: All Time has no preceding window, and a previous window that was
 * empty or nearly empty turns any ratio into theatre.
 */
function deltaHtml(current, previous) {
  if (period === 'all' || !windowData?.previous) return '';
  if (previous === null || previous === undefined) return '';
  const label = PREVIOUS_LABEL[period] || 'previous period';
  const diff = current - previous;
  if (diff === 0) return `<div class="sub stat-delta is-flat">No change vs ${label}</div>`;
  const up = diff > 0;
  const arrow = up ? '▲' : '▼';
  const cls = up ? 'is-up' : 'is-down';
  // A percentage needs a baseline worth dividing by.
  const magnitude = previous >= MIN_BASELINE_FOR_PERCENT
    ? `${Math.abs(Math.round((diff / previous) * 100))}%`
    : `${Math.abs(diff).toLocaleString()}`;
  return `<div class="sub stat-delta ${cls}">${arrow} ${magnitude} vs ${label}</div>`;
}

function statsGridHtml(current) {
  const cur = windowData?.current?.totals || {};
  const prev = windowData?.previous?.totals || null;
  // The roster AS IT WAS over this window, not as it is now. `totalMembers` is
  // `is_active = 1` — today's roster — so pairing it with a window's distinct
  // earners counted everyone who has since left in the numerator only, and
  // all-time read "227 of 102".
  const roster = cur.rosterMembers ?? staticData?.stats?.totalMembers ?? 0;
  const chests = cur.chests || 0;
  const points = cur.points || 0;
  const active = cur.activeMembers || 0;
  const avg = active > 0 ? Math.round((chests / active) * 10) / 10 : 0;
  const prevAvg = prev && prev.activeMembers > 0
    ? Math.round((prev.chests / prev.activeMembers) * 10) / 10
    : null;

  // "Scans" used to sit here. It is an operational number, not an analytical
  // one, and the Dashboard already carries it.
  return `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">Chests</div>
        <div class="value">${chests.toLocaleString()}</div>
        ${deltaHtml(chests, prev ? prev.chests : null)}
      </div>
      <div class="stat-card">
        <div class="label">Points</div>
        <div class="value">${points.toLocaleString()}</div>
        ${deltaHtml(points, prev ? prev.points : null)}
      </div>
      <div class="stat-card">
        <div class="label">Active Members</div>
        <div class="value">${active.toLocaleString()}${roster ? `<span class="stat-of"> of ${roster.toLocaleString()}</span>` : ''}</div>
        ${deltaHtml(active, prev ? prev.activeMembers : null)}
      </div>
      <div class="stat-card">
        <div class="label">Avg Chests / Active Member</div>
        <div class="value">${avg.toLocaleString()}</div>
        ${deltaHtml(avg, prevAvg)}
      </div>
      ${concentrationTileHtml(current)}
    </div>`;
}

// ─── Breakdown ───
// One card replacing three that all answered "chests grouped by a dimension"
// in three different visual languages: a CSS bar-list for Type, a Chart.js
// horizontal bar for Source, and a paginated table for Chest. Same question,
// three shapes, none comparable with another.
//
// The bar-list won. It shows count, share and points at once (the bar chart
// showed count only, and the table made you read numbers to see proportion),
// it is themeable straight from CSS variables, and it needs no Chart.js
// instance to destroy and rebuild on every theme change.

const BREAKDOWN_DIMENSIONS = [
  { key: 'type', label: 'Type' },
  { key: 'source', label: 'Source' },
  { key: 'chest', label: 'Chest' },
];

// Enough to see the shape of the distribution without the card becoming the
// page. Everything past it is one click away, and the filter reaches it too.
const BREAKDOWN_TOP_N = 15;

/** The current dimension's rows, normalised to one shape. */
function breakdownRows(current) {
  if (breakdownDim === 'source') {
    return (current.bySource || []).map((r) => ({
      label: r.chest_source || 'Unknown',
      count: r.count,
      points: r.points || 0,
      // Sources have no rarity, so they take the neutral dot rather than
      // borrowing a colour that would read as a chest tier.
      typeClass: 'unknown',
      href: null,
    }));
  }
  if (breakdownDim === 'chest') {
    return (current.byName || []).map((r) => ({
      label: r.chest_name,
      count: r.count,
      points: r.points || 0,
      typeClass: r.chest_type || 'unknown',
      href: chestHash(r.chest_name, 'all'),
    }));
  }
  return (current.byType || []).map((r) => ({
    label: r.chest_type,
    count: r.count,
    points: r.points || 0,
    typeClass: r.chest_type || 'unknown',
    href: null,
  }));
}

function breakdownCardHtml(current) {
  const rows = breakdownRows(current);
  // Share is always against the WHOLE dimension, never the filtered subset —
  // otherwise typing in the filter rescales every bar and a 2% source draws
  // itself as the biggest thing in the clan.
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const totalPoints = rows.reduce((sum, r) => sum + r.points, 0);

  const needle = breakdownFilter.trim().toLowerCase();
  const filtered = needle
    ? rows.filter((r) => String(r.label).toLowerCase().includes(needle))
    : rows;
  const visible = breakdownShowAll ? filtered : filtered.slice(0, BREAKDOWN_TOP_N);
  const hidden = filtered.length - visible.length;

  const dimButtons = BREAKDOWN_DIMENSIONS.map((d) =>
    `<button class="btn btn-tight ${breakdownDim === d.key ? 'active' : ''}" data-bdim="${d.key}">${d.label}</button>`,
  ).join('');

  // Type has eight or so rows; a filter box over them would be furniture.
  const filterBox = rows.length > BREAKDOWN_TOP_N
    ? `<input type="search" class="input breakdown-filter" data-bfilter
         placeholder="Filter ${esc(breakdownDim === 'chest' ? 'chests' : 'sources')}…"
         value="${esc(breakdownFilter)}" aria-label="Filter breakdown">`
    : '';

  const body = visible.length > 0
    ? visible.map((r) => {
        const share = total > 0 ? (r.count / total) * 100 : 0;
        // Round for the bar so a hairline is still visible, but print the real
        // number — a row that says "1%" next to a bar pinned at 1% is honest;
        // a row that says "0%" and draws nothing looks like a bug.
        const barWidth = Math.max(1, Math.round(share));
        const shareText = share >= 1 ? `${Math.round(share)}%` : '<1%';
        const name = r.href
          ? `<a class="member-link" href="${r.href}">${esc(r.label)}</a>`
          : esc(r.label);
        return `<div class="type-row type-${esc(r.typeClass)}">
          <div class="type-row-main">
            <span class="type-row-name"><span class="type-row-dot"></span>${name}</span>
            <span class="type-row-value">${r.count.toLocaleString()}</span>
          </div>
          <div class="type-row-bar"><span style="width: ${barWidth}%"></span></div>
          <div class="type-row-meta">
            <span>${shareText} of chests</span>
            <span>${r.points.toLocaleString()} pts</span>
          </div>
        </div>`;
      }).join('')
    : `<div class="empty-state"><p>${needle ? 'Nothing matches that filter.' : 'No chests in this timeframe.'}</p></div>`;

  const moreControl = hidden > 0
    ? `<button class="btn btn-tight breakdown-more" data-bmore>Show all ${filtered.length.toLocaleString()}</button>`
    : (breakdownShowAll && filtered.length > BREAKDOWN_TOP_N
        ? '<button class="btn btn-tight breakdown-more" data-bmore>Show top 15</button>'
        : '');

  return `
    <div class="card">
      <div class="card-header">
        <h2>Breakdown</h2>
        <div class="metric-toggle" role="group" aria-label="Break down by">${dimButtons}</div>
      </div>
      <div class="card-body analytics-type-panel">
        <div class="type-summary-card">
          <span class="type-summary-label">${esc(BREAKDOWN_DIMENSIONS.find((d) => d.key === breakdownDim).label)} spread</span>
          <strong>${rows.length.toLocaleString()}</strong>
          <span>${total.toLocaleString()} chests · ${totalPoints.toLocaleString()} pts in this timeframe</span>
        </div>
        ${filterBox}
        <div class="type-breakdown-list">${body}</div>
        ${moreControl}
      </div>
    </div>`;
}

// ─── Pace ───
// "Are we going to make it" is a different question from "how are we doing",
// and only the first one is actionable while there is still time to act.

// Below this much of the period elapsed, a projection is arithmetic on almost
// no data — one good evening on a Monday would forecast a record week.
const PACE_MIN_ELAPSED = 0.25;

// How far short of the goal a projection has to land before it is worth
// naming as a risk rather than a rounding difference.
const PACE_SHORTFALL = 0.75;

const GOAL_DAYS_BY_PERIOD = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };

/**
 * How far through the current period we are, 0..1, or null when the question
 * doesn't apply.
 *
 * Elapsed is measured against the goal's OWN period length, not the real
 * window: scaleGoalForPeriod prices a monthly target at 30 days, so measuring
 * progress against a 31-day month would quietly move the finish line. Only the
 * period in progress has a pace — a past window is finished, and All Time has
 * no end to run out of.
 */
function paceElapsed() {
  if (period === 'all' || periodOffset !== 0) return null;
  const days = GOAL_DAYS_BY_PERIOD[period];
  if (!days) return null;
  const w = computeGameWindow(period, 0);
  if (!w) return null;
  const startMs = Date.parse(w.from);
  const spanMs = days * 86_400_000;
  const elapsed = (Date.now() - startMs) / spanMs;
  return Math.min(1, Math.max(0, elapsed));
}

function formatRemaining(fraction) {
  const days = GOAL_DAYS_BY_PERIOD[period] || 0;
  const leftMs = Math.max(0, (1 - fraction) * days * 86_400_000);
  const d = Math.floor(leftMs / 86_400_000);
  const h = Math.floor((leftMs % 86_400_000) / 3_600_000);
  if (d > 0) return `${d}d ${h}h remaining`;
  if (h > 0) return `${h}h remaining`;
  return 'less than an hour remaining';
}

/**
 * The clan-side pace band above the contributor table.
 *
 * Counts members against the PER-MEMBER goal, which is the only thing that
 * target means. It is deliberately not applied to any clan-wide total: a
 * 47-member clan clears 47x a per-member goal every week, so a clan-level
 * version would be permanently green and would teach people the colour is
 * decoration.
 */
function paceBandHtml(current) {
  const periodGoal = scaleGoalForPeriod(weeklyGoalPoints, period);
  if (!periodGoal) return '';
  const elapsed = paceElapsed();
  if (elapsed === null || elapsed < PACE_MIN_ELAPSED) return '';
  if (!Array.isArray(windowData?.movers)) return '';

  // The WHOLE roster, not current.contributors — that is a top-N display list
  // (ten rows), so counting over it capped "on pace" at ten and shovelled
  // everyone below tenth place into the shortfall bucket. On a clan where
  // eighty members had already cleared the goal it read "10 of 101 on pace, 91
  // will finish short", which is not a rounding error, it is the opposite of
  // the truth.
  //
  // windowData.movers is the full comparison set and carries this window's
  // points for every member who earned anything in either window. Present
  // exactly when pace is (compare && windowed), so no extra request.
  const all = Array.isArray(windowData?.movers) ? windowData.movers : [];
  // Someone the sweep has removed is not "going to finish short" — they are
  // gone, and counting them makes the clan look worse than it is every week.
  const rows = all.filter((r) => r.isActive);
  const roster = staticData?.stats?.totalMembers ?? rows.length;

  // Projection assumes the rest of the period looks like the part so far. That
  // is an assumption, not a forecast, and the caption says so rather than
  // dressing it up.
  const projected = (points) => points / elapsed;
  const onPace = rows.filter((r) => projected(r.points) >= periodGoal).length;
  const shortBy = rows.filter((r) => projected(r.points) < periodGoal * PACE_SHORTFALL).length;
  // Members who earned nothing in either window never reach the comparison set
  // at all, and they are short by definition.
  const silent = Math.max(0, roster - rows.length);

  return `
    <div class="pace-band">
      <span class="pace-figure">${onPace.toLocaleString()} of ${roster.toLocaleString()}</span>
      on pace for ${periodGoal.toLocaleString()} pts
      <span class="pace-sep">·</span>${formatRemaining(elapsed)}
      ${shortBy + silent > 0 ? `<span class="pace-sep">·</span><span class="pace-risk">${(shortBy + silent).toLocaleString()} will finish more than ${Math.round((1 - PACE_SHORTFALL) * 100)}% short</span>` : ''}
      <span class="pace-caveat">if the rest of the ${MEMBER_PERIOD_NOUN_ANALYTICS[period] || 'period'} matches so far</span>
    </div>`;
}

/**
 * Top contributors for the window, as one ranked table.
 *
 * This replaced two ten-row podiums, "Top Chests" and "Top Points", sitting
 * side by side. They were two orderings of very nearly the same ten people, so
 * half the screen was spent saying the same thing twice and neither told you
 * the other figure for anyone on it.
 *
 * Points cell is goal-coloured, reusing the Leaderboard's own helpers rather
 * than re-deriving the thresholds — the goal is PER MEMBER, so it is meaningful
 * on a member row here in a way it deliberately is not on the clan-wide stat
 * strip above.
 *
 * The Days and Best-day columns are what stop a sum being read as effort. Every
 * ranking in this app is a total, and a total pays one lucky 6,000-point event
 * drop exactly what it pays five weeks of turning up. "Days" says how often
 * somebody showed up; "best day" says how much of their total came from a
 * single sitting. Together they separate the two, which no amount of staring at
 * the points column will.
 */
function contributorsCardHtml(current) {
  const all = current.contributors || [];
  const windowDays = current.windowDays ?? windowData?.windowDays ?? null;
  const periodGoal = scaleGoalForPeriod(weeklyGoalPoints, period);
  const warnAt = goalWarnThreshold(periodGoal);

  // "Sustained" is turning up often AND not depending on one big day. Both
  // halves are needed: five sessions can still be one real evening and four
  // token ones, and one huge day is not commitment however large it is.
  const canFilter = windowDays !== null && windowDays >= 4;
  const sustained = (r) => windowDays
    && r.activeDays / windowDays >= SUSTAINED_MIN_ACTIVE_RATIO;

  const rows = contributorsSustainedOnly && canFilter ? all.filter(sustained) : all;

  const goalHint = periodGoal
    ? `<span class="card-header-hint">Goal ${periodGoal.toLocaleString()} pts / member · amber from ${warnAt.toLocaleString()}</span>`
    : '';

  const minDays = windowDays ? Math.ceil(windowDays * SUSTAINED_MIN_ACTIVE_RATIO) : 0;
  const filterChip = canFilter
    ? `<button class="btn btn-tight ${contributorsSustainedOnly ? 'active' : ''}" data-csustained
         title="Members active on at least ${minDays} of the ${windowDays} days in this timeframe">Sustained only</button>`
    : '';

  // A filter that silently removes people is a filter nobody trusts. Say how
  // many went and on which of the two rules, so a member can check themselves
  // against the numbers in their own row.
  const filterNote = contributorsSustainedOnly && canFilter
    ? `<p class="muted-copy card-note">Showing ${rows.length.toLocaleString()} of
        ${all.length.toLocaleString()} — members active on at least ${minDays} of the
        ${windowDays} days in this timeframe.</p>`
    : '';

  const body = rows.length > 0
    ? rows.map((e, i) => {
        const rank = contributorsSustainedOnly ? all.indexOf(e) + 1 : i + 1;
        const goalClass = goalStatusClassFor(e.points, periodGoal);
        const bestShare = e.points > 0 ? Math.round((e.bestDayPoints / e.points) * 100) : 0;
        return `<tr>
          <td data-label="Rank" data-role="lead"><span class="rank rank-${rank}">#${rank}</span></td>
          <td data-label="Player" data-role="primary"><span class="mrow-name">${memberLink(e.memberId, e.name)}</span><span class="mrow-sub">${e.chests.toLocaleString()} chests</span></td>
          <td data-label="Days" class="num" data-role="hidden">${e.activeDays.toLocaleString()}${windowDays ? ` <span class="of-days">/ ${windowDays}</span>` : ''}</td>
          <td data-label="Best day" class="num" data-role="hidden" title="${e.bestDayPoints.toLocaleString()} points on their best single day">${bestShare}%</td>
          <td data-label="Points" class="num ${goalClass}" data-role="metric">${e.points.toLocaleString()}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="5"><div class="empty-state"><p>${contributorsSustainedOnly
        ? 'Nobody met the sustained bar in this timeframe.'
        : 'Nobody collected a chest in this timeframe.'}</p></div></td></tr>`;

  return `
    <div class="card">
      <div class="card-header">
        <h2>Top Contributors</h2>
        <div class="contributors-controls">${filterChip}${goalHint}</div>
      </div>
      <div class="card-body">
        ${paceBandHtml(current)}
        ${filterNote}
        <p class="muted-copy card-note">
          Gift chests earned in this timeframe. Triumphals are scored on their
          <a class="member-link" href="#triumphal">own page</a>; end-of-event clan rewards
          rank nobody, so they are excluded.
        </p>
        <table class="table-responsive leaderboard-table">
          <colgroup>
            <col class="col-rank">
            <col class="col-player">
            <col class="col-num">
            <col class="col-num">
            <col class="col-num">
          </colgroup>
          <thead><tr>
            <th>Rank</th><th>Player</th>
            <th class="num" title="Game days in this timeframe on which they collected at least one chest">Days</th>
            <th class="num" title="Share of their points that came from their single biggest day. Context, not a verdict — concentrating a week's effort into an event day is a normal way to play.">Best day</th>
            <th class="num">Points</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

/**
 * How few people the clan depends on.
 *
 * A leader can read a leaderboard for months without noticing that four of
 * fifty members produce half of everything — until two of them go quiet and a
 * target that has always been hit is missed.
 *
 * Rendered as a stat tile in the same row as the headline figures, because that
 * is what it is: one number about this timeframe, with context. As its own card
 * beside them it was half again their height with the content floating in the
 * middle of it.
 *
 * The sparkline shows SHAPE and the big number shows LEVEL. Bars are scaled to
 * the series' own maximum, not to 100% — a share that sits around 17% every
 * week drew eight identical stubs along the floor, which is a true picture of
 * nothing. The exact value per week is on hover, and the tile's own number says
 * where the level actually is.
 *
 * No verdict text and no red/green: there is no correct concentration for a
 * clan. A tight core carrying an event is a strategy, not a fault.
 */
function concentrationTileHtml(current) {
  const c = current.concentration;
  if (!c || c.topFiveShare === null) return '';

  const pct = Math.round(c.topFiveShare * 100);
  const half = c.membersForHalf;
  // Gate the trend on enough weeks to BE a trend; three points is a squiggle.
  const weekly = Array.isArray(c.weekly) && c.weekly.length >= 8 ? c.weekly : [];
  const peak = weekly.length ? Math.max(...weekly.map((w) => w.share)) : 0;

  const spark = weekly.length > 0
    ? `<div class="concentration-spark" role="img"
         aria-label="Top-five share over the last ${weekly.length} game weeks">
        ${weekly.map((w) => {
          const h = peak > 0 ? Math.max(8, Math.round((w.share / peak) * 100)) : 8;
          return `<span class="concentration-bar" style="height: ${h}%" title="${w.weekStart}: ${Math.round(w.share * 100)}%"></span>`;
        }).join('')}
      </div>`
    : '';

  return `
    <div class="stat-card stat-card-concentration">
      <div class="label">Top 5 share</div>
      <div class="value">${pct}%</div>
      <div class="sub">${half ? `${half.toLocaleString()} member${half === 1 ? '' : 's'} make half the points` : 'of this timeframe&rsquo;s points'}</div>
      ${spark}
    </div>`;
}

// ─── Movers ───
// Who to thank and who to chase, since the last comparable window.
//
// This is deliberately ONE card. Four separate ones suggested themselves — a
// roster watchlist, a biggest-drops toggle, a "nobody scored" list and a "needs
// a look" list — and they would have been four overlapping subsets of the same
// eight people, each with its own private threshold. Four cards a leader learns
// to ignore is worse than one they read.

// A percentage needs a baseline worth dividing by. Below this, a member's
// previous window is too small for "down 80%" to mean anything, so they can
// still appear as a mover but never as a flagged drop.
const MOVER_MIN_BASELINE_POINTS = 50;

// How far below their own previous window a member has to fall before the
// drop is worth a leader's attention.
const MOVER_DROP_RATIO = 0.5;

// Rows shown in the movers table before it is capped. The attention list is
// separate and always shows everything it flags.
const MOVERS_VISIBLE = 10;

/**
 * Decide who is worth flagging, and why.
 *
 * Two reason codes only, on purpose. Baseline decay, "playing but not
 * contributing" and the rest are all defensible, and every one of them is a
 * guess about which people a leader actually wants surfaced. Ship the two that
 * are unambiguous, find out whether they flag the right people, and add from
 * there rather than shipping six thresholds nobody has calibrated.
 */
function flagMover(row, windowStartMs) {
  // Someone who joined mid-window has an empty previous window for a reason
  // that is not a drop. Reporting them as "down 100%" is exactly how a
  // watchlist trains people to stop reading it.
  const joinedMs = Date.parse(row.firstSeen);
  if (Number.isFinite(joinedMs) && joinedMs >= windowStartMs) return null;

  if (row.prevPoints >= MOVER_MIN_BASELINE_POINTS && row.points === 0) {
    return { code: 'silent', label: 'No chests this period' };
  }
  if (row.prevPoints >= MOVER_MIN_BASELINE_POINTS
      && row.points < row.prevPoints * MOVER_DROP_RATIO) {
    const pct = Math.round((1 - row.points / row.prevPoints) * 100);
    const noun = MEMBER_PERIOD_NOUN_ANALYTICS[period] || 'period';
    return { code: 'drop', label: `Down ${pct}% on their own previous ${noun}` };
  }
  return null;
}

function moversCardHtml() {
  const rows = Array.isArray(windowData?.movers) ? windowData.movers : [];
  if (period === 'all' || !windowData?.previous) return '';

  const windowStartMs = windowData?.from ? Date.parse(windowData.from) : 0;
  const coverage = windowData?.coverage;
  // A real scan gap means the current window is an undercount, and every
  // "stopped contributing" flag in it could be the scanner rather than the
  // member. Say so and show nobody rather than sending a leader after people
  // who did nothing wrong.
  const blindGap = coverage && coverage.worstGapHours > 0;

  const withDelta = rows.map((r) => ({
    ...r,
    delta: r.points - r.prevPoints,
    flag: blindGap ? null : flagMover(r, windowStartMs),
  }));

  const movers = [...withDelta].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const visible = movers.slice(0, MOVERS_VISIBLE);
  const flagged = withDelta.filter((r) => r.flag);

  const deltaCell = (d) => {
    if (d === 0) return '<span class="mover-delta is-flat">—</span>';
    const cls = d > 0 ? 'is-up' : 'is-down';
    return `<span class="mover-delta ${cls}">${d > 0 ? '▲' : '▼'} ${Math.abs(d).toLocaleString()}</span>`;
  };

  const moverRows = visible.length > 0
    ? visible.map((r) => `<tr>
        <td data-label="Player" data-role="primary"><span class="mrow-name">${memberLink(r.memberId, r.name)}${r.isActive ? '' : ' <span class="mover-left-badge" title="No longer on the in-game roster">left</span>'}</span><span class="mrow-sub">was ${r.prevPoints.toLocaleString()}</span></td>
        <td data-label="Points" class="num" data-role="metric">${r.points.toLocaleString()}</td>
        <td data-label="Change" class="num" data-role="hidden">${deltaCell(r.delta)}</td>
      </tr>`).join('')
    : '<tr><td colspan="3"><div class="empty-state"><p>Nothing to compare yet — this is the first period with data on both sides.</p></div></td></tr>';

  const attention = blindGap
    ? `<div class="empty-state"><p>Not shown for this window: the scanner was quiet for
         ${coverage.worstGapHours} hours, longer than a gift survives, so a member looking
         inactive here may just be a chest nobody could capture.</p></div>`
    : (flagged.length > 0
        ? `<table class="table-responsive attention-table">
             <colgroup><col class="col-player"><col><col class="col-num"><col class="col-num"></colgroup>
             <thead><tr>
               <th>Player</th><th>Why</th>
               <th class="num">Previous</th><th class="num">This period</th>
             </tr></thead>
             <tbody>${flagged.map((r) => `<tr>
               <td data-label="Player" data-role="primary"><span class="mrow-name">${memberLink(r.memberId, r.name)}</span><span class="mrow-sub">${esc(r.flag.label)}</span></td>
               <td data-label="Why" data-role="hidden">${esc(r.flag.label)}</td>
               <td data-label="Previous" class="num muted-num" data-role="hidden">${r.prevPoints.toLocaleString()}</td>
               <td data-label="This period" class="num" data-role="metric">${r.points.toLocaleString()}</td>
             </tr>`).join('')}</tbody>
           </table>`
        : '<div class="empty-state"><p>Nobody has fallen off their own pace this period.</p></div>');

  return `
    <div class="card mt-24">
      <div class="card-header">
        <h2>Movers</h2>
        <span class="card-header-hint">vs the ${PREVIOUS_LABEL[period] || 'previous period'}</span>
      </div>
      <div class="card-body">
        <table class="table-responsive">
          <colgroup><col class="col-player"><col class="col-num"><col class="col-num"></colgroup>
          <thead><tr><th>Player</th><th class="num">Points</th><th class="num">Change</th></tr></thead>
          <tbody>${moverRows}</tbody>
        </table>
      </div>
    </div>

    <details class="card card-collapsible" data-section-key="analytics-attention">
      <summary class="card-header"><h2>Needs a look${flagged.length && !blindGap ? ` (${flagged.length})` : ''}</h2></summary>
      <div class="card-body">
        <p class="muted-copy card-note">
          A reason, not a verdict. Members who joined mid-period are excluded — their
          previous window is empty because they weren't here, which is not a drop.
        </p>
        ${attention}
      </div>
    </details>`;
}

// ─── Activity clock ───
// Which hours the clan actually plays. Two-hour columns, because 24 of them in
// a card is a texture and nobody schedules anything to the hour anyway.
const CLOCK_BUCKET_HOURS = 2;

// Below this many timed chests the shading is reading noise as a pattern —
// a handful of chests will always cluster somewhere.
const CLOCK_MIN_CHESTS = 40;

const CLOCK_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * When is this clan actually playing?
 *
 * The one view here no rival tool can produce: everyone else's scan frequency
 * is gated at 30–60 minutes by their pricing, so their timestamps are scan
 * clocks. Ours is the minute the chest was claimed, read off the gift card's
 * countdown.
 *
 * Which means the empty state matters as much as the chart. If the Stage-3
 * calibration crop excludes the "Time left" text, every row falls back to the
 * scan clock, the server's predicate excludes all of them, and this card has
 * nothing to draw — so it says exactly that, and what to do about it, rather
 * than rendering an empty grid that reads as "the clan never plays".
 */
function activityClockCardHtml(current) {
  const clock = current.activityClock;
  if (!clock) return '';

  const { grid, timed, total } = clock;
  const coverage = total > 0 ? Math.round((timed / total) * 100) : 0;

  if (timed < CLOCK_MIN_CHESTS) {
    const why = total === 0
      ? 'No chests in this timeframe yet.'
      : (timed === 0
        ? `None of the ${total.toLocaleString()} chests in this timeframe carry a real earn time, so
           there is nothing to place on a clock. Every one fell back to the scan clock, which
           usually means the calibrated gift-card crop is cutting off the "Time left" countdown —
           re-running Stage 3 of calibration with the countdown inside the rectangle fixes it.`
        : `Only ${timed.toLocaleString()} of ${total.toLocaleString()} chests in this timeframe
           carry a real earn time — too few to read a pattern from without inventing one.`);
    return `
      <div class="card mt-24">
        <div class="card-header"><h2>Activity Clock</h2></div>
        <div class="card-body card-body-padded">
          <div class="empty-state"><p>${why}</p></div>
        </div>
      </div>`;
  }

  const buckets = 24 / CLOCK_BUCKET_HOURS;
  const cells = grid.map((hours) => {
    const out = [];
    for (let b = 0; b < buckets; b += 1) {
      let sum = 0;
      for (let h = b * CLOCK_BUCKET_HOURS; h < (b + 1) * CLOCK_BUCKET_HOURS; h += 1) sum += hours[h];
      out.push(sum);
    }
    return out;
  });

  // Five discrete levels, cut at QUANTILES of the non-zero cells rather than as
  // fractions of the peak.
  //
  // Fractions of the peak do not work for this data: one heavy evening sets the
  // peak and every other cell lands in the bottom band, so the grid reads as a
  // single bright square on a flat field. Quantiles guarantee the busy hours
  // separate from the quiet ones, which is the only thing anyone reads this for.
  const nonZero = cells.flat().filter((v) => v > 0).sort((a, b) => a - b);
  const cut = (q) => (nonZero.length ? nonZero[Math.floor((nonZero.length - 1) * q)] : 0);
  const cuts = [cut(0.25), cut(0.5), cut(0.75)];
  const levelOf = (v) => {
    if (v <= 0) return 0;
    if (v <= cuts[0]) return 1;
    if (v <= cuts[1]) return 2;
    if (v <= cuts[2]) return 3;
    return 4;
  };
  const dayTotals = cells.map((row) => row.reduce((a, b) => a + b, 0));
  const bestDayIdx = dayTotals.indexOf(Math.max(...dayTotals));
  const bandTotals = Array.from({ length: buckets }, (_, b) =>
    cells.reduce((sum, row) => sum + row[b], 0));
  const bestBand = bandTotals.indexOf(Math.max(...bandTotals));
  const bandLabel = (b) => `${String(b * CLOCK_BUCKET_HOURS).padStart(2, '0')}:00`;

  // The game day turns over mid-afternoon UTC, so the busiest band and the
  // busiest game day are not the same question. Drawing the boundary is
  // cheaper than explaining it.
  const rolloverBucket = Math.floor((windowData?.rolloverUtcHour ?? 17) / CLOCK_BUCKET_HOURS);

  const header = Array.from({ length: buckets }, (_, b) =>
    `<span class="clock-col-label${b === rolloverBucket ? ' is-rollover' : ''}">${b % 2 === 0 ? bandLabel(b) : ''}</span>`,
  ).join('');

  const rows = cells.map((row, d) => `
    <div class="clock-row">
      <span class="clock-day-label">${CLOCK_DAYS[d]}</span>
      ${row.map((v, b) => `<span
                  class="clock-cell clock-l${levelOf(v)}${b === rolloverBucket ? ' is-rollover' : ''}"
                  title="${CLOCK_DAYS[d]} ${bandLabel(b)}–${bandLabel(b + 1) === '24:00' ? '24:00' : bandLabel(b + 1)} UTC · ${v.toLocaleString()} chests"></span>`).join('')}
    </div>`).join('');

  return `
    <div class="card mt-24">
      <div class="card-header">
        <h2>Activity Clock</h2>
        <span class="card-header-hint">
          Real earn times, UTC · based on ${coverage}% of this timeframe's chests
        </span>
      </div>
      <div class="card-body card-body-padded">
        <div class="clock-grid">
          <div class="clock-row clock-header"><span class="clock-day-label"></span>${header}</div>
          ${rows}
        </div>
        <p class="muted-copy clock-note">
          Busiest day is <strong>${CLOCK_DAYS[bestDayIdx]}</strong>; the heaviest band is
          <strong>${bandLabel(bestBand)}–${bandLabel(bestBand + 1) === '24:00' ? '24:00' : bandLabel(bestBand + 1)} UTC</strong>.
          The marked column is the ${String(windowData?.rolloverUtcHour ?? 17).padStart(2, '0')}:00 game-day
          rollover — a busy evening either side of it belongs to two different game days.
        </p>
      </div>
    </div>`;
}

function paint() {
  if (!mountedEl) return;
  const el = mountedEl;
  const current = windowData?.current;

  if (!current) {
    el.innerHTML = `${periodControlsHtml()}<div class="card"><div class="card-body"><div class="empty-state"><p>Failed to load analytics.</p></div></div></div>`;
    wire();
    return;
  }

  const mightTotals = staticData?.mightTotals || [];

  el.innerHTML = `
    ${periodControlsHtml()}

    ${statsGridHtml(current)}

    ${mightTotals.length === 1 ? `
    <div class="card">
      <div class="card-header"><h2>Clan Might</h2></div>
      <div class="card-body card-body-padded">
        <div class="empty-state"><p>Not enough might history yet — one more daily snapshot and this becomes a trend.</p></div>
      </div>
    </div>` : ''}
    ${mightTotals.length > 1 ? `
    <div class="card">
      <div class="card-header">
        <h2>Clan Might</h2>
        <span class="card-header-hint">
          Last 90 game days, whatever the timeframe above · <a class="member-link" href="#might">compare members →</a>
        </span>
      </div>
      <div class="card-body card-body-padded">
        <div class="chart-container chart-container--compact"><canvas id="clanMightChart"></canvas></div>
      </div>
    </div>` : ''}

    <div class="two-col-grid">
      <div class="card">
        <div class="card-header">
          <h2>Clan Activity</h2>
          <div class="metric-toggle" role="group" aria-label="Activity metric">
            <button class="btn btn-tight ${activityMetric === 'chests' ? 'active' : ''}" data-ametric="chests">Chests</button>
            <button class="btn btn-tight ${activityMetric === 'points' ? 'active' : ''}" data-ametric="points">Points</button>
          </div>
        </div>
        <div class="card-body card-body-padded">
          <div class="chart-container"><canvas id="clanActivityChart"></canvas></div>
        </div>
      </div>

      ${breakdownCardHtml(current)}
    </div>

    ${contributorsCardHtml(current)}

    ${activityClockCardHtml(current)}

    ${moversCardHtml()}
  `;

  wire();
  // The router calls this after a route change, but a period switch repaints in
  // place and never goes through the router — without this the "Needs a look"
  // section snaps shut every time the timeframe moves.
  restoreDetailsState(el, 'analytics');
  destroyActiveCharts();
  drawAnalyticsCharts();
}

function wire() {
  const el = mountedEl;
  if (!el) return;

  el.querySelectorAll('[data-aperiod]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      period = btn.dataset.aperiod;
      periodOffset = 0;
          syncUrl();
      await reload();
    });
  });

  el.querySelectorAll('[data-aperiod-nav]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      periodOffset += btn.dataset.aperiodNav === 'next' ? -1 : 1;
      if (periodOffset < 0) periodOffset = 0;
          syncUrl();
      await reload();
    });
  });

  // Metric toggle and pagination are both pure re-reads of data already in
  // hand — repaint, never refetch.
  el.querySelectorAll('[data-ametric]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activityMetric = btn.dataset.ametric === 'points' ? 'points' : 'chests';
      paint();
    });
  });

  el.querySelectorAll('[data-csustained]').forEach((btn) => {
    btn.addEventListener('click', () => {
      contributorsSustainedOnly = !contributorsSustainedOnly;
      paint();
    });
  });

  el.querySelectorAll('[data-bdim]').forEach((btn) => {
    btn.addEventListener('click', () => {
      breakdownDim = btn.dataset.bdim;
      // A filter typed against chest names is meaningless against sources, and
      // "show all 200 chests" should not carry over to a list of eight types.
      breakdownFilter = '';
      breakdownShowAll = false;
      paint();
    });
  });

  el.querySelectorAll('[data-bmore]').forEach((btn) => {
    btn.addEventListener('click', () => {
      breakdownShowAll = !breakdownShowAll;
      paint();
    });
  });

  const filterInput = el.querySelector('[data-bfilter]');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      breakdownFilter = filterInput.value;
      paint();
      // paint() replaced the node, so put the caret back where the user left it.
      const next = el.querySelector('[data-bfilter]');
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });
  }
}

// ─── Charts ───

function drawAnalyticsCharts() {
  const current = windowData?.current;
  if (!current) return;

  const t = chartTokens();
  const tickFont = { size: 11 };
  const tooltipStyle = {
    backgroundColor: t.tooltipBg,
    titleColor: t.tooltipText,
    bodyColor: t.tooltipText,
    borderColor: t.tooltipBorder,
    borderWidth: 1,
    cornerRadius: 8,
    padding: 10,
  };

  const mightTotals = staticData?.mightTotals || [];
  const mightCanvas = $('#clanMightChart');
  if (mightCanvas && mightTotals.length > 1) {
    activeCharts.add(new Chart(mightCanvas, {
      type: 'line',
      data: {
        labels: mightTotals.map((d) => d.gameDate),
        datasets: [{
          label: 'Clan might',
          data: mightTotals.map((d) => d.totalMight),
          borderColor: t.accentGold,
          backgroundColor: t.accentGold,
          borderWidth: 2,
          pointRadius: mightTotals.length > 60 ? 0 : 2,
          tension: 0.2,
          fill: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: Object.assign({}, tooltipStyle, {
            callbacks: {
              label: (ctx) => 'Might: ' + ctx.parsed.y.toLocaleString('en-US'),
              // The headcount behind each total: recruiting and levelling both
              // move this line, and only this tells them apart.
              afterBody: (items) => {
                const point = mightTotals[items[0].dataIndex];
                return point ? point.memberCount + ' member(s) counted' : '';
              },
            },
          }),
        },
        scales: {
          x: { ticks: { color: t.tick, font: tickFont, maxRotation: 0, autoSkipPadding: 16 }, grid: { color: t.grid } },
          y: {
            ticks: {
              color: t.tick,
              font: tickFont,
              callback: (v) => {
                if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'B';
                if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(0) + 'M';
                if (Math.abs(v) >= 1e3) return Math.round(v / 1e3) + 'k';
                return v;
              },
            },
            grid: { color: t.grid },
          },
        },
      },
    }));
  }

  // ─── Clan Activity ───
  // One chart, not four. It used to be Chests / Points / Active Members / Avg
  // Chests-per-Member as four cloned single-series bars — and Avg is literally
  // Chests divided by Active Members, so a derived quantity was given the same
  // visual weight as both of its own inputs, three times the width, and no way
  // to see any of them against each other.
  //
  // Now: bars are the metric you picked, a thin muted line on the right axis is
  // how many members were active, and the previous window is a dashed ghost
  // behind it. Avg-per-member is gone as a series — it is the relationship
  // between the bars and the line, which is now visible directly, and it is
  // still a number on the stat strip above.
  const activityCanvas = $('#clanActivityChart');
  const filledDaily = fillDailySeries(current.days || [], current.fromDay, current.toDay);
  if (activityCanvas && filledDaily.length > 0) {
    const prev = windowData?.previous;
    const prevFilled = prev ? fillDailySeries(prev.days || [], prev.fromDay, prev.toDay) : [];

    const currentSeries = bucketSeries(filledDaily);
    const previousSeries = bucketSeries(prevFilled);
    const bucketed = currentSeries.length !== filledDaily.length;

    const metric = activityMetric;
    const metricLabel = metric === 'points' ? 'Points' : 'Chests';
    const barColor = metric === 'points' ? t.barGold : t.barBlue;
    const barHover = metric === 'points' ? t.barGoldHover : t.barBlueHover;

    // Align the ghost by POSITION, not by date — it is "the same slot, one
    // window ago". Equal-length windows normally match exactly; a month
    // boundary can differ by a day or two, so anything past the end is null
    // (Chart.js simply breaks the line) rather than wrapping around.
    const ghost = currentSeries.map((_, i) => {
      const hit = previousSeries[i];
      return hit ? hit[metric] : null;
    });
    // A previous window with nothing in it draws as a flat line along zero,
    // which reads as a collapse rather than as an absence. Don't draw it.
    const showGhost = ghost.some((v) => v !== null && v > 0);

    const datasets = [{
      type: 'bar',
      label: metricLabel,
      data: currentSeries.map((d) => d[metric]),
      backgroundColor: barColor,
      hoverBackgroundColor: barHover,
      borderRadius: 6,
      borderSkipped: false,
      order: 3,
      yAxisID: 'y',
    }];

    if (showGhost) {
      datasets.push({
        type: 'line',
        label: `${metricLabel} · ${PREVIOUS_LABEL[period] || 'previous period'}`,
        data: ghost,
        borderColor: t.tick,
        backgroundColor: t.tick,
        borderWidth: 1.5,
        borderDash: [4, 4],
        pointRadius: 0,
        tension: 0.25,
        fill: false,
        order: 2,
        yAxisID: 'y',
      });
    }

    datasets.push({
      type: 'line',
      label: bucketed ? 'Active members (daily avg)' : 'Active members',
      data: currentSeries.map((d) => d.activeMembers),
      borderColor: t.accentGreen,
      backgroundColor: t.accentGreen,
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.25,
      fill: false,
      order: 1,
      yAxisID: 'y1',
    });

    activeCharts.add(new Chart(activityCanvas, {
      data: { labels: currentSeries.map((d) => d.label), datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: { color: t.tick, boxWidth: 12, boxHeight: 2, font: { size: 11 } },
          },
          tooltip: Object.assign({}, tooltipStyle, {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${Number(ctx.parsed.y).toLocaleString()}`,
            },
          }),
        },
        scales: {
          x: {
            ticks: { color: t.tick, font: tickFont, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 },
            grid: { color: t.grid },
          },
          y: {
            beginAtZero: true,
            ticks: {
              color: t.tick,
              font: tickFont,
              precision: metric === 'points' ? undefined : 0,
              callback: (v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v),
            },
            grid: { color: t.grid },
            title: { display: true, text: metricLabel, color: t.tick, font: { size: 11 } },
          },
          y1: {
            position: 'right',
            beginAtZero: true,
            ticks: { color: t.accentGreen, font: tickFont, precision: 0 },
            // One grid is enough; a second set of lines at different intervals
            // reads as noise over the bars.
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'Active', color: t.accentGreen, font: { size: 11 } },
          },
        },
      },
    }));
  }
}

/**
 * Collapse a daily series into weekly buckets once it is too long to read one
 * bar per day.
 *
 * A yearly window is ~365 bars in a card a few hundred pixels wide, which is a
 * texture rather than a chart. Metrics SUM across the bucket; active members is
 * a daily MEAN, because "distinct members active this week" cannot be recovered
 * from per-day counts — the same person active on three days would be counted
 * three times. The legend says "daily avg" when this fires so the line is never
 * read as a headcount it isn't.
 */
function bucketSeries(series, maxPoints = MAX_ACTIVITY_BARS) {
  if (!Array.isArray(series) || series.length <= maxPoints) return series || [];
  const size = Math.ceil(series.length / maxPoints);
  const out = [];
  for (let i = 0; i < series.length; i += size) {
    const slice = series.slice(i, i + size);
    const activeSum = slice.reduce((a, d) => a + d.activeMembers, 0);
    out.push({
      day: slice[0].day,
      // Name the span, not the first day of it — "Apr 6" on a bar covering a
      // week would be read as that single day.
      label: slice.length > 1 ? `${slice[0].label} – ${slice[slice.length - 1].label}` : slice[0].label,
      chests: slice.reduce((a, d) => a + d.chests, 0),
      points: slice.reduce((a, d) => a + d.points, 0),
      activeMembers: Math.round(activeSum / slice.length),
    });
  }
  return out;
}

/**
 * Expand the server's sparse day rows into a dense, gap-free series.
 *
 * The rollup emits no row for a day nobody earned anything, so plotting the
 * rows as they arrive would silently close the gaps and draw a quiet week as if
 * it were a busy one. A zero here means "no chests"; it does NOT mean the
 * scanner was down, and nothing on this chart claims otherwise.
 *
 * All Time has no bounds to fill between, so it falls back to the tail of the
 * data — one bar per game day since the clan was created is not a chart.
 */
function fillDailySeries(days, fromDay, toDay) {
  const byDay = new Map((Array.isArray(days) ? days : []).map((entry) => [entry.day, entry]));

  let start = fromDay;
  let end = toDay;
  if (!start || !end) {
    const keys = [...byDay.keys()].sort();
    if (keys.length === 0) return [];
    end = keys[keys.length - 1];
    start = keys[Math.max(0, keys.length - ALL_TIME_CHART_DAYS)];
  }

  const series = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime())) return [];

  // Hard stop so a malformed bound can never spin here.
  for (let guard = 0; cursor <= last && guard < 400; guard += 1) {
    const key = formatUtcDateKey(cursor);
    const value = byDay.get(key);
    const chests = value?.chests || 0;
    const activeMembers = value?.activeMembers || 0;
    series.push({
      day: key,
      label: formatGameDayLabel(cursor),
      chests,
      points: value?.points || 0,
      activeMembers,
      avgChestsPerMember: activeMembers > 0 ? Math.round((chests / activeMembers) * 10) / 10 : 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return series;
}

function formatGameDayLabel(date) {
  // UTC-aware so "Apr 9" on the chart means game-day 9, not "whatever Apr 9
  // means in the browser's local time".
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ─── Chest drill-down state ───
// Separate from the page state above: this is the #chest/<name> sub-page, and
// its period selector is its own (a chest's collectors over all time is a
// different question from the clan's week).

// Client-side sort state for the Collectors table. The Rank column always
// reflects the canonical points-desc ranking, whatever the display sort is.
let chestCollectorsSort = { key: 'points', dir: 'desc' };
let cachedChestDetail = null;
let currentChestDrillPeriod = 'all';
let currentChestDrillName = '';

// ─── Chest Drill-Down ───
// Clicking a chest row in the Analytics "All Chest Types" table opens a
// dedicated page listing every member who has collected that chest along
// with a per-member count + points tally and headline stats.

export async function viewChestByName(chestName, navigate) {
  const route = parseHashRoute();
  const periodParam = route.params.get('period');
  if (periodParam && ['daily', 'weekly', 'monthly', 'all'].includes(periodParam)) {
    currentChestDrillPeriod = periodParam;
  } else {
    currentChestDrillPeriod = 'all';
  }
  currentChestDrillName = chestName;

  const expectedHash = chestHash(chestName, currentChestDrillPeriod);
  if (window.location.hash !== expectedHash) {
    window.location.hash = expectedHash;
    return;
  }

  const data = await api(`/chests/by-name/${encodeURIComponent(chestName)}/members?period=${currentChestDrillPeriod}`);
  if (!data || data.error) {
    // The chest name doesn't resolve in the active clan (e.g. a superadmin
    // switched the active clan while sitting on #chest/<name> for a chest
    // that only the previous clan has). Bounce to the main overview rather
    // than dropping the user on analytics with a popup, matching the
    // member, session and resources pages.
    if (typeof navigate === 'function') navigate('dashboard');
    return;
  }
  // The URL may have been a slug; use the canonical name the server
  // resolved so future actions (period switch, row expansion) pass
  // the exact chest_name to downstream endpoints.
  if (data.chestName) currentChestDrillName = data.chestName;
  renderChestDetail(data);
}

export function setChestDrillPeriod(period, navigate) {
  currentChestDrillPeriod = period;
  if (typeof navigate === 'function') {
    navigate(`chest/${encodeURIComponent(currentChestDrillName)}`,
      period === 'all' ? {} : { period });
  }
}

function renderChestDetail(data) {
  cachedChestDetail = data;
  const content = $('#content');
  const period = data.period || 'all';
  const members = data.members || [];
  const hasData = members.length > 0;

  const periodButtons = ['daily', 'weekly', 'monthly', 'all'].map((p) =>
    `<button class="btn ${period === p ? 'active' : ''}" data-action="set-chest-drill-period" data-period="${p}">${p.charAt(0).toUpperCase() + p.slice(1)}</button>`,
  ).join('');

  const chestTypeBadge = data.chestType
    ? `<span class="chest-type ${data.chestType}">${esc(data.chestType)}</span>`
    : '';

  // Stamp every member with its canonical points-desc rank (1-indexed) so
  // the Rank column stays stable even when the user sorts the table by
  // another column. The server already returns members sorted by points.
  const rankedMembers = members.map((m, i) => ({ ...m, _rank: i + 1 }));
  const displayMembers = sortChestCollectors(
    rankedMembers,
    chestCollectorsSort.key,
    chestCollectorsSort.dir,
  );

  // Medal the top 3 collectors directly in the rank column, matching the
  // Discord leaderboard embed treatment. Medals follow the stamped rank,
  // not the display index, so they remain on the actual top-3 scorers
  // after re-sorting.
  const medals = ['🥇', '🥈', '🥉'];
  const formatRank = (rank) => (rank <= 3 ? medals[rank - 1] : `#${rank}`);

  const arrow = (key) => chestCollectorsSort.key === key
    ? (chestCollectorsSort.dir === 'asc' ? ' ▲' : ' ▼')
    : '';

  const chestNameEnc = encodeURIComponent(data.chestName);
  const tableBody = hasData
    ? displayMembers.map((m) => {
        const memberKey = m.memberId !== null && m.memberId !== undefined
          ? String(m.memberId)
          : `name:${m.memberName}`;
        const lastSeenCell = m.lastSeen
          ? `<span title="${esc(formatDate(m.lastSeen))}">${formatRelativeTime(m.lastSeen)}</span>`
          : '-';
        return `<tr class="chest-collector-row"
            data-action="toggle-chest-collector"
            data-member-key="${esc(memberKey)}"
            data-member-id="${m.memberId ?? ''}"
            data-member-name="${esc(m.memberName)}"
            data-chest-name-enc="${chestNameEnc}">
          <td class="chest-collector-caret" data-label="" data-role="hidden"><span class="caret">▸</span></td>
          <td data-label="Rank" data-role="lead">${formatRank(m._rank)}</td>
          <td data-label="Member" data-role="primary"><span class="mrow-name">${memberLink(m.memberId, m.memberName)}</span><span class="mrow-sub">${(m.count || 0).toLocaleString()} chests</span></td>
          <td class="num" data-label="Count" data-role="hidden">${(m.count || 0).toLocaleString()}</td>
          <td class="num" data-label="Points" data-role="metric">${(m.points || 0).toLocaleString()}</td>
          <td class="last-seen-cell" data-label="Last Seen" data-role="hidden">${lastSeenCell}</td>
        </tr>`;
      }).join('')
    : '';

  content.innerHTML = `
    <div class="card">
      <div class="card-header member-detail-header">
        <div class="member-detail-title">
          <h2>${esc(data.chestName)}</h2>
          ${chestTypeBadge}
        </div>
        <button class="btn" data-action="member-back">← Back</button>
      </div>
      <div class="card-body card-body-padded">
        <div class="period-selector mb-12">${periodButtons}</div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="label">Total Collected</div>
            <div class="value">${(data.totalCount || 0).toLocaleString()}</div>
          </div>
          <div class="stat-card">
            <div class="label">Total Points</div>
            <div class="value">${(data.totalPoints || 0).toLocaleString()}</div>
          </div>
          <div class="stat-card">
            <div class="label">Unique Collectors</div>
            <div class="value">${(data.uniqueCollectors || 0).toLocaleString()}</div>
          </div>
          <div class="stat-card">
            <div class="label">Avg per Collector</div>
            <div class="value">${(data.avgPerCollector || 0).toLocaleString()}</div>
          </div>
          <div class="stat-card">
            <div class="label">Points per Chest</div>
            <div class="value">${(data.avgPointsPerChest || 0).toLocaleString()}</div>
          </div>
          <div class="stat-card">
            <div class="label">First Seen</div>
            <div class="value member-detail-date">${data.firstSeen ? formatDateShort(data.firstSeen) : '-'}</div>
            <div class="sub">${data.firstSeen ? formatRelativeTime(data.firstSeen) : ''}</div>
          </div>
          <div class="stat-card">
            <div class="label">Last Seen</div>
            <div class="value member-detail-date">${data.lastSeen ? formatDateShort(data.lastSeen) : '-'}</div>
            <div class="sub">${data.lastSeen ? formatRelativeTime(data.lastSeen) : ''}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>Collectors (${members.length})</h2></div>
      <div class="card-body">
        ${hasData
          ? `<table class="table-responsive chest-collectors-table"><colgroup>
              <col class="col-caret">
              <col class="col-rank">
              <col class="col-member">
              <col class="col-num">
              <col class="col-num">
              <col class="col-last-seen">
            </colgroup><thead><tr><th class="caret-col"></th><th class="sortable" data-action="sort-chest-collectors" data-sort-key="rank">Rank${arrow('rank')}</th><th class="sortable" data-action="sort-chest-collectors" data-sort-key="name">Member${arrow('name')}</th><th class="sortable num" data-action="sort-chest-collectors" data-sort-key="count">Count${arrow('count')}</th><th class="sortable num" data-action="sort-chest-collectors" data-sort-key="points">Points${arrow('points')}</th><th class="sortable" data-action="sort-chest-collectors" data-sort-key="lastSeen">Last Seen${arrow('lastSeen')}</th></tr></thead><tbody>${tableBody}</tbody></table>`
          : '<div class="empty-state"><p>No collectors in this period.</p></div>'}
      </div>
    </div>
  `;
}

function sortChestCollectors(members, key, dir) {
  // Apply direction inline so tied rows return 0 and the stable sort
  // preserves the input order. Reversing afterwards flips equal items.
  const mul = dir === 'desc' ? -1 : 1;
  return [...members].sort((a, b) => {
    let av;
    let bv;
    switch (key) {
      case 'rank':
        av = a._rank;
        bv = b._rank;
        break;
      case 'name':
        av = (a.memberName || '').toLowerCase();
        bv = (b.memberName || '').toLowerCase();
        break;
      case 'count':
        av = a.count || 0;
        bv = b.count || 0;
        break;
      case 'lastSeen':
        av = a.lastSeen || '';
        bv = b.lastSeen || '';
        break;
      case 'points':
      default:
        av = a.points || 0;
        bv = b.points || 0;
        break;
    }
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return 0;
  });
}

export function setChestCollectorsSort(key) {
  if (chestCollectorsSort.key === key) {
    chestCollectorsSort.dir = chestCollectorsSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    chestCollectorsSort.key = key;
    // Name/rank default ascending; all numeric/date columns default descending.
    chestCollectorsSort.dir = (key === 'name' || key === 'rank') ? 'asc' : 'desc';
  }
  // Re-render in place using the cached data so we skip a network round-trip.
  if (cachedChestDetail) renderChestDetail(cachedChestDetail);
}

export async function toggleChestCollectorRow(row) {
  if (!row || !row.parentElement) return;
  const tbody = row.parentElement;
  const memberKey = row.dataset.memberKey || '';
  const memberId = row.dataset.memberId || '';
  const memberName = row.dataset.memberName || '';
  const chestNameEnc = row.dataset.chestNameEnc || '';
  const period = currentChestDrillPeriod || 'all';

  const existing = tbody.querySelector(`tr.chest-collector-details[data-member-key="${cssEscape(memberKey)}"]`);
  const caret = row.querySelector('.caret');
  if (existing) {
    existing.remove();
    row.classList.remove('expanded');
    if (caret) caret.textContent = '▸';
    return;
  }

  // Collapse any other open detail row so only one is expanded at a time.
  tbody.querySelectorAll('tr.chest-collector-details').forEach((el) => el.remove());
  tbody.querySelectorAll('tr.chest-collector-row.expanded').forEach((el) => {
    el.classList.remove('expanded');
    const c = el.querySelector('.caret');
    if (c) c.textContent = '▸';
  });

  row.classList.add('expanded');
  if (caret) caret.textContent = '▾';

  const detailRow = document.createElement('tr');
  detailRow.className = 'chest-collector-details';
  detailRow.dataset.memberKey = memberKey;
  detailRow.innerHTML = `<td colspan="6"><div class="chest-collector-details-inner">Loading history…</div></td>`;
  row.after(detailRow);

  const params = new URLSearchParams({ period });
  if (memberId) {
    params.set('memberId', memberId);
  } else {
    params.set('playerName', memberName);
  }
  const resp = await api(`/chests/by-name/${chestNameEnc}/history?${params.toString()}`);
  const inner = detailRow.querySelector('.chest-collector-details-inner');
  if (!inner) return;
  if (!resp || resp.error) {
    inner.innerHTML = `<div class="empty-state"><p>${esc(resp?.error || 'Failed to load history')}</p></div>`;
    return;
  }
  const records = resp.records || [];
  if (records.length === 0) {
    inner.innerHTML = '<div class="empty-state"><p>No records in this period.</p></div>';
    return;
  }

  const rowsHtml = records.map((r) => `<tr>
    <td class="history-date" title="${esc(formatDate(r.effectiveAt))}">${esc(formatDate(r.effectiveAt))}</td>
    <td><span class="chest-type ${esc(r.chestType)}">${esc(r.chestType || '-')}</span></td>
    <td>${esc(r.chestSource || '-')}</td>
    <td class="num">${(r.quantity || 0).toLocaleString()}</td>
    <td class="num">${(r.pointValue || 0).toLocaleString()}</td>
  </tr>`).join('');

  inner.innerHTML = `
    <div class="chest-history-header">${records.length} record${records.length === 1 ? '' : 's'} for ${esc(memberName)}</div>
    <table class="chest-history-table">
      <thead><tr><th>Received</th><th>Level</th><th>Source</th><th class="num">Qty</th><th class="num">Points</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}
