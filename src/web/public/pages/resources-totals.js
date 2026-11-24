// Resources — Totals tab.
//
// A full member × resource-type matrix: one row per clan member, one column
// per (non-excluded) resource type, cell = that member's total Sent (donated)
// of that resource — for the selected timeframe — in its own unit. Every
// column is sortable. Timeframe uses the shared game-window (Weekly/Monthly/
// Yearly/All, same week definition as the Leaderboard); Daily is omitted as
// too granular for a totals matrix. A few fragment/special resources are
// excluded — see EXCLUDED_SLUGS. Built client-side from /resources/summary.

import { loadGameArt } from '../lib/game-art.js';
import { api } from '../lib/api.js';
import { esc, memberLink } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { sortableThHtml } from '../lib/sort-headers.js';
import { computeGameWindow, computeGameWindowDates } from '../lib/period.js';
import { getGameDayRolloverUtcHour, getWeekStart } from '../lib/state.js';
import {
  periodScrubberHtml, wirePeriodScrubber, emptyHtml, errorStateHtml, refusalText, wireRetry, setPageActions,
} from '../lib/ui-kit.js';
import {
  formatResourceAmount, formatResourceCompact, resourceIconOnly, resourceTabsHtml,
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

export async function renderResourcesTotals(el) {
  // Read-only dashboard — visible to any authenticated clan member.
  mountedEl = el;
  setPageActions('');
  el.innerHTML = `<div class="rs-page">${resourceTabsHtml('totals')}${emptyHtml(t('Loading totals…'))}</div>`;
  // The game's resource icons (lib/game-art.js) are in before the first paint.
  await loadGameArt();
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

  let answers;
  try {
    answers = await Promise.all([
      api('/resources/types'),
      api('/members'),
      api(`/resources/summary?${qs}`),
    ]);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    answers = [null, null, { error: err?.message || '' }];
  }
  const [typesRes, membersRes, summaryRes] = answers;

  const types = Array.isArray(typesRes) ? typesRes : (typesRes?.types ?? []);
  const members = Array.isArray(membersRes) ? membersRes : [];
  const summary = Array.isArray(summaryRes?.rows) ? summaryRes.rows : [];

  const columns = types.filter((type) => !EXCLUDED_SLUGS.has(type.slug));
  const byMember = new Map();
  for (const m of members) byMember.set(m.id, { memberId: m.id, name: m.name, sent: new Map() });
  for (const r of summary) {
    if (r.resourceTypeId == null || r.sentAmount <= 0) continue;
    const rec = byMember.get(r.memberId);
    if (rec) rec.sent.set(r.resourceTypeId, (rec.sent.get(r.resourceTypeId) || 0) + r.sentAmount);
  }

  // A refusal answer (an object, not { rows }) is said, not drawn as all zeros.
  cache = { columns, rows: [...byMember.values()], failed: Array.isArray(summaryRes?.rows) ? null : (refusalText(summaryRes) || ' ') };
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
  const arrowFor = (key) => (sort.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : '');

  const all = sortedRows();
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  const start = (page - 1) * PAGE_SIZE;
  const pageRows = all.slice(start, start + PAGE_SIZE);

  const headCols = columns.map((c) => {
    const active = sort.key === `type-${c.id}`;
    // The icon / name / arrow stack lays its own arrow out, so it passes its own.
    return sortableThHtml({
      key: `type-${c.id}`,
      sortState: sort,
      className: `rtype-th${active ? ' is-sorted' : ''}`,
      title: tGame(c.name),
      arrowHtml: '',
      labelHtml: `<span class="rtype-head">
        ${resourceIconOnly(c.name)}
        <span class="rtype-head-name">${esc(tGame(c.name))}</span>
        <span class="rtype-head-arrow" aria-hidden="true">${arrowFor(`type-${c.id}`)}</span>
      </span>`,
    });
  }).join('');

  const colGroup = `<colgroup><col class="col-player">${columns.map(() => '<col class="col-rtype">').join('')}</colgroup>`;

  const body = pageRows.length === 0
    ? `<tr><td colspan="${columns.length + 1}" class="empty-state-cell">${t('No members yet.')}</td></tr>`
    : pageRows.map((row) => `
        <tr>
          <td data-label="${t('Member')}" data-role="primary"><span class="mrow-name">${memberLink(row.memberId, row.name)}</span></td>
          ${columns.map((c) => {
            const metricAttr = sort.key === `type-${c.id}` ? ' data-role="metric"' : '';
            const v = row.sent.get(c.id) || 0;
            if (v <= 0) return `<td data-label="${esc(tGame(c.name))}" class="col-num"${metricAttr}><span class="resources-totals-zero">—</span></td>`;
            return `<td data-label="${esc(tGame(c.name))}" class="col-num"${metricAttr} title="${esc(formatResourceAmount(c.slug, v))}">${esc(formatResourceCompact(c.slug, v))}</td>`;
          }).join('')}
        </tr>`).join('');

  const pagination = total > PAGE_SIZE ? `
    <div class="pagination">
      <button class="btn btn-tight" data-totals-page="prev" ${page <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
      <span class="pagination-info">${t('Page {page} of {pages}', { page, pages: totalPages })} · ${tn(total, '{n} member', '{n} members', { n: total })}</span>
      <button class="btn btn-tight" data-totals-page="next" ${page >= totalPages ? 'disabled' : ''}>${t('Next →')}</button>
    </div>` : '';

  const rolloverHr = getGameDayRolloverUtcHour();
  const weekStart = getWeekStart();
  const scrubber = periodScrubberHtml({
    periods: PERIODS, period, offset: periodOffset, rolloverHr, weekStart,
    win: computeGameWindow(period, periodOffset, rolloverHr, weekStart),
  });

  el.innerHTML = cache.failed
    ? `<div class="rs-page">${resourceTabsHtml('totals')}${scrubber}${errorStateHtml(t('The resources could not be loaded.'), cache.failed.trim())}</div>`
    : `<div class="rs-page">
      ${resourceTabsHtml('totals')}
      ${scrubber}
      <p class="ui-sub">${t('Donation totals by member')} · ${t('Sent · each in its own unit')}</p>
      <div class="ui-table-card">
        <table class="table-responsive ui-table resources-totals-table">
          ${colGroup}
          <thead><tr>
            ${sortableThHtml({ key: 'member', labelHtml: t('Member'), sortState: sort })}
            ${headCols}
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
        ${pagination}
      </div>
    </div>`;

  if (cache.failed) wireRetry(el, reload);
  wire(el);
  const table = el.querySelector('.resources-totals-table');
  if (table) {
    fitNameColumns(table);
    // Measured again once the web font is in: the fallback font's widths differ.
    document.fonts?.ready.then(() => { if (table.isConnected) fitNameColumns(table); });
  }
}

/** The narrowest a resource column gets: its icon and a compact amount ("123.4M") fit. */
const MIN_NAME_COL = 52;
let measureCtx = null;

/**
 * Size each resource column to the longest word of its name. The names are
 * the game's own and can't be shortened ("Drachenmünzen", "Wissenschaftliche
 * Arbeiten", "ускоритель"), and `hyphens: auto` doesn't hyphenate in Chrome or
 * Edge on Windows, so a fixed narrow column cut them mid-word. Measured from
 * the names alone, so the widths follow the language and never move with
 * sorting, paging or the period (the table stays table-layout: fixed); the
 * browser shares the spare width out, and a table too wide for the card
 * scrolls inside it.
 */
function fitNameColumns(table) {
  const cols = table.querySelectorAll('col.col-rtype');
  const names = table.querySelectorAll('.rtype-head-name');
  if (!cols.length || cols.length !== names.length) return;
  const th = names[0].closest('th');
  if (!th) return;
  const nameStyle = getComputedStyle(names[0]);
  const thStyle = getComputedStyle(th);
  const pad = (parseFloat(thStyle.paddingLeft) || 0) + (parseFloat(thStyle.paddingRight) || 0);
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  if (!measureCtx) return;
  measureCtx.font = `${nameStyle.fontStyle} ${nameStyle.fontWeight} ${nameStyle.fontSize} ${nameStyle.fontFamily}`;
  names.forEach((name, i) => {
    const words = name.textContent.trim().split(/\s+/);
    const longest = Math.max(0, ...words.map((w) => measureCtx.measureText(w).width));
    // +2: rounding between canvas and layout must never push a last letter over.
    cols[i].style.width = `${Math.max(MIN_NAME_COL, Math.ceil(longest + pad + 2))}px`;
  });
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

  wirePeriodScrubber(el, {
    onPeriod: async (p) => { period = p; periodOffset = 0; page = 1; await reload(); },
    onStep: async (delta) => { periodOffset = Math.max(0, periodOffset + delta); page = 1; await reload(); },
  });
}
