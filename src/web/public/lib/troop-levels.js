// "Your levels": the troop tiers an account has unlocked (Guardsmen,
// Specialists, Monsters, Engineers) and how many of the top levels the troop
// picker shows. One set per account, saved on the server
// (/api/tools/citadel-levels), shared by Tools → Citadel and → Stacks.
//
// The window rule itself (troopInWindow) is in citadel-sim.js, with the data.

import { apiPut } from './api.js';
import { esc, notify } from './ui.js';
import { t, tn } from './i18n.js';
import { troopTier, DEFAULT_LEVEL_SPAN, ALL_LEVELS_SPAN } from './citadel-sim.js';

export const LEVEL_KINDS = [
  ['g', t('Guardsmen')],
  ['s', t('Specialists')],
  ['m', t('Monsters')],
  ['e', t('Engineers')],
];
export const levelKindLabel = (k) => LEVEL_KINDS.find(([x]) => x === k)?.[1] ?? k;

/** Nothing chosen yet: every kind "any", the default window. */
export const NO_LEVELS = Object.freeze({ g: null, s: null, m: null, e: null, span: null });

/** How many top levels the picker may show: 1-4, or all of them. */
const SPANS = [1, 2, 3, 4, ALL_LEVELS_SPAN];

/** The levels row: a select per kind, then how many levels to show. */
export function levelsHtml(levels) {
  const selects = LEVEL_KINDS.map(([k, label]) => {
    const v = levels[k];
    const opts = [`<option value="" ${v === null ? 'selected' : ''}>${esc(t('any'))}</option>`]
      .concat([9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${v === n ? 'selected' : ''}>${n}</option>`)).join('');
    return `<label class="citadel-level-field"><span>${esc(label)}</span>
      <select class="input citadel-level-select" data-level-kind="${k}">${opts}</select></label>`;
  }).join('');
  const span = levels.span ?? DEFAULT_LEVEL_SPAN;
  const spanOpts = SPANS.map((n) => {
    const label = n === ALL_LEVELS_SPAN ? t('All levels') : tn(n, 'Top {n} level', 'Top {n} levels', { n });
    return `<option value="${n}" ${span === n ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
  return `<div class="citadel-levels" role="group" aria-label="${esc(t('Your troop levels'))}">
      <span class="citadel-inside-label">${t('Your levels')}</span>${selects}
      <label class="citadel-level-field citadel-level-span"><span>${esc(t('Show'))}</span>
        <select class="input citadel-level-select" data-level-kind="span">${spanOpts}</select></label>
      <span class="citadel-levels-hint muted-copy">${t('Top levels count down from your highest. Saved to your account, for Citadel and Stacks.')}</span>
    </div>`;
}

/** Apply a change from one of levelsHtml's selects. False when `el` isn't one of them. */
export function applyLevelChange(levels, el) {
  const kind = el?.dataset?.levelKind;
  if (!kind) return false;
  const n = Number(el.value);
  if (kind === 'span') levels.span = SPANS.includes(n) ? n : null;
  else if (kind in levels) levels[kind] = Number.isInteger(n) && n >= 1 && n <= 9 ? n : null;
  return true;
}

/** Save to the account. Returns what the server stored, or null when it didn't. */
export async function saveLevels(levels) {
  try {
    const res = await apiPut('/tools/citadel-levels', levels);
    return res?.levels ?? null;
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return null;
    await notify(t('Could not save: {error}', { error: err?.message || err }), t('Could not save'));
    return null;
  }
}

/** "G5", "M8"… after a troop in the picker: monsters have no numeral in their names. */
export function levelTag(troopId) {
  const tier = troopTier(troopId);
  if (!tier) return '';
  const [kind, n] = tier;
  return `<span class="citadel-pop-level" title="${esc(`${levelKindLabel(kind)} ${n}`)}">${kind.toUpperCase()}${n}</span>`;
}
