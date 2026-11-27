// Events → Ancients → Hits: who of the clan hit the Tin Man at 4 stacks, and
// who didn't.
//
// The Tin Man starts with 4 stacks of monsters and drops to 3, 2, 1 as its
// health goes. Some clans require hitting it while it has all 4: waiting for
// fewer gives one player more rewards at the clan's cost. Every report shared
// in the clan chat, in a private message to the scanner account or in a chat
// picked under Clans → In-game is opened on the game's journal and kept
// (docs/battle-reports.md); GET /api/tinman/hits?from=&to= serves the window's
// hits. The rule is fixed: hit it while it has all 4 stacks.
//
// First, one row per member: hits at the rule, hits below it, the fewest
// stacks they hit at, their last hit, and a mark — ✓ every hit at the rule,
// ✗ every hit below it, ◐ both — always with the words; the ones below the
// rule sort first. Members who shared no hit are folded under it, like "No
// vault seen"; every single hit is folded under that. 25 a page, sortable.

import { api } from '../lib/api.js';
import { esc, memberLink, formatDate, formatDateShort } from '../lib/ui.js';
import { sortableThHtml } from '../lib/sort-headers.js';
import { emptyHtml, notesHtml, asList } from '../lib/ui-kit.js';
import { t, tn } from '../lib/i18n.js';

const PAGE_SIZE = 25;
/** The rule: hit the Tin Man only while it has all its stacks (battle-report.ts TINMAN_FULL_STACKS). */
const RULE = 4;

// Opens on the members below the rule.
let memberSort = { key: 'status', dir: 'asc' };
let memberPage = 1;
let hitSort = { key: 'when', dir: 'desc' };
let hitPage = 1;
let noHitOpen = false;
let everyHitOpen = false;

/** The window's hits ({ hits, reports }), or null when they could not be read. */
export async function fetchHits(from, to) {
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  try {
    const res = await api(`/tinman/hits?${qs}`);
    return res && Array.isArray(res.hits) ? res : null;
  } catch {
    return null;
  }
}

/** Hits in the answer (for the view's tab label). */
export function hitsCount(data) {
  return data ? data.hits.length : 0;
}

/** A new window (another run): back to the first pages. */
export function resetHitsPage() {
  memberPage = 1;
  hitPage = 1;
}

/** "Today 07:14", "Yesterday 04:12", else "2026/11/17 03:40" — the viewer's clock. */
function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const now = new Date();
  if (day(d) === day(now)) return t('Today {time}', { time });
  if (day(d) === day(new Date(now.getTime() - 86_400_000))) return t('Yesterday {time}', { time });
  return `${formatDateShort(iso)} ${time}`;
}

const stacksWords = (n) => tn(n, '{n} stack', '{n} stacks');
const ruleWords = (rule) => stacksWords(rule);

const MARK = {
  ok: { glyph: '✓', cls: 'is-ok' },
  below: { glyph: '✗', cls: 'is-below' },
  mixed: { glyph: '◐', cls: 'is-mixed' },
};
const markHtml = (kind) => `<span class="hit-mark ${MARK[kind].cls}" aria-hidden="true">${MARK[kind].glyph}</span>`;

/** One row per member with a hit: their hits at the rule and below it, the fewest stacks, the last hit, and a status. */
function membersOf(hits, rule) {
  const byMember = new Map();
  for (const h of hits) {
    if (!h.memberId) continue; // outside the roster: counted in a note
    let m = byMember.get(h.memberId);
    if (!m) {
      m = { memberId: h.memberId, name: h.name || '—', hits: [] };
      byMember.set(h.memberId, m);
    }
    m.hits.push(h);
  }
  return [...byMember.values()].map((m) => {
    const ok = m.hits.filter((h) => h.stacks >= rule).length;
    const below = m.hits.length - ok;
    const status = below === 0 ? 'ok' : ok === 0 ? 'below' : 'mixed';
    return {
      ...m,
      ok,
      below,
      status,
      lowest: Math.min(...m.hits.map((h) => h.stacks)),
      last: m.hits.map((h) => h.at).sort().at(-1),
    };
  });
}

function statusWords(m, rule) {
  const stacks = ruleWords(rule);
  if (m.status === 'ok') return t('Every hit at {stacks}', { stacks });
  if (m.status === 'below') return t('Every hit below {stacks}', { stacks });
  return tn(m.below, '{n} hit below {stacks}', '{n} hits below {stacks}', { stacks });
}

const STATUS_ORDER = { below: 0, mixed: 1, ok: 2 };

