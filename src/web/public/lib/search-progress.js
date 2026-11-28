// The count search's progress bar (Tools → Citadel and Tools → Monsters): the
// search runs in a worker (lib/army-search.js) and a phone may take ~10 s, so
// the page shows how far it is and what it is doing — a progressbar for
// screen readers, words and the kit's bar for everyone. Theme colours only
// (style.css "search-progress").

import { esc } from './ui.js';
import { t } from './i18n.js';
import { barHtml } from './ui-kit.js';

/** { pct 0–100, words } for a progress report { done, total, phase } (null: just started). */
export function progressNow(p) {
  const pct = p && p.total > 0 ? Math.max(0, Math.min(100, Math.floor((p.done / p.total) * 100))) : 0;
  const words = p?.phase === 'improve'
    ? t('Improving the best army… {pct}%', { pct })
    : t('Trying starting armies… {pct}%', { pct });
  return { pct, words };
}

/** The bar and its words, inside a tile that is not announced (it moves a few hundred times). */
export function progressHtml(p) {
  const { pct, words } = progressNow(p);
  return `<p class="search-progress-text">${esc(words)}</p>
    <div class="search-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"
      aria-valuetext="${esc(words)}" aria-label="${esc(t('Working out the counts…'))}">${barHtml({ points: pct, max: 100, cls: 'search-progress-bar' })}</div>`;
}

/** Move the bar and its words in place: the card around it is not redrawn on every step. */
export function paintProgress(root, p) {
  const bar = root.querySelector('.search-progress');
  if (!bar) return;
  const { pct, words } = progressNow(p);
  bar.setAttribute('aria-valuenow', String(pct));
  bar.setAttribute('aria-valuetext', words);
  bar.querySelector('.ui-bar-fill')?.style.setProperty('--w', `${pct}%`);
  const text = root.querySelector('.search-progress-text');
  if (text) text.textContent = words;
}
