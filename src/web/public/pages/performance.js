// Performance (admins only): over- and underachievers.
//
// Every active member scored against what the clan expects of them — the
// Leaderboard's weekly points goal, the Tin Man target for their guards level,
// and taking part in events — over a timeframe. The server does all of the
// scoring (src/data/performance.ts; the tunables are in
// src/config/performance-scoring.ts) and sends back the weights and thresholds
// it used, so nothing here holds a second copy of them.

import { api } from '../lib/api.js';
import { esc, memberLink } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { getCurrentUser } from '../lib/state.js';
import { sortableThHtml } from '../lib/sort-headers.js';
import { guardsCellHtml, nameWithGoldPassHtml } from '../lib/guards-format.js';
import { DEFAULT_GOAL_AMBER_PCT } from '../lib/weekly-goal.js';

const PAGE_SIZE = 25;
/** Members named in each of the two spotlight cards; the table has the rest. */
const SPOTLIGHT_SIZE = 10;

// Keyed by the server's timeframe keys. A key added there without a label
// here still works; its button just reads the raw key until one is added.
const TIMEFRAME_LABELS = {
  month: t('1 month'),
  quarter: t('3 months'),
  half: t('6 months'),
  year: t('12 months'),
  all: t('All time'),
};

const SIGNAL_LABELS = {
  goalHits: t('Weekly goal reached'),
  goalPoints: t('Weekly points vs goal'),
  tinman: t('{tinman} vs target', { tinman: tGame('Tin Man') }),
  events: t('Event participation'),
};

// Colour never carries the status alone: every status has a glyph and a word.
const STATUS = {
  over: { glyph: '▲', label: t('Overachiever'), cls: 'is-over' },
  'on-track': { glyph: '●', label: t('On track'), cls: 'is-on-track' },
  under: { glyph: '▼', label: t('Underachiever'), cls: 'is-under' },
  unscored: { glyph: '–', label: t('Not enough data'), cls: 'is-unscored' },
};

// Sort keys whose natural first click is ascending; everything else starts high.
const ASC_FIRST = new Set(['rank', 'name', 'since']);

let hostEl = null;
let timeframe = null; // null until the server names its default
let report = null;
let guardsByMember = new Map();
let sort = { key: 'rank', dir: 'asc' };
let page = 1;
let statusFilter = 'all';
let guardsFilter = 'all';

const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

export async function renderPerformance(el) {
  hostEl = el;
  const role = getCurrentUser()?.role;
  if (role !== 'admin' && role !== 'superadmin') {
    el.innerHTML = `<div class="card"><div class="card-body"><div class="empty-state"><p>${t('Only clan admins can see this page.')}</p></div></div></div>`;
    return;
  }
  el.innerHTML = `<div class="card"><div class="card-body"><div class="empty-state"><p>${t('Scoring members…')}</p></div></div></div>`;
  wire(el);
  await load();
}

async function load() {
  const query = timeframe ? `?timeframe=${encodeURIComponent(timeframe)}` : '';
  const [data, guards] = await Promise.all([
    api(`/performance${query}`),
    // Only for the Guards cell's confidence and Gold Pass marker; the report
    // carries the level itself, so a failure here costs nothing else.
    api('/guards/overview').catch(() => null),
  ]);
  if (!data || data.error) {
    hostEl.innerHTML = `<div class="card"><div class="card-body"><div class="empty-state"><p>${esc(data?.error || t('Could not load the performance report.'))}</p></div></div></div>`;
    return;
  }
  report = data;
  timeframe = data.timeframe;
  guardsByMember = new Map((Array.isArray(guards?.rows) ? guards.rows : []).map((g) => [g.memberId, g]));
  paint();
}

function paint() {
  const r = report;
  if (!r.dataStart) {
    hostEl.innerHTML = `${headerCardHtml(r)}<div class="card"><div class="card-body"><div class="empty-state"><p>${t('No chest data for this clan yet.')}</p></div></div></div>`;
    return;
  }
  hostEl.innerHTML = `
    ${headerCardHtml(r)}
    ${r.members.length
      ? `<div class="perf-spotlight">${spotlightHtml('over', r)}${spotlightHtml('under', r)}</div>
         ${guardsCardHtml(r)}
         <div id="perfTableHost">${tableCardHtml(r)}</div>`
      : `<div class="card"><div class="card-body"><div class="empty-state"><p>${t('Nobody has been in the clan long enough for this timeframe yet.')}</p></div></div></div>`}
    ${howCardHtml(r)}
    ${tooNewCardHtml(r)}
  `;
}

