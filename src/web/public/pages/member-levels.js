// Admin → Levels from chat. Paste the levels players post in the in-game chat
// ("taulen: G8/M8/S7/E8/C35/D284"), check who each name is, and save. Every
// letter is stored; the G value also becomes an admin guards entry, so the
// guards estimate picks it up. Server: routes/member-levels.ts.
//
// Two steps on purpose: names in chat are hand-typed and often off by a letter,
// so nothing is saved until an admin has seen who each one was matched to.

import { api, apiPost } from '../lib/api.js';
import { esc, memberLink, notify } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';

const LETTERS = ['g', 'm', 's', 'e', 'c', 'd'];
const LETTER_TITLE = {
  g: t('{letter} — {category} level', { letter: 'G', category: tGame('Guardsmen') }),
  m: t('{letter} — {category} level', { letter: 'M', category: tGame('Monsters') }),
  s: t('{letter} — {category} level', { letter: 'S', category: tGame('Specialists') }),
  e: t('{letter} — {category} level', { letter: 'E', category: tGame('Engineering') }),
  c: t('{letter} — {category} level', { letter: 'C', category: tGame('Crypting') }),
  d: t('{letter} — {category} level', { letter: 'D', category: tGame('Dragon') }),
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
  el.innerHTML = `<div class="card-body card-body-padded"><p class="muted-copy">${t('Loading…')}</p></div>`;
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
      <h2>${t('Levels from chat')}</h2>
      <span class="card-header-hint">${t('Paste what players post — G also feeds their guards level')}</span>
    </div>
    <div class="card-body card-body-padded">
      <label class="visually-hidden" for="levelsText">${t('Chat lines')}</label>
      <textarea id="levelsText" class="input tinman-text" rows="7" spellcheck="false"
        placeholder="${t('One player per line, as posted in chat, e.g.')}&#10;taulen: G8/M8/S7/E8/C35/D284&#10;Dark Knight: G7.M8.S7.E7.C30.D199">${esc(text)}</textarea>
      <div class="levels-controls">
        <button type="button" class="btn btn-primary" data-levels="preview">${t('Check names')}</button>
        <span class="muted-copy">${today ? t('Saved as reported today ({date}).', { date: esc(today) }) : t('Saved as reported today.')}</span>
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

// Preview cells measured against the picked member's latest report: a changed
// value shows "old → new" (green up, red down), an unchanged one is muted.
function diffCells(levels, prev) {
  return LETTERS.map((k) => {
    const v = levels?.[k];
    if (v === undefined || v === null) return `<td class="num" data-label="${k.toUpperCase()}"><span class="events-zero">—</span></td>`;
    const old = prev?.levels?.[k];
    const date = esc(prev?.asOf?.[k] || '');
    if (old === undefined || old === null) {
      return `<td class="num levels-new" data-label="${k.toUpperCase()}" title="${t('First report')}">${v}</td>`;
    }
    if (old === v) {
      return `<td class="num levels-same" data-label="${k.toUpperCase()}" title="${t('Unchanged since {date}', { date })}">${v}</td>`;
    }
    return `<td class="num levels-changed ${v > old ? 'is-up' : 'is-down'}" data-label="${k.toUpperCase()}" title="${t('Was {old} (reported {date})', { old, date })}"><span class="levels-was">${old}→</span><strong>${v}</strong></td>`;
  }).join('');
}

function countChanges(levels, prev) {
  return LETTERS.filter((k) => levels?.[k] != null && prev?.levels?.[k] != null && prev.levels[k] !== levels[k]).length;
}

// What saving this row changes — under the member picker, and as the phone
// compact row's summary line.
function diffStatus(levels, prev) {
  if (!prev) return { cls: 'is-new', text: t('First report') };
  const n = countChanges(levels, prev);
  if (n) return { cls: 'is-changed', text: tn(n, '{n} level changed', '{n} levels changed', { n }) };
  return { cls: '', text: t('No change since {date}', { date: esc(prev.lastReported || '') }) };
}

function letterHeads() {
  return LETTERS.map((k) => `<th class="num" title="${esc(LETTER_TITLE[k])}">${k.toUpperCase()}</th>`).join('');
}

function previewHtml() {
  const rows = preview.rows;
  const options = (selected) => [
    `<option value="">${t('— Skip —')}</option>`,
    ...members.map((m) => `<option value="${m.id}" ${String(m.id) === String(selected) ? 'selected' : ''}>${esc(m.name)}</option>`),
  ].join('');
  const picked = rows.map((_, i) => picks.get(i) ?? '');
  const dupes = new Set(picked.filter((v, i) => v && picked.indexOf(v) !== i));
  const latestById = new Map(latest.map((l) => [String(l.memberId), l]));
  const changedPlayers = rows.filter((r, i) => picked[i] && countChanges(r.levels, latestById.get(picked[i]))).length;
  const firstReports = picked.filter((v) => v && !latestById.has(v)).length;
  const body = rows.map((r, i) => {
    const sel = picks.get(i) ?? '';
    const status = sel ? diffStatus(r.levels, latestById.get(sel)) : null;
    const tag = r.matchKind === 'exact'
      ? `<span class="levels-tag is-ok" title="${t('Exact match')}">✓</span>`
      : r.matchKind === 'fuzzy'
        ? `<span class="levels-tag is-fuzzy" title="${t('Matched by spelling to {name} — check it', { name: esc(r.memberName || '') })}">≈</span>`
        : `<span class="levels-tag is-none" title="${t('No member matched — pick one or leave it skipped')}">?</span>`;
    return `<tr class="${dupes.has(sel) ? 'levels-dupe' : ''}">
      <td data-role="primary"><span class="mrow-name">${tag} ${esc(r.rawName)}</span><span class="mrow-sub levels-sub ${status?.cls || ''}" title="${esc(r.raw)}">${status ? status.text : esc(r.raw.split('\n')[0])}</span></td>
      <td data-label="${t('Member')}"><select class="input levels-pick" data-row="${i}" aria-label="${t('Member for {name}', { name: esc(r.rawName) })}">${options(sel)}</select>${status ? `<span class="levels-status ${status.cls}">${status.text}</span>` : ''}</td>
      ${sel ? diffCells(r.levels, latestById.get(sel)) : letterCells(r.levels)}
    </tr>`;
  }).join('');
  const matched = picked.filter(Boolean).length;
  const fuzzy = rows.filter((r) => r.matchKind === 'fuzzy').length;
  const none = rows.filter((r) => r.matchKind === 'unmatched').length;
  const skipped = preview.skipped?.length
    ? `<p class="muted-copy tinman-hint">${tn(preview.skipped.length, '{n} line not read: {lines}', '{n} lines not read: {lines}', { n: preview.skipped.length, lines: preview.skipped.slice(0, 5).map((s) => `<code>${esc(s)}</code>`).join(' ') })}</p>`
    : '';
  return `
    <div class="levels-preview">
      <p class="levels-summary"><strong>${tn(rows.length, '{n} players read', '{n} players read', { n: rows.length })}</strong> · ${tn(matched, '{n} to save', '{n} to save', { n: matched })}${changedPlayers ? ` · ${tn(changedPlayers, '{n} with changed levels', '{n} with changed levels', { n: changedPlayers })}` : ''}${firstReports ? ` · ${tn(firstReports, '{n} first report', '{n} first reports', { n: firstReports })}` : ''}${fuzzy ? ` · <span class="tool-warn">${tn(fuzzy, '{n} matched by spelling — check them', '{n} matched by spelling — check them', { n: fuzzy })}</span>` : ''}${none ? ` · ${tn(none, '{n} not matched (skipped unless you pick a member)', '{n} not matched (skipped unless you pick a member)', { n: none })}` : ''}${dupes.size ? ` · <span class="tool-short">${t('the same member is picked twice')}</span>` : ''}</p>
      ${skipped}
      <div class="events-scroll">
        <table class="table-responsive levels-table levels-diff">
          <colgroup><col class="col-member"><col class="col-assign">${LETTERS.map(() => '<col class="col-lvl">').join('')}</colgroup>
          <thead><tr><th>${t('Posted as')}</th><th>${t('Member')}</th>${letterHeads()}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <div class="tinman-upload-actions levels-save">
        <button type="button" class="btn btn-primary" data-levels="save" ${matched && !dupes.size ? '' : 'disabled'}>${tn(matched, 'Save {n} player', 'Save {n} players', { n: matched })}</button>
        <button type="button" class="btn" data-levels="cancel">${t('Cancel')}</button>
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
      : `${g}${est !== null && est !== g ? ` <span class="muted-copy" title="${t('Guards estimate from donations + entries')}">${t('(est. {estimate})', { estimate: est })}</span>` : ''}`;
    return `<tr>
      <td data-role="primary"><span class="mrow-name">${memberLink(r.memberId, r.name)}${r.isActive ? '' : ` <span class="muted-copy">${t('(left)')}</span>`}</span></td>
      <td class="num" data-label="G">${gCell}</td>
      ${LETTERS.slice(1).map((k) => `<td class="num" data-label="${k.toUpperCase()}" title="${r.asOf[k] ? t('reported {date}', { date: esc(r.asOf[k]) }) : ''}">${r.levels[k] ?? '<span class="events-zero">—</span>'}</td>`).join('')}
      <td class="history-date" data-label="${t('Reported')}">${esc(r.lastReported)}</td>
    </tr>`;
  }).join('');
  return `
    <details class="card-collapsible tool-roster-list" data-section-key="admin-member-levels">
      <summary class="card-header"><h2>${t('Latest reported levels ({count})', { count: latest.length })}</h2></summary>
      <div class="events-scroll">
        <table class="table-responsive levels-table">
          <colgroup><col class="col-member">${LETTERS.map(() => '<col class="col-lvl">').join('')}<col class="col-date"></colgroup>
          <thead><tr><th>${t('Member')}</th>${letterHeads()}<th>${t('Reported')}</th></tr></thead>
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
    message = { error: true, html: t('Paste the chat lines first.') };
    paint();
    return;
  }
  btn.disabled = true;
  try {
    const res = await apiPost('/member-levels/preview', { text });
    if (res?.error) {
      const s = Array.isArray(res.skipped) && res.skipped.length ? ` ${t("Couldn't read: {lines}", { lines: res.skipped.map((x) => `<code>${esc(x)}</code>`).join(' ') })}` : '';
      message = { error: true, html: `${esc(res.error)}${s}` };
      preview = null;
    } else {
      preview = res;
      picks = new Map(res.rows.map((r, i) => [i, r.memberId ? String(r.memberId) : '']));
      message = null;
    }
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    message = { error: true, html: esc(t('Could not check: {error}', { error: err?.message || err })) };
  }
  paint();
}

async function save(btn) {
  const entries = preview.rows
    .map((r, i) => ({ memberId: Number(picks.get(i) || 0), levels: r.levels, raw: r.raw }))
    .filter((e) => e.memberId > 0);
  if (!entries.length) return;
  btn.disabled = true;
  btn.textContent = t('Saving…');
  try {
    const res = await apiPost('/member-levels/import', { entries });
    if (res?.error) {
      await notify(res.error, t('Could not save'));
      btn.disabled = false;
      return;
    }
    const r = res.result;
    message = {
      error: false,
      html: `${tn(r.saved, '<strong>Saved {n} player</strong> for {date}', '<strong>Saved {n} players</strong> for {date}', { n: r.saved, date: esc(today) })} · ${tn(r.guardsReports, '{n} guards level entered', '{n} guards levels entered', { n: r.guardsReports })}${r.rejected ? ` · ${tn(r.rejected, '{n} skipped', '{n} skipped', { n: r.rejected })}` : ''}.`,
    };
    preview = null;
    text = '';
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    await notify(t('Could not save: {error}', { error: err?.message || err }), t('Could not save'));
    btn.disabled = false;
    return;
  }
  await reload();
}
