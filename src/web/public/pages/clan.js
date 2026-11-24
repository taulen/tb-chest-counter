// Clan page — the clan as the game's own clan window shows it, read by every
// scan (game-protocol-phase.ts → collectClan, /api/game/clan). Built on the
// UI kit (docs/design-standard.md):
//
//   header  a tile: the clan logo (composed from the game's layers, game-art/
//           clan-logo.ts), [TAG] Name, kingdom, the Clan Capital's position,
//           founded, leader, language, and the medals the clan displays;
//   stats   stat tiles: members / member limit, might, wealth points, help
//           points, rank by wealth in the kingdom (a link to Rankings) — each
//           with its change since the day before;
//   tabs    the kit's sub-tab bar, one address per section (#clan/<tab>,
//           #triumphal). Research: the clan's three technology trees (Clan
//           territories, Allies, Fortifications — Clan Capital field 17) drawn
//           like the profile's research trees, with a per-tree summary and
//           recent level-ups. Rankings: the game's "Clan ranking by Kingdom" —
//           five categories, the top 100 with logos, this clan highlighted
//           (pinned under the list when outside it), its rank by day; loaded
//           when the tab opens (/api/game/clan/rankings). Treasury: the
//           capital's stock per item, each with its own game icon. Resources:
//           what members donated to the Clan Capital (#resources, /totals,
//           /admin — pages/resources-*.js). History: one row per game day.
//           Joins & leaves: who joined, left or came back
//           (pages/clan-roster.js). Triumphal Chests (pages/triumphal.js).
//
// The trees come from /api/game/tech-trees (the same file the profile uses);
// only the clan trees the game's clan research holds are shown — tree 17
// (clanTalentsTree17) is a different, per-player thing.

import { api } from '../lib/api.js';
import { esc, formatDate, formatDateShort, formatGameDayShort, memberLink } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { loadGameArt, resourceIconUrl } from '../lib/game-art.js';
import {
  subTabsHtml, tileHtml, statTileHtml, statTilesHtml, tableCardHtml, emptyHtml,
  errorStateHtml, refusalText, wireRetry, asList, centreCurrentSubTab,
} from '../lib/ui-kit.js';
import { loadTrees, treeHtml, treeProgress, nodeState } from './member-techs.js';
import { renderTriumphal } from './triumphal.js';
import { mountRoster, rosterPanelHtml } from './clan-roster.js';
import { renderResourcesOverview } from './resources-overview.js';
import { renderResourcesTotals } from './resources-totals.js';
import { renderResourcesAdmin } from './resources.js';

const PHONE = '(max-width: 640px)';
const CHANGES_SHOWN = 60;
const HISTORY_SHOWN = 30;

/** The open tab, Resources section and tree, kept while navigating within the SPA. */
const view = { tab: 'research', resources: 'overview', tree: null, rankKind: 7, rankPage: null };

// My Clan's sections. Triumphal Chests and Resources are tabs here too (Nov
// 2026: both left the main menu). Every tab has an address (#clan/<tab>,
// #triumphal — Triumphal's period selector lives in it — and #resources, with
// its own sections at #resources/totals and #resources/admin); the sub-tab bar
// is links to those addresses, and the router switches only the panel while
// My Clan is on screen (switchClanTab): the header and stats stay put.
const CLAN_TABS = [
  { key: 'research', label: () => t('Research') },
  { key: 'rankings', label: () => t('Rankings') },
  { key: 'treasury', label: () => t('Treasury') },
  { key: 'resources', label: () => t('Resources') },
  { key: 'history', label: () => t('History') },
  { key: 'roster', label: () => t('Joins & leaves') },
  { key: 'triumphal', label: () => t('Triumphal Chests') },
];

/** Tabs drawn from their own data: shown even when the clan itself couldn't be read. */
const OWN_DATA_TABS = new Set(['triumphal', 'resources']);

/** Resources' sections, each its own address (lib/resource-format.js resourceTabsHtml). */
const RESOURCE_SECTIONS = {
  overview: renderResourcesOverview,
  totals: renderResourcesTotals,
  admin: renderResourcesAdmin,
};

/**
 * Open My Clan on a section (#clan/<tab>, #triumphal, #resources[/<section>]).
 * `sub` picks Resources' section.
 */
export function setClanTab(key, sub) {
  if (CLAN_TABS.some((tb) => tb.key === key)) view.tab = key;
  if (key === 'resources') view.resources = RESOURCE_SECTIONS[sub] ? sub : 'overview';
}

const tabHash = (key) => (key === 'triumphal' ? '#triumphal' : key === 'resources' ? '#resources' : `#clan/${key}`);

