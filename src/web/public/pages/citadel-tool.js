// Tools → Citadel: build an army, see the fight played out for both coin flips.
//
// The rules and data live in lib/citadel-sim.js (measured from real battle
// reports; docs/citadel-simulator.md). This file is the army editor, the
// results, and the saved armies — kept per ACCOUNT on the server
// (/api/tools/citadel-presets), so they follow the player between devices.
//
// What the player fills in, and what is worked out:
//  - Strength bonus for every troop (from its card) — it drives every number.
//  - Health bonus ONLY for troops that get hit: the simulator treats a missing
//    health as untouchable and asks for it when that troop still takes a hit
//    (game01master's setup: the first striker, and the Phoenix the Bear hits).
//  - Counts are AUTOMATIC on Elven 25 and 30 (game01master's sizing, from the
//    bonuses) unless switched to Manual; elsewhere there is no sizing rule, so
//    they are typed in or come from a recommended setup.
// Bonuses change with every captain, artifact or research swap, so nothing
// ships with any; the page says when they were typed or saved.

import { api, apiPut, apiDelete } from '../lib/api.js';
import { esc, notify, confirmDialog, promptDialog, formatRelativeTime } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { formatCompact } from '../lib/ancient-planner.js';
import {
  TROOPS,
  TROOP_GROUPS,
  DEFENDERS,
  CITADELS,
  troopById,
  citadelById,
  simulateBoth,
  optimizeCounts,
  gmRoles,
  gmCounts,
  GM_CITADELS,
} from '../lib/citadel-sim.js';

/** The count search runs this long after the last keystroke. */
const SEARCH_DELAY_MS = 350;

const DRAFT_KEY = 'tbcc.citadel.draft.v1';
/** Bonuses older than this get an amber "check them" nudge. */
const STALE_MS = 6 * 3600 * 1000;

const icon = (troopId) => new URL(`../img/troops/${troopId}.webp`, import.meta.url).href;
const troopName = (id) => tGame(troopById(id)?.name ?? id);

const GROUP_LABELS = {
  guardsmen: t('Guardsmen'),
  specialists: t('Specialists'),
  monsters: t('Monsters'),
  mercenaries: t('Mercenaries'),
  siege: t('Siege engines'),
};
const ROLE_LABELS = {
  first: [t('1st'), t('First striker: kills the strongest stack and takes the opening hits')],
  second: [t('2nd'), t('Second striker')],
  third: [t('3rd'), t('Third striker')],
  cleanup: [t('Clean'), t('Cleanup: finishes what is left')],
  walls: [t('Walls'), t('Breaks the walls in the siege')],
  extra: [t('Extra'), t('Not part of game01master\'s template')],
};

/** Proven setups: troops and counts only — never anyone's bonuses. */
const GM_TEMPLATE = ['corax-1', 'fire-phoenix-1', 'royal-lion-1', 'griffin-7', 'vulture-7', 'griffin-6', 'vulture-6', 'siege-ballistae-7'];
const RECOMMENDED = [
  {
    id: 'rec-wyverns',
    citadelId: 'elven-15',
    name: t('Elven 10–15: {wyvern} only', { wyvern: tGame('Wyvern') }),
    rows: [['wyvern', 3]],
  },
  {
    id: 'rec-e20',
    citadelId: 'elven-20',
    name: t('Elven 20: {wyvern} + {phoenix}', { wyvern: tGame('Wyvern'), phoenix: tGame('Fire Phoenix I') }),
    rows: [['wyvern', 12], ['fire-phoenix-1', 1]],
  },
  { id: 'rec-gm-25', citadelId: 'elven-25', name: t('Elven {level}: game01master + cleanups', { level: 25 }), rows: GM_TEMPLATE.map((id) => [id, 0]) },
  { id: 'rec-gm-30', citadelId: 'elven-30', name: t('Elven {level}: game01master + cleanups', { level: 30 }), rows: GM_TEMPLATE.map((id) => [id, 0]) },
];

/** Module state — rebuilt on every page render. */
let cs = null;

function emptyRow(troopId, count = 0) {
  return { troopId, count, strengthPct: null, healthPct: null };
}

const num = (v) => (Number.isFinite(v) ? v : null);

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!citadelById(d?.citadelId) || !Array.isArray(d.rows)) return null;
    return {
      citadelId: d.citadelId,
      rows: d.rows.filter((r) => troopById(r?.troopId)).map((r) => ({
        troopId: r.troopId,
        count: Number.isInteger(r.count) && r.count >= 0 ? r.count : 0,
        strengthPct: num(r.strengthPct),
        healthPct: num(r.healthPct),
      })),
      countMode: ['auto', 'gm', 'manual'].includes(d.countMode) ? d.countMode : 'auto',
      bonusesAt: typeof d.bonusesAt === 'string' ? d.bonusesAt : null,
      bonusesFrom: typeof d.bonusesFrom === 'string' ? d.bonusesFrom : null,
    };
  } catch {
    return null;
  }
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      citadelId: cs.citadelId, rows: cs.rows, countMode: cs.countMode, bonusesAt: cs.bonusesAt, bonusesFrom: cs.bonusesFrom,
    }));
  } catch { /* private mode — the draft just isn't kept */ }
}

