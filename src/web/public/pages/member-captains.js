// Captains tab on the member profile: every captain the player owns, the way
// the game's Captains screen shows them — portrait in its rarity frame, level
// badge, star level, the active line-up — read from the member's city record
// (GET /api/game/members/:id/captains). Hovering a captain (desktop) shows its
// details beside it; a click or tap opens them in a dialog.

import { api } from '../lib/api.js';
import { contentModal, esc, formatDate, formatDateShort } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';

const FINE_HOVER = '(hover: hover) and (pointer: fine)';
// Hover intent: a pointer crossing the grid on its way elsewhere opens nothing.
const SHOW_DELAY_MS = 200;
const HIDE_DELAY_MS = 100;
const HISTORY_LINES = 8;

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

/** The panel placeholder; mountMemberCaptains fills it the first time its tab opens. */
export function memberCaptainsPanelHtml() {
  return `<div class="member-captains" data-member-captains><div class="card"><div class="card-body card-body-padded"><p class="muted-copy">${t('Loading…')}</p></div></div></div>`;
}

function noteCard(text) {
  return `<div class="card"><div class="card-body card-body-padded"><div class="empty-state"><p>${text}</p></div></div></div>`;
}

/** Filled stars, then empty ones up to `max` (the detail view shows how far it can go). */
function starsHtml(n, max = 0) {
  const on = '<span class="captain-star is-on" aria-hidden="true">★</span>'.repeat(Math.max(0, n));
  const off = max > n ? '<span class="captain-star" aria-hidden="true">★</span>'.repeat(max - n) : '';
  return `<span class="captain-stars" role="img" aria-label="${esc(tn(n, '{n} star', '{n} stars', { n }))}">${on}${off}</span>`;
}

function portraitHtml(c, cls = 'captain-portrait') {
  return c.iconUrl
    ? `<img class="${cls}" src="${esc(c.iconUrl)}" alt="" loading="lazy" decoding="async">`
    : `<span class="${cls} is-empty" aria-hidden="true"></span>`;
}

function tileHtml(c, i) {
  return `<button type="button" class="captain-tile rarity-${Number(c.rarity) || 0}" data-captain-index="${i}" aria-haspopup="dialog">
      <span class="captain-frame">
        ${portraitHtml(c)}
        <span class="captain-level">${c.level}</span>
        ${c.stars ? starsHtml(c.stars) : ''}
      </span>
      <span class="captain-name">${esc(tGame(c.name))}</span>
    </button>`;
}

function changeText(ch) {
  if (ch.prevLevel === null) return t('New captain');
  const parts = [];
  if (ch.prevLevel !== ch.level) parts.push(t('Level {from} → {to}', { from: ch.prevLevel, to: ch.level }));
  if (ch.prevStars !== ch.stars) parts.push(t('Stars {from} → {to}', { from: ch.prevStars, to: ch.stars }));
  return parts.join(' · ');
}

/** The captain's details: art, rarity, level, stars, XP, line-up, star bonuses, history. */
function detailHtml(c, changes, { withName = false } = {}) {
  const art = c.artUrl || c.iconUrl;
  const bonuses = Array.isArray(c.starBonuses) ? c.starBonuses : [];
  const history = changes.filter((ch) => ch.captainId === c.captainId).slice(0, HISTORY_LINES);
  return `<div class="captain-detail rarity-${Number(c.rarity) || 0}">
      <div class="captain-detail-art${c.artUrl ? '' : ' is-portrait'}">${art ? `<img src="${esc(art)}" alt="" decoding="async">` : ''}</div>
      <div class="captain-detail-body">
        ${withName ? `<div class="captain-detail-name">${esc(tGame(c.name))}</div>` : ''}
        <div class="captain-detail-head">
          <span class="captain-detail-level">${t('Level {n}', { n: c.level })}</span>
          ${c.rarityName ? `<span class="captain-detail-rarity">${esc(tGame(c.rarityName))}</span>` : ''}
        </div>
        ${starsHtml(c.stars, c.maxStars)}
        <dl class="captain-detail-facts">
          ${c.xp != null ? `<div><dt>${t('XP')}</dt><dd>${fmt(c.xp)}</dd></div>` : ''}
          ${c.slot ? `<div><dt>${t('Active line-up')}</dt><dd>${t('Slot {n}', { n: c.slot })}</dd></div>` : ''}
          <div><dt>${t('Tracked since')}</dt><dd title="${esc(formatDate(c.firstSeen))}">${esc(formatDateShort(c.firstSeen))}</dd></div>
        </dl>
        ${bonuses.length ? `
          <div class="captain-detail-section">${t('Star level {n}', { n: c.stars })}</div>
          <ul class="captain-bonus-list">${bonuses.map(([text, value]) => `<li><span>${esc(tGame(text))}</span><span class="captain-bonus-value">${esc(value)}</span></li>`).join('')}</ul>` : ''}
        ${history.length ? `
          <div class="captain-detail-section">${t('Level history')}</div>
          <ul class="captain-history">${history.map((ch) => `<li><span>${esc(changeText(ch))}</span><span class="muted-copy">${esc(formatDateShort(ch.changedAt))}</span></li>`).join('')}</ul>` : ''}
        <p class="captain-detail-note">${t("Equipment, artifact and skill bonuses aren't read yet.")}</p>
      </div>
    </div>`;
}

