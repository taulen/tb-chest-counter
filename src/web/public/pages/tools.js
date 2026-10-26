// Tools page — calculators any member can use. One sub-tab per tool
// (#tools/<key>; a bare #tools opens the first), on the same segmented
// control as Events and Resources.
//
// The Ancient planner is a replica of totalcalculator.org/summons.php with the
// clan's own roster filled in: who the newest might capture saw (or, when that
// is missing or old, who any scan saw this week — never more than 100), each
// counted at their estimated guards level. The arithmetic lives in
// lib/ancient-planner.js; this file is inputs, sliders and tables.
//
// Inputs and results render separately: dragging a slider repaints only the
// results, so the control under the pointer is never replaced mid-drag.

import { api, apiPut } from '../lib/api.js';
import { esc, notify } from '../lib/ui.js';
import { getCurrentUser } from '../lib/state.js';
import { t, tn, tGame } from '../lib/i18n.js';
import {
  TIERS,
  ARTIFACT_LEVEL_COSTS,
  TOME_BONUS_PCT,
  MAX_SUMMONS,
  MIN_TINMAN_LEVEL,
  MAX_TINMAN_LEVEL,
  planAncients,
  formatCompact,
} from '../lib/ancient-planner.js';

const TOOLS = [
  { key: 'ancient', name: t('Ancient planner') },
];

/** Bare #tools → the first tool; an unknown key falls back the same way. */
export async function renderTools(el, toolKey) {
  const tool = TOOLS.find((x) => x.key === toolKey) ?? TOOLS[0];
  el.innerHTML = `${toolTabsHtml(tool.key)}<div class="tools-mount"></div>`;
  const mount = el.querySelector('.tools-mount');
  if (tool.key === 'ancient') await renderAncientPlanner(mount);
}

function toolTabsHtml(activeKey) {
  return `<div class="resources-tabs" role="tablist">${TOOLS.map((tool) => {
    const active = tool.key === activeKey;
    return `<a class="resources-tab ${active ? 'is-active' : ''}" href="#tools/${tool.key}" role="tab" aria-selected="${active}">${esc(tool.name)}</a>`;
  }).join('')}</div>`;
}

// ─── Ancient planner ─────────────────────────────────────────────

const img = (name) => new URL(`../img/ancients/${name}.webp`, import.meta.url).href;

/** Slider + number-box settings. `tomeLevel` is the Tome of Knowledge level
 *  (1–28); the bonus % it carries is what the arithmetic uses. */
const FIELDS = {
  level: { label: t('{tinman} level', { tinman: tGame('Tin Man') }), min: MIN_TINMAN_LEVEL, max: MAX_TINMAN_LEVEL, hint: t('Where the clan stands before the first summon.') },
  tomeLevel: { label: tGame('Tome of Knowledge'), min: 1, max: TOME_BONUS_PCT.length, hint: t('Bought first, with the Figurine. Raises the points needed per kill.') },
  missing: { label: t('No-shows'), min: 0, max: 100, unit: '%', hint: t('Share of the vault pot that never arrives.') },
  trick: { label: t('Vault trick'), min: 0, max: 100, unit: '%', hint: t('Members who place a vault one level above their cap (phone only).') },
  margin: { label: t('Overshoot'), min: 0, max: 100, unit: '%', hint: t('How far members typically beat a target. Each target is divided by 1 + this.') },
};

/** What the page opens on comes from the server: the clan's saved default, or
 *  the built-ins in src/config/ancient-planner-defaults.ts. This copy is only
 *  for when that request fails. Moving a slider is never remembered — the next
 *  visit opens on the clan default again, so nobody's stale tweak can pass for it. */
const FALLBACK_DEFAULTS = {
  source: 'built-in',
  settings: { level: 1, tomeLevel: 26, missing: 5, trick: 0, margin: 15, unknownAs: 'g7', summons: 3 },
  savedAt: null,
  savedBy: null,
};

/** Module state for the mounted planner — rebuilt on every page render. */
let st = null;

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, Math.round(v)));
}

function isAdmin() {
  const role = getCurrentUser()?.role;
  return role === 'admin' || role === 'superadmin';
}

/** Apply a defaults record to the state (settings, unknown handling, summons). */
function applyDefaults(defaults) {
  const { summons, ...settings } = defaults.settings;
  st.settings = { ...settings };
  st.picked = summons;
  st.counts = rosterCounts(st.roster, st.settings.unknownAs);
}

