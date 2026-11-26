// Tools → Costs: what research costs, from the game's own files (GET
// /api/game/research-costs, read every patch). Two parts, the question first:
//
//   What a tier costs   pick a troop line (Guardsmen, Specialists, Engineer
//                       corps, Monsters, Crypts) and a range ("G5 → G7"): the
//                       total in the tree's currency, the research time with
//                       your research speed bonus, the Academy level it needs —
//                       and the exact path, step by step: every unlock and every
//                       research level the game's prerequisites ask for
//                       (src/game-protocol/tier-costs.ts). Each step also says
//                       what a single troop type costs alone and which research
//                       is optional (no tier needs it: carrying capacity).
//   Every research      one tree at a time (or a search across all), one row
//                       per research, the 10 levels across; a troop tree's rows
//                       sit under the tier they are needed for.
//
// The blueprints card is still kingdom289.com's (the game's building upgrade
// costs aren't read yet). On a phone a research row collapses to name + total
// and opens onto its levels.

import { api } from '../lib/api.js';
import { esc } from '../lib/ui.js';
import { t, tGame } from '../lib/i18n.js';
import { asList, errorStateHtml, refusalText, segHtml, wireRetry } from '../lib/ui-kit.js';
import { formatCompact } from '../lib/ancient-planner.js';
import { costHtml, currencyNoteHtml, formatSeconds, loadTreeStatus, notLiveNoteHtml, notLiveTagHtml } from '../lib/tech-levels.js';
import {
  BLUEPRINTS, LEVEL_COLUMNS, levelValues, rangeSteps, stepOfTech, sumSteps, treeCurrency, withSpeed,
} from '../lib/research-costs.js';

/** Per-browser conveniences only. */
const TREE_KEY = 'tbcc.costs.tree.v2';
const VIEW_KEY = 'tbcc.costs.view.v1';
const RANGE_KEY = 'tbcc.costs.range.v1';
const SPEED_KEY = 'tbcc.costs.speed.v1';
const LEVELS = Array.from({ length: LEVEL_COLUMNS }, (_, i) => i + 1);

/** The troop lines as the game names them. */
const FAMILY_NAME = {
  guardsmen: () => tGame('Guardsmen'),
  specialists: () => tGame('Specialists'),
  engineers: () => tGame('Engineer corps'),
  monsters: () => tGame('Monsters'),
  crypts: () => tGame('Crypts'),
};

/** Module state — rebuilt on every page render. */
let cs = null;

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* not remembered, still works */ }
}

