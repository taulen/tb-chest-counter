// Resources → Admin: the transaction ledger (filter, sort, edit) and the
// import history (delete a bad batch). Data arrives only from the daily Clan
// Capital history read; the screenshot upload that used to live here was
// removed in Nov 2026, and rows the reader couldn't identify are resolved from
// the Admin page (unresolved-resources.js).

import { api, apiPatch, apiDelete } from '../lib/api.js';
import { esc, formatDate, formatGameDayShort, notify, confirmDialog } from '../lib/ui.js';
import { sortableThHtml } from '../lib/sort-headers.js';
import { getCurrentUser } from '../lib/state.js';
import {
  formatResourceAmount, resourceIconHtml, directionPillHtml, resourceCropHoverHtml,
  resourceTabsHtml, isResourcesEnabledForActiveClan,
} from '../lib/resource-format.js';
import { t, tn, tGame } from '../lib/i18n.js';

const PAGE_SIZE = 25;
let currentPage = 1;
let filters = {
  memberId: '',
  resourceTypeId: '',
  direction: '',
  from: '',
  to: '',
  sortBy: 'transaction_date',
  sortDir: 'desc',
};

// Cached resource types for the inline-edit dropdown (populated on each render).
let cachedTypes = [];

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatTxAmount(tx) {
  return formatResourceAmount(tx.resourceTypeSlug, tx.amount);
}

// ─── Sort ─────────────────────────────────────────────────────────────────────

