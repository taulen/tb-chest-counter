import { api, apiPost, apiPut, apiPatch, apiDelete } from '../lib/api.js';
import { esc, formatDate, formatGameDayShort, localDateKey, notify, confirmDialog, attachCropPreviews } from '../lib/ui.js';
import { getCurrentUser } from '../lib/state.js';
import {
  formatResourceAmount, resourceIconHtml, directionPillHtml,
  resourceTabsHtml, isResourcesEnabledForActiveClan,
} from '../lib/resource-format.js';

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

// Persists the upload result summary across the reload() that follows a completed upload.
let lastUploadSummary = null; // { html: string, cls: string } | null
// Cached resource types for the inline-edit dropdown (populated on each render).
let cachedTypes = [];

// ─── Modernized upload: curated file list ──────────────────────────────────────
// The dropzone builds its own list (drag / paste / browse) rather than relying
// on the <input>'s FileList, so individual files can be removed before upload.
// Persists across reload() so a sort/filter/edit doesn't drop a pending batch.
let selectedFiles = [];
let thumbUrls = [];
let pasteHandlerBound = false;

function revokeThumbUrls() {
  for (const u of thumbUrls) { try { URL.revokeObjectURL(u); } catch (_) { /* noop */ } }
  thumbUrls = [];
}

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type && f.type.startsWith('image/'));
  if (!files.length) return;
  selectedFiles.push(...files);
  renderThumbs();
}

function renderThumbs() {
  const wrap = document.getElementById('resourcesThumbs');
  if (!wrap) return;
  const summary = document.getElementById('resourcesUploadSummary');
  const btn = document.querySelector('[data-action="resources-upload"]');
  revokeThumbUrls();

  if (selectedFiles.length === 0) {
    wrap.innerHTML = '';
    if (summary) summary.textContent = '';
    if (btn) btn.disabled = true;
    return;
  }

  wrap.innerHTML = selectedFiles.map((f, i) => {
    const url = URL.createObjectURL(f);
    thumbUrls.push(url);
    return `<div class="resource-thumb" title="${esc(f.name)}">
      <img src="${url}" alt="">
      <button class="resource-thumb-remove" data-thumb-index="${i}" type="button" aria-label="Remove">×</button>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.resource-thumb-remove').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number.parseInt(b.dataset.thumbIndex, 10);
      if (Number.isFinite(idx)) { selectedFiles.splice(idx, 1); renderThumbs(); }
    });
  });

  const bytes = selectedFiles.reduce((s, f) => s + (f.size || 0), 0);
  if (summary) summary.textContent = `${selectedFiles.length} screenshot${selectedFiles.length === 1 ? '' : 's'} · ${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (btn) btn.disabled = false;
}

// Attach dropzone listeners to the freshly-rendered DOM. Paste is bound once
// globally (guarded by a live-dropzone lookup) so it isn't duplicated per render.
function wireUpload() {
  const dz = document.getElementById('resourcesDropzone');
  const input = document.getElementById('resourcesFileInput');
  if (!dz || !input) return;

  dz.addEventListener('click', (e) => {
    if (e.target.closest('.resource-thumb-remove')) return;
    input.click();
  });
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.add('is-drag');
  }));
  dz.addEventListener('dragleave', (e) => {
    if (dz.contains(e.relatedTarget)) return;
    dz.classList.remove('is-drag');
  });
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('is-drag');
    addFiles(e.dataTransfer?.files);
  });

  if (!pasteHandlerBound) {
    window.addEventListener('paste', (e) => {
      if (!document.getElementById('resourcesDropzone')) return;
      const items = e.clipboardData?.items || [];
      const imgs = [];
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) imgs.push(f); }
      }
      if (imgs.length) { e.preventDefault(); addFiles(imgs); }
    });
    pasteHandlerBound = true;
  }
}

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

// ─── Upload ──────────────────────────────────────────────────────────────────

// Max simultaneous OCR requests. Tesseract is CPU-heavy; 3 keeps throughput
// high without starving the event loop or blowing RAM on too many WASM workers.
const UPLOAD_CONCURRENCY = 3;

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function setUploadProgress(resultEl, current, total) {
  if (!resultEl) return;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  resultEl.querySelector('.upload-progress-header').textContent =
    `Processing ${current} / ${total}…`;
  const bar = resultEl.querySelector('.upload-progress-bar');
  if (bar) {
    bar.classList.remove('upload-progress-indeterminate');
    bar.style.width = `${pct}%`;
  }
}

