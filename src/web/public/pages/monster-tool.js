// Tools → Monsters: any monster target the game has — Common to Epic squads,
// bosses, the Tin Man, raids, vaults, citadels — and the fight played out for
// both coin flips (docs/monster-simulator.md).
//
// Everything about the target comes from the game's own files
// (GET /api/tools/battle-data, rebuilt each patch; lib/monster-army.js); the
// fight is the engine Citadel uses (lib/battle-sim.js). What the player brings:
// troops and their bonuses, typed in, filled in from one of their shared
// battles, or SUGGESTED from their battles — every troop they sent in the last
// week, never more than they sent in one battle, sized by the count search for
// the fewest losses. The army and settings are kept in this browser.

import { loadGameArt, unitIconHtml } from '../lib/game-art.js';
import { api } from '../lib/api.js';
import { esc, notify, contentModal, copyTextToClipboard, formatRelativeTime } from '../lib/ui.js';
import { errorStateHtml, wireRetry } from '../lib/ui-kit.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { simulateBothArmies, optimizeArmy } from '../lib/battle-sim.js';
import { outcomeHtml, strikeLogHtml } from '../lib/battle-result.js';
import {
  UNIT_GROUPS, PROTECTED_KINDS, unitDefs, fieldableUnits, unitLevel, targetFamilies,
  targetOfReport, hasEventMonsters, withEventBonus, bonusesFromBattle, armyFromBattles,
  targetCommand, battleCommand,
} from '../lib/monster-army.js';
import { tierUnlocked, tierInWindow } from '../lib/citadel-sim.js';
import { openTroopPicker, closeTroopPicker } from '../lib/troop-picker.js';
import { pickBattleReport, reportChoiceLabel, loadReportArmies } from '../lib/report-picker.js';
import { NO_LEVELS, levelsHtml, applyLevelChange, saveLevels, levelKindLabel } from '../lib/troop-levels.js';
import { parseBonus } from './citadel-tool.js';

const DRAFT_KEY = 'tbcc.monsters.draft.v1';
const SEARCH_DELAY_MS = 350;
/** The count search stops improving after this long (a phone, a big suggested army). */
const SEARCH_TIME_MS = 2500;
/** Bonuses older than this get an amber "check them" nudge. */
const STALE_MS = 6 * 3600 * 1000;

const GROUP_LABELS = {
  guardsmen: t('Guardsmen'),
  specialists: t('Specialists'),
  monsters: t('Monsters'),
  mercenaries: t('Mercenaries'),
  siege: t('Siege engines'),
};
const TARGET_GROUP_LABELS = {
  common: t('Common squads'),
  rare: t('Rare squads'),
  heroic: t('Heroic squads'),
  legendary: t('Legendary squads'),
  epic: t('Epic squads and bosses'),
  raid: t('Raids'),
  vault: t('Vaults'),
  citadel: t('Citadels'),
  other: t('Other'),
};

/** Module state — rebuilt on every page render. */
let ms = null;

const defOf = (id) => ms?.defs.get(String(id)) ?? null;
const unitName = (id) => tGame(defOf(id)?.name ?? String(id));
const icon = (id, size, cls = '') => unitIconHtml(defOf(id), unitName(id), { size, cls });
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** "G8", "M5"…; a mercenary sharing its name with another gets its tier ("Bull Rider V" and "IX"). */
function unitTagHtml(id) {
  const d = defOf(id);
  if (!d) return '';
  const lvl = unitLevel(d);
  if (lvl) return `<span class="citadel-pop-level" title="${esc(`${levelKindLabel(lvl[0])} ${lvl[1]}`)}">${lvl[0].toUpperCase()}${lvl[1]}</span>`;
  if (ms.sameName.has(d.name) && d.tier) return `<span class="citadel-pop-level">${ROMAN[d.tier] ?? d.tier}</span>`;
  return '';
}

const num = (v) => (Number.isFinite(v) ? v : null);

function fmtBonus(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  const s = String(v);
  return ms?.decimalComma ? s.replace('.', ',') : s;
}

// ─── Draft ───────────────────────────────────────────────────────

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
    if (!d || typeof d !== 'object') return null;
    return {
      target: d.target && typeof d.target.name === 'string' ? { name: d.target.name, level: Number(d.target.level) || 0, variant: Number(d.target.variant) || 0 } : null,
      rows: Array.isArray(d.rows) ? d.rows.map((r) => ({
        unitId: String(r?.unitId ?? ''),
        count: Number.isInteger(r?.count) && r.count >= 0 ? r.count : 0,
        strengthPct: num(r?.strengthPct),
        healthPct: num(r?.healthPct),
        cap: Number.isInteger(r?.cap) && r.cap >= 0 ? r.cap : null,
      })) : [],
      countMode: d.countMode === 'manual' ? 'manual' : 'auto',
      eventPct: num(d.eventPct),
      bonusesAt: typeof d.bonusesAt === 'string' ? d.bonusesAt : null,
      bonusesNote: typeof d.bonusesNote === 'string' ? d.bonusesNote : null,
      decimalComma: d.decimalComma === true,
      suggestPlayer: Number.isFinite(Number(d.suggestPlayer)) && d.suggestPlayer !== null ? Number(d.suggestPlayer) : null,
      suggestedFrom: d.suggestedFrom && typeof d.suggestedFrom.label === 'string' && typeof d.suggestedFrom.at === 'string'
        ? { label: d.suggestedFrom.label, at: d.suggestedFrom.at, lead: typeof d.suggestedFrom.lead === 'string' ? d.suggestedFrom.lead : null, matched: d.suggestedFrom.matched !== false }
        : null,
    };
  } catch {
    return null;
  }
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      target: ms.target, rows: ms.rows, countMode: ms.countMode, eventPct: ms.eventPct,
      bonusesAt: ms.bonusesAt, bonusesNote: ms.bonusesNote, decimalComma: ms.decimalComma, suggestPlayer: ms.suggestPlayer, suggestedFrom: ms.suggestedFrom,
    }));
  } catch { /* private mode: the draft just isn't kept */ }
}

// ─── Render ──────────────────────────────────────────────────────

