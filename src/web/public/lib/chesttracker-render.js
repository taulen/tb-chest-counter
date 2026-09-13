// Single source of truth for the ChestTracker snapshot-detail card.
// Used by both the authenticated /#external page and the public-share
// page so the two stay in lockstep — same headers, same coloured
// targets, same week-over-week deltas. The auth page wraps this in a
// snapshot picker + ingest-status accordion; the public page just
// shows the latest snapshot.
//
// Caller passes in:
//  - the snapshot detail (already loaded)
//  - the current share code (used in the title)
//  - context for the meta strip ("we fetched" tooltip and the
//    "last checked" timestamp + tooltip) — both flavors of the page
//    have slightly different sources for these (loop.lastSuccessAt vs
//    a getLatestPollAt() probe), so the caller wires them in.

import { esc, formatDate } from './ui.js';

// ─── Helpers ────────────────────────────────────────────────────────

// Compact column labels. Long category names ("union of triumph",
// "heroic monster") wrap or force horizontal scroll; these shortened
// forms fit ~15 columns on a 1080p-ish browser without losing meaning
// in context. Headers get a title attribute so hovering still shows
// the full name. Any category not in the map falls back to title-case.
const CATEGORY_SHORT = {
  'common crypt': 'Common',
  'rare crypt': 'Rare',
  'epic crypt': 'Epic',
  'elven citadel': 'Elven',
  'cursed citadel': 'Cursed',
  'heroic monster': 'Heroic',
  'epic squad': 'Squad',
  'union of triumph': 'Triumph',
  'ragnarok shop': 'Ragnarok',
  'hermes store': 'Hermes',
  'tartaros crypt': 'Tartaros',
  'dark omens': 'Omens',
  'seasonal store': 'Season',
  'tournament': 'Tourn.',
};

export function prettyCategory(key) {
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function shortCategory(key) {
  return CATEGORY_SHORT[key] || prettyCategory(key);
}

export function collectCategoryKeys(players) {
  const seen = new Set();
  for (const p of players) {
    for (const k of Object.keys(p.categories || {})) seen.add(k);
  }
  const preferred = [
    'common crypt', 'rare crypt', 'epic crypt', 'ancients',
    'elven citadel', 'cursed citadel', 'heroic monster', 'epic squad',
    'store', 'tournament', 'union of triumph',
  ];
  const out = [];
  for (const p of preferred) if (seen.has(p)) { out.push(p); seen.delete(p); }
  return [...out, ...Array.from(seen).sort()];
}

// Chesttracker's SPA only shows target-met status (green/yellow/red)
// for three columns. We mirror that: Points, Chests overall, and
// Ancients (mapped to the "riseoftheancientsevent" requirement key).
const REQUIREMENT_KEYS = {
  points: 'points',
  chests: 'chests',
  ancients: 'riseoftheancientsevent',
};

export function extractTargets(detailSettings) {
  // detail.settings is the raw /settings payload: { settings: { requirement: [...] }, schedule: {...} }
  // The requirement array is indexed per guards-level bucket on their
  // site; in practice most clans define a single entry that applies
  // across the board, so we read index 0 as the default.
  const req = detailSettings?.settings?.requirement?.[0];
  if (!req || typeof req !== 'object') return null;
  const parse = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    points: parse(req[REQUIREMENT_KEYS.points]),
    chests: parse(req[REQUIREMENT_KEYS.chests]),
    ancients: parse(req[REQUIREMENT_KEYS.ancients]),
  };
}

// Thresholds match what chesttracker.com appears to use on their SPA
// (verified against the reference screenshot: 4/13 red, 8/13 yellow,
// 13+ green).
export function statusClassFor(actual, target) {
  if (target == null || target <= 0) return '';
  const pct = actual / target;
  if (pct >= 1) return 'ext-cell-ok';
  if (pct >= 0.5) return 'ext-cell-warn';
  return 'ext-cell-low';
}

// Compact delta badge rendered inline to the right of its headline
// number. "vs last week" context moves into a title tooltip so the
// badge itself stays short enough to share the line. Returns a muted
// em-dash when we don't have a prior-week snapshot yet.
export function renderDelta(current, previous, opts = {}) {
  const showPct = opts.showPct !== false;
  if (previous == null) {
    return '<span class="ext-meta-delta ext-meta-delta-none" title="No prior-week snapshot to compare against">—</span>';
  }
  const diff = current - previous;
  if (diff === 0) {
    return '<span class="ext-meta-delta ext-meta-delta-flat" title="No change vs last week">±0</span>';
  }
  const arrow = diff > 0 ? '▲' : '▼';
  const cls = diff > 0 ? 'ext-meta-delta-up' : 'ext-meta-delta-down';
  const signed = (diff > 0 ? '+' : '') + diff.toLocaleString();
  const pct = showPct && previous !== 0
    ? ` ${diff > 0 ? '+' : ''}${Math.round((diff / previous) * 100)}%`
    : '';
  const title = `${signed}${pct} vs last week (was ${previous.toLocaleString()})`;
  return `<span class="ext-meta-delta ${cls}" title="${title}">${arrow} ${signed}${pct}</span>`;
}