/** The sub-tab bar: one link per section, the open one marked. */
function clanTabsHtml(active) {
  return subTabsHtml({
    label: t('My Clan'),
    current: active,
    items: CLAN_TABS.map((tb) => ({ key: tb.key, label: tb.label(), href: tabHash(tb.key) })),
  });
}

/**
 * A phone's sideways strip opens on the tab a link landed on (#resources,
 * #triumphal sit past the first screenful). Only on a full render: a tab
 * tapped in place is already in view.
 */
function centreClanTab(content) {
  centreCurrentSubTab(content.querySelector('.clan-page > .ui-subtabs'));
}

/** Fill the Triumphal Chests panel (or container) in place. */
async function mountTriumphal(content) {
  const box = content.querySelector('[data-clan-triumphal]');
  if (box) await renderTriumphal(box);
}

/** Fill the Resources panel with its open section (Overview, Totals, Admin). */
async function mountResources(content) {
  const box = content.querySelector('[data-clan-resources]');
  if (box) await RESOURCE_SECTIONS[view.resources](box);
}

/** The holder of a tab drawn from its own data. */
function ownDataBoxHtml(key) {
  return key === 'triumphal' ? '<div data-clan-triumphal></div>' : '<div data-clan-resources></div>';
}

/** The clan data My Clan is showing (the Rankings panel pins this clan from it). */
let clanData = null;

/**
 * Fill the panels that load their own data when they first show. Run from
 * the router's switch (switchClanTab) or the render, never straight from a
 * tab click: the click changes the address, and the router's navigation then
 * aborts every read started before it — a panel fetched from the click itself
 * came back "Couldn't load".
 */
async function mountPanel(content, key) {
  if (key === 'rankings' && clanData) await mountRankings(content, clanData);
  else if (key === 'roster') await mountRoster(content);
  else if (key === 'triumphal') await mountTriumphal(content);
  else if (key === 'resources') await mountResources(content);
}