export function sortResources(key, reload) {
  if (filters.sortBy === key) {
    filters.sortDir = filters.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    filters.sortBy = key;
    filters.sortDir = 'asc';
  }
  currentPage = 1;
  reload('resources/admin');
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export function changeResourcesPage(delta, reload) {
  currentPage += delta;
  if (currentPage < 1) currentPage = 1;
  reload('resources/admin');
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export function setResourcesFilter(key, value, reload) {
  filters[key] = value ?? '';
  currentPage = 1;
  reload('resources/admin');
}

export function handleResourcesApplyFilters(reload) {
  const fromEl = document.getElementById('resourcesDateFrom');
  const toEl = document.getElementById('resourcesDateTo');
  if (fromEl) filters.from = fromEl.value;
  if (toEl) filters.to = toEl.value;
  currentPage = 1;
  reload('resources/admin');
}

// ─── Batch delete ─────────────────────────────────────────────────────────────

export async function handleResourcesBatchDelete(batchId, reload) {
  if (!batchId) return;
  const ok = await confirmDialog(t('Delete this batch and all its transactions?'));
  if (!ok) return;
  try {
    await apiDelete(`/resources/batches/${batchId}`);
    reload('resources/admin');
  } catch (err) {
    await notify(t('Delete failed: {error}', { error: err.message }), t('Error'));
  }
}

// ─── Inline edit ─────────────────────────────────────────────────────────────

export function handleResourcesTxEdit(txId) {
  const row = document.querySelector(`tr[data-tx-row="${txId}"]`);
  if (!row) return;
  const d = row.dataset;
  const selectedType = cachedTypes.find((type) => String(type.id) === d.txResourceId);
  const isSpeedup = selectedType?.slug === 'clan-speedup';
  const typeOptions = [
    `<option value="">${t('— Unknown —')}</option>`,
    ...cachedTypes.map((type) =>
      `<option value="${type.id}" ${String(type.id) === d.txResourceId ? 'selected' : ''}>${esc(tGame(type.name))}</option>`
    ),
  ].join('');
  const initDays  = isSpeedup ? Math.floor(Number(d.txAmount) / 24) : 0;
  const initHours = isSpeedup ? Number(d.txAmount) % 24 : 0;
  const amountCell = isSpeedup
    ? `<div class="speedup-amount-edit">
         <div class="speedup-amount-row">
           <input type="number" class="input input-tight" id="txEditAmountD-${txId}" value="${initDays}" min="0" step="1"> ${t('d')}
         </div>
         <div class="speedup-amount-row">
           <input type="number" class="input input-tight" id="txEditAmountH-${txId}" value="${initHours}" min="0" step="1"> ${t('h')}
         </div>
       </div>`
    : `<input type="number" class="input input-tight" id="txEditAmount-${txId}" value="${esc(d.txAmount)}" min="1" step="1">`;

  row.innerHTML = `
    <td data-label="${t('Member')}">${esc(d.txMemberName)}</td>
    <td data-label="${t('Resource')}"><select class="input input-tight" id="txEditResource-${txId}">${typeOptions}</select></td>
    <td data-label="${t('Direction')}">
      <select class="input input-tight" id="txEditDir-${txId}">
        <option value="1"  ${d.txDirection === '1'  ? 'selected' : ''}>${t('Sent')}</option>
        <option value="-1" ${d.txDirection === '-1' ? 'selected' : ''}>${t('Took')}</option>
      </select>
    </td>
    <td data-label="${t('Amount')}">${amountCell}</td>
    <td data-label="${t('Date')}"><input type="date"   class="input input-tight" id="txEditDate-${txId}"   lang="sv" value="${esc(d.txDate)}"></td>
    <td data-label="" class="col-tx-actions">
      <button class="btn btn-tight btn-primary" data-action="resources-tx-save" data-tx-id="${txId}">${t('Save')}</button>
      <button class="btn btn-tight"             data-action="resources-tx-cancel">${t('Cancel')}</button>
    </td>
  `;
}

export async function handleResourcesTxSave(txId, reload) {
  const resourceEl = document.getElementById(`txEditResource-${txId}`);
  const dirEl      = document.getElementById(`txEditDir-${txId}`);
  const dateEl     = document.getElementById(`txEditDate-${txId}`);
  if (!resourceEl || !dirEl || !dateEl) return;

  const resourceTypeId = resourceEl.value ? Number.parseInt(resourceEl.value, 10) : null;
  const direction      = Number.parseInt(dirEl.value, 10);
  const transactionDate = dateEl.value;

  // Speedup rows use two inputs (days + hours); all others use a single amount input.
  const dayEl   = document.getElementById(`txEditAmountD-${txId}`);
  const hourEl  = document.getElementById(`txEditAmountH-${txId}`);
  const amountEl = document.getElementById(`txEditAmount-${txId}`);

  let amount;
  if (dayEl && hourEl) {
    const days  = Math.max(0, Number.parseInt(dayEl.value,  10) || 0);
    const hours = Math.max(0, Number.parseInt(hourEl.value, 10) || 0);
    amount = days * 24 + hours;
  } else if (amountEl) {
    amount = Number.parseInt(amountEl.value, 10);
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    await notify(t('Amount must be positive.'), t('Validation'));
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) {
    await notify(t('Date is required.'), t('Validation'));
    return;
  }

  try {
    const res = await apiPatch(`/resources/transactions/${txId}`, { resourceTypeId, direction, amount, transactionDate });
    if (res?.error) {
      await notify(t('Save failed: {error}', { error: res.error }), t('Error'));
      return;
    }
    reload('resources/admin');
  } catch (err) {
    await notify(t('Save failed: {error}', { error: err.message }), t('Error'));
  }
}

export function handleResourcesTxCancel(reload) {
  reload('resources/admin');
}

// ─── Main render ─────────────────────────────────────────────────────────────

export async function renderResourcesAdmin(el, navigate) {
  const user = getCurrentUser();
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    el.innerHTML = `<div class="card"><div class="card-body"><p>${t('Admin access required.')}</p></div></div>`;
    return;
  }

  // Bounce to the dashboard if the active clan doesn't use resources — a
  // superadmin can land here with a stale hash after switching clans.
  if (!(await isResourcesEnabledForActiveClan())) {
    if (typeof navigate === 'function') navigate('dashboard');
    return;
  }

  const [typesRes, membersRes] = await Promise.all([
    api('/resources/types'),
    api('/members'),
  ]);

  const allTypes = Array.isArray(typesRes) ? typesRes : (typesRes?.types ?? []);
  cachedTypes = allTypes;
  const allMembers = Array.isArray(membersRes) ? membersRes : [];

  const qs = new URLSearchParams();
  if (filters.memberId)      qs.set('memberId',       filters.memberId);
  if (filters.resourceTypeId) qs.set('resourceTypeId', filters.resourceTypeId);
  if (filters.direction)     qs.set('direction',       filters.direction);
  if (filters.from)          qs.set('from',            filters.from);
  if (filters.to)            qs.set('to',              filters.to);
  qs.set('sortBy',  filters.sortBy);
  qs.set('sortDir', filters.sortDir);
  qs.set('limit',   String(PAGE_SIZE));
  qs.set('offset',  String((currentPage - 1) * PAGE_SIZE));

  const [txRes, batchRes] = await Promise.all([
    api(`/resources/transactions?${qs}`),
    api('/resources/batches'),
  ]);

  const transactions = Array.isArray(txRes?.rows) ? txRes.rows : [];
  const total = txRes?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const batches = Array.isArray(batchRes) ? batchRes : (batchRes?.batches ?? []);

  const th = (key, labelHtml) => sortableThHtml({
    key, labelHtml, sortState: { key: filters.sortBy, dir: filters.sortDir }, action: 'resources-sort',
  });

  const memberOptions = allMembers.map((m) =>
    `<option value="${m.id}" ${String(m.id) === filters.memberId ? 'selected' : ''}>${esc(m.name)}</option>`
  ).join('');

  const typeOptions = allTypes.map((type) =>
    `<option value="${type.id}" ${String(type.id) === filters.resourceTypeId ? 'selected' : ''}>${esc(tGame(type.name))}</option>`
  ).join('');

  const txRows = transactions.length === 0
    ? `<tr><td colspan="6" class="empty-state-cell">${t('No transactions match the current filters.')}</td></tr>`
    : transactions.map((tx) => `
        <tr data-tx-row="${tx.id}"
            data-tx-member-name="${esc(tx.memberName ?? tx.rawPlayerName ?? '')}"
            data-tx-resource-id="${tx.resourceTypeId ?? ''}"
            data-tx-direction="${tx.direction}"
            data-tx-amount="${tx.amount}"
            data-tx-date="${esc(tx.transactionDate)}">
          <td data-label="${t('Member')}" data-role="primary"><span class="mrow-name">${esc(tx.memberName ?? tx.rawPlayerName ?? '—')}</span></td>
          <td data-label="${t('Resource')}">${resourceIconHtml(tx.resourceTypeSlug, tx.resourceTypeName)}${tx.hasCrop ? ` ${resourceCropHoverHtml(tx)}` : ''}</td>
          <td data-label="${t('Direction')}">${directionPillHtml(tx.direction)}</td>
          <td data-label="${t('Amount')}" class="col-num" data-role="metric">${formatTxAmount(tx)}</td>
          <td data-label="${t('Date')}">${esc(formatGameDayShort(tx.transactionDate))}</td>
          <td class="col-tx-actions">
            <button class="btn btn-tight" data-action="resources-tx-edit" data-tx-id="${tx.id}">${t('Edit')}</button>
          </td>
        </tr>`
    ).join('');

  const pagination = total > PAGE_SIZE ? `
    <div class="pagination">
      <button class="btn btn-tight" data-action="resources-page-prev" ${currentPage <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
      <span class="pagination-info">${t('Page {page} of {pages}', { page: currentPage, pages: totalPages })} · ${tn(total, '{n} row', '{n} rows', { n: total })}</span>
      <button class="btn btn-tight" data-action="resources-page-next" ${currentPage >= totalPages ? 'disabled' : ''}>${t('Next →')}</button>
    </div>
  ` : '';

  const batchRows = batches.length === 0
    ? `<tr><td colspan="7" class="empty-state-cell">${t('No imports yet.')}</td></tr>`
    : batches.map((b) => {
        // An automated batch is a scroll sweep, not a pile of files — so its
        // file_count is pages. Labelling both the same would misreport one of them.
        const isScan = b.source === 'scan';
        const fileCount = b.fileCount ?? 1;
        const countLabel = isScan
          ? tn(fileCount, '{n} page', '{n} pages', { n: esc(String(fileCount)) })
          : tn(fileCount, '{n} file', '{n} files', { n: esc(String(fileCount)) });
        return `
        <tr>
          <td data-label="${t('Imported')}" data-role="primary"><span class="mrow-name">${esc(formatDate(b.uploadedAt))}</span><span class="mrow-sub">${countLabel}</span></td>
          <td data-label="${t('Source')}">${isScan
            ? `<span class="resource-direction resource-batch-auto" title="${t('Read from the game by the automated capture')}">${t('Automatic')}</span>`
            : `<span class="resource-direction resource-batch-upload" title="${t('Screenshots uploaded by an admin')}">${t('Upload')}</span>`}</td>
          <td data-label="${t('Screenshot Date')}">${esc(formatGameDayShort(b.uploadDate))}</td>
          <td data-label="${isScan ? t('Pages') : t('Files')}" class="col-num">${b.fileCount ?? 1}</td>
          <td data-label="${t('Rows')}"    class="col-num" data-role="metric">${b.rowCount}</td>
          <td data-label="${t('Errors')}"  class="col-num">${b.errorCount}</td>
          <td class="col-actions">
            <button class="btn btn-tight btn-danger" data-action="resources-batch-delete" data-batch-id="${b.id}">${t('Delete')}</button>
          </td>
        </tr>`;
      }).join('');

  el.innerHTML = `
    ${resourceTabsHtml('admin')}

    <div class="card">
      <div class="card-header"><h2>${t('Resource History')}</h2></div>
      <div class="card-body">
        <div class="resources-filter-bar">
          <select class="input resource-filter-select" data-filter-key="memberId" aria-label="${t('Filter by member')}">
            <option value="">${t('All members')}</option>
            ${memberOptions}
          </select>
          <select class="input resource-filter-select" data-filter-key="resourceTypeId" aria-label="${t('Filter by resource')}">
            <option value="">${t('All resources')}</option>
            <option value="unknown" ${filters.resourceTypeId === 'unknown' ? 'selected' : ''}>${t('— Unknown —')}</option>
            ${typeOptions}
          </select>
          <select class="input resource-filter-select" data-filter-key="direction" aria-label="${t('Filter by direction')}">
            <option value=""  ${filters.direction === ''   ? 'selected' : ''}>${t('All directions')}</option>
            <option value="1" ${filters.direction === '1'  ? 'selected' : ''}>${t('Sent')}</option>
            <option value="-1"${filters.direction === '-1' ? 'selected' : ''}>${t('Took')}</option>
          </select>
          <input type="date" id="resourcesDateFrom" class="input" lang="sv" value="${esc(filters.from)}" aria-label="${t('From date')}">
          <input type="date" id="resourcesDateTo"   class="input" lang="sv" value="${esc(filters.to)}"   aria-label="${t('To date')}">
          <button class="btn" data-action="resources-apply-filters">${t('Apply')}</button>
        </div>
        <table class="table-responsive resources-table">
          <colgroup>
            <col class="col-member">
            <col class="col-resource">
            <col class="col-direction">
            <col class="col-amount">
            <col class="col-date">
            <col class="col-tx-actions">
          </colgroup>
          <thead><tr>
            ${th('member_name', t('Member'))}
            ${th('resource_type', t('Resource'))}
            ${th('direction', t('Direction'))}
            ${th('amount', t('Amount'))}
            ${th('transaction_date', t('Date'))}
            <th></th>
          </tr></thead>
          <tbody>${txRows}</tbody>
        </table>
        ${pagination}
      </div>
    </div>

    <details class="card card-collapsible" data-section-key="resources-upload-history">
      <summary class="card-header"><h2>${t('Import History')}</h2></summary>
      <div class="card-body">
        <table class="table-responsive resources-batches-table">
          <colgroup>
            <col class="col-uploaded-at">
            <col class="col-batch-source">
            <col class="col-upload-date">
            <col class="col-file-count">
            <col class="col-row-count">
            <col class="col-error-count">
            <col class="col-actions-narrow">
          </colgroup>
          <thead><tr>
            <th>${t('Imported')}</th>
            <th>${t('Source')}</th>
            <th>${t('Screenshot Date')}</th>
            <th class="col-num">${t('Files')}</th>
            <th class="col-num">${t('Rows')}</th>
            <th class="col-num">${t('Errors')}</th>
            <th></th>
          </tr></thead>
          <tbody>${batchRows}</tbody>
        </table>
      </div>
    </details>
  `;
}
