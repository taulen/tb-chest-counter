// Chats: the clan chat as stored by the site — its full history, searchable.
//
// What the game's chat service still serves is only recent history; the site
// keeps every line it ever read (chat-repo.ts), so this page shows lines the
// game itself no longer does. Laid out like the game's Clan chat: a time
// gutter, then a card per message headed "<rank> <name>". Shared map
// locations, raids, joins and reports arrive as placeholders plus a payload
// (chat-text.ts) and render as chips.
//
// Only the clan chat is shown; CHANNELS is the list the left column renders,
// so the clan's group chats can be added later without reshaping the page.

import { api } from '../lib/api.js';
import { esc, memberLink, localDateKey, copyTextToClipboard } from '../lib/ui.js';
import { t, tn, tGame, getLanguage } from '../lib/i18n.js';
import { gameRankName } from '../lib/game-facts.js';

const CHANNELS = [{ key: 'clan', label: () => t('Clan chat'), endpoint: '/chat/clan' }];
const PAGE = 100;
const POLL_MS = 45_000;
/** Close enough to the bottom to follow new messages as they arrive. */
const FOLLOW_PX = 120;

let state = null;
let pollTimer = null;

function freshState() {
  return {
    channel: CHANNELS[0],
    q: '',
    sender: '',
    date: '',
    items: [], // oldest first
    people: {},
    objects: {},
    hasOlder: false,
    hasNewer: false,
    loading: false,
    history: null,
    available: true,
    senders: null,
    newBelow: 0,
  };
}

// ── Rendering one message ───────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
const timeOf = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fullTimeOf = (ms) => { const d = new Date(ms); return `${localDateKey(d)} ${timeOf(ms)}:${pad(d.getSeconds())}`; };

