// Timeframes for the might views. The Might page (every card on it) and the
// Members page's change column offer this one list through this one selector,
// so the two can't drift apart.

import { t } from './i18n.js';
import { getCurrentGameDayKey, gameWeekStartOf } from './period.js';

// "This week" is the clan's own week (its week-start setting, Sunday or the
// Tinman cycle), not a rolling seven days. The rest are rolling windows.
export const MIGHT_WINDOWS = [
  { id: 'week', label: t('This week') },
  { id: '30', days: 30, label: t('30 days') },
  { id: '90', days: 90, label: t('90 days') },
  { id: '180', days: 180, label: t('6 months') },
  { id: '365', days: 365, label: t('1 year') },
];

// One selection for both pages: picking 90 days on Members and then opening
// Might shows the same 90 days, not a second default of its own.
let selectedId = '30';

export function getMightWindow() {
  return selectedId;
}

export function setMightWindow(id) {
  if (MIGHT_WINDOWS.some((o) => o.id === id)) selectedId = id;
}

/**
 * The selected window as the might API reads it. `days` is the rolling span
 * the charts draw, counted back from the newest reading. For the clan week it
 * reaches one day before the week's first day, so the curve starts on the
 * reading the week is measured from. `sinceDay` (week only) pins the change
 * column to exactly that: the last reading before the week began.
 */
export function mightWindowParams(id = selectedId) {
  const opt = MIGHT_WINDOWS.find((o) => o.id === id) ?? MIGHT_WINDOWS[1];
  if (opt.id !== 'week') return { days: opt.days, sinceDay: null };
  const today = getCurrentGameDayKey();
  const start = gameWeekStartOf(new Date(`${today}T00:00:00Z`));
  return {
    days: Math.round((Date.parse(`${today}T00:00:00Z`) - start.getTime()) / 86_400_000) + 1,
    sinceDay: start.toISOString().slice(0, 10),
  };
}

/** Query string for /might/overview's change column. */
export function mightDeltaQuery(id = selectedId) {
  const { days, sinceDay } = mightWindowParams(id);
  return `deltaDays=${days}${sinceDay ? `&sinceDay=${sinceDay}` : ''}`;
}

/**
 * The selector's buttons. `attrsFor(option)` returns the data attributes each
 * page wires its click handling to; the caller supplies the `.period-selector`
 * container so it can give it an id to repaint in place.
 */
export function mightWindowButtonsHtml(activeId, attrsFor) {
  return MIGHT_WINDOWS
    .map((o) => `<button class="btn ${o.id === activeId ? 'active' : ''}" aria-pressed="${o.id === activeId}" ${attrsFor(o)}>${o.label}</button>`)
    .join('');
}

/** Hover text for a change cell: exactly which two readings were compared. */
export function mightDeltaTitle(row) {
  return row?.baselineDate && row?.gameDate ? `${row.baselineDate} → ${row.gameDate}` : '';
}