// Like ui.js's formatRelativeTime but keeps hours + minutes together
// ("2h 50m ago") instead of rounding down to the coarser bucket. Good
// for at-a-glance "how fresh is this?" reads in the meta strip.
export function formatTimeAgo(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (!Number.isFinite(diffSec)) return '—';
  if (diffSec < 30) return 'just now';
  if (diffSec < 60) return '<1m ago';
  const totalMin = Math.round(diffSec / 60);
  if (totalMin < 60) return `${totalMin}m ago`;
  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin - totalHr * 60;
  if (totalHr < 24) {
    return remMin > 0 ? `${totalHr}h ${remMin}m ago` : `${totalHr}h ago`;
  }
  const totalDay = Math.floor(totalHr / 24);
  const remHr = totalHr - totalDay * 24;
  if (totalDay < 7) {
    return remHr > 0 ? `${totalDay}d ${remHr}h ago` : `${totalDay}d ago`;
  }
  return formatDate(iso);
}

// ─── Share-code archive picker ──────────────────────────────────────
//
// A clan's ChestTracker code is not permanent — clans merge, re-form, or
// move to a fresh tracker. When that happens the old code's snapshots are
// ARCHIVED, never deleted, and this picker is how you get back to them.
// Rendered only when there's more than one code to choose between, so
// the common single-tracker case looks exactly as it did before.

export function renderShareCodeSelect(codes, selected) {
  if (!Array.isArray(codes) || codes.length < 2) return '';
  const options = codes.map((c) => {
    const weeks = c.weeks ? `${c.weeks} week${c.weeks === 1 ? '' : 's'}` : 'no data yet';
    const kingdom = c.kingdom != null ? ` · K${c.kingdom}` : '';
    const tag = c.isCurrent ? ' — current' : ' — archived';
    const label = `${c.shareCode}${tag} (${weeks}${kingdom})`;
    const sel = c.shareCode === selected ? ' selected' : '';
    return `<option value="${esc(c.shareCode)}"${sel}>${esc(label)}</option>`;
  }).join('');
  return `<label class="ext-archive-picker">
    <span class="ext-archive-picker-label">Tracker</span>
    <select class="input ext-archive-select" data-action="ext-select-share-code" title="Switch between this clan's ChestTracker codes. Older codes are kept and stay browsable.">${options}</select>
  </label>`;
}

export function renderArchivedNotice(codeInfo) {
  if (!codeInfo) return '';
  const range = codeInfo.firstWindow && codeInfo.lastWindow
    ? ` covering ${formatDate(codeInfo.firstWindow)} → ${formatDate(codeInfo.lastWindow)}`
    : '';
  return `<div class="ext-archive-notice">
    Viewing an <strong>archived</strong> tracker (<code>${esc(codeInfo.shareCode)}</code>)${esc(range)}.
    This clan now polls a different share code — switch back with the Tracker picker above.
  </div>`;
}

// ─── Snapshot detail card ───────────────────────────────────────────

/**
 * Render the full snapshot-detail card (header + meta strip + per-player
 * table). Pure HTML string — caller controls placement.
 *
 * Required state:
 *  - detail: snapshot detail (with players, settings, previousWeek, etc.)
 *  - title: the top heading, e.g. `ChestTracker.com data (XQOOZXYGBC)`
 *
 * Meta-strip parameters (auth and public derive these differently):
 *  - fetchedAtTooltip: tooltip string for the "We fetched" pill. The
 *    auth page appends "Next fetch in Xh Ym" when polling is running;
 *    the public page just shows the formatted date.
 *  - lastCheckedAt: ISO string for "Last checked" (or null/undefined)
 *  - weekNav: optional HTML for the prev/next week stepper rendered beside
 *    the title. Auth page passes one in; public-share leaves it '' so its
 *    header is unchanged.
 *  - archiveSelect: optional HTML for the share-code picker (see
 *    renderShareCodeSelect). Only rendered when the clan has used more
 *    than one tracker, so single-code clans see no extra chrome.
 *  - archivedNotice: optional HTML banner shown when the displayed code
 *    is not the clan's live one.
 */
