// Admin → Levels from chat. Paste the levels players post in the in-game chat
// ("taulen: G8/M8/S7/E8/C35/D284"), check who each name is, and save. Every
// letter is stored; the G value also becomes an admin guards entry, so the
// guards estimate picks it up. Server: routes/member-levels.ts.
//
// Two steps on purpose: names in chat are hand-typed and often off by a letter,
// so nothing is saved until an admin has seen who each one was matched to.

import { api, apiPost } from '../lib/api.js';
import { esc, memberLink, notify } from '../lib/ui.js';

const LETTERS = ['g', 'm', 's', 'e', 'c', 'd'];
const LETTER_TITLE = {
  g: 'G — Guardsmen level',
  m: 'M — Monsters level',
  s: 'S — Specialists level',
  e: 'E — Engineering level',
  c: 'C — Crypting level',
  d: 'D — Dragon level',
};

let el = null;
let members = [];
let today = '';
let latest = [];
let preview = null;   // { rows, skipped } from /preview, with picks applied
let picks = new Map(); // row index → member id ('' = skip)
let text = '';
let message = null;   // { error, html }

export async function mountMemberLevels(target) {
  el = target;
  el.innerHTML = '<div class="card-body card-body-padded"><p class="muted-copy">Loading…</p></div>';
  await reload();
}

async function reload() {
  try {
    const [res, mem] = await Promise.all([api('/member-levels'), api('/members')]);
    latest = Array.isArray(res?.rows) ? res.rows : [];
    today = res?.today || '';
    members = (Array.isArray(mem) ? mem : []).slice().sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
  }
  paint();
}

function paint() {
  if (!el) return;
  el.innerHTML = `
    <div class="card-header">
      <h2>Levels from chat</h2>
      <span class="card-header-hint">Paste what players post — G also feeds their guards level</span>
    </div>
    <div class="card-body card-body-padded">
      <label class="visually-hidden" for="levelsText">Chat lines</label>
      <textarea id="levelsText" class="input tinman-text" rows="7" spellcheck="false"
        placeholder="One player per line, as posted in chat, e.g.&#10;taulen: G8/M8/S7/E8/C35/D284&#10;Dark Knight: G7.M8.S7.E7.C30.D199">${esc(text)}</textarea>
      <div class="levels-controls">
        <button type="button" class="btn btn-primary" data-levels="preview">Check names</button>
        <span class="muted-copy">Saved as reported today${today ? ` (${esc(today)})` : ''}.</span>
      </div>
      ${message ? `<div class="tinman-result ${message.error ? 'is-error' : ''}" role="status">${message.html}</div>` : ''}
      ${preview ? previewHtml() : ''}
      ${latestHtml()}
    </div>`;
  wire();
}

function letterCells(levels) {
  return LETTERS.map((k) => `<td class="num" data-label="${k.toUpperCase()}">${levels?.[k] ?? '<span class="events-zero">—</span>'}</td>`).join('');
}

function letterHeads() {
  return LETTERS.map((k) => `<th class="num" title="${esc(LETTER_TITLE[k])}">${k.toUpperCase()}</th>`).join('');
}

function previewHtml() {
  const rows = preview.rows;
  const options = (selected) => [
    `<option value="">— Skip —</option>`,
    ...members.map((m) => `<option value="${m.id}" ${String(m.id) === String(selected) ? 'selected' : ''}>${esc(m.name)}</option>`),
  ].join('');
  const picked = rows.map((_, i) => picks.get(i) ?? '');
  const dupes = new Set(picked.filter((v, i) => v && picked.indexOf(v) !== i));
  const body = rows.map((r, i) => {
    const sel = picks.get(i) ?? '';
    const tag = r.matchKind === 'exact'
      ? '<span class="levels-tag is-ok" title="Exact match">✓</span>'
      : r.matchKind === 'fuzzy'
        ? `<span class="levels-tag is-fuzzy" title="Matched by spelling to ${esc(r.memberName || '')} — check it">≈</span>`
        : '<span class="levels-tag is-none" title="No member matched — pick one or leave it skipped">?</span>';
    return `<tr class="${dupes.has(sel) ? 'levels-dupe' : ''}">
      <td data-role="primary"><span class="mrow-name">${tag} ${esc(r.rawName)}</span><span class="mrow-sub" title="${esc(r.raw)}">${esc(r.raw.split('\n')[0])}</span></td>
      <td data-label="Member"><select class="input levels-pick" data-row="${i}" aria-label="Member for ${esc(r.rawName)}">${options(sel)}</select></td>
      ${letterCells(r.levels)}
    </tr>`;
  }).join('');
  const matched = picked.filter(Boolean).length;
  const fuzzy = rows.filter((r) => r.matchKind === 'fuzzy').length;
  const none = rows.filter((r) => r.matchKind === 'unmatched').length;
  const skipped = preview.skipped?.length
    ? `<p class="muted-copy tinman-hint">${preview.skipped.length} line${preview.skipped.length === 1 ? '' : 's'} not read: ${preview.skipped.slice(0, 5).map((s) => `<code>${esc(s)}</code>`).join(' ')}</p>`
    : '';
  return `
    <div class="levels-preview">
      <p class="levels-summary"><strong>${rows.length} players read</strong> · ${matched} to save${fuzzy ? ` · <span class="tool-warn">${fuzzy} matched by spelling — check them</span>` : ''}${none ? ` · ${none} not matched (skipped unless you pick a member)` : ''}${dupes.size ? ' · <span class="tool-short">the same member is picked twice</span>' : ''}</p>
      ${skipped}
      <div class="events-scroll">
        <table class="table-responsive levels-table">
          <colgroup><col class="col-member"><col class="col-assign">${LETTERS.map(() => '<col class="col-lvl">').join('')}</colgroup>
          <thead><tr><th>Posted as</th><th>Member</th>${letterHeads()}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <div class="tinman-upload-actions levels-save">
        <button type="button" class="btn btn-primary" data-levels="save" ${matched && !dupes.size ? '' : 'disabled'}>Save ${matched} player${matched === 1 ? '' : 's'}</button>
        <button type="button" class="btn" data-levels="cancel">Cancel</button>
      </div>
    </div>`;
}