export async function renderMonsterTool(mount) {
  closeTroopPicker();
  await loadGameArt();
  let data;
  try {
    data = await api('/tools/battle-data');
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
    data = null;
  }
  if (!data?.units || !Array.isArray(data.targets)) {
    mount.innerHTML = errorStateHtml(t('The game\'s monster data could not be loaded.'), data?.error ?? '');
    wireRetry(mount, () => renderMonsterTool(mount));
    return;
  }
  const defs = unitDefs(data);
  const draft = loadDraft();
  const names = new Map();
  for (const d of fieldableUnits(defs)) names.set(d.name, (names.get(d.name) ?? 0) + 1);
  ms = {
    data,
    defs,
    families: targetFamilies(data),
    troops: fieldableUnits(defs),
    sameName: new Set([...names].filter(([, n]) => n > 1).map(([n]) => n)),
    target: draft?.target ?? null,
    // `defs`, not defOf(): ms isn't set yet while this object is built.
    rows: (draft?.rows ?? []).filter((r) => defs.get(r.unitId)?.kind),
    countMode: draft?.countMode ?? 'auto',
    eventPct: draft?.eventPct ?? null,
    bonusesAt: draft?.bonusesAt ?? null,
    bonusesNote: draft?.bonusesNote ?? null,
    decimalComma: draft?.decimalComma ?? false,
    /** The viewer's own linked players (Suggest picks one), and which one. */
    ownPlayers: [],
    suggestPlayer: draft?.suggestPlayer ?? null,
    /** The battle the rows were suggested from ({ label, at }), shown above them; null for rows typed or filled in. */
    suggestedFrom: draft?.suggestedFrom ?? null,
    levels: { ...NO_LEVELS },
    logOpener: 'enemy',
    search: null,
  };
  if (!currentTarget()) {
    // A level a patch removed: the same target's nearest level, else the first target.
    const fam = ms.target ? familyOf(ms.target.name) : null;
    ms.target = fam ? { name: fam.name, level: nearestLevel(fam, ms.target.level), variant: 0 } : defaultTarget();
  }
  mount.innerHTML = `
    <div class="citadel-tool monster-tool">
      <div class="citadel-top-slot"></div>
      <div class="citadel-army-slot"></div>
      <div class="citadel-results" aria-live="polite"></div>
      ${howItWorksHtml()}
    </div>`;
  const root = mount.querySelector('.monster-tool');
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  paintAll(root);
  try {
    const res = await api('/tools/citadel-levels');
    if (res?.levels) ms.levels = { ...ms.levels, ...res.levels };
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
  }
  if (root.isConnected) paintAll(root);
  // The viewer's own players, for Suggest's player select (several linked accounts have different armies).
  const own = await loadReportArmies();
  if (!ms || !root.isConnected) return;
  ms.ownPlayers = (own?.players ?? []).filter((p) => p.own);
  if (!ms.ownPlayers.some((p) => p.playerId === ms.suggestPlayer)) ms.suggestPlayer = ms.ownPlayers[0]?.playerId ?? null;
  const slot = root.querySelector('.monster-player-slot');
  if (slot) slot.innerHTML = playerSelectHtml();
}

/** The first Common squad's lowest level: something to look at before a choice. */
function defaultTarget() {
  const fam = ms.families[0]?.families[0];
  return fam ? { name: fam.name, level: fam.levels[0].level, variant: 0 } : null;
}

/** The family's level closest to `want`. */
function nearestLevel(fam, want) {
  return fam.levels.reduce((best, l) => (Math.abs(l.level - want) < Math.abs(best - want) ? l.level : best), fam.levels[0].level);
}

function familyOf(name) {
  for (const g of ms.families) for (const f of g.families) if (f.name === name) return f;
  return null;
}

/** The target picked (a battle-data target), or null. */
function currentTarget() {
  const f = ms?.target ? familyOf(ms.target.name) : null;
  const lvl = f?.levels.find((l) => l.level === ms.target.level);
  return lvl ? lvl.variants[Math.min(ms.target.variant ?? 0, lvl.variants.length - 1)] : null;
}

// ─── What is worked out ──────────────────────────────────────────

const enemyArmy = (target) => target.army.map(([u, n]) => ({ def: defOf(u), count: n }));
const eventOn = (target) => hasEventMonsters(target, ms.defs);
const rowDef = (r, target) => withEventBonus(defOf(r.unitId), eventOn(target) ? ms.eventPct : 0);

function searchKey(target) {
  return JSON.stringify([target?.ids?.[0], ms.eventPct, ms.rows.map((r) => [r.unitId, r.strengthPct, r.healthPct, r.cap])]);
}

let searchTimer = null;
function scheduleSearch(root, target) {
  clearTimeout(searchTimer);
  const key = searchKey(target);
  searchTimer = setTimeout(() => {
    if (!ms || searchKey(currentTarget()) !== key || !root.isConnected) return;
    const prot = (r) => PROTECTED_KINDS.has(defOf(r.unitId).kind);
    const res = optimizeArmy({
      army: ms.rows.map((r) => ({
        def: rowDef(r, target), strengthPct: r.strengthPct, healthPct: r.healthPct,
        // What a loss costs: the gold to revive it (the game's own price), else its health.
        protected: prot(r), cap: r.cap ?? undefined, weight: defOf(r.unitId).revive,
      })),
      enemy: enemyArmy(target),
      // Also from "no mercenaries or monsters at all": they join only where the rest can't win.
      starts: [ms.rows.map((r) => r.count), ms.rows.map((r) => (prot(r) ? 0 : r.cap ?? r.count))],
      timeLimitMs: SEARCH_TIME_MS,
      // Mercenaries and monsters judged on the worse coin flip: none lost either way, wherever that can be done.
      worstCase: true,
    });
    ms.search = { key, ok: res.ok, counts: res.counts };
    refresh(root);
  }, SEARCH_DELAY_MS);
}

