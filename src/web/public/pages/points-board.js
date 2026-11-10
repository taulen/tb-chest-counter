// Chest Points — the active clan's scoring table on the Admin page, one line
// per chest SOURCE (see src/data/points-board.ts for why a source is the unit).
// Every clan has its own values; superadmins switch clan to edit another's.
//
// Self-contained: it fetches its own data and re-renders only itself, so a
// save or a recalculate never reloads the page or loses the admin's place.
// Edits are kept in module state until saved — switching category, searching,
// or a re-render of the Admin page around it keeps them — and every save or
// recalculate is previewed (records + points that will move, per clan) before
// anything is written.
//
// Values have a history (docs/chest-points-history.md): a save applies either
// from today's game day on (earlier chests keep their points) or to all
// history, and the History view lists the dated changes, each of which can be
// moved, re-valued or removed with the same preview.

import { api, apiPost } from '../lib/api.js';
import { esc, notify, contentModal, selectDialog, formatDate, formatGameDayShort } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';

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
  /** groupId → the tier value as typed. Display only: the edit itself lives
   *  in `dirty`, one entry per level it moved. */
  groupDirty: new Map(),
  busy: false,
  /** 'board' (the values) or 'history' (the dated changes and the log). */
  view: 'board',
  history: null,
  /** The dated change being edited in the History view, as a draft:
   *  { id, day, note, lines: [{ key, label, chestName, from, to }] }. */
  stepDraft: null,
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
// Sources only another clan has recorded are listed so they can be valued
// ahead of the first chest; say so instead of "0 chests".
const chestCount = (n) => (n > 0 ? tn(n, '{n} chest', '{n} chests', { n: fmt(n) }) : `<span class="muted-copy">${t('none recorded yet')}</span>`);
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
    root.querySelector('.pb-body').innerHTML = `<p class="muted-copy">${board?.error ? t('Couldn\'t load chest points: {error}.', { error: esc(board.error) }) : t('Couldn\'t load chest points.')}</p>`;
    return;
  }
  // Edits belong to the clan they were typed against; never carry them over.
  if (state.board && state.board.clan?.id !== board.clan?.id) {
    state.dirty.clear();
    state.split.clear();
    state.groupDirty.clear();
    state.expanded.clear();
  }
  state.board = board;
  if (state.view === 'history') await loadHistory();
  if (!root?.isConnected) return;
  const title = root.querySelector('.pb-header h2');
  if (title) title.innerHTML = `${t('Chest Points')} <span class="muted-copy">· ${esc(board.clan?.name || '')}</span>`;
  // Drop edits for anything that no longer exists, or now already holds the
  // edited value (someone else saved the same thing).
  for (const [k, v] of state.dirty) {
    const [sourceKey, chestName] = k.split('\t');
    const cur = currentValue(sourceKey, chestName);
    if (cur === null || String(cur) === v) state.dirty.delete(k);
  }
  for (const id of [...state.groupDirty.keys()]) {
    const members = board.sources.filter((s) => s.group === id);
    if (!members.some((m) => state.dirty.has(dirtyKey(m.key, '')))) state.groupDirty.delete(id);
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
      <h2>${t('Chest Points')}</h2>
      <div class="pb-header-actions">
        <button class="btn btn-tight" type="button" data-pb="history" aria-pressed="false" title="${t('What each chest was worth, and from when')}">${t('History')}</button>
        ${canEdit ? `
        <button class="btn btn-tight" type="button" data-pb="copy" title="${t('Make this clan pay exactly what another clan pays')}">${t('Copy from clan…')}</button>
        <button class="btn btn-tight" type="button" data-pb="recalc">${t('Recalculate')}</button>` : ''}
      </div>
    </div>
    <div class="card-body card-body-padded pb-body"><p class="is-loading">${t('Loading chest points…')}</p></div>
  `;
}

// ─── Rendering ───

function render() {
  const historyBtn = root.querySelector('[data-pb="history"]');
  if (historyBtn) {
    historyBtn.textContent = state.view === 'history' ? t('Back to values') : t('History');
    historyBtn.setAttribute('aria-pressed', String(state.view === 'history'));
  }
  root.querySelectorAll('[data-pb="recalc"], [data-pb="copy"]').forEach((b) => { b.hidden = state.view === 'history'; });
  if (state.view === 'history') {
    renderHistory();
    return;
  }
  // Recalculate only ever has work when records are out of date — say so on
  // the button rather than letting it look like the step that applies a save.
  const recalc = root.querySelector('[data-pb="recalc"]');
  if (recalc) {
    const stale = state.board.staleRecords;
    recalc.textContent = stale > 0 ? tn(stale, 'Recalculate {n} out of date', 'Recalculate {n} out of date', { n: fmt(stale) }) : t('Recalculate');
    recalc.title = stale > 0
      ? t('Bring stored chest records that no longer match their source value back in line')
      : t('Every stored chest record already matches — nothing to recalculate');
  }
  const body = root.querySelector('.pb-body');
  const focusKey = document.activeElement?.closest?.('.pb-board') ? document.activeElement.dataset.pbKey : null;
  body.innerHTML = `
    <div class="pb-board">
      ${statusHtml()}
      <div class="pb-toolbar">
        <input type="search" class="input pb-search" placeholder="${t('Search sources or chests…')}" aria-label="${t('Search sources or chests')}" value="${esc(state.query)}" data-pb="search">
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
    `<span>${tn(b.sources.length, '{n} source', '{n} sources', { n: fmt(b.sources.length) })}</span>`,
    unset > 0
      ? `<span class="pb-flag">⚠ ${tn(unset, '{n} source with no value yet', '{n} sources with no value yet', { n: fmt(unset) })}</span>`
      : `<span>✓ ${t('every source has a value')}</span>`,
    b.staleRecords > 0
      ? `<span class="pb-flag">⟳ ${canEdit
        ? tn(b.staleRecords, '{n} record out of date — Recalculate fixes it', '{n} records out of date — Recalculate fixes it', { n: fmt(b.staleRecords) })
        : tn(b.staleRecords, '{n} record out of date', '{n} records out of date', { n: fmt(b.staleRecords) })}</span>`
      : `<span>✓ ${t('all stored records are up to date')}</span>`,
  ];
  if (b.historySteps > 0) {
    parts.push(`<button type="button" class="pb-linkish" data-pb="history">${tn(b.historySteps, '{n} dated change', '{n} dated changes', { n: fmt(b.historySteps) })}</button>`);
  }
  const clan = esc(b.clan?.name || t('this clan'));
  const intro = [
    canEdit
      ? t('What each chest source is worth for <strong>{clan}</strong> — every clan has its own values; switch clan to edit another clan\'s.', { clan })
      : t('What each chest source is worth for <strong>{clan}</strong> — every clan has its own values.', { clan }),
    t('Most sources pay one value for every chest they drop; the few that pay some chests differently list those under the source.'),
    canEdit
      ? t('When you save, you choose: from today on (chests from earlier days keep their points) or for all history (every recorded chest is rescored — for fixing a wrong value).')
      : t('<strong>Read-only</strong> — only a superadmin can change values.'),
  ].join(' ');
  return `
    <p class="muted-copy pb-intro">${intro}</p>
    <div class="pb-status">${parts.join('<span class="pb-dot" aria-hidden="true">·</span>')}</div>
  `;
}

