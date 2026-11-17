// UI translations. English is the source language AND the default: a visitor
// who never picked a language gets English, whatever their browser or device
// says — never Accept-Language, never navigator.language.
//
// The keys are the English strings themselves (gettext-style), so a string
// with no translation yet simply shows in English, and the code reads the
// same as it did before:
//
//   t('Leaderboard')                              → 'Clasificación'
//   t('Deleted {name}', { name: esc(name) })      → interpolation
//   tn(count, '{n} chest', '{n} chests')          → plural (Russian has 3 forms)
//   tGame('Wooden Chest')                         → the game's OFFICIAL name
//
// t() never escapes: it returns the translation of a string the caller would
// otherwise have written inline, and placeholder values are inserted as given
// — escape them exactly as the English template did.
//
// The choice lives in localStorage ('lang'), like the theme, and for a signed-in
// account also on the server (PUT /api/auth/language) so it follows the person
// across devices. Changing language reloads the page: strings are baked into
// rendered HTML and module-level constants, and a reload is the one way to
// re-render all of them.
//
// tests/config/i18n-dictionaries.test.ts keeps every dictionary in step with
// the t()/tn() calls in the source.

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'ru', label: 'Русский' },
  { code: 'de', label: 'Deutsch' },
];
const CODES = new Set(LANGUAGES.map((l) => l.code));
const STORAGE_KEY = 'lang';
export const DEFAULT_LANGUAGE = 'en';

export function isLanguage(value) {
  return typeof value === 'string' && CODES.has(value);
}

function safeRead() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (_) {
    return null;
  }
}

function safeWrite(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
    return localStorage.getItem(STORAGE_KEY) === value;
  } catch (_) {
    return false;
  }
}

const stored = safeRead();
let current = isLanguage(stored) ? stored : DEFAULT_LANGUAGE;
let ui = {};
/** Hand-kept names the game's own files don't cover (lib/i18n/<lang>.js `game`). */
let game = {};
/** The game's own names in this language, from its translation files (GET /api/game-texts/<lang>). */
let official = {};

/** How long a page waits for the game's names before it renders with English ones. */
const GAME_TEXTS_TIMEOUT_MS = 2500;

/**
 * The game's names in `lang`, built on the server from the game's own
 * translation CSVs (src/game-protocol/game-texts.ts). An /api URL — never a
 * cached-by-extension asset (docs/cloudflare-caching.md) — revalidated by its
 * ETag. Anything going wrong (offline, slow, no data yet) gives {}: names then
 * show in English, and the page never waits longer than the timeout.
 */