/**
 * Tiers worth showing: T9 always (guards levels can't tell a T9 from a G9, so
 * it is the one tier a leader fills by hand), plus every tier the counts
 * actually hold. Everything with no roster to fill from, or on request.
 *
 * Computed when the counts are (re)built, NOT on every slider move, so a tier
 * dragged down to 0 doesn't vanish from under the pointer.
 */
function computeShownTiers() {
  if (st.showAllTiers || st.roster.members.length === 0) return new Set(TIERS.map((x) => x.key));
  return new Set(TIERS.filter((x) => x.key === 't9' || (st.counts[x.key] || 0) > 0).map((x) => x.key));
}

function rosterCounts(roster, unknownAs) {
  const counts = Object.fromEntries(TIERS.map((t) => [t.key, 0]));
  for (const m of roster.members) {
    const key = m.guardsLevel ? `g${m.guardsLevel}` : unknownAs;
    if (key in counts) counts[key] += 1;
  }
  return counts;
}

async function renderAncientPlanner(mount) {
  let roster;
  try {
    roster = await api('/tools/ancient-roster');
  } catch (err) {
    // Logged out (already redirected) or superseded by another navigation.
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
    // Anything else: the calculator still works with hand-entered counts.
    roster = { source: 'none', members: [], maxMembers: 100, windowDays: 7, maxAgeDays: 2, mightGameDate: null };
  }

  st = {
    roster,
    /** The clan's saved default (or the built-ins) — what Reset returns to. */
    defaults: roster.defaults ?? FALLBACK_DEFAULTS,
    settings: null,
    counts: null,
    /** Summon count being planned. */
    picked: null,
    showAllTiers: false,
    shownTiers: null,
  };
  applyDefaults(st.defaults);
  st.shownTiers = computeShownTiers();

  mount.innerHTML = `
    <div class="ancient-planner">
      <div class="ancient-results" aria-live="polite"></div>
      <div class="ancient-inputs">
        <div class="ancient-roster-slot">${rosterCardHtml()}</div>
        ${settingsCardHtml()}
      </div>
      ${howItWorksHtml()}
    </div>`;

  const root = mount.querySelector('.ancient-planner');
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('click', onClick);
  paintResults(root);
}

// ─── Inputs ──────────────────────────────────────────────────────

function sliderRow({ id, label, min, max, value, readout = '', hint = '', attrs }) {
  return `
    <div class="tool-slider-row">
      <div class="tool-slider-head">
        <label class="tool-slider-label" for="${id}">${esc(label)}</label>
        <span class="tool-slider-readout" data-readout="${esc(attrs.key)}">${readout}</span>
      </div>
      <div class="tool-slider-controls">
        <input type="range" class="tool-slider" id="${id}" min="${min}" max="${max}" step="1" value="${value}" ${attrs.html}>
        <input type="number" class="input tool-num" min="${min}" max="${max}" step="1" value="${value}" inputmode="numeric" aria-label="${esc(label)}" ${attrs.html}>
      </div>
      ${hint ? `<p class="tool-slider-hint">${esc(hint)}</p>` : ''}
    </div>`;
}

function rosterSourceHtml() {
  const r = st.roster;
  const n = r.members.length;
  if (r.source === 'might') {
    return tn(n, 'From the might scan of <strong>{date}</strong> · {n} member.', 'From the might scan of <strong>{date}</strong> · {n} members.', { date: esc(r.mightGameDate) });
  }
  if (r.source === 'recent') {
    const why = r.mightGameDate
      ? tn(r.maxAgeDays, 'The last might scan ({date}) is more than {n} day old', 'The last might scan ({date}) is more than {n} days old', { date: esc(r.mightGameDate) })
      : t('There is no might scan yet');
    return t('{why}, so this is everyone seen in the last {days} · {members} (max {max}).', {
      why,
      days: tn(r.windowDays, '{n} day', '{n} days'),
      members: tn(n, '{n} member', '{n} members'),
      max: r.maxMembers,
    });
  }
  return t('No roster to fill from — no might scan and nobody seen this week. Enter the counts by hand.');
}