// ─── Header ───────────────────────────────────────────────────

function headerCardHtml(r) {
  const counts = { over: 0, 'on-track': 0, under: 0, unscored: 0 };
  for (const m of r.members) counts[m.status] = (counts[m.status] ?? 0) + 1;
  const scored = r.members.length - counts.unscored;

  const span = r.windowFrom ? `${r.windowFrom} → ${r.windowTo}` : '';
  const units = [
    r.weeklyGoal ? tn(r.units.weeks, '{n} closed week', '{n} closed weeks', { n: r.units.weeks }) : '',
    tn(r.units.tinmanRuns, '{n} {tinman} run', '{n} {tinman} runs', { n: r.units.tinmanRuns, tinman: esc(tGame('Tin Man')) }),
    tn(r.units.eventRuns, '{n} event run', '{n} event runs', { n: r.units.eventRuns }),
  ].filter(Boolean).join(' · ');
  const hint = [esc(span), r.windowFrom ? units : ''].filter(Boolean).join(' · ');

  const buttons = r.timeframes.map((tf) => {
    const active = tf.key === r.timeframe;
    return `<button class="btn ${active ? 'active' : ''}" aria-pressed="${active}" data-perf-timeframe="${esc(tf.key)}">${esc(TIMEFRAME_LABELS[tf.key] ?? tf.key)}</button>`;
  }).join('');

  const noGoal = r.weeklyGoal
    ? ''
    : `<p class="perf-note">${t('No weekly points goal is set, so the score leaves the weekly goal out. Set one on the Clans page (Leaderboard goal).')}</p>`;

  return `<div class="card">
    <div class="card-header leaderboard-header">
      <div class="events-title">
        <h2>${t('Over- and underachievers')}</h2>
        <span class="card-header-hint">${hint}</span>
      </div>
      <div class="period-selector" role="group" aria-label="${t('Timeframe')}">${buttons}</div>
    </div>
    <div class="card-body card-body-padded">
      ${noGoal}
      <div class="stats-grid">
        <div class="stat-card">
          <div class="label">${t('Members scored')}</div>
          <div class="value">${scored.toLocaleString()}</div>
          <div class="sub">${tn(r.requiredDays, 'at least {n} day in the clan', 'at least {n} days in the clan', { n: r.requiredDays })}</div>
        </div>
        <div class="stat-card">
          <div class="label">${t('Overachievers')}</div>
          <div class="value perf-value-over">${counts.over.toLocaleString()}</div>
          <div class="sub">${t('score {pct} or more', { pct: pct(r.scoring.overThreshold) })}</div>
        </div>
        <div class="stat-card">
          <div class="label">${t('Underachievers')}</div>
          <div class="value perf-value-under">${counts.under.toLocaleString()}</div>
          <div class="sub">${t('score below {pct}', { pct: pct(r.scoring.underThreshold) })}</div>
        </div>
        <div class="stat-card">
          <div class="label">${t('Too new to judge')}</div>
          <div class="value">${r.tooNew.length.toLocaleString()}</div>
          <div class="sub">${t('joined too recently for this timeframe')}</div>
        </div>
      </div>
    </div>
  </div>`;
}

// ─── Spotlight cards ──────────────────────────────────────────

function nameHtml(m) {
  return nameWithGoldPassHtml(memberLink(m.memberId, m.name), guardsByMember.get(m.memberId)?.goldPass);
}

function statusHtml(m) {
  const s = STATUS[m.status] ?? STATUS.unscored;
  return `<span class="perf-status ${s.cls}" title="${esc(s.label)}"><span aria-hidden="true">${s.glyph}</span><span class="visually-hidden">${esc(s.label)}:</span> ${pct(m.score)}</span>`;
}

/**
 * "Goal 142% (3/4 weeks) · Tin Man 180% · Events 9/13 runs" — only the signals
 * they have. The goal leads with its share like Tin Man does: by how much a
 * member beats it counts toward the score, not only how often.
 */
