// A player's titles on the member profile — "Prefect" from the Loyalty Bonus,
// a tournament's "Blademaster", Premium's "Great Marshal": the game's small
// round title icons, tucked into the profile header after the game facts.
// Only here: never in a list or table (user, Nov 2026). Hovering an icon
// (desktop) shows the title's card beside it — time left, the bonus text,
// where it comes from — and a click or tap opens the same in a dialog (the
// keyboard and touch path), as the Captains tab's tiles do.
// Data: GET /api/game/members/:id → `titles` (game-protocol/titles.ts).

import { esc, formatDate, formatDateShort } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { itemIconHtml } from '../lib/game-art.js';
import { wireTiles } from './member-captains.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Time left until `iso`: "6 days left", "3 h left", "12 min left". */
export function titleTimeLeft(iso, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return tn(days, '{n} day left', '{n} days left');
  const hours = Math.floor(ms / HOUR_MS);
  if (hours >= 1) return t('{n} h left', { n: hours });
  return t('{n} min left', { n: Math.max(1, Math.ceil(ms / 60_000)) });
}

/** How long the title lasts from when it was received: "Lasts 7 days" (whole days), else hours. */
function titleDuration(seconds) {
  const s = Number(seconds) || 0;
  if (s % 86_400 === 0) return tn(s / 86_400, 'Lasts {n} day', 'Lasts {n} days');
  return t('Lasts {n} h', { n: Math.round(s / 3_600) });
}

/** "2026/11/18 10:16" — the date and the minute (formatDate adds the seconds). */
const dateMinute = (iso) => formatDate(iso).slice(0, 16);

/** The title's card: its picture, time left, the game's bonus text and source, when received / ending. */
function titleDetailHtml(tt, { withName = false } = {}) {
  const name = tGame(tt.name);
  const lines = tGame(tt.description).split('\n').map((l) => l.trim()).filter(Boolean);
  const time = tt.endsAt
    ? `<strong>${esc(titleTimeLeft(tt.endsAt))}</strong><span>${esc(titleDuration(tt.seconds))}</span>`
    : `<strong>${esc(t('No set end'))}</strong>`;
  const times = Number(tt.times) || 0;
  return `<div class="title-detail">
      <div class="title-detail-art">${itemIconHtml(tt.artUrl || tt.iconUrl, { size: 64, name })}</div>
      <div class="title-detail-body">
        ${withName ? `<div class="title-detail-name">${esc(name)}</div>` : ''}
        <div class="title-detail-time">${time}</div>
        ${lines.length ? `<ul class="title-detail-bonus">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
        ${tt.source ? `<p class="title-detail-source">${esc(tGame(tt.source))}</p>` : ''}
        <dl class="title-detail-facts">
          <div><dt>${t('Received')}</dt><dd title="${esc(formatDate(tt.receivedAt))}">${esc(formatDateShort(tt.receivedAt))}</dd></div>
          ${tt.endsAt ? `<div><dt>${t('Ends')}</dt><dd title="${esc(formatDate(tt.endsAt))}">${esc(dateMinute(tt.endsAt))}</dd></div>` : ''}
        </dl>
        ${times > 1 ? `<p class="title-detail-note">${esc(tn(times, 'Received {n} time in all', 'Received {n} times in all'))}</p>` : ''}
      </div>
    </div>`;
}

/**
 * The header's row of title icons (empty when the member holds none). Each
 * is a button — its name and time left as its label — so the keyboard and
 * screen readers reach the same card the pointer does.
 */
export function memberTitlesHtml(titles) {
  if (!Array.isArray(titles) || !titles.length) return '';
  const icons = titles.map((tt, i) => {
    const name = tGame(tt.name);
    const left = tt.endsAt ? titleTimeLeft(tt.endsAt) : t('No set end');
    const art = tt.iconUrl
      ? `<img src="${esc(tt.iconUrl)}" alt="" width="26" height="26" decoding="async">`
      : `<span class="member-title-letter" aria-hidden="true">${esc((name.trim()[0] ?? '?').toUpperCase())}</span>`;
    return `<button type="button" class="member-title" data-tile="title" data-index="${i}" data-card-place="below" aria-haspopup="dialog"`
      + ` aria-label="${esc(t('{title}: {left}', { title: name, left }))}">${art}</button>`;
  }).join('');
  return `<div class="member-titles" role="group" aria-labelledby="memberTitlesLabel">`
    + `<span class="member-titles-label" id="memberTitlesLabel">${t('Titles')}</span>${icons}</div>`;
}

/** Hover card and dialog for the header's title icons, once the header is in the page. */
export function wireMemberTitles(root, titles) {
  const el = root?.querySelector('.member-titles');
  if (!el || !Array.isArray(titles)) return;
  wireTiles(el, {
    title: (i) => {
      const tt = titles[i];
      return tt && {
        title: tGame(tt.name),
        html: titleDetailHtml(tt),
        hoverHtml: titleDetailHtml(tt, { withName: true }),
      };
    },
  });
}
