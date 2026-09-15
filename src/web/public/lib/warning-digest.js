// Turning raw warn/error log lines into something an operator will actually
// read on the System page.
//
// The problem this exists for: these messages are written for a log file,
// where the reader has already decided to read the line and wants the reason
// and the remedy in it. The System page showed them verbatim in a table — on
// 2026-09-15 that was 19 entries with a median of 171 characters and one of
// 637, all in the same weight, with nothing to separate an idle note about a
// chart gap from a clan whose roster capture had failed. The predictable
// outcome is that the whole card gets dismissed unread, which costs more than
// showing nothing would.
//
// No DOM and no imports, so it can be tested directly (same arrangement as
// leaderboard-render.js). The rendering itself stays in pages/system.js.

// Longest a derived headline may run before it is cut on a word boundary.
export const HEADLINE_MAX = 96;

// Below this, a cut has not yet said anything useful, so a too-short headline
// is worse than a slightly long one.
const MIN_CUT = 50;

/**
 * The one-line headline for a warning, derived from the message text.
 *
 * Nothing is authored at the call site. Deriving works because the messages
 * are, near enough without exception, already headline-first: a short clause
 * naming what happened, then an em dash or a full stop, then the explanation
 * and the remedy. So the first clause IS the headline and the rest is what
 * the expanded row is for. That also means it keeps working for call sites
 * nobody has touched, and for ones added later.
 *
 * Cut points, in order:
 *   1. An em dash surrounded by spaces. Never a hyphen — clan names contain
 *      one ("CWB - ChaosWithoutBorders") and cutting there would behead the
 *      message at the clan name.
 *   2. The end of the first sentence, but only where a capital or a digit
 *      starts the next one, so "1 h 0 m", "v1.2" and "#2." are not read as
 *      sentence ends.
 *   3. The last comma-clause boundary, so an over-long line ends on a clause
 *      rather than mid-thought ("...already recorded, because the" reads as a
 *      truncation; "...already recorded" reads as a headline).
 *   4. A hard cut on the last word boundary.
 */
export function warningHeadline(msg) {
  const text = String(msg == null ? '' : msg).replace(/\s+/g, ' ').trim();
  if (!text) return '(empty message)';

  const dash = text.indexOf(' — ');
  if (dash > 0 && dash <= HEADLINE_MAX) return text.slice(0, dash);

  const sentence = text.search(/\.\s+(?=[A-Z0-9])/);
  if (sentence > 0 && sentence <= HEADLINE_MAX) return text.slice(0, sentence);

  if (text.length <= HEADLINE_MAX) return text;

  const comma = text.lastIndexOf(', ', HEADLINE_MAX);
  if (comma > MIN_CUT) return text.slice(0, comma) + '…';

  const cut = text.lastIndexOf(' ', HEADLINE_MAX);
  return text.slice(0, cut > MIN_CUT ? cut : HEADLINE_MAX) + '…';
}

/** True when the expanded body would show more than the headline already did. */
export function hasMoreThanHeadline(msg, headline) {
  const full = String(msg == null ? '' : msg).replace(/\s+/g, ' ').trim();
  return full.length > String(headline).replace(/…$/, '').length;
}

/**
 * Fold identical messages into one entry carrying a count.
 *
 * A repeat says nothing the first one didn't, and the buffer is finite: on
 * 2026-09-15 three identical "Discord member lookup failed" lines held three
 * of the twenty slots, which is three real problems that could not be shown.
 *
 * Keyed on level + module + message, so two modules reporting the same string
 * stay distinct. The folded entry keeps the NEWEST timestamp, because the
 * question being asked of it is "is this still happening?", not "when did it
 * start" — `firstTs` carries the other end for anything that wants it.
 */
export function groupWarnings(entries) {
  const byKey = new Map();
  for (const e of entries || []) {
    const key = [e.levelName, e.module, e.msg].join('␟');
    const seen = byKey.get(key);
    if (seen) {
      seen.count++;
      if (e.ts > seen.ts) seen.ts = e.ts;
      if (e.ts < seen.firstTs) seen.firstTs = e.ts;
    } else {
      byKey.set(key, Object.assign({}, e, { count: 1, firstTs: e.ts }));
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.ts - a.ts);
}

/**
 * Split grouped entries into the ones asking for something and the rest.
 *
 * The split reuses the `alert` flag that already drives the System nav dot
 * (`log.warn({ noAlert: true }, ...)` at the call site), so one place decides
 * whether something is actionable rather than the UI forming a second opinion
 * that could disagree with the dot.
 */
export function splitWarnings(entries) {
  const grouped = groupWarnings(entries);
  return {
    attention: grouped.filter((e) => e.alert !== false),
    fyi: grouped.filter((e) => e.alert === false),
  };
}