function chipsHtml() {
  const b = state.board;
  const unset = b.sources.filter((s) => s.unset);
  // Counts are rows on screen, so a heroic tier counts once, not per level.
  const rows = (sources) => displayUnits(sources).length;
  const chips = [];
  if (unset.length > 0) chips.push({ key: NEEDS_VALUE, title: `⚠ ${t('Needs a value')}`, count: rows(unset), flag: true });
  for (const c of b.categories) {
    chips.push({ key: c.key, title: c.title, count: rows(b.sources.filter((s) => s.category === c.key)), edited: editedIn(c.key) });
  }
  chips.push({ key: ALL, title: t('All'), count: rows(b.sources) });
  const searching = state.query.trim() !== '';
  return `
    <div class="pb-chips" role="group" aria-label="${t('Source category')}">
      ${chips.map((c) => {
        const active = !searching && state.category === c.key;
        return `<button type="button" class="pb-chip${active ? ' active' : ''}${c.flag ? ' pb-chip-flag' : ''}" data-pb="category" data-category="${c.key}" aria-pressed="${active}">
          ${esc(c.title)} <span class="pb-chip-count">${fmt(c.count)}</span>${c.edited ? `<span class="pb-chip-edited" title="${tn(c.edited, '{n} unsaved edit', '{n} unsaved edits', { n: fmt(c.edited) })}">● ${fmt(c.edited)}</span>` : ''}
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
      || tGame(s.label).toLowerCase().includes(q)
      || s.chests.some((c) => c.name.toLowerCase().includes(q) || tGame(c.name).toLowerCase().includes(q)));
  }
  if (state.category === ALL) return all;
  if (state.category === NEEDS_VALUE) return all.filter((s) => s.unset);
  return all.filter((s) => s.category === state.category);
}

/**
 * The rows a list of sources draws as: a grouped source (a heroic tier) folds
 * into its group's row, placed where its first member would be.
 */
function displayUnits(sources) {
  const units = [];
  const seen = new Set();
  for (const s of sources) {
    if (!s.group) {
      units.push({ source: s });
    } else if (!seen.has(s.group)) {
      seen.add(s.group);
      const group = state.board.groups.find((g) => g.id === s.group);
      units.push(group ? { group } : { source: s });
    }
  }
  return units;
}

function listHtml() {
  const units = displayUnits(visibleSources());
  if (units.length === 0) {
    return `<p class="muted-copy pb-empty">${state.query.trim() ? t('Nothing matches “{query}”.', { query: esc(state.query.trim()) }) : t('Nothing here.')}</p>`;
  }
  // Across categories (search, All) a heading per category keeps the list
  // scannable; inside one category it would only repeat the chip.
  const grouped = state.query.trim() !== '' || state.category === ALL || state.category === NEEDS_VALUE;
  const titles = new Map(state.board.categories.map((c) => [c.key, c.title]));
  let last = null;
  return units.map((u) => {
    const category = u.group ? u.group.category : u.source.category;
    const heading = grouped && category !== last
      ? `<div class="pb-group" role="presentation">${esc(titles.get(category) || category)}</div>` : '';
    last = category;
    return heading + (u.group ? groupHtml(u.group) : sourceHtml(u.source));
  }).join('');
}

// ─── Groups (heroic tiers): one row that sets every level in it ───

const GROUP_PREFIX = 'group:';

function groupMembers(groupId) {
  return state.board.sources.filter((s) => s.group === groupId);
}

/** What the group pays: the value most of its members' records score. */
function groupBase(members) {
  const byValue = new Map();
  for (const m of members) {
    const v = byValue.get(m.points) || { records: 0, members: 0 };
    v.records += m.records;
    v.members += 1;
    byValue.set(m.points, v);
  }
  let best = null;
  for (const [points, v] of byValue) {
    if (!best || v.records > best.records || (v.records === best.records && v.members > best.members)
      || (v.records === best.records && v.members === best.members && points < best.points)) {
      best = { points, ...v };
    }
  }
  return best ? best.points : 0;
}

const levelOf = (s) => /(\d+)/.exec(s.key)?.[1] || s.label;