export async function renderCitadelTool(mount) {
  const draft = loadDraft();
  cs = {
    citadelId: draft?.citadelId ?? 'elven-20',
    rows: draft?.rows ?? [],
    countMode: draft?.countMode ?? 'auto',
    bonusesAt: draft?.bonusesAt ?? null,
    bonusesFrom: draft?.bonusesFrom ?? null,
    presets: [],
    presetsError: false,
    selectedPreset: '',
    logOpener: 'citadel',
    /** Last count search: { key, ok, counts } — see scheduleSearch(). */
    search: null,
  };
  mount.innerHTML = `
    <div class="citadel-tool">
      <div class="citadel-top-slot"></div>
      <div class="citadel-army-slot"></div>
      <div class="citadel-results" aria-live="polite"></div>
      ${howItWorksHtml()}
    </div>`;
  const root = mount.querySelector('.citadel-tool');
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  paintAll(root);
  try {
    cs.presets = (await api('/tools/citadel-presets')).presets ?? [];
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
    cs.presetsError = true;
  }
  paintTop(root);
}

// ─── What is filled in, what is worked out ───────────────────────

/** 'auto' (the simulator's search, any citadel), 'gm' (Elven 25/30 only) or 'manual'. */
function countMode() {
  if (cs.countMode === 'gm' && !GM_CITADELS.has(cs.citadelId)) return 'auto';
  return cs.countMode;
}

/** What the search depends on — when this changes, the counts are searched again. */
function searchKey() {
  return JSON.stringify([cs.citadelId, cs.rows.map((r) => [r.troopId, r.strengthPct, r.healthPct])]);
}

let searchTimer = null;

/** Search the counts a moment after the last change, then fill them in place. */
function scheduleSearch(root) {
  clearTimeout(searchTimer);
  const key = searchKey();
  searchTimer = setTimeout(() => {
    if (!cs || searchKey() !== key || !root.isConnected) return;
    const gm = gmCounts(cs.citadelId, cs.rows.map((r) => ({ ...r, healthPct: r.healthPct ?? 0 })));
    const starts = [cs.rows.map((r) => r.count)];
    if (gm.some((n) => n !== null)) starts.push(gm.map((n) => (Number.isFinite(n) ? n : 0)));
    const res = optimizeCounts({ citadelId: cs.citadelId, army: cs.rows, starts });
    cs.search = { key, ok: res.ok, counts: res.counts };
    refresh(root);
  }, SEARCH_DELAY_MS);
}

/**
 * Counts (searched, game01master's or typed), the bonuses still needed, and —
 * once nothing is missing — both simulated outcomes. Worked-out counts are
 * written back into the rows, so saving or switching to Manual keeps them.
 */
function analyze(root) {
  const mode = countMode();
  const roles = gmRoles(cs.citadelId, cs.rows);
  const autoRow = cs.rows.map((r, i) => (mode === 'auto') || (mode === 'gm' && roles[i] !== null && roles[i] !== 'extra'));
  const strengthMissing = [];
  const healthNeeded = new Map(); // row index → why ('first' | attacker names)
  cs.rows.forEach((r, i) => {
    if ((autoRow[i] || r.count > 0) && r.strengthPct === null) strengthMissing.push(i);
  });
  let pending = false;
  let failed = false;
  if (mode === 'gm') {
    const counts = gmCounts(cs.citadelId, cs.rows.map((r) => ({ ...r, strengthPct: r.strengthPct ?? NaN, healthPct: r.healthPct ?? NaN })));
    counts.forEach((n, i) => {
      if (autoRow[i] && Number.isFinite(n)) cs.rows[i].count = Math.max(0, n);
    });
    // game01master sizes the first striker from its health (it absorbs the opening hit).
    const first = roles.indexOf('first');
    if (first >= 0 && cs.rows[first].healthPct === null) healthNeeded.set(first, 'first');
  } else if (mode === 'auto' && cs.rows.length && !strengthMissing.length) {
    if (cs.search?.key === searchKey()) {
      cs.search.counts.forEach((n, i) => { cs.rows[i].count = n; });
      failed = !cs.search.ok;
    } else {
      pending = true;
      if (root) scheduleSearch(root);
    }
  }

  let both = null;
  if (!pending && !failed && !strengthMissing.length && !healthNeeded.size && cs.rows.some((r) => r.count > 0)) {
    both = simulateBoth({ citadelId: cs.citadelId, army: cs.rows });
    for (const res of [both.you, both.citadel]) {
      for (const s of res.army) {
        if (!s.healthUnknown || !s.wasHit) continue;
        const hitters = new Set(healthNeeded.get(s.index) || []);
        for (const k of res.strikes) if (k.side === 'citadel' && k.target === s.troopId) hitters.add(DEFENDERS[k.actor].name);
        healthNeeded.set(s.index, [...hitters]);
      }
    }
    if (healthNeeded.size) both = null;
  }
  return { mode, auto: mode !== 'manual', roles, autoRow, strengthMissing, healthNeeded, both, pending, failed };
}

