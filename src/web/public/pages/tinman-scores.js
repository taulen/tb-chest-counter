// Tin Man scores — Events → Ancients.
//
// Rise of the Ancients standings, pasted in by an admin after each summon. The
// in-game ranking is cumulative across the run, so every paste is a full
// snapshot and a player's points IN a summon are the step from the previous
// uploaded snapshot. A summon nobody pasted is simply skipped: its points land
// on the next summon that was pasted, and the table says so instead of showing
// zeros. Server side: routes/tinman.ts, data/repositories/tinman-repo.ts.
//
// Self-contained: events.js paints the page and then calls mountTinmanScores
// with the selected run; this module owns its card, state and repaints, and
// keeps the run's data cached so a sort or page change on the events table
// doesn't refetch it.

import { api, apiPut, apiDelete } from '../lib/api.js';
import { esc, memberLink, notify, confirmDialog, formatDate } from '../lib/ui.js';
import { sortableThHtml } from '../lib/sort-headers.js';
import { getCurrentUser } from '../lib/state.js';
import { formatCompact } from '../lib/ancient-planner.js';

const PAGE_SIZE = 25;

let mountEl = null;
let members = [];
/** Requested run: a Tinman date, null for "the newest", or 'all' (no single run). */
let requested = null;
let data = null;          // last GET /tinman response
let loadedFor = undefined; // the `requested` value `data` answers
let sort = { key: 'total', dir: 'desc' };
let page = 1;
let uploadOpen = false;
let uploadSummon = null;  // chosen summon in the upload form
let uploadText = '';
let lastResult = null;    // message after a save

function isAdmin() {
  const role = getCurrentUser()?.role;
  return role === 'admin' || role === 'superadmin';
}

/**
 * Render the card into `el` for one run.
 * @param {HTMLElement} el
 * @param {{ date: string | null | 'all', members: Array<{ id: number, name: string }> }} opts
 */
export async function mountTinmanScores(el, opts) {
  if (!el) return;
  mountEl = el;
  members = [...(opts.members || [])].sort((a, b) => a.name.localeCompare(b.name));
  if (opts.date !== requested) {
    requested = opts.date;
    page = 1;
    uploadSummon = null;
    lastResult = null;
  }
  if (requested === 'all') {
    el.innerHTML = cardHtml('<p class="muted-copy tinman-note">Tin Man scores are per run — pick a single run with the arrows above to see them.</p>', '');
    return;
  }
  if (loadedFor !== requested || !data) {
    el.innerHTML = cardHtml('<p class="muted-copy tinman-note">Loading…</p>', '');
    await load();
  }
  paint();
}

async function load() {
  const want = requested;
  try {
    const qs = want ? `?date=${encodeURIComponent(want)}` : '';
    const res = await api(`/tinman${qs}`);
    if (want !== requested) return; // superseded by another run
    data = res?.error ? null : res;
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
    data = null;
  }
  loadedFor = want;
}

function cardHtml(body, actions) {
  const date = data && loadedFor === requested ? data.date : (requested && requested !== 'all' ? requested : '');
  return `
    <div class="card tinman-card">
      <div class="card-header">
        <div class="events-title">
          <h2>Tin Man scores</h2>
          <span class="card-header-hint">Rise of the Ancients${date ? ` · ${esc(date)}` : ''} · points per summon</span>
        </div>
        ${actions}
      </div>
      ${body}
    </div>`;
}

// ─── Painting ────────────────────────────────────────────────────

/** Summon columns: 1 … the highest uploaded, gaps included so a missed summon shows. */
function summonColumns() {
  const uploaded = new Map((data?.summons || []).map((s) => [s.summon, s]));
  const highest = Math.max(0, ...uploaded.keys());
  const cols = [];
  let gap = [];
  for (let n = 1; n <= highest; n++) {
    if (uploaded.has(n)) {
      cols.push({ summon: n, uploaded: true, covers: gap });
      gap = [];
    } else {
      cols.push({ summon: n, uploaded: false, covers: [] });
      gap.push(n);
    }
  }
  return cols;
}

function sortedPlayers(cols) {
  const players = [...(data?.players || [])];
  players.forEach((p, i) => { p._rank = i + 1; }); // server order: total desc
  // A summon column that no longer exists (another run) sorts by total instead.
  const key = sort.key.startsWith('s:') && !cols.some((c) => c.uploaded && `s:${c.summon}` === sort.key)
    ? 'total'
    : sort.key;
  const mul = sort.dir === 'asc' ? 1 : -1;
  const val = (p) => {
    if (key === 'name') return p.name.toLowerCase();
    if (key === 'rank') return p._rank;
    if (key === 'played') return p.played;
    if (key.startsWith('s:')) return p.perSummon[Number(key.slice(2))] ?? -1;
    return p.total;
  };
  players.sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return a._rank - b._rank;
  });
  return players;
}