function groupHtml(g) {
  const members = groupMembers(g.id);
  const base = groupBase(members);
  const differing = members.filter((m) => m.points !== base);
  const records = members.reduce((n, m) => n + m.records, 0);
  const q = state.query.trim().toLowerCase();
  // A search that found a member (not the tier itself) opens the tier.
  const open = state.expanded.has(GROUP_PREFIX + g.id) || (q !== '' && !g.label.toLowerCase().includes(q));
  const anyEdited = members.some((m) => [...state.dirty.keys()].some((k) => k.startsWith(`${m.key}\t`)));
  const meta = [tn(members.length, '{n} level', '{n} levels', { n: fmt(members.length) }), chestCount(records)];
  if (differing.length > 0) {
    meta.push(`<span class="pb-meta-exc">${differing.map((m) => t('Level {level} pays {points}', { level: esc(levelOf(m)), points: fmt(m.points) })).join(', ')}</span>`);
  }
  const stale = members.reduce((n, m) => n + m.staleRecords, 0);
  if (stale > 0) meta.push(`<span class="pb-flag">⟳ ${tn(stale, '{n} out of date', '{n} out of date', { n: fmt(stale) })}</span>`);
  const unset = members.some((m) => m.unset);

  return `
    <div class="pb-row pb-group-row${unset ? ' is-unset' : ''}${anyEdited ? ' has-edits' : ''}${open ? ' is-open' : ''}" role="listitem" data-group-id="${esc(g.id)}">
      <div class="pb-main">
        <div class="pb-name">
          <span class="pb-label">${esc(tGame(g.label))}</span>
          ${unset ? `<span class="badge-warn">⚠ ${t('Needs a value')}</span>` : ''}
          <span class="pb-meta">${meta.join(' · ')}</span>
        </div>
        <div class="pb-control">${groupControl(g, base)}</div>
        <button type="button" class="pb-expand" data-pb="expand" data-source-key="${esc(GROUP_PREFIX + g.id)}" aria-expanded="${open}" aria-label="${open ? t('Hide levels for {name}', { name: esc(tGame(g.label)) }) : t('Show levels for {name}', { name: esc(tGame(g.label)) })}"><span aria-hidden="true">${open ? '▾' : '▸'}</span></button>
      </div>
      ${open ? `<div class="pb-members">${members.map(sourceHtml).join('')}</div>` : ''}
    </div>
  `;
}

function groupControl(g, base) {
  if (!canEdit) return `<span class="pb-value-static">${fmt(base)}</span>`;
  const raw = state.groupDirty.get(g.id);
  const edited = raw !== undefined;
  return `
    <label class="pb-value${edited ? ' is-edited' : ''}">
      <input type="number" class="input pb-input" min="0" step="1" inputmode="numeric"
        value="${esc(edited ? raw : String(base))}" data-pb="group-value" data-pb-key="${esc(GROUP_PREFIX + g.id)}"
        data-group-id="${esc(g.id)}" aria-label="${t('Points for every level of {name}', { name: esc(tGame(g.label)) })}">
      <span class="pb-unit" aria-hidden="true">${t('pts')}</span>
    </label>
    ${edited ? `<span class="pb-was">${t('not saved · was {points}', { points: fmt(base) })}</span>` : ''}
  `;
}

/**
 * Typing a tier value edits every level that pays the tier's value; a level
 * already paying something else keeps it (edit that level on its own to move
 * it). The edits are ordinary per-source edits, so saving needs nothing new.
 */
function onGroupInput(input) {
  const id = input.dataset.groupId;
  const members = groupMembers(id);
  const base = groupBase(members);
  const raw = input.value.trim();
  const reset = raw === '' || raw === String(base);
  if (reset) state.groupDirty.delete(id);
  else state.groupDirty.set(id, raw);
  for (const m of members) {
    if (m.points !== base) continue;
    const k = dirtyKey(m.key, '');
    if (reset) state.dirty.delete(k);
    else state.dirty.set(k, raw);
  }
  const row = input.closest('.pb-group-row');
  if (row) {
    row.classList.toggle('has-edits', members.some((m) => [...state.dirty.keys()].some((k) => k.startsWith(`${m.key}\t`))));
    input.closest('.pb-value')?.classList.toggle('is-edited', !reset);
    const control = input.closest('.pb-control');
    control?.querySelector('.pb-was')?.remove();
    if (!reset && control) control.insertAdjacentHTML('beforeend', `<span class="pb-was">${t('not saved · was {points}', { points: fmt(base) })}</span>`);
    // Redraw the open member rows so they show the values they now carry.
    for (const m of members) rerenderRow(m.key, { fallback: false });
  }
  refreshEditSummary();
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
        aria-label="${t('Points for {name}', { name: esc(label) })}">
      <span class="pb-unit" aria-hidden="true">${t('pts')}</span>
    </label>
    ${edited ? `<span class="pb-was">${t('not saved · was {points}', { points: fmt(value) })}</span>` : ''}
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
    chestCount(s.records),
    s.chests.length > 1 ? tn(s.chests.length, '{n} kind', '{n} kinds', { n: fmt(s.chests.length) }) : esc(tGame(s.chests[0]?.name || '')),
  ].filter(Boolean);
  if (exceptions.length > 0) meta.push(`<span class="pb-meta-exc">${tn(exceptions.length, '{n} exception', '{n} exceptions', { n: fmt(exceptions.length) })}</span>`);
  if (s.staleRecords > 0) meta.push(`<span class="pb-flag">⟳ ${tn(s.staleRecords, '{n} out of date', '{n} out of date', { n: fmt(s.staleRecords) })}</span>`);
  const expandable = s.chests.length > 1 || exceptions.length > 0;

  return `
    <div class="pb-row${s.unset ? ' is-unset' : ''}${anyEdited ? ' has-edits' : ''}${open ? ' is-open' : ''}" role="listitem">
      <div class="pb-main">
        <div class="pb-name">
          <span class="pb-label" title="${esc(tGame(s.source))}">${esc(tGame(s.label))}</span>
          ${s.unset ? `<span class="badge-warn">⚠ ${t('Needs a value')}</span>` : ''}
          <span class="pb-meta">${meta.join(' · ')}</span>
        </div>
        <div class="pb-control">${valueControl(s.key, '', s.points, tGame(s.label))}</div>
        ${expandable
          ? `<button type="button" class="pb-expand" data-pb="expand" data-source-key="${esc(s.key)}" aria-expanded="${open}" aria-label="${open ? t('Hide chests for {name}', { name: esc(tGame(s.label)) }) : t('Show chests for {name}', { name: esc(tGame(s.label)) })}"><span aria-hidden="true">${open ? '▾' : '▸'}</span></button>`
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
          <span class="pb-chest-name">${esc(tGame(c.name))}</span>
          ${c.unset ? `<span class="badge-warn">⚠ ${t('Needs a value')}</span>` : ''}
          <span class="pb-meta">${chestCount(c.records)}</span>
        </div>
        <div class="pb-control">${valueControl(s.key, c.name, c.points, t('{chest} from {source}', { chest: tGame(c.name), source: tGame(s.label) }))}</div>
        ${canEdit ? `<button type="button" class="pb-reset" data-pb="follow" data-source-key="${esc(s.key)}" data-chest-name="${esc(c.name)}" title="${t('Pay the source\'s value instead')}" aria-label="${t('{chest}: pay the source\'s value instead', { chest: esc(tGame(c.name)) })}">↺</button>` : '<span class="pb-expand-spacer"></span>'}
      </div>`).join('');

  const chips = followers
    .slice()
    .sort((a, b) => b.records - a.records)
    .map((c) => canEdit
      ? `<button type="button" class="pb-follower" data-pb="split" data-source-key="${esc(s.key)}" data-chest-name="${esc(c.name)}" title="${t('Give {chest} its own value', { chest: esc(tGame(c.name)) })}">${esc(tGame(c.name))} <span class="pb-chip-count">${fmt(c.records)}</span></button>`
      : `<span class="pb-follower">${esc(tGame(c.name))} <span class="pb-chip-count">${fmt(c.records)}</span></span>`)
    .join('');

  return `
    <div class="pb-detail">
      ${followers.length > 0 ? `
        <div class="pb-followers-label">${t('Pays the source value ({value}):', { value: `<span class="pb-source-echo">${fmt(state.dirty.get(dirtyKey(s.key, '')) ?? s.points)}</span>` })}${canEdit ? ` <span class="muted-copy">${t('click a chest to give it its own value')}</span>` : ''}</div>
        <div class="pb-followers">${chips}</div>` : ''}
      ${exceptions.length > 0 ? `<div class="pb-followers-label">${t('Pays its own value:')}</div>${exRows}` : ''}
    </div>
  `;
}

