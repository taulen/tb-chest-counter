// Chats: the clan chat as stored by the site — its full history, searchable.
//
// What the game's chat service still serves is only recent history; the site
// keeps every line it ever read (chat-repo.ts), so this page shows lines the
// game itself no longer does. Laid out like the game's Clan chat: a time
// gutter, then a card per message headed "<rank> <name>". Shared map
// locations, raids, joins and reports arrive as placeholders plus a payload
// (chat-text.ts) and render as chips.
//
// Two views, both paged — the page never loads the whole history:
//   - the conversation: the newest end (live, polled), or opened AT a search
//     hit or a date (`/context`: ~50 messages either side), with older/newer
//     pages loaded as you scroll. At most MAX_ITEMS stay loaded; the far end
//     is dropped (and can be loaded again) as you go.
//   - search results: a search / writer filter runs over the WHOLE stored
//     history on the server, says how many messages match, and lists them 100
//     at a time; each hit opens the conversation at that message, with a way
//     back to the results.
//
// Only the clan chat is shown; CHANNELS is the list the left column renders,
// so the clan's group chats can be added later without reshaping the page.

import { api, apiPost } from '../lib/api.js';
import { esc, memberLink, localDateKey, copyTextToClipboard, prefersReducedMotion } from '../lib/ui.js';
import { t, tn, tGame, getLanguage } from '../lib/i18n.js';
import { gameRankName, heroAvatarHtml } from '../lib/game-facts.js';
import { emptyHtml, errorStateHtml, refusalText, wireRetry } from '../lib/ui-kit.js';

const CHANNELS = [{ key: 'clan', label: () => t('Clan chat'), endpoint: '/chat/clan' }];
const PAGE = 100;
const MAX_ITEMS = 2000;
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
    /** 'chat' (the conversation) or 'results' (search / writer filter). */
    mode: 'chat',
    // The conversation, oldest first.
    items: [],
    hasOlder: false,
    hasNewer: false,
    focusKey: null,
    /** The conversation was opened from the results (offer the way back). */
    fromResults: false,
    // Search results, newest first.
    results: null,
    people: {},
    objects: {},
    terrains: {},
    loading: false,
    history: null,
    available: true,
    senders: null,
    newBelow: 0,
    /** Translations asked for, by message key: { status, shown, from, text, same }. */
    tr: new Map(),
  };
}

const filtering = () => !!(state.q || state.sender);

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

