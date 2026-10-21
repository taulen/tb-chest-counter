// Chest Points — the global scoring table on the Admin page, one line per
// chest SOURCE (see src/data/points-board.ts for why a source is the unit).
//
// Self-contained: it fetches its own data and re-renders only itself, so a
// save or a recalculate never reloads the page or loses the admin's place.
// Edits are kept in module state until saved — switching category, searching,
// or a re-render of the Admin page around it keeps them — and every save or
// recalculate is previewed (records + points that will move, per clan) before
// anything is written.

import { api, apiPost } from '../lib/api.js';
import { esc, notify, contentModal } from '../lib/ui.js';

const CATEGORY_STORE_KEY = 'pointsBoard.category';
const NEEDS_VALUE = 'needs-value';
const ALL = 'all';

const state = {
  board: null,
  category: null,
  query: '',
  /** `${sourceKey}\t${chestName}` → edited value (string, as typed). */
  dirty: new Map(),
  /** Source keys whose chest list is open. */
  expanded: new Set(),
  /** sourceKey → Set of chest names given their own line before any edit. */
  split: new Map(),
  busy: false,
};

let root = null;
let canEdit = false;

// Edits live in this module until saved, so a reload or closing the tab would
// drop them silently — ask first, the way an unsaved form does.
window.addEventListener('beforeunload', (e) => {
  if (state.dirty.size === 0) return;
  e.preventDefault();
  e.returnValue = '';
});

const fmt = (n) => Number(n || 0).toLocaleString();
const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '±0');
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const dirtyKey = (sourceKey, chestName) => `${sourceKey}\t${chestName}`;

function storedCategory() {
  try { return localStorage.getItem(CATEGORY_STORE_KEY); } catch { return null; }
}
function rememberCategory(key) {
  try { localStorage.setItem(CATEGORY_STORE_KEY, key); } catch { /* private mode */ }
}

/**
 * Mount the board into `el`. Called on every Admin render; module state
 * (category, search, unsaved edits, open rows) survives the re-render.
 */
export async function mountPointsBoard(el, { isSuperadmin }) {
  root = el;
  canEdit = Boolean(isSuperadmin);
  root.innerHTML = shellHtml();
  wire();
  await refresh();
}

async function refresh() {
  const board = await api('/admin/source-points');
  if (!root?.isConnected) return;
  if (!board || board.error || !Array.isArray(board.sources)) {
    root.querySelector('.pb-body').innerHTML = `<p class="muted-copy">Couldn't load chest points${board?.error ? `: ${esc(board.error)}` : ''}.</p>`;
    return;
  }
  state.board = board;
  // Drop edits for anything that no longer exists, or now already holds the
  // edited value (someone else saved the same thing).
  for (const [k, v] of state.dirty) {
    const [sourceKey, chestName] = k.split('\t');
    const cur = currentValue(sourceKey, chestName);
    if (cur === null || String(cur) === v) state.dirty.delete(k);
  }
  if (!state.category || !validCategory(state.category)) {
    const saved = storedCategory();
    state.category = validCategory(saved) ? saved
      : board.sources.some((s) => s.unset) ? NEEDS_VALUE
        : board.categories[0]?.key || ALL;
  }
  render();
}

function validCategory(key) {
  if (!key || !state.board) return false;
  if (key === ALL) return true;
  if (key === NEEDS_VALUE) return state.board.sources.some((s) => s.unset);
  return state.board.categories.some((c) => c.key === key);
}

function findSource(sourceKey) {
  return state.board?.sources.find((s) => s.key === sourceKey) || null;
}

function currentValue(sourceKey, chestName) {
  const src = findSource(sourceKey);
  if (!src) return null;
  if (chestName === '') return src.points;
  const chest = src.chests.find((c) => c.name === chestName);
  return chest ? chest.points : null;
}

function shellHtml() {
  return `
    <div class="card-header pb-header">
      <h2>Chest Points</h2>
      ${canEdit ? '<button class="btn btn-tight" type="button" data-pb="recalc">Recalculate</button>' : ''}
    </div>
    <div class="card-body card-body-padded pb-body"><p class="is-loading">Loading chest points…</p></div>
  `;
}

// ─── Rendering ───