function paintAll(root) {
  paintTop(root);
  const a = analyze(root);
  paintArmy(root, a);
  paintResults(root, a);
}

/** After typing: refresh the worked-out numbers and flags without replacing the input in use. */
function refresh(root) {
  const a = analyze(root);
  const focused = document.activeElement;
  cs.rows.forEach((r, i) => {
    const count = root.querySelector(`[data-row="${i}"][data-field="count"]`);
    if (count && count !== focused) count.value = a.autoRow[i] && (a.pending || a.strengthMissing.length) ? '' : String(r.count);
    root.querySelector(`[data-row="${i}"][data-field="strengthPct"]`)?.classList.toggle('is-missing', a.strengthMissing.includes(i));
    const health = root.querySelector(`[data-row="${i}"][data-field="healthPct"]`);
    if (health) {
      health.classList.toggle('is-missing', a.healthNeeded.has(i));
      health.placeholder = healthPlaceholder(i, a);
    }
  });
  const note = root.querySelector('.citadel-army .citadel-note');
  if (note) note.outerHTML = bonusesNoteHtml();
  paintResults(root, a);
  saveDraft();
}

function healthPlaceholder(i, a) {
  if (a.healthNeeded.has(i)) return t('needed');
  if (a.both) return t('not hit');
  return t('if hit');
}

// ─── 1 · Citadel picker + armies ─────────────────────────────────

function paintTop(root) {
  const slot = root.querySelector('.citadel-top-slot');
  if (slot) slot.innerHTML = topCardHtml();
}

