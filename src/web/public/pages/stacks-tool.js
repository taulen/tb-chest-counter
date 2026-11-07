// Tools → Stacks: size every stack of a march from one base stack, so the
// enemy wears down the cheap stacks first and reaches the valuable ones last.
//
// The sizing rule is lib/stack-calc.js — a port of Kaiculator, checked count
// for count against it (docs/stack-calculator.md). This file is the troop list,
// the size and limit inputs, the result in loss order, and the saved armies,
// kept per ACCOUNT on the server (/api/tools/stack-presets). Troop levels are
// the same per-account levels the Citadel tab uses.

import { api, apiPut, apiDelete } from '../lib/api.js';
import { esc, notify, confirmDialog, promptDialog, choiceDialog, contentModal, copyTextToClipboard } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { formatCompact } from '../lib/ancient-planner.js';
import { TROOP_GROUPS, TROOPS, troopById, troopTier, troopUnlocked, troopInWindow, bonusFamily, marchList } from '../lib/citadel-sim.js';
import {
  planStacks,
  fitBaseToLeadership,
  STACK_TROOPS,
  TEMPLE_REVIVAL_REDUCTION,
  DEFAULT_TIER_MULTIPLIER,
  DEFAULT_SIEGE_MULTIPLIER,
  MONSTER_MODES,
} from '../lib/stack-calc.js';
import { openTroopPicker, closeTroopPicker } from '../lib/troop-picker.js';
import { parseBonus, nextFreeName, LEVEL_KINDS, levelTag } from './citadel-tool.js';

const DRAFT_KEY = 'tbcc.stacks.draft.v1';

const icon = (troopId) => new URL(`../img/troops/${troopId}.webp`, import.meta.url).href;
const troopName = (id) => tGame(troopById(id)?.name ?? id);
const levelKindLabel = (k) => LEVEL_KINDS.find(([x]) => x === k)?.[1] ?? k;

const GROUP_LABELS = {
  guardsmen: t('Guardsmen'),
  specialists: t('Specialists'),
  monsters: t('Monsters'),
  mercenaries: t('Mercenaries'),
  siege: t('Siege engines'),
};
const PICKER_GROUPS = TROOP_GROUPS.map((g) => [g, GROUP_LABELS[g]]);
const KIND_LABELS = {
  troop: null, // the group label (Guardsmen / Specialists) says more
  monster: t('Monster'),
  mercenary: t('Mercenary'),
  siege: t('Siege decoy'),
};

const DEFAULTS = {
  baseMode: 'manual',
  baseCount: 100,
  tierMultiplier: DEFAULT_TIER_MULTIPLIER,
  siegeMultiplier: DEFAULT_SIEGE_MULTIPLIER,
  leadership: 0,
  authority: 0,
  dominance: 0,
  monsterMode: 'reference',
  templeLevel: 1,
  specialistsFirst: true,
  epicHunterLast: false,
};
/** The march screen's three capacities and the Temple are the game's words:
 *  tGame() shows the official name, or English. */
const STAT = { leadership: tGame('Leadership'), authority: tGame('Authority'), dominance: tGame('Dominance') };
const TEMPLE = tGame('Temple');
const LIMITS = Object.entries(STAT);
const MAX_COUNT = 1_000_000_000;

/** Module state — rebuilt on every page render. */
let ss = null;

/** Rows always follow the troop list's order: guardsmen by tier, then specialists, monsters, mercenaries, siege. */
const POS = new Map(TROOPS.map((x, i) => [x.id, i]));
const sortRows = (rows) => [...rows].sort((a, b) => (POS.get(a.troopId) ?? 999) - (POS.get(b.troopId) ?? 999));

const num = (v) => (Number.isFinite(v) ? v : null);

/** A whole number as typed: "250 000", "250,000" and "250.000" all read 250000. */
function parseCount(raw) {
  const digits = String(raw ?? '').replace(/[\s  ,.'’_]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

function cleanSettings(s) {
  const out = { ...DEFAULTS };
  if (!s || typeof s !== 'object') return out;
  if (s.baseMode === 'fill' || s.baseMode === 'manual') out.baseMode = s.baseMode;
  if (Number.isInteger(s.baseCount) && s.baseCount >= 1) out.baseCount = Math.min(s.baseCount, 10_000_000);
  if (Number.isFinite(s.tierMultiplier) && s.tierMultiplier >= 1 && s.tierMultiplier <= 5) out.tierMultiplier = s.tierMultiplier;
  if (Number.isFinite(s.siegeMultiplier) && s.siegeMultiplier >= 0 && s.siegeMultiplier <= 3) out.siegeMultiplier = s.siegeMultiplier;
  for (const [k] of LIMITS) if (Number.isInteger(s[k]) && s[k] >= 0) out[k] = Math.min(s[k], MAX_COUNT);
  if (MONSTER_MODES.includes(s.monsterMode)) out.monsterMode = s.monsterMode;
  if (Number.isInteger(s.templeLevel) && s.templeLevel >= 1 && s.templeLevel <= TEMPLE_REVIVAL_REDUCTION.length) out.templeLevel = s.templeLevel;
  if (typeof s.specialistsFirst === 'boolean') out.specialistsFirst = s.specialistsFirst;
  if (typeof s.epicHunterLast === 'boolean') out.epicHunterLast = s.epicHunterLast;
  return out;
}

function cleanRows(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!STACK_TROOPS.some((x) => x.id === r?.troopId) || seen.has(r.troopId)) continue;
    seen.add(r.troopId);
    out.push({ troopId: r.troopId, healthPct: num(r.healthPct) || null });
  }
  return sortRows(out);
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return { rows: cleanRows(d?.rows), settings: cleanSettings(d?.settings), decimalComma: d?.decimalComma === true };
  } catch {
    return null;
  }
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ rows: ss.rows, settings: ss.settings, decimalComma: ss.decimalComma }));
  } catch { /* private mode — the draft just isn't kept */ }
}

