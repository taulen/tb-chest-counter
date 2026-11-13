// Per-player chest breakdown on the leaderboard: what a member's points in the
// window on screen were made of, one line per chest source ("Level 10 Crypt ·
// 100 chests · 500 points"), in the sections of the FAQ's points table. The
// server builds it (src/data/member-source-breakdown.ts) with the board's own
// filter, so the lines always add up to the row they explain.
//
// Two tiers, like the screenshot-evidence previews in ui.js:
//
//  - Hover a row (desktop, real pointer) → a large read-only card beside the
//    name. It never takes the pointer (pointer-events: none), so running the
//    mouse down the board moves it from row to row instead of parking on top of
//    the rows below; once one is open, the next row's swaps in without waiting.
//  - Click / tap the player's name, or Enter on it → the same overview in a
//    modal that scrolls. That is the phone path (no hover there, and a tap
//    anywhere else on the row still expands it — mobile-rows.js leaves buttons
//    alone) and the keyboard path. It is also where a card too long to show in
//    full is read: the card says so.
//
// The page owns the data: `load(memberId)` fetches for the window it is
// showing, `context(memberId)` names the member, their rank and that window,
// and it calls reset() whenever it re-fetches the board — a scan may have added
// chests, and the rows the card was anchored to are gone.
//
// The public share page uses it; the signed-in board links each name to the
// member's profile instead, which has all of this and more. Keep the imports to
// what that page can load (no session, no router).

import { esc, escapeHtml, contentModal } from './ui.js';
import { t, tn, tGame } from './i18n.js';
import { pointsSectionTitle } from './leaderboard-faq.js';

const PHONE = '(max-width: 640px)';
const FINE_HOVER = '(hover: hover) and (pointer: fine)';
// Hover intent: a pointer crossing the board on its way somewhere else opens nothing.
const SHOW_DELAY_MS = 220;
// Leaving a row for its neighbour swaps the card instead of flashing it shut.
const HIDE_DELAY_MS = 120;
// More lines than this (sections count as one each) flow into two columns, when
// there is room for them.
const TWO_COLUMN_LINES = 14;
// The card's two-column form is ~860px; below this viewport it stays one column.
const TWO_COLUMN_MIN_VIEWPORT = 1100;

const ROW_SELECTOR = '.leaderboard-table tbody tr';
const TRIGGER_SELECTOR = '[data-breakdown-member]';

const fmt = (n) => Number(n || 0).toLocaleString();

/**
 * The player cell for a board that offers the breakdown: the name as a button
 * (it opens the modal), carrying the member id the card and modal fetch by.
 */
export function breakdownNameHtml(entry) {
  return `<button type="button" class="lb-name-btn" data-breakdown-member="${Number(entry.memberId)}" aria-haspopup="dialog">${escapeHtml(entry.memberName)}</button>`;
}

// ─── Rendering ────────────────────────────────────────────────

function lineCount(data) {
  return data.sections.reduce((n, s) => n + s.rows.length + 1, 0);
}

/**
 * Sections into two columns at the section boundary that balances them best.
 * Sections are never split: a heading on one side and its rows on the other
 * would read as two sources of the same name.
 */
function splitColumns(sections) {
  const sizes = sections.map((s) => s.rows.length + 1);
  const total = sizes.reduce((a, b) => a + b, 0);
  let best = sections.length;
  let bestMax = total;
  let left = 0;
  for (let k = 1; k < sections.length; k++) {
    left += sizes[k - 1];
    const max = Math.max(left, total - left);
    if (max < bestMax) { bestMax = max; best = k; }
  }
  return [sections.slice(0, best), sections.slice(best)];
}