function signalSummaryHtml(m) {
  const g = m.signals.goalHits;
  const gp = m.signals.goalPoints;
  const tm = m.signals.tinman;
  const ev = m.signals.events;
  return [
    g.units ? tn(g.units, 'Goal {pct} ({hits}/{n} week)', 'Goal {pct} ({hits}/{n} weeks)', { pct: pct(gp.share), hits: g.hits, n: g.units }) : '',
    tm.units ? t('{tinman} {pct}', { tinman: esc(tGame('Tin Man')), pct: pct(tm.share) }) : '',
    ev.units ? tn(ev.units, 'Events {hits}/{n} run', 'Events {hits}/{n} runs', { hits: ev.hits, n: ev.units }) : '',
  ].filter(Boolean).join(' · ');
}

function spotlightHtml(kind, r) {
  const rows = r.members
    .filter((m) => m.status === kind)
    .sort((a, b) => (kind === 'over' ? b.score - a.score : a.score - b.score));
  const shown = rows.slice(0, SPOTLIGHT_SIZE);
  const title = kind === 'over' ? t('Overachievers') : t('Underachievers');
  const empty = kind === 'over'
    ? t('Nobody scores {pct} or more in this timeframe.', { pct: pct(r.scoring.overThreshold) })
    : t('Nobody scores below {pct} in this timeframe.', { pct: pct(r.scoring.underThreshold) });
  const more = rows.length - shown.length;
  return `<div class="card perf-spotlight-card perf-spotlight-${kind}">
    <div class="card-header"><h2>${title}</h2><span class="card-header-hint">${rows.length.toLocaleString()}</span></div>
    <div class="card-body card-body-padded">
      ${shown.length
        ? `<ol class="perf-list">${shown.map((m) => `<li class="perf-list-item">
            <div class="perf-list-main"><span class="perf-list-name">${nameHtml(m)}</span>${statusHtml(m)}</div>
            <div class="perf-list-sub">${signalSummaryHtml(m)}</div>
          </li>`).join('')}</ol>
          ${more > 0 ? `<p class="perf-more">${tn(more, '+{n} more in the table below', '+{n} more in the table below', { n: more })}</p>` : ''}`
        : `<p class="perf-note">${empty}</p>`}
    </div>
  </div>`;
}

