// Resources — Totals tab.
//
// A full member × resource-type matrix: one row per clan member, one column
// per (non-excluded) resource type, cell = that member's total Sent (donated)
// of that resource — for the selected timeframe — in its own unit. Every
// column is sortable. Timeframe uses the shared game-window (Weekly/Monthly/
// Yearly/All, same week definition as the Leaderboard); Daily is omitted as
// too granular for a totals matrix. A few fragment/special resources are
// excluded — see EXCLUDED_SLUGS. Built client-side from /resources/summary.

import { api } from '../lib/api.js';
import { esc, memberLink } from '../lib/ui.js';
import { computeGameWindowDates } from '../lib/period.js';
import { renderPeriodNav } from '../lib/period-nav.js';
import {
  formatResourceAmount, formatResourceCompact, resourceIconOnly, resourceTabsHtml,
  isResourcesEnabledForActiveClan,
} from '../lib/resource-format.js';

const PAGE_SIZE = 25;
const PERIODS = ['weekly', 'monthly', 'yearly', 'all'];

// Resources that aren't useful in the totals matrix (per clan request).
const EXCLUDED_SLUGS = new Set([
  'omen-essence',
  'chronoglyph-clan-fragment',
  'seal-of-suppression',
  'hermes-loyalty-level',
  'torch-of-olympus-clan-fragment',
]);

let sort = { key: 'member', dir: 'asc' };
let sortInitialized = false; // first load defaults to sorting by Silver
let page = 1;
let period = 'weekly';   // same game-week system as the rest of the site
let periodOffset = 0;    // 0 = current period, 1 = previous, …
let cache = null;        // { columns: [{id,name,slug}], rows: [{memberId,name,sent:Map}] }
let mountedEl = null;

export async function renderResourcesTotals(el, navigate) {
  // Read-only dashboard — visible to any authenticated clan member.
  if (!(await isResourcesEnabledForActiveClan())) {
    if (typeof navigate === 'function') navigate('dashboard');
    return;
  }

  mountedEl = el;
  el.innerHTML = `${resourceTabsHtml('totals')}<div class="empty-state"><p>Loading totals…</p></div>`;
  await reload();
}

// Inclusive [from, to] game-day date window for the current period slot
// (rollover-aware, same week definition as the Leaderboard/Overview).
function periodWindow() {
  const win = computeGameWindowDates(period, periodOffset);
  return win ? { from: win.from, to: win.to } : { from: '', to: '' };
}

async function reload() {
  const { from, to } = periodWindow();
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);

  const [typesRes, membersRes, summaryRes] = await Promise.all([
    api('/resources/types'),
    api('/members'),
    api(`/resources/summary?${qs}`),
  ]);

  const types = Array.isArray(typesRes) ? typesRes : (typesRes?.types ?? []);
  const members = Array.isArray(membersRes) ? membersRes : [];
  const summary = Array.isArray(summaryRes?.rows) ? summaryRes.rows : [];

  const columns = types.filter((t) => !EXCLUDED_SLUGS.has(t.slug));
  const byMember = new Map();
  for (const m of members) byMember.set(m.id, { memberId: m.id, name: m.name, sent: new Map() });
  for (const r of summary) {
    if (r.resourceTypeId == null || r.sentAmount <= 0) continue;
    const rec = byMember.get(r.memberId);
    if (rec) rec.sent.set(r.resourceTypeId, (rec.sent.get(r.resourceTypeId) || 0) + r.sentAmount);
  }

  cache = { columns, rows: [...byMember.values()] };
  // Default to sorting by Silver (descending) on first load when it's a
  // column, surfacing silver donations; the user's own sort choice sticks
  // afterward across period changes and repaints.
  if (!sortInitialized) {
    const silver = columns.find((c) => c.slug === 'silver');
    if (silver) sort = { key: `type-${silver.id}`, dir: 'desc' };
    sortInitialized = true;
  }
  paint();
}

function sortedRows() {
  const rows = [...cache.rows];
  const { key, dir } = sort;
  const mul = dir === 'asc' ? 1 : -1;
  if (key === 'member') {
    rows.sort((a, b) => (a.name || '').localeCompare(b.name || '') * mul);
  } else {
    const id = Number(key.slice('type-'.length));
    rows.sort((a, b) => ((a.sent.get(id) || 0) - (b.sent.get(id) || 0)) * mul);
  }
  return rows;
}

