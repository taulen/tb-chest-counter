// Shared resource formatting + feature-guard helpers.
//
// Lifted out of pages/resources.js so the Overview dashboard, the Admin
// ledger, and the member-detail resources section all format amounts,
// icons, and direction pills identically. The one non-obvious rule:
// `clan-speedup` amounts are stored in HOURS and render as `Xd Yh`.

import { esc } from './ui.js';
import { api } from './api.js';
import { getCurrentUser } from './state.js';

/**
 * Format a resource amount for display. Speedups are stored in hours and
 * shown as days+hours; everything else is a plain grouped integer.
 */
export function formatResourceAmount(slug, amount) {
  const n = Number(amount) || 0;
  if (slug === 'clan-speedup') {
    const d = Math.floor(n / 24);
    const h = n % 24;
    if (d > 0 && h > 0) return `${d}d ${h}h`;
    if (d > 0) return `${d}d`;
    return `${h}h`;
  }
  return n.toLocaleString();
}

/** A short unit hint for a resource ("hrs" for speedups, else ""). */
export function resourceUnit(slug) {
  return slug === 'clan-speedup' ? 'time' : '';
}

/**
 * Compact amount for dense tables (e.g. the Totals matrix): "12.3M",
 * "1.5K", "450". Speedups keep their `Xd Yh` form (already short). Pair
 * with a title="…" carrying formatResourceAmount() for the exact value.
 */
export function formatResourceCompact(slug, amount) {
  const n = Number(amount) || 0;
  if (slug === 'clan-speedup') return formatResourceAmount(slug, n);
  if (n < 1000) return String(n);
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** Inline icon + name for a resource. `slug` may be null (Unknown). */
export function resourceIconHtml(slug, name) {
  const label = esc(name ?? 'Unknown');
  if (!slug) return label;
  // The name lives in its own span so it can truncate with an ellipsis
  // inside the fixed-width Resource column (long event names like "Torch
  // of Olympus Clan Fragment" would otherwise wrap to two lines). The
  // title carries the full name for hover.
  return `<span class="resource-type-cell"><img src="/assets/resource-icons/${esc(slug)}.png" class="resource-icon-img" alt=""><span class="resource-type-name" title="${label}">${label}</span></span>`;
}

/** Just the icon (no label) — for compact cells/cards. */
export function resourceIconOnly(slug) {
  if (!slug) return '';
  return `<img src="/assets/resource-icons/${esc(slug)}.png" class="resource-icon-img" alt="">`;
}

/**
 * The segmented tab control shown at the top of the Resources pages.
 * `active` is 'overview', 'totals', or 'admin'. Links use hash sub-routes so
 * the browser back button and deep-links work.
 *
 * Overview + Totals are read-only dashboards visible to every clan member; the
 * Admin tab (upload + ledger) is only rendered for admins/superadmins so
 * regular members never see it. The Admin page + API still enforce this
 * server-side — this is just UI hygiene.
 */
export function resourceTabsHtml(active) {
  const tab = (key, hash, label) =>
    `<a class="resources-tab ${active === key ? 'is-active' : ''}" href="${hash}">${label}</a>`;
  const user = getCurrentUser();
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
  return `<div class="resources-tabs" role="tablist">
    ${tab('overview', '#resources', 'Overview')}
    ${tab('totals', '#resources/totals', 'Totals')}
    ${isAdmin ? tab('admin', '#resources/admin', 'Admin') : ''}
  </div>`;
}

/** Sent/Took direction pill. `direction` is 1 (Sent) or -1 (Took). */
export function directionPillHtml(direction) {
  const isSent = direction === 1;
  return `<span class="resource-direction ${isSent ? 'resource-sent' : 'resource-took'}">${isSent ? 'Sent' : 'Took'}</span>`;
}

/**
 * A tiny inline-SVG sparkline (filled area + line) for a series of values.
 * Cheap enough to render many at once (card grid / member rows) without the
 * overhead of Chart.js canvases. Colors come from CSS via the .resource-spark
 * classes so it stays theme-aware.
 */
export function resourceSparklineSvg(values) {
  const vals = Array.isArray(values) ? values : [];
  if (!vals.length || vals.every((v) => v === 0)) {
    return '<svg class="resource-spark" viewBox="0 0 100 28" preserveAspectRatio="none"></svg>';
  }
  const max = Math.max(...vals, 1);
  const n = vals.length;
  const step = n > 1 ? 100 / (n - 1) : 0;
  const pts = vals.map((v, i) => `${(i * step).toFixed(2)},${(26 - (v / max) * 24).toFixed(2)}`).join(' ');
  return `<svg class="resource-spark" viewBox="0 0 100 28" preserveAspectRatio="none">
    <polygon class="resource-spark-area" points="0,28 ${pts} 100,28"></polygon>
    <polyline class="resource-spark-line" points="${pts}"></polyline>
  </svg>`;
}

/**
 * Whether the currently-active clan has resource tracking enabled.
 *
 * A superadmin can switch the header clan-picker to a clan that has
 * resources disabled while sitting on the Resources page; the switch
 * reloads with the stale #resources hash. The render functions call this
 * and bounce to the dashboard when it returns false, mirroring how the
 * ChestTracker tab guards itself (external.js). Any failure resolves to
 * false so we never strand the user on a feature the clan doesn't use.
 */
export async function isResourcesEnabledForActiveClan() {
  try {
    const data = await api('/clans');
    const clans = Array.isArray(data?.clans) ? data.clans : [];
    const activeId = data?.activeClanId ?? null;
    const activeClan = clans.find((c) => c.id === activeId) ?? clans[0] ?? null;
    return activeClan?.resourcesEnabled === true;
  } catch {
    return false;
  }
}
