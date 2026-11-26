// A research's levels as the game's tables give them — cost, research time,
// Might and the bonus each level brings, and the building it asks for — read
// every patch (src/game-protocol/tech-trees.ts buildTechLevels, served by
// /api/game/tech-trees/:id/levels). Tap a node of any tree (a member's or the
// clan's Research tab, Tools → What's new) and its levels open under the tree.

import { api } from './api.js';
import { esc } from './ui.js';
import { t, tGame } from './i18n.js';
import { formatCompact } from './ancient-planner.js';

/** One request per tree per page load. */
const cache = new Map();

export function loadTreeLevels(treeId) {
  if (!cache.has(treeId)) {
    cache.set(treeId, api(`/game/tech-trees/${encodeURIComponent(treeId)}/levels`).then((r) => {
      if (!r || r.error || !r.techs) throw new Error(r?.error || 'no levels');
      return r;
    }).catch((err) => {
      cache.delete(treeId);
      throw err;
    }));
  }
  return cache.get(treeId);
}

// ─── Is a tree live? Since when has the game's data had it? ───
// GET /api/game/tech-tree-status: per tree `firstSeen` (this install's oldest
// copy holding it — the game's files carry no dates) and `live` (any player,
// or for a clan tree any clan, the site reads has a level in it; null = no data).

let status = null;
let statusLoading = null;

/** Load the trees' status once a page load; never throws (null when it can't be had). */
export function loadTreeStatus() {
  if (!statusLoading) {
    statusLoading = api('/game/tech-tree-status')
      .then((r) => {
        status = r && r.trees ? r : null;
        return status;
      })
      .catch((err) => {
        statusLoading = null;
        if (err?.name === 'UnauthenticatedError') throw err;
        return null;
      });
  }
  return statusLoading;
}

const statusOf = (treeId) => status?.trees?.[treeId] || null;

/** "◌ Not live" for a tree nobody has started (glyph + words, never colour alone). */
export function notLiveTagHtml(treeId) {
  return statusOf(treeId)?.live === false ? `<span class="tl-tag">◌ ${esc(t('Not live'))}</span>` : '';
}

/** One line over a tree nobody has started: not in the game yet, and since when its data has been there. */
export function notLiveNoteHtml(tree) {
  const s = tree ? statusOf(tree.id) : null;
  if (s?.live !== false) return '';
  const who = tree.kind === 'clan'
    ? t('none of the clans this site reads has started it')
    : t('none of the players this site reads has started it');
  const since = s.firstSeen ? t("In the game's data since at least {date}.", { date: s.firstSeen.slice(0, 10) }) : '';
  return `<p class="tl-notlive">◌ <b>${esc(t('Not live yet'))}</b>: ${esc(who)}. ${esc(since)}</p>`;
}

/** What a research is paid in, as the game describes it: "Skylands Points — Earned by collecting Campaign Chest rewards." */
export function currencyNoteHtml(itemIds, items) {
  const lines = [...new Set(itemIds)].map((id) => items?.[id]).filter((it) => it?.tooltip).map((it) => `<p class="tl-currency">${it.iconUrl ? `<img src="${esc(it.iconUrl)}" alt="" decoding="async">` : ''}<span><b>${esc(tGame(it.name))}</b>: ${esc(it.tooltip)}</span></p>`);
  return lines.join('');
}