function analyze(root) {
  const target = currentTarget();
  const auto = ms.countMode === 'auto';
  const strengthMissing = [];
  ms.rows.forEach((r, i) => { if ((auto || r.count > 0) && r.strengthPct === null) strengthMissing.push(i); });
  const healthNeeded = new Map();
  let pending = false;
  let failed = false;
  if (target && auto && ms.rows.length && !strengthMissing.length) {
    if (ms.search?.key === searchKey(target)) {
      ms.search.counts.forEach((n, i) => { if (ms.rows[i]) ms.rows[i].count = n; });
      failed = !ms.search.ok;
    } else {
      pending = true;
      if (root) scheduleSearch(root, target);
    }
  }
  let both = null;
  if (target && !pending && !failed && !strengthMissing.length && ms.rows.some((r) => r.count > 0)) {
    both = simulateBothArmies({
      mine: ms.rows.map((r, index) => ({ def: rowDef(r, target), count: r.count, strengthPct: r.strengthPct, healthPct: r.healthPct, index })),
      theirs: enemyArmy(target),
    });
    for (const res of [both.you, both.enemy]) {
      for (const s of res.army) {
        if (!s.healthUnknown || !s.wasHit) continue;
        const hitters = new Set(healthNeeded.get(s.index) || []);
        for (const k of res.strikes) if (k.side !== 'you' && k.target === s.troopId) hitters.add(defOf(k.actor)?.name ?? '');
        healthNeeded.set(s.index, [...hitters].filter(Boolean));
      }
    }
    if (healthNeeded.size) both = null;
  }
  return { target, auto, strengthMissing, healthNeeded, both, pending, failed };
}

function paintAll(root) {
  root.querySelector('.citadel-top-slot').innerHTML = topCardHtml();
  const a = analyze(root);
  root.querySelector('.citadel-army-slot').innerHTML = armyCardHtml(a);
  paintResults(root, a);
}

/** After typing: the worked-out numbers and flags, without replacing the box in use. */
function refresh(root) {
  const a = analyze(root);
  const focused = document.activeElement;
  ms.rows.forEach((r, i) => {
    const count = root.querySelector(`[data-row="${i}"][data-field="count"]`);
    if (count && count !== focused) count.value = a.auto && (a.pending || a.strengthMissing.length) ? '' : String(r.count);
    const strength = root.querySelector(`[data-row="${i}"][data-field="strengthPct"]`);
    strength?.classList.toggle('is-missing', a.strengthMissing.includes(i));
    if (strength && strength !== focused) strength.value = fmtBonus(r.strengthPct);
    const health = root.querySelector(`[data-row="${i}"][data-field="healthPct"]`);
    if (health && health !== focused) health.value = fmtBonus(r.healthPct);
    if (health) {
      health.classList.toggle('is-missing', a.healthNeeded.has(i));
      health.placeholder = a.healthNeeded.has(i) ? t('needed') : a.both ? t('not hit') : t('if hit');
    }
    const note = root.querySelector(`[data-note-row="${i}"]`);
    if (note) note.textContent = rowNote(i, a);
  });
  const note = root.querySelector('.monster-bonus-note');
  if (note) note.outerHTML = bonusesNoteHtml();
  const unused = root.querySelector('.monster-unused-slot');
  if (unused) unused.innerHTML = unusedHtml(a);
  paintResults(root, a);
  saveDraft();
}

// ─── 1 · The target ──────────────────────────────────────────────

function topCardHtml() {
  const target = currentTarget();
  const fam = target ? familyOf(target.name) : null;
  // Two selects, so neither gets long: the type (Common, Rare, Epic…), then the target of that type.
  const group = ms.families.find((g) => g.families.includes(fam)) ?? ms.families[0];
  const types = ms.families.map((g) => `<option value="${esc(g.group)}" ${g === group ? 'selected' : ''}>${esc(TARGET_GROUP_LABELS[g.group])}</option>`).join('');
  const families = (group?.families ?? []).map((f) => `<option value="${esc(f.name)}" ${f.name === target?.name ? 'selected' : ''}>${esc(tGame(f.name))}</option>`).join('');
  const levels = (fam?.levels ?? []).map((l) => `<option value="${l.level}" ${l.level === target?.level ? 'selected' : ''}>${esc(t('Level {n}', { n: l.level }))}</option>`).join('');
  const lvl = fam?.levels.find((l) => l.level === target?.level);
  const variants = lvl && lvl.variants.length > 1
    ? `<label class="monster-target-field"><span>${t('Version')}</span>
        <select class="input" data-mon="variant">${lvl.variants.map((v, i) => `<option value="${i}" ${v === target ? 'selected' : ''}>${esc(t('Version {n}', { n: i + 1 }))} · ${esc(v.army.map(([u, n]) => `${formatCount(n)} ${tGame(defOf(u)?.name ?? '')}`).join(', '))}</option>`).join('')}</select></label>`
    : '';
  const inside = target
    ? target.army.map(([u, n]) => `<span class="citadel-defender">${icon(u, 22, 'citadel-icon-sm')}<strong>${n.toLocaleString()}</strong> ${esc(unitName(u))}</span>`).join('')
    : '';
  return `
    <div class="ui-tile tool-tile citadel-top">
      <h2 class="citadel-step"><span class="citadel-step-num" aria-hidden="true">1</span>${t('Pick the target')}</h2>
      <div class="monster-target-row">
        <label class="monster-target-field monster-target-type"><span>${t('Type')}</span>
          <select class="input" data-mon="type">${types}</select></label>
        <label class="monster-target-field monster-target-name"><span>${t('Target')}</span>
          <select class="input" data-mon="family">${families}</select></label>
        <label class="monster-target-field"><span>${t('Level')}</span>
          <select class="input" data-mon="level">${levels}</select></label>
        ${variants}
      </div>
      ${target ? `<p class="citadel-inside"><span class="citadel-inside-label">${t('Inside')}</span>${inside}</p>
        <p class="citadel-inside monster-led"><span class="citadel-inside-label">${t('Attack')}</span>${esc(ledByText(target))}</p>` : ''}
      ${lvl && lvl.variants.length > 1 ? `<p class="citadel-note muted-copy">${t('The game keeps more than one version of this level. Pick the one whose army you see on the map.')}</p>` : ''}
      ${levelsHtml(ms.levels)}
    </div>`;
}

const formatCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n.toLocaleString());

