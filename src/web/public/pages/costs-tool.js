// Tools → Costs: research costs per level, the Guardsmen tier totals and the
// upgrade blueprints, from kingdom289.com's Costs & Upgrades page — packed to
// be read at a glance. The page there gives every research its own card with
// eleven boxes; here a research tree is one table where every research that
// costs the same shares a row (lib/research-costs.js holds the data and the
// merge), the 10 levels read across, and K/M/B/T are told apart by colour as
// well as by their suffix.
//
// One tree at a time (chips), or a search across all of them. On a phone a row
// collapses to names + total, and opens onto the 10 levels as a 5×2 grid.

import { esc } from '../lib/ui.js';
import { t, tGame } from '../lib/i18n.js';
import { formatCompact } from '../lib/ancient-planner.js';
import { CURVES, TREES, mergeRows, pathPicks, GUARDSMEN_TIERS, tierTotal, curveTotal, BLUEPRINTS } from '../lib/research-costs.js';

/** The tree last looked at — a per-browser convenience only. */
const TREE_KEY = 'tbcc.costs.tree.v1';
const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Module state — rebuilt on every page render. */
let cs = null;

function loadTree() {
  try {
    const key = localStorage.getItem(TREE_KEY);
    if (TREES.some((x) => x.key === key)) return key;
  } catch { /* storage blocked: start on the first tree */ }
  return TREES[0].key;
}

function saveTree(key) {
  try { localStorage.setItem(TREE_KEY, key); } catch { /* not remembered, still works */ }
}

/** Magnitude class: the K/M/B/T suffix says it, the colour lets it be scanned. */
const mag = (v) => (v >= 1e12 ? 'cost-t' : v >= 1e9 ? 'cost-b' : v >= 1e6 ? 'cost-m' : 'cost-k');
const exact = (v) => Math.round(v).toLocaleString();

export function renderCostsTool(mount) {
  cs = { tree: loadTree(), query: '' };
  mount.innerHTML = `
    <div class="costs-tool">
      <div class="costs-glance">
        ${tiersCardHtml()}
        ${blueprintsCardHtml()}
      </div>
      <div class="card costs-research">
        <div class="card-header">
          <h2>${t('Research costs')}</h2>
          <span class="card-header-hint">${t('{points} per level', { points: esc(tGame('Valor points')) })}</span>
        </div>
        <div class="costs-filters">
          <input type="search" class="input costs-search" placeholder="${t('Find a research…')}" aria-label="${t('Find a research')}" data-costs="search">
          <div class="costs-chips-slot">${chipsHtml()}</div>
        </div>
        <div class="card-body costs-table-slot">${tableHtml()}</div>
      </div>
    </div>`;

  const root = mount.querySelector('.costs-tool');
  root.addEventListener('input', (e) => {
    if (e.target.dataset?.costs !== 'search') return;
    cs.query = e.target.value;
    paint(root);
  });
  root.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-costs-tree]');
    if (!chip) return;
    cs.tree = chip.dataset.costsTree;
    cs.query = '';
    saveTree(cs.tree);
    const search = root.querySelector('[data-costs="search"]');
    if (search) search.value = '';
    paint(root);
  });
}

/** Repaint the chips and the table, never the search box (it keeps focus). */
function paint(root) {
  root.querySelector('.costs-chips-slot').innerHTML = chipsHtml();
  root.querySelector('.costs-table-slot').innerHTML = tableHtml();
}

// ─── At a glance ─────────────────────────────────────────────────

function tiersCardHtml() {
  const tiles = GUARDSMEN_TIERS.map((x) => `
    <div class="costs-tile">
      <span class="tool-tier-badge">${x.tier}</span>
      <span class="costs-tile-value ${mag(tierTotal(x))}" title="${exact(tierTotal(x))}">${formatCompact(tierTotal(x))}</span>
      <span class="costs-tile-sub">${formatCompact(x.unlock)} + 2×${formatCompact(curveTotal(x.research))}</span>
    </div>`).join('');
  return `
    <div class="card costs-glance-card">
      <div class="card-header"><h2>${esc(tGame('Guardsmen'))}</h2><span class="card-header-hint">${t('Tier unlock + two maxed 10-level researches')}</span></div>
      <div class="costs-tiles">${tiles}</div>
    </div>`;
}

/** Blueprints on top, their Gold under it — the header says which is which. */
function blueprintsCardHtml() {
  const gold = esc(tGame('Gold'));
  const tiles = BLUEPRINTS.map((x) => `
    <div class="costs-tile">
      <span class="tool-tier-badge">${t('Lv {level}', { level: x.level })}</span>
      <span class="costs-tile-value" title="${exact(x.blueprints)}">${formatCompact(x.blueprints)}</span>
      <span class="costs-tile-sub costs-gold" title="${exact(x.gold)} ${gold}">${formatCompact(x.gold)}<span class="visually-hidden"> ${gold}</span></span>
    </div>`).join('');
  return `
    <div class="card costs-glance-card">
      <div class="card-header"><h2>${t('Blueprints for upgrades')}</h2><span class="card-header-hint costs-legend"><span class="costs-gold">${gold}</span></span></div>
      <div class="costs-tiles costs-tiles-narrow">${tiles}</div>
    </div>`;
}

// ─── Research table ──────────────────────────────────────────────