function sectionHtml(section, totalPoints) {
  const rows = section.rows.map((r) => {
    // The fill behind a line is its share of the member's points: the lines
    // that made the score stand out at a glance. Under 1% it is left off — a
    // hairline at the left edge reads as a stray border, not as a share.
    const pct = totalPoints > 0 ? (r.points / totalPoints) * 100 : 0;
    const share = pct >= 1 ? Math.round(pct * 10) / 10 : 0;
    const name = r.source ? tGame(r.source) : '';
    const label = name ? escapeHtml(name) : `<em>${t('Unknown source')}</em>`;
    // Truncated with an ellipsis in a narrow column, so the full name is the title.
    return `<div class="lbb-line lbb-row${r.points === 0 ? ' is-zero' : ''}" role="row" style="--lbb-share: ${share}%">
        <span class="lbb-src" role="rowheader"${name ? ` title="${esc(name)}"` : ''}>${label}</span>
        <span class="lbb-num" role="cell">${fmt(r.chests)}</span>
        <span class="lbb-num lbb-pts" role="cell">${fmt(r.points)}</span>
      </div>`;
  }).join('');
  return `<div class="lbb-section" role="rowgroup">
      <div class="lbb-line lbb-section-head" role="row">
        <span class="lbb-src" role="rowheader">${escapeHtml(pointsSectionTitle(section.key) || section.key)}</span>
        <span class="lbb-num" role="cell">${fmt(section.chests)}</span>
        <span class="lbb-num" role="cell">${fmt(section.points)}</span>
      </div>
      ${rows}
    </div>`;
}

// Divs with table roles rather than a <table>: two columns of sections have to
// balance side by side, and the lines sit on one shared grid inside each.
function columnHtml(sections, totalPoints) {
  return `<div class="lbb-col" role="table">
      <div class="lbb-line lbb-colhead" role="row">
        <span role="columnheader">${t('Source')}</span>
        <span class="lbb-num" role="columnheader">${t('Chests')}</span>
        <span class="lbb-num" role="columnheader">${t('Points')}</span>
      </div>
      ${sections.map((s) => sectionHtml(s, totalPoints)).join('')}
    </div>`;
}

function bodyHtml(data, twoColumns) {
  if (!data.sections.length || !data.totalChests) {
    return `<p class="lbb-empty">${t('No chests in this timeframe.')}</p>`;
  }
  const cols = twoColumns ? splitColumns(data.sections).filter((c) => c.length) : [data.sections];
  return `<div class="lbb-cols${cols.length > 1 ? ' is-two' : ''}">
      ${cols.map((c) => columnHtml(c, data.totalPoints)).join('')}
    </div>`;
}

function totalsHtml(data) {
  return `<div class="lbb-totals">
      <span>${tn(data.totalChests, '{n} chest', '{n} chests', { n: `<strong>${fmt(data.totalChests)}</strong>` })}</span>
      <span>${tn(data.totalPoints, '{n} point', '{n} points', { n: `<strong>${fmt(data.totalPoints)}</strong>` })}</span>
    </div>`;
}

function rankHtml(rank) {
  return Number.isFinite(rank) ? `<span class="rank rank-${rank}">#${rank}</span>` : '';
}

/** The hover card: name, rank and window up top, then totals and the lines. */
function cardHtml(ctx, { data = null, state = 'ready', twoColumns = false } = {}) {
  const head = `<div class="lbb-head">
      <div class="lbb-who">${rankHtml(ctx.rank)}<span class="lbb-name">${escapeHtml(ctx.memberName || '')}</span></div>
      ${ctx.windowLabel ? `<div class="lbb-when">${escapeHtml(ctx.windowLabel)}</div>` : ''}
    </div>`;
  if (state === 'loading') return `${head}<p class="lbb-empty">${t('Loading…')}</p>`;
  if (state === 'error') return `${head}<p class="lbb-empty">${t("Couldn't load this player's chests.")}</p>`;
  return `${head}
    ${totalsHtml(data)}
    <div class="lbb-body">${bodyHtml(data, twoColumns)}</div>
    <div class="lbb-more">${t('Click the name for the full list')}</div>`;
}