function topCardHtml() {
  const kinds = [['elven', t('Elven')], ['cursed', t('Cursed')]];
  const picker = kinds.map(([kind, label]) => `
    <div class="citadel-kind" role="group" aria-label="${esc(t('{kind} citadels', { kind: label }))}">
      <span class="citadel-kind-label">${esc(label)}</span>
      ${CITADELS.filter((c) => c.kind === kind).map((c) => `
        <button type="button" class="citadel-level ${c.id === cs.citadelId ? 'is-active' : ''}" data-cit-action="citadel" data-citadel="${c.id}" aria-pressed="${c.id === cs.citadelId}">${c.level}</button>`).join('')}
    </div>`).join('');

  const saved = cs.presets.map((p) => `<option value="saved:${p.id}" ${cs.selectedPreset === `saved:${p.id}` ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const rec = RECOMMENDED.map((r) => `<option value="rec:${r.id}" ${cs.selectedPreset === `rec:${r.id}` ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const isSaved = cs.selectedPreset.startsWith('saved:');

  const citadel = citadelById(cs.citadelId);
  const inside = [...citadel.units.map(([id, n]) => ({ id, n })), { id: 'walls', n: citadel.walls }]
    .map(({ id, n }) => `<span class="citadel-defender"><strong>${n.toLocaleString()}</strong> ${esc(tGame(DEFENDERS[id].name))}</span>`)
    .join('');

  return `
    <div class="card citadel-top">
      <h2 class="citadel-step"><span class="citadel-step-num" aria-hidden="true">1</span>${t('Pick the citadel')}</h2>
      <div class="citadel-top-row">
        <div class="citadel-picker">${picker}</div>
        <div class="citadel-presets">
          <label class="visually-hidden" for="citadel-preset">${t('Load an army')}</label>
          <select id="citadel-preset" class="input citadel-preset-select" data-cit="preset">
            <option value="">${t('Load an army…')}</option>
            <optgroup label="${esc(t('Recommended'))}">${rec}</optgroup>
            ${cs.presets.length ? `<optgroup label="${esc(t('Your saved armies'))}">${saved}</optgroup>` : ''}
          </select>
          <button type="button" class="btn btn-sm" data-cit-action="save">${t('Save army')}</button>
          ${isSaved ? `<button type="button" class="btn btn-sm btn-ghost" data-cit-action="delete">${t('Delete')}</button>` : ''}
        </div>
      </div>
      <p class="citadel-inside"><span class="citadel-inside-label">${t('Inside')}</span>${inside}</p>
      ${cs.presetsError ? `<p class="citadel-note tool-warn">${t('Your saved armies could not be loaded.')}</p>` : ''}
    </div>`;
}

// ─── 2 · Army editor ─────────────────────────────────────────────

function paintArmy(root, a) {
  const slot = root.querySelector('.citadel-army-slot');
  if (slot) slot.innerHTML = armyCardHtml(a);
}

function bonusesNoteHtml() {
  const base = t('Type each troop\'s strength bonus from its card, read with the captains you will march with; health only where it says “needed”. Bonuses change with every captain, artifact or research swap — update them before every attack.');
  if (!cs.bonusesAt) return `<p class="citadel-note">${base}</p>`;
  const stale = Date.now() - new Date(cs.bonusesAt).getTime() > STALE_MS;
  const when = esc(formatRelativeTime(cs.bonusesAt));
  const from = cs.bonusesFrom
    ? t('Bonuses from the saved army “{name}”, saved {when}.', { name: esc(cs.bonusesFrom), when })
    : t('Bonuses entered {when}.', { when });
  return `<p class="citadel-note">${base} <span class="${stale ? 'tool-warn' : 'citadel-note-when'}">${stale ? '⚠ ' : ''}${from}</span></p>`;
}

function countModeHtml(a) {
  const btn = (mode, label, title) => `<button type="button" class="citadel-seg ${a.mode === mode ? 'is-active' : ''}" data-cit-action="count-mode" data-mode="${mode}" aria-pressed="${a.mode === mode}" title="${esc(title)}">${label}</button>`;
  return `
    <div class="citadel-count-mode" role="group" aria-label="${esc(t('Counts'))}">
      <span class="citadel-count-mode-label">${t('Counts')}</span>
      ${btn('auto', t('Auto'), t('The simulator searches the counts that win with the fewest losses, with a 3% safety margin on your bonuses'))}
      ${GM_CITADELS.has(cs.citadelId) ? btn('gm', 'game01master', t('Counts as game01master\'s calculator works them out (Elven 25 and 30)')) : ''}
      ${btn('manual', t('Manual'), t('You type the counts yourself'))}
    </div>`;
}

function countModeNote(a) {
  if (a.mode === 'auto') return t('Counts: searched by the simulator for the fewest losses with your troops and bonuses — wins even with every bonus 3% lower. Add or remove troops to try other setups.');
  if (a.mode === 'gm') return t('Counts: game01master\'s sizing, in the order of your rows (1st, 2nd, 3rd striker, cleanups, a siege engine for the walls).');
  return t('Counts: you type them.');
}

function armyCardHtml(a) {
  // Roles only mean something in game01master's template.
  const hasRoles = a.mode === 'gm' && a.roles.some(Boolean);
  const rows = cs.rows.map((r, i) => rowHtml(r, i, hasRoles ? a.roles[i] : undefined, a)).join('');
  const taken = new Set(cs.rows.map((r) => r.troopId));
  const addOptions = TROOP_GROUPS.map((g) => `
    <optgroup label="${esc(GROUP_LABELS[g])}">
      ${TROOPS.filter((x) => x.group === g && !taken.has(x.id)).map((x) => `<option value="${x.id}">${esc(tGame(x.name))}</option>`).join('')}
    </optgroup>`).join('');
  return `
    <div class="card citadel-army">
      <div class="card-header">
        <h2 class="citadel-step"><span class="citadel-step-num" aria-hidden="true">2</span>${t('Your army')}<span class="citadel-step-hint">${t('you fill this in')}</span></h2>
        ${countModeHtml(a)}
      </div>
      <div class="card-body-padded">
        ${bonusesNoteHtml()}
        <p class="citadel-note citadel-count-note">${countModeNote(a)}</p>
        ${cs.rows.length ? `
          <div class="citadel-rows ${hasRoles ? 'has-roles' : ''}" role="list">
            <div class="citadel-row citadel-row-head" aria-hidden="true">
              ${hasRoles ? `<span>${t('Role')}</span>` : ''}
              <span class="citadel-head-troop">${t('Troop')}</span>
              <span>${t('Count')}<small>${a.auto ? t('worked out') : t('you type')}</small></span>
              <span>${t('Strength %')}<small>${t('from the troop card')}</small></span>
              <span>${t('Health %')}<small>${t('only if hit')}</small></span>
              <span></span>
            </div>
            ${rows}
          </div>` : `<p class="citadel-empty muted-copy">${t('Add the troops you will send, or load a recommended army above.')}</p>`}
        <div class="citadel-add">
          <label class="visually-hidden" for="citadel-add">${t('Add a troop')}</label>
          <select id="citadel-add" class="input citadel-add-select" data-cit="add">
            <option value="">${t('+ Add a troop…')}</option>
            ${addOptions}
          </select>
        </div>
      </div>
    </div>`;
}

function rowHtml(r, i, role, a) {
  const name = troopName(r.troopId);
  const [roleShort, roleLong] = role ? ROLE_LABELS[role] : ['', ''];
  const isAuto = a.autoRow[i];
  const countUnknown = isAuto && (a.pending || a.strengthMissing.length > 0 || r.strengthPct === null);
  const field = (key, value, label, step, { cls = '', placeholder = '', readonly = false, title = '' } = {}) => `
    <label class="citadel-field" data-label="${esc(label)}">
      <span class="visually-hidden">${esc(t('{troop}: {field}', { troop: name, field: label }))}</span>
      <input type="number" class="input citadel-num ${cls}" data-row="${i}" data-field="${key}" step="${step}" ${key === 'count' ? 'min="0"' : 'min="-100"'}
        inputmode="decimal" value="${value ?? ''}" placeholder="${esc(placeholder)}" ${readonly ? 'readonly tabindex="-1"' : ''} ${title ? `title="${esc(title)}"` : ''}>
    </label>`;
  return `
    <div class="citadel-row" role="listitem" data-row="${i}">
      ${role !== undefined ? `<span class="citadel-role ${role ? `is-${role}` : ''}" title="${esc(roleLong)}">${esc(roleShort)}</span>` : ''}
      <span class="citadel-troop"><img class="citadel-icon" src="${icon(r.troopId)}" alt="" width="36" height="36" decoding="async"><span class="citadel-troop-name">${esc(name)}</span></span>
      ${field('count', countUnknown ? '' : r.count, t('Count'), 1, isAuto
        ? {
          cls: 'is-auto',
          placeholder: a.pending ? '…' : '—',
          readonly: true,
          title: a.mode === 'gm'
            ? t('Worked out from your bonuses, the way game01master does it. Switch Counts to Manual to change it.')
            : t('Searched by the simulator from your bonuses. Switch Counts to Manual to change it.'),
        }
        : { placeholder: '0' })}
      ${field('strengthPct', r.strengthPct, t('Strength %'), 0.1, { cls: a.strengthMissing.includes(i) ? 'is-missing' : '', placeholder: t('from card') })}
      ${field('healthPct', r.healthPct, t('Health %'), 0.1, { cls: a.healthNeeded.has(i) ? 'is-missing' : '', placeholder: healthPlaceholder(i, a) })}
      <span class="citadel-row-actions">
        <button type="button" class="citadel-icon-btn" data-cit-action="up" data-row="${i}" aria-label="${esc(t('Move {troop} up', { troop: name }))}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="citadel-icon-btn" data-cit-action="down" data-row="${i}" aria-label="${esc(t('Move {troop} down', { troop: name }))}" ${i === cs.rows.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="citadel-icon-btn is-remove" data-cit-action="remove" data-row="${i}" aria-label="${esc(t('Remove {troop}', { troop: name }))}">✕</button>
      </span>
    </div>`;
}

// ─── 3 · Result ──────────────────────────────────────────────────

function paintResults(root, a) {
  const el = root.querySelector('.citadel-results');
  if (!el) return;
  if (!cs.rows.length) {
    el.innerHTML = '';
    return;
  }
  const title = `<h2 class="citadel-step citadel-result-title"><span class="citadel-step-num" aria-hidden="true">3</span>${t('Result')}<span class="citadel-step-hint">${t('worked out as you type')}</span></h2>`;
  const asks = [];
  if (a.strengthMissing.length) {
    asks.push(t('Enter the strength bonus for: {troops}.', { troops: a.strengthMissing.map((i) => `<strong>${esc(troopName(cs.rows[i].troopId))}</strong>`).join(', ') }));
  }
  for (const [i, why] of a.healthNeeded) {
    const troop = `<strong>${esc(troopName(cs.rows[i].troopId))}</strong>`;
    asks.push(why === 'first'
      ? t('Enter the health bonus for {troop}: as first striker its count depends on it.', { troop })
      : t('Enter the health bonus for {troop}: it gets hit by {attackers}.', { troop, attackers: why.map((n) => esc(tGame(n))).join(', ') }));
  }
  if (asks.length) {
    el.innerHTML = `${title}
      <div class="card citadel-waiting">
        ${asks.map((x) => `<p>${x}</p>`).join('')}
        <p class="muted-copy">${t('The result needs these from your own troop cards — they decide every number.')}</p>
      </div>`;
    return;
  }
  if (a.pending) {
    el.innerHTML = `${title}<div class="card citadel-waiting"><p>${t('Working out the counts…')}</p></div>`;
    return;
  }
  if (a.failed) {
    el.innerHTML = `${title}<div class="card citadel-waiting is-bad"><p>${t('These troops can\'t take this citadel in both coin flips, even in large numbers.')}</p>
      <p class="muted-copy">${t('Add a siege engine for the walls, or stronger troops.')}</p></div>`;
    return;
  }
  if (!a.both) {
    el.innerHTML = `${title}<div class="card citadel-waiting"><p>${t('Enter how many of each troop you send.')}</p></div>`;
    return;
  }
  const both = a.both;
  const lostOf = (res) => res.army.reduce((x, s) => x + s.lost, 0);
  const avg = Math.round(((lostOf(both.you) + lostOf(both.citadel)) / 2) * 10) / 10;
  el.innerHTML = `${title}
    <div class="citadel-outcomes">
      ${outcomeHtml(both.you, t('If you strike first'))}
      ${outcomeHtml(both.citadel, t('If the citadel strikes first'))}
    </div>
    <p class="citadel-avg muted-copy">${t('Who strikes first after the walls is a coin flip. Average: {lost}.', { lost: avg === 0 ? t('no losses') : tn(avg, '{n} troop lost', '{n} troops lost', { n: avg.toLocaleString() }) })}
      ${t('Luck (double damage, blocks, hitting two squads) is not included.')}</p>
    ${logHtml(both)}`;
}

function outcomeHtml(r, title) {
  const lostRows = r.army.filter((s) => s.lost > 0);
  const total = lostRows.reduce((x, s) => x + s.lost, 0);
  let verdict;
  if (r.won) verdict = `<span class="citadel-tag is-win">✓ ${t('Victory')}</span>`;
  else if (r.reason === 'walls') verdict = `<span class="citadel-tag is-loss">✕ ${t('The walls hold')}</span>`;
  else verdict = `<span class="citadel-tag is-loss">✕ ${t('Defeat')}</span>`;
  const headline = total === 0
    ? `<div class="citadel-headline is-clean">${t('No losses')}</div>`
    : `<div class="citadel-headline">${tn(total, '{n} troop lost', '{n} troops lost', { n: total.toLocaleString() })}</div>`;
  const list = lostRows.map((s) => {
    const wall = s.lostInSiege > 0 ? ` <span class="muted-copy">${t('({n} to the walls)', { n: s.lostInSiege.toLocaleString() })}</span>` : '';
    return `<li><img class="citadel-icon-sm" src="${icon(s.troopId)}" alt="" width="22" height="22"><span class="citadel-loss-name">${esc(troopName(s.troopId))}</span><span class="citadel-loss-num">−${s.lost.toLocaleString()}</span><span class="citadel-loss-of">${t('of {n}', { n: s.count.toLocaleString() })}</span>${wall}</li>`;
  }).join('');
  let why = '';
  if (r.reason === 'walls') why = t('Nothing you sent can bring the walls down in time. Siege engines strike before the walls.');
  else if (r.reason === 'destroyed') why = t('Your army is wiped out.');
  else if (r.reason === 'rounds') why = t('The fight does not end — something can\'t be killed.');
  const meta = r.won ? tn(r.rounds, '{n} round', '{n} rounds', { n: r.rounds }) : '';
  return `
    <div class="card citadel-outcome ${r.won ? 'is-win' : 'is-loss'}">
      <div class="citadel-outcome-head"><h3>${esc(title)}</h3>${verdict}</div>
      ${headline}
      ${list ? `<ul class="citadel-losses">${list}</ul>` : ''}
      ${why ? `<p class="citadel-why">${why}</p>` : ''}
      ${meta ? `<p class="citadel-meta muted-copy">${meta}</p>` : ''}
    </div>`;
}

function nameOf(id, side) {
  return side === 'you' ? troopName(id) : tGame(DEFENDERS[id]?.name ?? id);
}

/** One side of a strike line: your troops get their icon, the citadel's units a plain name. */
function logUnitHtml(id, side) {
  const name = esc(nameOf(id, side));
  return side === 'you'
    ? `<img class="citadel-icon-sm" src="${icon(id)}" alt="" width="22" height="22"><span>${name}</span>`
    : `<span>${name}</span>`;
}

/** What the hit did, from your side of the table: your losses, or what the enemy has left. */
function logResultHtml(s) {
  if (s.side === 'citadel') {
    return s.unitsLost > 0
      ? `<span class="citadel-log-result is-loss">${t('−{n} lost', { n: s.unitsLost.toLocaleString() })}</span>`
      : `<span class="citadel-log-result is-free">${t('no loss')}</span>`;
  }
  if (s.killed) return `<span class="citadel-log-result is-kill">${s.target === 'walls' ? t('walls down') : t('destroyed')}</span>`;
  return `<span class="citadel-log-result">${t('{n} left', { n: s.unitsLeft.toLocaleString() })}</span>`;
}

function logHtml(both) {
  const r = both[cs.logOpener];
  // Group into the siege and the rounds, each headed by who opened it.
  const groups = [];
  for (const s of r.strikes) {
    const key = s.phase === 'siege' ? 'siege' : `r${s.round}`;
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      let title;
      if (s.phase === 'siege') title = t('Siege — breaking the walls');
      else if (s.side === 'you') title = t('Round {n} — you strike first', { n: s.round });
      else title = t('Round {n} — the citadel strikes first', { n: s.round });
      g = { key, title, items: [] };
      groups.push(g);
    }
    g.items.push(s);
  }
  const body = groups.map((g) => `
    <li class="citadel-log-group">
      <div class="citadel-log-head">${esc(g.title)}</div>
      <ol class="citadel-log-lines">
        ${g.items.map((s) => {
          const targetSide = s.side === 'you' ? 'citadel' : 'you';
          const luck = [s.double ? t('double damage') : '', s.second ? t('second squad') : '']
            .filter(Boolean).map((x) => `<span class="citadel-log-tag">${esc(x)}</span>`).join('');
          return `
            <li class="citadel-log-item is-${s.side}">
              <span class="citadel-log-actor">${logUnitHtml(s.actor, s.side)}</span>
              <span class="citadel-log-arrow" aria-label="${esc(t('hits'))}">→</span>
              <span class="citadel-log-target">${logUnitHtml(s.target, targetSide)}</span>
              <span class="citadel-log-dmg" title="${Math.round(s.damage).toLocaleString()}">${formatCompact(s.damage)}${luck}</span>
              ${logResultHtml(s)}
            </li>`;
        }).join('')}
      </ol>
    </li>`).join('');
  return `
    <details class="card card-collapsible citadel-log" data-section-key="tools-citadel-log">
      <summary class="card-header"><h2>${t('Strike by strike')}</h2></summary>
      <div class="card-body-padded">
        <div class="citadel-log-bar">
          <div class="citadel-log-switch" role="group" aria-label="${esc(t('Who strikes first'))}">
            <button type="button" class="btn btn-sm ${cs.logOpener === 'you' ? 'btn-primary' : ''}" data-cit-action="log" data-opener="you" aria-pressed="${cs.logOpener === 'you'}">${t('You first')}</button>
            <button type="button" class="btn btn-sm ${cs.logOpener === 'citadel' ? 'btn-primary' : ''}" data-cit-action="log" data-opener="citadel" aria-pressed="${cs.logOpener === 'citadel'}">${t('Citadel first')}</button>
          </div>
          <p class="citadel-log-legend">${t('Each line is one stack hitting another, in the order the game plays them. Red lines are the citadel hitting you; the last column is what each hit cost or left.')}</p>
        </div>
        <div class="citadel-log-cols" aria-hidden="true">
          <span>${t('Attacker')}</span><span></span><span>${t('Target')}</span><span>${t('Damage')}</span><span>${t('Result')}</span>
        </div>
        <ol class="citadel-log-list">${body}</ol>
      </div>
    </details>`;
}

function howItWorksHtml() {
  return `
    <details class="card card-collapsible" data-section-key="tools-citadel-howto">
      <summary class="card-header"><h2>${t('How this works')}</h2></summary>
      <div class="card-body-padded tool-howto">
        <ul>
          <li>${t('<strong>Siege.</strong> Siege engines strike the walls first. Without them the walls hit you first, and keep hitting each round until they fall. Losses to the walls are final; wounds from them heal before the battle.')}</li>
          <li>${t('<strong>Battle.</strong> A coin flip decides who opens; after that the sides take turns, strongest stack first, and the side that did not act last opens the next round.')}</li>
          <li>${t('<strong>Targets.</strong> Every stack hits where it deals the most damage — features like “vs mounted” count, and a target can\'t take more than it has left. That is why counts matter: one troop too many can change a stack\'s target.')}</li>
          <li>${t('<strong>Losses.</strong> Wounds stay through the battle: a stack loses a troop for every full troop\'s health of damage it takes in total.')}</li>
          <li>${t('<strong>game01master counts</strong> (Elven 25 and 30) follow its calculator: first, second and third striker, cleanups, and a siege engine for the walls, in the order of your rows.')}</li>
        </ul>
        <p class="muted-copy">${t('Every rule was measured from real battle reports and replays them strike for strike. Troop icons and the sizing method: {gm} (non-commercial licence). Unit data: {wiki} and in-game cards.', {
          gm: '<a href="https://github.com/game01master/tb-citadel-calculator" target="_blank" rel="noopener">game01master</a>',
          wiki: '<a href="https://totalbattlewiki.com/citadels/elven/" target="_blank" rel="noopener">totalbattlewiki.com</a>',
        })}</p>
      </div>
    </details>`;
}

// ─── Events ──────────────────────────────────────────────────────

function onInput(e) {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !el.dataset.field || el.readOnly) return;
  const row = cs.rows[Number(el.dataset.row)];
  if (!row) return;
  const raw = el.value.trim();
  if (el.dataset.field === 'count') {
    const n = Math.floor(Number(raw));
    row.count = raw === '' || !Number.isFinite(n) || n < 0 ? 0 : Math.min(n, 100_000_000);
  } else {
    const v = Number(raw.replace(',', '.'));
    row[el.dataset.field] = raw === '' || !Number.isFinite(v) ? null : Math.min(Math.max(v, -100), 1_000_000);
    cs.bonusesAt = new Date().toISOString();
    cs.bonusesFrom = null;
  }
  refresh(el.closest('.citadel-tool'));
}

