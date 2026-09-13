// Compact expandable table rows (mobile). The <=640px CSS engine in
// style.css collapses each .table-responsive row down to identity +
// headline metric and hides the rest; this one delegated listener flips
// a row's `.is-open` class so those hidden columns can be revealed on
// tap. Event delegation means it survives every SPA re-render without
// re-binding, and it no-ops on desktop (the engine only collapses rows
// under the media query, so `.is-open` has nothing to toggle there).
//
// Wired once per entry point: app.js (authed SPA) and public-share.js.

// Taps that land on a real control — a link, a button, an inline
// input/select, anything wired with its own data-action (the events and
// chest-collector drill-down carets), or a span acting as a button (the
// evidence-crop 🖼️ triggers, which open a lightbox) — must do their own
// thing, not toggle the row. Only bare taps on the row body expand it.
const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [data-action], [role="button"]';

export function initMobileRows(root = document) {
  root.addEventListener('click', (event) => {
    // Desktop keeps every column visible, so there is nothing to expand.
    if (!window.matchMedia('(max-width: 640px)').matches) return;
    if (event.target.closest(INTERACTIVE)) return;

    const row = event.target.closest('.table-responsive tr');
    if (!row) return;

    // Only compact-row-engine rows (a primary cell) that actually have a
    // hidden column to reveal are expandable — mirror the CSS chevron
    // condition exactly so tappable-looking rows and toggle-able rows
    // are always the same set.
    if (!row.querySelector('td[data-role="primary"]')) return;
    if (!row.matches(':has(td:not([data-role]):not(:empty))')) return;

    row.classList.toggle('is-open');
  });
}