export async function handleResourcesUpload(reload) {
  const dateInput = document.getElementById('resourcesUploadDate');
  const resultEl = document.getElementById('resourcesUploadResult');
  const btn = document.querySelector('[data-action="resources-upload"]');

  if (!selectedFiles.length) {
    await notify('Please add one or more screenshots first.', 'Upload');
    return;
  }

  const files = selectedFiles.slice();
  // Same reasoning as the field's default (see renderResources): the date is
  // what "TODAY" meant in the screenshot, which is the uploader's local
  // calendar date, not the game day.
  const uploadDate = dateInput?.value || localDateKey();
  const total = files.length;
  const label = total === 1 ? `1 screenshot` : `${total} screenshots`;
  // Captured from the 'done' event so we can offer to resolve any
  // unmatched-resource ("unknown") rows immediately after the import.
  let batchId = null;

  if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
  if (resultEl) {
    resultEl.className = 'resources-upload-result is-loading';
    resultEl.innerHTML = `
      <div class="upload-progress-header">Processing 0 / ${total}…</div>
      <div class="upload-progress-bar-wrap"><div class="upload-progress-bar" style="width:0%"></div></div>
    `;
  }

  try {
    const images = await Promise.all(files.map(toBase64));

    // Use raw fetch so we can stream the NDJSON progress lines as they arrive.
    const response = await fetch('/api/resources/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, uploadDate }),
    });

    if (response.status === 401) { window.location.replace('/login'); return; }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let msg = `HTTP ${response.status}`;
      try { msg = JSON.parse(text).error || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done_event = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep the incomplete trailing fragment
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'progress') {
          setUploadProgress(resultEl, ev.current, ev.total);
        } else if (ev.type === 'done') {
          done_event = ev;
        } else if (ev.type === 'error') {
          throw new Error(ev.error);
        }
      }
    }

    if (!done_event) throw new Error('Server closed the stream without a result.');

    batchId = done_event.batchId ?? null;
    const inserted = done_event.inserted ?? 0;
    const errors = Array.isArray(done_event.errors) ? done_event.errors : [];
    const errCount = errors.length;
    const errDetail = errCount > 0
      ? `<div class="upload-log">${errors.slice(0, 20).map((e) => `<div class="upload-log-error">${esc(e)}</div>`).join('')}</div>`
      : '';
    lastUploadSummary = {
      html: `
        <strong>Done.</strong> ${label} processed — ${inserted} rows inserted${errCount ? `, ${errCount} error${errCount === 1 ? '' : 's'}` : ''}
        <div class="upload-progress-bar-wrap"><div class="upload-progress-bar" style="width:100%"></div></div>
        ${errDetail}
      `,
      cls: errCount > 0 ? 'resources-upload-result upload-mixed' : 'resources-upload-result upload-success',
    };
  } catch (err) {
    lastUploadSummary = {
      html: `<strong>Upload failed:</strong> ${esc(err.message)}`,
      cls: 'resources-upload-result upload-mixed',
    };
  }

  selectedFiles = [];
  revokeThumbUrls();
  if (btn) { btn.disabled = false; btn.textContent = 'Upload & Extract'; }
  reload('resources/admin');

  // If the OCR couldn't match every icon, some rows landed as "unknown".
  // Surface them right away in an editable modal so the admin resolves
  // them in one place instead of hunting them down with the filter and
  // editing each row individually.
  if (batchId != null) {
    await openUnknownResourcesModalForBatch(batchId, reload);
  }
}

/**
 * Status card for automated collection — read-only.
 *
 * Deliberately has no buttons. What used to be here moved out for two different
 * reasons: the daily on/off switch is INSTANCE-WIDE and had no business on a page
 * scoped to one clan (a superadmin could change every clan's behaviour while looking
 * at one of them), and the manual collect/diagnose actions belong beside the per-clan
 * toggle on the Clans page, where the clan they act on is explicit rather than
 * inherited from the active session.
 *
 * What stays is what an admin of THIS clan needs about their own data: whether
 * collection is running, when it last ran, what is double-counted, what needs
 * resolving.
 */
