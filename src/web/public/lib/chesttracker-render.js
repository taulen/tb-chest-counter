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
import { t, tn, tGame } from './i18n.js';

// ─── Helpers ────────────────────────────────────────────────────────

// Compact column labels. Long category names ("union of triumph",
// "heroic monster") wrap or force horizontal scroll; these shortened
// forms fit ~15 columns on a 1080p-ish browser without losing meaning
// in context. Headers get a title attribute so hovering still shows
// the full name. Any category not in the map falls back to title-case.
const CATEGORY_SHORT = {
  'common crypt': t('Common'),
  'rare crypt': t('Rare'),
  'epic crypt': t('Epic'),
  'elven citadel': t('Elven'),
  'cursed citadel': t('Cursed'),
  'heroic monster': t('Heroic'),
  'epic squad': t('Squad'),
  'union of triumph': t('Triumph'),
  'ragnarok shop': tGame('Ragnarok'),
  'hermes store': tGame('Hermes'),
  'tartaros crypt': tGame('Tartaros'),
  'dark omens': t('Omens'),
  'seasonal store': t('Season'),
  'tournament': t('Tourn.'),
};

export function prettyCategory(key) {
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function shortCategory(key) {
  return CATEGORY_SHORT[key] || tGame(prettyCategory(key));
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

// The words behind the cell colours — same idea, and the same glyphs, as the
// leaderboard's goal cells (goalCellContentHtml in leaderboard-render.js), but
// this tab keeps chesttracker.com's own 50% amber threshold.
const STATUS_TEXT = {
  'ext-cell-ok': { glyph: '✓', label: t('target reached') },
  'ext-cell-warn': { glyph: '◐', label: t('at least half the target') },
  'ext-cell-low': { glyph: '↓', label: t('below half the target') },
};

/** Glyph + value + spoken status for a target-coloured cell; just the value with no target. */
export function statusCellHtml(actual, target, formatted = String(actual)) {
  const s = STATUS_TEXT[statusClassFor(actual, target)];
  if (!s) return formatted;
  return `<span class="goal-glyph" aria-hidden="true">${s.glyph}</span>${formatted}`
    + `<span class="visually-hidden">, ${s.label}</span>`;
}

// Compact delta badge rendered inline to the right of its headline
// number. "vs last week" context moves into a title tooltip so the
// badge itself stays short enough to share the line. Returns a muted
// em-dash when we don't have a prior-week snapshot yet.
export function renderDelta(current, previous, opts = {}) {
  const showPct = opts.showPct !== false;
  if (previous == null) {
    return `<span class="ext-meta-delta ext-meta-delta-none" title="${t('No prior-week snapshot to compare against')}">—</span>`;
  }
  const diff = current - previous;
  if (diff === 0) {
    return `<span class="ext-meta-delta ext-meta-delta-flat" title="${t('No change vs last week')}">±0</span>`;
  }
  const arrow = diff > 0 ? '▲' : '▼';
  const cls = diff > 0 ? 'ext-meta-delta-up' : 'ext-meta-delta-down';
  const signed = (diff > 0 ? '+' : '') + diff.toLocaleString();
  const pct = showPct && previous !== 0
    ? ` ${diff > 0 ? '+' : ''}${Math.round((diff / previous) * 100)}%`
    : '';
  const title = t('{change} vs last week (was {previous})', { change: `${signed}${pct}`, previous: previous.toLocaleString() });
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
  if (diffSec < 30) return t('just now');
  if (diffSec < 60) return t('<1m ago');
  const totalMin = Math.round(diffSec / 60);
  if (totalMin < 60) return tn(totalMin, '{n}m ago', '{n}m ago');
  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin - totalHr * 60;
  if (totalHr < 24) {
    return remMin > 0 ? t('{h}h {m}m ago', { h: totalHr, m: remMin }) : tn(totalHr, '{n}h ago', '{n}h ago');
  }
  const totalDay = Math.floor(totalHr / 24);
  const remHr = totalHr - totalDay * 24;
  if (totalDay < 7) {
    return remHr > 0 ? t('{d}d {h}h ago', { d: totalDay, h: remHr }) : tn(totalDay, '{n}d ago', '{n}d ago');
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
    const weeks = c.weeks ? tn(c.weeks, '{n} week', '{n} weeks', { n: c.weeks }) : t('no data yet');
    const kingdom = c.kingdom != null ? ` · K${c.kingdom}` : '';
    const label = c.isCurrent
      ? t('{code} — current ({weeks}{kingdom})', { code: c.shareCode, weeks, kingdom })
      : t('{code} — archived ({weeks}{kingdom})', { code: c.shareCode, weeks, kingdom });
    const sel = c.shareCode === selected ? ' selected' : '';
    return `<option value="${esc(c.shareCode)}"${sel}>${esc(label)}</option>`;
  }).join('');
  return `<label class="ext-archive-picker">
    <span class="ext-archive-picker-label">${t('Tracker')}</span>
    <select class="input ext-archive-select" data-action="ext-select-share-code" title="${t('Switch between this clan\'s ChestTracker codes. Older codes are kept and stay browsable.')}">${options}</select>
  </label>`;
}

export function renderArchivedNotice(codeInfo) {
  if (!codeInfo) return '';
  const viewing = codeInfo.firstWindow && codeInfo.lastWindow
    ? t('Viewing an <strong>archived</strong> tracker (<code>{code}</code>) covering {from} → {to}.', {
      code: esc(codeInfo.shareCode),
      from: esc(formatDate(codeInfo.firstWindow)),
      to: esc(formatDate(codeInfo.lastWindow)),
    })
    : t('Viewing an <strong>archived</strong> tracker (<code>{code}</code>).', { code: esc(codeInfo.shareCode) });
  return `<div class="ext-archive-notice">
    ${viewing}
    ${t('This clan now polls a different share code — switch back with the Tracker picker above.')}
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
      <div class="empty-state"><p>${t('No snapshot available yet.')}</p></div>
    </div></div>`;
  }

  const targets = extractTargets(detail.settings);
  const categoryKeys = collectCategoryKeys(detail.players);

  const fixedHeaders = [
    { label: t('Player'), full: t('Player') },
    { label: t('G'), full: t('Guards level') },
    { label: t('Points'), full: t('Points') },
    { label: t('Chests'), full: t('Total chests') },
  ];
  const categoryHeaders = categoryKeys.map((k) => ({ label: shortCategory(k), full: tGame(prettyCategory(k)) }));
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
    // The phone summary line repeats the chests status: the Chests column itself
    // is hidden on phones, which used to drop that status entirely.
    const chestsStatus = (v) => (targets ? statusCellHtml(v, targets.chests, String(v)) : String(v));
    const cells = [
      `<td data-label="${t('Player')}" data-role="primary"><span class="mrow-name">${esc(p.playerName)}</span><span class="mrow-sub">${tn(chests, '{n} chest', '{n} chests', { n: chestsStatus(chests) })} · ${tn(ancients, '{n} ancient', '{n} ancients', { n: ancients })}</span></td>`,
      `<td data-label="${t('G')}" data-role="lead">${t('G{level}', { level: p.guardsLevel })}</td>`,
      `<td data-label="${t('Points')}" class="${pointsCls}" data-role="metric">${targets ? statusCellHtml(points, targets.points, points.toLocaleString()) : points.toLocaleString()}</td>`,
      `<td data-label="${t('Chests')}" class="${chestsCls}" data-role="hidden">${chestsStatus(chests)}</td>`,
      ...categoryKeys.map((k) => {
        const v = p.categories?.[k] || 0;
        const cls = k === 'ancients' ? ancientsCls : '';
        const html = k === 'ancients' && targets ? statusCellHtml(v, targets.ancients) : v;
        return `<td data-label="${esc(shortCategory(k))}" class="${cls}">${html}</td>`;
      }),
    ];
    return `<tr>${cells.join('')}</tr>`;
  }).join('');

  const targetsValue = targets
    ? ([
        targets.points != null ? t('{n} pts', { n: targets.points.toLocaleString() }) : null,
        targets.chests != null ? tn(targets.chests, '{n} chest', '{n} chests', { n: targets.chests }) : null,
        targets.ancients != null ? tn(targets.ancients, '{n} ancient', '{n} ancients', { n: targets.ancients }) : null,
      ].filter(Boolean).join(' · ') || t('none defined'))
    : t('Not available');

  const ctLastScanned = detail.settings?.lastScannedAt || null;
  const prev = detail.previousWeek || null;
  const playerDelta = renderDelta(detail.playerCount, prev ? prev.playerCount : null, { showPct: false });
  const chestsDelta = renderDelta(detail.totalChests, prev ? prev.totalChests : null);
  const pointsDelta = renderDelta(detail.totalPoints, prev ? prev.totalPoints : null);

  const lastCheckedTooltip = lastCheckedAt
    ? t('{date} · includes 304 polls (no new data)', { date: formatDate(lastCheckedAt) })
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
          <div class="ext-meta-label">${t('We fetched')}</div>
          <div class="ext-meta-value" title="${esc(fetchedAtTooltip || formatDate(detail.fetchedAt))}">${esc(formatTimeAgo(detail.fetchedAt))}</div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">${t('Last checked')}</div>
          <div class="ext-meta-value" title="${esc(lastCheckedTooltip)}">${lastCheckedAt ? esc(formatTimeAgo(lastCheckedAt)) : '—'}</div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">${t('ChestTracker scanned')}</div>
          <div class="ext-meta-value" title="${ctLastScanned ? esc(formatDate(ctLastScanned)) : ''}">${ctLastScanned ? esc(formatTimeAgo(ctLastScanned)) : '—'}</div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">${t('Week window')}</div>
          <div class="ext-meta-value">${formatDate(detail.windowStart)} → ${formatDate(detail.windowEnd)}</div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">${t('Players')}</div>
          <div class="ext-meta-value-row">
            <span class="ext-meta-value ext-meta-value-accent">${detail.playerCount}</span>
            ${playerDelta}
          </div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">${t('Chests')}</div>
          <div class="ext-meta-value-row">
            <span class="ext-meta-value ext-meta-value-accent">${detail.totalChests.toLocaleString()}</span>
            ${chestsDelta}
          </div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">${t('Points')}</div>
          <div class="ext-meta-value-row">
            <span class="ext-meta-value ext-meta-value-accent">${detail.totalPoints.toLocaleString()}</span>
            ${pointsDelta}
          </div>
        </div>
        <div class="ext-meta-item">
          <div class="ext-meta-label">${t('Targets')}</div>
          <div class="ext-meta-value">${esc(targetsValue)}</div>
        </div>
      </div>
    </div>
    ${detail.players.length > 0
      ? `<table class="table-responsive ext-detail-table"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`
      : `<div class="empty-state"><p>${t('Snapshot has no players.')}</p></div>`}
  </div></div>`;
}