/** Show `key`'s panel and mark its link; every other panel hides. */
function showPanel(content, key) {
  content.querySelectorAll('[data-clan-panel]').forEach((p) => { p.hidden = p.dataset.clanPanel !== key; });
  content.querySelectorAll('.ui-subtabs .ui-subtab').forEach((a) => {
    if (a.getAttribute('href') === tabHash(key)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/**
 * Switch to a tab while My Clan is already on screen: only the panel changes,
 * nothing above it moves. False when My Clan isn't mounted (render it then).
 * `sub` picks Resources' section; a Resources action's reload lands here too.
 */
export async function switchClanTab(content, key, sub) {
  if (!CLAN_TABS.some((tb) => tb.key === key) || !content.querySelector('[data-clan-page]')) return false;
  setClanTab(key, sub);
  showPanel(content, key);
  await mountPanel(content, key);
  return true;
}

/** Medal tier → CSS modifier (colour) — the tier's name is always written next to it. */
const TIER_CLASS = { 1: 'is-bronze', 2: 'is-silver', 3: 'is-gold', 4: 'is-platinum' };

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());

/** 8.33B / 297.9M / 5.59M — the exact figure goes in the title. */
function compact(n) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e8 ? 0 : 2)}M`;
  if (abs >= 1e4) return `${Math.round(n / 1e3)}k`;
  return Number(n).toLocaleString();
}

function signed(n, format = fmt) {
  if (!n) return '±0';
  return `${n > 0 ? '+' : '−'}${format(Math.abs(n))}`;
}

/** A plain one-sentence note where a section has nothing to show yet. */
function noteTile(text) {
  return `<div class="ui-tile span-12 clan-note">${emptyHtml(text)}</div>`;
}

/** The language's own name in the viewer's language ("en_US" → "English (United States)"). */
function languageName(code) {
  if (!code) return '';
  try {
    const ui = document.documentElement.lang || 'en';
    return new Intl.DisplayNames([ui], { type: 'language' }).of(code.replace('_', '-')) || code;
  } catch {
    return code;
  }
}

export async function renderClan(content) {
  rankingsPromise = null;
  clanData = null;
  content.innerHTML = `<div class="ui-tile span-12 clan-note"><p class="ui-sub">${t('Loading…')}</p></div>`;
  let data;
  let trees = null;
  try {
    [data, trees] = await Promise.all([
      api('/game/clan'),
      loadTrees().catch(() => null),
      loadGameArt(),
    ]);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    data = null;
  }
  // A refusal (a 429, a 500's { error, ref }) or a failed read: say so, offer
  // Try again — the strip stays, so Triumphal Chests and Resources (their own
  // data) are still reachable.
  const ownData = OWN_DATA_TABS.has(view.tab);
  const why = refusalText(data);
  if (data === null || why) {
    content.innerHTML = `<div class="clan-page">${clanTabsHtml(view.tab)}
        ${ownData
          ? ownDataBoxHtml(view.tab)
          : `<div class="ui-tile span-12">${errorStateHtml(t("Couldn't load the clan. Try again in a minute."), why)}</div>`}
      </div>`;
    centreClanTab(content);
    if (ownData) await mountPanel(content, view.tab);
    else wireRetry(content, () => renderClan(content));
    return;
  }
  if (!data.linked) {
    // No game data (yet): the strip stays, so Triumphal Chests and Resources are reachable.
    content.innerHTML = `<div class="clan-page">${clanTabsHtml(view.tab)}
        ${ownData
          ? ownDataBoxHtml(view.tab)
          : noteTile(t("The clan hasn't been read from the game yet. The next scan reads it."))}
      </div>`;
    centreClanTab(content);
    if (ownData) await mountPanel(content, view.tab);
    return;
  }

  const clanTrees = asList(trees?.trees).filter((tr) => tr.kind === 'clan' && tr.nodes.length && !/talents/i.test(tr.layout || ''));
  const levels = data.techs?.levels || {};
  if (!CLAN_TABS.some((tb) => tb.key === view.tab)) view.tab = 'research';

  const panel = (key, html) => `<div class="clan-panel" data-clan-panel="${key}"${key === view.tab ? '' : ' hidden'}>${html}</div>`;
  content.innerHTML = `
    <div class="clan-page" data-clan-page>
      ${headerHtml(data)}
      ${statsHtml(data)}
      ${clanTabsHtml(view.tab)}
      ${panel('research', researchHtml(clanTrees, levels, data.techs))}
      ${panel('rankings', '<div data-clan-rankings></div>')}
      ${panel('treasury', treasuryHtml(data.treasury))}
      ${panel('resources', ownDataBoxHtml('resources'))}
      ${panel('history', historyHtml(asList(data.history)))}
      ${panel('roster', rosterPanelHtml())}
      ${panel('triumphal', ownDataBoxHtml('triumphal'))}
    </div>`;

  clanData = data;
  centreClanTab(content);
  wireTrees(content, clanTrees, levels, trees);
  // A whole page in a tab (Triumphal, Resources) is awaited, so the router's
  // scroll reset and <details> restore run after it; the rest fill in behind.
  if (OWN_DATA_TABS.has(view.tab)) await mountPanel(content, view.tab);
  else mountPanel(content, view.tab);
  // The rank tile is a link to #clan/rankings: open it on that ranking. When
  // Rankings is already drawn, redraw it on that ranking now (no fetch); the
  // link then switches the tab, or — already on it — nothing else is needed.
  content.querySelectorAll('[data-goto-ranking]').forEach((el) => el.addEventListener('click', (ev) => {
    view.rankKind = Number(el.dataset.gotoRanking);
    view.rankPage = null;
    if (content.querySelector('[data-clan-rankings]')?.dataset.mounted) mountRankings(content, data, true);
    if (view.tab === 'rankings') ev.preventDefault();
  }));
}

// ─── Header ──────────────────────────────────────────────────────────────

function headerHtml(data) {
  const i = data.info;
  const pills = [];
  if (i.realm) pills.push(`<span class="game-fact-pill is-rank">${t('Kingdom #{n}', { n: i.realm })}</span>`);
  if (i.capitalX !== null && i.capitalY !== null) {
    pills.push(`<span class="game-fact-pill" title="${esc(tGame('Clan Capital'))}">${t('Capital K:{k} X:{x} Y:{y}', { k: i.realm ?? '?', x: i.capitalX, y: i.capitalY })}</span>`);
  }
  if (i.foundedAt) {
    pills.push(`<span class="game-fact-pill" title="${esc(formatDate(i.foundedAt))}">${t('Founded {date}', { date: formatDateShort(i.foundedAt) })}</span>`);
  }
  if (i.leader?.name) {
    const who = i.leader.memberId ? memberLink(i.leader.memberId, i.leader.name) : esc(i.leader.name);
    pills.push(`<span class="game-fact-pill">${t('Leader: {name}', { name: who })}</span>`);
  }
  if (i.language) pills.push(`<span class="game-fact-pill">${esc(languageName(i.language))}</span>`);

  return `
    <section class="ui-tile span-12 clan-head" aria-labelledby="clanHeadName">
      <div class="clan-head-top">
        ${i.logoUrl ? `<img class="clan-head-logo" src="${esc(i.logoUrl)}" alt="${esc(t('Clan logo'))}" width="87" height="87" decoding="async">` : ''}
        <div class="clan-head-main">
          <h2 class="clan-head-name" id="clanHeadName"><span class="clan-head-tag">[${esc(i.tag)}]</span> ${esc(i.name)}</h2>
          <div class="game-facts clan-head-facts">${pills.join('')}</div>
        </div>
      </div>
      ${medalsHtml(asList(data.medals))}
      ${data.stats ? `<p class="ui-sub" title="${esc(formatDate(data.stats.capturedAt))}">${t('Read from the game {date}', { date: esc(formatDate(data.stats.capturedAt)) })}</p>` : ''}
    </section>`;
}

function medalsHtml(medals) {
  if (!medals.length) return '';
  return `<ul class="clan-medals" aria-label="${esc(t('Medals'))}">
    ${medals.map((m) => {
      const icon = m.iconUrl || '';
      const tierName = m.tierName ? tGame(m.tierName) : '';
      const title = [m.description, m.earnedAt ? t('Earned {date}', { date: formatDateShort(m.earnedAt) }) : ''].filter(Boolean).join('\n');
      return `<li class="clan-medal ${TIER_CLASS[m.tier] || ''}" title="${esc(title)}">
        ${icon ? `<img class="clan-medal-icon" src="${esc(icon)}" alt="" width="40" height="40" loading="lazy" decoding="async">` : '<span class="clan-medal-glyph" aria-hidden="true"></span>'}
        <span class="clan-medal-text">
          <span class="clan-medal-name">${esc(m.name ? tGame(m.name) : t('Medal #{n}', { n: m.medalId }))}</span>
          <span class="clan-medal-sub">${esc([tierName, m.earnedAt ? formatDateShort(m.earnedAt) : ''].filter(Boolean).join(' · '))}</span>
        </span>
      </li>`;
    }).join('')}
  </ul>`;
}

// ─── Stats ───────────────────────────────────────────────────────────────

function statsHtml(data) {
  const s = data.stats;
  if (!s) return '';
  // The change since the previous game day's last read.
  const days = asList(data.history);
  const prev = [...days].reverse().find((d) => d.gameDate < s.gameDate) || null;
  const delta = (key, format = fmt) => {
    if (!prev || prev[key] === null || prev[key] === undefined || s[key] === null || s[key] === undefined) return '';
    return t('{change} since {date}', { change: signed(s[key] - prev[key], format), date: formatGameDayShort(prev.gameDate) });
  };
  const tiles = [
    statTileHtml({
      label: t('Members'),
      value: s.memberLimit ? `${fmt(s.members)}<span class="ui-big-of"> / ${fmt(s.memberLimit)}</span>` : fmt(s.members),
      sub: delta('members'),
    }),
    statTileHtml({ label: t('Might'), value: compact(s.might), title: fmt(s.might), sub: delta('might', compact) }),
  ];
  if (s.wealth !== null) tiles.push(statTileHtml({ label: t('Wealth points'), value: compact(s.wealth), title: fmt(s.wealth), sub: delta('wealth', compact) }));
  if (s.helpPoints !== null) tiles.push(statTileHtml({ label: t('Help points'), value: compact(s.helpPoints), title: fmt(s.helpPoints), sub: delta('helpPoints', compact) }));
  if (s.wealthRank !== null) {
    // A rank opens that ranking on the Rankings tab.
    tiles.push(statTileHtml({
      label: t('Rank by wealth'),
      value: `#${s.wealthRank}`,
      sub: data.info.realm ? t('in kingdom #{n}', { n: data.info.realm }) : '',
      href: '#clan/rankings',
      attrs: `data-goto-ranking="7" title="${esc(t('Open the clan rankings'))}"`,
    }));
  }
  return statTilesHtml(tiles, 'clan-stats');
}