function render() {
  // Recalculate only ever has work when records are out of date — say so on
  // the button rather than letting it look like the step that applies a save.
  const recalc = root.querySelector('[data-pb="recalc"]');
  if (recalc) {
    const stale = state.board.staleRecords;
    recalc.textContent = stale > 0 ? `Recalculate ${fmt(stale)} out of date` : 'Recalculate';
    recalc.title = stale > 0
      ? 'Bring stored chest records that no longer match their source value back in line'
      : 'Every stored chest record already matches — nothing to recalculate';
  }
  const body = root.querySelector('.pb-body');
  const focusKey = document.activeElement?.closest?.('.pb-board') ? document.activeElement.dataset.pbKey : null;
  body.innerHTML = `
    <div class="pb-board">
      ${statusHtml()}
      <div class="pb-toolbar">
        <input type="search" class="input pb-search" placeholder="Search sources or chests…" aria-label="Search sources or chests" value="${esc(state.query)}" data-pb="search">
      </div>
      ${chipsHtml()}
      <div class="pb-list" role="list">${listHtml()}</div>
      ${canEdit ? saveBarHtml() : ''}
    </div>
  `;
  if (focusKey) body.querySelector(`[data-pb-key="${CSS.escape(focusKey)}"]`)?.focus();
}

function statusHtml() {
  const b = state.board;
  const unset = b.sources.filter((s) => s.unset).length;
  const parts = [
    `<span>${plural(b.sources.length, 'source')}</span>`,
    unset > 0
      ? `<span class="pb-flag">⚠ ${plural(unset, 'source')} with no value yet</span>`
      : '<span>✓ every source has a value</span>',
    b.staleRecords > 0
      ? `<span class="pb-flag">⟳ ${plural(b.staleRecords, 'record')} out of date${canEdit ? ' — Recalculate fixes it' : ''}</span>`
      : '<span>✓ all stored records match these values</span>',
  ];
  return `
    <p class="muted-copy pb-intro">One <strong>global</strong> table: what each chest source is worth, for every clan. Most sources pay one value for every chest they drop; the few that pay some chests differently list those under the source.${canEdit ? ' Saving a value also updates every chest already recorded from that source, so a save never needs a Recalculate.' : ' <strong>Read-only</strong> — only a superadmin can change values.'}</p>
    <div class="pb-status">${parts.join('<span class="pb-dot" aria-hidden="true">·</span>')}</div>
  `;
}

function chipsHtml() {
  const b = state.board;
  const unset = b.sources.filter((s) => s.unset).length;
  const chips = [];
  if (unset > 0) chips.push({ key: NEEDS_VALUE, title: '⚠ Needs a value', count: unset, flag: true });
  for (const c of b.categories) chips.push({ key: c.key, title: c.title, count: c.sources, edited: editedIn(c.key) });
  chips.push({ key: ALL, title: 'All', count: b.sources.length });
  const searching = state.query.trim() !== '';
  return `
    <div class="pb-chips" role="group" aria-label="Source category">
      ${chips.map((c) => {
        const active = !searching && state.category === c.key;
        return `<button type="button" class="pb-chip${active ? ' active' : ''}${c.flag ? ' pb-chip-flag' : ''}" data-pb="category" data-category="${c.key}" aria-pressed="${active}">
          ${esc(c.title)} <span class="pb-chip-count">${fmt(c.count)}</span>${c.edited ? `<span class="pb-chip-edited" title="${plural(c.edited, 'unsaved edit')}">● ${fmt(c.edited)}</span>` : ''}
        </button>`;
      }).join('')}
    </div>
  `;
}

function editedIn(category) {
  let n = 0;
  for (const k of state.dirty.keys()) {
    if (findSource(k.split('\t')[0])?.category === category) n++;
  }
  return n;
}

function visibleSources() {
  const q = state.query.trim().toLowerCase();
  const all = state.board.sources;
  if (q) {
    return all.filter((s) => s.label.toLowerCase().includes(q)
      || s.source.toLowerCase().includes(q)
      || s.chests.some((c) => c.name.toLowerCase().includes(q)));
  }
  if (state.category === ALL) return all;
  if (state.category === NEEDS_VALUE) return all.filter((s) => s.unset);
  return all.filter((s) => s.category === state.category);
}

function listHtml() {
  const sources = visibleSources();
  if (sources.length === 0) {
    return `<p class="muted-copy pb-empty">${state.query.trim() ? `Nothing matches “${esc(state.query.trim())}”.` : 'Nothing here.'}</p>`;
  }
  // Across categories (search, All) a heading per category keeps the list
  // scannable; inside one category it would only repeat the chip.
  const grouped = state.query.trim() !== '' || state.category === ALL || state.category === NEEDS_VALUE;
  const titles = new Map(state.board.categories.map((c) => [c.key, c.title]));
  let last = null;
  return sources.map((s) => {
    const heading = grouped && s.category !== last
      ? `<div class="pb-group" role="presentation">${esc(titles.get(s.category) || s.category)}</div>` : '';
    last = s.category;
    return heading + sourceHtml(s);
  }).join('');
}