/** Research time as the game words it: 5m, 2h 30m, 3d 4h, 156d. */
export function formatSeconds(s) {
  const sec = Math.max(0, Math.round(Number(s) || 0));
  if (!sec) return '—';
  const days = Math.floor(sec / 86_400);
  const hours = Math.floor((sec % 86_400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (days >= 100) return t('{days}d', { days: days.toLocaleString('en-US') });
  if (days) return t('{days}d {hours}h', { days, hours });
  if (hours) return t('{hours}h {minutes}m', { hours, minutes });
  return t('{minutes}m', { minutes: Math.max(1, minutes) });
}

/** An amount of each item a level costs: the game's icon and a compact number (exact in the title). */
export function costHtml(cost, items) {
  const parts = Object.entries(cost || {}).map(([id, amount]) => {
    const item = items?.[id];
    const name = item ? tGame(item.name) : `#${id}`;
    const exact = Number(amount).toLocaleString('en-US');
    return `<span class="tl-cost" title="${esc(`${exact} ${name}`)}">${item?.iconUrl ? `<img src="${esc(item.iconUrl)}" alt="" loading="lazy" decoding="async">` : ''}<span>${esc(formatCompact(amount))}</span><span class="visually-hidden"> ${esc(name)}</span></span>`;
  });
  return parts.length ? parts.join('') : '<span class="tl-none">—</span>';
}

/** Sum of costs per item. */
function sumCosts(list) {
  const out = {};
  for (const l of list) for (const [id, amount] of Object.entries(l.cost || {})) out[id] = (out[id] || 0) + Number(amount);
  return out;
}

/**
 * The levels table for one research. `current` is the reader's level in it
 * (a member's, the clan's), 0 for none: done levels dim, the next one is
 * marked, and the totals say what is left to the max.
 */
export function levelsPanelHtml(node, data, { current = 0 } = {}) {
  const list = data?.techs?.[node.techId] || [];
  if (!list.length) return `<p class="muted-copy">${esc(t('The game data has no levels for this research.'))}</p>`;
  const items = data.items || {};
  // "Academy" is a building (levels 1–45) as well as the research screen: say which.
  const buildingName = (b) => (b
    ? t('Needs the {building} building at level {level}', { building: tGame(data.buildings?.[b[0]] || `#${b[0]}`), level: b[1] })
    : '');
  const left = list.filter((l) => l.level > current);
  const scope = current > 0 ? left : list;
  const totals = scope.length ? `<div class="tl-totals">
      <div class="tl-total"><span class="ui-stat-label">${esc(current > 0 ? t('Left to max') : t('All levels'))}</span><span class="tl-total-value">${costHtml(sumCosts(scope), items)}</span></div>
      <div class="tl-total"><span class="ui-stat-label">${esc(t('Research time'))}</span><span class="tl-total-value">${esc(formatSeconds(scope.reduce((s, l) => s + (l.seconds || 0), 0)))}</span></div>
      <div class="tl-total"><span class="ui-stat-label">${esc(t('Might'))}</span><span class="tl-total-value">+${esc(formatCompact(scope.reduce((s, l) => s + (l.might || 0), 0)))}</span></div>
    </div>` : `<p class="ui-sub">${esc(t('Maxed: nothing left to research.'))}</p>`;
  let lastBuilding = '';
  const rows = list.map((l) => {
    const needs = buildingName(l.building);
    const note = needs && needs !== lastBuilding ? `<span class="tl-needs">${esc(needs)}</span>` : '';
    lastBuilding = needs || lastBuilding;
    const state = l.level <= current ? ' is-done' : l.level === current + 1 && current > 0 ? ' is-next' : '';
    const bonus = (l.lines || []).map(([text, value]) => `<span class="tl-line"><span>${esc(tGame(text))}</span> <b>${esc(value)}</b></span>`).join('');
    return `<tr class="tl-row${state}">
        <td class="num tl-lv">${l.level}${l.level <= current ? ' ✓' : ''}</td>
        <td class="tl-bonus">${bonus || '—'}${note}</td>
        <td class="tl-cost-cell">${costHtml(l.cost, items)}</td>
        <td class="num">${esc(formatSeconds(l.seconds))}</td>
        <td class="num">${l.might ? `+${esc(formatCompact(l.might))}` : '—'}</td>
      </tr>`;
  }).join('');
  return `<div class="tl-panel">
      <div class="tl-head">
        ${node.iconUrl ? `<img class="tl-icon" src="${esc(node.iconUrl)}" alt="" decoding="async">` : ''}
        <div class="tl-title">
          <span class="tl-name">${esc(tGame(node.name))}</span>
          ${node.description ? `<span class="ui-sub">${esc(node.description)}</span>` : ''}
          ${current > 0 ? `<span class="ui-sub">${esc(t('Level {level} of {max}', { level: current, max: list.length }))}</span>` : ''}
        </div>
      </div>
      ${totals}
      ${currencyNoteHtml(list.flatMap((l) => Object.keys(l.cost || {})), items)}
      <div class="tl-scroll">
        <table class="ui-table tl-table">
          <thead><tr><th class="num">${esc(t('Lv'))}</th><th>${esc(t('Bonus'))}</th><th>${esc(t('Cost'))}</th><th class="num">${esc(t('Time'))}</th><th class="num">${esc(t('Might'))}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="ui-sub tl-source">${esc(t("From the game's own files; research time before speed bonuses."))}</p>
    </div>`;
}

/**
 * Tap a node of the tree in `viewEl` and its levels open in a panel after it.
 * `getTree()` is the tree on screen, `levels` the reader's {techId: level}
 * (or {}). Returns `clear()` for when the tree changes.
 */
export function wireTreeLevels(viewEl, getTree, levels = {}) {
  let slot = viewEl.nextElementSibling;
  if (!slot || !slot.classList.contains('tl-slot')) {
    slot = document.createElement('div');
    slot.className = 'tl-slot';
    viewEl.after(slot);
  }
  const open = async (techId) => {
    const tree = getTree();
    const node = [...(tree?.nodes || []), ...(tree?.unplaced || [])].find((n) => n.techId === techId);
    if (!tree || !node) return;
    viewEl.querySelectorAll('[data-tech-id].is-picked').forEach((n) => n.classList.remove('is-picked'));
    viewEl.querySelector(`[data-tech-id="${techId}"]`)?.classList.add('is-picked');
    slot.innerHTML = `<p class="muted-copy">${esc(t('Loading…'))}</p>`;
    try {
      const data = await loadTreeLevels(tree.id);
      slot.innerHTML = levelsPanelHtml(node, data, { current: Number(levels?.[techId] || 0) });
    } catch {
      slot.innerHTML = `<p class="muted-copy">${esc(t("Couldn't load this research's levels. Try again in a minute."))}</p>`;
    }
    slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  viewEl.addEventListener('click', (e) => {
    const n = e.target.closest('[data-tech-id]');
    if (n) void open(Number(n.dataset.techId));
  });
  viewEl.addEventListener('keydown', (e) => {
    const n = e.target.closest?.('[data-tech-id]');
    if (n && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      void open(Number(n.dataset.techId));
    }
  });
  return { clear: () => { slot.innerHTML = ''; } };
}