function rosterCardHtml() {
  const unknown = st.roster.members.filter((m) => !m.guardsLevel).length;
  const unknownOptions = [['skip', t('Leave them out')], ...TIERS.filter((tier) => tier.key !== 't9').map((tier) => [tier.key, t('Count as {tier}', { tier: tier.label })])]
    .map(([v, l]) => `<option value="${v}" ${st.settings.unknownAs === v ? 'selected' : ''}>${esc(l)}</option>`)
    .join('');

  const hidden = TIERS.filter((x) => !st.shownTiers.has(x.key));
  const rows = TIERS.filter((x) => st.shownTiers.has(x.key)).map((tier) => sliderRow({
    id: `ancient-tier-${tier.key}`,
    label: tier.label,
    min: 0,
    max: st.roster.maxMembers || 100,
    value: st.counts[tier.key],
    attrs: { key: `tier-${tier.key}`, html: `data-tier="${tier.key}"` },
  })).join('');

  return `
    <div class="card">
      <div class="card-header">
        <h2>${t('Members per tier')}</h2>
        <button type="button" class="btn btn-sm" data-tool-action="reload-roster">${t('Count the roster again')}</button>
      </div>
      <div class="card-body-padded">
        <p class="muted-copy">${rosterSourceHtml()}</p>
        ${unknown > 0 ? `
          <div class="tool-inline-field">
            <label for="ancient-unknown">${tn(unknown, '{n} member has no known guards level', '{n} members have no known guards level')}</label>
            <select id="ancient-unknown" class="input tool-select" data-setting="unknownAs">${unknownOptions}</select>
          </div>` : ''}
        <p class="muted-copy tool-tier-note">${t('T9 = maxed on G, S, M and E. Guards levels can\'t tell a T9 from a G9, so move them across by hand.')}</p>
        <div class="tool-slider-grid">${rows}</div>
        ${tierToggleHtml(hidden)}
        <p class="tool-total-line" data-readout="memberTotal">${memberTotalHtml()}</p>
        ${rosterListHtml()}
      </div>
    </div>`;
}

function tierToggleHtml(hidden) {
  if (st.roster.members.length === 0) return '';
  if (st.showAllTiers) {
    return `<p class="tool-tier-toggle"><button type="button" class="btn btn-sm btn-ghost" data-tool-action="toggle-tiers">${t('Show only the clan\'s tiers')}</button></p>`;
  }
  if (!hidden.length) return '';
  return `<p class="tool-tier-toggle muted-copy">${tn(hidden.length, '{tiers} hidden — nobody in the clan is at that level.', '{tiers} hidden — nobody in the clan is at those levels.', { tiers: hidden.map((x) => x.label).join(', ') })}
    <button type="button" class="btn btn-sm btn-ghost" data-tool-action="toggle-tiers">${t('Show all tiers')}</button></p>`;
}

/** Rebuild the roster card — after the shown tiers may have changed. */
function rerenderRoster(root) {
  st.shownTiers = computeShownTiers();
  const slot = root.querySelector('.ancient-roster-slot');
  if (slot) slot.innerHTML = rosterCardHtml();
}

function memberTotalHtml() {
  const total = TIERS.reduce((a, tier) => a + (st.counts[tier.key] || 0), 0);
  const over = total > (st.roster.maxMembers || 100);
  return `${tn(total, '<strong>{n}</strong> member in the plan', '<strong>{n}</strong> members in the plan')}${over ? ` <span class="tool-warn">⚠ ${t('more than a clan can hold ({max})', { max: st.roster.maxMembers || 100 })}</span>` : ''}`;
}

function rosterListHtml() {
  const members = st.roster.members;
  if (members.length === 0) return '';
  const sorted = [...members].sort((a, b) => (b.guardsLevel ?? 0) - (a.guardsLevel ?? 0) || a.name.localeCompare(b.name));
  const items = sorted.map((m) => {
    const lvl = m.guardsLevel ? `G${m.guardsLevel}` : '?';
    const stale = m.guardsStale ? ` <span class="tool-muted" title="${t('No new donation evidence for a while — the level may have risen')}">${t('(old)')}</span>` : '';
    return `<li><span class="tool-roster-level">${lvl}</span> ${esc(m.name)}${stale}</li>`;
  }).join('');
  return `
    <details class="card-collapsible tool-roster-list" data-section-key="tools-ancient-roster">
      <summary class="card-header"><h2>${t('Who was counted')}</h2></summary>
      <ul class="tool-roster-items">${items}</ul>
    </details>`;
}