function onChange(e) {
  const el = e.target;
  const root = el.closest('.citadel-tool');
  if (el instanceof HTMLSelectElement && el.dataset.cit === 'add' && el.value) {
    cs.rows.push(emptyRow(el.value));
    saveDraft();
    paintAll(root);
    root.querySelector(`[data-row="${cs.rows.length - 1}"][data-field="strengthPct"]`)?.focus();
    return;
  }
  if (el instanceof HTMLSelectElement && el.dataset.cit === 'preset') {
    cs.selectedPreset = el.value;
    if (el.value) applyPreset(el.value);
    paintAll(root);
    return;
  }
  if (el instanceof HTMLInputElement && el.dataset.field && !el.readOnly) {
    // Settle what onInput left: show the stored value back.
    const row = cs.rows[Number(el.dataset.row)];
    if (row) el.value = row[el.dataset.field] ?? '';
  }
}

function applyPreset(value) {
  const [kind, id] = value.split(':');
  const keep = new Map(cs.rows.map((r) => [r.troopId, r]));
  if (kind === 'rec') {
    const rec = RECOMMENDED.find((r) => r.id === id);
    if (!rec) return;
    cs.citadelId = rec.citadelId;
    // Your own bonuses for the same troops carry over; nothing else is filled in.
    cs.rows = rec.rows.map(([troopId, count]) => ({ ...emptyRow(troopId, count), strengthPct: keep.get(troopId)?.strengthPct ?? null, healthPct: keep.get(troopId)?.healthPct ?? null }));
    cs.countMode = 'auto';
  } else if (kind === 'saved') {
    const p = cs.presets.find((x) => String(x.id) === id);
    if (!p) return;
    if (citadelById(p.data.citadelId)) cs.citadelId = p.data.citadelId;
    cs.rows = p.data.rows.filter((r) => troopById(r.troopId)).map((r) => ({
      troopId: r.troopId, count: r.count, strengthPct: num(r.strengthPct), healthPct: num(r.healthPct),
    }));
    // A saved army keeps the counts it was saved with.
    cs.countMode = 'manual';
    cs.bonusesAt = p.updatedAt;
    cs.bonusesFrom = p.name;
  }
  saveDraft();
}