function buildCaptureCardHtml(status) {
  if (!status) return '';

  // Two independent switches, and the card used to report only the first — so a clan
  // excluded from the daily read was told its history "is read once per game day",
  // which is exactly the sort of status line that stops an admin uploading the
  // screenshots they still need to upload.
  const autoOn = !!(status.calibrated && status.enabled && status.clanAutoCapture);

  const stateLine = !status.calibrated
    ? `<p class="muted-copy mb-12"><strong>Not set up yet.</strong> Automated collection needs the
         world-map chain calibrated. A superadmin finishes that under
         <strong>System &rarr; Scanner Calibration</strong> (Stages 5 and 6, plus the MAP button in
         Stage 1).</p>`
    : !status.enabled
      ? `<p class="muted-copy mb-12"><strong>Calibrated, but the daily run is off.</strong> A
           superadmin enables it under <strong>System &rarr; Automated Resource Collection</strong>, and
           can trigger a one-off read for this clan from <strong>Clans &rarr; Resource Tracking</strong>.</p>`
      : status.clanAutoCapture
        ? `<p class="muted-copy mb-12"><strong>On.</strong> This clan's capital history is read once per
             game day, right after the might snapshot &mdash; no uploads needed.</p>`
        : `<p class="muted-copy mb-12"><strong>On for the instance, but this clan is left out.</strong>
             A clan admin ticks <em>Include in the daily automatic read</em> under
             <strong>Clans &rarr; Resource Tracking</strong> to add it. Until then this clan's rows only
             arrive from screenshots uploaded below.</p>`;

  const lastLine = status.lastCapture
    ? `<p class="muted-copy mb-12">Last read: game day <strong>${esc(status.lastCapture.gameDate)}</strong>
         at ${esc(formatDate(status.lastCapture.capturedAt))} &middot;
         ${status.lastCapture.rowsInserted} row(s) recorded.
         ${status.lastCapture.gameDate === status.currentGameDate
           ? "Today's read is done."
           // Only a run that is actually scheduled can be "pending" — saying it of a
           // clan that has been excluded promises something that will never happen.
           : autoOn ? "Today's read is still pending." : ''}</p>`
    : '<p class="muted-copy mb-12">Never read from the game yet.</p>';

  // Overlap is a data-correctness warning, not a status line: until an admin deletes
  // one side, those dates are counted twice in every total on this page.
  const overlapLine = status.overlaps?.length
    ? `<div class="resources-upload-result is-warning mb-12">
         <strong>Double-counted dates.</strong> These dates have rows from BOTH an uploaded
         screenshot and an automated read, so their totals are inflated until you delete one of the
         two batches in Upload History:
         ${esc(status.overlaps.map((ov) => `${ov.transactionDate} (${ov.uploadRows} uploaded + ${ov.scanRows} read)`).join(', '))}.
       </div>`
    : '';

  const unresolvedLine = status.unresolvedCount > 0
    ? `<div class="inline-form-row mb-12">
         <span class="muted-copy"><strong>${status.unresolvedCount}</strong> row(s) have no resource &mdash;
           the icon couldn't be identified. Each kept a crop of the original row.</span>
         <button class="btn" data-action="resources-resolve-unknowns">Resolve ${status.unresolvedCount} row(s)</button>
       </div>`
    : '<p class="muted-copy">No unresolved rows &mdash; every recorded row has a resource.</p>';

  return `
    <details class="card card-collapsible" data-section-key="resources-automated" open>
      <summary class="card-header"><h2>Automated Collection</h2></summary>
      <div class="card-body card-body-padded">
        ${stateLine}
        ${lastLine}
        ${overlapLine}
        ${unresolvedLine}
      </div>
    </details>`;
}

/**
 * Render the debug-screenshot gallery.
 *
 * Fetched separately from the page render and injected, so a few hundred thumbnails
 * can't slow down (or fail) the main admin view. Filenames carry the meaning —
 * p001, p002 … are scroll pages in order, _blank_ is a page where the list went
 * empty and the sweep waited, _final_page_ is where it stopped — so they're shown
 * verbatim rather than prettified into something less precise.
 */
export async function handleResourcesResolveUnknowns(reload) {
  let rows = [];
  try {
    const qs = new URLSearchParams({
      resourceTypeId: 'unknown',
      sortBy: 'date',
      sortDir: 'desc',
      limit: '200',
      offset: '0',
    });
    const res = await api(`/resources/transactions?${qs}`);
    rows = Array.isArray(res?.rows) ? res.rows : [];
  } catch (err) {
    return notify(String(err), 'Could not load unresolved rows');
  }
  if (rows.length === 0) {
    return notify('Nothing left to resolve — every row has a resource.', 'All clear');
  }
  if (!cachedTypes.length) {
    try {
      const typesRes = await api('/resources/types');
      cachedTypes = Array.isArray(typesRes) ? typesRes : (typesRes?.types ?? []);
    } catch (_) { /* fall through with an empty list */ }
  }
  openUnknownResourcesModal(rows, reload);
}

// ─── Post-import: resolve unknown-resource rows ────────────────────────────────

