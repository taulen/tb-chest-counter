// Compact expandable table rows (mobile). The <=640px CSS engine in
// style.css collapses each .table-responsive row down to identity +
// headline metric and hides the rest; this one delegated listener flips
// a row's `.is-open` class so those hidden columns can be revealed on
// tap. Event delegation means it survives every SPA re-render without
// re-binding, and it no-ops on desktop (the engine only collapses rows
// under the media query, so `.is-open` has nothing to toggle there).
//
// Keyboard: at phone width an expandable row is also a focusable control
// (tabindex + aria-expanded) that Enter / Space toggle — before, only a tap
// could open one, so the hidden columns were out of reach from a keyboard and
// a screen reader never heard that there was more. Above 640px the rows get
// no tabindex, so the desktop Tab order is untouched.
//
// Wired once per entry point: app.js (authed SPA) and public-share.js.

const PHONE = '(max-width: 640px)';

// Taps that land on a real control — a link, a button, an inline
// input/select, anything wired with its own data-action (the events and
// chest-collector drill-down carets), or a span acting as a button (the
// evidence-crop 🖼️ triggers, which open a lightbox) — must do their own
// thing, not toggle the row. Only bare taps on the row body expand it.
const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [data-action], [role="button"]';

// Only compact-row-engine rows (a primary cell) that actually have a hidden
// column to reveal are expandable — mirror the CSS chevron condition exactly
// so tappable-looking rows and toggle-able rows are always the same set. A
// row with its own data-action (the drill-down rows) has its own toggle.
function isExpandable(row) {
  return !row.matches('[data-action]')
    && !!row.querySelector('td[data-role="primary"]')
    && row.matches(':has(td:not([data-role]):not(:empty))');
}

function toggle(row) {
  row.classList.toggle('is-open');
  if (row.dataset.mrowKey) row.setAttribute('aria-expanded', String(row.classList.contains('is-open')));
}

/** Give expandable rows (phone width only) their keyboard affordances. */
function enhance(root) {
  const phone = window.matchMedia(PHONE).matches;
  // On desktop with nothing previously enhanced there is nothing to undo.
  if (!phone && !root.querySelector('tr[data-mrow-key]')) return;
  root.querySelectorAll('.table-responsive tr').forEach((row) => {
    if (phone && isExpandable(row)) {
      if (!row.dataset.mrowKey) {
        row.dataset.mrowKey = '1';
        row.tabIndex = 0;
      }
      row.setAttribute('aria-expanded', String(row.classList.contains('is-open')));
    } else if (row.dataset.mrowKey) {
      delete row.dataset.mrowKey;
      row.removeAttribute('tabindex');
      row.removeAttribute('aria-expanded');
    }
  });
}

export function initMobileRows(root = document) {
  root.addEventListener('click', (event) => {
    // Desktop keeps every column visible, so there is nothing to expand.
    if (!window.matchMedia(PHONE).matches) return;
    if (event.target.closest(INTERACTIVE)) return;

    const row = event.target.closest('.table-responsive tr');
    if (!row || !isExpandable(row)) return;
    toggle(row);
  });

  // Enter / Space on the focused row itself — never on a control inside it.
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target;
    if (!(row instanceof HTMLElement) || !row.matches('tr[data-mrow-key]')) return;
    event.preventDefault(); // Space would otherwise scroll the page
    toggle(row);
  });

  // Every render replaces the rows, so re-apply after any change — batched to
  // one pass per frame however many mutations a render makes.
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      enhance(root);
    });
  };
  new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
  window.matchMedia(PHONE).addEventListener('change', schedule);
  schedule();
}
