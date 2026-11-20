// Events → Ancients → Vaults: who raised a Vault of the Ancients.
//
// On the first day of an Ancients run a player can raise a vault; it goes up
// by itself within ~10 squares of their city. Every scan reads the map around
// members' cities (scheduler/game-protocol-phase.ts, game_map_objects) and
// keeps each vault with its owner, so a run's raisers are the vaults first
// seen inside its window. GET /api/tinman/vaults?from=&to= serves them.
//
// One row per member (a member raises one vault a run; over All time the
// count is how many runs they raised one in), sortable, 25 a page, and the
// active members with none folded away under it — like "Did not participate".

import { api } from '../lib/api.js';
import { esc, memberLink, formatDate, formatDateShort } from '../lib/ui.js';
import { sortableThHtml } from '../lib/sort-headers.js';
import { emptyHtml, notesHtml, asList } from '../lib/ui-kit.js';
import { t, tn } from '../lib/i18n.js';

const PAGE_SIZE = 25;

let sort = { key: 'level', dir: 'desc' };
let page = 1;
let noVaultOpen = false;

/** The run's vaults ({ raised, outsiders, since }), or null when they could not be read. */
export async function fetchVaults(from, to) {
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  try {
    const res = await api(`/tinman/vaults?${qs}`);
    return res && Array.isArray(res.raised) ? res : null;
  } catch {
    return null;
  }
}

/** Vaults raised by the clan's players in the answer (for the view's tab label). */
export function vaultsCount(data) {
  return data ? data.raised.length : 0;
}

/** A new window (another run): back to the first page. */
export function resetVaultsPage() {
  page = 1;
}

/** "Today 07:14", "Yesterday 04:12", else "2026/11/17 03:40" — the viewer's clock. */
function seenWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const now = new Date();
  if (day(d) === day(now)) return t('Today {time}', { time });
  if (day(d) === day(new Date(now.getTime() - 86_400_000))) return t('Yesterday {time}', { time });
  return `${formatDateShort(iso)} ${time}`;
}

/** One row per raiser: their vaults' levels, count and first sighting. */
function raisersOf(raised) {
  const byKey = new Map();
  for (const v of raised) {
    const key = v.memberId ? `m${v.memberId}` : `n${v.ownerName}`;
    let r = byKey.get(key);
    if (!r) {
      r = { memberId: v.memberId, name: v.ownerName || '—', vaults: [] };
      byKey.set(key, r);
    }
    r.vaults.push(v);
  }
  return [...byKey.values()].map((r) => {
    const levels = r.vaults.map((v) => v.level ?? 0).sort((a, b) => b - a);
    return {
      ...r,
      levels,
      topLevel: levels[0] ?? 0,
      count: r.vaults.length,
      firstSeen: r.vaults.map((v) => v.firstSeen).sort()[0],
    };
  });
}

function sorted(rows) {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return [...rows].sort((a, b) => {
    let d = 0;
    if (sort.key === 'name') d = byName(a, b) * dir;
    else if (sort.key === 'count') d = (a.count - b.count) * dir;
    else if (sort.key === 'seen') d = a.firstSeen.localeCompare(b.firstSeen) * dir;
    else d = (a.topLevel - b.topLevel) * dir;
    return d || byName(a, b);
  });
}

/**
 * Paint the Vaults view into `el`.
 *   data     fetchVaults() answer, or null (could not be read)
 *   members  the clan's active members (for "No vault seen")
 *   to       the window's end (ISO) — members who joined after it are left out; '' = now
 */
export function mountVaults(el, { data, members, to }) {
  if (!el) return;
  const paint = () => {
    el.innerHTML = vaultsHtml(data, asList(members), to);
    wire();
  };
  const wire = () => {
    el.querySelectorAll('th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sortKey;
        if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
        else sort = { key, dir: key === 'name' || key === 'seen' ? 'asc' : 'desc' };
        page = 1;
        paint();
      });
    });
    el.querySelectorAll('[data-vaults-page]').forEach((btn) => {
      btn.addEventListener('click', () => {
        page = Math.max(1, page + (btn.dataset.vaultsPage === 'next' ? 1 : -1));
        paint();
      });
    });
    const fold = el.querySelector('details[data-section-key="events-novault"]');
    if (fold) fold.addEventListener('toggle', () => { noVaultOpen = fold.open; });
  };
  paint();
}

