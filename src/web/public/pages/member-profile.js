// The member profile's layout (redesign, Nov 2026): who they are, this week's
// numbers, and what happened, grouped by game day.
//
//   desktop  identity + pinned numbers + "Everything else" | the feed | today's chests
//   phone    one column; every "Everything else" entry and the chest list open
//            as a sheet that slides up
//
// members.js still builds every older panel (statistics, chest history,
// events, might, research, talents, captains, timeline); here they become
// sheets, so nothing the profile showed before is lost. Game words carry a
// dotted underline and explain themselves in a small popover.

import { api } from '../lib/api.js';
import { esc, formatDate, formatDateShort, holdDialogFocus, sourceLink } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { chestLabelHtml } from '../lib/game-art.js';
import { computeGameWindow, gameDayKeyFor, getCurrentGameDayKey } from '../lib/period.js';
import { formatCompact } from '../lib/ancient-planner.js';
import { gameRankName, heroAvatarHtml } from '../lib/game-facts.js';
import { entryParts } from './member-timeline.js';

/** How many game days the feed tells (older ones: the Timeline sheet). */
const FEED_DAYS = 7;
/** Chest rows read for the feed's "from" lines; per-day counts come from the daily series. */
const FEED_CHEST_LIMIT = 500;
/** Rows of today's chests on a phone before "All …". */
const TODAY_PHONE_ROWS = 6;

// ─── Game words ─────────────────────────────────────────────────────────

/** The game's clan ranks, highest first, in the game's own words. */
const rankList = () => [1, 2, 3, 4, 5].map(gameRankName).join(', ');

/** Short, plain definitions for the game words the profile uses. */
function termText(key) {
  switch (key) {
    case 'might': return t('Might is the game’s measure of a player’s total strength: army, buildings, research and heroes together.');
    case 'gold-pass': return t('The Gold Pass is the game’s paid monthly pass. The game reports who has it.');
    case 'rank': return t('Clan ranks in the game, highest first: {ranks}. The {leader} and {superior} ranks run the clan, and are admins on this site too.', { ranks: rankList(), leader: gameRankName(1), superior: gameRankName(2) });
    case 'guards': return t('The highest Guardsmen troop tier this player has researched: G1 is the first, each tier is stronger.');
    case 'crypt': return t('Crypts are places on the game map that players explore. Each one explored sends a chest to the clan’s Gifts with the player’s name on it.');
    case 'citadel': return t('Citadels are strongholds on the map that clan members attack. A win sends chests to the clan’s Gifts.');
    case 'points': return t('Every chest is worth points, set by the clan for each chest and source. Points count toward the weekly goal.');
    case 'weekly-goal': return t('The number of points the clan asks each member to collect in a game week.');
    case 'game-day': return t('A game day runs from 17:00 UTC to 17:00 UTC the next day, the same as in the game.');
    case 'burning': return t('A burning city has had its walls broken by an attack. It shows on the game map until the walls are repaired.');
    case 'titles': return t('Titles are bonuses the game gives for a while, for example to the strongest players of an event.');
    default: return '';
  }
}

function termTitle(key) {
  switch (key) {
    case 'might': return t('Might');
    case 'gold-pass': return t('Gold Pass');
    case 'rank': return t('Clan rank');
    case 'guards': return t('Guardsmen tier');
    case 'crypt': return t('Crypt');
    case 'citadel': return t('Citadel');
    case 'points': return t('Points');
    case 'weekly-goal': return t('Weekly goal');
    case 'game-day': return t('Game day');
    case 'burning': return t('Burning city');
    case 'titles': return t('Titles');
    default: return '';
  }
}

/** A game word with a dotted underline that explains itself. `label` is already-safe HTML. */
function termHtml(key, label) {
  return `<button type="button" class="mp-term" data-term="${esc(key)}" aria-haspopup="dialog" aria-expanded="false">${label}</button>`;
}

// ─── Identity ───────────────────────────────────────────────────────────