/** A terrain type's name ("Dense forest") for a shared map tile — the game's words. */
function terrainName(id) {
  const n = typeof id === 'number' ? state.terrains[id] : null;
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
      // As the game writes a shared location (client_config.value.poi.copy_coords.*):
      // a player's portal (map object 4) "Player's portal NAME", any other player
      // object "Player's City NAME", a clan object "Clan Capital CLAN", a map tile
      // its terrain ("Dense forest"), anything else its own name.
      let label;
      if (sub.entryType === 'tile') label = name || terrainName(sub.staticId) || t('Location');
      else if (sub.entryType === 'user') label = [sub.staticId === 4 ? tGame("Player's portal") : tGame("Player's City"), name].filter(Boolean).join(' ');
      else if (sub.entryType === 'clan') label = [objectName(sub.staticId), name].filter(Boolean).join(' ');
      else label = name || objectName(sub.staticId);
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

/** One message. A search hit (`hit`) carries the button that opens it in the conversation. */
function messageHtml(m, { hit = false } = {}) {
  const time = `<time class="chat-time" datetime="${new Date(m.at).toISOString()}" title="${esc(fullTimeOf(m.at))}">${timeOf(m.at)}</time>`;
  const focus = m.key === state.focusKey && !hit ? ' is-focus' : '';
  const open = hit
    ? `<button type="button" class="btn btn-sm chat-open" data-chat-action="open" data-key="${esc(m.key)}">${esc(t('Show in chat'))}</button>` : '';
  if (m.kind === 'service') {
    return `<li class="chat-msg is-service${hit ? ' is-hit' : ''}${focus}" data-key="${esc(m.key)}">${time}<div class="chat-card">${bodyHtml(m)}${open ? `<div class="chat-hit-actions">${open}</div>` : ''}</div></li>`;
  }
  const who = m.sender.playerId ? state.people[m.sender.playerId] : null;
  const role = m.sender.rank ?? who?.role ?? null;
  const rank = role ? gameRankName(role) : '';
  // The portrait as the game draws it: in the player's frame, hero level on its plate.
  const avatar = who?.avatarUrl
    ? `<span class="chat-avatar">${heroAvatarHtml(who, 30)}</span>`
    : '<span class="chat-avatar is-empty" aria-hidden="true"></span>';
  const nameHtml = who?.memberId ? memberLink(who.memberId, m.sender.name) : esc(m.sender.name || t('Unknown player'));
  const nameMarked = terms().length && !who?.memberId ? marked(m.sender.name || '') : nameHtml;
  const edited = m.edited
    ? ` <span class="chat-edited" title="${esc(t('Earlier text: {text}', { text: m.previousText ?? '' }))}">${esc(t('(edited)'))}</span>` : '';
  return `<li class="chat-msg role-${role ?? 0}${hit ? ' is-hit' : ''}${focus}" data-key="${esc(m.key)}">${time}<div class="chat-card">
    <div class="chat-head">${avatar}${rank ? `<span class="chat-rank">${esc(rank)}</span>` : ''}<span class="chat-name">${nameMarked}</span>${edited}${translateButtonHtml(m)}${open}</div>
    <div class="chat-text">${bodyHtml(m)}</div>${translationHtml(m)}
  </div></li>`;
}

// ── Translation: on request, one message at a time ─────────────────────────

/** A language's name in the viewer's language ("Russian", "russe"), else its code. */
function languageName(code) {
  try {
    return new Intl.DisplayNames([getLanguage()], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

const translatable = (m) => m.kind === 'user' && /\p{L}/u.test(m.text ?? '');

function translateButtonHtml(m) {
  if (!translatable(m)) return '';
  const tr = state.tr.get(m.key);
  const pressed = tr?.shown && tr.status === 'done';
  return `<button type="button" class="chat-translate" data-chat-action="translate" data-key="${esc(m.key)}" aria-pressed="${pressed ? 'true' : 'false'}"${tr?.status === 'loading' ? ' aria-busy="true"' : ''}>${esc(t('Translate'))}</button>`;
}

function translationHtml(m) {
  const tr = state.tr.get(m.key);
  if (!tr?.shown || tr.status === 'loading') return '';
  if (tr.status === 'error') {
    return `<p class="chat-translation is-error" role="status">${esc(t('Translation is not available right now. Try again later.'))}</p>`;
  }
  if (tr.same) {
    return `<p class="chat-translation" role="status">${esc(t('Already in {language}.', { language: languageName(tr.from ?? getLanguage()) }))}</p>`;
  }
  const from = tr.from ? t('Translated from {language}', { language: languageName(tr.from) }) : t('Translated');
  return `<div class="chat-translation" role="status"><span class="chat-tr-from">${esc(from)}</span><div class="chat-text" lang="${esc(getLanguage())}">${bodyHtml({ ...m, text: tr.text })}</div></div>`;
}

function findMessage(key) {
  return state.items.find((m) => m.key === key) ?? state.results?.items?.find((m) => m.key === key) ?? null;
}

/** Redraw one message's button and translation in place (focus stays on the button). */
function refreshTranslation(root, m) {
  for (const node of root.querySelectorAll(`.chat-msg[data-key="${m.key}"]`)) {
    const tr = state.tr.get(m.key);
    const btn = node.querySelector('.chat-translate');
    if (btn) {
      // A toggle keeps its label; aria-pressed (and its look) says whether it is on.
      btn.setAttribute('aria-pressed', tr?.shown && tr.status === 'done' ? 'true' : 'false');
      if (tr?.status === 'loading') btn.setAttribute('aria-busy', 'true');
      else btn.removeAttribute('aria-busy');
    }
    node.querySelector('.chat-translation')?.remove();
    node.querySelector('.chat-card > .chat-text')?.insertAdjacentHTML('afterend', translationHtml(m));
  }
}

/** The Translate button: fetch this one message's translation, or show / hide it. */
async function toggleTranslation(root, key) {
  const s = state;
  const m = findMessage(key);
  if (!m) return;
  const tr = s.tr.get(key);
  if (tr?.status === 'loading') return;
  if (tr?.status === 'done') {
    tr.shown = !tr.shown;
    refreshTranslation(root, m);
    return;
  }
  // First click, or a retry after a failure.
  s.tr.set(key, { status: 'loading', shown: true });
  refreshTranslation(root, m);
  let next;
  try {
    const res = await apiPost(`${s.channel.endpoint}/translate`, { key, lang: getLanguage() });
    next = res && !res.error
      ? { status: 'done', shown: true, from: res.from ?? null, text: res.text ?? '', same: !!res.same }
      : { status: 'error', shown: true };
  } catch {
    next = { status: 'error', shown: true };
  }
  s.tr.set(key, next);
  if (s === state) refreshTranslation(root, m);
}

const dayOf = (m) => localDateKey(new Date(m.at));

/**
 * Messages with a separator wherever the local day changes (either order).
 * `prevDay` is the day of the message the chunk continues from, so an
 * appended page does not repeat the separator of a day already open.
 */
function chunkHtml(items, opts, prevDay = '') {
  let html = '';
  let day = prevDay;
  for (const m of items) {
    const d = dayOf(m);
    if (d !== day) {
      day = d;
      html += `<li class="chat-day" role="separator"><span>${esc(d)}</span></li>`;
    }
    html += messageHtml(m, opts);
  }
  return html;
}

function noMessagesHtml() {
  const empty = filtering()
    ? t('No messages match.')
    : state.available ? t('No clan chat stored yet. It is collected with every scan.') : t('The clan chat has not been read yet. It is collected with every scan.');
  return emptyHtml(empty);
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

/** A conversation request: never filtered (the conversation is the whole chat). */
function chatQuery(extra) {
  const p = new URLSearchParams({ limit: String(PAGE) });
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  return `${state.channel.endpoint}?${p}`;
}

/** A results request: the search and writer filter. */
function resultsQuery(extra) {
  const p = new URLSearchParams({ limit: String(PAGE) });
  if (state.q) p.set('q', state.q);
  if (state.sender) p.set('sender', state.sender);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  return `${state.channel.endpoint}?${p}`;
}

function absorb(res) {
  // api() hands back whatever JSON the server sent: a refusal (a 429, a 500's
  // { error, ref }) is an error to show, not an empty chat.
  const refusal = refusalText(res);
  if (refusal || !res || typeof res !== 'object') {
    throw Object.assign(new Error(refusal || 'No answer'), { refusal: !!refusal });
  }
  Object.assign(state.people, res.people ?? {});
  Object.assign(state.objects, res.objects ?? {});
  Object.assign(state.terrains, res.terrains ?? {});
  state.history = res.history ?? state.history;
  state.available = res.available !== false;
}

/** Start of a local calendar day, for "open the chat on this date". */
function startOfDay(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** One request at a time; a newer view request wins over an older one still running. */
let generation = 0;
async function guarded(fn) {
  const mine = ++generation;
  // Whatever scroll gesture led here is used up: the scrolls this request
  // causes itself (restoring the view, opening at a message) never page.
  wantsMore = false;
  state.loading = true;
  try {
    return await fn(() => mine === generation);
  } finally {
    if (mine === generation) state.loading = false;
  }
}

/** The newest end of the conversation (live). */
async function openLive(root) {
  await guarded(async (current) => {
    const res = await api(chatQuery({}));
    if (!current()) return;
    absorb(res);
    Object.assign(state, {
      mode: 'chat', items: (res.messages ?? []).slice().reverse(), hasOlder: !!res.hasMore, hasNewer: false,
      focusKey: null, newBelow: 0,
    });
    paint(root, { toBottom: true });
  });
}

/** The conversation at a message (`around`) or at a time (`at`). */
async function openContext(root, params, { fromResults = false } = {}) {
  if (fromResults && state.mode === 'results' && state.results) {
    state.results.scrollTop = root.querySelector('.chat-log').scrollTop;
  }
  await guarded(async (current) => {
    const p = new URLSearchParams(params);
    const res = await api(`${state.channel.endpoint}/context?${p}`);
    if (!current()) return;
    absorb(res);
    Object.assign(state, {
      mode: 'chat', items: res.messages ?? [], hasOlder: !!res.hasOlder, hasNewer: !!res.hasNewer,
      focusKey: res.focus ?? null, newBelow: 0, fromResults: fromResults || (state.fromResults && filtering()),
    });
    paint(root);
    revealFocus(root);
  });
}

/** Scroll the focused message into the middle of the log and flash it. */
function revealFocus(root) {
  const log = root.querySelector('.chat-log');
  const el = state.focusKey ? log.querySelector(`.chat-msg[data-key="${CSS.escape(state.focusKey)}"]`) : null;
  if (!el) { log.scrollTop = log.scrollHeight; return; }
  log.scrollTop = el.offsetTop - log.clientHeight / 2 + el.offsetHeight / 2;
  el.classList.add(prefersReducedMotion() ? 'is-focus-still' : 'is-focus-flash');
  el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

/** Search results over the whole stored history (first page). */
async function openResults(root) {
  await guarded(async (current) => {
    const res = await api(resultsQuery({}));
    if (!current()) return;
    absorb(res);
    state.results = {
      items: res.messages ?? [],
      hasMore: !!res.hasMore,
      total: res.matches?.total ?? (res.messages ?? []).length,
      oldestAt: res.matches?.oldestAt ?? null,
      scrollTop: 0,
    };
    state.mode = 'results';
    state.focusKey = null;
    paint(root, { toTop: true });
    announce(root, resultsSummary());
  });
}

async function moreResults(root) {
  const r = state.results;
  if (state.loading || state.mode !== 'results' || !r?.hasMore || !r.items.length) return;
  await guarded(async (current) => {
    const res = await api(resultsQuery({ before: r.items[r.items.length - 1].key }));
    if (!current()) return;
    absorb(res);
    const more = res.messages ?? [];
    const prevDay = dayOf(r.items[r.items.length - 1]);
    r.items = r.items.concat(more);
    r.hasMore = !!res.hasMore;
    // Appended below: nothing on screen moves.
    listEl(root)?.insertAdjacentHTML('beforeend', chunkHtml(more, { hit: true }, prevDay));
    paintEdges(root);
    paintChrome(root);
  });
}

/**
 * Change the list without moving what is on screen: the first visible message
 * stays where it was, whatever was added above or dropped at either end.
 */
function keepingView(root, change) {
  const log = root.querySelector('.chat-log');
  const anchor = [...log.querySelectorAll('.chat-msg')].find((el) => el.offsetTop + el.offsetHeight > log.scrollTop);
  const key = anchor?.dataset.key;
  const offset = anchor ? anchor.offsetTop - log.scrollTop : 0;
  change();
  const again = key ? log.querySelector(`.chat-msg[data-key="${CSS.escape(key)}"]`) : null;
  if (again) log.scrollTop = again.offsetTop - offset;
}

const listEl = (root) => root.querySelector('.chat-log .chat-list');

/** Remove the nodes of dropped messages, then any day separator left heading nothing. */
function dropNodes(root, dropped) {
  const list = listEl(root);
  if (!list || !dropped.length) return;
  for (const m of dropped) list.querySelector(`.chat-msg[data-key="${CSS.escape(m.key)}"]`)?.remove();
  for (const sep of [...list.querySelectorAll('.chat-day')]) {
    const next = sep.nextElementSibling;
    if (!next || next.classList.contains('chat-day')) sep.remove();
  }
}

async function loadOlder(root) {
  if (state.loading || state.mode !== 'chat' || !state.hasOlder || !state.items.length) return;
  await guarded(async (current) => {
    const res = await api(chatQuery({ before: state.items[0].key }));
    if (!current()) return;
    absorb(res);
    const older = (res.messages ?? []).slice().reverse();
    keepingView(root, () => {
      const list = listEl(root);
      const firstDay = dayOf(state.items[0]);
      const headSep = list?.querySelector('.chat-day');
      state.items = older.concat(state.items);
      state.hasOlder = !!res.hasMore;
      if (list && older.length) {
        list.insertAdjacentHTML('afterbegin', chunkHtml(older));
        // The day that was at the top continues from the new page: one separator.
        if (dayOf(older[older.length - 1]) === firstDay) headSep?.remove();
      }
      // Bounded: drop the far (newest) end; it loads again when scrolled to.
      if (state.items.length > MAX_ITEMS) {
        dropNodes(root, state.items.slice(MAX_ITEMS));
        state.items = state.items.slice(0, MAX_ITEMS);
        state.hasNewer = true;
      }
      paintEdges(root);
    });
    paintChrome(root);
  });
}

async function loadNewer(root, { live = false } = {}) {
  if (state.loading || state.mode !== 'chat' || !state.items.length) return;
  if (!live && !state.hasNewer) return;
  await guarded(async (current) => {
    const log = root.querySelector('.chat-log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < FOLLOW_PX;
    const res = await api(chatQuery({ after: state.items[state.items.length - 1].key }));
    if (!current()) return;
    absorb(res);
    const newer = res.messages ?? [];
    if (!live) state.hasNewer = !!res.hasMore;
    if (newer.length) {
      keepingView(root, () => {
        const prevDay = dayOf(state.items[state.items.length - 1]);
        state.items = state.items.concat(newer);
        listEl(root)?.insertAdjacentHTML('beforeend', chunkHtml(newer, {}, prevDay));
        // Bounded: drop the far (oldest) end; it loads again when scrolled to.
        if (state.items.length > MAX_ITEMS) {
          dropNodes(root, state.items.slice(0, state.items.length - MAX_ITEMS));
          state.items = state.items.slice(state.items.length - MAX_ITEMS);
          state.hasOlder = true;
        }
        paintEdges(root);
      });
    } else if (!live) {
      paintEdges(root); // the "newer" button goes: this is the newest end
    }
    if (live && newer.length) {
      announce(root, tn(newer.length, '{n} new message', '{n} new messages'));
      if (nearBottom) log.scrollTop = log.scrollHeight;
      else state.newBelow += newer.length;
    }
    paintChrome(root);
  });
}

/** Live: new lines while the page is visible and the conversation sits at its newest end. */
function startPolling(root) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!root.isConnected) { clearInterval(pollTimer); pollTimer = null; return; }
    if (document.visibilityState !== 'visible' || state.mode !== 'chat' || state.hasNewer || state.loading) return;
    loadNewer(root, { live: true }).catch(() => {});
  }, POLL_MS);
}

// ── Painting ───────────────────────────────────────────────────────────────

/** Say it to screen readers (the log is not a live region: a new view replaces it whole). */
function announce(root, text) {
  const el = root.querySelector('#chatLive');
  if (el) el.textContent = text;
}

function resultsSummary() {
  const r = state.results;
  if (!r) return '';
  if (!r.total) return t('No messages match.');
  const since = r.oldestAt ? localDateKey(new Date(r.oldestAt)) : '';
  return tn(r.total, '{n} match since {date}', '{n} matches since {date}', { date: since });
}

/** Everything around the log: status, the results line, back / latest buttons. */
function paintChrome(root) {
  const status = root.querySelector('.chat-status');
  if (status) status.innerHTML = statusHtml();
  const line = root.querySelector('.chat-results');
  if (line) {
    if (state.mode === 'results') {
      const r = state.results;
      line.textContent = r?.total
        ? `${resultsSummary()} · ${t('Showing {shown}', { shown: r.items.length.toLocaleString() })}`
        : '';
    } else if (state.focusKey && !state.fromResults && state.date) {
      line.textContent = t('The chat from {date} on.', { date: state.date });
    } else {
      line.textContent = '';
    }
  }
  const back = root.querySelector('[data-chat-action="back"]');
  if (back) back.hidden = !(state.mode === 'chat' && state.fromResults && filtering() && state.results);
  const jump = root.querySelector('.chat-jump');
  if (jump) {
    const show = state.mode === 'chat' && (state.hasNewer || state.newBelow > 0);
    jump.hidden = !show;
    jump.textContent = state.newBelow > 0 && !state.hasNewer
      ? tn(state.newBelow, '{n} new message ↓', '{n} new messages ↓')
      : t('Jump to the latest ↓');
  }
}

/** The buttons / markers at the two ends of the log. */
function paintEdges(root) {
  const top = root.querySelector('.chat-log .chat-edge.is-top');
  const bottom = root.querySelector('.chat-log .chat-edge.is-bottom');
  if (state.mode === 'results') {
    if (top) top.innerHTML = '';
    if (bottom) {
      bottom.innerHTML = state.results?.hasMore
        ? `<button type="button" class="btn btn-sm" data-chat-action="more-results">${esc(t('Load more results'))}</button>` : '';
    }
    return;
  }
  if (top) {
    top.innerHTML = state.hasOlder
      ? `<button type="button" class="btn btn-sm" data-chat-action="older">${esc(t('Load older messages'))}</button>`
      : state.items.length && state.history?.complete ? `<span class="chat-start">${esc(t('Start of the stored history'))}</span>` : '';
  }
  if (bottom) {
    bottom.innerHTML = state.hasNewer
      ? `<button type="button" class="btn btn-sm" data-chat-action="newer">${esc(t('Load newer messages'))}</button>` : '';
  }
}

/**
 * A whole new view (live end, a conversation opened at a message or date,
 * search results). Paging within a view never comes here: it adds or drops
 * only the nodes of the page concerned (loadOlder / loadNewer / moreResults).
 */
function paint(root, { toBottom = false, toTop = false } = {}) {
  const log = root.querySelector('.chat-log');
  const results = state.mode === 'results';
  const items = results ? state.results.items : state.items;
  log.setAttribute('aria-label', results ? t('Search results') : t('Clan chat messages'));
  log.innerHTML = items.length
    ? `<div class="chat-edge is-top"></div><ol class="chat-list">${chunkHtml(items, { hit: results })}</ol><div class="chat-edge is-bottom"></div>`
    : noMessagesHtml();
  paintEdges(root);
  paintChrome(root);
  if (toBottom) log.scrollTop = log.scrollHeight;
  if (toTop) log.scrollTop = 0;
}

/**
 * Pages load only when a PERSON asks: a click on "Load older / newer / more",
 * or scrolling into an edge by wheel, touch or keyboard — one gesture, at most
 * one page. Never on visibility: the first version paged on an
 * IntersectionObserver, and with prod's 20,000+ lines each page landed with
 * the edge still in range, so the whole history streamed in and repainted
 * without end. Scroll positions the page sets itself (restoring the view
 * after a page, opening at a message) are not gestures and load nothing.
 */
let wantsMore = false;
const EDGE_PX = 80;

function wireEdgePaging(root) {
  const log = root.querySelector('.chat-log');
  const intent = () => { wantsMore = true; };
  log.addEventListener('wheel', intent, { passive: true });
  log.addEventListener('touchmove', intent, { passive: true });
  log.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) intent();
  });
  log.addEventListener('scroll', () => {
    if (!wantsMore || state.loading) return;
    const nearTop = log.scrollTop < EDGE_PX;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < EDGE_PX;
    if (state.mode === 'results') {
      if (nearBottom && state.results?.hasMore) { wantsMore = false; moreResults(root).catch(() => {}); }
      return;
    }
    if (nearTop && state.hasOlder) {
      wantsMore = false;
      loadOlder(root).catch(() => {});
    } else if (nearBottom && state.hasNewer) {
      wantsMore = false;
      loadNewer(root).catch(() => {});
    }
  }, { passive: true });
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
  // One tile on the kit: the channel's name and how much is stored, the
  // search / writer / date toolbar, the conversation. Only the clan chat
  // exists (CHANNELS), so there is no channel list to pick from; private
  // messages are never shown here.
  el.innerHTML = `
    <div class="chat-page">
      <section class="ui-tile span-12 chat-main" aria-labelledby="chatTitle">
        <div class="ui-tile-head chat-top">
          <h2 id="chatTitle" class="ui-tile-title">${esc(state.channel.label())}</h2>
          <p class="ui-sub chat-status"></p>
        </div>
        <form class="ui-toolbar chat-tools" role="search">
          <label class="chat-search">
            <span class="visually-hidden">${esc(t('Search the chat'))}</span>
            <input type="search" class="input" id="chatSearch" placeholder="${esc(t('Search messages and names'))}" autocomplete="off" enterkeyhint="search">
          </label>
          <label class="chat-filter">
            <span class="visually-hidden">${esc(t('Written by'))}</span>
            <select class="input" id="chatSender"><option value="">${esc(t('Everyone'))}</option></select>
          </label>
          <label class="chat-filter chat-date">
            <span class="chat-date-label">${esc(t('Go to'))}</span>
            <input type="date" class="input" id="chatDate" lang="sv" max="${today}">
          </label>
          <button type="button" class="btn btn-sm" data-chat-action="clear" hidden>${esc(t('Clear'))}</button>
        </form>
        <div class="chat-results-row">
          <button type="button" class="chat-back" data-chat-action="back" hidden>${esc(t('← Back to results'))}</button>
          <p class="chat-results" aria-live="polite"></p>
        </div>
        <div class="chat-log" role="region" tabindex="0" aria-label="${esc(t('Clan chat messages'))}"></div>
        <button type="button" class="btn btn-sm btn-primary chat-jump" data-chat-action="latest" hidden></button>
        <p class="ui-sub chat-note">${esc(t('Every message is kept here, even after the game no longer shows it.'))}</p>
        <span class="visually-hidden" aria-live="polite" id="chatLive"></span>
      </section>
    </div>`;

  const root = el.querySelector('.chat-page');
  root.querySelector('.chat-tools').addEventListener('submit', (e) => e.preventDefault());
  const clearBtn = root.querySelector('[data-chat-action="clear"]');
  const searchInput = root.querySelector('#chatSearch');
  const senderSel = root.querySelector('#chatSender');
  const dateInput = root.querySelector('#chatDate');
  const syncClear = () => { clearBtn.hidden = !(state.q || state.sender || state.date); };
  /** A search / writer filter shows its results; none shows the live conversation. */
  const refilter = () => {
    syncClear();
    state.fromResults = false;
    state.results = null;
    return (filtering() ? openResults(root) : openLive(root)).catch((err) => showLoadError(root, err, refilter));
  };

  let searchTimer = null;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      refilter();
    }, 300);
  });
  senderSel.addEventListener('change', (e) => {
    state.sender = e.target.value;
    refilter();
  });
  dateInput.addEventListener('change', (e) => {
    state.date = e.target.value;
    syncClear();
    if (state.date) openContext(root, { at: String(startOfDay(state.date)) }, { fromResults: state.mode === 'results' }).catch(() => {});
    else (filtering() ? openResults(root) : openLive(root)).catch(() => {});
  });

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-chat-action]');
    // A click anywhere on a search hit's card (not on a link or chip) opens it too.
    if (!btn) {
      const hit = e.target.closest('.chat-msg.is-hit');
      if (hit && !e.target.closest('a, button')) await openContext(root, { around: hit.dataset.key }, { fromResults: true });
      return;
    }
    const action = btn.dataset.chatAction;
    if (action === 'older') await loadOlder(root);
    else if (action === 'newer') await loadNewer(root);
    else if (action === 'more-results') await moreResults(root);
    else if (action === 'open') await openContext(root, { around: btn.dataset.key }, { fromResults: true });
    else if (action === 'translate') await toggleTranslation(root, btn.dataset.key);
    else if (action === 'back') {
      state.mode = 'results';
      state.focusKey = null;
      paint(root);
      root.querySelector('.chat-log').scrollTop = state.results?.scrollTop ?? 0;
    } else if (action === 'latest') {
      if (state.hasNewer) {
        state.date = '';
        dateInput.value = '';
        syncClear();
        await openLive(root);
      }
      const log = root.querySelector('.chat-log');
      log.scrollTop = log.scrollHeight;
      state.newBelow = 0;
      paintChrome(root);
    } else if (action === 'clear') {
      state.q = ''; state.sender = ''; state.date = '';
      searchInput.value = '';
      senderSel.value = '';
      dateInput.value = '';
      await refilter();
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
      paintChrome(root);
    }
  }, { passive: true });

  wireEdgePaging(root);
  const loadLive = () => openLive(root).catch((err) => showLoadError(root, err, loadLive));
  await loadLive();
  loadSenders(root).catch(() => {});
  startPolling(root);
}

/**
 * The conversation could not load (a failed read, or a refusal such as a
 * 429): say so in the log, with the server's reason and Try again. A read the
 * router cancelled (another page) shows nothing.
 */
function showLoadError(root, err, again) {
  if (err?.name === 'AbortError' || !root.isConnected) return;
  const log = root.querySelector('.chat-log');
  if (!log) return;
  log.innerHTML = errorStateHtml(t('The chat could not be loaded.'), err?.refusal ? err.message : '');
  wireRetry(log, again);
}
