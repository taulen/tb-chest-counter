// Research and Talents tabs on the member profile: a member's level in every
// research and hero talent, drawn on the game's own trees (positions and links
// from /api/game/tech-trees, levels from /api/game/members/:id/techs — both
// read from the game, see docs/game-protocol.md).
//
// On a desktop a tree is drawn as the game draws it: left to right, three rows
// tall, scrolling sideways when wide. On a phone it is turned on its side — the
// game's columns become rows and its three rows three columns, which fit the
// screen — and reads top to bottom. Nodes carry their state (done, in progress,
// available, locked) and the prerequisite links; a summary above counts them.

import { api } from '../lib/api.js';
import { esc, formatDate, formatGameDayShort } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';

// Layout grids, in CSS px. Desktop: a step per game column and per game row.
// Phone (turned): node size, the gap between the three columns, and the step
// from one game column (a row there) to the next.
const DESK = { colStep: 192, rowStep: 82, nodeW: 176, nodeH: 64 };
const PHONE_GRID = { nodeW: 100, gap: 10, rowStep: 88, nodeH: 70 };
const PHONE = '(max-width: 640px)';

/** Troop families shown as headline stats on the Research tab. */
const TIER_STATS = [
  { key: 'guardsmen', letter: 'G', label: 'Guardsmen' },
  { key: 'specialists', letter: 'S', label: 'Specialists' },
  { key: 'engineers', letter: 'E', label: 'Engineer corps' },
  { key: 'monsters', letter: 'M', label: 'Monsters' },
  { key: 'crypts', letter: 'C', label: 'Crypts' },
];

let treesPromise = null;
/** The open tree per tab, kept across members so comparing players is one click. */
const openTree = { research: null, talent: null };

function loadTrees() {
  if (!treesPromise) {
    treesPromise = api('/game/tech-trees').then((r) => {
      if (!r || r.error || !Array.isArray(r.trees)) throw new Error(r?.error || 'no trees');
      return r;
    }).catch((err) => { treesPromise = null; throw err; });
  }
  return treesPromise;
}

/** The panel placeholder; mountMemberTechs fills it the first time its tab opens. */
export function memberTechPanelHtml(kind) {
  return `<div class="member-techs" data-member-techs="${kind}"><div class="card"><div class="card-body card-body-padded"><p class="muted-copy">${t('Loading…')}</p></div></div></div>`;
}

function noteCard(text) {
  return `<div class="card"><div class="card-body card-body-padded"><div class="empty-state"><p>${text}</p></div></div></div>`;
}

/**
 * Fill the `kind` ('research' | 'talent') panel inside `root` for a member.
 * `tiers` is the member's troop tiers from /api/game/members/:id (or null).
 */
export async function mountMemberTechs(root, memberId, kind, tiers) {
  const el = root.querySelector(`[data-member-techs="${kind}"]`);
  if (!el || el.dataset.mounted === String(memberId)) return;
  el.dataset.mounted = String(memberId);
  let trees;
  let techs;
  try {
    [trees, techs] = await Promise.all([loadTrees(), api(`/game/members/${memberId}/techs`)]);
  } catch {
    el.innerHTML = noteCard(t("Couldn't load the research trees. Try again in a minute."));
    return;
  }
  if (!techs?.linked || !techs.readAt) {
    el.innerHTML = noteCard(t("This member's research hasn't been read from the game yet. It is read once a day."));
    return;
  }
  render(el, kind, trees, techs, tiers);
}