export function renderSnapshotDetailCardHtml({
  detail,
  title,
  fetchedAtTooltip,
  lastCheckedAt,
  weekNav = '',
  archiveSelect = '',
  archivedNotice = '',
}) {
  if (!detail) {
    return `<div class="card"><div class="card-body card-body-padded">
      <div class="ext-detail-titlerow">
        <h2 class="ext-subheader">${title}</h2>
        ${archiveSelect}
      </div>
      ${archivedNotice}
      <div class="empty-state"><p>No snapshot available yet.</p></div>
    </div></div>`;
  }

  const targets = extractTargets(detail.settings);
  const categoryKeys = collectCategoryKeys(detail.players);

  const fixedHeaders = [
    { label: 'Player', full: 'Player' },
    { label: 'G', full: 'Guards level' },
    { label: 'Points', full: 'Points' },
    { label: 'Chests', full: 'Total chests' },
  ];
  const categoryHeaders = categoryKeys.map((k) => ({ label: shortCategory(k), full: prettyCategory(k) }));
  const headHtml = [...fixedHeaders, ...categoryHeaders]
    .map((h) => `<th title="${esc(h.full)}">${esc(h.label)}</th>`)
    .join('');

  const bodyHtml = detail.players.map((p) => {
    const points = p.points || 0;
    const chests = p.chests || 0;
    const ancients = p.categories?.ancients || 0;
    const pointsCls = targets ? statusClassFor(points, targets.points) : '';
    const chestsCls = targets ? statusClassFor(chests, targets.chests) : '';
    const ancientsCls = targets ? statusClassFor(ancients, targets.ancients) : '';

    // Mobile compact-row roles: G is the lead badge, Player the identity
    // (with a chests·ancients summary line), Points the headline metric,
    // and every category column collapses into the tap-to-expand panel.
    const cells = [
      `<td data-label="Player" data-role="primary"><span class="mrow-name">${esc(p.playerName)}</span><span class="mrow-sub">${chests} chests · ${ancients} ancients</span></td>`,
      `<td data-label="G" data-role="lead">G${p.guardsLevel}</td>`,
      `<td data-label="Points" class="${pointsCls}" data-role="metric">${points.toLocaleString()}</td>`,
      `<td data-label="Chests" class="${chestsCls}" data-role="hidden">${chests}</td>`,
      ...categoryKeys.map((k) => {
        const v = p.categories?.[k] || 0;
        const cls = k === 'ancients' ? ancientsCls : '';
        return `<td data-label="${esc(shortCategory(k))}" class="${cls}">${v}</td>`;
      }),
    ];
    return `<tr>${cells.join('')}</tr>`;
  }).join('');

  const targetsValue = targets
    ? ([
        targets.points != null ? `${targets.points.toLocaleString()} pts` : null,
        targets.chests != null ? `${targets.chests} chests` : null,
        targets.ancients != null ? `${targets.ancients} ancients` : null,
      ].filter(Boolean).join(' · ') || 'none defined')
    : 'Not available';

  const ctLastScanned = detail.settings?.lastScannedAt || null;
  const prev = detail.previousWeek || null;
  const playerDelta = renderDelta(detail.playerCount, prev ? prev.playerCount : null, { showPct: false });
  const chestsDelta = renderDelta(detail.totalChests, prev ? prev.totalChests : null);
  const pointsDelta = renderDelta(detail.totalPoints, prev ? prev.totalPoints : null);

  const lastCheckedTooltip = lastCheckedAt
    ? `${formatDate(lastCheckedAt)} · includes 304 polls (no new data)`
    : '';

  return `<div class="card"><div class="card-body card-body-padded">
    <div class="ext-detail-header">
      <div class="ext-detail-titlerow">
        <h2 class="ext-subheader">${title}</h2>
        ${archiveSelect}
        ${weekNav}
      </div>
      ${archivedNotice}
      <div class="ext-meta-strip">
        <div class="ext-meta-item">
          <div class="ext-meta-label">We fetched</div>
          <div class="ext-meta-value" title="${esc(fetchedAtTooltip || formatDate(detail.fetchedAt))}">${esc(formatTimeAgo(detail.fetchedAt))}</div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">Last checked</div>
          <div class="ext-meta-value" title="${esc(lastCheckedTooltip)}">${lastCheckedAt ? esc(formatTimeAgo(lastCheckedAt)) : '—'}</div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">ChestTracker scanned</div>
          <div class="ext-meta-value" title="${ctLastScanned ? esc(formatDate(ctLastScanned)) : ''}">${ctLastScanned ? esc(formatTimeAgo(ctLastScanned)) : '—'}</div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">Week window</div>
          <div class="ext-meta-value">${formatDate(detail.windowStart)} → ${formatDate(detail.windowEnd)}</div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">Players</div>
          <div class="ext-meta-value-row">
            <span class="ext-meta-value ext-meta-value-accent">${detail.playerCount}</span>
            ${playerDelta}
          </div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">Chests</div>
          <div class="ext-meta-value-row">
            <span class="ext-meta-value ext-meta-value-accent">${detail.totalChests.toLocaleString()}</span>
            ${chestsDelta}
          </div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">Points</div>
          <div class="ext-meta-value-row">
            <span class="ext-meta-value ext-meta-value-accent">${detail.totalPoints.toLocaleString()}</span>
            ${pointsDelta}
          </div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">Targets</div>
          <div class="ext-meta-value">${esc(targetsValue)}</div>
        </div>
      </div>
    </div>
    ${detail.players.length > 0
      ? `<table class="table-responsive ext-detail-table"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`
      : '<div class="empty-state"><p>Snapshot has no players.</p></div>'}
  </div></div>`;
}