function paint() {
  if (!mountEl) return;
  if (!data) {
    mountEl.innerHTML = cardHtml('<p class="muted-copy tinman-note">Could not load the Tin Man scores.</p>', '');
    return;
  }
  const admin = isAdmin();
  const actions = admin
    ? `<button type="button" class="btn btn-sm ${uploadOpen ? 'active' : 'btn-primary'}" data-tinman="toggle-upload">${uploadOpen ? 'Close' : 'Add summon scores'}</button>`
    : '';

  const cols = summonColumns();
  const body = `
    ${data.isTinmanDay === false ? `<p class="tinman-warn">⚠ ${esc(data.date)} isn't a Tinman day on the usual 6-day cadence.</p>` : ''}
    ${uploadOpen && admin ? uploadPanelHtml() : ''}
    ${summonsStripHtml(admin)}
    ${data.players.length ? tableHtml(cols) : `<p class="muted-copy tinman-note">${admin
      ? 'No scores for this run yet. After each summon, copy the in-game ranking and add it with <strong>Add summon scores</strong>.'
      : 'No scores for this run yet — an admin adds them after each summon.'}</p>`}
    ${reviewHtml(admin)}`;
  mountEl.innerHTML = cardHtml(body, actions);
  wire();
}

function summonsStripHtml(admin) {
  const summons = data.summons || [];
  if (!summons.length) return '';
  const chips = summons.map((s) => `
    <span class="tinman-chip">
      <strong>Summon ${s.summon}</strong>
      <span class="tinman-chip-meta">${s.rows} names${s.unmatched ? ` · <span class="tool-warn">${s.unmatched} unmatched</span>` : ''} · ${esc(s.uploadedBy || '—')} · ${esc(formatDate(s.uploadedAt))}</span>
      ${admin ? `<button type="button" class="tinman-chip-del" data-tinman="delete" data-summon="${s.summon}" aria-label="Delete summon ${s.summon} scores" title="Delete this upload">×</button>` : ''}
    </span>`).join('');
  return `<div class="tinman-chips">${chips}</div>`;
}

function uploadPanelHtml() {
  const uploaded = new Set((data.summons || []).map((s) => s.summon));
  const max = data.maxSummons || 8;
  const next = Math.min(max, Math.max(0, ...uploaded) + 1);
  const chosen = uploadSummon ?? next;
  const options = [];
  for (let n = 1; n <= max; n++) {
    options.push(`<option value="${n}" ${n === chosen ? 'selected' : ''}>Summon ${n}${uploaded.has(n) ? ' — replaces the current upload' : ''}</option>`);
  }
  const res = lastResult
    ? `<div class="tinman-result ${lastResult.error ? 'is-error' : ''}" role="status">${lastResult.html}</div>`
    : '';
  return `
    <div class="tinman-upload">
      <div class="tinman-upload-row">
        <label for="tinmanSummon">Scores after</label>
        <select id="tinmanSummon" class="input tinman-summon-select" data-tinman="summon">${options.join('')}</select>
      </div>
      <label class="visually-hidden" for="tinmanText">Pasted ranking</label>
      <textarea id="tinmanText" class="input tinman-text" rows="8" spellcheck="false"
        placeholder="Paste the whole clan ranking as it stands after this summon, e.g.&#10;| 1 | Fiin SK 2 | 63,965,364 |&#10;| 2 | Frostbite | 59,878,655 |">${esc(uploadText)}</textarea>
      <p class="muted-copy tinman-hint">The in-game ranking keeps growing through the run — paste it as it stands. Missed a summon? Just paste the next one: those points land there.</p>
      <div class="tinman-upload-actions">
        <button type="button" class="btn btn-primary" data-tinman="save">Save summon ${chosen}</button>
      </div>
      ${res}
    </div>`;
}

function tableHtml(cols) {
  const players = sortedPlayers(cols);
  const total = players.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > pages) page = pages;
  const rows = players.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const th = (key, labelHtml, className = '', title = '') => sortableThHtml({
    key, labelHtml, sortState: sort, title,
    className: [className, sort.key === key ? 'is-sorted' : ''].filter(Boolean).join(' '),
  });
  const summonHeads = cols.map((c) => {
    if (!c.uploaded) {
      return `<th class="num tinman-missing-col" title="Summon ${c.summon} was not pasted — its points are in the next pasted summon">S${c.summon}<span class="tinman-col-sub">not uploaded</span></th>`;
    }
    const covers = c.covers.length ? `<span class="tinman-col-sub">incl. S${c.covers.join(', S')}</span>` : '';
    const title = c.covers.length
      ? `Points scored since summon ${c.covers[0] - 1 || 'the start'} — includes the summon(s) not pasted`
      : `Points scored in summon ${c.summon}`;
    return th(`s:${c.summon}`, `S${c.summon}${covers}`, 'num', title);
  }).join('');

  const body = rows.map((p) => {
    const nameHtml = p.memberId
      ? memberLink(p.memberId, p.name)
      : `<span class="tinman-raw">${esc(p.rawName)}</span>`;
    const tag = !p.memberId
      ? ' <span class="tinman-tag" title="Not matched to a clan member yet">not matched</span>'
      : p.matchKind === 'fuzzy' && p.rawName !== p.name
        ? ` <span class="tinman-tag tinman-tag-fuzzy" title="Pasted as “${esc(p.rawName)}” — matched by spelling">≈</span>`
        : '';
    const cells = cols.map((c) => {
      if (!c.uploaded) return '<td class="num tinman-missing-col" data-label="S' + c.summon + '"><span class="events-zero">·</span></td>';
      const v = p.perSummon[c.summon];
      if (v === undefined) return `<td class="num" data-label="S${c.summon}"><span class="events-zero" title="Not in this summon's ranking">–</span></td>`;
      if (v === 0) return `<td class="num" data-label="S${c.summon}"><span class="events-zero" title="No points in this summon">—</span></td>`;
      return `<td class="num${v < 0 ? ' tool-short' : ''}" data-label="S${c.summon}" title="${v.toLocaleString()}">${formatCompact(v)}</td>`;
    }).join('');
    return `<tr>
      <td data-role="lead">${p._rank}</td>
      <td data-role="primary"><span class="mrow-name">${nameHtml}${tag}</span><span class="mrow-sub">${p.played} of ${cols.filter((c) => c.uploaded).length} pasted summons</span></td>
      ${cells}
      <td class="num" data-role="metric" data-label="Total" title="${p.total.toLocaleString()}"><strong>${formatCompact(p.total)}</strong></td>
      <td class="num" data-role="hidden">${p.played}</td>
    </tr>`;
  }).join('');

  const pagination = total > PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-tinman-page="prev" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
        <span class="pagination-info">Page ${page} of ${pages} · ${total} players</span>
        <button class="btn btn-tight" data-tinman-page="next" ${page >= pages ? 'disabled' : ''}>Next →</button>
      </div>`
    : '';

  return `
    <div class="card-body">
      <div class="events-scroll">
        <table class="table-responsive tinman-table">
          <colgroup><col class="col-rank"><col class="col-member">${cols.map(() => '<col class="col-num">').join('')}<col class="col-num"><col class="col-played"></colgroup>
          <thead><tr>
            ${th('rank', 'Rank')}
            ${th('name', 'Player')}
            ${summonHeads}
            ${th('total', 'Total', 'num', 'Points over the whole run so far')}
            ${th('played', 'Played', 'num', 'Summons this player scored in')}
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      ${pagination}
    </div>`;
}