async function loadOfficialNames(lang) {
  if (typeof fetch !== 'function') return {};
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), GAME_TEXTS_TIMEOUT_MS) : null;
  try {
    const res = await fetch(`/api/game-texts/${encodeURIComponent(lang)}`, {
      credentials: 'same-origin',
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    if (!res.ok) return {};
    const body = await res.json();
    return body && body.texts && typeof body.texts === 'object' ? body.texts : {};
  } catch (_) {
    return {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Asked for at once, in parallel with the dictionary; awaited at the end of
// this module, after the shell is translated and shown.
const officialNames = current !== DEFAULT_LANGUAGE ? loadOfficialNames(current) : null;

if (current !== DEFAULT_LANGUAGE) {
  try {
    const mod = await import(`./i18n/${current}.js`);
    ui = mod.ui || {};
    game = mod.game || {};
  } catch (_) {
    // A dictionary that fails to load must never take the page down with it
    // (one failed import aborts the whole module graph) — fall back to English.
    current = DEFAULT_LANGUAGE;
  }
}

const pluralRules = (() => {
  try {
    return new Intl.PluralRules(current);
  } catch (_) {
    return null;
  }
})();

/** The language in use: en | es | fr | ru | de. */
export function getLanguage() {
  return current;
}

function interpolate(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
  ));
}

/** Translate a UI string. `key` is the English text. */
export function t(key, params) {
  const hit = ui[key];
  return interpolate(typeof hit === 'string' && hit ? hit : key, params);
}

let reverse = null;

/**
 * The English source of a string t() produced, or the text itself when it
 * isn't one. For code that inspects display text — ui.js picks a modal's
 * success/error styling from words in its title — so it can keep matching
 * English whatever the language.
 */
export function englishOf(text) {
  if (current === DEFAULT_LANGUAGE || typeof text !== 'string') return text;
  if (!reverse) {
    reverse = new Map();
    for (const [key, value] of Object.entries(ui)) {
      if (typeof value === 'string' && value) reverse.set(value, key);
    }
  }
  return reverse.get(text) ?? text;
}

/**
 * Translate a count-dependent string. `one` and `other` are the English
 * singular and plural; the dictionary entry is keyed by `other` and holds the
 * target language's plural forms ({ one, few, many, other } — whichever that
 * language uses). `{n}` defaults to the count, formatted like every other
 * number on the site; pass params.n to override.
 */
export function tn(count, one, other, params) {
  const all = { n: Number(count).toLocaleString(), ...params };
  const hit = ui[other];
  if (hit && typeof hit === 'object') {
    const category = pluralRules ? pluralRules.select(Number(count)) : 'other';
    const form = hit[category] || hit.other;
    if (form) return interpolate(form, all);
  }
  return interpolate(Number(count) === 1 ? one : other, all);
}

/** `{n}` pattern entry for a name with numbers, filled back in order; null when there is none. */
function fromPattern(dict, name, normalize) {
  const numbers = name.match(/\d+/g);
  if (!numbers) return null;
  const key = name.replace(/\d+/g, '{n}');
  const pattern = normalize ? dict.get(normalize(key)) : dict[key];
  if (typeof pattern !== 'string' || !pattern) return null;
  let i = 0;
  return pattern.replace(/\{n\}/g, () => numbers[i++] ?? '');
}

/**
 * A stored spelling the game writes differently: case, spacing, "Lvl" for
 * "Level" and dash style — the scan's own rule (game-protocol/gift-text.ts),
 * which keeps writing the OCR era's "Lvl 25-29 Vault of the Ancients" for the
 * game's "Level 25–29 Vault of the Ancients".
 */
const normalizeName = (s) => s.toLowerCase().replace(/\blvl\b/g, 'level').replace(/[–—]/g, '-').replace(/\s+/g, '');
let officialNormalized = null;

function officialName(name) {
  const hit = official[name];
  if (typeof hit === 'string' && hit) return hit;
  const filled = fromPattern(official, name);
  if (filled) return filled;
  if (!officialNormalized) {
    officialNormalized = new Map();
    for (const [key, value] of Object.entries(official)) {
      const k = normalizeName(key);
      if (typeof value === 'string' && value && !officialNormalized.has(k)) officialNormalized.set(k, value);
    }
  }
  return officialNormalized.get(normalizeName(name)) || fromPattern(officialNormalized, name, normalizeName);
}

/**
 * The game's own name for a chest, source, event, resource, title, captain,
 * tech… in the current language. Data stays English — scans store the game's
 * English names — so pass the English and call this only where it is shown.
 *
 * In order:
 *   1. the game's own text (`official`, from its translation files via
 *      /api/game-texts): exact, then a `{n}` pattern, then the same after
 *      normalizing case, spacing, "Lvl" and dashes;
 *   2. the hand-kept `game` block of lib/i18n/<lang>.js — only names the
 *      game's files don't cover (the app's shorthands like 'Ancients');
 *   3. the ui dictionary — how the event catalog's own labels ('Finish
 *      Reward', 'Vaults Taken Down': this app's words, not the game's) get
 *      translated; the guard test reads them out of src/config/event-catalog.ts;
 *   4. a `{n}` pattern of the `game` block;
 *   5. the English itself — what the game shows an English client. A guessed
 *      name would send a player looking for something their game doesn't have.
 *
 * Names with numbers ("Level 15 epic Crypt") match a pattern entry with `{n}`
 * for each number, filled back in order: 'Level {n} epic Crypt' → 'Epische
 * Gruft Level {n}'.
 */
export function tGame(name) {
  if (name == null || name === '' || current === DEFAULT_LANGUAGE) return name;
  const s = String(name);
  const fromGame = officialName(s);
  if (fromGame) return fromGame;
  const hit = game[s];
  if (typeof hit === 'string' && hit) return hit;
  const label = ui[s];
  if (typeof label === 'string' && label) return label;
  return fromPattern(game, s) ?? name;
}

/**
 * Translate the static markup of a page shell. Marks:
 *   data-i18n                     → the element's text content
 *   data-i18n-attr="title aria-label placeholder"
 *                                 → each listed attribute's current value
 * The English original is kept in the element so a second pass is harmless.
 */
export function translateDom(root = document) {
  if (current === DEFAULT_LANGUAGE || !root || typeof root.querySelectorAll !== 'function') return;
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    if (el.dataset.i18nSource === undefined) el.dataset.i18nSource = el.textContent.trim();
    el.textContent = t(el.dataset.i18nSource);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    for (const attr of el.dataset.i18nAttr.split(/\s+/).filter(Boolean)) {
      const sourceKey = `i18nSrc${attr.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`;
      if (el.dataset[sourceKey] === undefined) el.dataset[sourceKey] = el.getAttribute(attr) ?? '';
      if (el.dataset[sourceKey]) el.setAttribute(attr, t(el.dataset[sourceKey]));
    }
  });
}

