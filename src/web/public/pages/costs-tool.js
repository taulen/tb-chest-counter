// Tools → Costs: what every research costs, level by level — the game's own
// numbers, read from its files every patch (GET /api/game/research-costs; see
// lib/research-costs.js), in each tree's own currency: Valor or Conquest points
// for a player's trees, Battle Crests for the Clan Duel ones, Scientific
// Tractates for the clan's. Or the research time instead (before speed
// bonuses). One tree at a time (chips, grouped by the Academy's tabs), or a
// search across all of them; research that costs the same shares a row, the 10
// levels read across, K/M/B/T told apart by colour as well as by suffix. On a
// phone a row collapses to names + total and opens onto the levels as a grid.
// Research the game doesn't draw in its tree yet closes each tree's table.
// The blueprints card is still kingdom289.com's (the game's building upgrade
// costs aren't read yet).

import { api } from '../lib/api.js';
import { esc } from '../lib/ui.js';
import { t, tGame } from '../lib/i18n.js';
import { asList, errorStateHtml, refusalText, segHtml, wireRetry } from '../lib/ui-kit.js';
import { formatCompact } from '../lib/ancient-planner.js';
import { currencyNoteHtml, formatSeconds, loadTreeStatus, notLiveNoteHtml, notLiveTagHtml } from '../lib/tech-levels.js';
import { BLUEPRINTS, LEVEL_COLUMNS, levelValues, mergeLevelRows, treeCurrency } from '../lib/research-costs.js';

/** The tree and view last looked at — per-browser conveniences only. */
const TREE_KEY = 'tbcc.costs.tree.v2';
const VIEW_KEY = 'tbcc.costs.view.v1';
const LEVELS = Array.from({ length: LEVEL_COLUMNS }, (_, i) => i + 1);

/** Module state — rebuilt on every page render. */
let cs = null;

function load(key, ok, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null && ok(v)) return v;
  } catch { /* storage blocked */ }
  return fallback;
}

function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not remembered, still works */ }
}

/** Magnitude class: the K/M/B/T suffix says it, the colour lets it be scanned. */
const mag = (v) => (v >= 1e12 ? 'cost-t' : v >= 1e9 ? 'cost-b' : v >= 1e6 ? 'cost-m' : 'cost-k');
const exact = (v) => Math.round(v).toLocaleString('en-US');

/** A value as the view shows it: an amount, or a research time. */
function shown(v) {
  return cs.view === 'time' ? formatSeconds(v) : formatCompact(v);
}
function cellClass(v) {
  return cs.view === 'time' ? '' : mag(v);
}
function titleOf(v) {
  return cs.view === 'time' ? `${exact(v)} s` : exact(v);
}

/** Every tree with at least one level that costs something. */
function costedTrees(data) {
  return asList(data?.trees).filter((tr) => [...asList(tr.nodes), ...asList(tr.unplaced)]
    .some((n) => asList(n.levels).some((l) => Object.keys(l.cost || {}).length)));
}

export async function renderCostsTool(mount) {
  mount.innerHTML = `<p class="muted-copy">${esc(t('Loading…'))}</p>`;
  let data = null;
  try {
    [data] = await Promise.all([api('/game/research-costs'), loadTreeStatus()]);
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
    data = null;
  }
  const trees = costedTrees(data);
  if (!trees.length) {
    mount.innerHTML = errorStateHtml(t("Couldn't load the research costs."), refusalText(data));
    wireRetry(mount, () => renderCostsTool(mount));
    return;
  }
  for (const tr of trees) tr.currency = treeCurrency(tr);
  cs = {
    trees,
    items: data.items || {},
    tree: Number(load(TREE_KEY, (v) => trees.some((x) => String(x.id) === v), String(trees[0].id))),
    view: load(VIEW_KEY, (v) => v === 'cost' || v === 'time', 'cost'),
    query: '',
  };
  mount.innerHTML = `
    <div class="costs-tool">
      <div class="costs-glance">${blueprintsCardHtml()}</div>
      <div class="ui-tile tool-tile costs-research">
        <div class="ui-tile-head">
          <h2 class="ui-tile-title">${esc(t('Research costs'))}</h2>
          <span class="ui-sub costs-unit-slot"></span>
        </div>
        <div class="costs-filters">
          <div class="costs-filter-row">
            <input type="search" class="input costs-search" placeholder="${esc(t('Find a research…'))}" aria-label="${esc(t('Find a research'))}" data-costs="search">
            <span class="costs-view-slot"></span>
          </div>
          <div class="costs-chips-slot"></div>
          <div class="costs-note-slot"></div>
        </div>
        <div class="tool-tile-table costs-table-slot"></div>
        <p class="ui-sub costs-source">${esc(t("The game's own numbers, read from its files every patch. Research time is before speed bonuses."))}</p>
      </div>
    </div>`;

  const root = mount.querySelector('.costs-tool');
  paint(root);
  root.addEventListener('input', (e) => {
    if (e.target.dataset?.costs !== 'search') return;
    cs.query = e.target.value;
    paint(root);
  });
  root.addEventListener('click', (e) => {
    const view = e.target.closest('[data-costs-view]');
    if (view) {
      cs.view = view.dataset.costsView;
      save(VIEW_KEY, cs.view);
      paint(root);
      return;
    }
    const chip = e.target.closest('[data-costs-tree]');
    if (!chip) return;
    cs.tree = Number(chip.dataset.costsTree);
    cs.query = '';
    save(TREE_KEY, String(cs.tree));
    const search = root.querySelector('[data-costs="search"]');
    if (search) search.value = '';
    paint(root);
  });
}

