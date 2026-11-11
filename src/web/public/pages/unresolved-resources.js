// Unresolved Resources — the Admin page section for Clan Capital history rows
// whose resource the icon matcher couldn't identify.
//
// Like the Review Queue it only appears while there is something to address,
// and it is driven by the same count as the Admin nav dot (/admin/nav-status),
// so the dot can never light without a section to act on.
//
// Each row is resolved where it is shown: the crop of the original game row
// sits beside a resource picker, because the icon in that crop IS the answer
// and nothing else on the row is in question (amount, direction and date are
// read reliably; the ledger on Resources → Admin edits them if ever needed).
// Until Nov 2026 this was a status card with a button that opened a dialog,
// on Resources → Admin next to the screenshot upload, which is gone.

import { api, apiPatch, mustOk } from '../lib/api.js';
import { esc, formatGameDayShort, notify, openCropLightbox } from '../lib/ui.js';
import { formatResourceAmount, directionPillHtml } from '../lib/resource-format.js';
import { t, tn, tGame } from '../lib/i18n.js';

/** Rows shown at once — the site's page size. The rest follow as these are resolved. */
const SHOWN = 25;

/**
 * The rows and the resource list the section needs, or null when there is
 * nothing to resolve. Only fetched when the nav-status count says there is
 * something, so a clean clan pays nothing for the section.
 */
export async function loadUnresolvedResources(count) {
  if (!(Number(count) > 0)) return null;
  try {
    const qs = new URLSearchParams({
      resourceTypeId: 'unknown', sortBy: 'date', sortDir: 'desc', limit: String(SHOWN), offset: '0',
    });
    const [txRes, typesRes] = await Promise.all([
      api(`/resources/transactions?${qs}`),
      api('/resources/types'),
    ]);
    const rows = Array.isArray(txRes?.rows) ? txRes.rows : [];
    const types = Array.isArray(typesRes) ? typesRes : (typesRes?.types ?? []);
    if (!rows.length) return null;
    return { rows, types, total: Number(txRes?.total) || rows.length };
  } catch (_) {
    return null; // one missing section, never a blank Admin page
  }
}

/** The section, or '' when nothing is waiting. */
export function unresolvedResourcesSectionHtml(data) {
  if (!data?.rows?.length) return '';
  const { rows, types, total } = data;
  const typeOptions = [...types]
    .map((type) => ({ id: type.id, name: tGame(type.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((type) => `<option value="${type.id}">${esc(type.name)}</option>`)
    .join('');

  const rowHtml = (tx) => {
    const cropUrl = `/api/resources/transactions/${tx.id}/crop`;
    const crop = tx.hasCrop
      ? `<button type="button" class="unres-crop" data-crop-open="${cropUrl}" title="${t('Click to enlarge')}">
           <img src="${cropUrl}" alt="${t('Screenshot of the row this entry came from')}" loading="lazy">
         </button>`
      : `<div class="unres-crop is-empty">${t('No screenshot of this row was kept.')}</div>`;
    return `
      <li class="unres-row" data-unres-row="${tx.id}" data-direction="${tx.direction}"
          data-amount="${tx.amount}" data-date="${esc(tx.transactionDate)}">
        ${crop}
        <div class="unres-side">
          <div class="unres-meta">
            <span class="unres-name">${esc(tx.memberName ?? tx.rawPlayerName ?? '—')}</span>
            ${directionPillHtml(tx.direction)}
            <span class="unres-amount">${formatResourceAmount(null, tx.amount)}</span>
            <span class="unres-date">${esc(formatGameDayShort(tx.transactionDate))}</span>
          </div>
          <div class="unres-actions">
            <select class="input" id="unresResource-${tx.id}" aria-label="${t('Resource')}">
              <option value="">${t('Select...')}</option>
              ${typeOptions}
            </select>
            <button class="btn btn-primary" data-action="resolve-resource-row" data-tx-id="${tx.id}">${t('Save')}</button>
          </div>
        </div>
      </li>`;
  };

  // Save all: one click for every row with a resource picked, the way the old
  // dialog did it. Only worth a button when there is more than one row.
  const more = total > rows.length
    ? `<p class="unres-more muted-copy">${t('Showing the newest {shown} of {total}. The rest appear here as these are resolved.', { shown: rows.length, total })}</p>`
    : '';
  const saveAll = rows.length > 1
    ? `<button class="btn btn-primary" data-action="resolve-resource-all">${t('Save all')}</button>`
    : '';
  return `
    <h2 class="page-section-title">${t('Unresolved Resources')} <span class="chest-type epic">${tn(total, '{n} row', '{n} rows', { n: total })}</span></h2>
    <p class="page-section-intro">${t("The daily Clan Capital read couldn't identify these icons. Pick the resource each row shows and save.")}</p>
    <div class="card unres-card">
      <ul class="unres-list">${rows.map(rowHtml).join('')}</ul>
      ${more || saveAll ? `<div class="unres-footer">${more}${saveAll}</div>` : ''}
    </div>`;
}

/**
 * Click-to-zoom on a crop, and a crop that fails to load (deleted from disk)
 * turning into the same note a row without one shows. Bound per render: the
 * section is rebuilt on every Admin rerender.
 */
export function wireUnresolvedResources(root) {
  const list = root.querySelector('.unres-list');
  if (!list) return;
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-crop-open]');
    if (btn) openCropLightbox(btn.dataset.cropOpen, { returnFocusTo: btn });
  });
  list.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const box = img.closest('.unres-crop');
    if (!box) return;
    const note = document.createElement('div');
    note.className = 'unres-crop is-empty';
    note.textContent = t('No screenshot of this row was kept.');
    box.replaceWith(note);
  }, true);
}

