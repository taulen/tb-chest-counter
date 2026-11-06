// In-page view tabs: one long page split into panels — Events → Scores /
// Participants, and a member profile's sections. Every panel is rendered into
// the DOM and the inactive ones are `hidden`, so switching never refetches or
// repaints; the page keeps the active key in its own state and passes it back
// on its next render.
//
// Real ARIA tabs: a tablist of buttons with roving tabindex (←/→/Home/End
// move between them), each controlling one tabpanel. Same segmented look as
// the Resources / Events sub-tab bars (.resources-tabs).

import { esc } from './ui.js';
import { t } from './i18n.js';

/**
 * The tab bar.
 * @param {string} group  unique per page ('events-view', 'member-view') — prefixes the ids
 * @param {Array<{ key: string, label: string }>} tabs  labels are already translated HTML-safe text
 * @param {string} active
 */
export function viewTabsHtml(group, tabs, active) {
  return `<div class="resources-tabs view-tabs" role="tablist" aria-label="${esc(t('Page sections'))}" data-view-tabs="${group}">
    ${tabs.map(({ key, label }) => {
      const on = key === active;
      return `<button type="button" role="tab" class="resources-tab${on ? ' is-active' : ''}"
        id="${group}-tab-${key}" aria-controls="${group}-panel-${key}" aria-selected="${on}"
        tabindex="${on ? 0 : -1}" data-view-tab="${key}">${label}</button>`;
    }).join('')}
  </div>`;
}

/** One panel wrapping `html`; hidden unless it is the active one. */
export function viewPanelHtml(group, key, active, html) {
  return `<div class="view-panel" role="tabpanel" id="${group}-panel-${key}" aria-labelledby="${group}-tab-${key}"
    data-view-panel="${group}:${key}"${key === active ? '' : ' hidden'}>${html}</div>`;
}

/**
 * Wire the bar rendered by viewTabsHtml inside `root`. `onChange(key)` runs
 * after the switch, for the page to remember the key (and to draw anything
 * that needs a visible box, such as a chart).
 */
export function wireViewTabs(root, group, onChange) {
  const bar = root.querySelector(`[data-view-tabs="${group}"]`);
  if (!bar) return;
  const tabs = [...bar.querySelectorAll('[data-view-tab]')];

  const select = (key, focus) => {
    for (const tab of tabs) {
      const on = tab.dataset.viewTab === key;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    root.querySelectorAll(`[data-view-panel^="${group}:"]`).forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== `${group}:${key}`;
    });
    onChange?.(key);
  };

  bar.addEventListener('click', (ev) => {
    const tab = ev.target.closest('[data-view-tab]');
    if (tab && tab.getAttribute('aria-selected') !== 'true') select(tab.dataset.viewTab, false);
  });
  bar.addEventListener('keydown', (ev) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[ev.key];
    if (next === undefined) return;
    ev.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length].dataset.viewTab, true);
  });
}