/** Repaint everything but the search box (it keeps focus). */
function paint(root) {
  root.querySelector('.costs-view-slot').innerHTML = segHtml({
    label: t('Show'),
    items: [{ value: 'cost', label: t('Cost') }, { value: 'time', label: t('Time') }],
    current: cs.view,
    attr: 'costs-view',
  });
  root.querySelector('.costs-chips-slot').innerHTML = chipsHtml();
  root.querySelector('.costs-unit-slot').innerHTML = unitHtml();
  // The tree on screen: what its currency is, in the game's words, and whether it is live yet.
  const tree = cs.query.trim() ? null : cs.trees.find((x) => x.id === cs.tree);
  root.querySelector('.costs-note-slot').innerHTML = tree ? notLiveNoteHtml(tree) + currencyNoteHtml([tree.currency], cs.items) : '';
  root.querySelector('.costs-table-slot').innerHTML = tableHtml();
}

/** What a number in the table is: the tree's currency per level, or research time. */
function unitHtml() {
  if (cs.view === 'time') return esc(t('Research time per level'));
  const tree = cs.query.trim() ? null : cs.trees.find((x) => x.id === cs.tree);
  const item = tree ? cs.items[tree.currency] : null;
  if (!item) return esc(t('Cost per level, in each tree\'s own currency'));
  return `${item.iconUrl ? `<img class="costs-unit-icon" src="${esc(item.iconUrl)}" alt="" decoding="async">` : ''}${esc(t('{points} per level', { points: tGame(item.name) }))}`;
}