/** The modal's content: the title already names the member. */
function sheetHtml(ctx, data, twoColumns) {
  return `<div class="lbb-sheet-meta">${rankHtml(ctx.rank)}${ctx.windowLabel ? `<span class="lbb-when">${escapeHtml(ctx.windowLabel)}</span>` : ''}</div>
    ${totalsHtml(data)}
    <div class="lbb-body">${bodyHtml(data, twoColumns)}</div>`;
}

// ─── Behaviour ────────────────────────────────────────────────

/**
 * Wire the hover card and the name → modal on a board rendered inside `root`.
 * Delegated, so it survives every re-render. Returns { reset }.
 *
 *  - `load(memberId)`    → Promise of the /breakdown response for the window
 *                          on screen.
 *  - `context(memberId)` → { memberName, rank, windowLabel } from the board
 *                          the page last rendered, so the card can name the
 *                          member before its data arrives.
 */
export function initLeaderboardBreakdown(root, { load, context }) {
  // memberId → Promise. A failed load is dropped so the next hover retries it.
  const cache = new Map();
  let card = null;
  let cardRow = null;
  let pendingRow = null;
  let showTimer = 0;
  let hideTimer = 0;

  const isPhone = () => window.matchMedia(PHONE).matches;
  const canHover = () => window.matchMedia(FINE_HOVER).matches && !isPhone();
  const rowOf = (el) => el?.closest?.(ROW_SELECTOR) || null;
  const memberOf = (row) => {
    const id = Number(row?.querySelector(TRIGGER_SELECTOR)?.dataset.breakdownMember);
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  function fetchFor(memberId) {
    let p = cache.get(memberId);
    if (!p) {
      p = Promise.resolve().then(() => load(memberId));
      cache.set(memberId, p);
      p.catch(() => { if (cache.get(memberId) === p) cache.delete(memberId); });
    }
    return p;
  }

  function hideCard() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    pendingRow = null;
    cardRow = null;
    if (card) {
      card.remove();
      card = null;
    }
  }

  /**
   * Top level with the row, as far RIGHT as it goes — flush with the row's end —
   * but never over the hovered name (and its GP badge). So it covers numbers,
   * which it restates, rather than the names a visitor steers down the board
   * by; only a window too narrow for both puts it over the name. Clamped into
   * the viewport.
   */
  function place() {
    if (!card || !cardRow) return;
    const trigger = cardRow.querySelector(TRIGGER_SELECTOR);
    const anchor = trigger?.closest('.name-badged') || trigger || cardRow;
    const a = anchor.getBoundingClientRect();
    const r = cardRow.getBoundingClientRect();
    const viewW = document.documentElement.clientWidth;
    const viewH = document.documentElement.clientHeight;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    let left = Math.max(Math.min(a.right, r.right) + 24, r.right - w);
    if (left + w > viewW - 8) left = viewW - w - 8;
    left = Math.max(8, left);
    let top = r.top - 8;
    if (top + h > viewH - 8) top = viewH - h - 8;
    top = Math.max(8, top);
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  function paint(html, { wide = false } = {}) {
    if (!card) {
      card = document.createElement('div');
      card.className = 'lbb-card';
      // The modal is the accessible form of this; the card is a glance for a
      // mouse, and announcing it on every row crossed would be noise.
      card.setAttribute('aria-hidden', 'true');
      document.body.appendChild(card);
      requestAnimationFrame(() => card?.classList.add('visible'));
    }
    card.classList.toggle('is-wide', wide);
    card.innerHTML = html;
    place();
    const body = card.querySelector('.lbb-body');
    card.classList.toggle('is-clipped', !!body && body.scrollHeight > body.clientHeight + 1);
  }

  function showFor(row) {
    pendingRow = null;
    const memberId = memberOf(row);
    if (!memberId || !row.isConnected) { hideCard(); return; }
    cardRow = row;
    const ctx = context(memberId) || {};
    // Painted first; a cached answer replaces it in a microtask, before the
    // browser paints, so a known member never flashes "Loading…".
    paint(cardHtml(ctx, { state: 'loading' }));
    fetchFor(memberId).then(
      (data) => {
        if (cardRow !== row) return; // the pointer has moved on
        const wide = lineCount(data) > TWO_COLUMN_LINES
          && document.documentElement.clientWidth >= TWO_COLUMN_MIN_VIEWPORT;
        paint(cardHtml(ctx, { data, twoColumns: wide }), { wide });
      },
      () => {
        if (cardRow === row) paint(cardHtml(ctx, { state: 'error' }));
      },
    );
  }

  async function openSheet(memberId) {
    hideCard();
    const ctx = context(memberId) || {};
    const modal = contentModal({
      title: ctx.memberName || '',
      html: `<p class="lbb-empty">${t('Loading…')}</p>`,
      className: 'lbb-modal',
    });
    if (!modal) return;
    try {
      const data = await fetchFor(memberId);
      const two = lineCount(data) > TWO_COLUMN_LINES;
      modal.overlay.querySelector('.modal-card')?.classList.toggle('is-two', two);
      modal.setHtml(sheetHtml(ctx, data, two));
    } catch {
      modal.setHtml(`<p class="lbb-empty">${t("Couldn't load this player's chests.")}</p>`);
    }
  }

  function pointAt(target) {
    if (!canHover()) return;
    const row = rowOf(target);
    if (!row || !memberOf(row)) return;
    clearTimeout(hideTimer);
    if (row === cardRow || row === pendingRow) return;
    clearTimeout(showTimer);
    if (card) {
      // Warm: a card is already up, so the move to another row swaps at once.
      showFor(row);
    } else {
      pendingRow = row;
      showTimer = setTimeout(() => showFor(row), SHOW_DELAY_MS);
    }
  }

  root.addEventListener('mouseover', (event) => pointAt(event.target));
  // A scroll closes the card, and the pointer is then already over a row:
  // moving it within that row fires no mouseover, so without this the card
  // stayed away until the pointer crossed into another one.
  root.addEventListener('mousemove', (event) => {
    if (!card && !pendingRow) pointAt(event.target);
  });

  root.addEventListener('mouseout', (event) => {
    const row = rowOf(event.target);
    if (!row || row.contains(event.relatedTarget)) return;
    if (row === pendingRow) {
      clearTimeout(showTimer);
      pendingRow = null;
    }
    if (!card) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideCard, HIDE_DELAY_MS);
  });

  // Keyboard: tabbing onto a name shows its card, as hovering would. Not while
  // a modal is up or closing — closing one hands focus back to the name, and a
  // card popping up over the board the moment the modal goes is not wanted.
  root.addEventListener('focusin', (event) => {
    const trigger = event.target.closest?.(TRIGGER_SELECTOR);
    if (!trigger || isPhone() || !trigger.matches(':focus-visible')) return;
    if (document.querySelector('.modal-overlay')) return;
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    showFor(rowOf(trigger));
  });
  root.addEventListener('focusout', (event) => {
    if (event.target.closest?.(TRIGGER_SELECTOR)) hideCard();
  });

  root.addEventListener('click', (event) => {
    const trigger = event.target.closest?.(TRIGGER_SELECTOR);
    if (!trigger) return;
    event.preventDefault();
    const memberId = Number(trigger.dataset.breakdownMember);
    if (Number.isInteger(memberId) && memberId > 0) openSheet(memberId);
  });

  // The card is fixed to the viewport; a scroll would leave it beside a row
  // that has moved away. Capture, so a scrolling table wrapper counts too.
  const hideOnMove = () => { if (card || pendingRow) hideCard(); };
  window.addEventListener('scroll', hideOnMove, { passive: true, capture: true });
  window.addEventListener('resize', hideOnMove, { passive: true });

  return {
    /** Forget every fetched breakdown and close the card: the board re-fetched. */
    reset() {
      cache.clear();
      hideCard();
    },
  };
}