// Fetch the just-imported batch's unmatched-resource rows and, if any exist,
// pop the editable modal. Silent no-op when the batch imported cleanly.
async function openUnknownResourcesModalForBatch(batchId, reload) {
  let rows = [];
  try {
    const qs = new URLSearchParams({
      batchId: String(batchId),
      resourceTypeId: 'unknown',
      sortBy: 'date',
      sortDir: 'asc',
      limit: '200',
      offset: '0',
    });
    // Use a standalone signal so the reload() that just fired can't abort
    // this read via the shared page-navigation signal.
    const res = await api(`/resources/transactions?${qs}`, { signal: new AbortController().signal });
    rows = Array.isArray(res?.rows) ? res.rows : [];
  } catch (_) {
    return; // The main table still shows the unknowns; the modal is a bonus.
  }
  if (rows.length === 0) return;

  // The resource dropdown needs the type list. It's populated on every admin
  // render (which just happened), but fetch as a fallback for robustness.
  if (!cachedTypes.length) {
    try {
      const typesRes = await api('/resources/types');
      cachedTypes = Array.isArray(typesRes) ? typesRes : (typesRes?.types ?? []);
    } catch (_) { /* fall through with an empty list */ }
  }

  openUnknownResourcesModal(rows, reload);
}

// Hover affordance for a row the importer left unresolved. data-crop-wide because
// a history row is wide and short, so it needs more width than a chest crop.
function cropHoverHtml(tx) {
  if (!tx.hasCrop) return '<span class="muted-copy">—</span>';
  return `<span class="unknown-crop-hover" data-crop-url="/api/resources/transactions/${tx.id}/crop"`
    + ` data-crop-wide tabindex="0" role="button"`
    + ` title="Hover to preview the screenshot row this came from — click to enlarge">🖼️</span>`;
}