function reviewHtml(admin) {
  const review = data.review || [];
  if (!review.length) return '';
  const unmatched = review.filter((r) => !r.memberId).length;
  if (!admin) {
    return unmatched ? `<p class="muted-copy tinman-note">${unmatched} pasted name${unmatched === 1 ? ' is' : 's are'} not matched to a member yet — an admin can assign them.</p>` : '';
  }
  const options = (selected) => [
    `<option value="">— Not a clan member —</option>`,
    ...members.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)}</option>`),
  ].join('');
  const rows = review.map((r) => `
    <tr>
      <td data-role="primary"><span class="mrow-name">${esc(r.rawName)}</span><span class="mrow-sub">${r.memberId ? 'matched by spelling' : r.matchKind === 'rejected' ? 'marked as not a member' : 'no match'}</span></td>
      <td class="num" data-role="metric" data-label="Points">${formatCompact(r.points)}</td>
      <td data-label="Member">
        <select class="input tinman-assign" data-raw-name="${esc(r.rawName)}" aria-label="Member for ${esc(r.rawName)}">${options(r.memberId)}</select>
      </td>
      <td data-label="">
        <button type="button" class="btn btn-sm" data-tinman="assign" data-raw-name="${esc(r.rawName)}">${r.memberId ? 'Confirm' : 'Save'}</button>
      </td>
    </tr>`).join('');
  return `
    <details class="card-collapsible tinman-review" data-section-key="tinman-review" ${unmatched ? 'open' : ''}>
      <summary class="card-header"><h2>Names to check (${review.length})</h2><span class="card-header-hint">${unmatched} unmatched · ${review.length - unmatched} matched by spelling</span></summary>
      <div class="card-body">
        <p class="muted-copy tinman-hint">Pick who each pasted name is. It applies to every summon of this run, and the spelling is remembered for future runs.</p>
        <table class="table-responsive tinman-review-table">
          <colgroup><col class="col-member"><col class="col-num"><col class="col-assign"><col class="col-action"></colgroup>
          <thead><tr><th>Pasted name</th><th class="num">Points</th><th>Member</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
}