function valueControl(sourceKey, chestName, value, label) {
  const k = dirtyKey(sourceKey, chestName);
  const edited = state.dirty.has(k);
  const shown = edited ? state.dirty.get(k) : String(value);
  if (!canEdit) return `<span class="pb-value-static">${fmt(value)}</span>`;
  return `
    <label class="pb-value${edited ? ' is-edited' : ''}">
      <input type="number" class="input pb-input" min="0" step="1" inputmode="numeric"
        value="${esc(shown)}" data-pb="value" data-pb-key="${esc(k)}"
        data-source-key="${esc(sourceKey)}" data-chest-name="${esc(chestName)}"
        aria-label="Points for ${esc(label)}">
      <span class="pb-unit" aria-hidden="true">pts</span>
    </label>
    ${edited ? `<span class="pb-was">not saved · was ${fmt(value)}</span>` : ''}
  `;
}

function sourceHtml(s) {
  const exceptions = s.chests.filter((c) => c.points !== s.points || state.split.get(s.key)?.has(c.name));
  const followers = s.chests.filter((c) => !exceptions.includes(c));
  // A search that only matches a chest name opens the row, so the chest it
  // found is on screen rather than behind a ▸.
  const q = state.query.trim().toLowerCase();
  const foundByChest = q !== ''
    && !s.label.toLowerCase().includes(q) && !s.source.toLowerCase().includes(q)
    && s.chests.some((c) => c.name.toLowerCase().includes(q));
  const open = state.expanded.has(s.key) || foundByChest;
  const anyEdited = [...state.dirty.keys()].some((k) => k.startsWith(`${s.key}\t`));
  const meta = [
    plural(s.records, 'chest'),
    s.chests.length > 1 ? plural(s.chests.length, 'kind') : esc(s.chests[0]?.name || ''),
  ];
  if (exceptions.length > 0) meta.push(`<span class="pb-meta-exc">${plural(exceptions.length, 'exception')}</span>`);
  if (s.staleRecords > 0) meta.push(`<span class="pb-flag">⟳ ${fmt(s.staleRecords)} out of date</span>`);
  const expandable = s.chests.length > 1 || exceptions.length > 0;

  return `
    <div class="pb-row${s.unset ? ' is-unset' : ''}${anyEdited ? ' has-edits' : ''}${open ? ' is-open' : ''}" role="listitem">
      <div class="pb-main">
        <div class="pb-name">
          <span class="pb-label" title="${esc(s.source)}">${esc(s.label)}</span>
          ${s.unset ? '<span class="badge-warn">⚠ Needs a value</span>' : ''}
          <span class="pb-meta">${meta.join(' · ')}</span>
        </div>
        <div class="pb-control">${valueControl(s.key, '', s.points, s.label)}</div>
        ${expandable
          ? `<button type="button" class="pb-expand" data-pb="expand" data-source-key="${esc(s.key)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} chests for ${esc(s.label)}"><span aria-hidden="true">${open ? '▾' : '▸'}</span></button>`
          : '<span class="pb-expand-spacer"></span>'}
      </div>
      ${expandable && open ? detailHtml(s, exceptions, followers) : ''}
    </div>
  `;
}

