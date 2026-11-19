// The redesign's shared pieces (docs/design-standard.md; CSS: style.css
// "UI kit"). Pages build from these instead of drawing their own: the page
// header, the sub-tab bar, the period scrubber, segmented controls, tiles,
// bars, deltas, goal bands, notes, empty and error states.
//
// Everything here returns HTML strings (the app renders with innerHTML) or
// wires one already in the page. Every user-visible word goes through t().

import { esc } from './ui.js';
import { t } from './i18n.js';
import { formatPeriodLabel } from './period.js';
import { goalDaysForPeriod } from './leaderboard-render.js';

const DAY_MS = 86_400_000;

/** The period buttons' words. Pages pick which periods they offer. */
export const PERIOD_LABELS = {
  daily: () => t('Day'),
  weekly: () => t('Week'),
  monthly: () => t('Month'),
  yearly: () => t('Year'),
  all: () => t('All'),
};

/** The goal bands: a glyph AND words, never colour alone. */
export const BANDS = {
  ok: { glyph: '✓', label: () => t('Reached') },
  pace: { glyph: '◐', label: () => t('On pace') },
  behind: { glyph: '↓', label: () => t('Behind') },
};

/**
 * The page header is the shell's (#pageHead: the nav entry's name and one
 * line under it, app.js updatePageHead). A page puts its own buttons beside
 * that title here — FAQ, Export CSV, Copy data — never in a second header.
 * The shell empties the slot on every navigation; call this on each render.
 */
export function setPageActions(html) {
  const box = document.getElementById('pageActions');
  if (box) box.innerHTML = html;
}

/**
 * The sub-tab bar for a page with sub-pages: real links to `#page/sub`, so a
 * sub-tab can be bookmarked, opened in a new tab and reached with the
 * keyboard; the current one carries aria-current="page". `items` is
 * `[{ key, label, href, count? }]` — `label` already translated.
 */
export function subTabsHtml({ label, items, current }) {
  return `<nav class="ui-subtabs" aria-label="${esc(label)}">
      ${items.map((it) => `<a class="ui-subtab" href="${esc(it.href)}"${it.key === current ? ' aria-current="page"' : ''}>${esc(it.label)}${it.count != null ? ` <span class="ui-subtab-n">${esc(String(it.count))}</span>` : ''}</a>`).join('')}
    </nav>`;
}

/**
 * A segmented control (one choice of a few): `items` is `[{ value, label }]`,
 * the chosen one aria-pressed. Wire clicks on `[data-<attr>]`.
 */
export function segHtml({ label, items, current, attr }) {
  return `<div class="ui-seg" role="group" aria-label="${esc(label)}">
      ${items.map((it) => `<button type="button" class="ui-seg-btn${it.value === current ? ' is-active' : ''}" aria-pressed="${it.value === current}" data-${attr}="${esc(it.value)}">${esc(it.label)}</button>`).join('')}
    </div>`;
}

/** "2026-11-15 → 2026-11-21" → "2026-11-15 → 21"; across a month "→ 12-05"; anything else as it is. */
export function compactRange(label) {
  const m = String(label).match(/^(\d{4})-(\d{2})-(\d{2}) → (\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return label;
  const [, y1, m1, d1, y2, m2, d2] = m;
  if (y1 !== y2) return label;
  return `${y1}-${m1}-${d1} → ${m1 === m2 ? d2 : `${m2}-${d2}`}`;
}

/**
 * The period scrubber: Day / Week / Month (/ Year) / All, the earlier and
 * later arrows, and where in the window we are ("Game day 3 of 7 · resets
 * 17:00 UTC (18:00 your time)"); on a phone one line ("2026-11-15 → 21 ·
 * day 3 of 7"). Windows follow the game day (lib/period.js).
 *
 *   periods   which buttons ('daily', 'weekly', 'monthly', 'yearly', 'all')
 *   period, offset, rolloverHr, weekStart   the window on screen
 *   win       computeGameWindow(...) for it (null for 'all')
 *
 * Wire it with wirePeriodScrubber().
 */
export function periodScrubberHtml({ periods, period, offset, rolloverHr, weekStart, win }) {
  const running = !!win && offset === 0;
  let where = '';
  let resetText = '';
  let dayShort = '';
  if (running) {
    const reset = new Date(Date.UTC(2000, 0, 1, rolloverHr));
    const local = reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    resetText = t('resets {utc} UTC ({local} your time)', { utc: `${String(rolloverHr).padStart(2, '0')}:00`, local });
    if (period === 'weekly') {
      const days = goalDaysForPeriod('weekly', weekStart);
      const day = Math.min(days, Math.floor((Date.now() - Date.parse(win.from)) / DAY_MS) + 1);
      where = `${t('Game day {day} of {days}', { day, days })} · ${resetText}`;
      dayShort = t('day {day} of {days}', { day, days });
    } else {
      where = resetText;
    }
  }
  const label = formatPeriodLabel(period, offset, rolloverHr, weekStart);
  const short = [compactRange(label), dayShort].filter(Boolean).join(' · ');
  const seg = segHtml({
    label: t('Period'),
    items: periods.map((p) => ({ value: p, label: PERIOD_LABELS[p]() })),
    current: period,
    attr: 'ui-period',
  });
  return `<div class="ui-period">
      ${seg}
      ${period === 'all' ? '' : `<div class="ui-step">
        <button type="button" class="ui-arrow" data-ui-step="1" aria-label="${esc(t('Earlier'))}">‹</button>
        <div class="ui-when"${resetText ? ` title="${esc(resetText)}"` : ''}>
          <span class="ui-when-label">${esc(label)}</span>${where ? `<span class="ui-when-sub">${esc(where)}</span>` : ''}
          <span class="ui-when-short">${esc(short)}${resetText ? `<span class="visually-hidden"> · ${esc(resetText)}</span>` : ''}</span>
        </div>
        <button type="button" class="ui-arrow" data-ui-step="-1" aria-label="${esc(t('Later'))}"${offset === 0 ? ' disabled' : ''}>›</button>
      </div>`}
    </div>`;
}

/**
 * Wire a scrubber drawn by periodScrubberHtml inside `root`: `onPeriod(p)`
 * for another period button, `onStep(delta)` for an arrow (+1 = earlier).
 * The current period's button does nothing.
 */
export function wirePeriodScrubber(root, { onPeriod, onStep }) {
  const box = root.querySelector('.ui-period');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('button') : null;
    if (!b || b.disabled) return;
    if (b.dataset.uiPeriod) {
      if (b.getAttribute('aria-pressed') === 'true') return;
      onPeriod(b.dataset.uiPeriod);
    } else if (b.dataset.uiStep) {
      onStep(Number(b.dataset.uiStep));
    }
  });
}