async function onClick(e) {
  const btn = e.target.closest('[data-cit-action]');
  if (!btn) return;
  const root = btn.closest('.citadel-tool');
  const action = btn.dataset.citAction;
  const i = Number(btn.dataset.row);
  if (action === 'citadel') {
    cs.citadelId = btn.dataset.citadel;
    saveDraft();
    paintAll(root);
  } else if (action === 'count-mode') {
    // Manual starts from the worked-out counts (analyze() wrote them into the rows).
    cs.countMode = ['auto', 'gm', 'manual'].includes(btn.dataset.mode) ? btn.dataset.mode : 'auto';
    saveDraft();
    paintAll(root);
  } else if (action === 'remove') {
    cs.rows.splice(i, 1);
    saveDraft();
    paintAll(root);
  } else if (action === 'up' || action === 'down') {
    const j = action === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= cs.rows.length) return;
    [cs.rows[i], cs.rows[j]] = [cs.rows[j], cs.rows[i]];
    saveDraft();
    paintAll(root);
    root.querySelector(`[data-cit-action="${action}"][data-row="${j}"]`)?.focus();
  } else if (action === 'log') {
    cs.logOpener = btn.dataset.opener === 'you' ? 'you' : 'citadel';
    const open = root.querySelector('.citadel-log')?.open;
    paintResults(root, analyze(root));
    const again = root.querySelector('.citadel-log');
    if (again && open) again.open = true;
  } else if (action === 'save') {
    await savePreset(root);
  } else if (action === 'delete') {
    await deletePreset(root);
  }
}