function saveBarHtml() {
  const n = state.dirty.size;
  return `
    <div class="pb-savebar${n > 0 ? ' is-visible' : ''}" ${n > 0 ? '' : 'hidden'}>
      <span class="pb-savebar-text">● ${tn(n, '{n} unsaved change', '{n} unsaved changes', { n: fmt(n) })}</span>
      <div class="pb-savebar-actions">
        <button type="button" class="btn btn-tight" data-pb="discard">${t('Discard')}</button>
        <button type="button" class="btn btn-tight btn-primary" data-pb="review">${esc(t('Review & save'))}</button>
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
    if (edited) was.textContent = t('not saved · was {points}', { points: fmt(currentValue(input.dataset.sourceKey, input.dataset.chestName)) });
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
    const groupRow = row.parentElement?.closest('.pb-group-row');
    if (groupRow) {
      const members = groupMembers(groupRow.dataset.groupId);
      groupRow.classList.toggle('has-edits', members.some((m) => [...state.dirty.keys()].some((d) => d.startsWith(`${m.key}\t`))));
    }
  }
  refreshEditSummary();
}

/** Save bar + chip counts, the two places that summarise pending edits. */
function refreshEditSummary() {
  const board = root.querySelector('.pb-board');
  const bar = board?.querySelector('.pb-savebar');
  if (bar) bar.outerHTML = saveBarHtml();
  const chips = board?.querySelector('.pb-chips');
  if (chips) chips.outerHTML = chipsHtml();
}

// ─── History: the dated changes, and the log of corrections ───

async function loadHistory() {
  const history = await api('/admin/source-points/history');
  if (!history || history.error || !Array.isArray(history.steps)) {
    state.history = { error: history?.error || t('Couldn\'t load the history.') };
    return;
  }
  // A draft belongs to the change it was made on; drop it if that one went.
  if (state.stepDraft && !history.steps.some((s) => s.id === state.stepDraft.id)) state.stepDraft = null;
  state.history = history;
}

async function showHistory(on) {
  state.view = on ? 'history' : 'board';
  if (!on) state.stepDraft = null;
  if (on && !state.history) {
    root.querySelector('.pb-body').innerHTML = `<p class="is-loading">${t('Loading the history…')}</p>`;
    await loadHistory();
    if (!root?.isConnected) return;
  }
  render();
}

/** Who saved it and when, plus the last edit if there was one. */
function stepMetaHtml(entry) {
  const parts = [t('saved {when} by {user}', { when: esc(formatDate(entry.createdAt)), user: esc(entry.createdBy || t('unknown')) })];
  if (entry.updatedAt && entry.updatedAt !== entry.createdAt) {
    parts.push(t('edited {when} by {user}', { when: esc(formatDate(entry.updatedAt)), user: esc(entry.updatedBy || t('unknown')) }));
  }
  return `<span class="pb-meta">${parts.join(' · ')}</span>`;
}

function noteHtml(note) {
  return note ? `<p class="pb-hist-note">“${esc(note)}”</p>` : '';
}

function stepHtml(step) {
  const editing = state.stepDraft?.id === step.id;
  return `
    <article class="pb-hist-item${editing ? ' is-editing' : ''}" data-step-id="${step.id}">
      <div class="pb-hist-head">
        <div class="pb-hist-title">
          <span class="pb-hist-when">${t('From game day {day}', { day: esc(formatGameDayShort(step.effectiveFrom)) })}</span>
          ${stepMetaHtml(step)}
        </div>
        ${canEdit && !editing ? `<div class="pb-hist-actions">
          <button type="button" class="btn btn-tight" data-pb="step-edit" data-step-id="${step.id}">${t('Edit')}</button>
          <button type="button" class="btn btn-tight" data-pb="step-remove" data-step-id="${step.id}">${t('Remove')}</button>
        </div>` : ''}
      </div>
      ${editing ? stepEditorHtml() : `
        ${noteHtml(step.note)}
        ${step.lines.length > 0 ? editsListHtml(step.lines) : `<p class="muted-copy">${t('No visible change on its own — it keeps some chests at the value they already had.')}</p>`}`}
    </article>
  `;
}

function stepEditorHtml() {
  const d = state.stepDraft;
  return `
    <div class="pb-hist-editor">
      <label class="pb-hist-field">
        <span class="pb-impact-heading">${t('Applies from game day')}</span>
        <input type="date" lang="sv" class="input pb-hist-day" value="${esc(d.day)}" max="${esc(state.history.today)}" data-pb="step-day">
      </label>
      ${d.lines.length > 0 ? `
        <ul class="pb-impact-list pb-hist-lines">
          ${d.lines.map((l, i) => `<li>
            <span class="pb-impact-name">${editNameHtml(l)}</span>
            <span class="pb-hist-line-control">
              <span class="muted-copy">${fmt(l.from)} →</span>
              <label class="pb-value">
                <input type="number" class="input pb-input" min="0" step="1" inputmode="numeric" value="${esc(String(l.to))}"
                  data-pb="step-line" data-line="${i}" aria-label="${t('Points for {name}', { name: esc(tGame(l.chestName || l.label)) })}">
                <span class="pb-unit" aria-hidden="true">${t('pts')}</span>
              </label>
              <button type="button" class="pb-reset" data-pb="step-line-drop" data-line="${i}" title="${t('Leave this one out of the change')}" aria-label="${t('Leave {name} out of the change', { name: esc(tGame(l.chestName || l.label)) })}">×</button>
            </span>
          </li>`).join('')}
        </ul>` : `<p class="muted-copy">${t('Every value is left out — saving removes this change.')}</p>`}
      <label class="pb-hist-field">
        <span class="pb-impact-heading">${t('Note')}</span>
        <input type="text" class="input pb-note" maxlength="300" value="${esc(d.note)}" data-pb="step-note" placeholder="${t('Why the value changed')}">
      </label>
      <div class="pb-hist-actions">
        <button type="button" class="btn btn-tight" data-pb="step-cancel">${t('Cancel')}</button>
        <button type="button" class="btn btn-tight btn-primary" data-pb="step-review">${esc(t('Review & save'))}</button>
      </div>
    </div>
  `;
}

function logHtml(entry) {
  const title = entry.kind === 'copy'
    ? t('Copied from {clan} — all history', { clan: esc(entry.note) })
    : t('Correction — all history');
  return `
    <article class="pb-hist-item">
      <div class="pb-hist-head">
        <div class="pb-hist-title">
          <span class="pb-hist-when">${title}</span>
          ${stepMetaHtml(entry)}
        </div>
      </div>
      ${entry.kind === 'correction' ? noteHtml(entry.note) : ''}
      ${entry.lines.length > 0 ? editsListHtml(entry.lines) : `<p class="muted-copy">${t('No value changed.')}</p>`}
    </article>
  `;
}

function renderHistory() {
  const body = root.querySelector('.pb-body');
  const h = state.history;
  if (!h) {
    body.innerHTML = `<p class="is-loading">${t('Loading the history…')}</p>`;
    return;
  }
  if (h.error) {
    body.innerHTML = `<p class="muted-copy">${esc(h.error)}</p>`;
    return;
  }
  body.innerHTML = `
    <div class="pb-history">
      <p class="muted-copy pb-intro">${t('A dated change applies from its game day\'s reset on; chests from earlier days keep the points they had. A correction to all history rescored every recorded chest, so it is kept as a record only.')}</p>
      <h3 class="pb-hist-heading">${t('Dated changes')}</h3>
      ${h.steps.length > 0
        ? `<div class="pb-hist-list">${h.steps.map(stepHtml).join('')}</div>`
        : `<p class="muted-copy pb-empty">${t('No dated changes yet. Values saved “from today on” are listed here.')}</p>`}
      ${h.log.length > 0 ? `
        <h3 class="pb-hist-heading">${t('Corrections to all history')}</h3>
        <div class="pb-hist-list">${h.log.map(logHtml).join('')}</div>` : ''}
      <p class="muted-copy pb-hist-foot">${t('Changes made before this history was kept (November 2026) were applied to all history and are not listed.')}</p>
    </div>
  `;
}

function startStepEdit(id) {
  const step = state.history?.steps.find((s) => s.id === id);
  if (!step) return;
  state.stepDraft = {
    id,
    day: step.effectiveFrom,
    note: step.note || '',
    lines: step.lines.map((l) => ({ ...l })),
  };
  renderHistory();
  root.querySelector('[data-pb="step-day"]')?.focus();
}

async function afterHistoryWrite() {
  state.stepDraft = null;
  state.history = null;
  await refresh();
}

function reviewStepEdit() {
  return withBusy(async () => {
    const d = state.stepDraft;
    const step = state.history?.steps.find((s) => s.id === d?.id);
    if (!d || !step) return;
    for (const l of d.lines) {
      if (!Number.isInteger(Number(l.to)) || Number(l.to) < 0 || String(l.to).trim() === '') {
        return notify(t('{name}: “{value}” isn\'t a whole number of points.', { name: tGame(l.chestName || l.label), value: String(l.to) }), t('Check the value'));
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.day)) return notify(t('Pick the game day the change applies from.'), t('Check the date'));
    const clanId = state.history.clan.id;
    const body = {
      clanId,
      effectiveFrom: d.day,
      changes: d.lines.map((l) => ({ sourceKey: l.key, chestName: l.chestName, points: Number(l.to) })),
      note: d.note,
    };
    const preview = await apiPost(`/admin/source-points/history/${d.id}`, { ...body, dryRun: true });
    if (preview?.error) return notify(preview.error, t('Preview failed'));
    const day = esc(formatGameDayShort(preview.effectiveFrom));
    const ok = await confirmImpact({
      title: preview.removes
        ? t('Remove the change from {day}?', { day: formatGameDayShort(step.effectiveFrom) })
        : t('Save the change from {day}?', { day: formatGameDayShort(preview.effectiveFrom) }),
      html: impactHtml(preview.impact, {
        edits: preview.removes ? null : preview.edits,
        intro: preview.removes
          ? t('As edited it no longer changes anything, so it is removed.')
          : t('Chests from game day {day} on score these values, until the next change of the same chest.', { day }),
      }),
      confirmLabel: preview.removes ? t('Remove change') : t('Save changes'),
    });
    if (!ok) return;
    const result = await apiPost(`/admin/source-points/history/${d.id}`, body);
    if (result?.error) return notify(result.error, t('Save failed'));
    await afterHistoryWrite();
    notify(t('{records} updated · {points} pts', {
      records: tn(result.updated, '{n} record', '{n} records', { n: fmt(result.updated) }),
      points: signed(result.impact.delta),
    }), result.removes ? t('Change removed') : t('Change saved'));
  });
}

function removeStep(id) {
  return withBusy(async () => {
    const step = state.history?.steps.find((s) => s.id === id);
    if (!step) return;
    const clanId = state.history.clan.id;
    const preview = await apiPost(`/admin/source-points/history/${id}/remove`, { clanId, dryRun: true });
    if (preview?.error) return notify(preview.error, t('Preview failed'));
    const day = esc(formatGameDayShort(step.effectiveFrom));
    const ok = await confirmImpact({
      title: t('Remove the change from {day}?', { day: formatGameDayShort(step.effectiveFrom) }),
      html: impactHtml(preview.impact, {
        intro: t('Chests from game day {day} on go back to the values in force before it, until the next change of the same chest.', { day }),
      }),
      confirmLabel: t('Remove change'),
    });
    if (!ok) return;
    const result = await apiPost(`/admin/source-points/history/${id}/remove`, { clanId });
    if (result?.error) return notify(result.error, t('Remove failed'));
    await afterHistoryWrite();
    notify(t('{records} updated · {points} pts', {
      records: tn(result.updated, '{n} record', '{n} records', { n: fmt(result.updated) }),
      points: signed(result.impact.delta),
    }), t('Change removed'));
  });
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
    if (t.dataset?.pb === 'group-value') {
      onGroupInput(t);
      return;
    }
    if (state.stepDraft && t.dataset?.pb === 'step-day') {
      state.stepDraft.day = t.value;
      return;
    }
    if (state.stepDraft && t.dataset?.pb === 'step-note') {
      state.stepDraft.note = t.value;
      return;
    }
    if (state.stepDraft && t.dataset?.pb === 'step-line') {
      const line = state.stepDraft.lines[Number(t.dataset.line)];
      if (line) line.to = t.value.trim();
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
      state.groupDirty.clear();
      render();
    } else if (action === 'review') {
      reviewAndSave();
    } else if (action === 'recalc') {
      recalculate();
    } else if (action === 'copy') {
      copyFromClan();
    } else if (action === 'history') {
      showHistory(state.view !== 'history');
    } else if (action === 'step-edit') {
      startStepEdit(Number(t.dataset.stepId));
    } else if (action === 'step-remove') {
      removeStep(Number(t.dataset.stepId));
    } else if (action === 'step-cancel') {
      state.stepDraft = null;
      renderHistory();
    } else if (action === 'step-line-drop') {
      state.stepDraft?.lines.splice(Number(t.dataset.line), 1);
      renderHistory();
    } else if (action === 'step-review') {
      reviewStepEdit();
    }
  });
}

/**
 * Redraw one row (a source, or a group when `key` is `group:<id>`) in place.
 * With `fallback: false` a row that isn't on screen is left alone instead of
 * redrawing the whole list — what a tier edit wants for its closed members.
 */
function rerenderRow(key, { fallback = true } = {}) {
  const group = key.startsWith(GROUP_PREFIX)
    ? state.board.groups.find((g) => GROUP_PREFIX + g.id === key) : null;
  const src = group ? null : findSource(key);
  const btn = root.querySelector(`[data-pb="expand"][data-source-key="${CSS.escape(key)}"]`)
    || (src ? root.querySelector(`[data-pb-key="${CSS.escape(dirtyKey(key, ''))}"]`) : null);
  const row = btn?.closest('.pb-row');
  if ((!src && !group) || !row) {
    if (fallback) render();
    return;
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = group ? groupHtml(group) : sourceHtml(src);
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
      return { error: t('{name}: “{value}” isn\'t a whole number of points.', { name: tGame(chestName || src?.label || sourceKey), value: raw }) };
    }
    changes.push({ sourceKey, chestName, points });
  }
  return { changes };
}

// ─── Preview + save ───

/** One "source — chest" name, as the board names things. */
function editNameHtml(e) {
  return `${esc(tGame(e.label))}${e.chestName ? ` <span class="muted-copy">— ${esc(tGame(e.chestName))}</span>` : ` <span class="muted-copy">— ${t('source value')}</span>`}`;
}

function editsListHtml(edits) {
  return `<ul class="pb-impact-list">
    ${edits.map((e) => `<li>
      <span class="pb-impact-name">${editNameHtml(e)}</span>
      <span class="pb-impact-move">${fmt(e.from)} → <strong>${fmt(e.to)}</strong></span>
    </li>`).join('')}
  </ul>`;
}

function editsHtml(edits) {
  if (!edits || edits.length === 0) return '';
  return `
    <div class="pb-impact-section">
      <div class="pb-impact-heading">${t('Changes')}</div>
      ${editsListHtml(edits)}
    </div>`;
}

function impactHtml(impact, { edits = null, intro = '' } = {}) {
  const editList = editsHtml(edits);

  // A save only ever touches the board's own clan, so a one-line list would
  // just repeat the totals above it.
  const clans = impact.clans.length > 1 ? `
    <div class="pb-impact-section">
      <div class="pb-impact-heading">${t('Per clan')}</div>
      <ul class="pb-impact-list">
        ${impact.clans.map((c) => `<li>
          <span class="pb-impact-name">${esc(c.name)}</span>
          <span class="pb-impact-move">${tn(c.records, '{n} record', '{n} records', { n: fmt(c.records) })} · <strong class="${c.delta < 0 ? 'is-error' : 'is-success'}">${t('{points} pts', { points: signed(c.delta) })}</strong></span>
        </li>`).join('')}
      </ul>
    </div>` : '';

  const lines = impact.lines.length > 0 ? `
    <details class="pb-impact-section">
      <summary class="pb-impact-heading">${tn(impact.lines.length + impact.moreLines, 'Where the points move ({n} line)', 'Where the points move ({n} lines)', { n: fmt(impact.lines.length + impact.moreLines) })}</summary>
      <ul class="pb-impact-list">
        ${impact.lines.map((l) => `<li>
          <span class="pb-impact-name">${esc(tGame(l.label))} <span class="muted-copy">— ${l.chests.length === 1 ? esc(tGame(l.chests[0])) : tn(l.chests.length, '{n} chest', '{n} chests', { n: l.chests.length })}</span></span>
          <span class="pb-impact-move">${l.from.map(fmt).join(', ')} → ${fmt(l.to)} · ${tn(l.records, '{n} record', '{n} records', { n: fmt(l.records) })} · ${signed(l.delta)}</span>
        </li>`).join('')}
        ${impact.moreLines > 0 ? `<li class="muted-copy">${tn(impact.moreLines, '…and {n} more line', '…and {n} more lines', { n: fmt(impact.moreLines) })}</li>` : ''}
      </ul>
    </details>` : '';

  return `
    ${intro ? `<p class="pb-impact-intro">${intro}</p>` : ''}
    <div class="pb-tiles">
      <div class="pb-tile"><div class="pb-tile-value">${fmt(impact.records)}</div><div class="pb-tile-label">${tn(impact.records, 'chest records change', 'chest records change')}</div></div>
      <div class="pb-tile"><div class="pb-tile-value ${impact.delta < 0 ? 'is-error' : impact.delta > 0 ? 'is-success' : ''}">${signed(impact.delta)}</div><div class="pb-tile-label">${tn(Math.abs(impact.delta), 'points in total', 'points in total')}</div></div>
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
          <button type="button" class="btn" data-pb-modal="cancel">${t('Cancel')}</button>
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
  root.querySelectorAll('[data-pb="review"], [data-pb="recalc"], [data-pb="copy"]').forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } finally {
    state.busy = false;
    root?.querySelectorAll('[data-pb="review"], [data-pb="recalc"], [data-pb="copy"]').forEach((b) => { b.disabled = false; });
  }
}