function chipsHtml() {
  const searching = cs.query.trim() !== '';
  return `
    <div class="pb-chips costs-chips" role="group" aria-label="${t('Research tree')}">
      ${TREES.map((tree) => {
        const active = !searching && cs.tree === tree.key;
        return `<button type="button" class="pb-chip${active ? ' active' : ''}" data-costs-tree="${tree.key}" aria-pressed="${active}">${esc(tGame(tree.name))}</button>`;
      }).join('')}
    </div>`;
}

/** Apostrophes don't count: "guardsmens training" finds Guardsmen's Training Cost. */
const norm = (s) => String(s).toLowerCase().replace(/['’]/g, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function queryWords() {
  return norm(cs.query).split(/\s+/).filter(Boolean);
}

function matches(name, words) {
  const hay = `${norm(name)} ${norm(tGame(name))}`;
  return words.every((w) => hay.includes(w));
}

function highlight(text, words) {
  if (!words.length) return esc(text);
  const re = new RegExp(`(${words.map(escapeRe).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

function tableHtml() {
  const words = queryWords();
  const trees = words.length ? TREES : TREES.filter((x) => x.key === cs.tree);
  const body = [];
  for (const tree of trees) {
    for (const section of tree.sections) {
      const rows = words.length ? section.rows.filter(([name]) => matches(name, words)) : section.rows;
      if (!rows.length) continue;
      if (words.length || tree.sections.length > 1) {
        body.push(`<tr class="costs-section"><th colspan="12" scope="colgroup">${esc(tGame(section.name))}</th></tr>`);
      }
      for (const group of mergeRows(rows)) body.push(groupRowHtml(group, words, tree));
    }
  }
  if (!body.length) {
    return `<p class="costs-empty muted-copy">${t('No research matches “{query}”.', { query: esc(cs.query.trim()) })}</p>`;
  }
  return `
    <table class="table-responsive costs-table">
      <colgroup><col class="col-name">${LEVELS.map(() => '<col class="col-lv">').join('')}<col class="col-total"></colgroup>
      <thead>
        <tr>
          <th rowspan="2" scope="col">${t('Research')}</th>
          <th colspan="10" scope="colgroup" class="costs-lv-head">${t('Level')}</th>
          <th rowspan="2" scope="col" class="num">${t('Total')}</th>
        </tr>
        <tr>${LEVELS.map((n) => `<th scope="col" class="num">${n}</th>`).join('')}</tr>
      </thead>
      <tbody>${body.join('')}</tbody>
    </table>`;
}

/** "Guardsmen's ", "Siege Engines' " — the owner a run of names shares. */
const OWNER = /^([^'’]+['’]s?\s)/;

/**
 * A merged row's names, each owner said once: "Guardsmen's Training Cost IV ·
 * March Speed IV · Carrying Capacity IV". The full name stays in the title.
 */
function namesHtml(names, words) {
  let owner = null;
  return names.map((n) => {
    const shown = tGame(n);
    const own = shown.match(OWNER)?.[1] ?? null;
    const text = own && own === owner ? shown.slice(own.length) : shown;
    owner = own;
    return `<span class="costs-name"${text === shown ? '' : ` title="${esc(shown)}"`}>${highlight(text, words)}</span>`;
  }).join('<span class="costs-sep" aria-hidden="true"> · </span>');
}

/**
 * The Total cell. In a troop tree a merged row costs what continuing takes —
 * two of its researches maxed, not one — so it shows that sum with "2 × each"
 * under it (on a phone, as the caption under the number).
 */
function totalCellHtml(group, tree) {
  const picks = pathPicks(tree, group);
  const sum = group.total * picks;
  if (picks === 1) {
    return `<td data-role="metric" data-label="${t('Total')}" class="num costs-total ${mag(sum)}" title="${exact(sum)}">${formatCompact(sum)}</td>`;
  }
  const each = `${picks} × ${formatCompact(group.total)}`;
  return `<td data-role="metric" data-label="${each}" class="num costs-total ${mag(sum)}" title="${t('Two of these maxed is enough to unlock the next troops.')}">${formatCompact(sum)}<span class="costs-total-each">${each}</span></td>`;
}

function groupRowHtml(group, words, tree) {
  const names = namesHtml(group.names, words);
  const total = totalCellHtml(group, tree);

  if (group.unlock !== null) {
    return `
      <tr class="costs-unlock">
        <td data-role="primary"><span class="costs-names"><span class="costs-tag">${t('Unlock')}</span> ${names}</span></td>
        <td data-role="hidden" colspan="10"></td>
        ${total}
      </tr>`;
  }

  const levels = CURVES[group.curve];
  const cells = levels.map((v) => `<td data-role="hidden" class="num ${mag(v)}" title="${exact(v)}">${formatCompact(v)}</td>`).join('');
  // Phone only: the 10 levels as one 5×2 grid in the expand panel.
  const ladder = levels.map((v, i) => `<span class="costs-ladder-item"><span class="costs-ladder-lv">${i + 1}</span><span class="${mag(v)}">${formatCompact(v)}</span></span>`).join('');
  return `
    <tr>
      <td data-role="primary"><span class="costs-names">${names}</span><span class="mrow-sub costs-range">${formatCompact(levels[0])} → ${formatCompact(levels[9])}</span></td>
      ${cells}
      ${total}
      <td class="costs-ladder" data-label=""><span class="costs-ladder-grid">${ladder}</span></td>
    </tr>`;
}