/** "Led by the Hero alone" … — who may lead an attack on the target (the game's own rule). */
function ledByText(target) {
  const n = target?.captains ?? 0;
  switch (targetCommand(target)) {
    case 'hero': return t('Led by the Hero alone: no captains.');
    case 'both': return tn(n, 'Led by the Hero, with up to {n} captain.', 'Led by the Hero, with up to {n} captains.');
    case 'captains': return tn(n, 'Led by {n} captain; the Hero can\'t attack it.', 'Led by up to {n} captains; the Hero can\'t attack it.');
    default: return '';
  }
}

// ─── 2 · Your army ───────────────────────────────────────────────

function bonusesNoteHtml() {
  const base = t('Type each troop\'s strength bonus from its card, read with the captains you will march with; health only where it says “needed”. Or fill them in from one of your shared battles, or let your latest battle suggest the army.');
  if (!ms.bonusesAt) return `<p class="citadel-note monster-bonus-note">${base}</p>`;
  const stale = Date.now() - new Date(ms.bonusesAt).getTime() > STALE_MS;
  const when = esc(formatRelativeTime(ms.bonusesAt));
  const from = ms.bonusesNote
    ? t('Bonuses from {source}, {when}.', { source: esc(ms.bonusesNote), when })
    : t('Bonuses entered {when}.', { when });
  return `<p class="citadel-note monster-bonus-note">${base} <span class="${stale ? 'tool-warn' : 'citadel-note-when'}">${stale ? '⚠ ' : ''}${from}</span></p>`;
}

/**
 * Which battle the suggested army came from, said plainly above the rows: the
 * player's latest, with its target, day and age (⚠ once it is older than
 * STALE_MS — troops trained or lost since aren't in it).
 */
function suggestedFromHtml() {
  const s = ms?.suggestedFrom;
  if (!s || !ms.rows.length) return '';
  const stale = Date.now() - new Date(s.at).getTime() > STALE_MS;
  const off = s.matched === false;
  const head = off ? t('Army from your latest battle, led differently from this attack')
    : s.lead === 'hero' ? t('Army from your latest Hero-led battle')
      : s.lead === 'captains' ? t('Army from your latest captain-led battle')
        : s.lead === 'both' ? t('Army from your latest battle led by the Hero with captains')
          : t('Army from your latest battle');
  return `<p class="monster-source ${stale || off ? 'is-stale' : ''}" role="status">
      <span class="monster-source-head">${stale || off ? '⚠' : '✓'} ${head}</span>
      <span class="monster-source-what">${esc(s.label)} · ${esc(formatRelativeTime(s.at))}${stale ? ` · ${t('troops trained or lost since then are not in it')}` : ''}</span>
    </p>`;
}

/** Which of the viewer's linked players Suggest reads (only when there is more than one). */
function playerSelectHtml() {
  if ((ms?.ownPlayers?.length ?? 0) < 2) return '';
  const opts = ms.ownPlayers.map((p) => `<option value="${p.playerId}" ${p.playerId === ms.suggestPlayer ? 'selected' : ''}>${esc(p.name || t('Unknown player'))} · ${esc(tn(p.battles, '{n} battle', '{n} battles'))}</option>`).join('');
  return `<label class="monster-player-field"><span class="visually-hidden">${esc(t('Player'))}</span>
    <select class="input" data-mon="player">${opts}</select></label>`;
}

function countModeHtml() {
  const btn = (mode, label, title) => `<button type="button" class="citadel-seg ${ms.countMode === mode ? 'is-active' : ''}" data-mon-action="count-mode" data-mode="${mode}" aria-pressed="${ms.countMode === mode}" title="${esc(title)}">${label}</button>`;
  return `
    <div class="citadel-count-mode" role="group" aria-label="${esc(t('Counts'))}">
      <span class="citadel-count-mode-label">${t('Counts')}</span>
      ${btn('auto', t('Auto'), t('The simulator searches the counts that win with the fewest losses, with a 3% safety margin on your bonuses'))}
      ${btn('manual', t('Manual'), t('You type the counts yourself'))}
    </div>`;
}

function eventFieldHtml(target) {
  if (!target || !eventOn(target)) return '';
  return `
    <label class="monster-event-field">
      <span>${t('Extra strength against these event monsters %')}</span>
      <input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" class="input citadel-num" data-field="eventPct"
        value="${esc(fmtBonus(ms.eventPct))}" placeholder="0">
      <small class="muted-copy">${t('Some events give your army extra strength against their own monsters (+450% on Epic Fenrir squads in Nov 2026). A battle against this target fills it in.')}</small>
    </label>`;
}

function unusedHtml(a) {
  if (!a.auto || a.pending || a.failed || a.strengthMissing.length) return '';
  const n = ms.rows.filter((r) => r.count === 0).length;
  return n ? `<button type="button" class="btn btn-sm btn-ghost" data-mon-action="drop-unused">${tn(n, 'Remove the troop not needed', 'Remove the {n} troops not needed')}</button>` : '';
}

function armyCardHtml(a) {
  const rows = ms.rows.map((r, i) => rowHtml(r, i, a)).join('');
  return `
    <div class="ui-tile tool-tile citadel-army">
      <div class="ui-tile-head">
        <h2 class="citadel-step"><span class="citadel-step-num" aria-hidden="true">2</span>${t('Your army')}<span class="citadel-step-hint">${t('you fill this in')}</span></h2>
        ${countModeHtml()}
      </div>
      <div class="tool-tile-body">
        ${bonusesNoteHtml()}
        ${suggestedFromHtml()}
        <div class="citadel-from-report monster-army-actions">
          <span class="monster-player-slot">${playerSelectHtml()}</span>
          <button type="button" class="btn btn-sm btn-primary" data-mon-action="suggest">${t('Suggest an army from my latest battle')}</button>
          <button type="button" class="btn btn-sm" data-mon-action="from-report">${t('Fill in from a battle report')}</button>
        </div>
        ${eventFieldHtml(a.target)}
        <p class="citadel-note citadel-count-note">${a.auto
          ? t('Counts: searched by the simulator for the fewest losses with your troops and bonuses. Monsters and mercenaries are kept alive wherever any count can do it. Wins even with every bonus 3% lower. A suggested troop never goes above what your latest battle had.')
          : t('Counts: you type them.')}</p>
        ${ms.rows.length ? `
          <div class="citadel-rows" role="list">
            <div class="citadel-row citadel-row-head" aria-hidden="true">
              <span class="citadel-head-troop">${t('Troop')}</span>
              <span>${t('Count')}<small>${a.auto ? t('worked out') : t('you type')}</small></span>
              <span>${t('Strength %')}<small>${t('from the troop card')}</small></span>
              <span>${t('Health %')}<small>${t('only if hit')}</small></span>
              <span></span>
            </div>
            ${rows}
          </div>` : `<p class="citadel-empty muted-copy">${t('Add the troops you will send, or let your latest battle suggest an army.')}</p>`}
        <div class="citadel-add">
          <button type="button" class="btn btn-sm citadel-add-btn" data-pick="add" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(t('Add a troop'))}">${t('+ Add a troop…')}</button>
          <span class="monster-unused-slot">${unusedHtml(a)}</span>
        </div>
      </div>
    </div>`;
}