/** A tile on the bento grid (.ui-grid): `span` 4 / 6 / 8 / 12; `body` and `link` are HTML. */
export function tileHtml(id, title, body, { span = 6, link = '', cls = '' } = {}) {
  return `<section class="ui-tile span-${span}${cls ? ` ${cls}` : ''}" aria-labelledby="ui-t-${esc(id)}">
      <div class="ui-tile-head"><h2 id="ui-t-${esc(id)}" class="ui-tile-title">${title}</h2>${link}</div>
      ${body}
    </section>`;
}

/**
 * One headline number in a .ui-stats strip: a label, the number (`value` and
 * `of` are HTML, e.g. "79" and " / 100"), and a line under it (`sub`, HTML —
 * a deltaHtml, a short fact). `extra` is anything below that (a sparkline).
 */
export function statHtml({ label, value, of = '', sub = '', extra = '', cls = '' }) {
  const classes = ['ui-stat', statFitClass(value), cls].filter(Boolean).join(' ');
  return `<div class="${classes}">
      <div class="ui-stat-label">${label}</div>
      <div class="ui-big">${value}${of ? `<span class="ui-big-of">${of}</span>` : ''}</div>
      ${sub ? `<div class="ui-sub">${sub}</div>` : ''}${extra}
    </div>`;
}

/**
 * A long headline has no break in it and is wider than a card in a
 * seven-card strip at the full size: "1,563,768" (a chest's all-time points)
 * and "2026/11/13" (its First Seen) both spilled out. These classes let it
 * shrink to its own card (style.css "is-fit"); a short one keeps its size.
 */