function terms() {
  return state.q.split(/\s+/).map((w) => w.replace(/["*^():]/g, '').trim()).filter((w) => w.length > 0);
}

/** Escape text, then mark every search term in it. */
function marked(text) {
  const safe = esc(String(text ?? ''));
  const words = terms();
  if (!words.length) return safe;
  const re = new RegExp(`(${words.map((w) => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

/** Plain text → escaped HTML with search marks and safe links. Line breaks are kept by CSS. */
function textHtml(text) {
  let out = '';
  let last = 0;
  for (const m of String(text).matchAll(URL_RE)) {
    let url = m[0];
    // Trailing punctuation belongs to the sentence, not the link.
    const trail = /[).,!?;:]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    out += marked(text.slice(last, m.index));
    out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(url)}</a>`;
    last = m.index + url.length;
  }
  return out + marked(text.slice(last));
}

const PIN_SVG = '<svg class="chat-chip-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
const DOC_SVG = '<svg class="chat-chip-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/></svg>';

function coordsOf(sub) {
  const c = sub.atomCoord && typeof sub.atomCoord === 'object' ? sub.atomCoord : sub;
  return [c.realmId, c.x, c.y].every((v) => typeof v === 'number') ? `K:${c.realmId} X:${c.x} Y:${c.y}` : '';
}

/** A game object's name (Portal, Vault of the Ancients…) — the game's words, official translation where known. */
function objectName(id) {
  const n = typeof id === 'number' ? state.objects[id] : null;
  return n ? tGame(n) : '';
}

function locationChip(label, coords) {
  if (!coords) return `<span class="chat-chip">${PIN_SVG}${marked(label || t('Location'))}</span>`;
  return `<button type="button" class="chat-chip chat-loc" data-chat-action="copy-coords" data-coords="${esc(coords)}"
    title="${esc(t('Copy coordinates'))}">${PIN_SVG}${label ? `${marked(label)} ` : ''}<span class="chat-coords">(${marked(coords)})</span></button>`;
}

const REPORT_LABELS = {
  attack: () => t('Battle report'),
  crypt: () => t('Crypt report'),
  scout: () => t('Scout report'),
  clan_announcement: () => t('Clan announcement'),
  pvpladder: () => t('Ladder battle report'),
};

/** One placeholder's content as HTML. */
function subHtml(sub) {
  const name = typeof sub.name === 'string' ? sub.name : '';
  const strong = (v) => `<strong>${marked(v)}</strong>`;
  switch (sub.type) {
    case 'coord': {
      const obj = objectName(sub.staticId);
      let label;
      if (sub.entryType === 'tile') label = t('Location');
      else if (sub.entryType === 'user') label = [obj, name].filter(Boolean).join(' ');
      else label = name || obj;
      return locationChip(label, coordsOf(sub));
    }
    case 'raid':
      return `<span class="chat-event">${t('{name} started a raid on {target}', { name: strong(name), target: strong(objectName(sub.targetStaticId) || t('a target')) })}</span>`;
    case 'clan': {
      const who = strong(name);
      if (sub.entryType === 'join') return `<span class="chat-event">${t('{name} joined the clan', { name: who })}</span>`;
      if (sub.entryType === 'leave') return `<span class="chat-event">${t('{name} left the clan', { name: who })}</span>`;
      if (sub.entryType === 'kicked') {
        return `<span class="chat-event">${sub.kicker
          ? t('{name} was removed from the clan by {kicker}', { name: who, kicker: strong(sub.kicker) })
          : t('{name} was removed from the clan', { name: who })}</span>`;
      }
      return `<span class="chat-event">${t('{name} left the clan (account closed)', { name: who })}</span>`;
    }
    case 'journal': {
      const label = (REPORT_LABELS[sub.entryType] ?? (() => t('Report')))();
      return `<span class="chat-chip">${DOC_SVG}${esc(label)}${name ? `: ${marked(name)}` : ''}</span>`;
    }
    case 'spawn_sabotage_spawn_to_enemy': {
      const clan = [sub.targetClanInitials ? `[${sub.targetClanInitials}]` : '', sub.targetClanName ?? ''].filter(Boolean).join(' ');
      return `<span class="chat-event">${t('{name} sent {squad} to {clan}', {
        name: strong(sub.spawnerName ?? ''), squad: strong(objectName(sub.staticAtomId) || t('a squad')), clan: strong(clan),
      })}</span> ${locationChip('', coordsOf(sub))}`;
    }
    case 'clan_spawn':
      return `<span class="chat-event">${t('{name} summoned {squad}', { name: strong(name), squad: strong(objectName(sub.staticId) || t('a squad')) })}</span> ${locationChip('', coordsOf(sub))}`;
    default:
      return `<span class="chat-chip is-unknown">${esc(t('Game content'))}</span>`;
  }
}

/** The message body: text with every placeholder replaced by its content. */
function bodyHtml(m) {
  const text = m.text ?? '';
  if (!text.trim() && !Object.keys(m.subs ?? {}).length) {
    return `<span class="chat-empty">${esc(t('No text (a sticker or an attachment)'))}</span>`;
  }
  let out = '';
  let last = 0;
  for (const ph of text.matchAll(/\/%\d+%\//g)) {
    out += textHtml(text.slice(last, ph.index));
    const sub = m.subs?.[ph[0]];
    out += sub ? subHtml(sub) : `<span class="chat-chip is-unknown">${esc(t('Attachment'))}</span>`;
    last = ph.index + ph[0].length;
  }
  return out + textHtml(text.slice(last));
}

function messageHtml(m) {
  const time = `<time class="chat-time" datetime="${new Date(m.at).toISOString()}" title="${esc(fullTimeOf(m.at))}">${timeOf(m.at)}</time>`;
  if (m.kind === 'service') {
    return `<li class="chat-msg is-service" data-key="${esc(m.key)}">${time}<div class="chat-card">${bodyHtml(m)}</div></li>`;
  }
  const who = m.sender.playerId ? state.people[m.sender.playerId] : null;
  const role = m.sender.rank ?? who?.role ?? null;
  const rank = role ? gameRankName(role) : '';
  const avatar = who?.avatarUrl
    ? `<img class="chat-avatar" src="${esc(who.avatarUrl)}" alt="" width="24" height="24" loading="lazy" decoding="async">`
    : '<span class="chat-avatar is-empty" aria-hidden="true"></span>';
  const nameHtml = who?.memberId ? memberLink(who.memberId, m.sender.name) : esc(m.sender.name || t('Unknown player'));
  const nameMarked = terms().length && !who?.memberId ? marked(m.sender.name || '') : nameHtml;
  const lang = getLanguage();
  const translated = m.translations && m.translations[lang] && m.translations[lang] !== m.text
    ? `<p class="chat-translation">${esc(t('Translated ({lang})', { lang }))}: ${textHtml(m.translations[lang])}</p>` : '';
  const edited = m.edited
    ? ` <span class="chat-edited" title="${esc(t('Earlier text: {text}', { text: m.previousText ?? '' }))}">${esc(t('(edited)'))}</span>` : '';
  return `<li class="chat-msg role-${role ?? 0}" data-key="${esc(m.key)}">${time}<div class="chat-card">
    <div class="chat-head">${avatar}${rank ? `<span class="chat-rank">${esc(rank)}</span>` : ''}<span class="chat-name">${nameMarked}</span>${edited}</div>
    <div class="chat-text">${bodyHtml(m)}</div>${translated}
  </div></li>`;
}

function logHtml() {
  if (!state.items.length) {
    const empty = state.q || state.sender
      ? t('No messages match.')
      : state.available ? t('No clan chat stored yet. It is collected with every scan.') : t('The clan chat has not been read yet. It is collected with every scan.');
    return `<p class="chat-none">${esc(empty)}</p>`;
  }
  let html = '';
  let day = '';
  for (const m of state.items) {
    const d = localDateKey(new Date(m.at));
    if (d !== day) {
      day = d;
      html += `<li class="chat-day" role="separator"><span>${esc(d)}</span></li>`;
    }
    html += messageHtml(m);
  }
  return `<ol class="chat-list">${html}</ol>`;
}

function statusHtml() {
  const h = state.history;
  if (!h || !h.total) return '';
  const since = h.oldestAt ? localDateKey(new Date(h.oldestAt)) : '';
  const parts = [tn(h.total, '{n} message stored since {date}', '{n} messages stored since {date}', { date: since })];
  if (!h.complete) parts.push(t('Older messages are still being collected from the game.'));
  return parts.map(esc).join(' · ');
}

// ── Loading ────────────────────────────────────────────────────────────────

function query(extra) {
  const p = new URLSearchParams({ limit: String(PAGE) });
  if (state.q) p.set('q', state.q);
  if (state.sender) p.set('sender', state.sender);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  return `${state.channel.endpoint}?${p}`;
}

function absorb(res) {
  Object.assign(state.people, res.people ?? {});
  Object.assign(state.objects, res.objects ?? {});
  state.history = res.history ?? state.history;
  state.available = res.available !== false;
}

/** End of a local calendar day (exclusive), for "jump to date". */
function endOfDay(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d + 1).getTime();
}

async function loadInitial(root) {
  state.loading = true;
  const to = state.date ? endOfDay(state.date) : null;
  const res = await api(query({ to }));
  absorb(res);
  state.items = (res.messages ?? []).slice().reverse();
  state.hasOlder = !!res.hasMore;
  state.hasNewer = !!to && to < Date.now();
  state.newBelow = 0;
  state.loading = false;
  paint(root, { toBottom: true });
}

async function loadOlder(root) {
  if (state.loading || !state.hasOlder || !state.items.length) return;
  state.loading = true;
  const log = root.querySelector('.chat-log');
  const before = state.items[0].key;
  try {
    const res = await api(query({ before }));
    absorb(res);
    const older = (res.messages ?? []).slice().reverse();
    state.items = older.concat(state.items);
    state.hasOlder = !!res.hasMore;
    const prevHeight = log.scrollHeight;
    const prevTop = log.scrollTop;
    paint(root);
    log.scrollTop = log.scrollHeight - prevHeight + prevTop;
  } finally {
    state.loading = false;
  }
}

async function loadNewer(root, { live = false } = {}) {
  if (state.loading || !state.items.length) return;
  if (!live && !state.hasNewer) return;
  state.loading = true;
  const log = root.querySelector('.chat-log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < FOLLOW_PX;
  try {
    const res = await api(query({ after: state.items[state.items.length - 1].key }));
    absorb(res);
    const newer = res.messages ?? [];
    if (!newer.length) {
      if (!live) state.hasNewer = false;
      paintStatus(root);
      return;
    }
    state.items = state.items.concat(newer);
    if (!live) state.hasNewer = !!res.hasMore;
    const prevTop = log.scrollTop;
    paint(root);
    if (live) announce(root, tn(newer.length, '{n} new message', '{n} new messages'));
    if (live && nearBottom) log.scrollTop = log.scrollHeight;
    else {
      log.scrollTop = prevTop;
      if (live) state.newBelow += newer.length;
      paintJump(root);
    }
  } finally {
    state.loading = false;
  }
}

/** Live: new lines while the page is visible and the view sits at the live end. */
function startPolling(root) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!root.isConnected) { clearInterval(pollTimer); pollTimer = null; return; }
    if (document.visibilityState !== 'visible' || state.hasNewer || state.loading) return;
    loadNewer(root, { live: true }).catch(() => {});
  }, POLL_MS);
}

