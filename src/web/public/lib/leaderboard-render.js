// Single source of truth for leaderboard rendering. Used by both the
// authenticated /#leaderboard page and the public-share page so the
// two stay in lockstep — same column structure, same sort behaviour,
// same period selector, same pagination. Caller passes in:
//
//  - the data (already paginated)
//  - a `playerCellHtml(entry)` callback so the auth page can render
//    clickable member links while the public page renders plain text
//  - an `actions` map of data-action attribute strings so each page
//    can route clicks to its own event handler without colliding
//
// Keep this file framework-free — it's plain HTML strings so the public
// page (no router, no shared state machine) can use it as easily as the
// auth page.

import { esc } from './ui.js';
import { renderPeriodNav } from './period-nav.js';

// Column-header hint for the two ranked metrics. The board leaves out
// end-of-event clan rewards — the placement prize the game drops on one
// account for the whole clan (1006 chests at once, on the 2026-08-24 Olympus
// close) — so a leader isn't ranked above the clan's actual best farmer for
// receiving it. Clan totals elsewhere still include them.
const EARNED_ONLY_HINT =
  'Chests the member collected themselves. Excludes end-of-event clan rewards, '
  + "which the game hands to one account for the whole clan's placement.";

/**
 * Stable sort by the selected key + direction. Ties always return 0
 * so the *input* order is preserved — callers should pre-order rows by
 * the canonical (server-side) tiebreak (points DESC, chests DESC, name
 * ASC) before calling. Using `mul` inline rather than reversing
 * afterwards is critical: `.reverse()` flips equal items and scrambles
 * the displayed ranks (#13 above #12).
 */
export function sortLeaderboardEntries(entries, key, dir) {
  const mul = dir === 'desc' ? -1 : 1;
  return [...entries].sort((a, b) => {
    let av;
    let bv;
    switch (key) {
      case 'rank':
        av = a.rank;
        bv = b.rank;
        break;
      case 'name':
        av = (a.memberName || '').toLowerCase();
        bv = (b.memberName || '').toLowerCase();
        break;
      case 'chests':
        av = a.totalChests;
        bv = b.totalChests;
        break;
      case 'level':
        av = a.heroLevel;
        bv = b.heroLevel;
        break;
      case 'might':
        av = a.might;
        bv = b.might;
        break;
      case 'points':
      default:
        av = a.totalPoints;
        bv = b.totalPoints;
        break;
    }
    // Might and hero level are null for anyone the daily snapshot has never
    // read. Those rows sink to the bottom in BOTH directions rather than
    // riding the multiplier: ascending "lowest might first" should open with
    // the smallest real reading, not with a block of members who have no
    // reading at all. Nulls keep their input order relative to each other.
    const aNull = av === null || av === undefined;
    const bNull = bv === null || bv === undefined;
    if (aNull || bNull) {
      if (aNull && bNull) return 0;
      return aNull ? 1 : -1;
    }
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return 0;
  });
}

// ─── Points goal ──────────────────────────────────────────────
//
// A clan stores ONE number — the weekly points target — and every other
// timeframe is derived from it here, so the daily / weekly / monthly views can
// never state goals that contradict each other. The scale is a flat daily rate
// (goal / 7) multiplied by the length of the period, which is what makes
// "am I on pace?" mean the same thing whichever tab you are looking at.
//
// 'all' gets no goal at all: an all-time window has no length to scale by, so
// any number we painted against it would be arbitrary.
const GOAL_DAYS_PER_PERIOD = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  yearly: 365,
};

/**
 * The points target for one member over `period`, given the clan's weekly goal.
 * Returns null when there is no goal, or when the period has no defined length.
 * Rounded to a whole point — a target of "3571.43" is noise on a scoreboard
 * that only ever shows integers.
 */
export function scaleGoalForPeriod(weeklyGoalPoints, period) {
  if (!Number.isFinite(weeklyGoalPoints) || weeklyGoalPoints <= 0) return null;
  const days = GOAL_DAYS_PER_PERIOD[period];
  if (!days) return null;
  return Math.round((weeklyGoalPoints / 7) * days);
}

// Green at the goal, amber from two-thirds of it, red below. Deliberately NOT
// the 50% threshold statusClassFor() uses for the ChestTracker tab — that one
// mirrors chesttracker.com's own colouring and has to keep matching their SPA,
// while this one is the clan's own standard.
const GOAL_WARN_RATIO = 0.66;

/** How the goal line names the active timeframe. */
const GOAL_PERIOD_NOUN = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