function detailHtml(s, exceptions, followers) {
  const exRows = exceptions
    .slice()
    .sort((a, b) => b.records - a.records)
    .map((c) => `
      <div class="pb-exc">
        <div class="pb-name">
          <span class="pb-chest-name">${esc(c.name)}</span>
          ${c.unset ? '<span class="badge-warn">⚠ Needs a value</span>' : ''}
          <span class="pb-meta">${plural(c.records, 'chest')}</span>
        </div>
        <div class="pb-control">${valueControl(s.key, c.name, c.points, `${c.name} from ${s.label}`)}</div>
        ${canEdit ? `<button type="button" class="pb-reset" data-pb="follow" data-source-key="${esc(s.key)}" data-chest-name="${esc(c.name)}" title="Pay the source's value instead" aria-label="${esc(c.name)}: pay the source's value instead">↺</button>` : '<span class="pb-expand-spacer"></span>'}
      </div>`).join('');

  const chips = followers
    .slice()
    .sort((a, b) => b.records - a.records)
    .map((c) => canEdit
      ? `<button type="button" class="pb-follower" data-pb="split" data-source-key="${esc(s.key)}" data-chest-name="${esc(c.name)}" title="Give ${esc(c.name)} its own value">${esc(c.name)} <span class="pb-chip-count">${fmt(c.records)}</span></button>`
      : `<span class="pb-follower">${esc(c.name)} <span class="pb-chip-count">${fmt(c.records)}</span></span>`)
    .join('');

  return `
    <div class="pb-detail">
      ${followers.length > 0 ? `
        <div class="pb-followers-label">Pays the source value (<span class="pb-source-echo">${fmt(state.dirty.get(dirtyKey(s.key, '')) ?? s.points)}</span>):${canEdit ? ' <span class="muted-copy">click a chest to give it its own value</span>' : ''}</div>
        <div class="pb-followers">${chips}</div>` : ''}
      ${exceptions.length > 0 ? `<div class="pb-followers-label">Pays its own value:</div>${exRows}` : ''}
    </div>
  `;
}

function saveBarHtml() {
  const n = state.dirty.size;
  return `
    <div class="pb-savebar${n > 0 ? ' is-visible' : ''}" ${n > 0 ? '' : 'hidden'}>
      <span class="pb-savebar-text">● ${plural(n, 'unsaved change')}</span>
      <div class="pb-savebar-actions">
        <button type="button" class="btn btn-tight" data-pb="discard">Discard</button>
        <button type="button" class="btn btn-tight btn-primary" data-pb="review">Review &amp; save</button>
      </div>
    </div>
  `;
}

/** Refresh the bits an edit changes without rebuilding the list under the cursor. */
function updateEditChrome(input) {
  const label = input.closest('.pb-value');
  const k = input.dataset.pbKey;
  const edited = state.dirty.has(k);
  label?.classList.toggle('is-edited', edited);
  const control = input.closest('.pb-control');
  let was = control?.querySelector('.pb-was');
  if (edited && !was && control) {
    was = document.createElement('span');
    was.className = 'pb-was';
    control.appendChild(was);
  }
  if (was) {
    if (edited) was.textContent = `not saved · was ${fmt(currentValue(input.dataset.sourceKey, input.dataset.chestName))}`;
    else was.remove();
  }
  const row = input.closest('.pb-row');
  if (row) {
    const key = input.dataset.sourceKey;
    row.classList.toggle('has-edits', [...state.dirty.keys()].some((d) => d.startsWith(`${key}\t`)));
    if (input.dataset.chestName === '') {
      const echo = row.querySelector('.pb-source-echo');
      if (echo) echo.textContent = fmt(state.dirty.get(k) ?? currentValue(key, ''));
    }
  }
  const board = root.querySelector('.pb-board');
  const bar = board?.querySelector('.pb-savebar');
  if (bar) bar.outerHTML = saveBarHtml();
  const chips = board?.querySelector('.pb-chips');
  if (chips) chips.outerHTML = chipsHtml();
}

// ─── Events ───

function wire() {
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset?.pb === 'search') {
      state.query = t.value;
      const list = root.querySelector('.pb-list');
      if (list) list.innerHTML = listHtml();
      const chips = root.querySelector('.pb-chips');
      if (chips) chips.outerHTML = chipsHtml();
      return;
    }
    if (t.dataset?.pb === 'value') {
      const { sourceKey, chestName } = t.dataset;
      const raw = t.value.trim();
      const cur = currentValue(sourceKey, chestName);
      const k = dirtyKey(sourceKey, chestName);
      if (raw === '' || raw === String(cur)) state.dirty.delete(k);
      else state.dirty.set(k, raw);
      updateEditChrome(t);
    }
  });

  root.addEventListener('keydown', (e) => {
    // Enter in a value box reviews, as a form would submit.
    if (e.key === 'Enter' && e.target.dataset?.pb === 'value' && state.dirty.size > 0) {
      e.preventDefault();
      reviewAndSave();
    }
  });

  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-pb]');
    if (!t || !root.contains(t)) return;
    const action = t.dataset.pb;
    if (action === 'category') {
      state.category = t.dataset.category;
      state.query = '';
      rememberCategory(state.category);
      render();
    } else if (action === 'expand') {
      const key = t.dataset.sourceKey;
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      rerenderRow(key);
    } else if (action === 'split') {
      const key = t.dataset.sourceKey;
      const set = state.split.get(key) || new Set();
      set.add(t.dataset.chestName);
      state.split.set(key, set);
      rerenderRow(key);
      root.querySelector(`[data-pb-key="${CSS.escape(dirtyKey(key, t.dataset.chestName))}"]`)?.focus();
    } else if (action === 'follow') {
      followSource(t.dataset.sourceKey, t.dataset.chestName);
    } else if (action === 'discard') {
      state.dirty.clear();
      state.split.clear();
      render();
    } else if (action === 'review') {
      reviewAndSave();
    } else if (action === 'recalc') {
      recalculate();
    }
  });
}