// ─── Hover card (desktop) ───
// One card for the page, fixed-positioned beside the hovered tile. It is a
// preview only (pointer-events: none): the click opens the same details in a
// dialog, which is also the keyboard and touch path.

let hoverCard = null;
let showTimer = 0;
let hideTimer = 0;

function hideHoverCard() {
  clearTimeout(showTimer);
  hoverCard?.classList.remove('is-visible');
}

function showHoverCard(tile, html) {
  if (!hoverCard) {
    hoverCard = document.createElement('div');
    hoverCard.className = 'captain-hovercard';
    hoverCard.setAttribute('aria-hidden', 'true');
    document.body.appendChild(hoverCard);
    window.addEventListener('hashchange', hideHoverCard);
    window.addEventListener('scroll', hideHoverCard, { passive: true, capture: true });
  }
  hoverCard.innerHTML = html;
  hoverCard.classList.add('is-visible');
  const a = tile.getBoundingClientRect();
  const r = hoverCard.getBoundingClientRect();
  const gap = 12;
  const roomRight = window.innerWidth - a.right - gap;
  const left = roomRight >= r.width + 8 ? a.right + gap : Math.max(8, a.left - gap - r.width);
  const top = Math.min(Math.max(8, a.top + a.height / 2 - r.height / 2), window.innerHeight - r.height - 8);
  hoverCard.style.left = `${Math.round(left)}px`;
  hoverCard.style.top = `${Math.round(Math.max(8, top))}px`;
}

function wireTiles(el, captains, changes) {
  const fine = window.matchMedia(FINE_HOVER);
  el.addEventListener('click', (ev) => {
    const tile = ev.target.closest('[data-captain-index]');
    if (!tile) return;
    const c = captains[Number(tile.dataset.captainIndex)];
    if (!c) return;
    hideHoverCard();
    contentModal({ title: tGame(c.name), html: detailHtml(c, changes), className: 'captain-modal' });
  });
  el.addEventListener('mouseover', (ev) => {
    if (!fine.matches) return;
    const tile = ev.target.closest('[data-captain-index]');
    if (!tile || tile.contains(ev.relatedTarget)) return;
    const c = captains[Number(tile.dataset.captainIndex)];
    if (!c) return;
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    // Already showing a card: swap straight to this one.
    const delay = hoverCard?.classList.contains('is-visible') ? 0 : SHOW_DELAY_MS;
    showTimer = setTimeout(() => showHoverCard(tile, detailHtml(c, changes, { withName: true })), delay);
  });
  el.addEventListener('mouseout', (ev) => {
    const tile = ev.target.closest('[data-captain-index]');
    if (!tile || tile.contains(ev.relatedTarget)) return;
    clearTimeout(showTimer);
    hideTimer = setTimeout(hideHoverCard, HIDE_DELAY_MS);
  });
}

export async function mountMemberCaptains(root, memberId) {
  const el = root.querySelector('[data-member-captains]');
  if (!el || el.dataset.mounted === String(memberId)) return;
  el.dataset.mounted = String(memberId);
  let data;
  try {
    data = await api(`/game/members/${memberId}/captains`);
  } catch {
    el.innerHTML = noteCard(t("Couldn't load this member's captains."));
    return;
  }
  if (!data?.linked || !data.captains?.length) {
    el.innerHTML = noteCard(t("This member's captains haven't been read from the game yet — the next scan reads them."));
    return;
  }
  const captains = data.captains;
  const changes = data.changes || [];
  // The game's own order: highest level first (the server sorts it so).
  const lineup = captains
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.slot > 0)
    .sort((a, b) => a.c.slot - b.c.slot);
  const recent = changes.slice(0, 40);
  el.innerHTML = `
    <div class="card">
      <div class="card-header"><h2>${t('Captains')}</h2>
        <span class="card-header-hint">${tn(captains.length, '{n} captain', '{n} captains', { n: captains.length })}</span>
      </div>
      <div class="card-body card-body-padded">
        ${lineup.length ? `
          <div class="captain-group-label">${t('Active line-up')}</div>
          <div class="captain-grid is-lineup">${lineup.map(({ c, i }) => tileHtml(c, i)).join('')}</div>
          <div class="captain-group-label">${t('All captains')}</div>` : ''}
        <div class="captain-grid">${captains.map((c, i) => tileHtml(c, i)).join('')}</div>
      </div>
    </div>
    ${recent.length ? `<div class="card">
      <div class="card-header"><h2>${t('Recent captain progress')}</h2></div>
      <div class="card-body">
        <table class="table-responsive captain-changes-table">
          <colgroup><col class="col-captain"><col class="col-change"><col class="col-date"></colgroup>
          <thead><tr><th>${t('Captain')}</th><th>${t('Change')}</th><th>${t('Date')}</th></tr></thead>
          <tbody>${recent.map((ch) => `<tr>
            <td data-label="${t('Captain')}" data-role="primary"><span class="mrow-name captain-change-name">${ch.iconUrl ? `<img class="captain-change-icon" src="${esc(ch.iconUrl)}" alt="" loading="lazy" decoding="async">` : ''}${esc(tGame(ch.name))}</span></td>
            <td data-label="${t('Change')}" data-role="metric">${esc(changeText(ch))}</td>
            <td data-label="${t('Date')}">${esc(formatDate(ch.changedAt))}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>` : ''}`;
  wireTiles(el, captains, changes);
}
