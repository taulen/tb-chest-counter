// Troop picker: a listbox with icons and a search box, appended to <body>
// (a native <select> can't show icons). Used by Tools → Citadel and → Stacks.
//
// Grouped by kind, arrow keys + Enter, Escape closes; the wheel scrolls the
// list and never the page (a page scroll would close it). On phones it is a
// bottom sheet (CSS) and stays open while the keyboard resizes the page.

import { esc } from './ui.js';
import { t, tGame } from './i18n.js';

const icon = (troopId) => new URL(`../img/troops/${troopId}.webp`, import.meta.url).href;

let picker = null; // { pop, trigger, opts, items: [], active }

export function closeTroopPicker({ refocus = false } = {}) {
  if (!picker) return;
  const { pop, trigger } = picker;
  picker = null;
  pop.remove();
  trigger?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('resize', onViewport);
  window.removeEventListener('scroll', onViewport, true);
  window.removeEventListener('hashchange', onViewport);
  if (refocus && trigger?.isConnected) trigger.focus();
}

function onOutside(e) {
  if (picker && !picker.pop.contains(e.target) && !picker.trigger.contains(e.target)) closeTroopPicker();
}
const isPhone = () => window.matchMedia('(max-width: 640px)').matches;

function onViewport(e) {
  // Scrolling inside the list is fine; anything else moving the page closes it.
  if (picker && e?.type === 'scroll' && picker.pop.contains(e.target)) return;
  // On phones it's a bottom sheet, and the on-screen keyboard resizes and
  // scrolls the page as soon as someone types in the search box.
  if (e?.type !== 'hashchange' && isPhone()) return;
  closeTroopPicker();
}

/**
 * Open the picker under `trigger` (clicking the same trigger again closes it).
 *
 * @param {object} o
 * @param {HTMLElement} o.trigger  the button that opened it
 * @param {{id: string, name: string, group: string}[]} o.troops  in display order
 * @param {[string, string][]} o.groups  [group key, heading], in display order
 * @param {string|null} o.current  the troop the row holds now (always listed, ticked)
 * @param {(def: object) => boolean} o.allow  whether any other troop is offered
 * @param {(id: string) => string} [o.tagHtml]  trusted markup after a name (a level tag)
 * @param {(id: string) => void} o.onPick
 */
export function openTroopPicker(o) {
  const wasOpen = picker && picker.trigger === o.trigger;
  closeTroopPicker();
  if (wasOpen) return;
  const pop = document.createElement('div');
  pop.className = 'citadel-pop';
  pop.innerHTML = `
    <input class="input citadel-pop-filter" type="search" autocomplete="off" spellcheck="false"
      placeholder="${esc(t('Find a troop…'))}" aria-label="${esc(t('Find a troop'))}" aria-controls="citadel-pop-list">
    <div class="citadel-pop-list" id="citadel-pop-list" role="listbox" aria-label="${esc(t('Troops'))}"></div>`;
  document.body.appendChild(pop);
  // The wheel over the picker never scrolls the page (which would close it):
  // the list scrolls while it can, and at either end the wheel stops there.
  const list = pop.querySelector('.citadel-pop-list');
  pop.addEventListener('wheel', (ev) => {
    const down = ev.deltaY > 0;
    const listCanScroll = list.contains(ev.target)
      && (down ? list.scrollTop + list.clientHeight < list.scrollHeight - 1 : list.scrollTop > 0);
    if (!listCanScroll) ev.preventDefault();
  }, { passive: false });
  picker = { pop, trigger: o.trigger, opts: o, items: [], active: 0 };
  o.trigger.setAttribute('aria-expanded', 'true');
  renderList('');
  place();
  const input = pop.querySelector('.citadel-pop-filter');
  input.addEventListener('input', () => renderList(input.value));
  pop.addEventListener('keydown', onKey);
  pop.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-troop]');
    if (opt) choose(opt.dataset.troop);
  });
  pop.addEventListener('pointermove', (e) => {
    const opt = e.target.closest('[data-troop]');
    if (opt && picker) setActive(picker.items.indexOf(opt.dataset.troop), false);
  });
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', onViewport);
  window.addEventListener('scroll', onViewport, true);
  window.addEventListener('hashchange', onViewport);
  // Phones: no keyboard until they tap the search box themselves.
  if (!isPhone()) input.focus();
}

/** Under the trigger (or above it when there's no room); phones get a bottom sheet from CSS. */
function place() {
  const { pop, trigger } = picker;
  const box = trigger.getBoundingClientRect();
  const width = Math.max(box.width, 300);
  const below = window.innerHeight - box.bottom - 12;
  const above = box.top - 12;
  const height = Math.min(380, Math.max(below, above));
  pop.style.width = `${width}px`;
  pop.style.maxHeight = `${height}px`;
  pop.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
  if (below >= Math.min(380, above) || below >= 260) pop.style.top = `${box.bottom + 4}px`;
  else pop.style.top = `${Math.max(8, box.top - 4 - Math.min(height, pop.scrollHeight))}px`;
}

function renderList(filter) {
  if (!picker) return;
  const { troops, groups, current, allow, tagHtml } = picker.opts;
  const q = filter.trim().toLowerCase();
  const items = [];
  const html = groups.map(([g, label]) => {
    const opts = troops.filter((x) => x.group === g && (x.id === current || allow(x))
      && (!q || tGame(x.name).toLowerCase().includes(q) || x.name.toLowerCase().includes(q)));
    if (!opts.length) return '';
    return `<div class="citadel-pop-group" role="presentation">${esc(label)}</div>${opts.map((x) => {
      items.push(x.id);
      return `<div class="citadel-pop-opt ${x.id === current ? 'is-current' : ''}" role="option" id="citadel-opt-${x.id}" data-troop="${x.id}" aria-selected="false">
        <img src="${icon(x.id)}" alt="" width="28" height="28" decoding="async"><span>${esc(tGame(x.name))}</span>${tagHtml ? tagHtml(x.id) : ''}${x.id === current ? '<span class="citadel-pop-check" aria-hidden="true">✓</span>' : ''}</div>`;
    }).join('')}`;
  }).join('');
  picker.items = items;
  picker.pop.querySelector('.citadel-pop-list').innerHTML = html || `<p class="citadel-pop-empty">${t('No troops match.')}</p>`;
  setActive(current && !q ? Math.max(0, items.indexOf(current)) : 0, true);
}

function setActive(k, scroll) {
  if (!picker || k < 0) return;
  picker.active = Math.min(k, picker.items.length - 1);
  const input = picker.pop.querySelector('.citadel-pop-filter');
  picker.pop.querySelectorAll('.citadel-pop-opt').forEach((el) => {
    const on = el.dataset.troop === picker.items[picker.active];
    el.classList.toggle('is-active', on);
    el.setAttribute('aria-selected', String(on));
    if (on && scroll) el.scrollIntoView({ block: 'nearest' });
  });
  if (picker.items.length) input.setAttribute('aria-activedescendant', `citadel-opt-${picker.items[picker.active]}`);
  else input.removeAttribute('aria-activedescendant');
}

function onKey(e) {
  if (!picker) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = picker.items.length;
    if (n) setActive((picker.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n, true);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (picker.items.length) choose(picker.items[picker.active]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeTroopPicker({ refocus: true });
  } else if (e.key === 'Tab') {
    closeTroopPicker();
  }
}

function choose(troopId) {
  if (!picker) return;
  const { onPick } = picker.opts;
  closeTroopPicker();
  onPick(troopId);
}