/** Magnitude class: the K/M/B/T suffix says it, the colour lets it be scanned. */
const mag = (v) => (v >= 1e12 ? 'cost-t' : v >= 1e9 ? 'cost-b' : v >= 1e6 ? 'cost-m' : 'cost-k');
const exact = (v) => Math.round(v).toLocaleString('en-US');
const techName = (id) => {
  const n = cs.techs[id]?.name || `#${id}`;
  // A research the game hasn't named yet keeps its text key: read it as words.
  return /^[a-z0-9_]+(\.[a-z0-9_%]+)+$/i.test(n) ? n.split('.').pop().replace(/_/g, ' ') : tGame(n);
};
const techIcon = (id, cls) => (cs.techs[id]?.iconUrl ? `<img class="${cls}" src="${esc(cs.techs[id].iconUrl)}" alt="" loading="lazy" decoding="async">` : `<span class="${cls} is-empty" aria-hidden="true"></span>`);

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
  const families = asList(data.tiers).filter((f) => asList(f.steps).length);
  const range = (() => {
    try { return JSON.parse(load(RANGE_KEY, '{}')) || {}; } catch { return {}; }
  })();
  cs = {
    trees,
    families,
    techs: data.techs || {},
    // How many levels each research has: one = an unlock (a troop, a captain, a crypt level).
    maxLevel: new Map(trees.flatMap((tr) => [...asList(tr.nodes), ...asList(tr.unplaced)].map((n) => [n.techId, asList(n.levels).length]))),
    items: data.items || {},
    buildings: data.buildings || {},
    family: families.some((f) => f.family === range.family) ? range.family : families[0]?.family,
    range,
    speed: Math.max(0, Number(load(SPEED_KEY, '0')) || 0),
    tree: Number(load(TREE_KEY, String(trees[0].id))),
    view: load(VIEW_KEY, 'cost') === 'time' ? 'time' : 'cost',
    query: '',
  };
  if (!trees.some((x) => x.id === cs.tree)) cs.tree = trees[0].id;
  mount.innerHTML = `
    <div class="costs-tool">
      ${families.length ? `<section class="ui-tile tool-tile ct" aria-labelledby="ct-title">
        <div class="ui-tile-head">
          <h2 class="ui-tile-title" id="ct-title">${esc(t('What a tier costs'))}</h2>
          <span class="ui-sub">${esc(t("Everything you research to reach it, from the game's own prerequisites"))}</span>
        </div>
        <div class="ct-controls"></div>
        <div class="ct-result" aria-live="polite"></div>
      </section>` : ''}
      <section class="ui-tile tool-tile costs-research" aria-labelledby="costs-all-title">
        <div class="ui-tile-head">
          <h2 class="ui-tile-title" id="costs-all-title">${esc(t('Every research'))}</h2>
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
      </section>
      <div class="costs-glance">${blueprintsCardHtml()}</div>
    </div>`;

  const root = mount.querySelector('.costs-tool');
  paintTiers(root);
  paint(root);
  root.addEventListener('input', (e) => {
    if (e.target.dataset?.costs === 'search') {
      cs.query = e.target.value;
      paint(root);
    } else if (e.target.dataset?.ct === 'speed') {
      cs.speed = Math.max(0, Math.min(100_000, Number(e.target.value) || 0));
      save(SPEED_KEY, cs.speed);
      paintTierResult(root);
    }
  });
  root.addEventListener('change', (e) => {
    const which = e.target.dataset?.ct;
    if (which !== 'from' && which !== 'to') return;
    const fam = currentFamily();
    const r = familyRange(fam);
    const value = Number(e.target.value);
    if (which === 'from') {
      r.from = value;
      if (r.to <= r.from) r.to = fam.steps.find((s) => s.tier > r.from)?.tier ?? r.from;
    } else {
      r.to = value;
      if (r.from >= r.to) r.from = [...fam.steps].reverse().find((s) => s.tier < r.to)?.tier ?? 0;
    }
    saveRange(fam, r);
    paintTiers(root);
  });
  root.addEventListener('click', (e) => {
    const fam = e.target.closest('[data-ct-family]');
    if (fam) {
      cs.family = fam.dataset.ctFamily;
      save(RANGE_KEY, JSON.stringify({ ...cs.range, family: cs.family }));
      paintTiers(root);
      return;
    }
    const step = e.target.closest('[data-ct-step]');
    if (step) {
      // A tier on the ladder: that one step.
      const f = currentFamily();
      const to = Number(step.dataset.ctStep);
      const from = [...f.steps].reverse().find((s) => s.tier < to)?.tier ?? 0;
      saveRange(f, { from, to });
      paintTiers(root);
      return;
    }
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
    save(TREE_KEY, cs.tree);
    const search = root.querySelector('[data-costs="search"]');
    if (search) search.value = '';
    paint(root);
  });
}

// ─── What a tier costs ───────────────────────────────────────────

function currentFamily() {
  return cs.families.find((f) => f.family === cs.family) || cs.families[0];
}

