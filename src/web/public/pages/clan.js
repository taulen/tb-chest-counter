// Clan page — the clan as the game's own clan window shows it, read by every
// scan (game-protocol-phase.ts → collectClan, /api/game/clan):
//
//   header  [TAG] Name, kingdom, the Clan Capital's position, founded, leader,
//           language, and the medals the clan displays (Information tab);
//   stats   members / member limit, might, wealth points, help points, rank by
//           wealth in the kingdom — each with its change since the day before;
//   tabs    Research: the clan's three technology trees (Clan territories,
//           Allies, Fortifications — Clan Capital field 17) drawn like the
//           profile's research trees, with a per-tree summary and recent
//           level-ups. Treasury: the capital's stock per resource.
//           History: one row per game day.
//
// The trees come from /api/game/tech-trees (the same file the profile uses);
// only the clan trees the game's clan research holds are shown — tree 17
// (clanTalentsTree17) is a different, per-player thing.

import { api } from '../lib/api.js';
import { esc, formatDate, formatDateShort, formatGameDayShort, memberLink } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { loadGameArt, gameArtUrl, resourceIconUrl } from '../lib/game-art.js';
import { viewTabsHtml, viewPanelHtml, wireViewTabs } from '../lib/view-tabs.js';
import { loadTrees, treeHtml, treeProgress, nodeState } from './member-techs.js';

const PHONE = '(max-width: 640px)';
const CHANGES_SHOWN = 60;
const HISTORY_SHOWN = 30;

/** The open tab and tree, kept while navigating within the SPA. */
const view = { tab: 'research', tree: null };

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
  content.innerHTML = `<div class="card"><div class="card-body card-body-padded"><p class="muted-copy">${t('Loading…')}</p></div></div>`;
  let data;
  let trees = null;
  try {
    [data, trees] = await Promise.all([
      api('/game/clan'),
      loadTrees().catch(() => null),
      loadGameArt(),
    ]);
  } catch {
    content.innerHTML = noteCard(t("Couldn't load the clan. Try again in a minute."));
    return;
  }
  if (!data?.linked) {
    content.innerHTML = noteCard(t("The clan hasn't been read from the game yet. The next scan reads it."));
    return;
  }

  const clanTrees = (trees?.trees || []).filter((tr) => tr.kind === 'clan' && tr.nodes.length && !/talents/i.test(tr.layout || ''));
  const levels = data.techs?.levels || {};
  const tabs = [
    { key: 'research', label: esc(t('Research')) },
    { key: 'treasury', label: esc(t('Treasury')) },
    { key: 'history', label: esc(t('History')) },
  ];
  if (!tabs.some((tb) => tb.key === view.tab)) view.tab = 'research';

  content.innerHTML = `
    <div class="clan-page">
      ${headerHtml(data)}
      ${statsHtml(data)}
      ${viewTabsHtml('clan-view', tabs, view.tab)}
      ${viewPanelHtml('clan-view', 'research', view.tab, researchHtml(clanTrees, levels, data.techs))}
      ${viewPanelHtml('clan-view', 'treasury', view.tab, treasuryHtml(data.treasury))}
      ${viewPanelHtml('clan-view', 'history', view.tab, historyHtml(data.history || []))}
    </div>`;

  wireViewTabs(content, 'clan-view', (key) => { view.tab = key; });
  wireTrees(content, clanTrees, levels, trees);
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
        <h2 class="clan-head-name"><span class="clan-head-tag">[${esc(i.tag)}]</span> ${esc(i.name)}</h2>
        <div class="game-facts clan-head-facts">${pills.join('')}</div>
        ${medalsHtml(data.medals || [])}
        ${data.stats ? `<p class="clan-head-read" title="${esc(formatDate(data.stats.capturedAt))}">${t('Read from the game {date}', { date: esc(formatDate(data.stats.capturedAt)) })}</p>` : ''}
      </div>
    </div>`;
}

function medalsHtml(medals) {
  if (!medals.length) return '';
  return `<ul class="clan-medals" aria-label="${esc(t('Medals'))}">
    ${medals.map((m) => {
      const icon = gameArtUrl(m.icon || '');
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
  const card = (label, value, { title = '', sub = '' } = {}) => `
    <div class="stat-card">
      <div class="label">${label}</div>
      <div class="value"${title ? ` title="${esc(title)}"` : ''}>${value}</div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
    </div>`;
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

// ─── Treasury ────────────────────────────────────────────────────────────

function treasuryHtml(treasury) {
  const rows = (treasury?.rows || []).filter((r) => r.name);
  if (!rows.length) return noteCard(t("The Clan Capital's treasury hasn't been read from the game yet."));
  const body = rows.map((r) => {
    const icon = resourceIconUrl(r.name);
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