async function savePreset(root) {
  if (!cs.rows.length) {
    await notify(t('Add some troops first.'), t('Nothing to save'));
    return;
  }
  const current = cs.presets.find((p) => `saved:${p.id}` === cs.selectedPreset);
  const name = await promptDialog(t('Name this army. Saving under an existing name replaces it.'), {
    title: t('Save army'), defaultValue: current?.name ?? '', confirmLabel: t('Save'),
  });
  if (name === null || !String(name).trim()) return;
  try {
    const res = await apiPut('/tools/citadel-presets', {
      name: String(name).trim(),
      data: {
        citadelId: cs.citadelId,
        rows: cs.rows.map((r) => ({ troopId: r.troopId, count: r.count, strengthPct: r.strengthPct, healthPct: r.healthPct })),
      },
    });
    if (res?.error) {
      await notify(res.error, t('Could not save'));
      return;
    }
    cs.presets = res.presets ?? cs.presets;
    cs.selectedPreset = `saved:${res.preset.id}`;
    cs.bonusesFrom = res.preset.name;
    cs.bonusesAt = res.preset.updatedAt;
    saveDraft();
    paintAll(root);
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    // notify()/confirmDialog() escape their message themselves.
    await notify(t('Could not save: {error}', { error: err?.message || err }), t('Could not save'));
  }
}

async function deletePreset(root) {
  const p = cs.presets.find((x) => `saved:${x.id}` === cs.selectedPreset);
  if (!p) return;
  const ok = await confirmDialog(t('Delete the saved army “{name}”?', { name: p.name }), { title: t('Delete army'), confirmLabel: t('Delete'), danger: true });
  if (!ok) return;
  try {
    const res = await apiDelete(`/tools/citadel-presets/${p.id}`);
    if (res?.error) {
      await notify(res.error, t('Could not delete'));
      return;
    }
    cs.presets = res.presets ?? cs.presets.filter((x) => x.id !== p.id);
    cs.selectedPreset = '';
    paintTop(root);
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    await notify(t('Could not delete: {error}', { error: err?.message || err }), t('Could not delete'));
  }
}