/**
 * The save dialog: the edits once, then where they apply — from today's game
 * day on, or to all history — with what each does to the stored records, and
 * an optional note for the History view. Resolves { mode, note }, or null.
 */
function saveDialog(preview) {
  const clan = esc(state.board.clan.name);
  const day = formatGameDayShort(preview.today);
  // A source nobody had valued yet scored 0 everywhere: the fix belongs to
  // all history. Anything else defaults to leaving the past alone.
  const allUnset = preview.edits.every((e) => findSource(e.key)?.unset);
  let mode = allUnset ? 'history' : 'forward';

  const modeImpact = () => {
    if (mode === 'forward') {
      const p = preview.forward;
      const intro = [
        p.impact.records > 0
          ? t('Chests of <strong>{clan}</strong> already recorded today are rescored; everything before today keeps its points.', { clan })
          : t('No chest recorded before now changes — chests of <strong>{clan}</strong> from today on score the new values.', { clan }),
        p.joinsStep ? t('This joins the change already saved for today, {day}.', { day: esc(day) }) : '',
      ].filter(Boolean).join(' ');
      return impactHtml(p.impact, { intro });
    }
    const p = preview.history;
    const intro = [
      p.impact.records > 0
        ? t('Every stored chest record of <strong>{clan}</strong> from these sources gets the new value, whatever day it was earned.', { clan })
        : t('No stored chest record of <strong>{clan}</strong> changes.', { clan }),
      p.replacesSteps.length > 0
        ? `<span class="pb-flag">⚠ ${tn(p.replacesSteps.length, 'It replaces what the dated change from {days} set for these chests.', 'It replaces what the dated changes from {days} set for these chests.', { days: esc(p.replacesSteps.map(formatGameDayShort).join(', ')) })}</span>`
        : '',
    ].filter(Boolean).join(' ');
    return impactHtml(p.impact, { intro });
  };

  const option = (value, title, text) => `
    <label class="pb-mode">
      <input type="radio" name="pb-mode" value="${value}"${mode === value ? ' checked' : ''}>
      <span class="pb-mode-text"><strong>${title}</strong><span class="muted-copy">${text}</span></span>
    </label>`;

  return new Promise((resolve) => {
    const modal = contentModal({
      title: tn(preview.edits.length, 'Save {n} change for {clan}?', 'Save {n} changes for {clan}?', { n: fmt(preview.edits.length), clan: state.board.clan.name }),
      wide: true,
      className: 'pb-impact-modal',
      html: `
        ${editsHtml(preview.edits)}
        <fieldset class="pb-modes">
          <legend class="pb-impact-heading">${t('Apply to')}</legend>
          ${option('forward', t('From today on'), t('Chests from game day {day} on score the new values. Chests from earlier days keep their points.', { day: esc(day) }))}
          ${option('history', t('All history'), t('Every chest this clan ever recorded is rescored. Use it to fix a value that was wrong.'))}
        </fieldset>
        <div class="pb-mode-impact">${modeImpact()}</div>
        <label class="pb-note-field">
          <span class="pb-impact-heading">${t('Note (optional, shown in the history)')}</span>
          <input type="text" class="input pb-note" maxlength="300" placeholder="${t('Why the value changed')}">
        </label>
        <div class="modal-actions">
          <button type="button" class="btn" data-pb-modal="cancel">${t('Cancel')}</button>
          <button type="button" class="btn btn-primary" data-pb-modal="confirm">${t('Save changes')}</button>
        </div>`,
    });
    if (!modal) return resolve(null);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(v);
    };
    modal.content.querySelectorAll('input[name="pb-mode"]').forEach((r) => {
      r.addEventListener('change', () => {
        mode = r.value;
        modal.content.querySelector('.pb-mode-impact').innerHTML = modeImpact();
      });
    });
    modal.content.querySelector('[data-pb-modal="cancel"]').addEventListener('click', () => done(null));
    modal.content.querySelector('[data-pb-modal="confirm"]').addEventListener('click', () => {
      done({ mode, note: modal.content.querySelector('.pb-note').value.trim() });
    });
    // Closing by ×, backdrop or Escape is a cancel.
    new MutationObserver((_, obs) => {
      if (!modal.overlay.isConnected) { obs.disconnect(); done(null); }
    }).observe(modal.overlay.parentNode, { childList: true });
  });
}

