// Unresolved Resources — the Admin page section for Clan Capital history rows
// whose resource the icon matcher couldn't identify, and the dialog that
// resolves them.
//
// Like the Review Queue it only appears while there is something to address,
// and it is driven by the same count as the Admin nav dot (/admin/nav-status),
// so the dot can never light without a section to act on. Until Nov 2026 this
// sat in an always-on status card on Resources → Admin, next to the screenshot
// upload; the upload is gone (the daily read does the same job), and resolving
// rows is data correction, which is what the Admin page is for.

import { api, apiPatch } from '../lib/api.js';
import { esc, notify, attachCropPreviews, holdDialogFocus } from '../lib/ui.js';
import { resourceCropHoverHtml } from '../lib/resource-format.js';
import { t, tn, tGame } from '../lib/i18n.js';

/** The section, or '' when nothing is waiting. */
export function unresolvedResourcesSectionHtml(count) {
  const n = Number(count) || 0;
  if (n <= 0) return '';
  return `
    <h2 class="page-section-title">${t('Unresolved Resources')} <span class="chest-type epic">${tn(n, '{n} row', '{n} rows', { n })}</span></h2>
    <div class="card">
      <div class="card-body card-body-padded">
        <div class="inline-form-row">
          <span class="muted-copy">${tn(n,
            "<strong>{n}</strong> Clan Capital history row has no resource &mdash; its icon couldn't be identified. Each kept a crop of the original row.",
            "<strong>{n}</strong> Clan Capital history rows have no resource &mdash; their icons couldn't be identified. Each kept a crop of the original row.")}</span>
          <button class="btn btn-primary" data-action="resources-resolve-unknowns">${tn(n, 'Resolve {n} row', 'Resolve {n} rows')}</button>
        </div>
      </div>
    </div>`;
}

/** The section's Resolve button: every unresolved row of the active clan, in one dialog. */
export async function resolveUnresolvedResources(reload) {
  let rows = [];
  let types = [];
  try {
    const qs = new URLSearchParams({
      resourceTypeId: 'unknown',
      sortBy: 'date',
      sortDir: 'desc',
      limit: '200',
      offset: '0',
    });
    const [txRes, typesRes] = await Promise.all([
      api(`/resources/transactions?${qs}`),
      api('/resources/types'),
    ]);
    rows = Array.isArray(txRes?.rows) ? txRes.rows : [];
    types = Array.isArray(typesRes) ? typesRes : (typesRes?.types ?? []);
  } catch (err) {
    return notify(String(err), t('Could not load unresolved rows'));
  }
  if (rows.length === 0) {
    return notify(t('Nothing left to resolve — every row has a resource.'), t('All clear'));
  }
  openUnknownResourcesModal(rows, types, reload);
}

function unknownRowHtml(tx, types) {
  const typeOptions = [
    `<option value="">${t('— Unknown —')}</option>`,
    ...types.map((type) => `<option value="${type.id}">${esc(tGame(type.name))}</option>`),
  ].join('');
  return `
    <tr data-unknown-row="${tx.id}">
      <td data-label="${t('Row')}" class="col-crop">${resourceCropHoverHtml(tx)}</td>
      <td data-label="${t('Member')}">${esc(tx.memberName ?? tx.rawPlayerName ?? '—')}</td>
      <td data-label="${t('Resource')}">
        <select class="input input-tight" data-field="resource" autocomplete="off">${typeOptions}</select>
      </td>
      <td data-label="${t('Direction')}">
        <select class="input input-tight" data-field="direction">
          <option value="1"  ${tx.direction === 1  ? 'selected' : ''}>${t('Sent')}</option>
          <option value="-1" ${tx.direction === -1 ? 'selected' : ''}>${t('Took')}</option>
        </select>
      </td>
      <td data-label="${t('Amount')}">
        <input type="number" class="input input-tight" data-field="amount" value="${esc(String(tx.amount))}" min="1" step="1">
      </td>
      <td data-label="${t('Date')}">
        <input type="date" class="input input-tight" data-field="date" lang="sv" value="${esc(tx.transactionDate)}">
      </td>
      <td class="col-tx-actions">
        <button class="btn btn-tight btn-primary" data-unknown-save="${tx.id}">${t('Save')}</button>
        <span class="unknown-row-status" aria-live="polite"></span>
      </td>
    </tr>`;
}