// ── Painting ───────────────────────────────────────────────────────────────

function paintStatus(root) {
  const el = root.querySelector('.chat-status');
  if (el) el.innerHTML = statusHtml();
}

/** Say it to screen readers (the log itself is repainted whole, so it is not a live region). */
function announce(root, text) {
  const el = root.querySelector('#chatLive');
  if (el) el.textContent = text;
}

function paintJump(root) {
  const btn = root.querySelector('.chat-jump');
  if (!btn) return;
  const show = state.hasNewer || state.newBelow > 0;
  btn.hidden = !show;
  btn.textContent = state.newBelow > 0
    ? tn(state.newBelow, '{n} new message ↓', '{n} new messages ↓')
    : t('Jump to the latest ↓');
}

function paint(root, { toBottom = false } = {}) {
  const log = root.querySelector('.chat-log');
  log.innerHTML = `
    <div class="chat-edge">${state.hasOlder ? `<button type="button" class="btn btn-sm" data-chat-action="older">${esc(t('Load older messages'))}</button>` : state.items.length && state.history?.complete && !state.q && !state.sender ? `<span class="chat-start">${esc(t('Start of the stored history'))}</span>` : ''}</div>
    ${logHtml()}
    <div class="chat-edge">${state.hasNewer ? `<button type="button" class="btn btn-sm" data-chat-action="newer">${esc(t('Load newer messages'))}</button>` : ''}</div>`;
  paintStatus(root);
  paintJump(root);
  const count = root.querySelector('.chat-results');
  if (count) {
    count.textContent = state.q || state.sender
      ? (state.hasOlder ? t('Showing the newest matches; scroll up for more.') : tn(state.items.length, '{n} match', '{n} matches'))
      : '';
  }
  if (toBottom) log.scrollTop = log.scrollHeight;
  observeEdges(root);
}