function settingsCardHtml() {
  const rows = Object.entries(FIELDS).map(([key, f]) => sliderRow({
    id: `ancient-${key}`,
    label: f.label,
    min: f.min,
    max: f.max,
    value: st.settings[key],
    readout: readoutFor(key),
    hint: f.hint,
    attrs: { key, html: `data-setting="${key}"` },
  })).join('');
  return `
    <div class="card">
      <div class="card-header">
        <h2>${t('Settings')}</h2>
        <div class="tool-default-actions">
          <button type="button" class="btn btn-sm" data-tool-action="reset-defaults">${t('Reset to clan default')}</button>
          ${isAdmin() ? `<button type="button" class="btn btn-sm btn-primary" data-tool-action="save-defaults">${t('Save as clan default')}</button>` : ''}
        </div>
      </div>
      <div class="card-body-padded">
        <p class="tool-default-status" data-readout="defaultsStatus" role="status">${defaultsStatusHtml()}</p>
        <div class="tool-slider-grid tool-slider-grid-wide">${rows}</div>
      </div>
    </div>`;
}

function readoutFor(key) {
  const v = st.settings[key];
  if (key === 'tomeLevel') {
    return t('Level {level} · <strong>+{pct}%</strong> · {cost} vault pts', { level: v, pct: TOME_BONUS_PCT[v - 1], cost: formatCompact(ARTIFACT_LEVEL_COSTS[v - 1]) });
  }
  if (key === 'level') return `<strong>${v}</strong>`;
  return `<strong>${v}%</strong>`;
}

// ─── Events ──────────────────────────────────────────────────────

function onInput(e) {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;
  const raw = t.value.trim();
  if (raw === '') return; // mid-typing; `change` settles it
  const value = Number(raw);
  if (!Number.isFinite(value)) return;

  if (t.dataset.tier) {
    const max = st.roster.maxMembers || 100;
    st.counts[t.dataset.tier] = clamp(value, 0, max);
    syncPair(t, `[data-tier="${t.dataset.tier}"]`, st.counts[t.dataset.tier]);
    setReadout('memberTotal', memberTotalHtml());
  } else if (t.dataset.setting && FIELDS[t.dataset.setting]) {
    const key = t.dataset.setting;
    st.settings[key] = clamp(value, FIELDS[key].min, FIELDS[key].max);
    syncPair(t, `[data-setting="${key}"]`, st.settings[key]);
    setReadout(key, readoutFor(key));
  } else {
    return;
  }
  paintResults(t.closest('.ancient-planner'));
}

/** A number box left empty or out of range snaps back to the stored value. */
function onChange(e) {
  const t = e.target;
  if (t instanceof HTMLSelectElement && t.dataset.setting === 'unknownAs') {
    st.settings.unknownAs = t.value;
    recountRoster(t.closest('.ancient-planner'));
    return;
  }
  if (!(t instanceof HTMLInputElement) || t.type !== 'number') return;
  const stored = t.dataset.tier ? st.counts[t.dataset.tier] : st.settings[t.dataset.setting];
  if (stored !== undefined) t.value = String(stored);
}

function onClick(e) {
  const action = e.target.closest('[data-tool-action]');
  if (action?.dataset.toolAction === 'reload-roster') {
    recountRoster(action.closest('.ancient-planner'));
    return;
  }
  if (action?.dataset.toolAction === 'toggle-tiers') {
    st.showAllTiers = !st.showAllTiers;
    const root = action.closest('.ancient-planner');
    rerenderRoster(root);
    paintResults(root);
    return;
  }
  if (action?.dataset.toolAction === 'reset-defaults') {
    resetToDefaults(action.closest('.ancient-planner'));
    return;
  }
  if (action?.dataset.toolAction === 'save-defaults') {
    saveDefaults(action);
    return;
  }
  const row = e.target.closest('[data-summons]');
  if (row) {
    st.picked = Number(row.dataset.summons);
    paintResults(row.closest('.ancient-planner'));
  }
}

function recountRoster(root) {
  st.counts = rosterCounts(st.roster, st.settings.unknownAs);
  rerenderRoster(root);
  paintResults(root);
}

function syncPair(source, selector, value) {
  const root = source.closest('.tool-slider-row');
  for (const input of root.querySelectorAll(selector)) {
    if (input !== source) input.value = String(value);
  }
  if (source.type === 'range') source.value = String(value);
}