function reviewAndSave() {
  return withBusy(async () => {
    const { changes, error } = collectChanges();
    if (error) return notify(error, t('Check the value'));
    if (changes.length === 0) return notify(t('Nothing to save.'), t('No changes'));

    const clanId = state.board.clan.id;
    const preview = await apiPost('/admin/source-points/changes', { clanId, changes, dryRun: true });
    if (preview?.error) return notify(preview.error, t('Preview failed'));
    if (preview.edits.length === 0) {
      state.dirty.clear();
      state.groupDirty.clear();
      render();
      return notify(t('Those values are already in place — nothing to save.'), t('No changes'));
    }
    const choice = await saveDialog(preview);
    if (!choice) return;

    const result = await apiPost('/admin/source-points/changes', { clanId, changes, mode: choice.mode, note: choice.note });
    if (result?.error) return notify(result.error, t('Save failed'));
    state.dirty.clear();
    state.split.clear();
    state.groupDirty.clear();
    state.history = null;
    await refresh();
    const changesText = tn(result.edits.length, '{n} change', '{n} changes', { n: fmt(result.edits.length) });
    const records = tn(result.updated, '{n} record', '{n} records', { n: fmt(result.updated) });
    notify(
      result.mode === 'forward'
        ? t('{changes} saved from {day} on · {records} updated · {points} pts', { changes: changesText, day: formatGameDayShort(result.effectiveFrom), records, points: signed(result.impact.delta) })
        : t('{changes} saved · {records} updated · {points} pts', { changes: changesText, records, points: signed(result.impact.delta) }),
      t('Chest points saved'),
    );
  });
}