function sortedMembers(rows) {
  const dir = memberSort.dir === 'asc' ? 1 : -1;
  const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return [...rows].sort((a, b) => {
    let d = 0;
    if (memberSort.key === 'name') d = byName(a, b) * dir;
    else if (memberSort.key === 'ok') d = (a.ok - b.ok) * dir;
    else if (memberSort.key === 'below') d = (a.below - b.below) * dir;
    else if (memberSort.key === 'lowest') d = (a.lowest - b.lowest) * dir;
    else if (memberSort.key === 'last') d = a.last.localeCompare(b.last) * dir;
    // Below the rule first, then the most hits below it.
    else d = (STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.below - a.below) * dir;
    return d || byName(a, b);
  });
}

function sortedHits(hits) {
  const dir = hitSort.dir === 'asc' ? 1 : -1;
  return [...hits].sort((a, b) => {
    let d = 0;
    if (hitSort.key === 'name') d = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()) * dir;
    else if (hitSort.key === 'stacks') d = (a.stacks - b.stacks) * dir;
    else if (hitSort.key === 'level') d = ((a.level ?? 0) - (b.level ?? 0)) * dir;
    else if (hitSort.key === 'killed') d = (a.killed - b.killed) * dir;
    else d = a.at.localeCompare(b.at) * dir;
    return d || b.at.localeCompare(a.at);
  });
}

function sharedInText(hit) {
  if (hit.sharedIn === 'private') return t('Private message');
  if (hit.sharedIn === 'group') return hit.chatName || t('Group chat');
  return t('Clan chat');
}

const pagerHtml = (attr, page, pages) => `<div class="pagination">
    <button class="btn btn-tight" ${attr}="prev" ${page <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
    <span class="pagination-info">${t('Page {page} of {pages}', { page, pages })}</span>
    <button class="btn btn-tight" ${attr}="next" ${page >= pages ? 'disabled' : ''}>${t('Next →')}</button>
  </div>`;

/**
 * Paint the Hits view into `el`.
 *   data     fetchHits() answer, or null (could not be read)
 *   members  the clan's active members (for "No hit shared")
 *   to       the window's end (ISO) — members who joined after it are left out; '' = now
 */
export function mountHits(el, { data, members, to }) {
  if (!el) return;
  const paint = () => {
    el.innerHTML = hitsHtml(data, asList(members), to);
    wire();
  };
  const wire = () => {
    el.querySelectorAll('[data-hits-table="members"] th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sortKey;
        if (memberSort.key === key) memberSort.dir = memberSort.dir === 'asc' ? 'desc' : 'asc';
        else memberSort = { key, dir: key === 'name' || key === 'status' || key === 'lowest' ? 'asc' : 'desc' };
        memberPage = 1;
        paint();
      });
    });
    el.querySelectorAll('[data-hits-table="hits"] th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sortKey;
        if (hitSort.key === key) hitSort.dir = hitSort.dir === 'asc' ? 'desc' : 'asc';
        else hitSort = { key, dir: key === 'name' || key === 'stacks' ? 'asc' : 'desc' };
        hitPage = 1;
        paint();
      });
    });
    el.querySelectorAll('[data-member-page]').forEach((btn) => btn.addEventListener('click', () => {
      memberPage = Math.max(1, memberPage + (btn.dataset.memberPage === 'next' ? 1 : -1));
      paint();
    }));
    el.querySelectorAll('[data-hit-page]').forEach((btn) => btn.addEventListener('click', () => {
      hitPage = Math.max(1, hitPage + (btn.dataset.hitPage === 'next' ? 1 : -1));
      paint();
    }));
    const noHit = el.querySelector('details[data-section-key="events-nohit"]');
    if (noHit) noHit.addEventListener('toggle', () => { noHitOpen = noHit.open; });
    const every = el.querySelector('details[data-section-key="events-everyhit"]');
    if (every) every.addEventListener('toggle', () => { everyHitOpen = every.open; });
  };
  paint();
}