function setReadout(key, html) {
  const el = document.querySelector(`.ancient-planner [data-readout="${key}"]`);
  if (el) el.innerHTML = html;
}

// ─── Results ─────────────────────────────────────────────────────

function currentPlan() {
  return planAncients({
    counts: st.counts,
    bonusPct: TOME_BONUS_PCT[st.settings.tomeLevel - 1],
    missingPct: st.settings.missing,
    trickPct: st.settings.trick,
    marginPct: st.settings.margin,
    level: st.settings.level,
  });
}

/** The summon count being planned — the clan default until a row is picked. */
function selectedSummons() {
  return clamp(st.picked || 1, 1, MAX_SUMMONS);
}

function paintResults(root) {
  const plan = currentPlan();
  const sel = selectedSummons();
  const opt = plan.options[sel - 1];
  root.querySelector('.ancient-results').innerHTML = `
    ${heroHtml(plan, opt)}
    <div class="ancient-tables">
      ${optionsCardHtml(plan, sel)}
      ${perMemberCardHtml(plan, opt)}
    </div>`;
  setReadout('defaultsStatus', defaultsStatusHtml());
}

// ─── Clan defaults ────────────────────────────────────────────────

/** The settings as they would be saved: sliders, unknown handling, summons. */
function currentDefaultSettings() {
  return { ...st.settings, summons: st.picked };
}

function differsFromDefaults() {
  const now = currentDefaultSettings();
  return Object.entries(st.defaults.settings).some(([k, v]) => now[k] !== v);
}

function defaultsStatusHtml() {
  const d = st.defaults;
  let base;
  if (d.source === 'clan') {
    const name = esc(d.savedBy || t('an admin'));
    base = d.savedAt
      ? t('Clan default saved by <strong>{name}</strong> on {date}.', { name, date: esc(String(d.savedAt).slice(0, 10)) })
      : t('Clan default saved by <strong>{name}</strong>.', { name });
  } else {
    base = isAdmin() ? t('Built-in defaults — save your own for the clan.') : t("Built-in defaults — an admin can save the clan's own.");
  }
  if (!differsFromDefaults()) return base;
  const tag = isAdmin() ? t('Changed — not saved') : t('Changed from the clan default');
  return `<span class="tool-changed">● ${tag}</span> ${base}`;
}

function resetToDefaults(root) {
  applyDefaults(st.defaults);
  for (const key of Object.keys(FIELDS)) {
    for (const input of root.querySelectorAll(`[data-setting="${key}"]`)) input.value = String(st.settings[key]);
    setReadout(key, readoutFor(key));
  }
  const unknown = root.querySelector('[data-setting="unknownAs"]');
  if (unknown) unknown.value = st.settings.unknownAs;
  recountRoster(root);
}

