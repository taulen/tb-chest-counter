// Sortable table headers, shared by every sortable table in the app and the
// public share page.
//
// A header used to be a bare <th> with a click listener: nothing a keyboard
// could reach, and a screen reader announced the sort arrow as "black
// up-pointing triangle" with no idea which way the column was sorted. Now the
// label sits in a real <button> (Enter and Space for free, no key handling to
// get wrong), the <th> carries aria-sort, and the arrow is decorative.
//
// Clicks still bubble from the button to the <th>, so every existing handler —
// the [data-action] dispatchers and the per-<th> listeners alike — keeps
// working unchanged.

import { esc } from './ui.js';

/**
 * One sortable <th>.
 *
 *  - key       the data-sort-key the page's handler reads
 *  - labelHtml TRUSTED html for the visible label (escape dynamic parts)
 *  - sortState { key, dir } — the table's current sort
 *  - action    optional data-action for delegated dispatchers
 *  - className extra classes for the <th> (e.g. "num")
 *  - title     optional tooltip
 *  - arrowHtml optional replacement for the default " ▲"/" ▼" arrow, for a
 *              header that lays its arrow out itself; omit the arrow entirely
 *              by passing ''
 *
 * @param {{
 *   key: string, labelHtml: string, sortState: ({ key: string, dir: string } | null | undefined),
 *   action?: string, className?: string, title?: string, arrowHtml?: (string | null),
 * }} opts
 */
export function sortableThHtml({
  key, labelHtml, sortState, action = '', className = '', title = '', arrowHtml = null,
}) {
  const active = sortState && sortState.key === key;
  const dir = active ? sortState.dir : null;
  const ariaSort = dir === 'asc' ? ' aria-sort="ascending"' : dir === 'desc' ? ' aria-sort="descending"' : '';
  const arrow = arrowHtml !== null
    ? arrowHtml
    : (dir ? `<span class="sort-arrow" aria-hidden="true">${dir === 'asc' ? ' ▲' : ' ▼'}</span>` : '');
  const classes = ['sortable', className].filter(Boolean).join(' ');
  return `<th class="${classes}" data-sort-key="${esc(key)}"${action ? ` data-action="${esc(action)}"` : ''}${ariaSort}${title ? ` title="${esc(title)}"` : ''}>`
    + `<button type="button" class="th-sort-btn">${labelHtml}${arrow}</button></th>`;
}

/**
 * Keep keyboard focus on the header that was just used to sort.
 *
 * Every sort re-renders its table via innerHTML, which destroys the focused
 * button and drops focus on <body> — a keyboard user would be thrown back to
 * the top of the page after each sort. One observer on `root` puts focus back
 * on the matching header in the new table, however the page re-rendered.
 */
export function initSortableHeaders(root) {
  if (!root || root.__sortHeadersBound) return;
  root.__sortHeadersBound = true;
  let pending = null;

  // Capture phase: some pages re-render synchronously inside their own click
  // handler, and the observer below runs as soon as that handler returns — so
  // the header has to be recorded before any page handler sees the click.
  root.addEventListener('click', (event) => {
    const btn = event.target.closest('.th-sort-btn');
    if (!btn) return;
    const th = btn.closest('th[data-sort-key]');
    pending = th ? { key: th.dataset.sortKey, action: th.dataset.action || '', at: Date.now() } : null;
  }, true);

  new MutationObserver(() => {
    if (!pending) return;
    // Only restore while focus is lost; never steal it from where the user
    // has since moved. A render that lands long after the click is not ours.
    if (Date.now() - pending.at > 10000) { pending = null; return; }
    const active = document.activeElement;
    if (active && active !== document.body && root.contains(active)) { pending = null; return; }
    for (const th of root.querySelectorAll('th[data-sort-key]')) {
      if (th.dataset.sortKey === pending.key && (th.dataset.action || '') === pending.action) {
        const btn = th.querySelector('.th-sort-btn');
        if (btn) {
          btn.focus({ preventScroll: true });
          pending = null;
        }
        return;
      }
    }
  }).observe(root, { childList: true, subtree: true });
}