function unknownRowHtml(tx) {
  const typeOptions = [
    `<option value="">— Unknown —</option>`,
    ...cachedTypes.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`),
  ].join('');
  return `
    <tr data-unknown-row="${tx.id}">
      <td data-label="Row" class="col-crop">${cropHoverHtml(tx)}</td>
      <td data-label="Member">${esc(tx.memberName ?? tx.rawPlayerName ?? '—')}</td>
      <td data-label="Resource">
        <select class="input input-tight" data-field="resource" autocomplete="off">${typeOptions}</select>
      </td>
      <td data-label="Direction">
        <select class="input input-tight" data-field="direction">
          <option value="1"  ${tx.direction === 1  ? 'selected' : ''}>Sent</option>
          <option value="-1" ${tx.direction === -1 ? 'selected' : ''}>Took</option>
        </select>
      </td>
      <td data-label="Amount">
        <input type="number" class="input input-tight" data-field="amount" value="${esc(String(tx.amount))}" min="1" step="1">
      </td>
      <td data-label="Date">
        <input type="date" class="input input-tight" data-field="date" lang="sv" value="${esc(tx.transactionDate)}">
      </td>
      <td class="col-tx-actions">
        <button class="btn btn-tight btn-primary" data-unknown-save="${tx.id}">Save</button>
        <span class="unknown-row-status" aria-live="polite"></span>
      </td>
    </tr>`;
}

// Build and show the "Resolve Unknown Resources" overlay. Self-contained:
// it wires its own listeners (it lives in #modalRoot, outside the delegated
// #content listener) and reloads the admin page once on close so the main
// table reflects every fix.
function openUnknownResourcesModal(rows, reload) {
  const root = document.getElementById('modalRoot');
  if (!root) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card modal-card-wide unknown-modal" role="dialog" aria-modal="true" aria-label="Resolve unknown resources">
      <div class="modal-title">Resolve unknown resources</div>
      <p class="modal-form-hint unknown-modal-hint">
        The importer couldn't identify the resource for
        <strong class="unknown-remaining">${rows.length}</strong>
        row${rows.length === 1 ? '' : 's'}. Hover the 🖼️ in the Row column to preview the
        screenshot row each one came from — or click it to open a zoomable full-size
        view — then pick the correct resource and save. The other fields are
        pre-filled from the screenshot and can be edited too.
      </p>
      <div class="unknown-modal-scroll">
        <table class="unknown-modal-table">
          <thead><tr>
            <th>Row</th><th>Member</th><th>Resource</th><th>Direction</th><th>Amount</th><th>Date</th><th></th>
          </tr></thead>
          <tbody>${rows.map(unknownRowHtml).join('')}</tbody>
        </table>
      </div>
      <div class="modal-actions">
        <button class="btn unknown-modal-close">Close</button>
        <button class="btn btn-primary unknown-modal-save-all">Save all</button>
      </div>
    </div>
  `;

  root.appendChild(overlay);
  // The modal lives in #modalRoot, outside the delegated #content listeners, so it
  // wires its own hover previews.
  attachCropPreviews(overlay);
  requestAnimationFrame(() => {
    overlay.classList.add('visible');
    // Focus the first resource dropdown so the operator can pick-and-save
    // straight from the keyboard without reaching for the mouse.
    overlay.querySelector('select[data-field="resource"]')?.focus();
  });

  let dirty = false; // any successful save → reload the admin page on close
  const remainingEl = overlay.querySelector('.unknown-remaining');
  const saveAllBtn = overlay.querySelector('.unknown-modal-save-all');
  const closeBtn = overlay.querySelector('.unknown-modal-close');

  const remainingCount = () => overlay.querySelectorAll('tr[data-unknown-row]:not(.is-resolved)').length;
  const refreshRemaining = () => {
    const n = remainingCount();
    if (remainingEl) remainingEl.textContent = String(n);
    if (n === 0 && saveAllBtn) { saveAllBtn.disabled = true; saveAllBtn.textContent = 'All resolved'; }
    if (closeBtn) closeBtn.textContent = n === 0 ? 'Done' : 'Close';
  };

  const cleanup = () => {
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 180);
    document.removeEventListener('keydown', onKey);
    if (dirty) reload('resources/admin');
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
  };
  document.addEventListener('keydown', onKey);

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
        if (statusEl) { statusEl.textContent = 'Pick a resource'; statusEl.className = 'unknown-row-status is-error'; }
        return false;
      }
      return false; // Save-all: leave unresolved rows untouched.
    }

    const resourceTypeId = Number.parseInt(resourceVal, 10);
    const direction = Number.parseInt(rowEl.querySelector('[data-field="direction"]').value, 10);
    const amount = Number.parseInt(rowEl.querySelector('[data-field="amount"]').value, 10);
    const transactionDate = rowEl.querySelector('[data-field="date"]').value;

    if (!Number.isFinite(amount) || amount <= 0) {
      if (statusEl) { statusEl.textContent = 'Bad amount'; statusEl.className = 'unknown-row-status is-error'; }
      return false;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) {
      if (statusEl) { statusEl.textContent = 'Bad date'; statusEl.className = 'unknown-row-status is-error'; }
      return false;
    }

    try {
      const res = await apiPatch(`/resources/transactions/${txId}`, { resourceTypeId, direction, amount, transactionDate });
      if (res?.error) {
        if (statusEl) { statusEl.textContent = res.error; statusEl.className = 'unknown-row-status is-error'; }
        return false;
      }
    } catch (err) {
      if (statusEl) { statusEl.textContent = err.message || 'Save failed'; statusEl.className = 'unknown-row-status is-error'; }
      return false;
    }

    dirty = true;
    rowEl.classList.add('is-resolved');
    rowEl.querySelectorAll('select, input, button').forEach((c) => { c.disabled = true; });
    if (statusEl) { statusEl.textContent = '✓ Saved'; statusEl.className = 'unknown-row-status is-ok'; }
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
        notify(`Saved ${saved}. ${left} row${left === 1 ? '' : 's'} still need a resource picked.`, 'Resources');
      } else {
        notify(`Saved ${saved} row${saved === 1 ? '' : 's'}.`, 'Saved');
      }
    }
  });
}

// ─── Batch delete ─────────────────────────────────────────────────────────────

export async function handleResourcesBatchDelete(batchId, reload) {
  if (!batchId) return;
  const ok = await confirmDialog('Delete this upload batch and all its transactions?');
  if (!ok) return;
  try {
    await apiDelete(`/resources/batches/${batchId}`);
    reload('resources/admin');
  } catch (err) {
    await notify('Delete failed: ' + err.message, 'Error');
  }
}

// ─── Inline edit ─────────────────────────────────────────────────────────────