async function saveDefaults(button) {
  button.disabled = true;
  const label = button.textContent;
  button.textContent = t('Saving…');
  try {
    const res = await apiPut('/tools/ancient-defaults', { settings: currentDefaultSettings() });
    if (res?.error) {
      await notify(res.error, t('Could not save'));
      return;
    }
    st.defaults = res.defaults;
    setReadout('defaultsStatus', defaultsStatusHtml());
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    await notify(t('Could not save: {error}', { error: err?.message || err }), t('Could not save'));
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

const fmtInt = (n) => Math.round(n).toLocaleString();
const summonsText = (n) => tn(n, '{n} summon', '{n} summons', { n });
const killsText = (n) => tn(n, '{n} kill', '{n} kills', { n });

/** Intrinsic sizes of the cut-outs, so the box is right before the image loads. */
const MEDALLION_SIZE = { tome: [210, 228], figurine: [210, 247], clock: [211, 230] };

function medallionHtml(name, title, level, caption) {
  const [w, h] = MEDALLION_SIZE[name];
  return `
    <figure class="ancient-artifact ancient-artifact-${name}">
      <div class="ancient-medallion">
        <img src="${img(name)}" alt="" width="${w}" height="${h}" decoding="async">
        <span class="ancient-badge" aria-hidden="true">${level ?? '—'}</span>
      </div>
      <figcaption>
        <span class="ancient-artifact-name">${esc(title)}</span>
        <span class="ancient-artifact-value">${caption}</span>
        <span class="visually-hidden">, ${t('level {level}', { level: level ?? t('not affordable') })}</span>
      </figcaption>
    </figure>`;
}

function heroHtml(plan, opt) {
  const ok = opt.attainable;
  const tomePct = TOME_BONUS_PCT[plan.tomeLevel - 1];
  const verdict = ok
    ? `<span class="ancient-verdict-tag is-ok">✓ ${t('Affordable')}</span>
       <div class="ancient-verdict-title">${t('{summons} × {minutes} min', { summons: summonsText(opt.summons), minutes: opt.minutes })}</div>
       <div class="ancient-verdict-sub">${tn(Math.round(opt.leftover), '{n} vault point left over after the Clock', '{n} vault points left over after the Clock', { n: fmtInt(opt.leftover) })}</div>`
    : `<span class="ancient-verdict-tag is-short">✕ ${t('Not affordable')}</span>
       <div class="ancient-verdict-title">${summonsText(opt.summons)}</div>
       <div class="ancient-verdict-sub">${tn(Math.round(opt.short), '{n} vault point short of the Figurine and Tome alone', '{n} vault points short of the Figurine and Tome alone', { n: fmtInt(opt.short) })}</div>`;

  return `
    <div class="card ancient-hero ${ok ? 'is-ok' : 'is-short'}">
      <div class="ancient-hero-body">
        <div class="ancient-hero-main">
          <div class="ancient-verdict">${verdict}</div>
          <div class="ancient-artifacts">
            ${medallionHtml('tome', tGame('Tome of Knowledge'), plan.tomeLevel, t('Bonus +{pct}%', { pct: tomePct }))}
            ${medallionHtml('figurine', tGame('Enchanted Figurine'), opt.summons, t('Summons {count}', { count: opt.summons }))}
            ${medallionHtml('clock', tGame('Mysterious Clock'), opt.clockLevel, ok ? t('Time {minutes} min', { minutes: opt.minutes }) : t('Time —'))}
          </div>
          <div class="stats-grid ancient-stats">
            <div class="stat-card"><div class="label">${t('Vault pot')}</div><div class="value">${formatCompact(plan.pot)}</div><div class="sub">${tn(plan.pot, '{n} point', '{n} points', { n: fmtInt(plan.pot) })}</div></div>
            <div class="stat-card stat-card-lead"><div class="label">${t('Clan target')}</div><div class="value">${formatCompact(opt.requirement)}</div><div class="sub">${t('{kills} incl. +{pct}% Tome', { kills: killsText(opt.summons), pct: tomePct })}</div></div>
            <div class="stat-card"><div class="label">${esc(tGame('Tin Man'))}</div><div class="value">${plan.level} → ${opt.endLevel}</div><div class="sub">${t('level before → after')}</div></div>
          </div>
        </div>
        <img class="ancient-tinman" src="${img('tinman')}" alt="" width="425" height="405" decoding="async">
      </div>
    </div>`;
}

function optionsCardHtml(plan, sel) {
  const tinManAfter = t('{tinman} after', { tinman: tGame('Tin Man') });
  const rows = plan.options.map((o) => {
    const isSel = o.summons === sel;
    const status = o.attainable
      ? `<span class="tool-ok">${t('{points} left', { points: fmtInt(o.leftover) })}</span>`
      : `<span class="tool-short">✕ ${t('{points} short', { points: formatCompact(o.short) })}</span>`;
    return `
      <tr class="ancient-option ${isSel ? 'is-selected' : ''} ${o.attainable ? '' : 'is-unaffordable'}" data-summons="${o.summons}">
        <td data-role="lead"><button type="button" class="ancient-pick" aria-pressed="${isSel}" aria-label="${t('Plan {summons}', { summons: summonsText(o.summons) })}">${o.summons}</button></td>
        <td data-role="primary"><span class="mrow-name">${o.attainable ? t('{minutes} min each', { minutes: o.minutes }) : t('Not affordable')}</span><span class="mrow-sub">${o.attainable ? t('{points} vault pts left', { points: fmtInt(o.leftover) }) : t('{points} vault pts short', { points: fmtInt(o.short) })}</span></td>
        <td data-role="hidden" class="num">${status}</td>
        <td data-role="metric" data-label="${t('Clan target')}" class="num" title="${fmtInt(o.requirement)}">${formatCompact(o.requirement)}</td>
        <td class="num" data-label="${esc(tinManAfter)}">${o.endLevel}</td>
      </tr>`;
  }).join('');
  return `
    <div class="card">
      <div class="card-header"><h2>${t('Summon options')}</h2><span class="card-header-hint">${t('Pick a row to plan it')}</span></div>
      <div class="card-body">
        <table class="table-responsive ancient-options-table">
          <colgroup><col class="col-summons"><col class="col-time"><col class="col-vault"><col class="col-target"><col class="col-after"></colgroup>
          <thead><tr><th>${t('Summons')}</th><th>${t('Time')}</th><th class="num">${t('Vault points')}</th><th class="num">${t('Clan target')}</th><th class="num">${esc(tinManAfter)}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function perMemberCardHtml(plan, opt) {
  const tierTotal = (tier) => (opt.perMember[tier.key] ?? 0) * (st.counts[tier.key] || 0);
  const handedOut = TIERS.reduce((a, tier) => a + tierTotal(tier), 0);
  const rows = TIERS.filter((x) => st.shownTiers.has(x.key)).map((tier) => {
    const n = st.counts[tier.key] || 0;
    const each = opt.perMember[tier.key];
    const total = tierTotal(tier);
    const share = handedOut > 0 ? `${((total / handedOut) * 100).toFixed(1)}%` : '—';
    return `
      <tr class="${n === 0 ? 'is-empty-tier' : ''}">
        <td data-role="lead"><span class="tool-tier-badge">${tier.label}</span></td>
        <td data-role="primary"><span class="mrow-name">${tn(n, '{n} member', '{n} members', { n })}</span><span class="mrow-sub">${t('{share} of the target', { share })}</span></td>
        <td data-role="metric" data-label="${t('Points each')}" class="num" title="${each === null ? '' : fmtInt(each)}"><strong>${formatCompact(each)}</strong></td>
        <td class="num" data-label="${t('Tier total')}">${n ? formatCompact(total) : '—'}</td>
        <td data-role="hidden" class="num">${share}</td>
      </tr>`;
  }).join('');
  const empty = plan.weightTotal === 0
    ? `<p class="card-note muted-copy">${t('Add members to a tier to split the target.')}</p>`
    : `<p class="card-note muted-copy">${t('For {kills}, already lowered for a {pct}% overshoot.', { kills: killsText(opt.summons), pct: st.settings.margin })}</p>`;
  return `
    <div class="card">
      <div class="card-header"><h2>${t('Points per member')}</h2><span class="card-header-hint">${esc(tGame('Rise of the Ancients'))}</span></div>
      ${empty}
      <div class="card-body">
        <table class="table-responsive ancient-tier-table">
          <colgroup><col class="col-tier"><col class="col-members"><col class="col-each"><col class="col-total"><col class="col-share"></colgroup>
          <thead><tr><th>${t('Tier')}</th><th>${t('Members')}</th><th class="num">${t('Points each')}</th><th class="num">${t('Tier total')}</th><th class="num">${t('Share')}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function howItWorksHtml() {
  return `
    <details class="card card-collapsible" data-section-key="tools-ancient-howto">
      <summary class="card-header"><h2>${t('How this works')}</h2></summary>
      <div class="card-body-padded tool-howto">
        <ul>
          <li>${t('<strong>Vault pot.</strong> Each member raids one vault in {event}. Their guards level caps its size: G1 1,000 … G9 8,200 vault points.', { event: esc(tGame('Ancients\' Treasure')) })}</li>
          <li>${t('<strong>What it buys.</strong> The Figurine (summons) and the Tome you pick come first. The Clock gets the rest, up to 120 minutes.')}</li>
          <li>${t('<strong>The target.</strong> Every summon is planned as a kill, one {tinman} level higher each time. The clan must score their combined HP plus the Tome bonus.', { tinman: esc(tGame('Tin Man')) })}</li>
          <li>${t('<strong>The split.</strong> Each tier gets a fixed weight (G9 = 2.25× G8, and T9 = 1.75× G9). The ratios are a planning convention, not game data.')}</li>
          <li>${t('<strong>Summons 7 and 8</strong> are only offered while a seasonal kingdom runs.')}</li>
        </ul>
        <p class="muted-copy">${t('Matches {link}, rebuilt from its outputs.', { link: `<a href="https://totalcalculator.org/summons.php" target="_blank" rel="noopener">${t('totalcalculator.org\'s Ancient planner')}</a>` })}</p>
      </div>
    </details>`;
}
