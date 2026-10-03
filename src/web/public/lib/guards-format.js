// Guards level + Gold Pass display, shared by every table that shows them —
// Leaderboard (authenticated and public share), Members, Might and the Events
// Triumphal tab — so a level reads the same wherever it appears.
//
// Both values are INFERRED (see src/data/repositories/guards-repo.ts and
// gold-pass-repo.ts), so every cell carries its own qualification in the
// tooltip: what the level was read from, how sure, and how old. A bare "G8"
// off a guess would quietly mislead.

import { esc, formatGameDayShort } from './ui.js';

const CONFIDENCE_LABEL = {
  high: 'high confidence',
  medium: 'medium confidence',
  low: 'low confidence — one ambiguous donation',
};

/**
 * Tooltip for an estimated level. `g` is the summary the API returns
 * ({ level, asOf, confidence, stale, reported }).
 */
export function guardsTitle(g) {
  if (!g || g.level == null) {
    return 'Guards level unknown — no Omen Essence or Scientific Tractates donation that reveals it yet';
  }
  const source = g.reported ? 'Entered by an admin' : 'Estimated from Omen Essence and Scientific Tractates donations';
  const parts = [
    `G${g.level} — ${source}`,
    `as of ${formatGameDayShort(g.asOf)}`,
    CONFIDENCE_LABEL[g.confidence] || '',
  ];
  if (g.stale) parts.push('no new donations since, so it may be higher by now');
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
  const text = `G${g.level}${g.confidence === 'low' ? '?' : ''}`;
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
  current: 'Gold Pass this Triumphal cycle — Union Chests from the pass track plus the 250k Scientific Tractates each one donates',
  previous: 'Had a Gold Pass last Triumphal cycle — not seen in this one yet',
};

/**
 * A small "GP" marker, or '' when the member has no pass in either cycle.
 * `title` overrides the tooltip for a page showing some other cycle.
 */
export function goldPassBadgeHtml(status, title = null) {
  if (status !== 'current' && status !== 'previous') return '';
  return `<span class="gold-pass-badge is-${status}" title="${esc(title || GOLD_PASS_TITLE[status])}">GP</span>`;
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