function rerenderRow(sourceKey) {
  const src = findSource(sourceKey);
  const btn = root.querySelector(`[data-pb="expand"][data-source-key="${CSS.escape(sourceKey)}"]`)
    || root.querySelector(`[data-pb-key="${CSS.escape(dirtyKey(sourceKey, ''))}"]`);
  const row = btn?.closest('.pb-row');
  if (!src || !row) return render();
  const tmp = document.createElement('div');
  tmp.innerHTML = sourceHtml(src);
  row.replaceWith(tmp.firstElementChild);
}

/** Make an exception pay the source's (possibly edited) value again. */
function followSource(sourceKey, chestName) {
  const src = findSource(sourceKey);
  if (!src) return;
  const sourceValue = state.dirty.get(dirtyKey(sourceKey, '')) ?? String(src.points);
  const chest = src.chests.find((c) => c.name === chestName);
  const k = dirtyKey(sourceKey, chestName);
  if (chest && String(chest.points) === sourceValue) state.dirty.delete(k);
  else state.dirty.set(k, sourceValue);
  state.split.get(sourceKey)?.delete(chestName);
  rerenderRow(sourceKey);
  const bar = root.querySelector('.pb-savebar');
  if (bar) bar.outerHTML = saveBarHtml();
}

function collectChanges() {
  const changes = [];
  for (const [k, raw] of state.dirty) {
    const [sourceKey, chestName] = k.split('\t');
    const points = Number(raw);
    if (!Number.isInteger(points) || points < 0) {
      const src = findSource(sourceKey);
      return { error: `${chestName || src?.label || sourceKey}: “${raw}” isn't a whole number of points.` };
    }
    changes.push({ sourceKey, chestName, points });
  }
  return { changes };
}

// ─── Preview + save ───

function impactHtml(impact, { edits = null, intro = '' } = {}) {
  const editList = edits && edits.length > 0 ? `
    <div class="pb-impact-section">
      <div class="pb-impact-heading">Changes</div>
      <ul class="pb-impact-list">
        ${edits.map((e) => `<li>
          <span class="pb-impact-name">${esc(e.label)}${e.chestName ? ` <span class="muted-copy">— ${esc(e.chestName)}</span>` : ' <span class="muted-copy">— source value</span>'}</span>
          <span class="pb-impact-move">${fmt(e.from)} → <strong>${fmt(e.to)}</strong></span>
        </li>`).join('')}
      </ul>
    </div>` : '';

  const clans = impact.clans.length > 0 ? `
    <div class="pb-impact-section">
      <div class="pb-impact-heading">Per clan</div>
      <ul class="pb-impact-list">
        ${impact.clans.map((c) => `<li>
          <span class="pb-impact-name">${esc(c.name)}</span>
          <span class="pb-impact-move">${plural(c.records, 'record')} · <strong class="${c.delta < 0 ? 'is-error' : 'is-success'}">${signed(c.delta)} pts</strong></span>
        </li>`).join('')}
      </ul>
    </div>` : '';

  const lines = impact.lines.length > 0 ? `
    <details class="pb-impact-section">
      <summary class="pb-impact-heading">Where the points move (${plural(impact.lines.length + impact.moreLines, 'line')})</summary>
      <ul class="pb-impact-list">
        ${impact.lines.map((l) => `<li>
          <span class="pb-impact-name">${esc(l.label)} <span class="muted-copy">— ${l.chests.length === 1 ? esc(l.chests[0]) : `${l.chests.length} chests`}</span></span>
          <span class="pb-impact-move">${l.from.map(fmt).join(', ')} → ${fmt(l.to)} · ${plural(l.records, 'record')} · ${signed(l.delta)}</span>
        </li>`).join('')}
        ${impact.moreLines > 0 ? `<li class="muted-copy">…and ${plural(impact.moreLines, 'more line')}</li>` : ''}
      </ul>
    </details>` : '';

  return `
    ${intro ? `<p class="pb-impact-intro">${intro}</p>` : ''}
    <div class="pb-tiles">
      <div class="pb-tile"><div class="pb-tile-value">${fmt(impact.records)}</div><div class="pb-tile-label">chest records change</div></div>
      <div class="pb-tile"><div class="pb-tile-value ${impact.delta < 0 ? 'is-error' : impact.delta > 0 ? 'is-success' : ''}">${signed(impact.delta)}</div><div class="pb-tile-label">points in total</div></div>
    </div>
    ${editList}
    ${clans}
    ${lines}
  `;
}

