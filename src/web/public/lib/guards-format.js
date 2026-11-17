// Guards level + Gold Pass display, shared by every table that shows them —
// Leaderboard (authenticated and public share), Members, Might, Performance and
// the Events Triumphal tab — so a level reads the same wherever it appears.
//
// Both come from the game: the level is the Guardsmen tier from the member's
// own research (src/data/repositories/guards-repo.ts), the Gold Pass the flag
// on their game record (gold-pass-repo.ts). The tooltip says when the research
// was read, so an old read never passes for a fresh one.

import { esc, formatGameDayShort } from './ui.js';
import { t, tGame } from './i18n.js';

/**
 * Tooltip for a level. `g` is the summary the API returns ({ level, asOf, stale }).
 */
export function guardsTitle(g) {
  if (!g || g.level == null) {
    return t('Guards level unknown — their research has not been read from the game yet');
  }
  const parts = [
    t('G{level} — {guardsmen} tier from their research, read {date}', { level: g.level, guardsmen: tGame('Guardsmen'), date: formatGameDayShort(g.asOf) }),
  ];
  if (g.stale) parts.push(t('not read for a while, so it may be higher by now'));
  return parts.join(' · ');
}

/** "G8" for a table cell; an old read is muted so it never reads as firmly as a fresh one. */
export function guardsCellHtml(g) {
  if (!g || g.level == null) {
    return `<span class="guards-level is-unknown" title="${esc(guardsTitle(null))}">—</span>`;
  }
  const cls = ['guards-level'];
  if (g.stale) cls.push('is-stale');
  return `<span class="${cls.join(' ')}" title="${esc(guardsTitle(g))}">${t('G{level}', { level: g.level })}</span>`;
}

/** Leaderboard rows carry the summary as flat fields; fold them back into one. */
export function guardsFromEntry(e) {
  if (!e || e.guardsLevel == null) return null;
  return { level: e.guardsLevel, asOf: e.guardsAsOf, stale: !!e.guardsStale };
}

const GOLD_PASS_TITLE = {
  current: t('Gold Pass — as the game reports it'),
  previous: t('Had a Gold Pass last {event} cycle, as the game reported it — not now', { event: tGame('Triumphal') }),
};

/**
 * A small "GP" marker, or '' when the member has no pass in either cycle.
 * `title` overrides the tooltip for a page showing some other cycle.
 */
export function goldPassBadgeHtml(status, title = null) {
  if (status !== 'current' && status !== 'previous') return '';
  return `<span class="gold-pass-badge is-${status}" title="${esc(title || GOLD_PASS_TITLE[status])}">${t('GP')}</span>`;
}

/**
 * A name with the Gold Pass marker after it. The marker sits outside the part
 * that ellipsizes, so a long name is clipped before the marker is.
 */
export function nameWithGoldPassHtml(nameHtml, status, title = null) {
  const badge = goldPassBadgeHtml(status, title);
  if (!badge) return nameHtml;
  return `<span class="name-badged"><span class="name-badged-text">${nameHtml}</span>${badge}</span>`;
}
