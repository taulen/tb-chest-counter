// Clan page — the clan as the game's own clan window shows it, read by every
// scan (game-protocol-phase.ts → collectClan, /api/game/clan):
//
//   header  the clan logo (composed from the game's layers, game-art/
//           clan-logo.ts), [TAG] Name, kingdom, the Clan Capital's position,
//           founded, leader, language, and the medals the clan displays;
//   stats   members / member limit, might, wealth points, help points, rank by
//           wealth in the kingdom (opens Rankings) — each with its change
//           since the day before;
//   tabs    Research: the clan's three technology trees (Clan territories,
//           Allies, Fortifications — Clan Capital field 17) drawn like the
//           profile's research trees, with a per-tree summary and recent
//           level-ups. Rankings: the game's "Clan ranking by Kingdom" — five
//           categories, the top 100 with logos, this clan highlighted (pinned
//           under the list when outside it), its rank by day; loaded when the
//           tab opens (/api/game/clan/rankings). Treasury: the capital's stock
//           per item, each with its own game icon. History: one row per game day.
//
// The trees come from /api/game/tech-trees (the same file the profile uses);
// only the clan trees the game's clan research holds are shown — tree 17
// (clanTalentsTree17) is a different, per-player thing.

import { api } from '../lib/api.js';
import { esc, formatDate, formatDateShort, formatGameDayShort, memberLink } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { loadGameArt, resourceIconUrl } from '../lib/game-art.js';
import { viewTabsHtml, viewPanelHtml, wireViewTabs } from '../lib/view-tabs.js';
import { loadTrees, treeHtml, treeProgress, nodeState } from './member-techs.js';

const PHONE = '(max-width: 640px)';
const CHANGES_SHOWN = 60;
const HISTORY_SHOWN = 30;

/** The open tab and tree, kept while navigating within the SPA. */
const view = { tab: 'research', tree: null, rankKind: 7, rankPage: null };

// My Clan's sections. Triumphal Chests is a tab here too (Nov 2026: it left the
// main menu), but a page of its own (#triumphal): its period selector lives in
// the address, so it can't be an in-page panel.
const CLAN_TABS = [
  { key: 'research', label: () => t('Research') },
  { key: 'rankings', label: () => t('Rankings') },
  { key: 'treasury', label: () => t('Treasury') },
  { key: 'history', label: () => t('History') },
  { key: 'triumphal', label: () => t('Triumphal Chests') },
];

/** Open My Clan on a section (#clan/<tab>). */
export function setClanTab(key) {
  if (CLAN_TABS.some((tb) => tb.key === key && key !== 'triumphal')) view.tab = key;
}