function hitsHtml(data, members, to) {
  if (!data) return emptyHtml(t('The Tin Man hits could not be loaded.'));
  const rule = RULE;
  const stacks = ruleWords(rule);
  const reports = data.reports || { waiting: 0 };
  const hits = data.hits;

  const notes = [
    esc(t('Read from battle reports shared in the clan chat, sent in a private message to the scanner account, or shared in a chat picked under Clans → In-game. A hit nobody shared is not here.')),
    esc(t('The Tin Man starts with 4 stacks of monsters and drops to 3, 2 and 1 as it loses health. The stacks are the ones it had when the hit began.')),
  ];
  if (reports.waiting > 0) {
    notes.push(esc(tn(reports.waiting, '{n} shared report is still being read.', '{n} shared reports are still being read.')));
  }
  const outside = hits.filter((h) => !h.memberId).length;
  if (outside) notes.push(esc(tn(outside, '{n} hit by a player outside the clan’s roster is only in the list of every hit.', '{n} hits by players outside the clan’s roster are only in the list of every hit.')));

  const rows = membersOf(hits, rule);
  const hitIds = new Set(rows.map((r) => r.memberId));
  const eligible = members.filter((m) => !to || !m.firstSeen || m.firstSeen < to);
  const without = eligible.filter((m) => !hitIds.has(m.id));

  if (!hits.length) return `${emptyHtml(t('No Tin Man hit was shared in this timeframe.'))}${noHitHtml(without)}${notesHtml(notes)}`;

  const atRule = rows.filter((r) => r.ok > 0).length;
  const belowRule = rows.filter((r) => r.below > 0).length;
  const stat = (label, value, sub = '', lead = false, glyph = '') => `<div class="ui-tile ev-stat${lead ? ' is-lead' : ''}">
      <span class="ui-stat-label">${glyph}${esc(label)}</span>
      <span class="ui-big">${value}</span>
      ${sub ? `<span class="ui-sub">${esc(sub)}</span>` : ''}
    </div>`;
  const tiles = `<div class="ev-stats">
      ${stat(t('Hit at {stacks}', { stacks }), atRule.toLocaleString(), tn(rows.length, 'of {n} member who shared a hit', 'of {n} members who shared a hit'), true, `${markHtml('ok')} `)}
      ${stat(t('Hit below {stacks}', { stacks }), belowRule.toLocaleString(), tn(rows.length, 'of {n} member who shared a hit', 'of {n} members who shared a hit'), false, `${markHtml('below')} `)}
      ${stat(t('No hit shared'), without.length.toLocaleString(), tn(eligible.length, 'of {n} member', 'of {n} members'))}
      ${stat(t('Tin Man hits shared'), hits.length.toLocaleString(), tn(new Set(hits.map((h) => h.playerId ?? h.name)).size, 'by {n} player', 'by {n} players'))}
    </div>`;

  return `${tiles}${membersTableHtml(rows, rule)}${noHitHtml(without)}${everyHitHtml(hits, rule)}${notesHtml(notes)}`;
}

function membersTableHtml(rows, rule) {
  const stacks = ruleWords(rule);
  const th = (key, label, cls = '') => sortableThHtml({
    key, labelHtml: esc(label), sortState: memberSort,
    className: [cls, memberSort.key === key ? 'is-sorted' : ''].filter(Boolean).join(' '),
  });
  const all = sortedMembers(rows);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  if (memberPage > pages) memberPage = pages;
  const body = all.slice((memberPage - 1) * PAGE_SIZE, memberPage * PAGE_SIZE).map((m) => {
    const words = statusWords(m, rule);
    // Phone: the mark and its words ride under the name; hits below the rule are the metric.
    return `<tr>
      <td data-label="${esc(t('Player'))}" data-role="primary"><span class="mrow-name">${memberLink(m.memberId, m.name)}</span><span class="mrow-sub">${markHtml(m.status)} ${esc(words)}</span></td>
      <td data-label="${esc(t('At {stacks}', { stacks }))}" class="col-num">${m.ok.toLocaleString()}</td>
      <td data-label="${esc(t('Below {stacks}', { stacks }))}" class="col-num${m.below ? ' hits-below-count' : ''}" data-role="metric">${m.below.toLocaleString()}</td>
      <td data-label="${esc(t('Fewest stacks'))}" class="col-num">${esc(String(m.lowest))}</td>
      <td data-label="${esc(t('Last hit'))}" class="col-date" title="${esc(formatDate(m.last))}">${esc(when(m.last))}</td>
      <td data-label="${esc(t('Status'))}" class="col-mark" data-role="hidden" title="${esc(words)}">${markHtml(m.status)}<span class="visually-hidden">${esc(words)}</span></td>
    </tr>`;
  }).join('');
  return `<section class="ev-section" aria-labelledby="ev-hits-members-title">
      <h2 class="ev-section-title" id="ev-hits-members-title">${esc(t('Members who shared a hit ({count})', { count: rows.length }))}</h2>
      <div class="ui-table-card">
        <table class="table-responsive ui-table events-hits-members" data-hits-table="members">
          <colgroup><col class="col-member"><col class="col-num"><col class="col-num"><col class="col-num"><col class="col-date"><col class="col-mark"></colgroup>
          <thead><tr>
            ${th('name', t('Player'))}
            ${th('ok', t('At {stacks}', { stacks }), 'num')}
            ${th('below', t('Below {stacks}', { stacks }), 'num')}
            ${th('lowest', t('Fewest stacks'), 'num')}
            ${th('last', t('Last hit'), 'col-date')}
            ${th('status', t('Status'), 'col-mark')}
          </tr></thead>
          <tbody>${body || `<tr><td colspan="6">${esc(t('No member of the clan shared a hit in this timeframe.'))}</td></tr>`}</tbody>
        </table>
        ${all.length > PAGE_SIZE ? pagerHtml('data-member-page', memberPage, pages) : ''}
      </div>
    </section>`;
}