let observer = null;
function observeEdges(root) {
  if (observer) observer.disconnect();
  if (typeof IntersectionObserver !== 'function') return;
  const log = root.querySelector('.chat-log');
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const action = e.target.dataset.chatAction;
      if (action === 'older') loadOlder(root).catch(() => {});
      if (action === 'newer') loadNewer(root).catch(() => {});
    }
  }, { root: log, rootMargin: '200px 0px' });
  log.querySelectorAll('[data-chat-action="older"], [data-chat-action="newer"]').forEach((b) => observer.observe(b));
}

async function loadSenders(root) {
  if (state.senders) return;
  try {
    const res = await api(`${state.channel.endpoint}/senders`);
    state.senders = res.senders ?? [];
  } catch {
    state.senders = [];
  }
  const sel = root.querySelector('#chatSender');
  if (!sel) return;
  sel.innerHTML = `<option value="">${esc(t('Everyone'))}</option>${state.senders.map((s) => `<option value="${esc(String(s.playerId))}">${esc(s.name)} (${Number(s.messages).toLocaleString()})</option>`).join('')}`;
  sel.value = state.sender;
}

// ── Page ───────────────────────────────────────────────────────────────────

export async function renderChats(el) {
  state = freshState();
  const today = localDateKey();
  el.innerHTML = `
    <div class="chat-page">
      <nav class="chat-channels card" aria-label="${esc(t('Chats'))}">
        <ul>${CHANNELS.map((c) => `<li><button type="button" class="chat-channel${c === state.channel ? ' is-active' : ''}" aria-current="${c === state.channel ? 'true' : 'false'}">${esc(c.label())}</button></li>`).join('')}</ul>
      </nav>
      <section class="chat-main card" aria-labelledby="chatTitle">
        <div class="chat-top">
          <h2 id="chatTitle">${esc(state.channel.label())}</h2>
          <p class="chat-status muted"></p>
        </div>
        <form class="chat-tools" role="search">
          <label class="chat-search">
            <span class="visually-hidden">${esc(t('Search the chat'))}</span>
            <input type="search" class="input" id="chatSearch" placeholder="${esc(t('Search messages and names'))}" autocomplete="off" enterkeyhint="search">
          </label>
          <label class="chat-filter">
            <span class="visually-hidden">${esc(t('Written by'))}</span>
            <select class="input" id="chatSender"><option value="">${esc(t('Everyone'))}</option></select>
          </label>
          <label class="chat-filter chat-date">
            <span class="chat-date-label">${esc(t('Up to'))}</span>
            <input type="date" class="input" id="chatDate" lang="sv" max="${today}">
          </label>
          <button type="button" class="btn btn-sm" data-chat-action="clear" hidden>${esc(t('Clear'))}</button>
        </form>
        <p class="chat-results muted" aria-live="polite"></p>
        <div class="chat-log" role="region" tabindex="0" aria-label="${esc(t('Clan chat messages'))}"></div>
        <button type="button" class="btn btn-sm btn-primary chat-jump" data-chat-action="latest" hidden></button>
        <p class="chat-note muted">${esc(t('Every message is kept here, even after the game no longer shows it.'))}</p>
        <span class="visually-hidden" aria-live="polite" id="chatLive"></span>
      </section>
    </div>`;

  const root = el.querySelector('.chat-page');
  root.querySelector('.chat-tools').addEventListener('submit', (e) => e.preventDefault());
  const clearBtn = root.querySelector('[data-chat-action="clear"]');
  const syncClear = () => { clearBtn.hidden = !(state.q || state.sender || state.date); };

  let searchTimer = null;
  root.querySelector('#chatSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      syncClear();
      loadInitial(root).catch(() => {});
    }, 300);
  });
  const senderSel = root.querySelector('#chatSender');
  senderSel.addEventListener('change', (e) => {
    state.sender = e.target.value;
    syncClear();
    loadInitial(root).catch(() => {});
  });
  root.querySelector('#chatDate').addEventListener('change', (e) => {
    state.date = e.target.value;
    syncClear();
    loadInitial(root).catch(() => {});
  });

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-chat-action]');
    if (!btn) return;
    const action = btn.dataset.chatAction;
    if (action === 'older') await loadOlder(root);
    else if (action === 'newer') await loadNewer(root);
    else if (action === 'latest') {
      if (state.hasNewer) { state.date = ''; root.querySelector('#chatDate').value = ''; syncClear(); await loadInitial(root); }
      const log = root.querySelector('.chat-log');
      log.scrollTop = log.scrollHeight;
      state.newBelow = 0;
      paintJump(root);
    } else if (action === 'clear') {
      state.q = ''; state.sender = ''; state.date = '';
      root.querySelector('#chatSearch').value = '';
      senderSel.value = '';
      root.querySelector('#chatDate').value = '';
      syncClear();
      await loadInitial(root);
    } else if (action === 'copy-coords') {
      await copyTextToClipboard(btn.dataset.coords);
      btn.classList.add('is-copied');
      announce(root, t('Copied {coords}', { coords: btn.dataset.coords }));
      setTimeout(() => btn.classList.remove('is-copied'), 1200);
    }
  });

  const log = root.querySelector('.chat-log');
  log.addEventListener('scroll', () => {
    if (state.newBelow && log.scrollHeight - log.scrollTop - log.clientHeight < FOLLOW_PX) {
      state.newBelow = 0;
      paintJump(root);
    }
  }, { passive: true });

  await loadInitial(root);
  loadSenders(root).catch(() => {});
  startPolling(root);
}
