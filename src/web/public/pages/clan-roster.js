// My Clan → Joins & leaves: who joined the clan, who left and who came back,
// newest first, grouped by game day (GET /api/game/clan/roster-changes; the
// rules are data/roster-changes.ts's, the same the member Timeline uses).
// Dense rows like the Timeline: a time gutter, what happened, the player's
// framed portrait and one line. Chips (All / Joins / Leaves) and a name search
// reload from the top; "Load older" pages by cursor. A list, not a table, so
// the phone layout is the Timeline's narrower grid rather than mobile rows.

import { api } from '../lib/api.js';
import { esc, formatDate, formatGameDayShort, memberLink } from '../lib/ui.js';
import { t, tn } from '../lib/i18n.js';
import { heroAvatarHtml } from '../lib/game-facts.js';
import { gameDayKeyFor } from '../lib/period.js';

const PAGE = 50;
const SEARCH_DELAY_MS = 250;

const FILTERS = [
  { key: '', label: () => t('All') },
  { key: 'joined', label: () => t('Joins') },
  { key: 'left', label: () => t('Leaves') },
];

/** The panel's placeholder until the tab is first opened (mountRoster fills it). */
export function rosterPanelHtml() {
  return `<div class="clan-roster" data-clan-roster><div class="card"><div class="card-body card-body-padded"><p class="muted-copy">${t('Loading…')}</p></div></div></div>`;
}

const timeOf = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** An instant as the game day it fell in (17:00 UTC rollover), ISO year first. */
const gameDayOf = (iso) => formatGameDayShort(gameDayKeyFor(Date.parse(iso)));

const glyph = (g, cls) => `<span class="tl-glyph ${cls}" aria-hidden="true">${g}</span>`;

function entryHtml(e) {
  const who = `<strong>${memberLink(e.memberId, e.name)}</strong>`
    + (e.asName ? ` <span class="rc-as">${esc(t('as {name}', { name: e.asName }))}</span>` : '');
  let icon;
  let text;
  let note = '';
  let title = '';
  if (e.kind === 'joined') {
    icon = glyph('↪', 'is-good');
    text = t('{name} joined the clan', { name: who });
  } else if (e.kind === 'returned') {
    icon = glyph('↻', 'is-gold');
    text = t('{name} came back to the clan', { name: who });
    note = e.prevLeftAt ? t('left {date}', { date: gameDayOf(e.prevLeftAt) })
      : e.seenSince ? t('in the clan before: first seen {date}', { date: gameDayOf(e.seenSince) }) : '';
  } else if (e.kind === 'restored') {
    icon = glyph('↻', '');
    text = t('{name} was restored on the site', { name: who });
  } else if (e.source === 'site') {
    icon = glyph('↩', 'is-bad');
    text = t('{name} marked as left', { name: who });
    title = t("The site's record, not the game's: the day it marked them gone, which can be later than the day they left.");
  } else {
    icon = glyph('↩', 'is-bad');
    text = t('{name} left the clan', { name: who });
  }
  const portrait = e.avatarUrl
    ? `<span class="rc-avatar">${heroAvatarHtml(e, 24)}</span>`
    : '<span class="rc-avatar is-empty" aria-hidden="true"></span>';
  const time = `<time class="tl-time" datetime="${esc(e.at)}" title="${esc(formatDate(e.at))}">${timeOf(e.at)}</time>`;
  return `<li class="tl-entry rc-entry is-${esc(e.kind)}${e.source === 'site' ? ' is-site' : ''}"${title ? ` title="${esc(title)}"` : ''}>`
    + `${time}<span class="tl-icon">${icon}</span>${portrait}`
    + `<div class="tl-body">${text}${note ? ` <span class="rc-note">· ${esc(note)}</span>` : ''}</div></li>`;
}

/** Day separators between game days; `lastDay` continues a previous page. */
function listHtml(entries, lastDay) {
  let html = '';
  let day = lastDay;
  for (const e of entries) {
    if (e.day !== day) {
      day = e.day;
      html += `<li class="tl-day" role="separator"><span>${esc(formatGameDayShort(day))}</span></li>`;
    }
    html += entryHtml(e);
  }
  return { html, lastDay: day };
}

function countsText(c) {
  if (!c) return '';
  // "12 joins (3 returns) · 7 leaves in the last 30 days": returns are among the joins.
  const joined = tn(c.joined, '{n} join', '{n} joins');
  const left = tn(c.left, '{n} leave', '{n} leaves');
  return c.returned
    ? t('{joined} ({returned}) · {left} in the last {days} days', { joined, returned: tn(c.returned, '{n} return', '{n} returns'), left, days: c.days })
    : t('{joined} · {left} in the last {days} days', { joined, left, days: c.days });
}