function recalculate() {
  // Recalculate works from SAVED values only; with edits still pending it
  // would report "nothing to do" and read as if the edits had been applied.
  if (state.dirty.size > 0) {
    return notify(
      tn(state.dirty.size, 'You have {n} unsaved change. Recalculate only uses saved values — use Review & save first (saving updates the stored records itself).', 'You have {n} unsaved changes. Recalculate only uses saved values — use Review & save first (saving updates the stored records itself).', { n: fmt(state.dirty.size) }),
      t('Save your changes first'),
    );
  }
  return withBusy(async () => {
    const clanId = state.board.clan.id;
    const preview = await apiPost('/admin/source-points/recalculate', { clanId, dryRun: true });
    if (preview?.error) return notify(preview.error, t('Recalculate failed'));
    if (preview.impact.records === 0) {
      return notify(t('Every stored chest record already matches the current values — saves update records as they are made.'), t('Nothing to recalculate'));
    }
    const ok = await confirmImpact({
      title: t('Recalculate chest points?'),
      html: impactHtml(preview.impact, {
        intro: t('These stored records of <strong>{clan}</strong> no longer match the values in force on the day they were earned (usually chests scanned before a value was set). Recalculating brings them in line.', { clan: esc(state.board.clan.name) }),
      }),
      confirmLabel: t('Recalculate'),
    });
    if (!ok) return;
    const result = await apiPost('/admin/source-points/recalculate', { clanId });
    if (result?.error) return notify(result.error, t('Recalculate failed'));
    await refresh();
    notify(t('{records} updated · {points} pts', {
      records: tn(result.updated, '{n} record', '{n} records', { n: fmt(result.updated) }),
      points: signed(result.impact.delta),
    }), t('Recalculated'));
  });
}

