// Color-theme runtime. Owns the data-theme attribute on <html>, the
// localStorage cache (so reloads and unauthenticated pages don't flash
// the wrong palette), and the optional PUT /api/auth/theme call that
// follows the choice across devices.
//
// Inline scripts in index.html / login.html / setup.html / public-share.html
// apply the cached theme synchronously before the stylesheet paints —
// this module then takes over once the page is interactive. Those scripts
// repeat resolveTheme() below in ES5; tests/config/theme-bootstrap.test.ts
// keeps the four of them identical.
//
// Two things are tracked separately:
//  - the PREFERENCE someone picked: auto | light | dark | oled. 'auto' is the
//    default for anyone who never chose, and follows the device;
//  - the PAINTED theme in data-theme, always light | dark | oled, so the CSS
//    never has to know 'auto' exists.

const PREFERENCES = new Set(['auto', 'light', 'dark', 'oled']);
const PAINTED = new Set(['light', 'dark', 'oled']);
const STORAGE_KEY = 'theme';
const DEFAULT_PREFERENCE = 'auto';

/**
 * The theme a preference paints. 'auto' follows the device, and a device in
 * dark mode gets OLED rather than Dark — true black is what someone who asked
 * their phone for dark mode is most likely to want, and Dark stays one click
 * away for anyone who prefers the blue-grey.
 */
export function resolveTheme(preference, prefersLight) {
  if (PAINTED.has(preference)) return preference;
  return prefersLight ? 'light' : 'oled';
}

function devicePrefersLight() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: light)').matches;
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
  } catch (_) { /* private browsing / storage disabled */ }
}

// Set by applyTheme; until then the stored value (or the default) stands.
let currentPreference = null;

/** What the visitor chose: auto | light | dark | oled. */
export function getThemePreference() {
  if (currentPreference) return currentPreference;
  const stored = safeRead();
  return PREFERENCES.has(stored) ? stored : DEFAULT_PREFERENCE;
}

/** The theme actually painted: light | dark | oled. */
export function getCurrentTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr && PAINTED.has(attr)) return attr;
  return resolveTheme(getThemePreference(), devicePrefersLight());
}

/**
 * Apply a theme preference to the page. Sets data-theme on <html> to the theme
 * it resolves to, caches the preference in localStorage, syncs every visible
 * switcher, and fires a `themechange` CustomEvent so charts (and anything else
 * that reads CSS variables at runtime) can refresh.
 *
 * `persist` defaults to true; pass false for a repaint that isn't a new choice
 * (the device switching light/dark under 'auto'). `syncServer` false keeps a
 * page without a session (setup, a public share link) from calling the API.
 */
export function applyTheme(preference, { persist = true, syncServer = true } = {}) {
  const pref = PREFERENCES.has(preference) ? preference : DEFAULT_PREFERENCE;
  currentPreference = pref;
  const painted = resolveTheme(pref, devicePrefersLight());
  document.documentElement.setAttribute('data-theme', painted);
  if (persist) safeWrite(pref);
  syncSwitchers(pref);
  document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: painted, preference: pref } }));
  if (syncServer && persist) {
    // Fire-and-forget. A failure here just means the next device
    // session won't inherit the change — local state is already
    // updated.
    fetch('/api/auth/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: pref }),
    }).catch(() => { /* offline / unauthenticated — ignore */ });
  }
  return painted;
}

// Under 'auto', follow the device live — flipping the OS to dark at sunset
// repaints an open page, and the charts redraw off the same themechange event.
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getThemePreference() === 'auto') applyTheme('auto', { persist: false, syncServer: false });
  });
}

function syncSwitchers(preference) {
  document.querySelectorAll('[data-action="set-theme"]').forEach((btn) => {
    const isActive = btn.dataset.theme === preference;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('select[data-theme-select]').forEach((select) => {
    select.value = preference;
  });
}

/**
 * Wire every theme switcher under `root`: the segmented rows
 * ([data-action="set-theme"] buttons) and the compact select
 * (select[data-theme-select]). Idempotent and delegated, so it survives the
 * switchers being re-rendered.
 */
export function bindThemeSwitcher(root = document, { syncServer = true } = {}) {
  syncSwitchers(getThemePreference());
  if (root.__themeDelegationBound) return;
  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action="set-theme"]');
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const next = target.dataset.theme;
    if (!PREFERENCES.has(next)) return;
    applyTheme(next, { syncServer });
  });
  root.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-theme-select]');
    if (!select || !PREFERENCES.has(select.value)) return;
    applyTheme(select.value, { syncServer });
  });
  root.__themeDelegationBound = true;
}

/**
 * Read a CSS custom property off <html>. Used by chart code that has to
 * pass concrete color strings into Chart.js options.
 */
export function readToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