/** Their own photo, else the hero portrait in its frame, else the first letter. */
function avatarHtml(name, game) {
  if (game?.photoUrl) {
    return `<img class="mp-photo" src="${esc(game.photoUrl)}" alt="" width="88" height="88" decoding="async">`;
  }
  const hero = heroAvatarHtml(game?.player, 72);
  if (hero) return hero;
  const letter = (String(name || '?').trim()[0] || '?').toUpperCase();
  return `<span class="mp-initial" aria-hidden="true">${esc(letter)}</span>`;
}

/** The game's facts as one quiet list: rank, joined, levels, VIP, ingots, Gold Pass, the map. */
function identityFactsHtml(player) {
  const p = player;
  if (!p) return '';
  const facts = [];
  const rank = gameRankName(p.role);
  if (rank) facts.push(`<li class="mp-fact is-rank">${termHtml('rank', esc(rank))}</li>`);
  if (p.inClan === false) facts.push(`<li class="mp-fact is-left">${t('Not in the clan')}</li>`);
  if (p.joinedAt) {
    const iso = new Date(p.joinedAt * 1000).toISOString();
    facts.push(`<li class="mp-fact" title="${esc(formatDate(iso))}">${t('In the clan since {date}', { date: esc(formatDateShort(iso)) })}</li>`);
  }
  if (p.heroLevel) facts.push(`<li class="mp-fact">${t('Hero level {n}', { n: p.heroLevel })}</li>`);
  if (p.cityLevel) facts.push(`<li class="mp-fact">${t('City level {n}', { n: p.cityLevel })}</li>`);
  if (p.vip) facts.push(`<li class="mp-fact">${t('VIP {n}', { n: p.vip })}</li>`);
  if (p.goldIngots != null) facts.push(`<li class="mp-fact">${esc(tGame('Gold Ingots'))} ${Number(p.goldIngots).toLocaleString()}</li>`);
  if (p.goldPass) facts.push(`<li class="mp-fact is-gold">${termHtml('gold-pass', `<span aria-hidden="true">✦</span> ${esc(t('Gold Pass'))}`)}</li>`);
  // The map, as plain facts.
  if (p.burning === true) facts.push(`<li class="mp-fact is-burning">${termHtml('burning', `<span aria-hidden="true">🔥</span> ${esc(t('City burning on the map'))}`)}</li>`);
  else if (p.shielded === true) facts.push(`<li class="mp-fact"><span aria-hidden="true">🛡</span> ${t('Shielded')}</li>`);
  return `<ul class="mp-facts" aria-label="${esc(t('What the game reports'))}">${facts.join('')}</ul>`;
}

export function identityHtml({ name, game, titlesHtml }) {
  const p = game?.player;
  const read = p?.capturedAt || p?.lastSeen;
  return `<section class="mp-card mp-identity" aria-label="${esc(t('About {name}', { name }))}">
      <div class="mp-avatar">${avatarHtml(name, game)}</div>
      <h1 class="mp-name">${esc(name)}</h1>
      ${identityFactsHtml(p)}
      ${titlesHtml ? `<div class="mp-titles">${titlesHtml}</div>` : ''}
      ${read ? `<p class="mp-read">${t('Read from the game {when}', { when: esc(formatDate(read)) })}</p>` : ''}
    </section>`;
}

// ─── Pinned numbers ─────────────────────────────────────────────────────

/**
 * This week's points against the goal, chests collected, rank in the clan
 * and might. `week` is the member read for this game week (rank), `progress`
 * the detail's this-week / last-week figures.
 */