/** My Clan's tab strip as links, for the Triumphal Chests page (#triumphal). */
export function clanTabLinksHtml(active) {
  return `<div class="resources-tabs view-tabs" role="navigation" aria-label="${esc(t('Page sections'))}">${CLAN_TABS.map((tb) => {
    const href = tb.key === 'triumphal' ? '#triumphal' : `#clan/${tb.key}`;
    return `<a class="resources-tab${tb.key === active ? ' is-active' : ''}" href="${href}"${tb.key === active ? ' aria-current="page"' : ''}>${esc(tb.label())}</a>`;
  }).join('')}</div>`;
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

function noteCard(text) {
  return `<div class="card"><div class="card-body card-body-padded"><div class="empty-state"><p>${text}</p></div></div></div>`;
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
  content.innerHTML =`<div class="card"><div class="card-body card-body-padded"><p class="muted-copy">${t('Loading…')}</p></div></div>`;
  let data;
  let trees = null;
  try {
    [data, trees] = await Promise.all([
      api('/game/clan'),
      loadTrees().catch(() => null),
      loadGameArt(),
    ]);
  } catch {
    // The strip stays, so Triumphal Chests is reachable whatever the game data.
    content.innerHTML = clanTabLinksHtml(view.tab) + noteCard(t("Couldn't load the clan. Try again in a minute."));
    return;
  }
  if (!data?.linked) {
    content.innerHTML = clanTabLinksHtml(view.tab) + noteCard(t("The clan hasn't been read from the game yet. The next scan reads it."));
    return;
  }

  const clanTrees = (trees?.trees || []).filter((tr) => tr.kind === 'clan' && tr.nodes.length && !/talents/i.test(tr.layout || ''));
  const levels = data.techs?.levels || {};
  const tabs = CLAN_TABS.map((tb) => ({ key: tb.key, label: esc(tb.label()) }));
  if (!tabs.some((tb) => tb.key === view.tab) || view.tab === 'triumphal') view.tab = 'research';

  content.innerHTML = `
    <div class="clan-page">
      ${headerHtml(data)}
      ${statsHtml(data)}
      ${viewTabsHtml('clan-view', tabs, view.tab)}
      ${viewPanelHtml('clan-view', 'research', view.tab, researchHtml(clanTrees, levels, data.techs))}
      ${viewPanelHtml('clan-view', 'rankings', view.tab, '<div data-clan-rankings></div>')}
      ${viewPanelHtml('clan-view', 'treasury', view.tab, treasuryHtml(data.treasury))}
      ${viewPanelHtml('clan-view', 'history', view.tab, historyHtml(data.history || []))}
    </div>`;

  wireViewTabs(content, 'clan-view', (key) => {
    if (key === 'triumphal') {
      window.location.hash = '#triumphal';
      return;
    }
    view.tab = key;
    if (key === 'rankings') mountRankings(content, data);
  });
  wireTrees(content, clanTrees, levels, trees);
  if (view.tab === 'rankings') mountRankings(content, data);
  // The rank stat card opens the Rankings tab on that ranking.
  content.querySelectorAll('[data-goto-ranking]').forEach((el) => el.addEventListener('click', () => {
    view.rankKind = Number(el.dataset.gotoRanking);
    view.rankPage = null;
    const tab = content.querySelector('#clan-view-tab-rankings');
    if (tab?.getAttribute('aria-selected') === 'true') mountRankings(content, data, true);
    else tab?.click();
    tab?.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
    <div class="card clan-head">
      <div class="card-body card-body-padded">
        <div class="clan-head-top">
          ${i.logoUrl ? `<img class="clan-head-logo" src="${esc(i.logoUrl)}" alt="${esc(t('Clan logo'))}" width="87" height="87" decoding="async">` : ''}
          <div class="clan-head-main">
            <h2 class="clan-head-name"><span class="clan-head-tag">[${esc(i.tag)}]</span> ${esc(i.name)}</h2>
            <div class="game-facts clan-head-facts">${pills.join('')}</div>
          </div>
        </div>
        ${medalsHtml(data.medals || [])}
        ${data.stats ? `<p class="clan-head-read" title="${esc(formatDate(data.stats.capturedAt))}">${t('Read from the game {date}', { date: esc(formatDate(data.stats.capturedAt)) })}</p>` : ''}
      </div>
    </div>`;
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
  const days = data.history || [];
  const prev = [...days].reverse().find((d) => d.gameDate < s.gameDate) || null;
  const delta = (key, format = fmt) => {
    if (!prev || prev[key] === null || prev[key] === undefined || s[key] === null || s[key] === undefined) return '';
    return t('{change} since {date}', { change: signed(s[key] - prev[key], format), date: formatGameDayShort(prev.gameDate) });
  };
  const card = (label, value, { title = '', sub = '', ranking = null } = {}) => {
    const inner = `
      <div class="label">${label}</div>
      <div class="value"${title ? ` title="${esc(title)}"` : ''}>${value}</div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}`;
    // A rank opens that ranking on the Rankings tab.
    return ranking === null
      ? `<div class="stat-card">${inner}</div>`
      : `<button type="button" class="stat-card stat-card-link" data-goto-ranking="${ranking}" title="${esc(t('Open the clan rankings'))}">${inner}</button>`;
  };
  const cards = [
    card(t('Members'), s.memberLimit ? `${fmt(s.members)} / ${fmt(s.memberLimit)}` : fmt(s.members), {
      sub: delta('members'),
    }),
    card(t('Might'), compact(s.might), { title: fmt(s.might), sub: delta('might', compact) }),
  ];
  if (s.wealth !== null) cards.push(card(t('Wealth points'), compact(s.wealth), { title: fmt(s.wealth), sub: delta('wealth', compact) }));
  if (s.helpPoints !== null) cards.push(card(t('Help points'), compact(s.helpPoints), { title: fmt(s.helpPoints), sub: delta('helpPoints', compact) }));
  if (s.wealthRank !== null) {
    cards.push(card(t('Rank by wealth'), `#${s.wealthRank}`, {
      sub: data.info.realm ? t('in kingdom #{n}', { n: data.info.realm }) : '',
      ranking: 7,
    }));
  }
  return `<div class="stats-grid clan-stats">${cards.join('')}</div>`;
}

// ─── Research ────────────────────────────────────────────────────────────

