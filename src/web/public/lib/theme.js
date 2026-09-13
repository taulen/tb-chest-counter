// Color-theme runtime. Owns the data-theme attribute on <html>, the
// localStorage cache (so reloads and unauthenticated pages don't flash
// the wrong palette), and the optional PUT /api/auth/theme call that
// follows the choice across devices.
//
// Inline scripts in index.html / login.html / setup.html / public-share.html
// apply the cached theme synchronously before the stylesheet paints —
// this module then takes over once the page is interactive.

const ALLOWED = new Set(['dark', 'light', 'oled']);
const STORAGE_KEY = 'theme';
const DEFAULT_THEME = 'dark';

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

export function getCurrentTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr && ALLOWED.has(attr)) return attr;
  const stored = safeRead();
  if (stored && ALLOWED.has(stored)) return stored;
  return DEFAULT_THEME;
}

/**
 * Apply a theme to the page. Sets data-theme on <html>, caches the
 * choice in localStorage, syncs any visible segmented-row buttons, and
 * fires a `themechange` CustomEvent so charts (and anything else that
 * reads CSS variables at runtime) can refresh.
 *
 * `persist` defaults to true; pass false from the initial bootstrap
 * call so the just-fetched server value doesn't immediately PUT back
 * to itself.
 */
export function applyTheme(theme, { persist = true, syncServer = true } = {}) {
  const next = ALLOWED.has(theme) ? theme : DEFAULT_THEME;
  const root = document.documentElement;
  if (next === DEFAULT_THEME) {
    // Keep the attribute set so the segmented row always reads the
    // current theme back the same way — implicit "no attribute = dark"
    // would force the buttons to special-case the bootstrap value.
    root.setAttribute('data-theme', next);
  } else {
    root.setAttribute('data-theme', next);
  }
  if (persist) safeWrite(next);
  syncSegmentedButtons(next);
  document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  if (syncServer && persist) {
    // Fire-and-forget. A failure here just means the next device
    // session won't inherit the change — local state is already
    // updated.
    fetch('/api/auth/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    }).catch(() => { /* offline / unauthenticated — ignore */ });
  }
  return next;
}

function syncSegmentedButtons(theme) {
  const buttons = document.querySelectorAll('[data-action="set-theme"]');
  buttons.forEach((btn) => {
    const isActive = btn.dataset.theme === theme;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

/**
 * Wire the inline segmented row in the user dropdown. Idempotent — safe
 * to call again if the menu is re-rendered. Reads + writes the current
 * theme to keep the buttons in sync with whatever paint state the page
 * currently has.
 */
export function bindThemeSwitcher(root = document) {
  syncSegmentedButtons(getCurrentTheme());
  // Delegate so we don't have to re-bind after a DOM rebuild.
  if (root.__themeDelegationBound) return;
  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action="set-theme"]');
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const next = target.dataset.theme;
    if (!ALLOWED.has(next)) return;
    applyTheme(next);
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