function latestHtml() {
  if (!latest.length) return '';
  const body = latest.map((r) => {
    const g = r.levels.g;
    const est = r.guardsEstimate;
    const gCell = g === undefined
      ? '<span class="events-zero">—</span>'
      : `${g}${est !== null && est !== g ? ` <span class="muted-copy" title="Guards estimate from donations + entries">(est. ${est})</span>` : ''}`;
    return `<tr>
      <td data-role="primary"><span class="mrow-name">${memberLink(r.memberId, r.name)}${r.isActive ? '' : ' <span class="muted-copy">(left)</span>'}</span></td>
      <td class="num" data-label="G">${gCell}</td>
      ${LETTERS.slice(1).map((k) => `<td class="num" data-label="${k.toUpperCase()}" title="${r.asOf[k] ? `reported ${esc(r.asOf[k])}` : ''}">${r.levels[k] ?? '<span class="events-zero">—</span>'}</td>`).join('')}
      <td class="history-date" data-label="Reported">${esc(r.lastReported)}</td>
    </tr>`;
  }).join('');
  return `
    <details class="card-collapsible tool-roster-list" data-section-key="admin-member-levels">
      <summary class="card-header"><h2>Latest reported levels (${latest.length})</h2></summary>
      <div class="events-scroll">
        <table class="table-responsive levels-table">
          <colgroup><col class="col-member">${LETTERS.map(() => '<col class="col-lvl">').join('')}<col class="col-date"></colgroup>
          <thead><tr><th>Member</th>${letterHeads()}<th>Reported</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </details>`;
}

function wire() {
  const ta = el.querySelector('#levelsText');
  if (ta) ta.addEventListener('input', () => { text = ta.value; });
  el.querySelectorAll('select.levels-pick').forEach((sel) => {
    sel.addEventListener('change', () => {
      picks.set(Number(sel.dataset.row), sel.value);
      paint();
      el.querySelector(`select.levels-pick[data-row="${sel.dataset.row}"]`)?.focus();
    });
  });
  el.querySelectorAll('[data-levels]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = btn.dataset.levels;
      if (a === 'preview') return runPreview(btn);
      if (a === 'save') return save(btn);
      if (a === 'cancel') {
        preview = null;
        message = null;
        paint();
      }
    });
  });
}

async function runPreview(btn) {
  if (!text.trim()) {
    message = { error: true, html: 'Paste the chat lines first.' };
    paint();
    return;
  }
  btn.disabled = true;
  try {
    const res = await apiPost('/member-levels/preview', { text });
    if (res?.error) {
      const s = Array.isArray(res.skipped) && res.skipped.length ? ` Couldn't read: ${res.skipped.map((x) => `<code>${esc(x)}</code>`).join(' ')}` : '';
      message = { error: true, html: `${esc(res.error)}${s}` };
      preview = null;
    } else {
      preview = res;
      picks = new Map(res.rows.map((r, i) => [i, r.memberId ? String(r.memberId) : '']));
      message = null;
    }
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    message = { error: true, html: esc(`Could not check: ${err?.message || err}`) };
  }
  paint();
}

async function save(btn) {
  const entries = preview.rows
    .map((r, i) => ({ memberId: Number(picks.get(i) || 0), levels: r.levels, raw: r.raw }))
    .filter((e) => e.memberId > 0);
  if (!entries.length) return;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await apiPost('/member-levels/import', { entries });
    if (res?.error) {
      await notify(res.error, 'Could not save');
      btn.disabled = false;
      return;
    }
    const r = res.result;
    message = {
      error: false,
      html: `<strong>Saved ${r.saved} player${r.saved === 1 ? '' : 's'}</strong> for ${esc(today)} · ${r.guardsReports} guards level${r.guardsReports === 1 ? '' : 's'} entered${r.rejected ? ` · ${r.rejected} skipped` : ''}.`,
    };
    preview = null;
    text = '';
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    await notify(`Could not save: ${err?.message || err}`, 'Could not save');
    btn.disabled = false;
    return;
  }
  await reload();
}