function rowNote(i, a) {
  const r = ms.rows[i];
  const d = defOf(r?.unitId);
  if (!d) return '';
  const notes = [];
  const lvl = unitLevel(d);
  if (lvl && !tierUnlocked(lvl, ms.levels)) notes.push(t('needs {kind} {n}', { kind: levelKindLabel(lvl[0]), n: lvl[1] }));
  if (r.cap !== null && r.cap !== undefined) notes.push(t('{n} in your latest battle', { n: r.cap.toLocaleString() }));
  if (a.auto && !a.pending && !a.failed && !a.strengthMissing.length && r.count === 0) notes.push(t('none needed'));
  return notes.join(' · ');
}

function rowHtml(r, i, a) {
  const name = unitName(r.unitId);
  const countUnknown = a.auto && (a.pending || a.strengthMissing.length > 0 || r.strengthPct === null);
  const field = (key, value, label, { cls = '', placeholder = '', readonly = false, title = '' } = {}) => `
    <label class="citadel-field" data-label="${esc(label)}">
      <span class="visually-hidden">${esc(t('{troop}: {field}', { troop: name, field: label }))}</span>
      <input ${key === 'count' ? 'type="number" step="1" min="0" inputmode="numeric"' : 'type="text" inputmode="decimal" autocomplete="off" spellcheck="false"'}
        class="input citadel-num ${cls}" data-row="${i}" data-field="${key}"
        value="${key === 'count' ? (value ?? '') : esc(fmtBonus(value))}" placeholder="${esc(placeholder)}" ${readonly ? 'readonly tabindex="-1"' : ''} ${title ? `title="${esc(title)}"` : ''}>
    </label>`;
  const health = a.healthNeeded.has(i) ? t('needed') : a.both ? t('not hit') : t('if hit');
  return `
    <div class="citadel-row" role="listitem" data-row="${i}">
      <span class="citadel-troop">
        <button type="button" class="citadel-troop-btn" data-pick="${i}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(t('{troop}: change troop', { troop: name }))}">
          ${icon(r.unitId, 36, 'citadel-icon')}
          <span class="citadel-troop-text"><span class="citadel-troop-name">${esc(name)}${unitTagHtml(r.unitId)}</span><span class="citadel-troop-note" data-note-row="${i}">${esc(rowNote(i, a))}</span></span>
          <span class="citadel-caret" aria-hidden="true"></span>
        </button>
      </span>
      ${field('count', countUnknown ? '' : r.count, t('Count'), a.auto
        ? { cls: 'is-auto', placeholder: a.pending ? '…' : '—', readonly: true, title: t('Searched by the simulator from your bonuses. Switch Counts to Manual to change it.') }
        : { placeholder: '0' })}
      ${field('strengthPct', r.strengthPct, t('Strength %'), { cls: a.strengthMissing.includes(i) ? 'is-missing' : '', placeholder: t('from card') })}
      ${field('healthPct', r.healthPct, t('Health %'), { cls: a.healthNeeded.has(i) ? 'is-missing' : '', placeholder: health })}
      <span class="citadel-row-actions">
        <button type="button" class="citadel-icon-btn is-remove" data-mon-action="remove" data-row="${i}" aria-label="${esc(t('Remove {troop}', { troop: name }))}">✕</button>
      </span>
    </div>`;
}

// ─── 3 · Result ──────────────────────────────────────────────────

const view = {
  name: (id) => unitName(id),
  icon: (id, side, size) => icon(id, size, 'citadel-icon-sm'),
  roundEnemy: (n) => t('Round {n} — the monsters strike first', { n }),
};