// ─── Actions ─────────────────────────────────────────────────────

function wire() {
  const el = mountEl;
  el.querySelectorAll('.tinman-table th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      else sort = { key, dir: key === 'name' || key === 'rank' ? 'asc' : 'desc' };
      page = 1;
      paint();
    });
  });
  el.querySelectorAll('[data-tinman-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      page += btn.dataset.tinmanPage === 'next' ? 1 : -1;
      if (page < 1) page = 1;
      paint();
    });
  });
  const text = el.querySelector('#tinmanText');
  if (text) text.addEventListener('input', () => { uploadText = text.value; });
  const select = el.querySelector('[data-tinman="summon"]');
  if (select) {
    select.addEventListener('change', () => {
      uploadSummon = Number(select.value);
      const btn = el.querySelector('[data-tinman="save"]');
      if (btn) btn.textContent = `Save summon ${uploadSummon}`;
    });
  }
  el.querySelectorAll('[data-tinman]').forEach((btn) => {
    if (btn.tagName !== 'BUTTON') return;
    btn.addEventListener('click', () => onAction(btn));
  });
}

async function onAction(btn) {
  const action = btn.dataset.tinman;
  if (action === 'toggle-upload') {
    uploadOpen = !uploadOpen;
    lastResult = null;
    paint();
    if (uploadOpen) mountEl.querySelector('#tinmanText')?.focus();
    return;
  }
  if (action === 'save') return save(btn);
  if (action === 'delete') return removeSummon(Number(btn.dataset.summon));
  if (action === 'assign') return assign(btn);
}

async function save(btn) {
  const summonSel = mountEl.querySelector('[data-tinman="summon"]');
  const summon = Number(summonSel?.value || 1);
  const text = mountEl.querySelector('#tinmanText')?.value || '';
  if (!text.trim()) {
    lastResult = { error: true, html: 'Paste the ranking first.' };
    paint();
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await apiPut(`/tinman/${encodeURIComponent(data.date)}/summons/${summon}`, { text });
    if (res?.error) {
      const sample = Array.isArray(res.skipped) && res.skipped.length
        ? `<br><span class="muted-copy">Couldn't read: ${res.skipped.map((s) => `<code>${esc(s)}</code>`).join(' ')}</span>`
        : '';
      lastResult = { error: true, html: `${esc(res.error)}${sample}` };
    } else {
      const r = res.result;
      const parts = [
        `<strong>Summon ${summon} ${r.replaced ? 'replaced' : 'saved'}</strong>: ${r.rows} names read`,
        `${r.matched - r.fuzzy} matched exactly`,
        r.fuzzy ? `${r.fuzzy} matched by spelling` : '',
        r.unmatched ? `<span class="tool-warn">${r.unmatched} not matched — see Names to check</span>` : '',
      ].filter(Boolean);
      const skipped = r.skipped ? `<br><span class="muted-copy">${r.skipped} line${r.skipped === 1 ? '' : 's'} skipped: ${r.skippedSample.map((s) => `<code>${esc(s)}</code>`).join(' ')}</span>` : '';
      const warn = [res.warning, res.staleWarning].filter(Boolean).map((w) => `<br><span class="tool-warn">⚠ ${esc(w)}</span>`).join('');
      lastResult = { error: false, html: `${parts.join(' · ')}${skipped}${warn}` };
      uploadText = '';
      uploadSummon = null;
      await load();
    }
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    lastResult = { error: true, html: esc(`Could not save: ${err?.message || err}`) };
  }
  paint();
}

async function removeSummon(summon) {
  const ok = await confirmDialog(`Delete the pasted scores for summon ${summon}? Its points move to the next pasted summon.`, {
    title: 'Delete summon scores', confirmLabel: 'Delete', danger: true,
  });
  if (!ok) return;
  try {
    const res = await apiDelete(`/tinman/${encodeURIComponent(data.date)}/summons/${summon}`);
    if (res?.error) await notify(res.error, 'Could not delete');
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    await notify(`Could not delete: ${err?.message || err}`, 'Could not delete');
  }
  await load();
  paint();
}

async function assign(btn) {
  const rawName = btn.dataset.rawName;
  const select = [...mountEl.querySelectorAll('select.tinman-assign')].find((s) => s.dataset.rawName === rawName);
  const memberId = select && select.value ? Number(select.value) : null;
  btn.disabled = true;
  try {
    const res = await apiPut(`/tinman/${encodeURIComponent(data.date)}/assign`, { rawName, memberId });
    if (res?.error) {
      await notify(res.error, 'Could not assign');
      btn.disabled = false;
      return;
    }
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    await notify(`Could not assign: ${err?.message || err}`, 'Could not assign');
    btn.disabled = false;
    return;
  }
  await load();
  paint();
}