function paint() {
  if (!mountedEl) return;
  const el = mountedEl;
  const { columns } = cache;
  const arrow = (key) => sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  const all = sortedRows();
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  const start = (page - 1) * PAGE_SIZE;
  const pageRows = all.slice(start, start + PAGE_SIZE);

  const headCols = columns.map((c) => {
    const active = sort.key === `type-${c.id}`;
    return `<th class="sortable rtype-th ${active ? 'is-sorted' : ''}" data-sort-key="type-${c.id}" title="${esc(c.name)}">
      <span class="rtype-head">
        ${resourceIconOnly(c.slug)}
        <span class="rtype-head-name">${esc(c.name)}</span>
        <span class="rtype-head-arrow">${arrow(`type-${c.id}`).trim()}</span>
      </span>
    </th>`;
  }).join('');

  const colGroup = `<colgroup><col class="col-player">${columns.map(() => '<col class="col-rtype">').join('')}</colgroup>`;

  const body = pageRows.length === 0
    ? `<tr><td colspan="${columns.length + 1}" class="empty-state-cell">No members yet.</td></tr>`
    : pageRows.map((row) => `
        <tr>
          <td data-label="Member" data-role="primary"><span class="mrow-name">${memberLink(row.memberId, row.name)}</span></td>
          ${columns.map((c) => {
            const metricAttr = sort.key === `type-${c.id}` ? ' data-role="metric"' : '';
            const v = row.sent.get(c.id) || 0;
            if (v <= 0) return `<td data-label="${esc(c.name)}" class="col-num"${metricAttr}><span class="resources-totals-zero">—</span></td>`;
            return `<td data-label="${esc(c.name)}" class="col-num"${metricAttr} title="${esc(formatResourceAmount(c.slug, v))}">${esc(formatResourceCompact(c.slug, v))}</td>`;
          }).join('')}
        </tr>`).join('');

  const pagination = total > PAGE_SIZE ? `
    <div class="pagination">
      <button class="btn btn-tight" data-totals-page="prev" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
      <span class="pagination-info">Page ${page} of ${totalPages} · ${total} members</span>
      <button class="btn btn-tight" data-totals-page="next" ${page >= totalPages ? 'disabled' : ''}>Next →</button>
    </div>` : '';

  const periodBtns = PERIODS.map((p) =>
    `<button class="btn ${period === p ? 'active' : ''}" data-tperiod="${p}">${p.charAt(0).toUpperCase()}${p.slice(1)}</button>`
  ).join('');
  // Always render the nav (arrows disabled for All) with a fixed-width label
  // so the controls don't shift when switching timeframes.
  const periodNav = renderPeriodNav({
    period,
    offset: periodOffset,
    prevAttr: 'data-tperiod-nav="prev"',
    nextAttr: 'data-tperiod-nav="next"',
    navClass: 'resources-totals-nav',
  });

  el.innerHTML = `
    ${resourceTabsHtml('totals')}
    <div class="card">
      <div class="card-header resources-totals-header">
        <div class="resources-totals-title">
          <h2>Donation totals by member</h2>
          <span class="card-header-hint">Sent · each in its own unit</span>
        </div>
        <div class="resources-totals-controls">
          <div class="period-selector">${periodBtns}</div>
          ${periodNav}
        </div>
      </div>
      <div class="card-body">
        <div class="resources-totals-scroll">
          <table class="table-responsive resources-totals-table">
            ${colGroup}
            <thead><tr>
              <th class="sortable" data-sort-key="member">Member${arrow('member')}</th>
              ${headCols}
            </tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        ${pagination}
      </div>
    </div>`;

  wire(el);
}

function wire(el) {
  el.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (sort.key === key) {
        sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sort.key = key;
        // Text column defaults ascending; numeric columns descending.
        sort.dir = key === 'member' ? 'asc' : 'desc';
      }
      page = 1;
      paint();
    });
  });

  el.querySelectorAll('[data-totals-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      page += btn.dataset.totalsPage === 'next' ? 1 : -1;
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
}