function paintResults(root, a) {
  const el = root.querySelector('.citadel-results');
  if (!el) return;
  if (!ms.rows.length || !a.target) {
    el.innerHTML = '';
    return;
  }
  const title = `<h2 class="citadel-step citadel-result-title"><span class="citadel-step-num" aria-hidden="true">3</span>${t('Result')}<span class="citadel-step-hint">${t('worked out as you type')}</span></h2>`;
  const asks = [];
  if (a.strengthMissing.length) {
    asks.push(t('Enter the strength bonus for: {troops}.', { troops: a.strengthMissing.map((i) => `<strong>${esc(unitName(ms.rows[i].unitId))}</strong>`).join(', ') }));
  }
  for (const [i, why] of a.healthNeeded) {
    asks.push(t('Enter the health bonus for {troop}: it gets hit by {attackers}.', {
      troop: `<strong>${esc(unitName(ms.rows[i].unitId))}</strong>`,
      attackers: why.map((n) => esc(tGame(n))).join(', '),
    }));
  }
  if (asks.length) {
    el.innerHTML = `${title}<div class="ui-tile tool-tile citadel-waiting">${asks.map((x) => `<p>${x}</p>`).join('')}
      <p class="muted-copy">${t('The result needs these from your own troop cards — they decide every number.')}</p></div>`;
    return;
  }
  if (a.pending) {
    el.innerHTML = `${title}<div class="ui-tile tool-tile citadel-waiting"><p>${t('Working out the counts…')}</p></div>`;
    return;
  }
  if (a.failed) {
    el.innerHTML = `${title}<div class="ui-tile tool-tile citadel-waiting is-bad">
      <p>${t('These troops can\'t beat {target} in one attack in both coin flips, even with all you sent.', { target: `<strong>${esc(tGame(a.target.name))}</strong>` })}</p>
      <p class="muted-copy">${t('Epic squads and bosses are hit many times, by many players. Switch Counts to Manual to see what one attack of yours does, or size the stacks in Tools → Stacks.')}</p>
      <p><button type="button" class="btn btn-sm" data-mon-action="count-mode" data-mode="manual">${t('Switch to Manual')}</button></p></div>`;
    return;
  }
  if (!a.both) {
    el.innerHTML = `${title}<div class="ui-tile tool-tile citadel-waiting"><p>${t('Enter how many of each troop you send.')}</p></div>`;
    return;
  }
  const lostOf = (res) => res.army.reduce((x, s) => x + s.lost, 0);
  const avg = Math.round(((lostOf(a.both.you) + lostOf(a.both.enemy)) / 2) * 10) / 10;
  const youTitle = t('If you strike first');
  const enemyTitle = t('If the monsters strike first');
  const shown = a.both[ms.logOpener] ?? a.both.enemy;
  el.innerHTML = `<div class="citadel-result-head">${title}
      <button type="button" class="btn btn-primary citadel-march-btn" data-mon-action="march">${t('March list')}</button>
    </div>
    <div class="citadel-outcomes">
      ${outcomeHtml(a.both.you, { title: youTitle, opener: 'you', selected: ms.logOpener === 'you', view, action: 'mon-action' })}
      ${outcomeHtml(a.both.enemy, { title: enemyTitle, opener: 'enemy', selected: ms.logOpener !== 'you', view, action: 'mon-action' })}
    </div>
    <p class="citadel-avg muted-copy">${t('Who strikes first is a coin flip. Average: {lost}.', { lost: avg === 0 ? t('no losses') : tn(avg, '{n} troop lost', '{n} troops lost', { n: avg.toLocaleString() }) })}
      ${t('Luck (double damage, hitting two squads, a blocked strike) is not included.')}</p>
    ${strikeLogHtml(shown, { title: ms.logOpener === 'you' ? youTitle : enemyTitle, view, sectionKey: 'tools-monsters-log' })}`;
}

function howItWorksHtml() {
  return `
    <details class="ui-fold" data-section-key="tools-monsters-howto">
      <summary class="ui-fold-head"><h2 class="ui-tile-title">${t('How this works')}</h2></summary>
      <div class="ui-fold-body tool-howto">
        <ul>
          <li>${t('<strong>The target.</strong> Every monster army and every unit\'s strength, health and “vs” features come from the game\'s own files, read again after every game patch. Monsters fight at exactly those numbers.')}</li>
          <li>${t('<strong>The fight.</strong> The same rules as Tools → Citadel, checked against over 370,000 strikes of the clan\'s shared battle reports: the strongest stack acts first, each stack hits where it deals the most damage, and wounds stay all battle.')}</li>
          <li>${t('<strong>Suggest an army.</strong> Your latest shared battle tells which troops you have now, how many, and their bonuses with the captains you marched with. Share a report before you plan. The search picks counts from that army for the fewest losses; monsters and mercenaries are kept alive wherever it can.')}</li>
          <li>${t('<strong>Epic squads and bosses</strong> are not killed in one attack. Manual counts show what your attack does: what you lose, in what order, and how much of the army it kills.')}</li>
        </ul>
        <p class="muted-copy">${t('Not included: luck, the 10% less damage Corruption monsters take, and Exiles\' Grove, whose defenders don\'t fight at their listed numbers.')}</p>
      </div>
    </details>`;
}

// ─── Events ──────────────────────────────────────────────────────

function onInput(e) {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !el.dataset.field || el.readOnly) return;
  const root = el.closest('.monster-tool');
  const raw = el.value.trim();
  if (/,/.test(raw)) ms.decimalComma = true;
  else if (/\./.test(raw)) ms.decimalComma = false;
  if (el.dataset.field === 'eventPct') {
    const v = parseBonus(raw);
    ms.eventPct = v === null ? null : Math.min(Math.max(v, 0), 1_000_000);
    refresh(root);
    return;
  }
  const row = ms.rows[Number(el.dataset.row)];
  if (!row) return;
  if (el.dataset.field === 'count') {
    const n = Math.floor(Number(raw));
    row.count = raw === '' || !Number.isFinite(n) || n < 0 ? 0 : Math.min(n, 100_000_000);
  } else {
    const v = parseBonus(raw);
    row[el.dataset.field] = v === null ? null : Math.min(Math.max(v, -100), 1_000_000);
    ms.bonusesAt = new Date().toISOString();
    ms.bonusesNote = null;
  }
  refresh(root);
}

function onChange(e) {
  const el = e.target;
  const root = el.closest('.monster-tool');
  if (el instanceof HTMLSelectElement && applyLevelChange(ms.levels, el)) {
    paintAll(root);
    root.querySelector(`[data-level-kind="${el.dataset.levelKind}"]`)?.focus();
    saveLevels(ms.levels).then((saved) => { if (saved && ms) ms.levels = saved; });
    return;
  }
  if (el instanceof HTMLSelectElement && el.dataset.mon) {
    const which = el.dataset.mon;
    if (which === 'type') {
      // The type's first target, at the level nearest the one picked before.
      const fam = ms.families.find((g) => g.group === el.value)?.families[0];
      if (!fam) return;
      ms.target = { name: fam.name, level: nearestLevel(fam, ms.target?.level ?? fam.levels[0].level), variant: 0 };
    } else if (which === 'family') {
      const fam = familyOf(el.value);
      if (!fam) return;
      // Keep the level when the new family has it, else the nearest one.
      ms.target = { name: fam.name, level: nearestLevel(fam, ms.target?.level ?? fam.levels[0].level), variant: 0 };
    } else if (which === 'level') {
      ms.target = { ...ms.target, level: Number(el.value), variant: 0 };
    } else if (which === 'player') {
      ms.suggestPlayer = Number(el.value) || null;
      saveDraft();
      return;
    } else if (which === 'variant') {
      ms.target = { ...ms.target, variant: Number(el.value) || 0 };
    }
    saveDraft();
    paintAll(root);
    root.querySelector(`[data-mon="${which}"]`)?.focus();
    return;
  }
  if (el instanceof HTMLInputElement && el.dataset.field && !el.readOnly) {
    if (el.dataset.field === 'eventPct') el.value = fmtBonus(ms.eventPct);
    else {
      const row = ms.rows[Number(el.dataset.row)];
      if (row) el.value = el.dataset.field === 'count' ? String(row.count ?? '') : fmtBonus(row[el.dataset.field]);
    }
  }
}

