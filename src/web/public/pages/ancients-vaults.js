// Events → Ancients → Vaults: who raised a Vault of the Ancients.
//
// On the first day of an Ancients run a player can raise a vault; it goes up
// by itself within ~10 squares of their city. Every scan reads the map around
// members' cities (scheduler/game-protocol-phase.ts, game_map_objects) and
// keeps each vault with its owner, so a run's raisers are the vaults first
// seen inside its window. GET /api/tinman/vaults?from=&to= serves them.
//
// With a vault chat picked (Clans → In-game → Battle reports, v144 — CWB's
// "-CWB VAULTS-", where everyone links the vault they raised), the answer also
// carries the links posted there in the window, each matched to a map vault or
// not (data/vault-posts.ts). Then a Posted column says who linked theirs (✓)
// and who didn't (✗), and a member who posted a vault the map never saw gets
// a row of their own ("Not seen on the map", the level from the link).
//
// One row per member (a member raises one vault a run; over All time the
// count is how many runs they raised one in), sortable, 25 a page, and the
// active members with none folded away under it — like "Did not participate".
// First seen = the first scan that saw it. The mark says whether it still
// stood at the newest scan (the map pass reads a standing vault's tile until
// it is gone): a green ✓ once it was taken down, a red ✗ while it stands. Its
// hover is the last scan that saw it — the take-down happened after that.

import { api } from '../lib/api.js';
import { esc, memberLink, formatDate, formatDateShort } from '../lib/ui.js';
import { sortableThHtml } from '../lib/sort-headers.js';
import { emptyHtml, notesHtml, asList } from '../lib/ui-kit.js';
import { t, tn } from '../lib/i18n.js';

const PAGE_SIZE = 25;

// Opens on the ones still standing, then the most recently taken down.
let sort = { key: 'down', dir: 'asc' };
let page = 1;
let noVaultOpen = false;

/** The run's vaults ({ raised, outsiders, since, vaultChats, posts }), or null when they could not be read. */
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

