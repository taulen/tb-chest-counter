// Events → Ancients → Hits: Tin Man hits members shared as battle reports.
//
// The Tin Man starts with 4 stacks of monsters and drops to 3, 2, 1 as its
// health goes. Some clans require hitting it while it has all 4: waiting for
// fewer gives one player more rewards at the clan's cost. Every report shared
// in the clan chat, in a private message to the scanner account or in a chat
// picked under Clans → In-game is opened on the game's journal and kept
// (docs/battle-reports.md); GET /api/tinman/hits?from=&to= serves the window's
// hits with the clan's rule.
//
// One row per hit, newest first, sortable, 25 a page. With a rule, each row
// says whether it met it: ✓ (green) or ✗ (red), always with the words.

import { api } from '../lib/api.js';
import { esc, memberLink, formatDate, formatDateShort } from '../lib/ui.js';
import { sortableThHtml } from '../lib/sort-headers.js';
import { emptyHtml, notesHtml } from '../lib/ui-kit.js';
import { t, tn } from '../lib/i18n.js';

const PAGE_SIZE = 25;

let sort = { key: 'when', dir: 'desc' };
let page = 1;

/** The window's hits ({ hits, requiredStacks, reports }), or null when they could not be read. */
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

/** A new window (another run): back to the first page. */
export function resetHitsPage() {
  page = 1;
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

/** The stacks cell: the count, and with a rule a ✓/✗ mark whose words are in the hover and for screen readers. */
function stacksCell(hit, rule) {
  const words = stacksWords(hit.stacks);
  if (!rule) return { html: esc(words), title: words };
  const ok = hit.stacks >= rule;
  const verdict = ok ? t('Met the rule') : t('Below the rule ({n} stacks)', { n: rule });
  const glyph = `<span class="hit-mark ${ok ? 'is-ok' : 'is-below'}" aria-hidden="true">${ok ? '✓' : '✗'}</span>`;
  return { html: `${glyph} ${esc(words)}<span class="visually-hidden"> · ${esc(verdict)}</span>`, title: `${words} · ${verdict}` };
}

function sharedInText(hit) {
  if (hit.sharedIn === 'private') return t('Private message');
  if (hit.sharedIn === 'group') return hit.chatName || t('Group chat');
  return t('Clan chat');
}

function sorted(hits) {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const byWhen = (a, b) => b.at.localeCompare(a.at);
  return [...hits].sort((a, b) => {
    let d = 0;
    if (sort.key === 'name') d = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()) * dir;
    else if (sort.key === 'stacks') d = (a.stacks - b.stacks) * dir;
    else if (sort.key === 'level') d = ((a.level ?? 0) - (b.level ?? 0)) * dir;
    else if (sort.key === 'killed') d = (a.killed - b.killed) * dir;
    else d = a.at.localeCompare(b.at) * dir;
    return d || byWhen(a, b);
  });
}

/**
 * Paint the Hits view into `el`.
 *   data   fetchHits() answer, or null (could not be read)
 */
export function mountHits(el, { data }) {
  if (!el) return;
  const paint = () => {
    el.innerHTML = hitsHtml(data);
    wire();
  };
  const wire = () => {
    el.querySelectorAll('th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sortKey;
        if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
        else sort = { key, dir: key === 'name' || key === 'stacks' ? 'asc' : 'desc' };
        page = 1;
        paint();
      });
    });
    el.querySelectorAll('[data-hits-page]').forEach((btn) => {
      btn.addEventListener('click', () => {
        page = Math.max(1, page + (btn.dataset.hitsPage === 'next' ? 1 : -1));
        paint();
      });
    });
  };
  paint();
}