async function onClick(e) {
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    openPicker(pick.closest('.monster-tool'), pick, pick.dataset.pick === 'add' ? 'add' : Number(pick.dataset.pick));
    return;
  }
  const btn = e.target.closest('[data-mon-action]');
  if (!btn) return;
  const root = btn.closest('.monster-tool');
  const action = btn.dataset.monAction;
  if (action === 'count-mode') {
    ms.countMode = btn.dataset.mode === 'manual' ? 'manual' : 'auto';
    saveDraft();
    paintAll(root);
  } else if (action === 'remove') {
    ms.rows.splice(Number(btn.dataset.row), 1);
    saveDraft();
    paintAll(root);
  } else if (action === 'drop-unused') {
    ms.rows = ms.rows.filter((r) => r.count > 0);
    saveDraft();
    paintAll(root);
  } else if (action === 'log') {
    ms.logOpener = btn.dataset.opener === 'you' ? 'you' : 'enemy';
    paintResults(root, analyze(root));
    const log = root.querySelector('.citadel-log');
    if (log) log.open = true;
    root.querySelector(`.citadel-outcome-pick[data-opener="${ms.logOpener}"]`)?.focus();
  } else if (action === 'march') {
    openMarchList(root);
  } else if (action === 'from-report') {
    await fillFromReport(root);
  } else if (action === 'suggest') {
    await suggestArmy(root, btn);
  }
}

// ─── From the player's battles ───────────────────────────────────

/** Pick one battle: an empty army takes that battle's whole army and target; otherwise the rows' bonuses are filled. */
async function fillFromReport(root) {
  const title = t('Fill in from a battle report');
  const picked = await pickBattleReport({
    title,
    intro: t('The bonuses the game used in a battle: pick the player, then the battle. With no troops added yet, the battle\'s whole army and its target are taken, so you can replay it.'),
  });
  if (!picked || !ms) return;
  const { report, reports } = picked;
  const res = bonusesFromBattle(report, reports, ms.defs);
  const target = targetOfReport(ms.data, report.target?.staticId);
  let filled = 0;
  if (!ms.rows.length) {
    const sent = new Map();
    for (const tr of report.troops ?? []) {
      const id = String(tr.unit);
      if (defOf(id)?.kind) sent.set(id, (sent.get(id) ?? 0) + (tr.count || 0));
    }
    ms.suggestedFrom = null;
    ms.rows = [...sent].map(([unitId, count]) => ({
      unitId, count, strengthPct: res.found.get(unitId)?.strengthPct ?? null, healthPct: res.found.get(unitId)?.healthPct ?? null, cap: null,
    }));
    filled = ms.rows.length;
    if (target) {
      const fam = familyOf(target.name);
      const lvl = fam?.levels.find((l) => l.level === target.level);
      ms.target = { name: target.name, level: target.level, variant: Math.max(0, lvl?.variants.indexOf(target) ?? 0) };
    }
    ms.countMode = 'manual';
  } else {
    for (const row of ms.rows) {
      const v = res.found.get(row.unitId);
      if (!v) continue;
      if (v.strengthPct !== null) row.strengthPct = v.strengthPct;
      if (v.healthPct !== null) row.healthPct = v.healthPct;
      filled++;
    }
  }
  const cur = currentTarget();
  if (res.eventPct !== null && cur && target?.name === cur.name && eventOn(cur)) ms.eventPct = Math.max(0, res.eventPct);
  if (!filled) {
    await notify(t('None of the troops in your army fought in that battle, or the report doesn’t show their bonuses.'), title);
    return;
  }
  // A battle led otherwise (the Hero instead of captains, or the other way) had other bonuses.
  const ledOtherwise = cur && report.led && battleCommand(report.led) !== targetCommand(cur);
  ms.bonusesAt = report.at;
  ms.bonusesNote = `${reportChoiceLabel(report)}${report.attacker?.name ? ` · ${report.attacker.name}` : ''}`;
  ms.search = null;
  saveDraft();
  paintAll(root);
  notify([
    tn(filled, 'Filled in {n} troop from the battle report.', 'Filled in {n} troops from the battle report.'),
    ...(res.gapsFrom ? [t('This battle shows no troop exactly, so the part every card has beyond the report came from the battle {battle}.', { battle: reportChoiceLabel(res.gapsFrom) })] : []),
    ...(ledOtherwise ? [t('That battle was led differently from an attack on {target}, so its bonuses may not be the ones you will have: check them.', { target: tGame(cur.name) })] : []),
  ].join(' '), title);
}