/** Show a preview modal; resolves true when the admin confirms. */
function confirmImpact({ title, html, confirmLabel }) {
  return new Promise((resolve) => {
    const modal = contentModal({
      title,
      wide: true,
      className: 'pb-impact-modal',
      html: `${html}
        <div class="modal-actions">
          <button type="button" class="btn" data-pb-modal="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" data-pb-modal="confirm">${esc(confirmLabel)}</button>
        </div>`,
    });
    if (!modal) return resolve(false);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(v);
    };
    modal.content.querySelector('[data-pb-modal="cancel"]').addEventListener('click', () => done(false));
    modal.content.querySelector('[data-pb-modal="confirm"]').addEventListener('click', () => done(true));
    // Closing by ×, backdrop or Escape is a cancel.
    new MutationObserver((_, obs) => {
      if (!modal.overlay.isConnected) { obs.disconnect(); done(false); }
    }).observe(modal.overlay.parentNode, { childList: true });
  });
}

async function withBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  root.querySelectorAll('[data-pb="review"], [data-pb="recalc"]').forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } finally {
    state.busy = false;
    root?.querySelectorAll('[data-pb="review"], [data-pb="recalc"]').forEach((b) => { b.disabled = false; });
  }
}

function reviewAndSave() {
  return withBusy(async () => {
    const { changes, error } = collectChanges();
    if (error) return notify(error, 'Check the value');
    if (changes.length === 0) return notify('Nothing to save.', 'No changes');

    const preview = await apiPost('/admin/source-points/changes', { changes, dryRun: true });
    if (preview?.error) return notify(preview.error, 'Preview failed');
    if (preview.edits.length === 0) {
      state.dirty.clear();
      render();
      return notify('Those values are already in place — nothing to save.', 'No changes');
    }
    const ok = await confirmImpact({
      title: `Save ${plural(preview.edits.length, 'change')}?`,
      html: impactHtml(preview.impact, {
        edits: preview.edits,
        intro: preview.impact.records > 0
          ? 'Saving updates these stored chest records right away, in every clan — there is nothing to Recalculate afterwards.'
          : 'No stored chest record changes — this only affects chests scanned from now on.',
      }),
      confirmLabel: 'Save changes',
    });
    if (!ok) return;

    const result = await apiPost('/admin/source-points/changes', { changes });
    if (result?.error) return notify(result.error, 'Save failed');
    state.dirty.clear();
    state.split.clear();
    await refresh();
    notify(
      `${plural(result.edits.length, 'change')} saved · ${plural(result.updated, 'record')} updated · ${signed(result.impact.delta)} pts`,
      'Chest points saved',
    );
  });
}

function recalculate() {
  // Recalculate works from SAVED values only; with edits still pending it
  // would report "nothing to do" and read as if the edits had been applied.
  if (state.dirty.size > 0) {
    return notify(
      `You have ${plural(state.dirty.size, 'unsaved change')}. Recalculate only uses saved values — use Review & save first (saving updates the stored records itself).`,
      'Save your changes first',
    );
  }
  return withBusy(async () => {
    const preview = await apiPost('/admin/source-points/recalculate', { dryRun: true });
    if (preview?.error) return notify(preview.error, 'Recalculate failed');
    if (preview.impact.records === 0) {
      return notify('Every stored chest record already matches the current values — saves update records as they are made.', 'Nothing to recalculate');
    }
    const ok = await confirmImpact({
      title: 'Recalculate chest points?',
      html: impactHtml(preview.impact, {
        intro: 'These stored records no longer match the current values (usually chests scanned before a value was set). Recalculating brings them in line, in every clan.',
      }),
      confirmLabel: 'Recalculate',
    });
    if (!ok) return;
    const result = await apiPost('/admin/source-points/recalculate', {});
    if (result?.error) return notify(result.error, 'Recalculate failed');
    await refresh();
    notify(`${plural(result.updated, 'record')} updated · ${signed(result.impact.delta)} pts`, 'Recalculated');
  });
}