/**
 * The lowest whole points value that earns amber — i.e. the first integer n
 * with n / goal >= GOAL_WARN_RATIO.
 *
 * Math.CEIL, not round. goalStatusClassFor compares the unrounded ratio, so
 * rounding to nearest names a number one point too low for roughly half of all
 * goals: with a daily goal of 1,073 the rounded figure is 708, but 708/1073 =
 * 0.6598 and that member's cell is painted RED — the caption contradicting the
 * row directly beneath it. Exported so the Clans-tab preview quotes the same
 * function rather than re-deriving it.
 */
export function goalWarnThreshold(goalPoints) {
  if (!Number.isFinite(goalPoints) || goalPoints <= 0) return null;
  return Math.ceil(goalPoints * GOAL_WARN_RATIO);
}

/**
 * Which of the three status buckets a member's points fall in, or '' when the
 * clan has no goal — so an unconfigured leaderboard carries no status marker
 * at all for the stylesheet to key on, rather than a class that paints nothing.
 */
function goalStatusFor(actualPoints, goalPoints) {
  if (!Number.isFinite(goalPoints) || goalPoints <= 0) return '';
  const pct = (actualPoints || 0) / goalPoints;
  if (pct >= 1) return 'ok';
  if (pct >= GOAL_WARN_RATIO) return 'warn';
  return 'low';
}

/** Status class for the Points cell (the stronger tint + matched text colour). */
export function goalStatusClassFor(actualPoints, goalPoints) {
  const status = goalStatusFor(actualPoints, goalPoints);
  return status ? `goal-cell-${status}` : '';
}

/**
 * Status class for the whole ROW — the same bucket, washed across every column
 * so rank and player name carry the signal too, not just the one number that
 * produced it.
 */
export function goalRowClassFor(actualPoints, goalPoints) {
  const status = goalStatusFor(actualPoints, goalPoints);
  return status ? `goal-row-${status}` : '';
}

/**
 * Compact might, for a column narrow enough to sit beside four others:
 * 1.2B / 340M / 12M / 850k. Mirrors the Might page's axis-tick formatter — the
 * exact digits live on the Might page and on hover here (title attribute), so
 * this only has to stay readable and monotonic.
 */
export function formatMightCompact(n) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

const PERIODS = ['daily', 'weekly', 'monthly', 'yearly', 'all'];

/**
 * Render the full leaderboard card (header with period selector +
 * period-nav arrows, table, pagination). All state is passed in — this
 * function is pure.
 *
 * `title` and `countLabel` parametrize the card so the Triumphal Chests
 * page can reuse the exact same layout, period selector, sort UX, and
 * pagination by passing different strings ("Triumphal Chests" / "Triumphals")
 * — the auth and public Leaderboards keep their defaults.
 *
 * Two optional decorations, both off by default so the Triumphal page is
 * untouched by either:
 *
 *  - `showMight` adds the Level + Might columns. The caller decides that from
 *    the WHOLE result set rather than the current page, so the table doesn't
 *    gain and lose two columns as you page through a clan whose newest members
 *    have no snapshot yet.
 *  - `goalWeeklyPoints` colours the Points cell against the clan's target for
 *    the selected period, and prints that target above the table.
 */