// Build and show the "Resolve unknown resources" overlay. Self-contained: it
// wires its own listeners (it lives in #modalRoot, outside the delegated
// #content listener) and rerenders the Admin page once on close, so a section
// with nothing left in it disappears.
function openUnknownResourcesModal(rows, types, reload) {
  const root = document.getElementById('modalRoot');
  if (!root) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card modal-card-wide unknown-modal" role="dialog" aria-modal="true">
      <div class="modal-title">${t('Resolve unknown resources')}</div>
      <p class="modal-form-hint unknown-modal-hint">
        ${tn(rows.length,
          "The importer couldn't identify the resource for {n} row. Hover the 🖼️ in the Row column to preview the screenshot row each one came from — or click it to open a zoomable full-size view — then pick the correct resource and save. The other fields are pre-filled from the screenshot and can be edited too.",
          "The importer couldn't identify the resource for {n} rows. Hover the 🖼️ in the Row column to preview the screenshot row each one came from — or click it to open a zoomable full-size view — then pick the correct resource and save. The other fields are pre-filled from the screenshot and can be edited too.",
          { n: `<strong class="unknown-remaining">${rows.length}</strong>` })}
      </p>
      <div class="unknown-modal-scroll">
        <table class="unknown-modal-table">
          <thead><tr>
            <th>${t('Row')}</th><th>${t('Member')}</th><th>${t('Resource')}</th><th>${t('Direction')}</th><th>${t('Amount')}</th><th>${t('Date')}</th><th></th>
          </tr></thead>
          <tbody>${rows.map((tx) => unknownRowHtml(tx, types)).join('')}</tbody>
        </table>
      </div>
      <div class="modal-actions">
        <button class="btn unknown-modal-close">${t('Close')}</button>
        <button class="btn btn-primary unknown-modal-save-all">${t('Save all')}</button>
      </div>
    </div>
  `;

  root.appendChild(overlay);
  attachCropPreviews(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));

  let dirty = false; // any successful save → rerender the page on close
  const remainingEl = overlay.querySelector('.unknown-remaining');
  const saveAllBtn = overlay.querySelector('.unknown-modal-save-all');
  const closeBtn = overlay.querySelector('.unknown-modal-close');

  const remainingCount = () => overlay.querySelectorAll('tr[data-unknown-row]:not(.is-resolved)').length;
  const refreshRemaining = () => {
    const n = remainingCount();
    if (remainingEl) remainingEl.textContent = String(n);
    if (n === 0 && saveAllBtn) { saveAllBtn.disabled = true; saveAllBtn.textContent = t('All resolved'); }
    if (closeBtn) closeBtn.textContent = n === 0 ? t('Done') : t('Close');
  };

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 180);
    release();
    if (dirty && typeof reload === 'function') reload('admin');
  };

  // Focus the first resource dropdown so the operator can pick-and-save
  // straight from the keyboard without reaching for the mouse.
  const release = holdDialogFocus(overlay, {
    card: overlay.querySelector('.modal-card'),
    initial: overlay.querySelector('select[data-field="resource"]'),
    onEscape: cleanup,
  });

  // Save a single row. Returns true on success. `requireResource` (per-row
  // Save) rejects rows still set to "unknown"; Save-all passes false and
  // simply skips them.
  const saveRow = async (rowEl, { requireResource }) => {
    if (!rowEl || rowEl.classList.contains('is-resolved')) return false;
    const txId = rowEl.dataset.unknownRow;
    const resourceVal = rowEl.querySelector('[data-field="resource"]').value;
    const statusEl = rowEl.querySelector('.unknown-row-status');

    if (!resourceVal) {
      if (requireResource) {
        if (statusEl) { statusEl.textContent = t('Pick a resource'); statusEl.className = 'unknown-row-status is-error'; }
        return false;
      }
      return false; // Save-all: leave unresolved rows untouched.
    }

    const resourceTypeId = Number.parseInt(resourceVal, 10);
    const direction = Number.parseInt(rowEl.querySelector('[data-field="direction"]').value, 10);
    const amount = Number.parseInt(rowEl.querySelector('[data-field="amount"]').value, 10);
    const transactionDate = rowEl.querySelector('[data-field="date"]').value;

    if (!Number.isFinite(amount) || amount <= 0) {
      if (statusEl) { statusEl.textContent = t('Bad amount'); statusEl.className = 'unknown-row-status is-error'; }
      return false;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) {
      if (statusEl) { statusEl.textContent = t('Bad date'); statusEl.className = 'unknown-row-status is-error'; }
      return false;
    }

    try {
      const res = await apiPatch(`/resources/transactions/${txId}`, { resourceTypeId, direction, amount, transactionDate });
      if (res?.error) {
        if (statusEl) { statusEl.textContent = res.error; statusEl.className = 'unknown-row-status is-error'; }
        return false;
      }
    } catch (err) {
      if (statusEl) { statusEl.textContent = err.message || t('Save failed'); statusEl.className = 'unknown-row-status is-error'; }
      return false;
    }

    dirty = true;
    rowEl.classList.add('is-resolved');
    rowEl.querySelectorAll('select, input, button').forEach((c) => { c.disabled = true; });
    if (statusEl) { statusEl.textContent = t('✓ Saved'); statusEl.className = 'unknown-row-status is-ok'; }
    refreshRemaining();
    return true;
  };

  overlay.addEventListener('click', async (e) => {
    if (e.target === overlay) { cleanup(); return; }
    if (e.target.closest('.unknown-modal-close')) { cleanup(); return; }

    const saveBtn = e.target.closest('[data-unknown-save]');
    if (saveBtn) {
      await saveRow(saveBtn.closest('tr[data-unknown-row]'), { requireResource: true });
      return;
    }

    if (e.target.closest('.unknown-modal-save-all')) {
      saveAllBtn.disabled = true;
      const pending = Array.from(overlay.querySelectorAll('tr[data-unknown-row]:not(.is-resolved)'));
      let saved = 0;
      for (const rowEl of pending) {
        if (await saveRow(rowEl, { requireResource: false })) saved++;
      }
      const left = remainingCount();
      if (left > 0) {
        saveAllBtn.disabled = false;
        notify(`${t('Saved {count}.', { count: saved })} ${tn(left, '{n} row still needs a resource picked.', '{n} rows still need a resource picked.')}`, t('Resources'));
      } else {
        notify(tn(saved, 'Saved {n} row.', 'Saved {n} rows.'), t('Saved'));
      }
    }
  });
}
