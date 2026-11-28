// "Your levels": the troop tiers an account has unlocked (Guardsmen,
// Specialists, Monsters, Engineers) and how many of the top levels the troop
// picker shows. One set per account, saved on the server
// (/api/tools/citadel-levels), shared by Tools → Citadel, → Monsters and → Stacks.
//
// The window rule itself (troopInWindow) is in citadel-sim.js, with the data.

import { api, apiPut } from './api.js';
import { esc, notify, formatRelativeTime } from './ui.js';
import { t, tn } from './i18n.js';
import { troopTier, DEFAULT_LEVEL_SPAN, ALL_LEVELS_SPAN } from './citadel-sim.js';

export const LEVEL_KINDS = [
  ['g', t('Guardsmen')],
  ['s', t('Specialists')],
  ['m', t('Monsters')],
  ['e', t('Engineers')],
];
export const levelKindLabel = (k) => LEVEL_KINDS.find(([x]) => x === k)?.[1] ?? k;
/** The lowest level of a kind: 1, monsters 3 — no lower monster tier exists (the user, Nov 28 2026). */
export const LEVEL_FLOOR = { g: 1, s: 1, m: 3, e: 1 };

/** Nothing chosen yet: every kind "any", the default window. */
export const NO_LEVELS = Object.freeze({ g: null, s: null, m: null, e: null, span: null });

/** How many top levels the picker may show: 1-4, or all of them. */
const SPANS = [1, 2, 3, 4, ALL_LEVELS_SPAN];

// ─── From the game (linked accounts) ─────────────────────────────
// An account linked to a game player in the active clan takes its levels
// from that player's research, as Tools → Costs does (the user, Nov 28 2026):
// GET /api/game/research-levels — its players here, its main one unless one is
// picked. Changing a level tries another one for the visit; the next visit
// starts from the game again, and "Reset to my in-game levels" goes back now.
// Not linked: the selects as before, saved to the account.

/**
 * The linked player's levels: { players: [{ playerId, name }], player: {
 * playerId, name, readAt, levels: { g, s, m, e } | null } |
 * null }, or null when it can't be had. Every level is 1–9, monsters 3–9:
 * tier 1 is every player's from the start, and monster tiers start at 3.
 */
export async function loadGameLevels(player = null) {
  try {
    return await api(`/game/research-levels${player ? `?player=${encodeURIComponent(player)}` : ''}`);
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') throw err;
    return null;
  }
}

/**
 * The game's levels when it has them (the window — `span` — stays the account's);
 * either way no level below its kind's floor (a saved Monsters 1 or 2 is 3).
 */
export function withGameLevels(levels, game) {
  const g = game?.player?.levels;
  const out = g ? { ...levels, g: g.g, s: g.s, m: g.m, e: g.e } : { ...levels };
  for (const [k, floor] of Object.entries(LEVEL_FLOOR)) if (Number.isInteger(out[k]) && out[k] < floor) out[k] = floor;
  return out;
}

/** Are these the game's levels? */
function fromGame(levels, game) {
  const g = game?.player?.levels;
  return !!g && LEVEL_KINDS.every(([k]) => levels[k] === g[k]);
}

/**
 * Save a level change to the account. With the game's levels only the window
 * (`span`) is saved — the levels are read again every visit — and the levels
 * on the page stay; else everything, and the levels the server stored come back.
 * `account`: the account's saved levels (what /api/tools/citadel-levels gave).
 */
export async function saveLevelChange(levels, game, account) {
  if (game?.player?.levels) {
    await saveLevels({ ...(account ?? NO_LEVELS), span: levels.span });
    return levels;
  }
  return (await saveLevels(levels)) ?? levels;
}

/** Whose levels, and whether they are still the game's (linked accounts only). */
function gameRowHtml(levels, game) {
  const players = game?.players ?? [];
  const p = game?.player;
  if (!players.length || !p) return '';
  const who = players.length > 1
    ? `<select class="input citadel-level-select citadel-level-player" data-level-player aria-label="${esc(t('Whose levels'))}">${players.map((x) => `<option value="${x.playerId}"${x.playerId === p.playerId ? ' selected' : ''}>${esc(x.name || t('Unknown player'))}</option>`).join('')}</select>`
    : `<strong class="citadel-level-who">${esc(p.name || t('Unknown player'))}</strong>`;
  let state;
  if (!p.levels) state = `<span class="muted-copy">${esc(t('Not read from the game yet. It is read once a day.'))}</span>`;
  else if (fromGame(levels, game)) state = `<span class="citadel-level-from" title="${esc(p.readAt ?? '')}">✓ ${esc(t('From their research, read {when}', { when: formatRelativeTime(p.readAt) }))}</span>`;
  else state = `<button type="button" class="btn btn-sm" data-level-reset>↺ ${esc(t('Reset to my in-game levels'))}</button>`;
  return `<span class="citadel-level-game">${who}${state}</span>`;
}

/** The levels row: whose (linked), a select per kind, then how many levels to show. */
export function levelsHtml(levels, game = null) {
  const linked = !!game?.player?.levels;
  const selects = LEVEL_KINDS.map(([k, label]) => {
    const v = levels[k];
    const opts = [`<option value="" ${v === null ? 'selected' : ''}>${esc(t('any'))}</option>`]
      .concat([9, 8, 7, 6, 5, 4, 3, 2, 1].filter((n) => n >= LEVEL_FLOOR[k]).map((n) => `<option value="${n}" ${v === n ? 'selected' : ''}>${n}</option>`)).join('');
    return `<label class="citadel-level-field"><span>${esc(label)}</span>
      <select class="input citadel-level-select" data-level-kind="${k}">${opts}</select></label>`;
  }).join('');
  const span = levels.span ?? DEFAULT_LEVEL_SPAN;
  const spanOpts = SPANS.map((n) => {
    const label = n === ALL_LEVELS_SPAN ? t('All levels') : tn(n, 'Top {n} level', 'Top {n} levels', { n });
    return `<option value="${n}" ${span === n ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
  const hint = linked
    ? t('Your levels come from your research in the game. Change one to try another for this visit; the next visit starts from the game again.')
    : t('Top levels count down from your highest. Saved to your account, for Citadel, Monsters and Stacks.');
  return `<div class="citadel-levels" role="group" aria-label="${esc(t('Your troop levels'))}">
      <span class="citadel-inside-label">${t('Your levels')}</span>${gameRowHtml(levels, game)}${selects}
      <label class="citadel-level-field citadel-level-span"><span>${esc(t('Show'))}</span>
        <select class="input citadel-level-select" data-level-kind="span">${spanOpts}</select></label>
      <span class="citadel-levels-hint muted-copy">${hint}</span>
    </div>`;
}

/** Apply a change from one of levelsHtml's selects. False when `el` isn't one of them. */
export function applyLevelChange(levels, el) {
  const kind = el?.dataset?.levelKind;
  if (!kind) return false;
  const n = Number(el.value);
  if (kind === 'span') levels.span = SPANS.includes(n) ? n : null;
  else if (kind in levels) levels[kind] = Number.isInteger(n) && n >= (LEVEL_FLOOR[kind] ?? 1) && n <= 9 ? n : null;
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