// ─── By guards level ──────────────────────────────────────────

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function guardsCardHtml(r) {
  const groups = new Map();
  for (const m of r.members) {
    const key = m.guardsLevel ?? 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  // Highest level first, unknown last.
  const keys = [...groups.keys()].sort((a, b) => (a === 0) - (b === 0) || b - a);
  const rows = keys.map((key) => {
    const list = groups.get(key);
    const scores = list.map((m) => m.score).filter((s) => s !== null);
    const over = list.filter((m) => m.status === 'over').length;
    const under = list.filter((m) => m.status === 'under').length;
    return `<tr>
      <td data-label="${t('Guards')}" data-role="primary">${key ? esc(t('G{level}', { level: key })) : `<span class="perf-dim">${t('Unknown')}</span>`}</td>
      <td data-label="${t('Members')}" class="num">${list.length.toLocaleString()}</td>
      <td data-label="${t('Median score')}" class="num" data-role="metric">${pct(median(scores))}</td>
      <td data-label="${t('Overachievers')}" class="num">${over.toLocaleString()}</td>
      <td data-label="${t('Underachievers')}" class="num">${under.toLocaleString()}</td>
    </tr>`;
  }).join('');
  return `<div class="card">
    <div class="card-header">
      <h2>${t('By guards level')}</h2>
      <span class="card-header-hint">${t('{tinman} targets follow the guards level; unknown counts as G{level}', { tinman: esc(tGame('Tin Man')), level: r.scoring.assumedGuardsLevel })}</span>
    </div>
    <div class="card-body">
      <table class="table-responsive perf-guards-table"><colgroup>
        <col class="col-guards"><col><col><col><col>
      </colgroup><thead><tr>
        <th>${t('Guards')}</th>
        <th class="num">${t('Members')}</th>
        <th class="num">${t('Median score')}</th>
        <th class="num">${t('Overachievers')}</th>
        <th class="num">${t('Underachievers')}</th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>
  </div>`;
}

// ─── Everyone ─────────────────────────────────────────────────

function sortValue(m, key, rankOf) {
  switch (key) {
    case 'rank': return rankOf.get(m.memberId) ?? null;
    case 'name': return m.name.toLowerCase();
    case 'score': return m.score;
    // Hits first, then the real share: hit shares differ by at least ~1/200,
    // which ×1e6 dwarfs any share a week can reach.
    case 'goal': return m.signals.goalHits.units ? m.signals.goalHits.value * 1e6 + (m.signals.goalPoints.share ?? 0) : null;
    case 'tinman': return m.signals.tinman.units ? m.signals.tinman.share : null;
    case 'events': return m.signals.events.units ? m.signals.events.share : null;
    case 'guards': return m.guardsLevel;
    case 'since': return m.tenureStart;
    default: return null;
  }
}

function thinNote(s) {
  return s.counted ? '' : ` · ${t('too little data to count yet')}`;
}

function goalCellHtml(m, r) {
  const h = m.signals.goalHits;
  const p = m.signals.goalPoints;
  if (!r.weeklyGoal) return `<span class="perf-dim" title="${esc(t('No weekly points goal is set'))}">—</span>`;
  if (!h.units) return `<span class="perf-dim" title="${esc(t('No whole week in the clan in this timeframe'))}">—</span>`;
  let title = tn(h.units, 'Reached the weekly goal in {hits} of {n} week; {pct} of the goal on average', 'Reached the weekly goal in {hits} of {n} weeks; {pct} of the goal on average', { hits: h.hits, n: h.units, pct: pct(p.share) });
  if (h.near) {
    title += ` · ${tn(h.near, '{n} more week came close to it and counts as part of a hit', '{n} more weeks came close to it and count as part of a hit', { n: h.near })}`;
  }
  title += thinNote(h);
  // Near misses ride beside the hits with the Leaderboard's "close to goal"
  // glyph, so "0/4" never hides four weeks at 95%.
  const near = h.near
    ? ` <span class="perf-cell-near"><span aria-hidden="true">◐</span><span class="visually-hidden">${t('close to goal')}:</span> ${h.near}</span>`
    : '';
  return `<span class="perf-cell${h.counted ? '' : ' is-thin'}" title="${esc(title)}">${h.hits}/${h.units}${near} <span class="perf-cell-sub">${pct(p.share)}</span></span>`;
}

function tinmanCellHtml(m) {
  const s = m.signals.tinman;
  if (!s.units) return `<span class="perf-dim" title="${esc(t('No finished {tinman} run in this timeframe', { tinman: tGame('Tin Man') }))}">—</span>`;
  let title = tn(s.units, '{pct} of their target on average, over {n} run', '{pct} of their target on average, over {n} runs', { pct: pct(s.share), n: s.units });
  if (m.tinmanMedianRuns) {
    title += ` · ${tn(m.tinmanMedianRuns, '{n} run had no targets pasted, so it is measured against the median player', '{n} runs had no targets pasted, so they are measured against the median player', { n: m.tinmanMedianRuns })}`;
  }
  title += thinNote(s);
  return `<span class="perf-cell${s.counted ? '' : ' is-thin'}" title="${esc(title)}">${pct(s.share)} <span class="perf-cell-sub">${tn(s.units, '{n} run', '{n} runs', { n: s.units })}</span></span>`;
}

function eventsCellHtml(m) {
  const s = m.signals.events;
  if (!s.units) return `<span class="perf-dim" title="${esc(t('No finished event run in this timeframe'))}">—</span>`;
  const title = tn(s.units, 'Took part in {hits} of {n} event run; {pct} of the median participant on average', 'Took part in {hits} of {n} event runs; {pct} of the median participant on average', { hits: s.hits, n: s.units, pct: pct(s.share) }) + thinNote(s);
  return `<span class="perf-cell${s.counted ? '' : ' is-thin'}" title="${esc(title)}">${s.hits}/${s.units} <span class="perf-cell-sub">${pct(s.share)}</span></span>`;
}

function guardsHtml(m) {
  const g = guardsByMember.get(m.memberId)?.guards;
  if (g) return guardsCellHtml(g);
  return m.guardsLevel ? esc(t('G{level}', { level: m.guardsLevel })) : guardsCellHtml(null);
}

function filteredMembers(r) {
  return r.members.filter((m) => {
    if (statusFilter !== 'all' && m.status !== statusFilter) return false;
    if (guardsFilter === 'unknown') return m.guardsLevel === null;
    if (guardsFilter !== 'all') return m.guardsLevel === Number(guardsFilter);
    return true;
  });
}

function tableCardHtml(r) {
  // Rank is the score order over everyone scored, whatever the sort or filter.
  const rankOf = new Map(r.members.filter((m) => m.score !== null).map((m, i) => [m.memberId, i + 1]));
  const rows = filteredMembers(r);
  const mul = sort.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const va = sortValue(a, sort.key, rankOf);
    const vb = sortValue(b, sort.key, rankOf);
    if (va === null && vb === null) return a.name.localeCompare(b.name);
    if (va === null) return 1;
    if (vb === null) return -1;
    return (va < vb ? -mul : va > vb ? mul : 0) || a.name.localeCompare(b.name);
  });
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > pages) page = pages;
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const th = (key, label, className = '', title = '') =>
    sortableThHtml({ key, labelHtml: label, sortState: sort, className, title });

  const levels = [...new Set(r.members.map((m) => m.guardsLevel).filter((l) => l !== null))].sort((a, b) => b - a);
  const statusOptions = [
    ['all', t('Everyone')],
    ['over', t('Overachievers')],
    ['on-track', t('On track')],
    ['under', t('Underachievers')],
    ['unscored', t('Not enough data')],
  ].map(([v, label]) => `<option value="${v}"${statusFilter === v ? ' selected' : ''}>${label}</option>`).join('');
  const guardsOptions = [
    `<option value="all"${guardsFilter === 'all' ? ' selected' : ''}>${t('All levels')}</option>`,
    ...levels.map((l) => `<option value="${l}"${guardsFilter === String(l) ? ' selected' : ''}>${esc(t('G{level}', { level: l }))}</option>`),
    r.members.some((m) => m.guardsLevel === null) ? `<option value="unknown"${guardsFilter === 'unknown' ? ' selected' : ''}>${t('Unknown')}</option>` : '',
  ].join('');

  const body = slice.length
    ? slice.map((m) => {
      const s = STATUS[m.status] ?? STATUS.unscored;
      return `<tr class="perf-row ${s.cls}">
        <td data-label="${t('Rank')}" data-role="lead">${rankOf.get(m.memberId) ?? '—'}</td>
        <td data-label="${t('Member')}" data-role="primary"><span class="mrow-name">${nameHtml(m)}</span></td>
        <td data-label="${t('Score')}" data-role="metric" class="num">${statusHtml(m)}</td>
        <td data-label="${esc(SIGNAL_LABELS.goalHits)}" class="num">${goalCellHtml(m, r)}</td>
        <td data-label="${esc(SIGNAL_LABELS.tinman)}" class="num">${tinmanCellHtml(m)}</td>
        <td data-label="${esc(SIGNAL_LABELS.events)}" class="num">${eventsCellHtml(m)}</td>
        <td data-label="${t('Guards')}" class="num">${guardsHtml(m)}</td>
        <td data-label="${t('Joined')}" title="${esc(tn(m.presentDays, '{n} day in the clan in this timeframe', '{n} days in the clan in this timeframe', { n: m.presentDays }))}">${esc(m.tenureStart)}</td>
      </tr>`;
    }).join('')
    : `<tr><td colspan="8"><div class="empty-state"><p>${t('No member matches these filters.')}</p></div></td></tr>`;

  const pager = rows.length > PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-perf-page="prev" ${page <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
        <span class="pagination-info">${tn(rows.length, 'Page {page} of {pages} · {n} members', 'Page {page} of {pages} · {n} members', { page, pages, n: rows.length })}</span>
        <button class="btn btn-tight" data-perf-page="next" ${page >= pages ? 'disabled' : ''}>${t('Next →')}</button>
      </div>`
    : '';

  return `<div class="card">
    <div class="card-header perf-table-header">
      <h2>${t('Everyone')}</h2>
      <div class="perf-toolbar">
        <label>${t('Show')} <select class="input" data-perf-filter="status">${statusOptions}</select></label>
        <label>${t('Guards')} <select class="input" data-perf-filter="guards">${guardsOptions}</select></label>
      </div>
    </div>
    <div class="card-body">
      <table class="table-responsive perf-table"><colgroup>
        <col class="col-rank"><col class="col-member"><col class="col-score">
        <col class="col-goal"><col class="col-signal"><col class="col-signal">
        <col class="col-guards"><col class="col-date">
      </colgroup><thead><tr>
        ${th('rank', t('Rank'))}${th('name', t('Member'))}${th('score', t('Score'), 'num')}
        ${th('goal', t('Goal'), 'num', SIGNAL_LABELS.goalHits)}
        ${th('tinman', esc(tGame('Tin Man')), 'num', SIGNAL_LABELS.tinman)}
        ${th('events', t('Events'), 'num', SIGNAL_LABELS.events)}
        ${th('guards', t('Guards'), 'num')}
        ${th('since', t('Joined'))}
      </tr></thead><tbody>${body}</tbody></table>
      ${pager}
    </div>
  </div>`;
}

// ─── How it works / too new ───────────────────────────────────

/**
 * When the goal changed inside the timeframe, say which weeks were judged by
 * which number: "35,000 now" alone would make a member who cleared 30,000 in an
 * earlier week look like they missed it.
 */
function goalStepsHtml(r) {
  const steps = (r.goalSteps || []).filter((s) => Number.isFinite(s.weeklyPoints));
  if (steps.length < 2) return '';
  // Name the amber band only when it moved too; otherwise it is noise.
  const amberMoved = steps.some((s) => s.amberPct !== steps[0].amberPct);
  const list = steps
    .map((s) => (amberMoved
      ? t('{points} (amber from {pct}%) from the week of {date}', { points: s.weeklyPoints.toLocaleString(), pct: s.amberPct, date: esc(s.from) })
      : t('{points} from the week of {date}', { points: s.weeklyPoints.toLocaleString(), date: esc(s.from) })))
    .join(', ');
  return ` ${t('The goal changed in this timeframe: {steps}.', { steps: list })}`;
}

function howCardHtml(r) {
  const s = r.scoring;
  const total = Object.values(s.weights).reduce((a, b) => a + b, 0) || 1;
  const weight = (key) => t('weight {pct}', { pct: pct(s.weights[key] / total) });
  const events = r.events.map((e) => esc(tGame(e.name))).join(', ');
  const goal = r.weeklyGoal ? r.weeklyGoal.toLocaleString() : '—';
  const item = (key, text) => `<li><strong>${esc(SIGNAL_LABELS[key])}</strong> <span class="perf-dim">(${weight(key)})</span> — ${text}</li>`;
  return `<details class="card card-collapsible" data-section-key="performance-how">
    <summary class="card-header"><h2>${t('How the score works')}</h2></summary>
    <div class="card-body card-body-padded perf-how">
      <ul>
        ${item('goalHits', t('the share of closed weeks at or above the weekly points goal that applied that week (the Leaderboard goal, now {goal} points).', { goal })
          + goalStepsHtml(r)
          + (s.goalNearMiss ? ` ${t('A week that misses it but reaches {near} of it (◐, close to goal) counts as {credit} of a hit.', { near: pct((r.goalAmberPct ?? DEFAULT_GOAL_AMBER_PCT) / 100), credit: pct(s.goalNearMiss.credit) })}` : ''))}
        ${item('goalPoints', t('points each week as a share of that goal, so going over it counts: a week at 150% of the goal lifts the score as much as a {tinman} run at 150% of its target.', { tinman: esc(tGame('Tin Man')) }))}
        ${item('tinman', [
          t('points in each finished {tinman} run against the target for their guards level, from the targets pasted on Events → Ancients.', { tinman: esc(tGame('Tin Man')) }),
          s.tinmanMedianFallback
            ? t('A run with no targets is measured against the median player.')
            : t('A run with no targets pasted doesn’t count.'),
          tn(s.minUnits.tinman, 'It counts toward the score once there is {n} run with targets in this timeframe.', 'It counts toward the score once there are {n} runs with targets in this timeframe.', { n: s.minUnits.tinman }),
        ].join(' '))}
        ${item('events', t('points in each finished run of {events} against the median participant. A run sat out counts as 0.', { events }))}
      </ul>
      <p>${s.overCurve
        ? t('A week or run only counts if the member was in the clan for all of it. Up to {from} of the goal or target, a share counts as it is; above that, every doubling adds {step}: {twice} scores {twiceScore}, and {capAt} or more scores {cap}, the most one week or run can count, so a single huge week can’t hide empty ones. The columns show the real shares.', {
          from: pct(s.overCurve.from),
          step: pct(s.overCurve.perDoubling),
          twice: pct(2 * s.overCurve.from),
          twiceScore: pct(Math.min(s.overCurve.from + s.overCurve.perDoubling, s.ratioCap)),
          capAt: pct(s.overCurve.from * 2 ** ((s.ratioCap - s.overCurve.from) / s.overCurve.perDoubling)),
          cap: pct(s.ratioCap),
        })
        : t('A week or run only counts if the member was in the clan for all of it, and one counts for at most {cap}, so a single huge week can’t hide empty ones.', { cap: pct(s.ratioCap) })}</p>
      <p>${t('The score is the weighted average of the parts a member has enough data for. 100% means meeting every expectation; {over} or more is an overachiever, below {under} an underachiever.', { over: pct(s.overThreshold), under: pct(s.underThreshold) })}</p>
      <p>${tn(r.requiredDays, 'To be shown, a member needs {n} day in the clan within this timeframe. Time in the clan counts from their first chest, might reading or sighting, whichever is earliest, so a renamed player keeps their old name’s history.', 'To be shown, a member needs {n} days in the clan within this timeframe. Time in the clan counts from their first chest, might reading or sighting, whichever is earliest, so a renamed player keeps their old name’s history.', { n: r.requiredDays })}</p>
    </div>
  </details>`;
}

function tooNewCardHtml(r) {
  if (!r.tooNew.length) return '';
  const rows = r.tooNew.map((m) => `<tr>
    <td data-role="primary"><span class="mrow-name">${memberLink(m.memberId, m.name)}</span></td>
    <td data-label="${t('Joined')}" data-role="metric">${esc(m.tenureStart)}</td>
    <td data-label="${t('Days in timeframe')}" class="num">${m.presentDays.toLocaleString()}</td>
  </tr>`).join('');
  return `<details class="card card-collapsible" data-section-key="performance-too-new">
    <summary class="card-header"><h2>${t('Too new to judge ({count})', { count: r.tooNew.length })}</h2></summary>
    <div class="card-body">
      <table class="table-responsive perf-new-table"><colgroup>
        <col class="col-member"><col class="col-date"><col class="col-days">
      </colgroup><thead><tr>
        <th>${t('Member')}</th><th>${t('Joined')}</th><th class="num">${t('Days in timeframe')}</th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>
  </details>`;
}

// ─── Wiring ───────────────────────────────────────────────────

function repaintTable() {
  const host = hostEl?.querySelector('#perfTableHost');
  if (host && report) host.innerHTML = tableCardHtml(report);
}

function wire(el) {
  // The host survives every innerHTML swap, so bind exactly once.
  if (el.dataset.perfWired === '1') return;
  el.dataset.perfWired = '1';

  el.addEventListener('click', (ev) => {
    const tf = ev.target.closest('button[data-perf-timeframe]')?.dataset.perfTimeframe;
    if (tf) {
      if (tf === timeframe) return;
      timeframe = tf;
      page = 1;
      el.querySelectorAll('button[data-perf-timeframe]').forEach((b) => {
        const on = b.dataset.perfTimeframe === tf;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      el.setAttribute('aria-busy', 'true');
      load().finally(() => el.removeAttribute('aria-busy'));
      return;
    }

    const sortKey = ev.target.closest('.perf-table th[data-sort-key]')?.dataset.sortKey;
    if (sortKey) {
      sort = sort.key === sortKey
        ? { key: sortKey, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key: sortKey, dir: ASC_FIRST.has(sortKey) ? 'asc' : 'desc' };
      page = 1;
      repaintTable();
      return;
    }

    const step = ev.target.closest('button[data-perf-page]')?.dataset.perfPage;
    if (step) {
      page += step === 'next' ? 1 : -1;
      if (page < 1) page = 1;
      repaintTable();
    }
  });

  el.addEventListener('change', (ev) => {
    const which = ev.target.closest('select[data-perf-filter]')?.dataset.perfFilter;
    if (!which) return;
    if (which === 'status') statusFilter = ev.target.value;
    else guardsFilter = ev.target.value;
    page = 1;
    repaintTable();
  });
}