/**
 * Make the board's clan pay exactly what another clan pays: every value is
 * replaced by a copy of the other clan's, and this clan's records follow.
 * The other clan is only read.
 */
function copyFromClan() {
  if (state.dirty.size > 0) {
    return notify(
      tn(state.dirty.size, 'You have {n} unsaved change. Copying replaces every value, so save or discard them first.', 'You have {n} unsaved changes. Copying replaces every value, so save or discard them first.', { n: fmt(state.dirty.size) }),
      t('Save your changes first'),
    );
  }
  return withBusy(async () => {
    const clan = state.board.clan;
    const list = await api('/clans');
    const others = (Array.isArray(list?.clans) ? list.clans : []).filter((c) => c.id !== clan.id);
    if (others.length === 0) return notify(t('There is no other clan to copy values from.'), t('Nothing to copy'));
    const picked = await selectDialog(
      t('Every chest point value of {clan} is replaced by the other clan\'s. The other clan is not changed.', { clan: clan.name }),
      others.map((c) => ({ value: c.id, label: c.name })),
      { title: t('Copy values into {clan}', { clan: clan.name }), fieldLabel: t('Copy from'), confirmLabel: t('Preview') },
    );
    if (picked === null || picked === undefined) return;
    const fromClanId = Number(picked);

    const preview = await apiPost('/admin/source-points/copy', { clanId: clan.id, fromClanId, dryRun: true });
    if (preview?.error) return notify(preview.error, t('Preview failed'));
    const fromName = esc(preview.from.name);
    const ok = await confirmImpact({
      title: t('Copy {from}\'s values into {clan}?', { from: preview.from.name, clan: clan.name }),
      html: impactHtml(preview.impact, {
        edits: preview.edits,
        intro: `${tn(preview.values, '<strong>{clan}</strong> will pay exactly what <strong>{from}</strong> pays ({n} saved value; anything {from} hasn\'t set uses the built-in default).', '<strong>{clan}</strong> will pay exactly what <strong>{from}</strong> pays ({n} saved values; anything {from} hasn\'t set uses the built-in default).', { n: fmt(preview.values), clan: esc(clan.name), from: fromName })} `
          + (preview.impact.records > 0
            ? t('These stored chest records of {clan} are updated right away. {from} is not changed.', { clan: esc(clan.name), from: fromName })
            : t('No stored chest record of {clan} changes. {from} is not changed.', { clan: esc(clan.name), from: fromName }))
          + (preview.dropsSteps > 0
            ? ` <span class="pb-flag">⚠ ${tn(preview.dropsSteps, 'The copied values apply to all history, so the dated change of {clan} goes.', 'The copied values apply to all history, so the {n} dated changes of {clan} go.', { n: fmt(preview.dropsSteps), clan: esc(clan.name) })}</span>`
            : ''),
      }),
      confirmLabel: t('Copy values'),
    });
    if (!ok) return;

    const result = await apiPost('/admin/source-points/copy', { clanId: clan.id, fromClanId });
    if (result?.error) return notify(result.error, t('Copy failed'));
    state.split.clear();
    state.history = null;
    await refresh();
    notify(
      t('{values} copied from {clan} · {records} updated · {points} pts', {
        values: tn(result.values, '{n} value', '{n} values', { n: fmt(result.values) }),
        clan: result.from.name,
        records: tn(result.updated, '{n} record', '{n} records', { n: fmt(result.updated) }),
        points: signed(result.impact.delta),
      }),
      t('Chest points copied'),
    );
  });
}
