// Guards level + Gold Pass display, shared by every table that shows them —
// Leaderboard (authenticated and public share), Members, Might and the Events
// Triumphal tab — so a level reads the same wherever it appears.
//
// Both values are INFERRED (see src/data/repositories/guards-repo.ts and
// gold-pass-repo.ts), so every cell carries its own qualification in the
// tooltip: what the level was read from, how sure, and how old. A bare "G8"
// off a guess would quietly mislead.

import { esc, formatGameDayShort } from './ui.js';
import { t, tGame } from './i18n.js';

const CONFIDENCE_LABEL = {
  high: t('high confidence'),
  medium: t('medium confidence'),
  low: t('low confidence — one ambiguous donation'),
};

/**
 * Tooltip for an estimated level. `g` is the summary the API returns
 * ({ level, asOf, confidence, stale, reported }).
 */
export function guardsTitle(g) {
  if (!g || g.level == null) {
    return t('Guards level unknown — no {essence} or {tractates} donation that reveals it yet', { essence: tGame('Omen Essence'), tractates: tGame('Scientific Tractates') });
  }
  const source = g.reported ? t('Entered by an admin') : t('Estimated from {essence} and {tractates} donations', { essence: tGame('Omen Essence'), tractates: tGame('Scientific Tractates') });
  const parts = [
    t('G{level} — {source}', { level: g.level, source }),
    t('as of {date}', { date: formatGameDayShort(g.asOf) }),
    CONFIDENCE_LABEL[g.confidence] || '',
  ];
  if (g.stale) parts.push(t('no new donations since, so it may be higher by now'));
  return parts.filter(Boolean).join(' · ');
}

/**
 * "G8" for a table cell. Low confidence gets a trailing "?", and both low and
 * stale are muted so a hedged value never reads as firmly as a settled one.
 */
export function guardsCellHtml(g) {
  if (!g || g.level == null) {
    return `<span class="guards-level is-unknown" title="${esc(guardsTitle(null))}">—</span>`;
  }
  const cls = ['guards-level'];
  if (g.confidence === 'low') cls.push('is-low');
  if (g.stale) cls.push('is-stale');
  const text = `${t('G{level}', { level: g.level })}${g.confidence === 'low' ? '?' : ''}`;
  return `<span class="${cls.join(' ')}" title="${esc(guardsTitle(g))}">${text}</span>`;
}

/** Leaderboard rows carry the summary as flat fields; fold them back into one. */
export function guardsFromEntry(e) {
  if (!e || e.guardsLevel == null) return null;
  return {
    level: e.guardsLevel,
    confidence: e.guardsConfidence,
    asOf: e.guardsAsOf,
    stale: !!e.guardsStale,
    reported: false,
  };
}

const GOLD_PASS_TITLE = {
  current: t('Gold Pass this {event} cycle — {chests} from the pass track plus the 250k {tractates} each one donates', { event: tGame('Triumphal'), chests: tGame('Union Chests'), tractates: tGame('Scientific Tractates') }),
  previous: t('Had a Gold Pass last {event} cycle — not seen in this one yet', { event: tGame('Triumphal') }),
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