export function renderLeaderboardCardHtml({
  title = 'Leaderboard',
  countLabel = 'Chests',
  pageEntries,
  totalEntries,
  currentPage,
  totalPages,
  period,
  offset,
  sortState,
  rolloverHr,
  pageSize,
  playerCellHtml,
  actions,
  showMight = false,
  goalWeeklyPoints = null,
  // Optional: when present, a download link for the window on screen. The
  // public share page does not pass one — that endpoint answers to an
  // unauthenticated token, and a whole-roster download is a different thing
  // from a leaderboard someone can read.
  exportHref = null,
}) {
  const periodGoal = scaleGoalForPeriod(goalWeeklyPoints, period);
  const arrow = (key) => sortState.key === key
    ? (sortState.dir === 'asc' ? ' ▲' : ' ▼')
    : '';

  const periodNavRow = renderPeriodNav({
    period,
    offset,
    rolloverHr,
    prevAttr: `data-action="${actions.periodPrev}"`,
    nextAttr: `data-action="${actions.periodNext}"`,
    hideOnAll: true,
    title: period,
  });

  const paginationControls = totalEntries > pageSize
    ? `<div class="pagination">
        <button class="btn btn-tight" data-action="${actions.pagePrev}" ${currentPage <= 1 ? 'disabled' : ''}>← Prev</button>
        <span class="pagination-info">Page ${currentPage} of ${totalPages} · ${totalEntries} players</span>
        <button class="btn btn-tight" data-action="${actions.pageNext}" ${currentPage >= totalPages ? 'disabled' : ''}>Next →</button>
      </div>`
    : '';

  const exportLink = exportHref
    ? `<a class="btn btn-tight leaderboard-export" href="${exportHref}" download
         title="Download this timeframe as CSV">Export CSV</a>`
    : '';

  const periodSelector = PERIODS.map((p) =>
    `<button class="btn ${period === p ? 'active' : ''}" data-action="${actions.setPeriod}" data-period="${p}">${p.charAt(0).toUpperCase() + p.slice(1)}</button>`,
  ).join('');

  // Level and Might carry NO data-role on purpose: under 640px the compact-row
  // engine reveals unmarked cells in the tap-to-expand panel, which is where
  // two secondary numbers belong on a phone. Rank/Player/Points keep their
  // lead/primary/metric roles, so the collapsed row looks exactly as it did.
  const mightHeadHtml = showMight
    ? `<th class="sortable num" data-action="${actions.sort}" data-sort-key="level" title="Hero level at the latest daily snapshot">Level${arrow('level')}</th>
        <th class="sortable num" data-action="${actions.sort}" data-sort-key="might" title="Might at the latest daily snapshot">Might${arrow('might')}</th>`
    : '';

  const mightCellsHtml = (e) => showMight
    ? `<td data-label="Level" class="num">${e.heroLevel == null ? '—' : e.heroLevel.toLocaleString()}</td>
        <td data-label="Might" class="num"${e.might == null ? '' : ` title="${e.might.toLocaleString()}"`}>${formatMightCompact(e.might)}</td>`
    : '';

  const tableHtml = pageEntries.length > 0
    ? `<table class="table-responsive leaderboard-table"><colgroup>
        <col class="col-rank">
        <col class="col-player">
        <col class="col-num">
        <col class="col-num">
        ${showMight ? '<col class="col-num col-level"><col class="col-num">' : ''}
      </colgroup><thead><tr>
        <th class="sortable" data-action="${actions.sort}" data-sort-key="rank">Rank${arrow('rank')}</th>
        <th class="sortable" data-action="${actions.sort}" data-sort-key="name">Player${arrow('name')}</th>
        <th class="sortable num" data-action="${actions.sort}" data-sort-key="chests" title="${EARNED_ONLY_HINT}">${esc(countLabel)}${arrow('chests')}</th>
        <th class="sortable num" data-action="${actions.sort}" data-sort-key="points" title="${EARNED_ONLY_HINT}">Points${arrow('points')}</th>
        ${mightHeadHtml}
      </tr></thead><tbody>
      ${pageEntries.map((e) => `<tr class="${goalRowClassFor(e.totalPoints, periodGoal)}">
        <td data-label="Rank" data-role="lead"><span class="rank rank-${e.rank}">#${e.rank}</span></td>
        <td data-label="Player" data-role="primary"><span class="mrow-name">${playerCellHtml(e)}</span><span class="mrow-sub">${e.totalChests.toLocaleString()} ${esc(countLabel.toLowerCase())}</span></td>
        <td data-label="${esc(countLabel)}" class="num" data-role="hidden">${e.totalChests.toLocaleString()}</td>
        <td data-label="Points" class="num ${goalStatusClassFor(e.totalPoints, periodGoal)}" data-role="metric">${e.totalPoints.toLocaleString()}</td>
        ${mightCellsHtml(e)}
      </tr>`).join('')}
    </tbody></table>`
    : '<div class="empty-state"><p>No data.</p></div>';

  // Small line above the table naming the target this view is judged against.
  // It states which timeframe it is and, when the number was derived rather
  // than typed in, where it came from — otherwise a daily figure of 3,571 sat
  // next to a weekly goal of 25,000 reads as two unrelated numbers.
  const goalHintHtml = periodGoal !== null
    ? `<div class="leaderboard-goal-hint">
        <span class="goal-hint-swatch" aria-hidden="true"></span>
        <span>${esc(GOAL_PERIOD_NOUN[period] || '')} goal: <strong>${periodGoal.toLocaleString()}</strong> points${period === 'weekly' ? '' : ` <span class="goal-hint-src">(from ${goalWeeklyPoints.toLocaleString()} / week)</span>`}</span>
        <span class="goal-hint-src">amber from ${goalWarnThreshold(periodGoal).toLocaleString()}</span>
      </div>`
    : '';

  return `<div class="card">
    <div class="card-header leaderboard-header">
      <div class="leaderboard-title-row"><h2>${esc(title)}</h2></div>
      <div class="leaderboard-controls">
        <div class="period-selector">${periodSelector}</div>
        ${periodNavRow}
        ${exportLink}
      </div>
    </div>
    <div class="card-body">
      ${goalHintHtml}
      ${tableHtml}
      ${paginationControls}
    </div>
  </div>`;
}