// ─── Research ────────────────────────────────────────────────────────────

function researchHtml(clanTrees, levels, techs) {
  if (!clanTrees.length) return noteTile(t("Couldn't load the research trees. Try again in a minute."));
  if (!techs?.readAt) return noteTile(t("The clan's research hasn't been read from the game yet. The next scan reads it."));
  if (!clanTrees.some((tr) => tr.id === view.tree)) view.tree = clanTrees[0].id;

  const rows = clanTrees.map((tr) => {
    const count = { done: 0, progress: 0, todo: 0 };
    for (const n of tr.nodes) {
      const st = nodeState(n, levels);
      if (st === 'done') count.done++;
      else if (st === 'progress') count.progress++;
      else count.todo++;
    }
    const p = treeProgress(tr, levels);
    return `<tr>
      <td data-label="${esc(t('Tree'))}" data-role="primary">
        <span class="clan-tree-cell">
          ${tr.iconUrl ? `<img class="clan-tree-icon" src="${esc(tr.iconUrl)}" alt="" width="28" height="28" loading="lazy" decoding="async">` : ''}
          <span class="mrow-name">${esc(tGame(tr.name))}</span>
        </span>
      </td>
      <td data-label="${esc(t('Maxed'))}" class="num">${count.done} / ${tr.nodes.length}</td>
      <td data-label="${esc(t('In progress'))}" class="num">${count.progress}</td>
      <td data-label="${esc(t('Not started'))}" class="num">${count.todo}</td>
      <td data-label="${esc(t('Levels'))}" data-role="metric" class="num">
        <span class="clan-tree-pct" style="--clan-fill:${p.pct}%">${p.pct}%</span>
        <span class="clan-tree-levels">${fmt(p.done)} / ${fmt(p.total)}</span>
      </td>
    </tr>`;
  }).join('');

  const picker = `<div class="tech-tree-picker">
    ${clanTrees.map((tr) => {
      const p = treeProgress(tr, levels);
      const on = tr.id === view.tree;
      return `<button type="button" class="tech-tree-btn${on ? ' is-active' : ''}${p.pct === 100 ? ' is-done' : ''}" data-clan-tree="${tr.id}" aria-pressed="${on}">
        ${tr.iconUrl ? `<img class="tech-tree-btn-icon" src="${esc(tr.iconUrl)}" alt="" loading="lazy" decoding="async">` : ''}
        <span class="tech-tree-btn-name">${esc(tGame(tr.name))}</span>
        <span class="tech-tree-btn-pct">${p.pct}%</span>
      </button>`;
    }).join('')}
  </div>`;

  return `<div class="clan-stack">
    ${tableCardHtml({
      title: t('Clan research'),
      hint: t('read from the game {date}', { date: esc(formatDateShort(techs.readAt)) }),
      hintTitle: formatDate(techs.readAt),
      body: `<table class="table-responsive ui-table clan-trees-table">
          <colgroup><col class="col-tree"><col class="col-n"><col class="col-n"><col class="col-n"><col class="col-levels"></colgroup>
          <thead><tr><th>${t('Tree')}</th><th class="num">${t('Maxed')}</th><th class="num">${t('In progress')}</th><th class="num">${t('Not started')}</th><th class="num">${t('Levels')}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`,
    })}
    ${tileHtml('clan-tech-trees', t('Technology trees'), `${picker}<div class="tech-tree-view" data-clan-tree-view></div>`, { span: 12 })}
    ${changesHtml(clanTrees, asList(techs.changes))}
  </div>`;
}