/** Set a row's picked resource, keeping its other fields as read. */
function patchRow(row, select) {
  return apiPatch(`/resources/transactions/${row.dataset.unresRow}`, {
    resourceTypeId: Number.parseInt(select.value, 10),
    direction: Number.parseInt(row.dataset.direction, 10),
    amount: Number.parseInt(row.dataset.amount, 10),
    transactionDate: row.dataset.date,
  });
}

async function rerenderInPlace(rerender) {
  const scrollY = window.scrollY;
  if (typeof rerender === 'function') await rerender();
  window.scrollTo(0, scrollY);
}

/** A row's own Save button. */
export async function saveUnresolvedResource(txId, rerender) {
  const row = document.querySelector(`[data-unres-row="${txId}"]`);
  const select = document.getElementById(`unresResource-${txId}`);
  if (!row || !select) return;
  if (!select.value) {
    notify(t('Pick a resource'), t('Unresolved Resources'));
    select.focus();
    return;
  }
  if (!await mustOk(patchRow(row, select), t('Save failed'))) return;
  await rerenderInPlace(rerender);
}

/**
 * Save all: every listed row that has a resource picked, then one rerender.
 * Rows left on "Select..." are skipped and stay listed, and the notice says
 * how many — the same contract the old dialog's Save all had.
 */
export async function saveAllUnresolvedResources(button, rerender) {
  const rows = [...document.querySelectorAll('.unres-row')];
  const picked = rows
    .map((row) => ({ row, select: document.getElementById(`unresResource-${row.dataset.unresRow}`) }))
    .filter(({ select }) => select?.value);
  if (!picked.length) {
    notify(t('Pick a resource'), t('Unresolved Resources'));
    rows[0]?.querySelector('select')?.focus();
    return;
  }
  if (button) button.disabled = true;
  let saved = 0;
  const failures = [];
  for (const { row, select } of picked) {
    try {
      const res = await patchRow(row, select);
      if (res && typeof res.error === 'string') failures.push(res.error);
      else saved++;
    } catch (err) {
      if (err?.name === 'UnauthenticatedError') return;
      failures.push(err?.message || String(err));
    }
  }
  await rerenderInPlace(rerender);
  if (failures.length) notify([...new Set(failures)].join('\n'), t('Save failed'));
  if (saved) {
    const unpicked = rows.length - picked.length;
    notify(`${tn(saved, 'Saved {n} row.', 'Saved {n} rows.')}${unpicked
      ? ` ${tn(unpicked, '{n} row still needs a resource picked.', '{n} rows still need a resource picked.')}`
      : ''}`, t('Saved'));
  }
}