function hitsHtml(data) {
  if (!data) return emptyHtml(t('The Tin Man hits could not be loaded.'));
  const rule = data.requiredStacks || null;
  const reports = data.reports || { waiting: 0 };

  const notes = [
    esc(t('Read from battle reports shared in the clan chat, sent in a private message to the scanner account, or shared in a chat picked under Clans → In-game. A hit nobody shared is not here.')),
    esc(t('The Tin Man starts with 4 stacks of monsters and drops to 3, 2 and 1 as it loses health. The stacks are the ones it had when the hit began.')),
  ];
  if (reports.waiting > 0) {
    notes.push(esc(tn(reports.waiting, '{n} shared report is still being read.', '{n} shared reports are still being read.')));
  }
  if (!rule) notes.push(esc(t('No Tin Man rule is set for the clan. An admin can set one under Clans → In-game → Battle reports.')));

  const hits = data.hits;
  if (!hits.length) return `${emptyHtml(t('No Tin Man hit was shared in this timeframe.'))}${notesHtml(notes)}`;

  const players = new Set(hits.map((h) => h.playerId ?? h.name));
  const stat = (label, value, sub = '', lead = false, glyph = '') => `<div class="ui-tile ev-stat${lead ? ' is-lead' : ''}">
      <span class="ui-stat-label">${glyph}${esc(label)}</span>
      <span class="ui-big">${value}</span>
      ${sub ? `<span class="ui-sub">${esc(sub)}</span>` : ''}
    </div>`;
  const ok = rule ? hits.filter((h) => h.stacks >= rule) : hits.filter((h) => h.stacks >= 4);
  const below = rule ? hits.filter((h) => h.stacks < rule) : hits.filter((h) => h.stacks < 4);
  const belowPlayers = new Set(below.map((h) => h.playerId ?? h.name));
  const tiles = `<div class="ev-stats">
      ${stat(t('Tin Man hits shared'), hits.length.toLocaleString(), tn(players.size, 'by {n} player', 'by {n} players'), true)}
      ${rule
        ? stat(t('Met the rule'), ok.length.toLocaleString(), tn(rule, 'at {n} stack or more', 'at {n} stacks or more'), false,
          '<span class="hit-mark is-ok" aria-hidden="true">✓</span>')
        : stat(t('At all 4 stacks'), ok.length.toLocaleString(), tn(hits.length, 'of {n} hit', 'of {n} hits'))}
      ${rule
        ? stat(t('Below the rule'), below.length.toLocaleString(), tn(belowPlayers.size, 'by {n} player', 'by {n} players'), false,
          '<span class="hit-mark is-below" aria-hidden="true">✗</span>')
        : stat(t('At fewer stacks'), below.length.toLocaleString(), tn(belowPlayers.size, 'by {n} player', 'by {n} players'))}
    </div>`;

  const th = (key, label, cls = '') => sortableThHtml({
    key, labelHtml: esc(label), sortState: sort,
    className: [cls, sort.key === key ? 'is-sorted' : ''].filter(Boolean).join(' '),
  });
  const all = sorted(hits);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  if (page > pages) page = pages;
  const pageRows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const body = pageRows.map((h) => {
    const cell = stacksCell(h, rule);
    const name = h.name ? memberLink(h.memberId, h.name) : `<span class="muted-copy">${esc(t('Unknown player'))}</span>`;
    // Phone: the stacks ride under the name; Tin Man level is the metric.
    return `<tr>
      <td data-label="${esc(t('Player'))}" data-role="primary"><span class="mrow-name">${name}</span><span class="mrow-sub">${cell.html}</span></td>
      <td data-label="${esc(t('Stacks'))}" class="col-stacks" data-role="hidden" title="${esc(cell.title)}">${cell.html}</td>
      <td data-label="${esc(t('Tin Man level'))}" class="col-num" data-role="metric">${h.level === null ? '—' : esc(h.level.toLocaleString())}</td>
      <td data-label="${esc(t('Units killed'))}" class="col-num">${esc(h.killed.toLocaleString())}</td>
      <td data-label="${esc(t('Fought'))}" class="col-date" title="${esc(formatDate(h.at))}">${esc(when(h.at))}</td>
      <td data-label="${esc(t('Shared in'))}" class="col-shared" title="${esc(t('Shared by {name}', { name: h.sharedBy || '—' }))}">${esc(sharedInText(h))}</td>
    </tr>`;
  }).join('');
  const pagination = all.length > PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-hits-page="prev" ${page <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
        <span class="pagination-info">${t('Page {page} of {pages}', { page, pages })}</span>
        <button class="btn btn-tight" data-hits-page="next" ${page >= pages ? 'disabled' : ''}>${t('Next →')}</button>
      </div>`
    : '';
  const table = `<section class="ev-section" aria-labelledby="ev-hits-title">
      <h2 class="ev-section-title" id="ev-hits-title">${esc(t('Tin Man hits ({count})', { count: hits.length }))}</h2>
      <div class="ui-table-card">
        <table class="table-responsive ui-table events-hits-table">
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
        ${pagination}
      </div>
    </section>`;

  return `${tiles}${table}${notesHtml(notes)}`;
}