/** Every troop of the chosen player's latest battle, capped at what it had, sized by the search. */
async function suggestArmy(root, btn) {
  const title = t('Suggest an army from my latest battle');
  btn.disabled = true;
  let res = null;
  try {
    // That player's battles only: several linked accounts have different armies.
    res = ms.suggestPlayer ? await loadReportArmies(String(ms.suggestPlayer)) : await api('/tools/report-armies');
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
  } finally {
    btn.disabled = false;
  }
  if (!ms || !root.isConnected) return;
  if (!res || !Array.isArray(res.reports)) {
    await notify(t('The battle reports could not be loaded.'), title);
    return;
  }
  if (!res.linked) {
    await notify(t('Your account isn\'t linked to a game player yet. Ask an admin for an invite code, or use “Fill in from a battle report” to pick anyone\'s battle.'), title);
    return;
  }
  const mine = res.reports.filter((r) => (ms.suggestPlayer ? r.attacker?.playerId === ms.suggestPlayer : res.players.some((p) => p.own && p.playerId === r.attacker?.playerId)));
  if (!mine.length) {
    await notify(t('No battle of yours from the last {days} days has been read yet. Share a report in the clan chat, or send it to the scanner account in a private message; it is read within a few minutes.', { days: res.windowDays ?? 7 }), title);
    return;
  }
  // The latest battle alone (the user's rule, Nov 28 2026): what the player
  // has NOW — troops of a week ago may be gone. Share a report before
  // planning. The other battles only fill what it can't show (within a day).
  // The latest battle LED THE WAY THIS TARGET IS (the user, Nov 28 2026): a
  // Rare squad's march is the Hero's, a Common squad's a captain's, and their
  // bonuses and leadership differ — so a player shares one report of each.
  // A Hero-with-captains target takes a Hero-led battle when it has no exact
  // match. With none at all, the latest battle, said so.
  const cur = currentTarget();
  const want = targetCommand(cur);
  const ledAs = (r) => battleCommand(r.led);
  const matched = mine.find((r) => ledAs(r) === want) ?? (want === 'both' ? mine.find((r) => r.led?.hero) : undefined) ?? null;
  const latest = matched ?? mine[0];
  // Gaps are filled only from battles led the same way (the same bonuses).
  const context = mine.filter((r) => ledAs(r) === ledAs(latest));
  const rows = armyFromBattles([latest], ms.defs, context);
  if (!rows.length) {
    await notify(t('Your latest battle shows no troops this page can use.'), title);
    return;
  }
  ms.rows = rows.map((r) => ({ unitId: r.unitId, count: r.cap, strengthPct: r.strengthPct, healthPct: r.healthPct, cap: r.cap }));
  if (cur && eventOn(cur) && targetOfReport(ms.data, latest.target?.staticId)?.name === cur.name) {
    const v = bonusesFromBattle(latest, context, ms.defs).eventPct;
    if (v !== null) ms.eventPct = Math.max(0, v);
  }
  ms.countMode = 'auto';
  ms.search = null;
  ms.bonusesAt = latest.at;
  ms.bonusesNote = `${reportChoiceLabel(latest)}${latest.attacker?.name ? ` · ${latest.attacker.name}` : ''}`;
  ms.suggestedFrom = { label: ms.bonusesNote, at: latest.at, lead: ledAs(latest), matched: !!matched || !cur };
  saveDraft();
  paintAll(root);
  if (cur && !matched) {
    await notify(t('{target}: {how} None of your battles of the last week was led that way, so this is your latest battle, led differently: its bonuses and how many troops you can send may not be what this attack has. Share a report of an attack led that way.', {
      target: tGame(cur.name), how: ledByText(cur),
    }), title);
  }
}

// ─── March list ──────────────────────────────────────────────────

/** The march screen's order: mercenaries, then monsters, then the rest, each strongest first. */
function marchRows() {
  const rank = (d) => (d.kind === 'mercenaries' ? 0 : d.kind === 'monsters' ? 1 : 2);
  return ms.rows.filter((r) => r.count > 0).map((r) => ({ ...r, def: defOf(r.unitId) }))
    .sort((a, b) => rank(a.def) - rank(b.def) || b.def.str - a.def.str || a.def.unit - b.def.unit);
}

function openMarchList(root) {
  const a = analyze(root);
  if (!a.both || !a.target) return;
  const where = `${tGame(a.target.name)} · ${t('Level {n}', { n: a.target.level })}`;
  const list = marchRows();
  const winsBoth = a.both.you.won && a.both.enemy.won;
  const html = `
    <p class="muted-copy citadel-march-intro">${esc(t('In the order the game lists them when you set up the march: go down the list and type each count.'))}</p>
    ${winsBoth ? '' : `<p class="citadel-march-warn">${esc(t('This army does not win in both coin flips. Check the result before you march.'))}</p>`}
    <ol class="citadel-march">
      ${list.map((r) => `<li>${icon(r.unitId, 36)}<span class="citadel-march-name">${esc(unitName(r.unitId))}</span><span class="citadel-march-count">${r.count.toLocaleString()}</span></li>`).join('')}
    </ol>
    <div class="modal-actions"><button type="button" class="btn btn-primary citadel-march-copy">${esc(t('Copy list'))}</button></div>`;
  const modal = contentModal({ title: t('March list: {citadel}', { citadel: where }), html, className: 'citadel-march-modal' });
  if (!modal) return;
  const copy = modal.content.querySelector('.citadel-march-copy');
  copy.addEventListener('click', async () => {
    await copyTextToClipboard([where, ...list.map((r) => `${unitName(r.unitId)} - ${r.count}`)].join('\n'));
    copy.textContent = t('Copied');
    setTimeout(() => { copy.textContent = t('Copy list'); }, 1500);
  });
}

// ─── Troop picker ────────────────────────────────────────────────

function openPicker(root, trigger, target) {
  const current = target === 'add' ? null : ms.rows[target]?.unitId ?? null;
  const taken = new Set(ms.rows.map((r) => r.unitId));
  openTroopPicker({
    trigger,
    troops: ms.troops,
    groups: UNIT_GROUPS.map((g) => [g, GROUP_LABELS[g]]),
    current,
    allow: (d) => !taken.has(d.id) && tierInWindow(unitLevel(d), ms.levels),
    tagHtml: unitTagHtml,
    iconHtml: (d, size) => unitIconHtml(d, tGame(d.name), { size }),
    onPick: (unitId) => {
      if (!defOf(unitId)) return;
      if (target === 'add') ms.rows.push({ unitId, count: 0, strengthPct: null, healthPct: null, cap: null });
      else if (ms.rows[target] && ms.rows[target].unitId !== unitId) Object.assign(ms.rows[target], { unitId, strengthPct: null, healthPct: null, cap: null });
      saveDraft();
      paintAll(root);
      const i = target === 'add' ? ms.rows.length - 1 : target;
      root.querySelector(target === 'add' ? `[data-row="${i}"][data-field="strengthPct"]` : `[data-pick="${i}"]`)?.focus();
    },
  });
}