/** The range shown for a family: remembered, else the step from its fifth tier (G5 → G6), else its first. */
function familyRange(fam) {
  const saved = cs.range[fam.family];
  const tiers = fam.steps.map((s) => s.tier);
  if (saved && tiers.includes(saved.to) && (saved.from === 0 || tiers.includes(saved.from)) && saved.from < saved.to) return { ...saved };
  const i = Math.min(4, Math.max(0, fam.steps.length - 2));
  const from = fam.steps.length > 1 ? fam.steps[i].tier : 0;
  return { from, to: fam.steps.find((s) => s.tier > from)?.tier ?? fam.steps[0].tier };
}

function saveRange(fam, r) {
  cs.range = { ...cs.range, [fam.family]: { from: r.from, to: r.to }, family: fam.family };
  save(RANGE_KEY, JSON.stringify(cs.range));
}

const labelOf = (fam, tier) => (tier === 0 ? t('Nothing yet') : fam.steps.find((s) => s.tier === tier)?.label ?? String(tier));

/** The tier picker: the line, a from → to range, the ladder of single steps, the research speed bonus. */
function paintTiers(root) {
  const fam = currentFamily();
  if (!fam) return;
  const r = familyRange(fam);
  const fromOptions = [0, ...fam.steps.slice(0, -1).map((s) => s.tier)]
    .map((tier) => `<option value="${tier}"${tier === r.from ? ' selected' : ''}>${esc(labelOf(fam, tier))}</option>`).join('');
  const toOptions = fam.steps.filter((s) => s.tier > r.from)
    .map((s) => `<option value="${s.tier}"${s.tier === r.to ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
  const currency = fam.steps.map((s) => Object.keys(s.cost)[0]).find(Boolean);
  const ladder = fam.steps.map((s) => {
    const on = s.tier > r.from && s.tier <= r.to;
    const amount = currency ? s.cost[currency] || 0 : 0;
    return `<button type="button" class="ct-rung${on ? ' is-on' : ''}" data-ct-step="${s.tier}" aria-pressed="${on}" title="${esc(`${labelOf(fam, [...fam.steps].reverse().find((x) => x.tier < s.tier)?.tier ?? 0)} → ${s.label}: ${exact(amount)}`)}">
        <span class="ct-rung-label">${esc(s.label)}</span>
        <span class="ct-rung-cost ${mag(amount)}">${esc(formatCompact(amount))}</span>
      </button>`;
  }).join('');
  // The lines as the game's letters (G S E M C) with their names: five fit a phone.
  const familyButtons = cs.families.map((f) => {
    const on = f.family === fam.family;
    return `<button type="button" class="ct-family-btn${on ? ' is-on' : ''}" data-ct-family="${esc(f.family)}" aria-pressed="${on}">
        <span class="ct-family-letter" aria-hidden="true">${esc(f.letter)}</span>
        <span class="ct-family-name">${esc(FAMILY_NAME[f.family]?.() ?? f.family)}</span>
      </button>`;
  }).join('');
  root.querySelector('.ct-controls').innerHTML = `
    <div class="ct-families" role="group" aria-label="${esc(t('Troops'))}">${familyButtons}</div>
    <span class="ct-family-current" aria-hidden="true">${esc(FAMILY_NAME[fam.family]?.() ?? fam.family)}</span>
    <div class="ct-pick">
      <label class="ct-field"><span class="ct-field-label">${esc(t('From'))}</span><select class="input" data-ct="from">${fromOptions}</select></label>
      <span class="ct-arrow" aria-hidden="true">→</span>
      <label class="ct-field"><span class="ct-field-label">${esc(t('To'))}</span><select class="input" data-ct="to">${toOptions}</select></label>
      <label class="ct-field ct-speed"><span class="ct-field-label">${esc(t('Your research speed bonus'))}</span>
        <span class="ct-speed-input"><input class="input" type="number" inputmode="numeric" min="0" step="1" value="${cs.speed}" data-ct="speed" aria-describedby="ct-speed-hint"><span aria-hidden="true">%</span></span>
      </label>
    </div>
    <div class="ct-ladder" role="group" aria-label="${esc(t('One tier at a time'))}">${ladder}</div>
    ${currency ? currencyNoteHtml([currency], cs.items) : ''}`;
  // A phone's ladder scrolls sideways: bring the chosen tier into view.
  const strip = root.querySelector('.ct-ladder');
  const rung = [...(strip?.querySelectorAll('.ct-rung.is-on') || [])].pop();
  if (strip && rung && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = rung.offsetLeft - strip.clientWidth / 2 + rung.clientWidth / 2;
  paintTierResult(root);
}

function timeText(seconds) {
  return formatSeconds(withSpeed(seconds, cs.speed));
}

function itemRowHtml(it) {
  const levels = it.to === 1 && cs.maxLevel.get(it.techId) === 1
    ? `<span class="costs-tag">${esc(t('Unlock'))}</span>`
    : `<span class="ct-lv">${esc(it.from + 1 === it.to ? t('Lv {level}', { level: it.to }) : t('Lv {from}–{to}', { from: it.from + 1, to: it.to }))}</span>`;
  return `<li class="ct-item">
      ${techIcon(it.techId, 'ct-item-icon')}
      <span class="ct-item-main">
        <span class="ct-item-name">${esc(techName(it.techId))}</span>
        <span class="ct-item-sub">${levels}<span class="ct-item-time">${esc(timeText(it.seconds))}</span></span>
      </span>
      <span class="ct-item-cost">${costHtml(it.cost, cs.items)}</span>
    </li>`;
}

function paintTierResult(root) {
  const fam = currentFamily();
  const slot = root.querySelector('.ct-result');
  if (!fam || !slot) return;
  const r = familyRange(fam);
  const steps = rangeSteps(fam, r.from, r.to);
  const sum = sumSteps(steps);
  const needs = Object.entries(sum.buildings)
    .map(([b, lv]) => t('{building} building level {level}', { building: tGame(cs.buildings[b] || `#${b}`), level: lv }));
  const tile = (label, value, sub = '') => `<div class="ct-tile"><span class="ui-stat-label">${esc(label)}</span><span class="ct-tile-value">${value}</span>${sub ? `<span class="ct-tile-sub">${sub}</span>` : ''}</div>`;
  const totalCost = Object.entries(sum.cost).map(([id, n]) => `<span title="${esc(`${exact(n)} ${tGame(cs.items[id]?.name || '')}`)}">${cs.items[id]?.iconUrl ? `<img class="ct-tile-icon" src="${esc(cs.items[id].iconUrl)}" alt="" decoding="async">` : ''}${esc(formatCompact(n))}</span>`).join(' ');
  const blocks = steps.map((s, i) => {
    const prev = i === 0 ? r.from : steps[i - 1].tier;
    const units = s.units.length > 1
      ? `<div class="ct-units"><span class="ct-units-label">${esc(t('One troop type only'))}</span>${s.units.map((u) => `<span class="ct-unit">${techIcon(u.techId, 'ct-unit-icon')}<span class="ct-unit-name">${esc(techName(u.techId))}</span><span class="ct-unit-cost">${costHtml(u.cost, cs.items)}</span></span>`).join('')}</div>`
      : '';
    const optional = s.optional.length
      ? `<details class="ct-optional" data-section-key="ct-optional-${esc(s.label)}">
          <summary>${esc(t('Optional at {tier}: not needed for any higher tier ({n})', { tier: labelOf(fam, prev), n: s.optional.length }))}</summary>
          <ul class="ct-items">${s.optional.map(itemRowHtml).join('')}</ul>
        </details>`
      : '';
    return `<div class="ct-step">
        <div class="ct-step-head">
          <span class="ct-step-label">${esc(labelOf(fam, prev))} → ${esc(s.label)}</span>
          <span class="ct-step-cost">${costHtml(s.cost, cs.items)}</span>
          <span class="ct-step-time">${esc(timeText(s.seconds))}</span>
        </div>
        <ul class="ct-items">${s.items.map(itemRowHtml).join('')}</ul>
        ${units}
        ${optional}
      </div>`;
  }).join('');
  slot.innerHTML = `
    <div class="ct-tiles">
      ${tile(t('{from} → {to} costs', { from: labelOf(fam, r.from), to: labelOf(fam, r.to) }), totalCost || '—')}
      ${tile(t('Research time'), esc(timeText(sum.seconds)), cs.speed ? esc(t('with +{pct}% research speed', { pct: cs.speed })) : `<span id="ct-speed-hint">${esc(t('before speed bonuses: enter yours above'))}</span>`)}
      ${tile(t('Might'), `+${esc(formatCompact(sum.might))}`)}
      ${needs.length ? tile(t('Needs'), esc(needs.join(' · '))) : ''}
    </div>
    <div class="ct-steps">${blocks}</div>`;
}

// ─── Every research ──────────────────────────────────────────────

/** Repaint the research part, never the search box (it keeps focus). */
function paint(root) {
  root.querySelector('.costs-view-slot').innerHTML = segHtml({
    label: t('Show'),
    items: [{ value: 'cost', label: t('Cost') }, { value: 'time', label: t('Time') }],
    current: cs.view,
    attr: 'costs-view',
  });
  root.querySelector('.costs-chips-slot').innerHTML = chipsHtml();
  root.querySelector('.costs-unit-slot').innerHTML = unitHtml();
  const tree = cs.query.trim() ? null : cs.trees.find((x) => x.id === cs.tree);
  root.querySelector('.costs-note-slot').innerHTML = tree ? notLiveNoteHtml(tree) + currencyNoteHtml([tree.currency], cs.items) : '';
  root.querySelector('.costs-table-slot').innerHTML = tableHtml();
}

/** What a number in the table is: the tree's currency per level, or research time. */
function unitHtml() {
  if (cs.view === 'time') return esc(t('Research time per level'));
  const tree = cs.query.trim() ? null : cs.trees.find((x) => x.id === cs.tree);
  const item = tree ? cs.items[tree.currency] : null;
  if (!item) return esc(t("Cost per level, in each tree's own currency"));
  return `${item.iconUrl ? `<img class="costs-unit-icon" src="${esc(item.iconUrl)}" alt="" decoding="async">` : ''}${esc(t('{points} per level', { points: tGame(item.name) }))}`;
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
    <div class="ui-tile tool-tile costs-glance-card">
      <div class="ui-tile-head"><h2 class="ui-tile-title">${t('Blueprints for upgrades')}</h2><span class="ui-sub costs-legend"><span class="costs-gold">${gold}</span> · kingdom289.com</span></div>
      <div class="costs-tiles costs-tiles-narrow">${tiles}</div>
    </div>`;
}

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

function matches(node, words) {
  const hay = `${norm(node.name)} ${norm(techName(node.techId))}`;
  return words.every((w) => hay.includes(w));
}

function highlight(text, words) {
  if (!words.length) return esc(text);
  const re = new RegExp(`(${words.map(escapeRe).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

function sectionRow(text, sub = '') {
  return `<tr class="costs-section"><th colspan="${LEVEL_COLUMNS + 2}" scope="colgroup">${esc(text)}${sub ? ` <span class="costs-section-sub">${esc(sub)}</span>` : ''}</th></tr>`;
}

/**
 * A troop tree's research under the tier it is first needed for ("Needed for
 * G6"), the optional ones under the tier they open at; any other tree in its
 * own order. Research the game doesn't draw in its tree comes last.
 */
function groupsOf(tree) {
  const fam = cs.families.find((f) => asList(f.trees).includes(tree.id));
  const nodes = asList(tree.nodes);
  if (!fam) return [{ title: '', nodes }];
  const where = stepOfTech(fam);
  const groups = new Map();
  const key = (w) => (w ? `${w.optional ? 'o' : 'n'}${String(w.tier).padStart(3, '0')}` : 'z');
  for (const n of nodes) {
    const w = where.get(n.techId);
    const k = key(w);
    if (!groups.has(k)) {
      const prev = w ? [...fam.steps].reverse().find((s) => s.tier < w.tier) : null;
      groups.set(k, {
        title: !w ? t('Other research') : w.optional ? t('Optional from {tier}', { tier: prev ? prev.label : t('the start') }) : t('Needed for {tier}', { tier: w.label }),
        order: w ? w.tier * 2 + (w.optional ? 1 : 0) : 1e6,
        nodes: [],
      });
    }
    groups.get(k).nodes.push(n);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order);
}

function tableHtml() {
  const words = queryWords();
  const trees = words.length ? cs.trees : cs.trees.filter((x) => x.id === cs.tree);
  const body = [];
  for (const tree of trees) {
    const valuesOf = (n) => levelValues(n, cs.view, tree.currency);
    const pick = (list) => (words.length ? list.filter((n) => matches(n, words)) : list).filter((n) => valuesOf(n).length);
    const groups = groupsOf(tree).map((g) => ({ ...g, nodes: pick(g.nodes) })).filter((g) => g.nodes.length);
    const later = pick(asList(tree.unplaced));
    if (!groups.length && !later.length) continue;
    if (words.length) body.push(sectionRow(tGame(tree.name)));
    for (const g of groups) {
      if (g.title) body.push(sectionRow(g.title));
      for (const n of g.nodes) body.push(rowHtml(n, valuesOf(n), words));
    }
    if (later.length) {
      body.push(sectionRow(t("Not drawn in the game's tree")));
      for (const n of later) body.push(rowHtml(n, valuesOf(n), words));
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

/** A value as the view shows it: an amount, or a research time. */
const shown = (v) => (cs.view === 'time' ? formatSeconds(v) : formatCompact(v));
const cellClass = (v) => (cs.view === 'time' ? '' : mag(v));
const titleOf = (v) => (cs.view === 'time' ? `${exact(v)} s` : exact(v));

function rowHtml(n, values, words) {
  const sum = values.reduce((a, b) => a + b, 0);
  const name = `<span class="costs-names">${techIcon(n.techId, 'costs-row-icon')}<span class="costs-name">${highlight(techName(n.techId), words)}</span></span>`;
  const total = `<td data-role="metric" data-label="${t('Total')}" class="num costs-total ${cellClass(sum)}" title="${titleOf(sum)}">${esc(shown(sum))}</td>`;
  // A one-level research is an unlock: its price, no ladder.
  if (values.length === 1) {
    return `
      <tr class="costs-unlock">
        <td data-role="primary">${name.replace('<span class="costs-name">', `<span class="costs-tag">${t('Unlock')}</span> <span class="costs-name">`)}</td>
        <td data-role="hidden" colspan="${LEVEL_COLUMNS}"></td>
        ${total}
      </tr>`;
  }
  const cells = LEVELS.map((i) => values[i - 1]).map((v) => (v === undefined
    ? '<td data-role="hidden" class="num"></td>'
    : `<td data-role="hidden" class="num ${cellClass(v)}" title="${titleOf(v)}">${esc(shown(v))}</td>`)).join('');
  // Phone only: the levels as one grid in the expand panel.
  const ladder = values.map((v, i) => `<span class="costs-ladder-item"><span class="costs-ladder-lv">${i + 1}</span><span class="${cellClass(v)}">${esc(shown(v))}</span></span>`).join('');
  return `
    <tr>
      <td data-role="primary">${name}<span class="mrow-sub costs-range">${esc(shown(values[0]))} → ${esc(shown(values[values.length - 1]))}</span></td>
      ${cells}
      ${total}
      <td class="costs-ladder" data-label=""><span class="costs-ladder-grid">${ladder}</span></td>
    </tr>`;
}