export function handleResourcesTxEdit(txId) {
  const row = document.querySelector(`tr[data-tx-row="${txId}"]`);
  if (!row) return;
  const d = row.dataset;
  const selectedType = cachedTypes.find((t) => String(t.id) === d.txResourceId);
  const isSpeedup = selectedType?.slug === 'clan-speedup';
  const typeOptions = [
    `<option value="">— Unknown —</option>`,
    ...cachedTypes.map((t) =>
      `<option value="${t.id}" ${String(t.id) === d.txResourceId ? 'selected' : ''}>${esc(t.name)}</option>`
    ),
  ].join('');
  const initDays  = isSpeedup ? Math.floor(Number(d.txAmount) / 24) : 0;
  const initHours = isSpeedup ? Number(d.txAmount) % 24 : 0;
  const amountCell = isSpeedup
    ? `<div class="speedup-amount-edit">
         <div class="speedup-amount-row">
           <input type="number" class="input input-tight" id="txEditAmountD-${txId}" value="${initDays}" min="0" step="1"> d
         </div>
         <div class="speedup-amount-row">
           <input type="number" class="input input-tight" id="txEditAmountH-${txId}" value="${initHours}" min="0" step="1"> h
         </div>
       </div>`
    : `<input type="number" class="input input-tight" id="txEditAmount-${txId}" value="${esc(d.txAmount)}" min="1" step="1">`;

  row.innerHTML = `
    <td data-label="Member">${esc(d.txMemberName)}</td>
    <td data-label="Resource"><select class="input input-tight" id="txEditResource-${txId}">${typeOptions}</select></td>
    <td data-label="Direction">
      <select class="input input-tight" id="txEditDir-${txId}">
        <option value="1"  ${d.txDirection === '1'  ? 'selected' : ''}>Sent</option>
        <option value="-1" ${d.txDirection === '-1' ? 'selected' : ''}>Took</option>
      </select>
    </td>
    <td data-label="Amount">${amountCell}</td>
    <td data-label="Date"><input type="date"   class="input input-tight" id="txEditDate-${txId}"   lang="sv" value="${esc(d.txDate)}"></td>
    <td data-label="" class="col-tx-actions">
      <button class="btn btn-tight btn-primary" data-action="resources-tx-save" data-tx-id="${txId}">Save</button>
      <button class="btn btn-tight"             data-action="resources-tx-cancel">Cancel</button>
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
    await notify('Amount must be positive.', 'Validation');
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) {
    await notify('Date is required.', 'Validation');
    return;
  }

  try {
    const res = await apiPatch(`/resources/transactions/${txId}`, { resourceTypeId, direction, amount, transactionDate });
    if (res?.error) {
      await notify('Save failed: ' + res.error, 'Error');
      return;
    }
    reload('resources/admin');
  } catch (err) {
    await notify('Save failed: ' + err.message, 'Error');
  }
}

export function handleResourcesTxCancel(reload) {
  reload('resources/admin');
}

// ─── Main render ─────────────────────────────────────────────────────────────

export async function renderResourcesAdmin(el, navigate) {
  const user = getCurrentUser();
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    el.innerHTML = '<div class="card"><div class="card-body"><p>Admin access required.</p></div></div>';
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

  const [txRes, batchRes, captureRes] = await Promise.all([
    api(`/resources/transactions?${qs}`),
    api('/resources/batches'),
    // Status of automated collection. Tolerated as null so an older server (or a
    // transient failure) degrades to hiding one card rather than blanking the page.
    api('/resources/capture-status').catch(() => null),
  ]);

  const transactions = Array.isArray(txRes?.rows) ? txRes.rows : [];
  const total = txRes?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const batches = Array.isArray(batchRes) ? batchRes : (batchRes?.batches ?? []);

  // Default (and cap) the upload date to the uploader's OWN calendar date, not
  // the game day.
  //
  // This field answers one question: what did "TODAY" mean in the screenshot?
  // The game's history list renders that header client-side and buckets rows at
  // the browser's local midnight — so for a hand-taken screenshot it means the
  // calendar date of the device that took it, which is this admin's. The
  // scanner gets the same answer by being pinned to a zone whose midnight is
  // the 17:00 rollover (src/config/game-timezone.ts); nothing can pin an
  // admin's phone, so the honest default here is their local date.
  //
  // Defaulting to the game day, as this did, dated every upload made between
  // local midnight and 17:00 UTC a day early.
  const uploadDateKey = localDateKey();
  const arrow = (key) => filters.sortBy === key ? (filters.sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const memberOptions = allMembers.map((m) =>
    `<option value="${m.id}" ${String(m.id) === filters.memberId ? 'selected' : ''}>${esc(m.name)}</option>`
  ).join('');

  const typeOptions = allTypes.map((t) =>
    `<option value="${t.id}" ${String(t.id) === filters.resourceTypeId ? 'selected' : ''}>${esc(t.name)}</option>`
  ).join('');

  const txRows = transactions.length === 0
    ? `<tr><td colspan="6" class="empty-state-cell">No transactions match the current filters.</td></tr>`
    : transactions.map((tx) => `
        <tr data-tx-row="${tx.id}"
            data-tx-member-name="${esc(tx.memberName ?? tx.rawPlayerName ?? '')}"
            data-tx-resource-id="${tx.resourceTypeId ?? ''}"
            data-tx-direction="${tx.direction}"
            data-tx-amount="${tx.amount}"
            data-tx-date="${esc(tx.transactionDate)}">
          <td data-label="Member" data-role="primary"><span class="mrow-name">${esc(tx.memberName ?? tx.rawPlayerName ?? '—')}</span></td>
          <td data-label="Resource">${resourceIconHtml(tx.resourceTypeSlug, tx.resourceTypeName ?? 'Unknown')}${tx.hasCrop ? ` ${cropHoverHtml(tx)}` : ''}</td>
          <td data-label="Direction">${directionPillHtml(tx.direction)}</td>
          <td data-label="Amount" class="col-num" data-role="metric">${formatTxAmount(tx)}</td>
          <td data-label="Date">${esc(formatGameDayShort(tx.transactionDate))}</td>
          <td class="col-tx-actions">
            <button class="btn btn-tight" data-action="resources-tx-edit" data-tx-id="${tx.id}">Edit</button>
          </td>
        </tr>`
    ).join('');

  const pagination = total > PAGE_SIZE ? `
    <div class="pagination">
      <button class="btn btn-tight" data-action="resources-page-prev" ${currentPage <= 1 ? 'disabled' : ''}>← Prev</button>
      <span class="pagination-info">Page ${currentPage} of ${totalPages} · ${total} rows</span>
      <button class="btn btn-tight" data-action="resources-page-next" ${currentPage >= totalPages ? 'disabled' : ''}>Next →</button>
    </div>
  ` : '';

  const batchRows = batches.length === 0
    ? `<tr><td colspan="7" class="empty-state-cell">No uploads yet.</td></tr>`
    : batches.map((b) => {
        // An automated batch is a scroll sweep, not a pile of files — so its
        // file_count is pages. Labelling both the same would misreport one of them.
        const isScan = b.source === 'scan';
        const unit = isScan ? 'pages' : 'files';
        return `
        <tr>
          <td data-label="Imported" data-role="primary"><span class="mrow-name">${esc(formatDate(b.uploadedAt))}</span><span class="mrow-sub">${esc(String(b.fileCount ?? 1))} ${unit}</span></td>
          <td data-label="Source">${isScan
            ? '<span class="resource-direction resource-batch-auto" title="Read from the game by the automated capture">Automatic</span>'
            : '<span class="resource-direction resource-batch-upload" title="Screenshots uploaded by an admin">Upload</span>'}</td>
          <td data-label="Screenshot Date">${esc(formatGameDayShort(b.uploadDate))}</td>
          <td data-label="${isScan ? 'Pages' : 'Files'}" class="col-num">${b.fileCount ?? 1}</td>
          <td data-label="Rows"    class="col-num" data-role="metric">${b.rowCount}</td>
          <td data-label="Errors"  class="col-num">${b.errorCount}</td>
          <td class="col-actions">
            <button class="btn btn-tight btn-danger" data-action="resources-batch-delete" data-batch-id="${b.id}">Delete</button>
          </td>
        </tr>`;
      }).join('');

  const captureCardHtml = buildCaptureCardHtml(captureRes);

  // Is the game reading this clan's history by itself? All four have to be true —
  // the instance schedule, this clan's inclusion in it, resource tracking for the
  // clan, and a finished calibration — because any one of them being off means the
  // daily read never happens and screenshots are the only way data arrives.
  //
  // When it IS all on, uploading is redundant work that also creates the
  // double-counted dates the card above warns about, so the section starts
  // collapsed rather than being the first thing on the page. Still one click away,
  // and expanding it survives a rerender (lib/ui.js remembers the choice per page).
  const autoCollecting = !!(
    captureRes?.enabled
    && captureRes?.clanAutoCapture
    && captureRes?.clanEnabled
    && captureRes?.calibrated
  );

  el.innerHTML = `
    ${resourceTabsHtml('admin')}
    ${captureCardHtml}
    <details class="card card-collapsible" data-section-key="resources-upload" ${autoCollecting ? '' : 'open'}>
      <summary class="card-header"><h2>Upload Screenshots${autoCollecting
        ? ' <span class="muted-copy">· not needed while the daily read is on</span>'
        : ''}</h2></summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy">Upload <strong>History</strong> screenshots from the game. Each screenshot can contain many players — every "sent / took resources" row is read and matched to its clan member automatically. Add as many screenshots as you like.</p>
        <div class="resources-dropzone" id="resourcesDropzone" tabindex="0" role="button" aria-label="Add screenshots by dropping, pasting, or clicking to browse">
          <input type="file" id="resourcesFileInput" accept="image/*" multiple class="is-hidden">
          <div class="resources-dropzone-inner">
            <div class="resources-dropzone-icon" aria-hidden="true">🖼️</div>
            <div class="resources-dropzone-text"><strong>Drop screenshots here</strong>, paste from clipboard, or <span class="resources-dropzone-browse">browse</span></div>
            <div class="resources-dropzone-hint">PNG or JPEG · multiple files · many players per screenshot</div>
          </div>
        </div>
        <div class="resources-thumbs" id="resourcesThumbs"></div>
        <div class="resources-upload-actions">
          <label class="resources-upload-label" for="resourcesUploadDate">Screenshot date</label>
          <input type="date" id="resourcesUploadDate" class="input" lang="sv" value="${uploadDateKey}" max="${uploadDateKey}" title="What &quot;Today&quot; meant in these screenshots — your own calendar date when you took them.">
          <span class="resources-upload-summary" id="resourcesUploadSummary"></span>
          <button class="btn btn-primary" data-action="resources-upload" disabled>Upload &amp; Extract</button>
        </div>
        <div id="resourcesUploadResult" class="resources-upload-result is-hidden"></div>
      </div>
    </details>

    <div class="card">
      <div class="card-header"><h2>Resource History</h2></div>
      <div class="card-body">
        <div class="resources-filter-bar">
          <select class="input resource-filter-select" data-filter-key="memberId" aria-label="Filter by member">
            <option value="">All members</option>
            ${memberOptions}
          </select>
          <select class="input resource-filter-select" data-filter-key="resourceTypeId" aria-label="Filter by resource">
            <option value="">All resources</option>
            <option value="unknown" ${filters.resourceTypeId === 'unknown' ? 'selected' : ''}>— Unknown —</option>
            ${typeOptions}
          </select>
          <select class="input resource-filter-select" data-filter-key="direction" aria-label="Filter by direction">
            <option value=""  ${filters.direction === ''   ? 'selected' : ''}>All directions</option>
            <option value="1" ${filters.direction === '1'  ? 'selected' : ''}>Sent</option>
            <option value="-1"${filters.direction === '-1' ? 'selected' : ''}>Took</option>
          </select>
          <input type="date" id="resourcesDateFrom" class="input" lang="sv" value="${esc(filters.from)}" aria-label="From date">
          <input type="date" id="resourcesDateTo"   class="input" lang="sv" value="${esc(filters.to)}"   aria-label="To date">
          <button class="btn" data-action="resources-apply-filters">Apply</button>
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
            <th class="sortable" data-action="resources-sort" data-sort-key="member_name">Member${arrow('member_name')}</th>
            <th class="sortable" data-action="resources-sort" data-sort-key="resource_type">Resource${arrow('resource_type')}</th>
            <th class="sortable" data-action="resources-sort" data-sort-key="direction">Direction${arrow('direction')}</th>
            <th class="sortable" data-action="resources-sort" data-sort-key="amount">Amount${arrow('amount')}</th>
            <th class="sortable" data-action="resources-sort" data-sort-key="transaction_date">Date${arrow('transaction_date')}</th>
            <th></th>
          </tr></thead>
          <tbody>${txRows}</tbody>
        </table>
        ${pagination}
      </div>
    </div>

    <details class="card card-collapsible" data-section-key="resources-upload-history">
      <summary class="card-header"><h2>Upload History</h2></summary>
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
            <th>Imported</th>
            <th>Source</th>
            <th>Screenshot Date</th>
            <th class="col-num">Files</th>
            <th class="col-num">Rows</th>
            <th class="col-num">Errors</th>
            <th></th>
          </tr></thead>
          <tbody>${batchRows}</tbody>
        </table>
      </div>
    </details>
  `;

  // Restore the upload summary banner that was stored before reload().
  if (lastUploadSummary) {
    const resultEl = document.getElementById('resourcesUploadResult');
    if (resultEl) {
      resultEl.className = lastUploadSummary.cls;
      resultEl.innerHTML = lastUploadSummary.html;
    }
    lastUploadSummary = null;
  }

  // Wire the dropzone and re-render any pending thumbnails (selectedFiles
  // survives reload, so a sort/filter/edit keeps a staged batch intact).
  wireUpload();
  renderThumbs();

}