export async function renderStacksTool(mount) {
  closeTroopPicker();
  const draft = loadDraft();
  ss = {
    rows: draft?.rows ?? [],
    settings: draft?.settings ?? { ...DEFAULTS },
    decimalComma: draft?.decimalComma ?? false,
    presets: [],
    presetsError: false,
    selectedPreset: '',
    /** Unlocked troop tiers, per account (shared with Citadel); null = any. */
    levels: { g: null, s: null, m: null, e: null },
  };
  mount.innerHTML = `
    <div class="citadel-tool stacks-tool">
      <div class="stacks-army-slot"></div>
      <div class="stacks-size-slot"></div>
      <div class="stacks-results" aria-live="polite"></div>
      ${howItWorksHtml()}
    </div>`;
  const root = mount.querySelector('.stacks-tool');
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  paintAll(root);
  const [presets, levels] = await Promise.allSettled([api('/tools/stack-presets'), api('/tools/citadel-levels')]);
  for (const r of [presets, levels]) {
    const name = r.status === 'rejected' ? r.reason?.name : '';
    if (name === 'UnauthenticatedError' || name === 'AbortError') throw r.reason;
  }
  if (presets.status === 'fulfilled') ss.presets = presets.value?.presets ?? [];
  else ss.presetsError = true;
  if (levels.status === 'fulfilled' && levels.value?.levels) ss.levels = { ...ss.levels, ...levels.value.levels };
  if (root.isConnected) paintAll(root);
}

// ─── The plan ────────────────────────────────────────────────────

function planInput(baseCount) {
  const s = ss.settings;
  return {
    rows: ss.rows,
    baseCount,
    tierMultiplier: s.tierMultiplier,
    siegeMultiplier: s.siegeMultiplier,
    limits: { leadership: s.leadership, authority: s.authority, dominance: s.dominance },
    monsterMode: s.monsterMode,
    templeLevel: s.templeLevel,
    specialistsFirst: s.specialistsFirst,
    epicHunterLast: s.epicHunterLast,
  };
}

/**
 * The base count in use: fitted to the leadership in Fill mode (when there is
 * leadership to fit), otherwise the typed one. Fill writes its result back, so
 * switching to Manual starts from it.
 */
function currentPlan() {
  const s = ss.settings;
  let fitted = false;
  if (s.baseMode === 'fill' && s.leadership > 0) {
    const n = fitBaseToLeadership(planInput(s.baseCount), s.leadership);
    if (n) {
      s.baseCount = n;
      fitted = true;
    }
  }
  return { plan: planStacks(planInput(s.baseCount)), fitted };
}

function paintAll(root) {
  const { plan, fitted } = currentPlan();
  const army = root.querySelector('.stacks-army-slot');
  if (army) army.innerHTML = armyCardHtml(plan);
  const size = root.querySelector('.stacks-size-slot');
  if (size) size.innerHTML = sizeCardHtml(plan, fitted);
  paintResults(root, plan);
}

/** After typing: refresh the worked-out numbers without replacing the box in use. */
function refresh(root) {
  const { plan, fitted } = currentPlan();
  const focused = document.activeElement;
  const counts = plan.ok ? new Map(plan.squads.map((s) => [s.troopId, s.count])) : new Map();
  ss.rows.forEach((r, i) => {
    const count = root.querySelector(`[data-row="${i}"][data-field="count"]`);
    if (count) count.value = counts.has(r.troopId) ? counts.get(r.troopId).toLocaleString() : '';
    const health = root.querySelector(`[data-row="${i}"][data-field="healthPct"]`);
    if (health && health !== focused) health.value = fmtBonus(r.healthPct);
    const note = root.querySelector(`[data-note-row="${i}"]`);
    if (note) note.innerHTML = troopNote(i, plan);
  });
  const base = root.querySelector('[data-setting="baseCount"]');
  if (base && base !== focused) base.value = ss.settings.baseCount.toLocaleString();
  const baseNote = root.querySelector('.stacks-base-note');
  if (baseNote) baseNote.outerHTML = baseNoteHtml(plan, fitted);
  paintResults(root, plan);
  saveDraft();
}

function fmtBonus(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  const s = String(v);
  return ss?.decimalComma ? s.replace('.', ',') : s;
}
const fmtDecimal = (v) => (ss?.decimalComma ? String(v).replace('.', ',') : String(v));

// ─── 1 · Troops ──────────────────────────────────────────────────

function presetsHtml() {
  const saved = ss.presets.map((p) => `<option value="${p.id}" ${ss.selectedPreset === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  return `
    <div class="citadel-presets">
      <label class="visually-hidden" for="stacks-preset">${t('Load an army')}</label>
      <select id="stacks-preset" class="input citadel-preset-select" data-stk="preset">
        <option value="">${ss.presets.length ? t('Load an army…') : t('No saved armies yet')}</option>
        ${saved}
      </select>
      <button type="button" class="btn btn-sm" data-stk-action="save">${t('Save army')}</button>
      ${ss.selectedPreset ? `<button type="button" class="btn btn-sm btn-ghost" data-stk-action="delete">${t('Delete')}</button>` : ''}
    </div>`;
}

function levelsHtml() {
  const selects = LEVEL_KINDS.map(([k, label]) => {
    const v = ss.levels[k];
    const opts = [`<option value="" ${v === null ? 'selected' : ''}>${esc(t('any'))}</option>`]
      .concat([9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${v === n ? 'selected' : ''}>${n}</option>`)).join('');
    return `<label class="citadel-level-field"><span>${esc(label)}</span>
      <select class="input citadel-level-select" data-stk="level" data-kind="${k}">${opts}</select></label>`;
  }).join('');
  return `<div class="citadel-levels" role="group" aria-label="${esc(t('Your troop levels'))}">
      <span class="citadel-inside-label">${t('Your levels')}</span>${selects}
      <span class="citadel-levels-hint muted-copy">${t('Shared with the Citadel tab. The troop list offers your level and the three below it.')}</span>
    </div>`;
}