/**
 * Switch language. Persists locally, tells the server for a signed-in account
 * (`syncServer`), then reloads so every string re-renders. A no-op for the
 * language already in use.
 */
export async function setLanguage(code, { syncServer = true } = {}) {
  if (!isLanguage(code) || code === current) return;
  const saved = safeWrite(code);
  if (syncServer) {
    try {
      await fetch('/api/auth/language', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: code }),
      });
    } catch (_) { /* offline / unauthenticated — the local choice still stands */ }
  }
  // Storage blocked: a reload would come back in the old language, so there is
  // nothing to reload into.
  if (saved) window.location.reload();
}

/**
 * Reconcile with the account's server-side choice once /api/auth/me answers.
 * The server wins when it holds one; an account that never chose ('') adopts
 * this browser's choice so a language picked on the public page carries over.
 * Reloads only when the language actually changes and the change could be
 * stored — a blocked localStorage would otherwise reload forever.
 */
export function adoptAccountLanguage(serverLanguage) {
  if (isLanguage(serverLanguage)) {
    if (serverLanguage !== current && safeWrite(serverLanguage)) window.location.reload();
    return;
  }
  if (current !== DEFAULT_LANGUAGE) {
    fetch('/api/auth/language', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: current }),
    }).catch(() => {});
  }
}

function syncSwitchers() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('select[data-lang-select]').forEach((select) => {
    select.value = current;
  });
  document.querySelectorAll('[data-action="set-language"]').forEach((btn) => {
    const isActive = btn.dataset.lang === current;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

/** `<option>`s for a language select, each named in its own language. */
export function languageOptionsHtml() {
  return LANGUAGES.map((l) => `<option value="${l.code}" lang="${l.code}">${l.label}</option>`).join('');
}

/**
 * Wire every language switcher under `root` (select[data-lang-select]).
 * Empty selects are filled with the five languages. Idempotent and delegated.
 */
export function bindLanguageSwitcher(root = document, { syncServer = true } = {}) {
  root.querySelectorAll('select[data-lang-select]').forEach((select) => {
    if (!select.options.length) select.innerHTML = languageOptionsHtml();
  });
  syncSwitchers();
  if (root.__langDelegationBound) return;
  root.addEventListener('change', (event) => {
    const select = event.target.closest && event.target.closest('select[data-lang-select]');
    if (!select) return;
    setLanguage(select.value, { syncServer });
  });
  root.__langDelegationBound = true;
}

// Translate the shell as soon as the dictionary is in, then reveal it. The
// inline bootstrap in each HTML shell hides the page (data-i18n-pending) for a
// non-English visitor so the English markup never flashes first.
if (typeof document !== 'undefined' && document.documentElement) {
  document.documentElement.lang = current;
  try {
    translateDom(document);
  } finally {
    document.documentElement.removeAttribute('data-i18n-pending');
  }
}

// The game's own names last: the shell above never waits for them, but every
// importer of this module does (top-level await), so no page renders a name
// before they are in — and tGame stays synchronous. loadOfficialNames never
// rejects and gives up after GAME_TEXTS_TIMEOUT_MS.
if (officialNames && current !== DEFAULT_LANGUAGE) official = await officialNames;