function noHitHtml(without) {
  const body = without.length
    ? `<div class="events-np-list">${without.map((m) => `<span class="events-np-item">${memberLink(m.id, m.name)}</span>`).join('')}</div>`
    : `<p class="empty-state">${esc(t('Every member shared a hit.'))}</p>`;
  return `<details class="card card-collapsible" data-section-key="events-nohit"${noHitOpen ? ' open' : ''}>
      <summary class="card-header"><h2>${esc(t('No hit shared ({count})', { count: without.length }))}</h2></summary>
      <div class="card-body">${body}</div>
    </details>`;
}

/** Every single hit, folded: the Tin Man's stacks, its level, units killed, when and where it was shared. */
function everyHitHtml(hits, rule) {
  const th = (key, label, cls = '') => sortableThHtml({
    key, labelHtml: esc(label), sortState: hitSort,
    className: [cls, hitSort.key === key ? 'is-sorted' : ''].filter(Boolean).join(' '),
  });
  const all = sortedHits(hits);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  if (hitPage > pages) hitPage = pages;
  const body = all.slice((hitPage - 1) * PAGE_SIZE, hitPage * PAGE_SIZE).map((h) => {
    const ok = h.stacks >= rule;
    const words = `${stacksWords(h.stacks)} · ${ok ? t('Met the rule') : t('Below the rule ({n} stacks)', { n: rule })}`;
    const cell = `${markHtml(ok ? 'ok' : 'below')} ${esc(stacksWords(h.stacks))}<span class="visually-hidden"> · ${esc(ok ? t('Met the rule') : t('Below the rule ({n} stacks)', { n: rule }))}</span>`;
    const name = h.name ? memberLink(h.memberId, h.name) : `<span class="muted-copy">${esc(t('Unknown player'))}</span>`;
    return `<tr>
      <td data-label="${esc(t('Player'))}" data-role="primary"><span class="mrow-name">${name}</span><span class="mrow-sub">${cell}</span></td>
      <td data-label="${esc(t('Stacks'))}" class="col-stacks" data-role="hidden" title="${esc(words)}">${cell}</td>
      <td data-label="${esc(t('Tin Man level'))}" class="col-num" data-role="metric">${h.level === null ? '—' : esc(h.level.toLocaleString())}</td>
      <td data-label="${esc(t('Units killed'))}" class="col-num">${esc(h.killed.toLocaleString())}</td>
      <td data-label="${esc(t('Fought'))}" class="col-date" title="${esc(formatDate(h.at))}">${esc(when(h.at))}</td>
      <td data-label="${esc(t('Shared in'))}" class="col-shared" title="${esc(t('Shared by {name}', { name: h.sharedBy || '—' }))}">${esc(sharedInText(h))}</td>
    </tr>`;
  }).join('');
  return `<details class="card card-collapsible" data-section-key="events-everyhit"${everyHitOpen ? ' open' : ''}>
      <summary class="card-header"><h2>${esc(t('Every hit ({count})', { count: hits.length }))}</h2></summary>
      <div class="card-body">
        <table class="table-responsive ui-table events-hits-table" data-hits-table="hits">
          <colgroup><col class="col-member"><col class="col-stacks"><col class="col-num"><col class="col-num"><col class="col-date"><col class="col-shared"></colgroup>
          <thead><tr>
            ${th('name', t('Player'))}
            ${th('stacks', t('Stacks'), 'col-stacks')}
            ${th('level', t('Tin Man level'), 'num')}
            ${th('killed', t('Units killed'), 'num')}
            ${th('when', t('Fought'), 'col-date')}
            <th scope="col" class="col-shared">${esc(t('Shared in'))}</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
        ${all.length > PAGE_SIZE ? pagerHtml('data-hit-page', hitPage, pages) : ''}
      </div>
    </details>`;
}