export function pinsHtml({ progress, goal, week, player, guardsHtml }) {
  const pts = progress?.thisWeek?.points ?? 0;
  const chests = progress?.thisWeek?.chests ?? 0;
  const lastChests = progress?.lastWeek?.chests ?? 0;
  const pct = goal ? Math.round((pts / goal) * 100) : null;
  const goalLine = goal
    ? (pts >= goal
      ? `<span class="mp-pin-status is-done">✓ ${t('Weekly goal reached')}</span>`
      : `<span class="mp-pin-status">${t('{pct}% of the {goal}', { pct, goal: termHtml('weekly-goal', esc(t('weekly goal'))) })}</span>`)
    : '';
  const bar = goal
    ? `<div class="mp-bar" role="img" aria-label="${esc(t('{points} of {goal} points', { points: pts.toLocaleString(), goal: goal.toLocaleString() }))}"><span style="width:${Math.min(100, pct)}%"></span></div>`
    : '';
  const delta = chests - lastChests;
  const deltaHtml = delta === 0
    ? `<span class="mp-pin-sub">${t('same as last week')}</span>`
    : `<span class="mp-pin-sub ${delta > 0 ? 'is-up' : 'is-down'}">${delta > 0 ? '▲' : '▼'} ${t('{n} vs last week', { n: Math.abs(delta).toLocaleString() })}</span>`;
  const rank = week?.rank;
  const rankHtml = rank != null
    ? `<span class="mp-pin-value">#${rank}</span><span class="mp-pin-sub">${week.totalRanked ? t('of {n} this week', { n: week.totalRanked }) : t('this week')}</span>`
    : `<span class="mp-pin-value">—</span><span class="mp-pin-sub">${t('no chests this week yet')}</span>`;
  const might = player?.might;
  return `<section class="mp-card mp-pins" aria-labelledby="mpPinsH">
      <h2 class="mp-label" id="mpPinsH">${t('This week')}</h2>
      <div class="mp-pin is-wide">
        <span class="mp-pin-label">${termHtml('points', esc(t('Points')))}</span>
        <span class="mp-pin-value">${pts.toLocaleString()}${goal ? `<span class="mp-pin-of"> / ${goal.toLocaleString()}</span>` : ''}</span>
        ${bar}
        ${goalLine}
      </div>
      <div class="mp-pin">
        <span class="mp-pin-label">${t('Chests collected')}</span>
        <span class="mp-pin-value">${chests.toLocaleString()}</span>
        ${deltaHtml}
      </div>
      <div class="mp-pin">
        <span class="mp-pin-label">${t('Rank in the clan')}</span>
        ${rankHtml}
      </div>
      ${might ? `<div class="mp-pin">
        <span class="mp-pin-label">${termHtml('might', esc(t('Might')))}</span>
        <span class="mp-pin-value">${esc(formatCompact(might))}</span>
        ${guardsHtml ? `<span class="mp-pin-sub">${termHtml('guards', esc(t('Guardsmen tier')))} ${guardsHtml}</span>` : ''}
      </div>` : ''}
    </section>`;
}

// ─── Everything else (the sheets) ───────────────────────────────────────

/** The list of sheets: [{ key, label, hint }]. */
export function moreListHtml(sheets) {
  return `<section class="mp-card mp-more" aria-labelledby="mpMoreH">
      <h2 class="mp-label" id="mpMoreH">${t('Everything else')}</h2>
      <ul class="mp-more-list">
        ${sheets.map((s) => `<li><button type="button" class="mp-more-btn" data-sheet-open="${esc(s.key)}" aria-haspopup="dialog">
            <span class="mp-more-text"><span class="mp-more-label">${esc(s.label)}</span>${s.hint ? `<span class="mp-more-hint">${esc(s.hint)}</span>` : ''}</span>
            <span class="mp-more-chev" aria-hidden="true">›</span>
          </button></li>`).join('')}
      </ul>
    </section>`;
}

/** One sheet: hidden until opened; its body is an older panel. */
export function sheetHtml(s) {
  return `<div class="mp-sheet-host" data-sheet="${esc(s.key)}" hidden>
      <div class="mp-sheet-backdrop" data-sheet-close></div>
      <div class="mp-sheet" role="dialog" aria-modal="true" aria-labelledby="mpSheetH-${esc(s.key)}">
        <div class="mp-sheet-head">
          <h2 id="mpSheetH-${esc(s.key)}">${esc(s.label)}</h2>
          <button type="button" class="mp-sheet-close" data-sheet-close aria-label="${esc(t('Close'))}">✕</button>
        </div>
        <div class="mp-sheet-body">${s.html}</div>
      </div>
    </div>`;
}

// ─── Today's chests ─────────────────────────────────────────────────────

function todayRowsHtml(chests, limit) {
  return chests.slice(0, limit).map((c) => `<li class="mp-chest">
      <span class="mp-chest-name">${chestLabelHtml(c.chestName, esc(tGame(c.chestName)))}</span>
      <span class="mp-chest-source">${sourceLink(c.chestSource)}</span>
      <span class="mp-chest-pts">${Number(c.pointValue || 0).toLocaleString()}</span>
    </li>`).join('');
}