function vaultsHtml(data, members, to) {
  if (!data) return emptyHtml(t('The vaults could not be loaded.'));
  if (!data.since) return emptyHtml(t('The map around the clan has not been read yet.'));
  if (to && to <= data.since) {
    return emptyHtml(t('Vaults are read from the map since {date}, after this run.', { date: data.since.slice(0, 10) }));
  }

  const notes = [
    esc(t('A vault goes up within about 10 squares of the city of the member who raised it, on the first day of the run. Each scan reads the map there.')),
    esc(t('A vault taken down before the next scan is not seen.')),
  ];
  if (data.outsiders > 0) {
    notes.push(esc(tn(data.outsiders, '{n} vault raised by a player outside the clan was also seen nearby.', '{n} vaults raised by players outside the clan were also seen nearby.')));
  }

  const rows = raisersOf(data.raised);
  if (!rows.length) {
    return `${emptyHtml(t('No vault raised by a member was seen in this timeframe.'))}${notesHtml(notes)}`;
  }

  // Members who were in the clan by the window's end and have no vault in it.
  const raisedIds = new Set(rows.map((r) => r.memberId).filter(Boolean));
  const eligible = members.filter((m) => !to || !m.firstSeen || m.firstSeen < to);
  const without = eligible.filter((m) => !raisedIds.has(m.id));

  const stat = (label, value, sub = '', lead = false) => `<div class="ui-tile ev-stat${lead ? ' is-lead' : ''}">
      <span class="ui-stat-label">${esc(label)}</span>
      <span class="ui-big">${value}</span>
      ${sub ? `<span class="ui-sub">${esc(sub)}</span>` : ''}
    </div>`;
  const tiles = `<div class="ev-stats">
      ${stat(t('Vaults raised'), data.raised.length.toLocaleString(), tn(rows.length, 'by {n} member', 'by {n} members'), true)}
      ${stat(t('No vault seen'), without.length.toLocaleString(), tn(eligible.length, 'of {n} member', 'of {n} members'))}
    </div>`;

  const showCount = rows.some((r) => r.count > 1);
  const th = (key, label, cls = '') => sortableThHtml({
    key, labelHtml: esc(label), sortState: sort,
    className: [cls, sort.key === key ? 'is-sorted' : ''].filter(Boolean).join(' '),
  });
  const all = sorted(rows);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  if (page > pages) page = pages;
  const pageRows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const body = pageRows.map((r) => {
    const where = r.vaults.filter((v) => v.x !== null && v.y !== null).map((v) => `${v.x}:${v.y}`).join(', ');
    return `<tr>
      <td data-label="${esc(t('Player'))}" data-role="primary"><span class="mrow-name">${memberLink(r.memberId, r.name)}</span><span class="mrow-sub">${esc(seenWhen(r.firstSeen))}</span></td>
      <td data-label="${esc(t('Level'))}" class="col-num" data-role="metric"${where ? ` title="${esc(where)}"` : ''}>${esc(r.levels.join(', '))}</td>
      ${showCount ? `<td data-label="${esc(t('Vaults'))}" class="col-num">${r.count.toLocaleString()}</td>` : ''}
      <td data-label="${esc(t('First seen'))}" class="col-date" data-role="hidden" title="${esc(formatDate(r.firstSeen))}">${esc(seenWhen(r.firstSeen))}</td>
    </tr>`;
  }).join('');
  const pagination = all.length > PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-vaults-page="prev" ${page <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
        <span class="pagination-info">${t('Page {page} of {pages}', { page, pages })}</span>
        <button class="btn btn-tight" data-vaults-page="next" ${page >= pages ? 'disabled' : ''}>${t('Next →')}</button>
      </div>`
    : '';
  const table = `<section class="ev-section" aria-labelledby="ev-vaults-title">
      <h2 class="ev-section-title" id="ev-vaults-title">${esc(t('Raised by ({count})', { count: rows.length }))}</h2>
      <div class="ui-table-card">
        <table class="table-responsive ui-table events-vaults-table">
          <colgroup><col class="col-member"><col class="col-num">${showCount ? '<col class="col-num">' : ''}<col class="col-date"></colgroup>
          <thead><tr>
            ${th('name', t('Player'))}
            ${th('level', t('Level'), 'num')}
            ${showCount ? th('count', t('Vaults'), 'num') : ''}
            ${th('seen', t('First seen'), 'col-date')}
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
        ${pagination}
      </div>
    </section>`;

  const noVaultBody = without.length
    ? `<div class="events-np-list">${without.map((m) => `<span class="events-np-item">${memberLink(m.id, m.name)}</span>`).join('')}</div>`
    : `<p class="empty-state">${esc(t('Every member raised a vault.'))}</p>`;
  const noVault = `<details class="card card-collapsible" data-section-key="events-novault"${noVaultOpen ? ' open' : ''}>
      <summary class="card-header"><h2>${esc(t('No vault seen ({count})', { count: without.length }))}</h2></summary>
      <div class="card-body">${noVaultBody}</div>
    </details>`;

  return `${tiles}${table}${noVault}${notesHtml(notes)}`;
}