function sourceNote(readSince) {
  return readSince
    ? t("Join times are the game's own, read since {date}: anyone who left before then shows only when they left. “Marked as left” is the site's own record from before the game was read: the day it noticed, which can be later than the day they left.", { date: gameDayOf(readSince) })
    : t("The clan's roster hasn't been read from the game yet. The next scan reads it.");
}

/** Fill the Joins & leaves panel (fetched the first time the tab opens). */
export async function mountRoster(root) {
  const el = root.querySelector('[data-clan-roster]');
  if (!el || el.dataset.mounted) return;
  el.dataset.mounted = '1';
  const state = { filter: '', q: '', next: null, lastDay: null, seq: 0, moreLoading: false, loaded: false };

  el.innerHTML = `<div class="card" data-rc-card>
      <div class="card-header"><h2>${esc(t('Joins & leaves'))}</h2><span class="card-header-hint rc-count"></span></div>
      <div class="rc-tools">
        <div class="tl-chips" role="group" aria-label="${esc(t('Show'))}">
          ${FILTERS.map((f) => `<button type="button" class="btn btn-sm tl-chip${f.key === '' ? ' active' : ''}" data-rc-filter="${f.key}" aria-pressed="${f.key === '' ? 'true' : 'false'}">${esc(f.label())}</button>`).join('')}
        </div>
        <input type="search" class="input rc-search" placeholder="${esc(t('Find a player…'))}" aria-label="${esc(t('Find a player'))}" autocomplete="off" enterkeyhint="search" data-rc-search>
      </div>
      <ol class="tl-list rc-list" aria-live="polite"></ol>
      <div class="tl-foot"></div>
      <p class="rc-source"></p>
    </div>`;
  // Listeners go on the card, which a remount replaces (never on `el`, which stays).
  const card = el.querySelector('[data-rc-card]');
  const list = card.querySelector('.rc-list');
  const foot = card.querySelector('.tl-foot');
  const count = card.querySelector('.rc-count');
  const source = card.querySelector('.rc-source');
  const moreButton = () => `<button type="button" class="btn btn-sm" data-rc-more>${esc(t('Load older'))}</button>`;

  const load = async (more) => {
    if (more && state.moreLoading) return;
    // A newer request (a chip, the next keystroke) wins over one in flight,
    // a "Load older" among them.
    const seq = more ? state.seq : ++state.seq;
    state.moreLoading = more;
    if (more) foot.querySelector('[data-rc-more]')?.setAttribute('disabled', '');
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (state.filter) q.set('filter', state.filter);
    if (state.q) q.set('q', state.q);
    if (more && state.next) q.set('before', state.next);
    let res;
    try {
      res = await api(`/game/clan/roster-changes?${q}`);
    } catch (err) {
      if (seq !== state.seq) return;
      state.moreLoading = false;
      if (err?.name === 'AbortError') {
        // The router moved on mid-request (another tab or page). Nothing
        // shown yet: load afresh the next time the tab opens.
        if (!state.loaded) el.dataset.mounted = '';
        else foot.innerHTML = state.next ? moreButton() : '';
        return;
      }
      foot.innerHTML = `<p class="muted-copy">${esc(t("Couldn't load the joins and leaves. Try again in a minute."))}</p>`;
      return;
    }
    if (seq !== state.seq) return;
    state.moreLoading = false;
    state.loaded = true;
    const entries = Array.isArray(res?.entries) ? res.entries : [];
    if (!more) {
      list.innerHTML = '';
      state.lastDay = null;
      count.textContent = countsText(res?.counts);
      source.textContent = sourceNote(res?.readSince ?? null);
    }
    const { html, lastDay } = listHtml(entries, state.lastDay);
    list.insertAdjacentHTML('beforeend', html);
    state.lastDay = lastDay;
    state.next = res?.next ?? null;
    const empty = !more && !entries.length;
    foot.innerHTML = state.next
      ? moreButton()
      : empty
        ? `<p class="muted-copy">${esc(state.filter || state.q ? t('No one matches.') : t('No joins or leaves recorded yet.'))}</p>`
        : '';
  };

  card.addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-rc-filter]');
    if (chip) {
      state.filter = chip.dataset.rcFilter;
      card.querySelectorAll('[data-rc-filter]').forEach((b) => {
        const on = b === chip;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      load(false);
      return;
    }
    if (ev.target.closest('[data-rc-more]')) load(true);
  });
  let timer = null;
  card.querySelector('[data-rc-search]').addEventListener('input', (ev) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = ev.target.value.trim();
      if (q === state.q) return;
      state.q = q;
      load(false);
    }, SEARCH_DELAY_MS);
  });
  await load(false);
}
