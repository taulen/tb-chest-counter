// The ← [label] → strip that sits under a period selector.
//
// This existed four times — leaderboard-render.js, events.js,
// resources-overview.js and resources-totals.js — and the copies had already
// drifted apart in ways nobody chose: leaderboard-render dropped the whole row
// on "all", events and resources-totals kept it and disabled both arrows,
// resources-overview guarded neither. Same control, three behaviours.
//
// The differences that are real are parameters here; everything else is now
// shared. Callers pass their own button attributes verbatim (`prevAttr` /
// `nextAttr`), so each page keeps the exact data-* hooks its click handler
// already listens for and no wiring moves.
//
// NOTE: this file is reachable from the public share page through
// leaderboard-render.js, so it MUST stay listed in PUBLIC_SHARE_ASSETS
// (src/web/public-share-assets.ts). tests/config/public-share-assets.test.ts
// walks the import graph and fails the build if it isn't.

import { esc } from './ui.js';
import { formatPeriodLabel } from './period.js';

/**
 * @param {object} opts
 * @param {string} opts.period      'daily' | 'weekly' | 'monthly' | 'yearly' | 'all'
 * @param {number} opts.offset      0 = current window, 1 = previous, …
 * @param {number} [opts.rolloverHr] Game-day rollover hour; omitted falls back
 *   to the server-reported value via lib/state.js, which is what every caller
 *   except the leaderboard already relied on.
 * @param {string} opts.prevAttr    Attribute text for the ← button, e.g.
 *   `data-action="leaderboard-period-prev"` or `data-tperiod-nav="prev"`.
 * @param {string} opts.nextAttr    Attribute text for the → button.
 * @param {boolean} [opts.hideOnAll] Render nothing at all on "all" instead of
 *   showing the row with both arrows disabled.
 * @param {string} [opts.navClass]  Extra class(es) on the .period-nav wrapper.
 * @param {string} [opts.title]     Noun for the button tooltips ("period", or
 *   the period name itself as the leaderboard does).
 * @param {string} [opts.allLabel]  Label shown on "all" when not hidden.
 * @returns {string} HTML
 */
export function renderPeriodNav({
  period,
  offset = 0,
  rolloverHr,
  prevAttr = '',
  nextAttr = '',
  hideOnAll = false,
  navClass = '',
  title = 'period',
  allLabel = 'All time',
}) {
  const isAll = period === 'all';
  if (isAll && hideOnAll) return '';

  // formatPeriodLabel returns 'All Time' for 'all', but the two callers that
  // render the row on "all" both spelled it 'All time'. Keep their casing —
  // this is a rename nobody asked for otherwise.
  const label = isAll ? allLabel : formatPeriodLabel(period, offset, rolloverHr);
  const cls = navClass ? `period-nav ${navClass}` : 'period-nav';

  return `<div class="${cls}">
      <button class="btn btn-tight" ${prevAttr} ${isAll ? 'disabled' : ''} title="Previous ${esc(title)}">←</button>
      <span class="period-nav-label">${esc(label)}</span>
      <button class="btn btn-tight" ${nextAttr} ${isAll || offset <= 0 ? 'disabled' : ''} title="Next ${esc(title)}">→</button>
    </div>`;
}