function armyCardHtml(plan) {
  const rows = ss.rows.map((r, i) => rowHtml(r, i, plan)).join('');
  return `
    <div class="card citadel-army">
      <div class="card-header">
        <h2 class="citadel-step"><span class="citadel-step-num" aria-hidden="true">1</span>${t('Your troops')}<span class="citadel-step-hint">${t('everything you will send')}</span></h2>
        ${presetsHtml()}
      </div>
      <div class="card-body-padded">
        ${levelsHtml()}
        ${ss.presetsError ? `<p class="citadel-note tool-warn">${t('Your saved armies could not be loaded.')}</p>` : ''}
        <p class="citadel-note stacks-intro">${t('The strongest guardsman or specialist you add is the base stack; every other stack is sized from it. Health bonuses are optional: type them from each troop\'s card for exact counts.')}</p>
        ${ss.rows.length ? `
          <div class="citadel-rows stacks-rows" role="list">
            <div class="citadel-row citadel-row-head" aria-hidden="true">
              <span class="citadel-head-troop">${t('Troop')}</span>
              <span>${t('Count')}<small>${t('worked out')}</small></span>
              <span>${t('Health %')}<small>${t('from the troop card')}</small></span>
              <span></span>
            </div>
            ${rows}
          </div>` : `<p class="citadel-empty muted-copy">${t('Add the troops you will send.')}</p>`}
        <div class="citadel-add">
          <button type="button" class="btn btn-sm citadel-add-btn" data-pick="add" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(t('Add a troop'))}">${t('+ Add a troop…')}</button>
        </div>
      </div>
    </div>`;
}

function rowHtml(r, i, plan) {
  const name = troopName(r.troopId);
  const count = plan.ok ? plan.squads.find((s) => s.troopId === r.troopId)?.count : undefined;
  const siege = troopById(r.troopId)?.siegeEngine;
  const label = (field) => `<span class="visually-hidden">${esc(t('{troop}: {field}', { troop: name, field }))}</span>`;
  const health = siege
    ? `<span class="citadel-field stacks-na" data-label="${esc(t('Health %'))}" title="${esc(t('Siege engines are sized from the biggest stack. Tune them with the siege multiplier.'))}">—</span>`
    : `<label class="citadel-field" data-label="${esc(t('Health %'))}">${label(t('Health %'))}
        <input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" class="input citadel-num"
          data-row="${i}" data-field="healthPct" value="${esc(fmtBonus(r.healthPct))}" placeholder="0"></label>`;
  return `
    <div class="citadel-row ${plan.ok && plan.baseTroopId === r.troopId ? 'is-base' : ''}" role="listitem" data-row="${i}">
      <span class="citadel-troop">
        <button type="button" class="citadel-troop-btn" data-pick="${i}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(t('{troop}: change troop', { troop: name }))}">
          <img class="citadel-icon" src="${icon(r.troopId)}" alt="" width="36" height="36" decoding="async">
          <span class="citadel-troop-text"><span class="citadel-troop-name">${esc(name)}</span><span class="citadel-troop-note" data-note-row="${i}">${troopNote(i, plan)}</span></span>
          <span class="citadel-caret" aria-hidden="true"></span>
        </button>
      </span>
      <label class="citadel-field" data-label="${esc(t('Count'))}">${label(t('Count'))}
        <input type="text" class="input citadel-num is-auto" data-row="${i}" data-field="count" readonly tabindex="-1"
          value="${count === undefined ? '' : count.toLocaleString()}" placeholder="—" title="${esc(t('Worked out from the base stack and your settings.'))}"></label>
      ${health}
      <span class="citadel-row-actions">
        <button type="button" class="citadel-icon-btn is-remove" data-stk-action="remove" data-row="${i}" aria-label="${esc(t('Remove {troop}', { troop: name }))}">✕</button>
      </span>
    </div>`;
}

/** Under the troop name: the base stack, a level it needs, bonuses it shares. */
function troopNote(i, plan) {
  const r = ss.rows[i];
  if (!r) return '';
  const notes = [];
  if (plan.ok && plan.baseTroopId === r.troopId) notes.push(t('base stack'));
  if (plan.ok && !plan.squads.some((s) => s.troopId === r.troopId)) {
    const monster = troopById(r.troopId)?.group === 'monsters';
    notes.push(monster && plan.monsterFit?.cut ? t('left out: over the {dominance} limit', { dominance: STAT.dominance }) : t('none: one unit holds more health than the base stack'));
  }
  if (!troopUnlocked(r.troopId, ss.levels)) {
    const [kind, tier] = troopTier(r.troopId);
    notes.push(t('needs {kind} {n}', { kind: levelKindLabel(kind), n: tier }));
  }
  const linked = familyPeers(i).filter((k) => ss.rows[k].healthPct === r.healthPct && r.healthPct !== null);
  if (linked.length) notes.push(t('bonuses shared with {troops}', { troops: linked.map((k) => troopName(ss.rows[k].troopId)).join(', ') }));
  return esc(notes.join(' · '));
}