function wireTrees(root, clanTrees, levels, trees) {
  const viewEl = root.querySelector('[data-clan-tree-view]');
  if (!viewEl) return;
  const phone = window.matchMedia(PHONE);
  const draw = () => {
    const tree = clanTrees.find((tr) => tr.id === view.tree);
    viewEl.innerHTML = treeHtml(tree, levels, trees, phone.matches);
  };
  draw();
  phone.addEventListener?.('change', () => { if (viewEl.isConnected) draw(); });
  root.querySelectorAll('[data-clan-tree]').forEach((btn) => btn.addEventListener('click', () => {
    view.tree = Number(btn.dataset.clanTree);
    root.querySelectorAll('[data-clan-tree]').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    draw();
  }));
}

function changesHtml(clanTrees, changes) {
  const inTrees = new Map(clanTrees.flatMap((tr) => tr.nodes.map((n) => [n.techId, { node: n, tree: tr }])));
  const rows = changes.filter((c) => inTrees.has(c.techId)).slice(0, CHANGES_SHOWN);
  const body = rows.length
    ? `<table class="table-responsive ui-table tech-changes-table">
        <colgroup><col class="col-tech"><col class="col-tree"><col class="col-level"><col class="col-date"></colgroup>
        <thead><tr><th>${t('Name')}</th><th>${t('Tree')}</th><th class="num">${t('Level')}</th><th>${t('Date')}</th></tr></thead>
        <tbody>
          ${rows.map((c) => {
            const hit = inTrees.get(c.techId);
            return `<tr>
              <td data-label="${esc(t('Name'))}" data-role="primary"><span class="mrow-name">${esc(tGame(hit.node.name))}</span></td>
              <td data-label="${esc(t('Tree'))}" data-role="hidden">${esc(tGame(hit.tree.name))}</td>
              <td data-label="${esc(t('Level'))}" data-role="metric" class="num">${c.level}/${hit.node.maxLevel}</td>
              <td data-label="${esc(t('Date'))}">${esc(formatDate(c.changedAt))}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`
    : emptyHtml(t('No level-ups since the clan was first read. New ones show here with the scan that saw them.'));
  return tableCardHtml({
    title: t('Recent research'),
    hint: rows.length ? tn(rows.length, '{n} change in the last 90 days', '{n} changes in the last 90 days', { n: rows.length }) : '',
    body,
  });
}

// ─── Rankings ────────────────────────────────────────────────────────────

/** The game's clan ranking categories, in its own order (message 23 kinds). */
const RANKING_LABELS = {
  7: t('Wealth'),
  1: t('Might'),
  3: t('Valor points gained'),
  4: t('Conquest points gained'),
  5: t('Crypt exploration'),
};
const RANK_HISTORY_SHOWN = 30;
const RANK_PAGE_SIZE = 25;

let rankingsPromise = null;

/** Fill the Rankings panel (fetched the first time it opens; `redraw` re-renders the kept data). */
async function mountRankings(root, data, redraw = false) {
  const el = root.querySelector('[data-clan-rankings]');
  if (!el) return;
  if (el.dataset.mounted && !redraw) return;
  el.dataset.mounted = '1';
  if (!el.innerHTML) el.innerHTML = `<div class="ui-tile span-12 clan-note"><p class="ui-sub">${t('Loading…')}</p></div>`;
  let r;
  try {
    rankingsPromise = rankingsPromise || api('/game/clan/rankings');
    r = await rankingsPromise;
  } catch (err) {
    rankingsPromise = null;
    el.dataset.mounted = '';
    if (err?.name === 'AbortError') { el.innerHTML = ''; return; }
    r = null;
  }
  const why = refusalText(r);
  if (r === null || why) {
    rankingsPromise = null;
    el.dataset.mounted = '';
    el.innerHTML = `<div class="ui-tile span-12">${errorStateHtml(t("Couldn't load the clan rankings. Try again in a minute."), why)}</div>`;
    wireRetry(el, () => mountRankings(root, data, true));
    return;
  }
  const kinds = asList(r.kinds).filter((k) => RANKING_LABELS[k.kind]).map((k) => ({ ...k, entries: asList(k.entries) }));
  if (!kinds.some((k) => k.entries.length)) {
    el.innerHTML = noteTile(t("The clan rankings haven't been read from the game yet. The next scan reads them."));
    return;
  }
  if (!kinds.some((k) => k.kind === view.rankKind)) view.rankKind = kinds[0].kind;
  const draw = () => {
    el.innerHTML = rankingsHtml(kinds, r, data);
    el.querySelectorAll('[data-rank-kind]').forEach((btn) => btn.addEventListener('click', () => {
      view.rankKind = Number(btn.dataset.rankKind);
      view.rankPage = null;
      draw();
    }));
    el.querySelectorAll('[data-rank-page]').forEach((btn) => btn.addEventListener('click', () => {
      view.rankPage = Number(btn.dataset.rankPage);
      draw();
    }));
  };
  draw();
}

function rankingsHtml(kinds, r, data) {
  const k = kinds.find((x) => x.kind === view.rankKind);
  const own = r.gameClanId;
  const picker = `<div class="clan-chips" role="group" aria-label="${esc(t('Ranking'))}">
    ${kinds.map((x) => {
      const on = x.kind === view.rankKind;
      return `<button type="button" class="ui-chip clan-rank-chip${on ? ' is-active' : ''}" data-rank-kind="${x.kind}" aria-pressed="${on}">
        ${x.iconUrl ? `<img class="clan-rank-kind-icon" src="${esc(x.iconUrl)}" alt="" width="22" height="22" decoding="async">` : ''}
        <span>${esc(RANKING_LABELS[x.kind])}</span>
      </button>`;
    }).join('')}
  </div>`;

  const at = k.entries.findIndex((e) => e.clanId === own);
  // 25 a page, opening on the page with this clan on it.
  const pages = Math.max(1, Math.ceil(k.entries.length / RANK_PAGE_SIZE));
  if (view.rankPage === null) view.rankPage = at < 0 ? 1 : Math.floor(at / RANK_PAGE_SIZE) + 1;
  view.rankPage = Math.min(Math.max(1, view.rankPage), pages);
  const first = (view.rankPage - 1) * RANK_PAGE_SIZE;
  const shown = k.entries.slice(first, first + RANK_PAGE_SIZE);
  const ownShown = at >= first && at < first + RANK_PAGE_SIZE;
  // Outside the list: the clan pinned under it, with its own value where the scan knows it.
  const ownValue = view.rankKind === 7 ? data.stats?.wealth : view.rankKind === 1 ? data.stats?.might : null;
  // The clan's own row shows its own tag and logo even when 15200 left it out.
  const fill = (e) => (e.clanId === own && !e.tag
    ? { ...e, tag: data.info.tag, name: data.info.name, logoUrl: e.logoUrl || data.info.logoUrl, members: e.members ?? data.stats?.members ?? null, memberLimit: e.memberLimit ?? data.stats?.memberLimit ?? null }
    : e);
  const row = (raw, rank, extra = '') => { const e = fill(raw); return `<tr class="${e.clanId === own ? 'is-own' : ''}${extra}">
      <td data-label="${esc(t('Rank'))}" data-role="lead" class="col-rank">${rank === null ? '—' : `#${rank}`}</td>
      <td data-label="${esc(t('Clan'))}" data-role="primary">
        <span class="clan-rank-cell">
          ${e.logoUrl ? `<img class="clan-rank-logo" src="${esc(e.logoUrl)}" alt="" width="32" height="32" loading="lazy" decoding="async">` : '<span class="clan-rank-logo is-empty" aria-hidden="true"></span>'}
          <span class="mrow-name"><span class="clan-rank-tag">[${esc(e.tag || '?')}]</span> ${esc(e.name || '')}</span>
        </span>
      </td>
      <td data-label="${esc(t('Members'))}" class="num">${e.members !== null && e.members !== undefined ? `${fmt(e.members)} / ${fmt(e.memberLimit)}` : '—'}</td>
      <td data-label="${esc(RANKING_LABELS[view.rankKind])}" data-role="metric" class="num" title="${esc(fmt(e.value))}">${fmt(e.value)}</td>
    </tr>`; };
  const rows = shown.map((e, i) => row(e, first + i + 1)).join('');
  // Not on this page: the clan pinned under it; not in the list at all: with the value the scan knows.
  const pinned = at >= 0 && !ownShown
    ? row(k.entries[at], at + 1, ' is-pinned')
    : at < 0
    ? row({
      clanId: own, tag: data.info.tag, name: data.info.name, logoUrl: data.info.logoUrl,
      members: data.stats?.members ?? null, memberLimit: data.stats?.memberLimit ?? null, value: ownValue ?? null,
    }, null, ' is-pinned')
    : '';
  const summary = at < 0
    ? t('{clan} is not in the top {n}', { clan: `[${esc(data.info.tag)}]`, n: k.entries.length })
    : t('{clan} is #{rank} of the top {n}', { clan: `[${esc(data.info.tag)}]`, rank: at + 1, n: k.entries.length });

  const pagination = pages > 1 ? `<div class="pagination">
      <button class="btn btn-tight" type="button" data-rank-page="${view.rankPage - 1}" ${view.rankPage <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
      <span class="pagination-info">${t('Page {page} of {pages}', { page: view.rankPage, pages })}</span>
      <button class="btn btn-tight" type="button" data-rank-page="${view.rankPage + 1}" ${view.rankPage >= pages ? 'disabled' : ''}>${t('Next →')}</button>
    </div>` : '';

  return `<div class="clan-stack">
    ${tableCardHtml({
      title: t('Clan ranking by Kingdom'),
      hint: k.capturedAt ? t('read from the game {date}', { date: esc(formatDateShort(k.capturedAt)) }) : '',
      hintTitle: k.capturedAt ? formatDate(k.capturedAt) : '',
      before: `${picker}<p class="ui-sub clan-rank-summary">${summary}</p>`,
      body: `<table class="table-responsive ui-table clan-rank-table">
          <colgroup><col class="col-rank"><col class="col-clan"><col class="col-members"><col class="col-value"></colgroup>
          <thead><tr><th class="col-rank">${t('Rank')}</th><th>${t('Clan')}</th><th class="num">${t('Members')}</th><th class="num">${esc(RANKING_LABELS[view.rankKind])}</th></tr></thead>
          <tbody>${rows}${pinned}</tbody>
        </table>`,
      foot: pagination,
    })}
    ${rankHistoryHtml(asList(r.history))}
  </div>`;
}

function rankHistoryHtml(history) {
  const days = history.filter((h) => h.kind === view.rankKind).reverse().slice(0, RANK_HISTORY_SHOWN);
  if (!days.length) return '';
  return tableCardHtml({
    title: t('Our rank by day'),
    hint: t('The last read of each game day'),
    body: `<table class="table-responsive ui-table clan-rank-history-table">
        <colgroup><col class="col-date"><col class="col-rank"><col class="col-value"></colgroup>
        <thead><tr><th>${t('Date')}</th><th class="col-rank">${t('Rank')}</th><th class="num">${esc(RANKING_LABELS[view.rankKind])}</th></tr></thead>
        <tbody>
          ${days.map((d) => `<tr>
            <td data-label="${esc(t('Date'))}" data-role="primary"><span class="mrow-name">${esc(formatGameDayShort(d.gameDate))}</span></td>
            <td data-label="${esc(t('Rank'))}" data-role="metric" class="col-rank">${d.rank === null ? esc(t('not in the top 100')) : `#${d.rank}`}</td>
            <td data-label="${esc(RANKING_LABELS[view.rankKind])}" class="num">${fmt(d.value)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`,
  });
}

// ─── Treasury ────────────────────────────────────────────────────────────

function treasuryHtml(treasury) {
  const rows = asList(treasury?.rows).filter((r) => r.name);
  if (!rows.length) return noteTile(t("The Clan Capital's treasury hasn't been read from the game yet."));
  const body = rows.map((r) => {
    const icon = r.iconUrl || resourceIconUrl(r.name);
    const change = r.previous === null || r.previous === undefined ? '' : signed(r.amount - r.previous);
    const dir = r.amount > (r.previous ?? r.amount) ? ' is-up' : r.amount < (r.previous ?? r.amount) ? ' is-down' : '';
    return `<tr>
      <td data-label="${esc(t('Resource'))}" data-role="primary">
        <span class="clan-res-cell">
          ${icon ? `<img class="clan-res-icon" src="${esc(icon)}" alt="" width="24" height="24" loading="lazy" decoding="async">` : ''}
          <span class="mrow-name">${esc(tGame(r.name))}</span>
        </span>
      </td>
      <td data-label="${esc(t('Amount'))}" data-role="metric" class="num" title="${esc(fmt(r.amount))}">${fmt(r.amount)}</td>
      <td data-label="${esc(t('Change'))}" class="num${dir}">${esc(change || '—')}</td>
    </tr>`;
  }).join('');
  return tableCardHtml({
    title: t('Clan Capital treasury'),
    hint: t('read from the game {date}', { date: esc(formatGameDayShort(treasury.gameDate)) }),
    hintTitle: formatDate(treasury.capturedAt),
    body: `<table class="table-responsive ui-table clan-treasury-table">
        <colgroup><col class="col-res"><col class="col-amount"><col class="col-change"></colgroup>
        <thead><tr><th>${t('Resource')}</th><th class="num">${t('Amount')}</th><th class="num">${t('Change since the day before')}</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`,
  });
}

// ─── History ─────────────────────────────────────────────────────────────

function historyHtml(days) {
  if (!days.length) return noteTile(t('No history yet: every scan adds a reading.'));
  const rows = [...days].reverse().slice(0, HISTORY_SHOWN).map((d) => `<tr>
      <td data-label="${esc(t('Date'))}" data-role="primary"><span class="mrow-name">${esc(formatGameDayShort(d.gameDate))}</span></td>
      <td data-label="${esc(t('Members'))}" class="num">${d.memberLimit ? `${fmt(d.members)} / ${fmt(d.memberLimit)}` : fmt(d.members)}</td>
      <td data-label="${esc(t('Might'))}" data-role="metric" class="num" title="${esc(fmt(d.might))}">${compact(d.might)}</td>
      <td data-label="${esc(t('Wealth points'))}" class="num" title="${esc(fmt(d.wealth))}">${compact(d.wealth)}</td>
      <td data-label="${esc(t('Help points'))}" class="num" title="${esc(fmt(d.helpPoints))}">${compact(d.helpPoints)}</td>
      <td data-label="${esc(t('Rank by wealth'))}" class="num">${d.wealthRank ? `#${d.wealthRank}` : '—'}</td>
    </tr>`).join('');
  return tableCardHtml({
    title: t('Clan history'),
    hint: t('The last read of each game day'),
    body: `<table class="table-responsive ui-table clan-history-table">
        <colgroup><col class="col-date"><col class="col-members"><col class="col-num"><col class="col-num"><col class="col-num"><col class="col-rank"></colgroup>
        <thead><tr><th>${t('Date')}</th><th class="num">${t('Members')}</th><th class="num">${t('Might')}</th><th class="num">${t('Wealth points')}</th><th class="num">${t('Help points')}</th><th class="num">${t('Rank by wealth')}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`,
  });
}