function statFitClass(valueHtml) {
  const n = String(valueHtml ?? '').replace(/<[^>]*>/g, '').replace(/&#?\w+;/g, 'x').trim().length;
  return n >= 10 ? 'is-fit-10' : n >= 8 ? 'is-fit-8' : '';
}

/** The "Somewhere →" link in a tile's corner. */
export function tileLinkHtml(href, label) {
  return `<a class="ui-tile-link" href="${esc(href)}">${esc(label)} <span aria-hidden="true">→</span></a>`;
}

/** "▲ 1,234" / "▼ 56" / "± 0", with optional words after; '' when there is no delta. */
export function deltaHtml(delta, label) {
  if (delta === null || delta === undefined) return '';
  const cls = delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : 'is-flat';
  const glyph = delta > 0 ? '▲' : delta < 0 ? '▼' : '±';
  return `<span class="ui-delta ${cls}"><span aria-hidden="true">${glyph}</span> ${Math.abs(Number(delta) || 0).toLocaleString()}${label ? ` <span class="ui-delta-label">${esc(label)}</span>` : ''}</span>`;
}

/** A goal band as words with its glyph: "✓ Reached". */
export function bandHtml(band, tag = 'span') {
  const b = BANDS[band];
  if (!b) return '';
  return `<${tag} class="ui-band band-${band}"><span aria-hidden="true">${b.glyph}</span> ${esc(b.label())}</${tag}>`;
}

/**
 * A bar against a goal line (bright) and a pace line (thin), filled in the
 * band's colour. `max` scales it; pass `cls` for a page's own size.
 */
export function barHtml({ points, goal = null, pace = null, band = null, max = 0, cls = '' }) {
  const top = Math.max(max || 0, goal || 0, points || 0, 1);
  const pct = (v) => `${Math.max(0, Math.min(100, (v / top) * 100)).toFixed(2)}%`;
  return `<div class="ui-bar${cls ? ` ${cls}` : ''}" aria-hidden="true">
      <div class="ui-bar-fill${band ? ` band-${band}` : ''}" style="--w:${pct(points || 0)}"></div>
      ${pace ? `<span class="ui-bar-tick is-pace" style="--x:${pct(pace)}"></span>` : ''}
      ${goal ? `<span class="ui-bar-tick is-goal" style="--x:${pct(goal)}"></span>` : ''}
    </div>`;
}

/** Notices: plain facts as a short list (information, never advice). `lines` are HTML. */
export function notesHtml(lines) {
  return lines.length ? `<ul class="ui-notes">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>` : '';
}

/**
 * A tile that folds (native <details>): "How this works", fine-tuning, a long
 * list. `key` becomes its data-section-key, so the open state survives a
 * re-render (lib/ui.js). `title` and `body` are HTML; `inset` for one inside
 * another tile.
 */
export function foldHtml({ key, title, body, open = false, inset = false, cls = '' }) {
  return `<details class="ui-fold${inset ? ' is-inset' : ''}${cls ? ` ${cls}` : ''}" data-section-key="${esc(key)}"${open ? ' open' : ''}>
      <summary class="ui-fold-head"><h2 class="ui-tile-title">${title}</h2></summary>
      <div class="ui-fold-body">${body}</div>
    </details>`;
}

/** Nothing to show — say so in one plain sentence. */
export function emptyHtml(text) {
  return `<p class="ui-empty">${esc(text)}</p>`;
}

/**
 * api() hands back whatever JSON the server sent, so a refusal (a 429, a
 * 500's { error, ref }) arrives as an OBJECT where a list was expected.
 * Use this before `.map`: the list, or [] for anything else.
 */
export function asList(value) {
  return Array.isArray(value) ? value : [];
}

/** The server's own words for a refusal answer, or ''. */
export function refusalText(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.error === 'string' ? value.error : '';
}

/**
 * Something could not load: say what, show the server's reason when it gave
 * one, and offer Try again. Wire the button with wireRetry().
 */
export function errorStateHtml(what, why = '') {
  return `<div class="ui-error-box" role="status">
      <p class="ui-error">${esc(what)}${why ? ` <span class="ui-error-why">${esc(why)}</span>` : ''}</p>
      <button type="button" class="btn btn-primary" data-ui-retry>${esc(t('Try again'))}</button>
    </div>`;
}

/** Run `again()` when the error state's Try again is pressed. */
export function wireRetry(root, again) {
  root.querySelector('[data-ui-retry]')?.addEventListener('click', () => { void again(); });
}

/**
 * One stat tile for a row of them (wrap the row in statTilesHtml): a label, a
 * big number (`value` is HTML; the exact figure in `title`), an optional line
 * under it. With `href` the whole tile is a link — a rank that opens its
 * ranking — and `attrs` adds raw attributes to it (data-*).
 */
export function statTileHtml({ label, value, title = '', sub = '', href = '', attrs = '' }) {
  const inner = `<span class="ui-stat-label">${esc(label)}</span>
      <span class="ui-big"${title ? ` title="${esc(title)}"` : ''}>${value}</span>
      ${sub ? `<span class="ui-sub">${esc(sub)}</span>` : ''}`;
  return href
    ? `<a class="ui-stat-tile is-link" href="${esc(href)}"${attrs ? ` ${attrs}` : ''}>${inner}</a>`
    : `<div class="ui-stat-tile"${attrs ? ` ${attrs}` : ''}>${inner}</div>`;
}

/** A row of stat tiles: as many to a line as fit (two on a phone). */
export function statTilesHtml(tiles, cls = '') {
  return tiles.length ? `<div class="ui-stats${cls ? ` ${cls}` : ''}">${tiles.join('')}</div>` : '';
}

/**
 * A titled card around a table or a list (.ui-table-card): the title and a
 * quiet hint in its head, optional padded content above the table (`before`:
 * a picker, a summary line), the table full-bleed, and `foot` (the site's
 * .pagination) as its last row. `title`, `hint`, `before`, `body` and `foot`
 * are HTML.
 */
export function tableCardHtml({ title, hint = '', hintTitle = '', before = '', body, foot = '', cls = '' }) {
  return `<section class="ui-table-card${cls ? ` ${cls}` : ''}">
      <div class="ui-card-head"><h2 class="ui-tile-title">${title}</h2>${hint ? `<span class="ui-sub"${hintTitle ? ` title="${esc(hintTitle)}"` : ''}>${hint}</span>` : ''}</div>
      ${before ? `<div class="ui-card-pad">${before}</div>` : ''}
      ${body}
      ${foot}
    </section>`;
}