/** The health boxes the player typed in themselves this visit. A family link never writes into those. */
const handTyped = new WeakSet();

/** Other rows whose troop reads the same bonuses (BONUS_FAMILIES), by index. */
function familyPeers(i) {
  const fam = bonusFamily(ss.rows[i]?.troopId);
  if (!fam) return [];
  return ss.rows.map((r, k) => k).filter((k) => k !== i && bonusFamily(ss.rows[k].troopId) === fam);
}

/** A family member's health bonus for a troop joining the list, or null. */
function familyHealth(troopId, skip = null) {
  const fam = bonusFamily(troopId);
  if (!fam) return null;
  return ss.rows.find((r) => r !== skip && bonusFamily(r.troopId) === fam && r.healthPct !== null)?.healthPct ?? null;
}

// ─── 2 · Size and limits ─────────────────────────────────────────

function textBox({ key, value, label, cls = '', readonly = false, inputmode = 'numeric', placeholder = '' }) {
  return `<input type="text" inputmode="${inputmode}" autocomplete="off" spellcheck="false" class="input stacks-input ${cls}" id="stacks-${key}"
    data-setting="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="${esc(label)}" ${readonly ? 'readonly tabindex="-1"' : ''}>`;
}

function baseNoteHtml(plan, fitted) {
  const s = ss.settings;
  let text = '';
  if (s.baseMode === 'fill' && !(s.leadership > 0)) text = `<span class="tool-warn">${t('Enter your {leadership} to fill it.', { leadership: esc(STAT.leadership) })}</span>`;
  else if (fitted && plan.ok) {
    text = t('The biggest {troop} stack that fits {n} {leadership}.', { troop: `<strong>${esc(troopName(plan.baseTroopId))}</strong>`, n: s.leadership.toLocaleString(), leadership: esc(STAT.leadership) });
  } else if (plan.ok && plan.baseCount !== plan.baseWanted) {
    text = t('Health bonuses and the specialist margin make it {n}.', { n: `<strong>${plan.baseCount.toLocaleString()}</strong>` });
  } else if (plan.ok) {
    text = t('The {troop} stack — the last trained troops to fall.', { troop: `<strong>${esc(troopName(plan.baseTroopId))}</strong>` });
  }
  return `<p class="stacks-base-note muted-copy">${text}</p>`;
}