function researchHtml(clanTrees, levels, techs) {
  if (!clanTrees.length) return noteCard(t("Couldn't load the research trees. Try again in a minute."));
  if (!techs?.readAt) return noteCard(t("The clan's research hasn't been read from the game yet. The next scan reads it."));
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

  return `
    <div class="card">
      <div class="card-header"><h2>${t('Clan research')}</h2>
        <span class="card-header-hint" title="${esc(formatDate(techs.readAt))}">${t('read from the game {date}', { date: esc(formatDateShort(techs.readAt)) })}</span>
      </div>
      <div class="card-body">
        <table class="table-responsive clan-trees-table">
          <colgroup><col class="col-tree"><col class="col-n"><col class="col-n"><col class="col-n"><col class="col-levels"></colgroup>
          <thead><tr><th>${t('Tree')}</th><th class="num">${t('Maxed')}</th><th class="num">${t('In progress')}</th><th class="num">${t('Not started')}</th><th class="num">${t('Levels')}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h2>${t('Technology trees')}</h2></div>
      <div class="card-body card-body-padded">
        ${picker}
        <div class="tech-tree-view" data-clan-tree-view></div>
      </div>
    </div>
    ${changesHtml(clanTrees, techs.changes || [])}`;
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
    ? `<table class="table-responsive tech-changes-table">
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
    : `<div class="card-body-padded"><p class="muted-copy">${t('No level-ups since the clan was first read. New ones show here with the scan that saw them.')}</p></div>`;
  return `<div class="card">
      <div class="card-header"><h2>${t('Recent research')}</h2>
        ${rows.length ? `<span class="card-header-hint">${tn(rows.length, '{n} change in the last 90 days', '{n} changes in the last 90 days', { n: rows.length })}</span>` : ''}
      </div>
      <div class="card-body">${body}</div>
    </div>`;
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
  if (!el.innerHTML) el.innerHTML = `<div class="card"><div class="card-body card-body-padded"><p class="muted-copy">${t('Loading…')}</p></div></div>`;
  let r;
  try {
    rankingsPromise = rankingsPromise || api('/game/clan/rankings');
    r = await rankingsPromise;
  } catch {
    rankingsPromise = null;
    el.dataset.mounted = '';
    el.innerHTML = noteCard(t("Couldn't load the clan rankings. Try again in a minute."));
    return;
  }
  const kinds = (r.kinds || []).filter((k) => RANKING_LABELS[k.kind]);
  if (!kinds.some((k) => k.entries.length)) {
    el.innerHTML = noteCard(t("The clan rankings haven't been read from the game yet. The next scan reads them."));
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
  const picker = `<div class="tech-tree-picker clan-rank-picker" role="group" aria-label="${esc(t('Ranking'))}">
    ${kinds.map((x) => {
      const on = x.kind === view.rankKind;
      return `<button type="button" class="tech-tree-btn${on ? ' is-active' : ''}" data-rank-kind="${x.kind}" aria-pressed="${on}">
        ${x.iconUrl ? `<img class="clan-rank-kind-icon" src="${esc(x.iconUrl)}" alt="" width="22" height="22" decoding="async">` : ''}
        <span class="tech-tree-btn-name">${esc(RANKING_LABELS[x.kind])}</span>
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

  return `
    <div class="card">
      <div class="card-header"><h2>${t('Clan ranking by Kingdom')}</h2>
        ${k.capturedAt ? `<span class="card-header-hint" title="${esc(formatDate(k.capturedAt))}">${t('read from the game {date}', { date: esc(formatDateShort(k.capturedAt)) })}</span>` : ''}
      </div>
      <div class="card-body card-body-padded">
        ${picker}
        <p class="clan-rank-summary">${summary}</p>
      </div>
      <div class="card-body">
        <table class="table-responsive clan-rank-table">
          <colgroup><col class="col-rank"><col class="col-clan"><col class="col-members"><col class="col-value"></colgroup>
          <thead><tr><th class="col-rank">${t('Rank')}</th><th>${t('Clan')}</th><th class="num">${t('Members')}</th><th class="num">${esc(RANKING_LABELS[view.rankKind])}</th></tr></thead>
          <tbody>${rows}${pinned}</tbody>
        </table>
        ${pages > 1 ? `<div class="pagination">
          <button class="btn btn-tight" type="button" data-rank-page="${view.rankPage - 1}" ${view.rankPage <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
          <span class="pagination-info">${t('Page {page} of {pages}', { page: view.rankPage, pages })}</span>
          <button class="btn btn-tight" type="button" data-rank-page="${view.rankPage + 1}" ${view.rankPage >= pages ? 'disabled' : ''}>${t('Next →')}</button>
        </div>` : ''}
      </div>
    </div>
    ${rankHistoryHtml(r.history || [])}`;
}

function rankHistoryHtml(history) {
  const days = history.filter((h) => h.kind === view.rankKind).reverse().slice(0, RANK_HISTORY_SHOWN);
  if (!days.length) return '';
  return `<div class="card">
      <div class="card-header"><h2>${t('Our rank by day')}</h2>
        <span class="card-header-hint">${t('The last read of each game day')}</span>
      </div>
      <div class="card-body">
        <table class="table-responsive clan-rank-history-table">
          <colgroup><col class="col-date"><col class="col-rank"><col class="col-value"></colgroup>
          <thead><tr><th>${t('Date')}</th><th class="col-rank">${t('Rank')}</th><th class="num">${esc(RANKING_LABELS[view.rankKind])}</th></tr></thead>
          <tbody>
            ${days.map((d) => `<tr>
              <td data-label="${esc(t('Date'))}" data-role="primary"><span class="mrow-name">${esc(formatGameDayShort(d.gameDate))}</span></td>
              <td data-label="${esc(t('Rank'))}" data-role="metric" class="col-rank">${d.rank === null ? esc(t('not in the top 100')) : `#${d.rank}`}</td>
              <td data-label="${esc(RANKING_LABELS[view.rankKind])}" class="num">${fmt(d.value)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ─── Treasury ────────────────────────────────────────────────────────────

function treasuryHtml(treasury) {
  const rows = (treasury?.rows || []).filter((r) => r.name);
  if (!rows.length) return noteCard(t("The Clan Capital's treasury hasn't been read from the game yet."));
  const body = rows.map((r) => {
    const icon = r.iconUrl || resourceIconUrl(r.name);
    const change = r.previous === null || r.previous === undefined ? '' : signed(r.amount - r.previous);
    return `<tr>
      <td data-label="${esc(t('Resource'))}" data-role="primary">
        <span class="clan-res-cell">
          ${icon ? `<img class="clan-res-icon" src="${esc(icon)}" alt="" width="24" height="24" loading="lazy" decoding="async">` : ''}
          <span class="mrow-name">${esc(tGame(r.name))}</span>
        </span>
      </td>
      <td data-label="${esc(t('Amount'))}" data-role="metric" class="num" title="${esc(fmt(r.amount))}">${fmt(r.amount)}</td>
      <td data-label="${esc(t('Change'))}" class="num${r.amount > (r.previous ?? r.amount) ? ' is-up' : r.amount < (r.previous ?? r.amount) ? ' is-down' : ''}">${esc(change || '—')}</td>
    </tr>`;
  }).join('');
  return `<div class="card">
      <div class="card-header"><h2>${t('Clan Capital treasury')}</h2>
        <span class="card-header-hint" title="${esc(formatDate(treasury.capturedAt))}">${t('read from the game {date}', { date: esc(formatGameDayShort(treasury.gameDate)) })}</span>
      </div>
      <div class="card-body">
        <table class="table-responsive clan-treasury-table">
          <colgroup><col class="col-res"><col class="col-amount"><col class="col-change"></colgroup>
          <thead><tr><th>${t('Resource')}</th><th class="num">${t('Amount')}</th><th class="num">${t('Change since the day before')}</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

// ─── History ─────────────────────────────────────────────────────────────

function historyHtml(days) {
  if (!days.length) return noteCard(t('No history yet: every scan adds a reading.'));
  const rows = [...days].reverse().slice(0, HISTORY_SHOWN).map((d) => `<tr>
      <td data-label="${esc(t('Date'))}" data-role="primary"><span class="mrow-name">${esc(formatGameDayShort(d.gameDate))}</span></td>
      <td data-label="${esc(t('Members'))}" class="num">${d.memberLimit ? `${fmt(d.members)} / ${fmt(d.memberLimit)}` : fmt(d.members)}</td>
      <td data-label="${esc(t('Might'))}" data-role="metric" class="num" title="${esc(fmt(d.might))}">${compact(d.might)}</td>
      <td data-label="${esc(t('Wealth points'))}" class="num" title="${esc(fmt(d.wealth))}">${compact(d.wealth)}</td>
      <td data-label="${esc(t('Help points'))}" class="num" title="${esc(fmt(d.helpPoints))}">${compact(d.helpPoints)}</td>
      <td data-label="${esc(t('Rank by wealth'))}" class="num">${d.wealthRank ? `#${d.wealthRank}` : '—'}</td>
    </tr>`).join('');
  return `<div class="card">
      <div class="card-header"><h2>${t('Clan history')}</h2>
        <span class="card-header-hint">${t('The last read of each game day')}</span>
      </div>
      <div class="card-body">
        <table class="table-responsive clan-history-table">
          <colgroup><col class="col-date"><col class="col-members"><col class="col-num"><col class="col-num"><col class="col-num"><col class="col-rank"></colgroup>
          <thead><tr><th>${t('Date')}</th><th class="num">${t('Members')}</th><th class="num">${t('Might')}</th><th class="num">${t('Wealth points')}</th><th class="num">${t('Help points')}</th><th class="num">${t('Rank by wealth')}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}