/** Vaults raised by the clan's players in the answer (for the view's tab label): seen on the map, or only posted. */
export function vaultsCount(data) {
  if (!data) return 0;
  return data.raised.length + unseenPosts(asList(data.posts)).length;
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

/** Posted vaults the map pass never saw, one per member, tile and level (a link posted twice is one vault). */
function unseenPosts(posts) {
  const seen = new Set();
  return posts.filter((p) => {
    if (p.objectId !== null || !p.memberId) return false;
    const k = `${p.memberId}:${p.x}:${p.y}:${p.objectType}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * A row's take-down mark and its words: "Taken down · last seen Today 07:14"
 * (✓, green) or "Still standing · last seen …" (✗, red). The words go in the
 * hover and to screen readers; colour is never the only signal. A vault only
 * posted has no mark: the map never saw it.
 */
function downMark(r) {
  if (!r.seen) return { glyph: '<span class="vault-mark is-unseen" aria-hidden="true">—</span>', words: t('Not seen on the map') };
  const time = seenWhen(r.lastSeen);
  const words = r.standing
    ? t('Still standing · last seen {time}', { time })
    : t('Taken down · last seen {time}', { time });
  const glyph = `<span class="vault-mark ${r.standing ? 'is-standing' : 'is-down'}" aria-hidden="true">${r.standing ? '✗' : '✓'}</span>`;
  return { glyph, words };
}

/** Posted in the vault chat (✓, green) or not (✗, red), with words. */
function postMark(r) {
  if (r.posted) {
    return {
      glyph: '<span class="vault-mark is-down" aria-hidden="true">✓</span>',
      words: t('Posted {time}', { time: seenWhen(r.postedAt) }),
    };
  }
  return { glyph: '<span class="vault-mark is-standing" aria-hidden="true">✗</span>', words: t('Not posted') };
}

/** One row per raiser: their vaults on the map and in the vault chat, levels, count, first sighting, whether one still stands. */
function raisersOf(raised, posts) {
  const byKey = new Map();
  const rowFor = (key, memberId, name) => {
    let r = byKey.get(key);
    if (!r) {
      r = { memberId, name: name || '—', vaults: [], posts: [] };
      byKey.set(key, r);
    }
    return r;
  };
  for (const v of raised) rowFor(v.memberId ? `m${v.memberId}` : `n${v.ownerName}`, v.memberId, v.ownerName).vaults.push(v);
  // A link counts for the member who posted it; a poster outside the roster isn't listed.
  for (const p of posts) if (p.memberId) rowFor(`m${p.memberId}`, p.memberId, p.name).posts.push(p);
  const unseen = new Set(unseenPosts(posts));
  return [...byKey.values()].map((r) => {
    const onlyPosted = r.posts.filter((p) => unseen.has(p));
    const levels = [...r.vaults.map((v) => v.level ?? 0), ...onlyPosted.map((p) => p.level)].sort((a, b) => b - a);
    const seen = r.vaults.length > 0;
    return {
      ...r,
      levels,
      topLevel: levels[0] ?? 0,
      count: r.vaults.length + onlyPosted.length,
      seen,
      firstSeen: seen ? r.vaults.map((v) => v.firstSeen).sort()[0] : '',
      lastSeen: seen ? r.vaults.map((v) => v.lastSeen).sort().at(-1) : '',
      // Over All time a raiser has a vault per run; any still up counts.
      standing: r.vaults.some((v) => v.standing === true),
      posted: r.posts.length > 0,
      postedAt: r.posts.map((p) => p.at).sort()[0] ?? '',
      unseenPosted: onlyPosted.length,
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
    // Not seen on the map sorts after every sighting.
    else if (sort.key === 'seen') d = (Number(!a.seen) - Number(!b.seen)) || a.firstSeen.localeCompare(b.firstSeen) * dir;
    // Still standing sorts first ascending, then the most recently seen; not seen last.
    else if (sort.key === 'down') {
      d = (Number(!a.seen) - Number(!b.seen))
        || ((a.standing ? 0 : 1) - (b.standing ? 0 : 1) || b.lastSeen.localeCompare(a.lastSeen)) * dir;
    }
    // Not posted first ascending: the ones to ask.
    else if (sort.key === 'posted') d = ((a.posted ? 1 : 0) - (b.posted ? 1 : 0) || a.postedAt.localeCompare(b.postedAt)) * dir;
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
        else sort = { key, dir: key === 'name' || key === 'seen' || key === 'down' || key === 'posted' ? 'asc' : 'desc' };
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

  const chats = asList(data.vaultChats);
  const hasChat = chats.length > 0;
  const posts = asList(data.posts);
  const notes = [
    esc(t('A vault goes up within about 10 squares of the city of the member who raised it, on the first day of the run. Each scan reads the map there.')),
    esc(t('A vault taken down before the next scan is not seen.')),
  ];
  if (hasChat) {
    notes.push(esc(t('Vault links are read from {chats}. A link counts for the member who posted it, and is matched to the map by tile, level and time.', { chats: chats.join(', ') })));
  } else {
    notes.push(esc(t('Pick the chat where members link their vaults under Clans → In-game → Battle reports, and this shows who posted theirs.')));
  }
  if (data.outsiders > 0) {
    notes.push(esc(tn(data.outsiders, '{n} vault raised by a player outside the clan was also seen nearby.', '{n} vaults raised by players outside the clan were also seen nearby.')));
  }

  const rows = raisersOf(data.raised, posts);
  if (!rows.length) {
    return `${emptyHtml(t('No vault raised by a member was seen in this timeframe.'))}${notesHtml(notes)}`;
  }
  const unseen = unseenPosts(posts).length;
  if (unseen > 0) {
    notes.push(esc(tn(unseen, '{n} posted vault was not seen on the map: raised out of the map pass’s reach, or taken down before a scan.', '{n} posted vaults were not seen on the map: raised out of the map pass’s reach, or taken down before a scan.')));
  }

  // Members who were in the clan by the window's end and have no vault in it, seen or posted.
  const raisedIds = new Set(rows.map((r) => r.memberId).filter(Boolean));
  const eligible = members.filter((m) => !to || !m.firstSeen || m.firstSeen < to);
  const without = eligible.filter((m) => !raisedIds.has(m.id));
  // Vaults (not raisers) the newest scan still saw.
  const standing = data.raised.filter((v) => v.standing === true).length;
  const total = data.raised.length + unseen;
  const seenRows = rows.filter((r) => r.seen);
  const notPosted = seenRows.filter((r) => !r.posted).length;

  const stat = (label, value, sub = '', lead = false, glyph = '') => `<div class="ui-tile ev-stat${lead ? ' is-lead' : ''}">
      <span class="ui-stat-label">${glyph}${esc(label)}</span>
      <span class="ui-big">${value}</span>
      ${sub ? `<span class="ui-sub">${esc(sub)}</span>` : ''}
    </div>`;
  const tiles = `<div class="ev-stats">
      ${stat(t('Vaults raised'), total.toLocaleString(), tn(rows.length, 'by {n} member', 'by {n} members'), true)}
      ${hasChat ? stat(t('Not posted'), notPosted.toLocaleString(), tn(seenRows.length, 'of {n} member seen on the map', 'of {n} members seen on the map'), false,
        '<span class="vault-mark is-standing" aria-hidden="true">✗</span>') : ''}
      ${stat(t('No vault seen'), without.length.toLocaleString(), tn(eligible.length, 'of {n} member', 'of {n} members'))}
      ${stat(t('Still standing'), standing.toLocaleString(), tn(data.raised.length, 'of {n} vault', 'of {n} vaults'), false,
        '<span class="vault-mark is-standing" aria-hidden="true">✗</span>')}
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
    const where = [...r.vaults.filter((v) => v.x !== null && v.y !== null).map((v) => `${v.x}:${v.y}`),
      ...r.posts.filter((p) => p.objectId === null).map((p) => `${p.x}:${p.y}`)].join(', ');
    const mark = downMark(r);
    const post = hasChat ? postMark(r) : null;
    // Phone: the marks and their words ride under the name; First Seen opens with the row.
    return `<tr>
      <td data-label="${esc(t('Player'))}" data-role="primary"><span class="mrow-name">${memberLink(r.memberId, r.name)}</span><span class="mrow-sub">${mark.glyph} ${esc(mark.words)}${post ? ` · ${post.glyph} ${esc(post.words)}` : ''}</span></td>
      <td data-label="${esc(t('Level'))}" class="col-num" data-role="metric"${where ? ` title="${esc(where)}"` : ''}>${esc(r.levels.join(', '))}</td>
      ${showCount ? `<td data-label="${esc(t('Vaults'))}" class="col-num">${r.count.toLocaleString()}</td>` : ''}
      <td data-label="${esc(t('First Seen'))}" class="col-date"${r.seen ? ` title="${esc(formatDate(r.firstSeen))}"` : ''}>${r.seen ? esc(seenWhen(r.firstSeen)) : `<span class="muted-copy" title="${esc(t('Not seen on the map'))}">—</span>`}</td>
      ${post ? `<td data-label="${esc(t('Posted'))}" class="col-mark" data-role="hidden" title="${esc(post.words)}">${post.glyph}<span class="visually-hidden">${esc(post.words)}</span></td>` : ''}
      <td data-label="${esc(t('Taken down'))}" class="col-mark" data-role="hidden" title="${esc(mark.words)}">${mark.glyph}<span class="visually-hidden">${esc(mark.words)}</span></td>
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
          <colgroup><col class="col-member"><col class="col-num">${showCount ? '<col class="col-num">' : ''}<col class="col-date">${hasChat ? '<col class="col-mark">' : ''}<col class="col-mark"></colgroup>
          <thead><tr>
            ${th('name', t('Player'))}
            ${th('level', t('Level'), 'num')}
            ${showCount ? th('count', t('Vaults'), 'num') : ''}
            ${th('seen', t('First Seen'), 'col-date')}
            ${hasChat ? th('posted', t('Posted'), 'col-mark') : ''}
            ${th('down', t('Taken down'), 'col-mark')}
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