function sizeCardHtml(plan, fitted) {
  const s = ss.settings;
  const seg = (mode, label, title) => `<button type="button" class="citadel-seg ${s.baseMode === mode ? 'is-active' : ''}" data-stk-action="base-mode" data-mode="${mode}" aria-pressed="${s.baseMode === mode}" title="${esc(title)}">${label}</button>`;
  const fill = s.baseMode === 'fill' && s.leadership > 0;
  const limits = LIMITS.map(([k, label]) => `
    <label class="stacks-field" for="stacks-${k}"><span class="stacks-field-label">${esc(label)}</span>
      ${textBox({ key: k, value: s[k] ? s[k].toLocaleString() : '', label, placeholder: t('no limit') })}</label>`).join('');
  const temple = TEMPLE_REVIVAL_REDUCTION.map((x, i) => `<option value="${i + 1}" ${s.templeLevel === i + 1 ? 'selected' : ''}>${t('Level {level} · ÷{x}', { level: i + 1, x: x.toFixed(2) })}</option>`).join('');
  const modes = [
    ['reference', t('Keep the counts (warn only)')],
    ['scaled', t('Scale every monster stack down')],
    ['whole-stacks', t('Leave out whole monster stacks')],
  ].map(([v, l]) => `<option value="${v}" ${s.monsterMode === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
  return `
    <div class="card stacks-size">
      <div class="card-header">
        <h2 class="citadel-step"><span class="citadel-step-num" aria-hidden="true">2</span>${t('Size and limits')}</h2>
      </div>
      <div class="card-body-padded">
        <div class="stacks-size-grid">
          <div class="stacks-base">
            <div class="stacks-field">
              <span class="stacks-field-label" id="stacks-base-label">${t('Base stack')}</span>
              <div class="stacks-base-row">
                ${textBox({ key: 'baseCount', value: s.baseCount.toLocaleString(), label: t('Base stack'), cls: fill ? 'is-auto' : '', readonly: fill })}
                <div class="citadel-count-mode" role="group" aria-labelledby="stacks-base-label">
                  ${seg('fill', t('Fill my {leadership}', { leadership: esc(STAT.leadership) }), t('The biggest base stack your {leadership} can carry, worked out again as you change anything', { leadership: STAT.leadership }))}
                  ${seg('manual', t('Manual'), t('You type the base stack yourself'))}
                </div>
              </div>
              ${baseNoteHtml(plan, fitted)}
            </div>
          </div>
          <div class="stacks-limits">
            <span class="stacks-field-label">${t('Your limits')}<small>${t('from the march screen; they change with your captain and dragon')}</small></span>
            <div class="stacks-limit-grid">${limits}</div>
          </div>
          <label class="stacks-field stacks-temple" for="stacks-temple"><span class="stacks-field-label">${esc(TEMPLE)}<small>${t('divides the revival cost')}</small></span>
            <select id="stacks-temple" class="input" data-setting="templeLevel">${temple}</select></label>
        </div>
        <details class="card-collapsible stacks-advanced" data-section-key="tools-stacks-advanced">
          <summary class="card-header"><h2>${t('Fine-tuning')}</h2></summary>
          <div class="stacks-advanced-body">
            <label class="stacks-field" for="stacks-tierMultiplier"><span class="stacks-field-label">${t('Tier multiplier')}<small>${t('how much bigger each lower tier is (1.9; older calculators used 2)')}</small></span>
              ${textBox({ key: 'tierMultiplier', value: fmtDecimal(s.tierMultiplier), label: t('Tier multiplier'), inputmode: 'decimal' })}</label>
            <label class="stacks-field" for="stacks-siegeMultiplier"><span class="stacks-field-label">${t('Siege multiplier')}<small>${t('raise it when the siege engines don\'t take the first hit, lower it when they last too long (0–3)')}</small></span>
              ${textBox({ key: 'siegeMultiplier', value: fmtDecimal(s.siegeMultiplier), label: t('Siege multiplier'), inputmode: 'decimal' })}</label>
            <label class="stacks-field" for="stacks-monsterMode"><span class="stacks-field-label">${t('Over the {dominance} limit', { dominance: esc(STAT.dominance) })}</span>
              <select id="stacks-monsterMode" class="input" data-setting="monsterMode">${modes}</select></label>
            <label class="stacks-check"><input type="checkbox" data-setting="specialistsFirst" ${s.specialistsFirst ? 'checked' : ''}>
              <span>${t('Specialists fall before the guardsmen of their tier')}</span></label>
            <label class="stacks-check"><input type="checkbox" data-setting="epicHunterLast" ${s.epicHunterLast ? 'checked' : ''}>
              <span>${t('Count the {hunter}\'s epic bonus: its stack is kept smallest and falls last', { hunter: esc(tGame('Epic Monster Hunter')) })}</span></label>
            <p class="muted-copy stacks-reset"><button type="button" class="btn btn-sm btn-ghost" data-stk-action="reset-advanced">${t('Back to the defaults')}</button></p>
          </div>
        </details>
      </div>
    </div>`;
}

// ─── 3 · Result ──────────────────────────────────────────────────

const fmt = (n) => Math.round(n).toLocaleString();

function statCard(label, value, sub, cls = '') {
  return `<div class="stat-card ${cls}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

function limitCard(key, label, plan) {
  const used = plan.used[key];
  const limit = plan.limits[key];
  if (!used && !limit) return '';
  let sub = limit ? t('of {limit}', { limit: fmt(limit) }) : t('no limit entered');
  if (plan.over[key]) sub = `<span class="tool-short">⚠ ${t('{n} over the limit', { n: fmt(used - limit) })}</span>`;
  return statCard(label, fmt(used), sub, plan.over[key] ? 'is-over' : '');
}

function monsterFitHtml(plan) {
  const f = plan.monsterFit;
  if (!f) return '';
  const limit = `${fmt(plan.limits.dominance)} ${STAT.dominance}`;
  let text;
  if (!f.cut) text = t('The monsters fit within {limit}.', { limit });
  else if (f.mode === 'whole-stacks') text = tn(f.dropped, '{n} monster stack left out to stay within {limit}.', '{n} monster stacks left out to stay within {limit}.', { n: f.dropped, limit });
  else text = t('Every monster stack scaled down to fit within {limit} ({pct}% of their full size).', { limit, pct: f.before ? Math.floor((f.after / f.before) * 1000) / 10 : 0 });
  return `<p class="citadel-note stacks-fit-note">${esc(text)}</p>`;
}

function kindText(s) {
  const def = troopById(s.troopId);
  return KIND_LABELS[s.kind] ?? GROUP_LABELS[def?.group] ?? '';
}

function paintResults(root, plan) {
  const el = root.querySelector('.stacks-results');
  if (!el) return;
  const title = `<h2 class="citadel-step citadel-result-title"><span class="citadel-step-num" aria-hidden="true">3</span>${t('Stacks')}<span class="citadel-step-hint">${t('in the order they fall')}</span></h2>`;
  if (!plan.ok) {
    el.innerHTML = plan.reason === 'empty' ? '' : `${title}<div class="card citadel-waiting"><p>${t('Add at least one guardsman or specialist: every stack is sized from the strongest of them.')}</p></div>`;
    return;
  }
  const s = ss.settings;
  const rows = plan.squads.map((q) => {
    const order = q.lossFrom === q.lossTo ? String(q.lossFrom) : `${q.lossFrom}–${q.lossTo}`;
    const isBase = q.troopId === plan.baseTroopId;
    // "12,345 Leadership": a number and the game's word, no sentence to translate.
    const costKey = q.leadership ? 'leadership' : q.authority ? 'authority' : 'dominance';
    const cost = `${fmt(q[costKey])} ${STAT[costKey]}`;
    const gap = q.gap
      ? `<span title="${esc(t('{health} less health than the stack before it — about {units} units', { health: fmt(q.gap.health), units: q.gap.units === null ? '—' : fmt(q.gap.units) }))}">−${q.gap.pct < 0.1 && q.gap.pct > 0 ? '<0.1' : (Math.round(q.gap.pct * 10) / 10).toLocaleString()}%</span>`
      : '<span class="tool-muted">—</span>';
    const bonus = q.healthPct ? t('+{pct}% health', { pct: (Math.round(q.healthPct * 100) / 100).toLocaleString() }) : '';
    return `
      <tr class="${isBase ? 'is-base' : ''} stacks-kind-${q.kind}">
        <td data-role="lead" class="stacks-order"><span class="stacks-order-badge" title="${esc(q.lossFrom === q.lossTo ? t('Falls as stack {n}', { n: q.lossFrom }) : t('Falls together as stacks {from} to {to}', { from: q.lossFrom, to: q.lossTo }))}">${order}</span></td>
        <td data-role="primary"><span class="stacks-troop"><img class="citadel-icon-sm" src="${icon(q.troopId)}" alt="" width="22" height="22"><span class="mrow-name">${esc(troopName(q.troopId))}</span></span><span class="mrow-sub">${esc(kindText(q))}${isBase ? ` · <strong>${t('base stack')}</strong>` : ''}</span></td>
        <td data-role="metric" class="num stacks-count" data-label="${esc(t('Count'))}">${fmt(q.count)}</td>
        <td class="num" data-label="${esc(t('Stack health'))}"><span title="${esc(fmt(q.stackHealth))}">${formatCompact(q.stackHealth)}</span>${bonus ? `<span class="stacks-cell-sub">${esc(bonus)}</span>` : ''}</td>
        <td class="num" data-label="${esc(t('Less than the one before'))}">${gap}</td>
        <td class="num" data-label="${esc(t('Costs'))}">${esc(cost)}</td>
      </tr>`;
  }).join('');
  el.innerHTML = `<div class="citadel-result-head">${title}
      <button type="button" class="btn btn-primary citadel-march-btn" data-stk-action="march">
        <svg class="citadel-march-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M6 4h8M6 8h8M6 12h8"/><circle cx="2.5" cy="4" r="0.9" fill="currentColor" stroke="none"/><circle cx="2.5" cy="8" r="0.9" fill="currentColor" stroke="none"/><circle cx="2.5" cy="12" r="0.9" fill="currentColor" stroke="none"/>
        </svg>${t('March list')}</button>
    </div>
    <div class="stats-grid stacks-stats">
      ${LIMITS.map(([k, label]) => limitCard(k, label, plan)).join('')}
      ${statCard(t('Revival cost'), formatCompact(plan.revivalGold), esc(t('gold · {temple} {level}', { temple: TEMPLE, level: s.templeLevel })))}
    </div>
    ${monsterFitHtml(plan)}
    <div class="card">
      <div class="card-header"><h2>${t('Loss order')}</h2><span class="card-header-hint">${t('1 falls first')}</span></div>
      <p class="card-note muted-copy">${t('An enemy hits the stack with the most health first. Each stack here holds a little less than the one above it, so the cheap stacks soak the hits and your strongest troops fall last.')}</p>
      <div class="card-body">
        <table class="table-responsive stacks-table">
          <colgroup><col class="col-order"><col class="col-troop"><col class="col-count"><col class="col-health"><col class="col-gap"><col class="col-cost"></colgroup>
          <thead><tr><th>#</th><th>${t('Troop')}</th><th class="num">${t('Count')}</th><th class="num">${t('Stack health')}</th><th class="num">${t('Less than the one before')}</th><th class="num">${t('Costs')}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function howItWorksHtml() {
  return `
    <details class="card card-collapsible" data-section-key="tools-stacks-howto">
      <summary class="card-header"><h2>${t('How this works')}</h2></summary>
      <div class="card-body-padded tool-howto">
        <ul>
          <li>${t('<strong>Who gets hit.</strong> An enemy stack hits the stack with the most health it can finish off. So the stack with the most health falls first, the one with the least falls last.')}</li>
          <li>${t('<strong>The base stack</strong> is your strongest guardsman or specialist, at the size you set. It is the smallest stack of trained troops and the last of them to fall.')}</li>
          <li>${t('<strong>Trained troops.</strong> Stacks of one tier hold the same health: one flyer = 10 riders = 20 foot soldiers. Each tier lower gets 1.9× the units, a little more health, so lower tiers fall first. Specialists get 1% more than the guardsmen of their tier.')}</li>
          <li>${t('<strong>Monsters and mercenaries</strong> stay just under the base stack (97% of its health) and step down from there, weakest first, so the strongest is the last stack standing.')}</li>
          <li>${t('<strong>Siege engines</strong> are decoys: each gets more health than your biggest stack, so an epic monster\'s first hits land on them and every other stack gets to strike.')}</li>
          <li>${t('<strong>Health bonuses</strong> divide the counts: +100% health needs half the units for the same stack health. Without them the counts are a fair start, not exact.')}</li>
          <li>${t('<strong>Revival cost</strong> prices 90% of every stack at its revival gold, divided by the reduction of your {temple}.', { temple: esc(TEMPLE) })}</li>
        </ul>
        <p class="muted-copy">${t('The sizing is {link}\'s, ported count for count. Its battle-report calibration is not included.', { link: '<a href="https://kaiculator.kaikaiju.com/" target="_blank" rel="noopener">Kaiculator</a>' })}</p>
      </div>
    </details>`;
}

// ─── Events ──────────────────────────────────────────────────────

function onInput(e) {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || el.readOnly) return;
  const root = el.closest('.stacks-tool');
  const raw = el.value.trim();
  if (el.dataset.field === 'healthPct') {
    const i = Number(el.dataset.row);
    const row = ss.rows[i];
    if (!row) return;
    if (/,/.test(raw)) ss.decimalComma = true;
    else if (/\./.test(raw)) ss.decimalComma = false;
    const v = parseBonus(raw);
    const before = row.healthPct;
    row.healthPct = v === null || v === 0 ? null : Math.min(Math.max(v, -99), 1_000_000);
    handTyped.add(row);
    // The same bonus goes to the rest of its family (Corax I and II…), but
    // only to boxes that agreed (or were empty) and weren't typed in by hand.
    for (const k of familyPeers(i)) {
      const peer = ss.rows[k];
      if (handTyped.has(peer)) continue;
      if (peer.healthPct !== null && peer.healthPct !== before) continue;
      peer.healthPct = row.healthPct;
      const input = root.querySelector(`[data-row="${k}"][data-field="healthPct"]`);
      if (input) input.value = fmtBonus(peer.healthPct);
    }
    refresh(root);
    return;
  }
  const key = el.dataset.setting;
  if (!key) return;
  if (el.type === 'checkbox') return; // handled on change
  const s = ss.settings;
  if (key === 'baseCount') {
    const n = parseCount(raw);
    if (n !== null && n >= 1) s.baseCount = Math.min(n, 10_000_000);
  } else if (LIMITS.some(([k]) => k === key)) {
    const n = raw === '' ? 0 : parseCount(raw);
    if (n !== null) s[key] = Math.min(n, MAX_COUNT);
    // Leadership turning on or off changes what Fill can do.
    if (key === 'leadership' && s.baseMode === 'fill') {
      const base = root.querySelector('[data-setting="baseCount"]');
      if (base) {
        base.readOnly = s.leadership > 0;
        base.classList.toggle('is-auto', s.leadership > 0);
      }
    }
  } else if (key === 'tierMultiplier' || key === 'siegeMultiplier') {
    if (/,/.test(raw)) ss.decimalComma = true;
    else if (/\./.test(raw)) ss.decimalComma = false;
    const v = parseBonus(raw);
    const [min, max] = key === 'tierMultiplier' ? [1, 5] : [0, 3];
    if (v !== null && v >= min && v <= max) s[key] = v;
  } else {
    return;
  }
  refresh(root);
}

function onChange(e) {
  const el = e.target;
  const root = el.closest('.stacks-tool');
  if (el instanceof HTMLSelectElement && el.dataset.stk === 'level') {
    const n = Number(el.value);
    if (el.dataset.kind in ss.levels) ss.levels[el.dataset.kind] = Number.isInteger(n) && n >= 1 && n <= 9 ? n : null;
    paintAll(root);
    root.querySelector(`[data-stk="level"][data-kind="${el.dataset.kind}"]`)?.focus();
    saveLevels();
    return;
  }
  if (el instanceof HTMLSelectElement && el.dataset.stk === 'preset') {
    ss.selectedPreset = el.value;
    if (el.value) applyPreset(el.value);
    saveDraft();
    paintAll(root);
    return;
  }
  if (el instanceof HTMLInputElement && el.dataset.field === 'healthPct') {
    // Settle what onInput left: show the stored value back.
    const row = ss.rows[Number(el.dataset.row)];
    if (row) el.value = fmtBonus(row.healthPct);
    return;
  }
  const key = el.dataset.setting;
  if (!key) return;
  const s = ss.settings;
  if (el instanceof HTMLSelectElement) {
    if (key === 'templeLevel') s.templeLevel = Number(el.value) || 1;
    if (key === 'monsterMode' && MONSTER_MODES.includes(el.value)) s.monsterMode = el.value;
    refresh(root);
    return;
  }
  if (el instanceof HTMLInputElement && el.type === 'checkbox') {
    if (key === 'specialistsFirst' || key === 'epicHunterLast') s[key] = el.checked;
    refresh(root);
    return;
  }
  // A box left empty or invalid shows the value in use again.
  if (el instanceof HTMLInputElement && !el.readOnly) {
    if (key === 'baseCount') el.value = s.baseCount.toLocaleString();
    else if (LIMITS.some(([k]) => k === key)) el.value = s[key] ? s[key].toLocaleString() : '';
    else if (key === 'tierMultiplier' || key === 'siegeMultiplier') el.value = fmtDecimal(s[key]);
  }
}

async function onClick(e) {
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    openPicker(pick.closest('.stacks-tool'), pick, pick.dataset.pick === 'add' ? 'add' : Number(pick.dataset.pick));
    return;
  }
  const btn = e.target.closest('[data-stk-action]');
  if (!btn) return;
  const root = btn.closest('.stacks-tool');
  const action = btn.dataset.stkAction;
  if (action === 'remove') {
    ss.rows.splice(Number(btn.dataset.row), 1);
    saveDraft();
    paintAll(root);
    root.querySelector('.citadel-add-btn')?.focus();
  } else if (action === 'base-mode') {
    ss.settings.baseMode = btn.dataset.mode === 'fill' ? 'fill' : 'manual';
    saveDraft();
    paintAll(root);
    root.querySelector(`[data-stk-action="base-mode"][data-mode="${ss.settings.baseMode}"]`)?.focus();
  } else if (action === 'reset-advanced') {
    for (const k of ['tierMultiplier', 'siegeMultiplier', 'monsterMode', 'specialistsFirst', 'epicHunterLast']) ss.settings[k] = DEFAULTS[k];
    saveDraft();
    paintAll(root);
    const details = root.querySelector('.stacks-advanced');
    if (details) details.open = true;
  } else if (action === 'march') {
    openMarchList();
  } else if (action === 'save') {
    await savePreset(root);
  } else if (action === 'delete') {
    await deletePreset(root);
  }
}

function applyPreset(id) {
  const p = ss.presets.find((x) => String(x.id) === id);
  if (!p) return;
  ss.rows = cleanRows(p.data?.rows);
  ss.settings = cleanSettings(p.data?.settings);
}

async function saveLevels() {
  try {
    const res = await apiPut('/tools/citadel-levels', ss.levels);
    if (res?.levels) ss.levels = res.levels;
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    await notify(t('Could not save: {error}', { error: err?.message || err }), t('Could not save'));
  }
}

// ─── Troop picker ────────────────────────────────────────────────

function openPicker(root, trigger, target) {
  const current = target === 'add' ? null : ss.rows[target]?.troopId ?? null;
  const taken = new Set(ss.rows.map((r) => r.troopId));
  openTroopPicker({
    trigger,
    troops: STACK_TROOPS,
    groups: PICKER_GROUPS,
    current,
    allow: (x) => !taken.has(x.id) && troopInWindow(x.id, ss.levels),
    tagHtml: levelTag,
    onPick: (troopId) => choosePicked(root, target, troopId),
  });
}

/** Add the troop, or swap a row's troop in place. Its health bonus comes from
 *  its family (another row's, or the row's own within the family), else none. */
function choosePicked(root, target, troopId) {
  if (!troopById(troopId)) return;
  let row;
  if (target === 'add') {
    row = { troopId, healthPct: familyHealth(troopId) };
    ss.rows = sortRows([...ss.rows, row]);
  } else {
    row = ss.rows[target];
    if (!row) return;
    if (row.troopId !== troopId) {
      const sameFamily = bonusFamily(troopId) !== null && bonusFamily(troopId) === bonusFamily(row.troopId);
      const shared = familyHealth(troopId, row);
      row.troopId = troopId;
      if (shared !== null) row.healthPct = shared;
      else if (!sameFamily) row.healthPct = null;
      ss.rows = sortRows(ss.rows);
    }
  }
  saveDraft();
  paintAll(root);
  const i = ss.rows.indexOf(row);
  (root.querySelector(`[data-row="${i}"][data-field="healthPct"]`) ?? root.querySelector(`[data-pick="${i}"]`))?.focus();
}

// ─── March list ──────────────────────────────────────────────────

function openMarchList() {
  const { plan } = currentPlan();
  if (!plan.ok) return;
  const list = marchList(plan.squads.map((q) => ({ troopId: q.troopId, count: q.count })));
  const over = LIMITS.filter(([k]) => plan.over[k]).map(([, label]) => label);
  const html = `
    <p class="muted-copy citadel-march-intro">${esc(t('In the order the game lists them when you set up the march: go down the list and type each count.'))}</p>
    ${over.length ? `<p class="citadel-march-warn">${esc(t('Over your limit: {limits}. The game won\'t let all of this march.', { limits: over.join(', ') }))}</p>` : ''}
    <ol class="citadel-march">
      ${list.map((r) => `<li>
        <img src="${icon(r.troopId)}" alt="" width="36" height="36">
        <span class="citadel-march-name">${esc(troopName(r.troopId))}</span>
        <span class="citadel-march-count">${r.count.toLocaleString()}</span>
      </li>`).join('')}
    </ol>
    <div class="modal-actions">
      <button type="button" class="btn btn-primary citadel-march-copy">${esc(t('Copy list'))}</button>
    </div>`;
  const modal = contentModal({ title: t('March list'), html, className: 'citadel-march-modal' });
  if (!modal) return;
  const copy = modal.content.querySelector('.citadel-march-copy');
  copy.addEventListener('click', async () => {
    // Plain digits: the list is pasted into chats in any language.
    await copyTextToClipboard(list.map((r) => `${troopName(r.troopId)} - ${r.count}`).join('\n'));
    copy.textContent = t('Copied');
    setTimeout(() => { copy.textContent = t('Copy list'); }, 1500);
  });
}

// ─── Saved armies (per account) ──────────────────────────────────

async function savePreset(root) {
  if (!ss.rows.length) {
    await notify(t('Add some troops first.'), t('Nothing to save'));
    return;
  }
  const current = ss.presets.find((p) => String(p.id) === ss.selectedPreset);
  const typed = await promptDialog(t('Name this army.'), { title: t('Save army'), defaultValue: current?.name ?? '', confirmLabel: t('Save') });
  if (typed === null || !String(typed).trim()) return;
  let name = String(typed).trim().replace(/\s+/g, ' ');
  if (ss.presets.some((p) => p.name === name)) {
    const copy = nextFreeName(name, ss.presets.map((p) => p.name));
    const choice = await choiceDialog(
      t('An army named “{name}” is already saved. Replace it, or keep both and save this one as “{copy}”?', { name, copy }),
      [{ value: 'copy', label: t('Keep both') }, { value: 'replace', label: t('Replace') }],
      { title: t('Save army') },
    );
    if (choice === null) return;
    if (choice === 'copy') name = copy;
  }
  try {
    const res = await apiPut('/tools/stack-presets', {
      name,
      data: { rows: ss.rows.map((r) => ({ troopId: r.troopId, healthPct: r.healthPct ?? 0 })), settings: ss.settings },
    });
    if (res?.error) {
      await notify(res.error, t('Could not save'));
      return;
    }
    ss.presets = res.presets ?? ss.presets;
    ss.selectedPreset = String(res.preset.id);
    paintAll(root);
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    await notify(t('Could not save: {error}', { error: err?.message || err }), t('Could not save'));
  }
}

async function deletePreset(root) {
  const p = ss.presets.find((x) => String(x.id) === ss.selectedPreset);
  if (!p) return;
  const ok = await confirmDialog(t('Delete the saved army “{name}”?', { name: p.name }), { title: t('Delete army'), confirmLabel: t('Delete'), danger: true });
  if (!ok) return;
  try {
    const res = await apiDelete(`/tools/stack-presets/${p.id}`);
    if (res?.error) {
      await notify(res.error, t('Could not delete'));
      return;
    }
    ss.presets = res.presets ?? ss.presets.filter((x) => x.id !== p.id);
    ss.selectedPreset = '';
    paintAll(root);
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    await notify(t('Could not delete: {error}', { error: err?.message || err }), t('Could not delete'));
  }
}