function todayHtml(res) {
  const chests = Array.isArray(res?.chests) ? res.chests : [];
  const total = res?.total ?? chests.length;
  const points = chests.reduce((s, c) => s + (Number(c.pointValue) || 0), 0);
  if (!total) {
    return `<h2 class="mp-today-title">${t('Collected today')}</h2>
      <p class="mp-muted">${t('No chests collected yet this game day.')}</p>`;
  }
  const more = total > TODAY_PHONE_ROWS
    ? `<button type="button" class="mp-link mp-today-all" data-sheet-open="history">${tn(total, 'All {n} chest →', 'All {n} chests →')}</button>`
    : '';
  return `<h2 class="mp-today-title">${tn(total, 'Collected today: {n}', 'Collected today: {n}')}</h2>
    <p class="mp-today-sub">${t('{points} {pointsTerm} · the {gameDay} so far', {
      points: points.toLocaleString(),
      pointsTerm: termHtml('points', esc(t('points'))),
      gameDay: termHtml('game-day', esc(t('game day'))),
    })}</p>
    <ul class="mp-chests" aria-label="${esc(t('Collected today'))}">${todayRowsHtml(chests, chests.length)}</ul>
    ${more}`;
}

// ─── The feed ───────────────────────────────────────────────────────────

/** "Today", "Yesterday", else the ISO date. */
function dayHeading(day, today) {
  if (day === today) return t('Today');
  const y = new Date(`${today}T00:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  if (day === y.toISOString().slice(0, 10)) return t('Yesterday');
  return day;
}

/** The plain-words line under an entry about a game word (once per kind in the feed). */
function plainWords(kind) {
  switch (kind) {
    case 'might': return { key: 'might', text: t('Might is the player’s total strength in the game.') };
    case 'gold_pass': return { key: 'gold-pass', text: t('The Gold Pass is the game’s paid monthly pass.') };
    case 'rank': return { key: 'rank', text: t('Clan ranks, highest first: {ranks}.', { ranks: rankList() }) };
    case 'tier': return { key: 'guards', text: t('Troop tiers come from research; a higher tier means stronger troops.') };
    case 'burning': return { key: 'burning', text: t('Walls broken by an attack; the city shows as burning on the map.') };
    case 'titles': return { key: 'titles', text: t('Titles are timed bonuses the game hands out.') };
    default: return null;
  }
}

const timeOf = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const utcTimeOf = (iso) => new Date(iso).toISOString().slice(11, 16);

function storyHtml(e, explained) {
  const [icon, text, items] = entryParts(e);
  const plain = plainWords(e.kind);
  const showPlain = plain && !explained.has(plain.key);
  if (showPlain) explained.add(plain.key);
  // The map's facts carry the time in UTC as well, so a clan across time zones reads one clock.
  const when = (e.kind === 'burning' || e.kind === 'shield')
    ? t('{local} · {utc} UTC', { local: timeOf(e.at), utc: utcTimeOf(e.at) })
    : timeOf(e.at);
  const body = items
    ? `<details class="mp-story-fold"><summary>${text}</summary><ul class="tl-items">${items}</ul></details>`
    : `<p class="mp-story-text">${text}</p>`;
  return `<li class="mp-story is-${esc(e.group || '')}">
      <span class="mp-story-icon">${icon}</span>
      <div class="mp-story-body">
        ${body}
        ${showPlain ? `<p class="mp-story-plain">${termHtml(plain.key, esc(plain.text))}</p>` : ''}
      </div>
      <time class="mp-story-time" datetime="${esc(e.at)}" title="${esc(formatDate(e.at))}">${esc(when)}</time>
    </li>`;
}

/** The day's chests as one story: how many, how many points, mostly from where. */
function chestStoryHtml(name, day, rows, truncated, explained) {
  const sources = new Map();
  for (const c of rows) sources.set(c.chestSource || '', (sources.get(c.chestSource || '') || 0) + 1);
  const top = [...sources.entries()].filter(([s]) => s).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const fromHtml = top.length
    ? `<p class="mp-story-from">${t('Mostly from {sources}', {
      sources: top.map(([s, n]) => `<span class="mp-source">${esc(tGame(s))}${truncated ? '' : ` <span class="mp-source-n">${n}</span>`}</span>`).join(''),
    })}</p>`
    : '';
  const mentionsCrypt = top.some(([s]) => /crypt/i.test(s));
  const mentionsCitadel = top.some(([s]) => /citadel/i.test(s));
  let plain = '';
  if (!explained.has('chests')) {
    explained.add('chests');
    plain = `<p class="mp-story-plain">${t('Each chest arrived in the clan’s Gifts from {name}; its {points} depend on the chest and where it came from.', {
      name: esc(name), points: termHtml('points', esc(t('points'))),
    })}${mentionsCrypt && !explained.has('crypt') ? ` ${termHtml('crypt', esc(t('What is a crypt?')))}` : ''}${mentionsCitadel && !explained.has('citadel') ? ` ${termHtml('citadel', esc(t('What is a citadel?')))}` : ''}</p>`;
    if (mentionsCrypt) explained.add('crypt');
    if (mentionsCitadel) explained.add('citadel');
  }
  return `<li class="mp-story is-chests">
      <span class="mp-story-icon"><span class="tl-glyph is-gold" aria-hidden="true">▣</span></span>
      <div class="mp-story-body">
        <p class="mp-story-text mp-story-big">${tn(day.chests, 'Collected {n} chest', 'Collected {n} chests')} <span class="mp-story-pts">· ${tn(day.points, '{n} point', '{n} points')}</span></p>
        ${fromHtml}
        ${plain}
        <button type="button" class="mp-link" data-sheet-open="history">${t('See the chests →')}</button>
      </div>
    </li>`;
}

/**
 * Build the feed: the last FEED_DAYS game days, newest first. Chest counts per
 * day come from the member's daily series (exact); the "from" line from up to
 * FEED_CHEST_LIMIT chest rows; everything else from the timeline.
 */
async function loadFeed(el, { memberId, name, dailySeries }) {
  const today = getCurrentGameDayKey();
  const fromWin = computeGameWindow('daily', FEED_DAYS - 1);
  const toWin = computeGameWindow('daily', 0);
  const [timeline, chestRes] = await Promise.all([
    api(`/game/members/${memberId}/timeline?limit=120`).catch(() => null),
    fromWin && toWin
      ? api(`/members/${memberId}/chests?limit=${FEED_CHEST_LIMIT}&offset=0&from=${encodeURIComponent(fromWin.from)}&to=${encodeURIComponent(toWin.to)}`).catch(() => null)
      : Promise.resolve(null),
  ]);
  const firstDay = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (FEED_DAYS - 1));
    return d.toISOString().slice(0, 10);
  })();

  const chestRows = Array.isArray(chestRes?.chests) ? chestRes.chests : [];
  const truncated = (chestRes?.total ?? 0) > chestRows.length;
  const rowsByDay = new Map();
  for (const c of chestRows) {
    const day = gameDayKeyFor(new Date(c.effectiveAt).getTime());
    if (!rowsByDay.has(day)) rowsByDay.set(day, []);
    rowsByDay.get(day).push(c);
  }
  const seriesByDay = new Map((dailySeries || []).filter((r) => r.chests > 0).map((r) => [r.day, r]));
  const entries = (Array.isArray(timeline?.entries) ? timeline.entries : []).filter((e) => e.day >= firstDay);
  const entriesByDay = new Map();
  for (const e of entries) {
    if (!entriesByDay.has(e.day)) entriesByDay.set(e.day, []);
    entriesByDay.get(e.day).push(e);
  }
  const days = [...new Set([...seriesByDay.keys(), ...entriesByDay.keys()])]
    .filter((d) => d >= firstDay && d <= today)
    .sort((a, b) => (a < b ? 1 : -1));

  const explained = new Set();
  const dayBlocks = days.map((day) => {
    const series = seriesByDay.get(day);
    const stories = [
      ...(series ? [chestStoryHtml(name, series, rowsByDay.get(day) || [], truncated, explained)] : []),
      ...(entriesByDay.get(day) || []).map((e) => storyHtml(e, explained)),
    ];
    return `<section class="mp-day" aria-labelledby="mpDay-${esc(day)}">
        <h3 class="mp-day-title" id="mpDay-${esc(day)}">${esc(dayHeading(day, today))}${day !== today && dayHeading(day, today) !== day ? ` <span class="mp-day-date">${esc(day)}</span>` : ''}</h3>
        <ol class="mp-stories">${stories.join('')}</ol>
      </section>`;
  });
  el.innerHTML = `
    <h2 class="mp-feed-title">${t('What happened')}</h2>
    ${dayBlocks.length ? dayBlocks.join('') : `<p class="mp-muted">${t('Nothing recorded in the last {n} game days.', { n: FEED_DAYS })}</p>`}
    <button type="button" class="btn mp-feed-older" data-sheet-open="timeline">${t('Everything older: the full timeline')}</button>`;
}

// ─── Mounting ───────────────────────────────────────────────────────────

/** The page around the pieces: columns on desktop, one column on a phone. */
export function profilePageHtml({ backHtml, identity, pins, more, sheets }) {
  return `<div class="mp-page">
      <div class="mp-top">${backHtml}</div>
      <div class="mp-grid">
        <div class="mp-side">${identity}${pins}${more}</div>
        <div class="mp-feed" data-mp-feed aria-live="polite"><h2 class="mp-feed-title">${t('What happened')}</h2><p class="mp-muted">${t('Loading…')}</p></div>
        <aside class="mp-card mp-today" data-mp-today aria-label="${esc(t('Collected today'))}"><p class="mp-muted">${t('Loading…')}</p></aside>
      </div>
      ${sheets.map(sheetHtml).join('')}
    </div>`;
}

let openRelease = null;
let openKey = null;

function closeSheet(root, { restoreFocus = true } = {}) {
  const host = openKey ? root.querySelector(`[data-sheet="${CSS.escape(openKey)}"]`) : null;
  if (host) host.hidden = true;
  document.documentElement.classList.remove('mp-sheet-open');
  const release = openRelease;
  openRelease = null;
  openKey = null;
  // Switching straight to another sheet: the next one takes focus right after.
  if (release && restoreFocus) release();
  else release?.();
}

/**
 * Open a sheet. `onOpen(key)` mounts what needs a live box (charts, trees).
 * Returns false when there is no such sheet.
 */
export function openSheet(root, key, onOpen, { returnTo = null } = {}) {
  const host = root.querySelector(`[data-sheet="${CSS.escape(key)}"]`);
  if (!host) return false;
  if (openKey) closeSheet(root, { restoreFocus: false });
  host.hidden = false;
  document.documentElement.classList.add('mp-sheet-open');
  openKey = key;
  const card = host.querySelector('.mp-sheet');
  openRelease = holdDialogFocus(host, {
    card,
    initial: host.querySelector('.mp-sheet-close'),
    onEscape: () => { closeSheet(root); onOpen?.(null); },
    returnTo,
  });
  onOpen?.(key);
  return true;
}

/**
 * The term popover: one at a time, under its word. Non-modal: a click
 * anywhere else or Escape closes it, and focus goes back to the word. The
 * document listeners are installed once; each render's page wires its words.
 */
const term = { pop: null, owner: null, installed: false };

function closeTerm({ refocus = false } = {}) {
  if (!term.pop) return;
  term.pop.remove();
  term.pop = null;
  term.owner?.setAttribute('aria-expanded', 'false');
  if (refocus && term.owner?.isConnected) term.owner.focus({ preventScroll: true });
  term.owner = null;
}

function installTermListeners() {
  if (term.installed) return;
  term.installed = true;
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && term.pop) {
      ev.preventDefault();
      ev.stopPropagation();
      closeTerm({ refocus: true });
    }
  }, true);
  document.addEventListener('click', (ev) => {
    if (term.pop && !ev.target.closest('.mp-term-pop') && !ev.target.closest('.mp-term')) closeTerm();
  });
  // A page change (the router swaps #content) must not leave a popover, or an
  // open sheet's focus hold (which would keep the new page inert), behind.
  window.addEventListener('hashchange', () => {
    closeTerm();
    const release = openRelease;
    openRelease = null;
    openKey = null;
    document.documentElement.classList.remove('mp-sheet-open');
    release?.();
  });
}

function openTerm(btn) {
  if (term.owner === btn) { closeTerm(); return; }
  closeTerm();
  const key = btn.dataset.term;
  const pop = document.createElement('div');
  pop.className = 'mp-term-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', termTitle(key));
  pop.innerHTML = `<div class="mp-term-head"><h2 class="mp-term-title">${esc(termTitle(key))}</h2>
      <button type="button" class="mp-term-close" aria-label="${esc(t('Close'))}">✕</button></div>
    <p>${esc(termText(key))}</p>`;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 24);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, r.left)) + window.scrollX}px`;
  pop.style.top = `${r.bottom + window.scrollY + 8}px`;
  term.pop = pop;
  term.owner = btn;
  btn.setAttribute('aria-expanded', 'true');
  const x = pop.querySelector('.mp-term-close');
  x.addEventListener('click', () => closeTerm({ refocus: true }));
  x.focus({ preventScroll: true });
}

/**
 * Wire the page: the sheets, the term popovers, then load the feed and
 * today's chests. `reopen` is the sheet that was open before a re-render
 * (a timeframe change or a page flip inside it); `onSheet(key|null)` tells
 * members.js which sheet is open, so it can mount charts and keep it open.
 */
/**
 * The feed and today's chests of the member on screen. A re-render inside a
 * sheet (a page flip, a timeframe) reuses them for a few minutes instead of
 * asking the server again.
 */
const PIECES_REUSE_MS = 3 * 60 * 1000;
const pieces = { memberId: null, at: 0, feed: '', today: '' };

export function mountProfile(root, { memberId, name, dailySeries, reopen, onSheet }) {
  // The previous render's sheet (its DOM is gone): let go of its focus hold.
  const stale = openRelease;
  openRelease = null;
  openKey = null;
  stale?.();
  document.documentElement.classList.remove('mp-sheet-open');
  installTermListeners();
  closeTerm();
  root.addEventListener('click', (ev) => {
    const word = ev.target.closest('.mp-term');
    if (word) {
      ev.preventDefault();
      ev.stopPropagation();
      openTerm(word);
      return;
    }
    const opener = ev.target.closest('[data-sheet-open]');
    if (opener) {
      closeTerm();
      openSheet(root, opener.dataset.sheetOpen, onSheet, { returnTo: opener });
      return;
    }
    if (ev.target.closest('[data-sheet-close]')) {
      closeSheet(root);
      onSheet?.(null);
    }
  });
  if (reopen) openSheet(root, reopen, onSheet);

  const fresh = pieces.memberId === memberId && Date.now() - pieces.at < PIECES_REUSE_MS;
  if (!fresh) Object.assign(pieces, { memberId, at: Date.now(), feed: '', today: '' });
  const feed = root.querySelector('[data-mp-feed]');
  if (feed && fresh && pieces.feed) feed.innerHTML = pieces.feed;
  else if (feed) {
    loadFeed(feed, { memberId, name, dailySeries })
      .then(() => { if (pieces.memberId === memberId) pieces.feed = feed.innerHTML; })
      .catch(() => {
        feed.innerHTML = `<h2 class="mp-feed-title">${t('What happened')}</h2><p class="mp-muted">${t("Couldn't load what happened.")}</p>`;
      });
  }
  const today = root.querySelector('[data-mp-today]');
  const win = computeGameWindow('daily', 0);
  if (today && fresh && pieces.today) today.innerHTML = pieces.today;
  else if (today && win) {
    api(`/members/${memberId}/chests?limit=${FEED_CHEST_LIMIT}&offset=0&from=${encodeURIComponent(win.from)}&to=${encodeURIComponent(win.to)}`)
      .then((res) => {
        today.innerHTML = todayHtml(res);
        if (pieces.memberId === memberId) pieces.today = today.innerHTML;
      })
      .catch(() => { today.innerHTML = `<p class="mp-muted">${t("Couldn't load today's chests.")}</p>`; });
  }
}

/** Is a sheet open right now (members.js keeps it open across re-renders)? */
export function openSheetKey() {
  return openKey;
}