// ─── At a glance ─────────────────────────────────────────────────

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
    <div class="ui-tile tool-tile costs-glance-card">
      <div class="ui-tile-head"><h2 class="ui-tile-title">${t('Blueprints for upgrades')}</h2><span class="ui-sub costs-legend"><span class="costs-gold">${gold}</span> · kingdom289.com</span></div>
      <div class="costs-tiles costs-tiles-narrow">${tiles}</div>
    </div>`;
}

// ─── Research table ──────────────────────────────────────────────

/** The Academy's tabs ("Unlock", "Boost", "Clan Duel"), then the clan's trees. */
function chipsHtml() {
  const searching = cs.query.trim() !== '';
  const groups = [];
  for (const tree of cs.trees) {
    const label = tree.kind === 'clan' ? t('Clan') : tGame(tree.tab || '') || t('Research');
    let g = groups.find((x) => x.label === label);
    if (!g) groups.push((g = { label, trees: [] }));
    g.trees.push(tree);
  }
  return groups.map((g) => `
    <div class="costs-chip-group">
      <span class="costs-chip-label">${esc(g.label)}</span>
      <div class="pb-chips costs-chips" role="group" aria-label="${esc(g.label)}">
        ${g.trees.map((tree) => {
          const active = !searching && cs.tree === tree.id;
          return `<button type="button" class="pb-chip${active ? ' active' : ''}" data-costs-tree="${tree.id}" aria-pressed="${active}">${tree.iconUrl ? `<img class="costs-chip-icon" src="${esc(tree.iconUrl)}" alt="" loading="lazy" decoding="async">` : ''}${esc(tGame(tree.name))}${notLiveTagHtml(tree.id)}</button>`;
        }).join('')}
      </div>
    </div>`).join('');
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

function sectionRow(text) {
  return `<tr class="costs-section"><th colspan="${LEVEL_COLUMNS + 2}" scope="colgroup">${esc(text)}</th></tr>`;
}

function tableHtml() {
  const words = queryWords();
  const trees = words.length ? cs.trees : cs.trees.filter((x) => x.id === cs.tree);
  const body = [];
  for (const tree of trees) {
    const valuesOf = (n) => levelValues(n, cs.view, tree.currency);
    const pick = (list) => (words.length ? list.filter((n) => matches(n.name, words)) : list).filter((n) => valuesOf(n).length);
    const placed = pick(asList(tree.nodes));
    const later = pick(asList(tree.unplaced));
    if (!placed.length && !later.length) continue;
    if (words.length) body.push(sectionRow(tGame(tree.name)));
    for (const row of mergeLevelRows(placed, valuesOf)) body.push(rowHtml(row, words));
    if (later.length) {
      body.push(sectionRow(t("Not drawn in the game's tree")));
      for (const row of mergeLevelRows(later, valuesOf)) body.push(rowHtml(row, words));
    }
  }
  if (!body.length) {
    return `<p class="costs-empty muted-copy">${t('No research matches “{query}”.', { query: esc(cs.query.trim()) })}</p>`;
  }
  return `
    <table class="table-responsive ui-table costs-table">
      <colgroup><col class="col-name">${LEVELS.map(() => '<col class="col-lv">').join('')}<col class="col-total"></colgroup>
      <thead>
        <tr>
          <th rowspan="2" scope="col">${t('Research')}</th>
          <th colspan="${LEVEL_COLUMNS}" scope="colgroup" class="costs-lv-head">${t('Level')}</th>
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
function namesHtml(nodes, words) {
  let owner = null;
  return nodes.map((n) => {
    // A research the game hasn't named yet keeps its text key ("tech.name.melee_strength_6"): read it as words.
    const shownName = /^[a-z0-9_]+(\.[a-z0-9_%]+)+$/i.test(n.name) ? n.name.split('.').pop().replace(/_/g, ' ') : tGame(n.name);
    const own = shownName.match(OWNER)?.[1] ?? null;
    const text = own && own === owner ? shownName.slice(own.length) : shownName;
    owner = own;
    return `<span class="costs-name"${text === shownName ? '' : ` title="${esc(shownName)}"`}>${highlight(text, words)}</span>`;
  }).join('<span class="costs-sep" aria-hidden="true"> · </span>');
}

/**
 * The Total cell: the whole row — every research in it maxed — with "41.6T
 * each" under it when it holds more than one (on a phone, the caption).
 */
function totalCellHtml(row) {
  const sum = row.total * row.nodes.length;
  if (row.nodes.length === 1) {
    return `<td data-role="metric" data-label="${t('Total')}" class="num costs-total ${cellClass(sum)}" title="${titleOf(sum)}">${esc(shown(sum))}</td>`;
  }
  const each = t('{amount} each', { amount: shown(row.total) });
  return `<td data-role="metric" data-label="${esc(each)}" class="num costs-total ${cellClass(sum)}" title="${titleOf(sum)}">${esc(shown(sum))}<span class="costs-total-each">${esc(each)}</span></td>`;
}

function rowHtml(row, words) {
  const names = namesHtml(row.nodes, words);
  const total = totalCellHtml(row);
  const icon = row.nodes[0].iconUrl ? `<img class="costs-row-icon" src="${esc(row.nodes[0].iconUrl)}" alt="" loading="lazy" decoding="async">` : '';
  // A one-level research is an unlock: its price, no ladder.
  if (row.values.length === 1) {
    return `
      <tr class="costs-unlock">
        <td data-role="primary"><span class="costs-names">${icon}<span class="costs-tag">${t('Unlock')}</span> ${names}</span></td>
        <td data-role="hidden" colspan="${LEVEL_COLUMNS}"></td>
        ${total}
      </tr>`;
  }
  const values = LEVELS.map((n) => row.values[n - 1]);
  const cells = values.map((v) => (v === undefined
    ? '<td data-role="hidden" class="num"></td>'
    : `<td data-role="hidden" class="num ${cellClass(v)}" title="${titleOf(v)}">${esc(shown(v))}</td>`)).join('');
  // Phone only: the levels as one grid in the expand panel.
  const ladder = row.values.map((v, i) => `<span class="costs-ladder-item"><span class="costs-ladder-lv">${i + 1}</span><span class="${cellClass(v)}">${esc(shown(v))}</span></span>`).join('');
  const first = row.values[0];
  const last = row.values[row.values.length - 1];
  return `
    <tr>
      <td data-role="primary"><span class="costs-names">${icon}${names}</span><span class="mrow-sub costs-range">${esc(shown(first))} → ${esc(shown(last))}</span></td>
      ${cells}
      ${total}
      <td class="costs-ladder" data-label=""><span class="costs-ladder-grid">${ladder}</span></td>
    </tr>`;
}