function treeProgress(tree, levels) {
  let done = 0;
  let total = 0;
  for (const n of tree.nodes) {
    total += n.maxLevel;
    done += Math.min(levels[n.techId] ?? 0, n.maxLevel);
  }
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

function render(el, kind, trees, techs, tiers) {
  const levels = techs.levels || {};
  const list = trees.trees.filter((tr) => tr.kind === kind && tr.nodes.length);
  if (!list.length) {
    el.innerHTML = noteCard(t('No trees of this kind in the game data.'));
    return;
  }
  if (!list.some((tr) => tr.id === openTree[kind])) openTree[kind] = list[0].id;

  const head = kind === 'research' ? tiersHtml(tiers?.tiers) : talentSummaryHtml(list, levels);
  // Research trees are grouped the way the game's academy groups them.
  const groups = kind === 'research'
    ? [...new Set(list.map((tr) => tr.tab || ''))].map((tab) => ({ tab, trees: list.filter((tr) => (tr.tab || '') === tab) }))
    : [{ tab: '', trees: list }];
  const picker = groups.map((g) => `
    <div class="tech-tree-group">
      ${g.tab ? `<span class="tech-tree-group-label">${esc(tGame(g.tab))}</span>` : ''}
      <div class="tech-tree-picker">
        ${g.trees.map((tr) => {
          const p = treeProgress(tr, levels);
          return `<button type="button" class="tech-tree-btn${tr.id === openTree[kind] ? ' is-active' : ''}${p.pct === 100 ? ' is-done' : ''}" data-tree="${tr.id}" aria-pressed="${tr.id === openTree[kind]}">
            ${tr.iconUrl ? `<img class="tech-tree-btn-icon" src="${esc(tr.iconUrl)}" alt="" loading="lazy" decoding="async">` : ''}
            <span class="tech-tree-btn-name">${esc(tGame(tr.name))}</span>
            <span class="tech-tree-btn-pct">${p.pct}%</span>
          </button>`;
        }).join('')}
      </div>
    </div>`).join('');

  el.innerHTML = `
    ${head}
    <div class="card">
      <div class="card-header"><h2>${kind === 'research' ? t('Research') : t('Talents')}</h2>
        <span class="card-header-hint" title="${esc(formatDate(techs.readAt))}">${t('read from the game {date}', { date: esc(formatGameDayShort(techs.readAt.slice(0, 10))) })}</span>
      </div>
      <div class="card-body card-body-padded">
        ${picker}
        <div class="tech-tree-view" data-tree-view></div>
      </div>
    </div>
    ${changesHtml(kind, list, techs.changes || [])}`;

  const view = el.querySelector('[data-tree-view]');
  const phone = window.matchMedia(PHONE);
  const draw = () => {
    const tree = list.find((tr) => tr.id === openTree[kind]);
    view.innerHTML = treeHtml(tree, levels, trees, phone.matches);
  };
  draw();
  // Turning the phone (or resizing past the breakpoint) redraws the other way.
  phone.addEventListener?.('change', () => { if (view.isConnected) draw(); });
  el.querySelectorAll('.tech-tree-btn').forEach((btn) => btn.addEventListener('click', () => {
    openTree[kind] = Number(btn.dataset.tree);
    el.querySelectorAll('.tech-tree-btn').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    draw();
  }));
}

function tiersHtml(tiers) {
  if (!tiers) return '';
  const cards = TIER_STATS.filter((s) => tiers[s.key]).map((s) => `
    <div class="stat-card">
      <div class="label">${esc(tGame(s.label))}</div>
      <div class="value">${s.letter}${tiers[s.key]}</div>
    </div>`).join('');
  return cards ? `<div class="stats-grid tech-tiers">${cards}</div>` : '';
}

function talentSummaryHtml(list, levels) {
  let spent = 0;
  for (const tr of list) for (const n of tr.nodes) spent += Math.min(levels[n.techId] ?? 0, n.maxLevel);
  return `<div class="stats-grid tech-tiers">
      <div class="stat-card">
        <div class="label">${t('Talent points spent')}</div>
        <div class="value">${spent.toLocaleString('en-US')}</div>
      </div>
    </div>`;
}

/** A node's state for this player: done, in progress, available (every unlock requirement met), or locked. */
function nodeState(n, levels) {
  const lvl = Math.min(levels[n.techId] ?? 0, n.maxLevel);
  if (lvl >= n.maxLevel) return 'done';
  if (lvl > 0) return 'progress';
  const unlock = (n.requires || []).filter((r) => (r.atLevel ?? 1) <= 1);
  return unlock.every((r) => (levels[r.techId] ?? 0) >= r.level) ? 'available' : 'locked';
}

function treeSummaryHtml(tree, levels) {
  const count = { done: 0, progress: 0, available: 0, locked: 0 };
  for (const n of tree.nodes) count[nodeState(n, levels)]++;
  const p = treeProgress(tree, levels);
  const cell = (label, value, cls = '') => `<div class="tech-sum${cls}"><span class="tech-sum-value">${value}</span><span class="tech-sum-label">${label}</span></div>`;
  return `<div class="tech-summary">
      ${cell(t('Maxed'), `${count.done} / ${tree.nodes.length}`, ' is-done')}
      ${cell(t('In progress'), count.progress)}
      ${cell(t('Available'), count.available)}
      ${cell(t('Locked'), count.locked)}
      ${cell(t('Levels'), `${p.done.toLocaleString('en-US')} / ${p.total.toLocaleString('en-US')}`)}
    </div>`;
}

function treeHtml(tree, levels, trees, phone = false) {
  if (!tree) return '';
  const tall = phone;
  const NODE_W = tall ? PHONE_GRID.nodeW : DESK.nodeW;
  const NODE_H = tall ? PHONE_GRID.nodeH : DESK.nodeH;
  const byId = new Map(tree.nodes.map((n) => [n.techId, n]));
  const maxCol = Math.max(...tree.nodes.map((n) => n.col));
  const maxRow = Math.max(...tree.nodes.map((n) => n.row));
  // Desktop: the game's columns left to right. Phone: top to bottom, with the
  // game's three rows as the columns.
  const x = (n) => (tall ? n.row * (NODE_W + PHONE_GRID.gap) : n.col * DESK.colStep);
  const y = (n) => (tall ? n.col * PHONE_GRID.rowStep : n.row * DESK.rowStep);
  const width = Math.ceil(tall ? maxRow * (NODE_W + PHONE_GRID.gap) + NODE_W : maxCol * DESK.colStep + NODE_W);
  const height = Math.ceil(tall ? maxCol * PHONE_GRID.rowStep + NODE_H : maxRow * DESK.rowStep + NODE_H);

  // Links inside this tree; a requirement in another tree is named on the node instead.
  const links = [];
  for (const n of tree.nodes) {
    for (const r of n.requires || []) {
      const from = byId.get(r.techId);
      if (!from) continue;
      const met = (levels[r.techId] ?? 0) >= r.level;
      let d;
      if (tall) {
        const x1 = x(from) + NODE_W / 2;
        const y1 = y(from) + NODE_H;
        const x2 = x(n) + NODE_W / 2;
        const y2 = y(n);
        const mid = (y1 + y2) / 2;
        d = `M${x1} ${y1} C${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
      } else {
        const x1 = x(from) + NODE_W;
        const y1 = y(from) + NODE_H / 2;
        const x2 = x(n);
        const y2 = y(n) + NODE_H / 2;
        const mid = (x1 + x2) / 2;
        d = `M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
      }
      links.push(`<path class="tech-link${met ? ' is-met' : ''}" d="${d}" />`);
    }
  }
  const allNodes = new Map(trees.trees.flatMap((tr) => tr.nodes.map((n) => [n.techId, { node: n, tree: tr }])));

  const STATE_CLASS = { done: 'is-maxed', progress: 'is-partial', available: 'is-available', locked: 'is-locked' };
  const nodes = tree.nodes.map((n) => {
    const lvl = Math.min(levels[n.techId] ?? 0, n.maxLevel);
    const st = nodeState(n, levels);
    const state = STATE_CLASS[st];
    const levelText = st === 'done'
      ? t('L{level}/{max} · Done', { level: lvl, max: n.maxLevel })
      : st === 'available'
        ? t('Available · max {max}', { max: n.maxLevel })
        : t('L{level}/{max}', { level: lvl, max: n.maxLevel });
    const outside = (n.requires || []).filter((r) => !byId.has(r.techId)).map((r) => {
      const o = allNodes.get(r.techId);
      return o ? `${tGame(o.node.name)} ${r.level} (${tGame(o.tree.name)})` : '';
    }).filter(Boolean);
    const title = [
      `${tGame(n.name)} — ${lvl}/${n.maxLevel}`,
      n.description || '',
      outside.length ? t('Also needs: {list}', { list: outside.join(', ') }) : '',
    ].filter(Boolean).join('\n');
    return `<div class="tech-node ${state}" style="left:${x(n)}px;top:${y(n)}px;width:${NODE_W}px;height:${NODE_H}px" title="${esc(title)}" role="img" aria-label="${esc(`${tGame(n.name)}: ${lvl} / ${n.maxLevel}`)}">
        ${n.iconUrl ? `<img class="tech-node-icon" src="${esc(n.iconUrl)}" alt="" loading="lazy" decoding="async">` : ''}
        <span class="tech-node-text">
          <span class="tech-node-name">${esc(tGame(n.name))}</span>
          <span class="tech-node-level">${esc(levelText)}</span>
        </span>
        <span class="tech-node-bar" style="--tech-fill:${n.maxLevel ? Math.round((lvl / n.maxLevel) * 100) : 0}%"></span>
      </div>`;
  }).join('');

  return `${treeSummaryHtml(tree, levels)}
    <div class="tech-tree-scroll${tall ? ' is-tall' : ''}">
      <div class="tech-tree-canvas" style="width:${width}px;height:${height}px">
        <svg class="tech-links" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${links.join('')}</svg>
        ${nodes}
      </div>
    </div>`;
}

function changesHtml(kind, list, changes) {
  const inKind = new Map(list.flatMap((tr) => tr.nodes.map((n) => [n.techId, { node: n, tree: tr }])));
  const rows = changes.filter((c) => inKind.has(c.techId)).slice(0, 60);
  if (!rows.length) return '';
  return `<div class="card">
      <div class="card-header"><h2>${kind === 'research' ? t('Recent research') : t('Recent talents')}</h2>
        <span class="card-header-hint">${tn(rows.length, '{n} change in the last 90 days', '{n} changes in the last 90 days', { n: rows.length })}</span>
      </div>
      <div class="card-body">
        <table class="table-responsive tech-changes-table">
          <colgroup><col class="col-tech"><col class="col-tree"><col class="col-level"><col class="col-date"></colgroup>
          <thead><tr><th>${t('Name')}</th><th>${t('Tree')}</th><th class="num">${t('Level')}</th><th>${t('Date')}</th></tr></thead>
          <tbody>
            ${rows.map((c) => {
              const hit = inKind.get(c.techId);
              return `<tr>
                <td data-label="${t('Name')}" data-role="primary"><span class="mrow-name">${esc(tGame(hit.node.name))}</span></td>
                <td data-label="${t('Tree')}" data-role="hidden">${esc(tGame(hit.tree.name))}</td>
                <td data-label="${t('Level')}" data-role="metric" class="num">${c.level}/${hit.node.maxLevel}</td>
                <td data-label="${t('Date')}">${esc(formatDate(c.changedAt))}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}
