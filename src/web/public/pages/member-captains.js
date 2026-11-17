// Captains tab on the member profile: every captain the player owns, the way
// the game's Captains screen shows them — portrait in its rarity frame, level
// badge, star level, the active line-up, and what each captain wears — then
// the player's Dragon, the Hall of Fame, and the artifacts the line-up
// captains carry, like the game's artifact book. All read from the member's
// city record (GET /api/game/members/:id/captains).
// Hovering a captain or artifact (desktop) shows its details beside it; a click
// or tap opens them in a dialog.

import { api } from '../lib/api.js';
import { contentModal, esc, formatDate, formatDateShort } from '../lib/ui.js';
import { t, tn, tGame, getLanguage } from '../lib/i18n.js';
import { heroAvatarHtml } from '../lib/game-facts.js';

// City field 9's entry for the hero (gear is stored under this "captain" id).
const HERO_ID = 1;

const FINE_HOVER = '(hover: hover) and (pointer: fine)';
// Hover intent: a pointer crossing the grid on its way elsewhere opens nothing.
const SHOW_DELAY_MS = 200;
const HIDE_DELAY_MS = 100;
const HISTORY_LINES = 8;
// An artifact's star level runs 1–25: five steps fill one of five stars.
const STAR_STEPS = 5;

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
/** XP runs to the hundreds of billions: compact in the viewer's language (430.2B, 430,2 млрд), the full number on hover. */
const fmtCompact = (n) => {
  try {
    return new Intl.NumberFormat(getLanguage() || 'en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n || 0));
  } catch {
    return fmt(n);
  }
};

/**
 * The game's XP bar: an "XP" badge on a gold-trimmed bar filled by the share
 * of this level's XP already earned, and "{n} to the next level" (compact;
 * the exact numbers on hover). Just the XP when the level table is unknown.
 */
function xpBarHtml(c) {
  if (c.xp == null) return '';
  const floor = Number(c.xpFloor);
  const next = Number(c.xpNext);
  if (c.xpFloor == null || c.xpNext == null || !(next > floor)) {
    return `<div class="captain-xp is-plain" title="${esc(fmt(c.xp))}"><span class="captain-xp-badge">${t('XP')}</span><span class="captain-xp-text">${esc(fmtCompact(c.xp))}</span></div>`;
  }
  const xp = Number(c.xp);
  const pct = Math.max(0, Math.min(100, Math.round(((xp - floor) / (next - floor)) * 100)));
  const toNext = Math.max(0, next - xp);
  const label = t('{n} to the next level', { n: fmtCompact(toNext) });
  return `<div class="captain-xp" title="${esc(`${fmt(xp)} / ${fmt(next)}`)}">
      <span class="captain-xp-badge">${t('XP')}</span>
      <span class="captain-xp-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(label)}">
        <span class="captain-xp-fill" style="--xp-fill:${pct}%"></span>
      </span>
      <span class="captain-xp-text">${esc(label)}</span>
    </div>`;
}

/**
 * The game's Stats screen: Leadership, Authority, Dominance (the game's own
 * stat names, so tGame) and Might at this level and star level.
 */
function statsHtml(stats) {
  if (!stats) return '';
  const row = (label, v) => `<div><dt>${esc(label)}</dt><dd>${esc(fmt(v))}</dd></div>`;
  return `<dl class="captain-detail-facts captain-stats">
      ${row(tGame('Leadership'), stats.leadership)}
      ${row(tGame('Authority'), stats.authority)}
      ${row(tGame('Dominance'), stats.dominance)}
      ${row(t('Might'), stats.might)}
    </dl>`;
}

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

/**
 * An artifact's five stars as the game draws them: star level 21 of 25 is four
 * full stars and the fifth one started.
 */
function artifactStarsHtml(star, maxStar) {
  const stars = Math.max(1, Math.round((maxStar || 25) / STAR_STEPS));
  const full = Math.min(stars, Math.floor(star / STAR_STEPS));
  const part = full < stars && star % STAR_STEPS > 0;
  let html = '';
  for (let i = 0; i < stars; i++) {
    const cls = i < full ? ' is-on' : i === full && part ? ' is-part' : '';
    html += `<span class="captain-star${cls}" aria-hidden="true">★</span>`;
  }
  return `<span class="captain-stars artifact-stars" role="img" aria-label="${esc(t('Star level {n} of {max}', { n: star, max: maxStar || 25 }))}">${html}</span>`;
}

function portraitHtml(c, cls = 'captain-portrait') {
  return c.iconUrl
    ? `<img class="${cls}" src="${esc(c.iconUrl)}" alt="" loading="lazy" decoding="async">`
    : `<span class="${cls} is-empty" aria-hidden="true"></span>`;
}

// The game's shared tile art (level plate, star sprites) from the last load.
let tileArt = {};

/**
 * A captain's tile as the game's line-up draws it: the back and frame in the
 * captain's rarity colour (blue rare, violet epic, gold legendary, red
 * mythic — the unit icon's own sprites), the head shot between them, the
 * level on a dark shield plate at the top-right and the stars along the
 * bottom (src/game-art/unit-frames.ts). Null until that art is extracted —
 * then the plain tile below stands in.
 */
function gameTileHtml(c) {
  if (!c.tileBackUrl || !c.tileFrameUrl || !c.iconUrl) return null;
  const plate = tileArt.levelPlateUrl;
  const star = tileArt.starOnUrl;
  const stars = c.stars > 0
    ? `<span class="captain-gt-stars">${(star ? `<img src="${esc(star)}" alt="" decoding="async">` : '<span class="captain-star is-on">★</span>').repeat(c.stars)}</span>`
    : '';
  return `<span class="captain-gt">
      <span class="captain-gt-box" aria-hidden="true">
        <img class="captain-gt-back" src="${esc(c.tileBackUrl)}" alt="" decoding="async">
        <img class="captain-gt-face" src="${esc(c.iconUrl)}" alt="" loading="lazy" decoding="async">
        <img class="captain-gt-frame" src="${esc(c.tileFrameUrl)}" alt="" decoding="async">
        <span class="captain-gt-level${plate ? '' : ' is-plain'}">${plate ? `<img src="${esc(plate)}" alt="" decoding="async">` : ''}<span class="captain-gt-num${c.level >= 100 ? ' is-3' : ''}">${c.level}</span></span>
        ${stars}
      </span>
      <span class="visually-hidden">${esc(t('Level {n}', { n: c.level }))}, ${esc(tn(c.stars, '{n} star', '{n} stars', { n: c.stars }))}</span>
    </span>`;
}

function tileHtml(c, i) {
  const game = gameTileHtml(c);
  return `<button type="button" class="captain-tile rarity-${Number(c.rarity) || 0}" data-tile="captain" data-index="${i}" aria-haspopup="dialog">
      ${game ?? `<span class="captain-frame">
        ${portraitHtml(c)}
        <span class="captain-level">${c.level}</span>
        ${c.stars ? starsHtml(c.stars) : ''}
      </span>`}
      <span class="captain-name">${esc(tGame(c.name))}</span>
    </button>`;
}

/** The hero's name: the game's own for its portrait (T13), else "Hero". */
const heroName = (hero) => (hero?.name ? tGame(hero.name) : t('Hero'));

/** The hero leads the line-up, as in the game: its portrait in the player's frame with the level plate. */
function heroTileHtml(hero) {
  const portrait = heroAvatarHtml(hero, 72);
  return `<button type="button" class="captain-tile is-hero" data-tile="hero" data-index="0" aria-haspopup="dialog">
      <span class="captain-hero-portrait">${portrait || '<span class="captain-portrait is-empty" aria-hidden="true"></span>'}</span>
      <span class="visually-hidden">${esc(t('Level {n}', { n: hero.level ?? '—' }))}</span>
      <span class="captain-name">${esc(heroName(hero))}</span>
    </button>`;
}

/** The hero's details: portrait, level, XP and what it wears (in full in the dialog). */
function heroDetailHtml(hero, { withName = false } = {}) {
  return `<div class="captain-detail is-hero">
      <div class="captain-detail-art is-portrait captain-hero-art">${heroAvatarHtml(hero, 120)}</div>
      <div class="captain-detail-body">
        ${withName ? `<div class="captain-detail-name">${esc(heroName(hero))}</div>` : ''}
        <div class="captain-detail-head">
          ${hero.level != null ? `<span class="captain-detail-level">${t('Level {n}', { n: hero.level })}</span>` : ''}
          <span class="captain-detail-rarity">${esc(t('Hero'))}</span>
        </div>
        ${xpBarHtml(hero)}
        ${withName ? equipmentHtml(hero, { full: false }) : ''}
      </div>
    </div>
    ${withName ? '' : `<div class="captain-gear">${equipmentHtml(hero, { full: true })}</div>`}`;
}

/** Artifact rarity (4 epic, 5 legendary, 6 mythic) → the captain colour scale (2 purple, 3 gold, 4 red). */
const artifactRarityClass = (r) => ({ 4: 2, 5: 3, 6: 4 })[Number(r)] ?? 0;

function artifactTileHtml(a, i) {
  return `<button type="button" class="captain-tile artifact-tile rarity-${artifactRarityClass(a.rarity)}${a.inLineup ? '' : ' is-benched'}" data-tile="artifact" data-index="${i}" aria-haspopup="dialog">
      <span class="artifact-frame">
        ${portraitHtml(a, 'artifact-icon')}
        <span class="captain-level">${a.level}</span>
      </span>
      ${artifactStarsHtml(a.star, a.maxStar)}
      <span class="captain-name">${esc(tGame(a.name))}</span>
    </button>`;
}

function changeText(ch) {
  if (ch.prevLevel === null) return t('New captain');
  const parts = [];
  if (ch.prevLevel !== ch.level) parts.push(t('Level {from} → {to}', { from: ch.prevLevel, to: ch.level }));
  if (ch.prevStars !== ch.stars) parts.push(t('Stars {from} → {to}', { from: ch.prevStars, to: ch.stars }));
  return parts.join(' · ');
}

function artifactChangeText(ch) {
  // Only the three line-up captains' artifacts are visible, so a first
  // sighting is an artifact moved INTO the line-up, never a new one; it
  // leaving shows as OUT of it (history rows from v118 on).
  if (ch.lineup === 'out') return t('Out of the line-up');
  if (ch.lineup === 'in' || ch.prevLevel === null) {
    const moved = ch.prevLevel !== null && (ch.prevLevel !== ch.level || ch.prevStar !== ch.star);
    return moved
      ? [t('Into the line-up'), ...(ch.prevLevel !== ch.level ? [t('Level {from} → {to}', { from: ch.prevLevel, to: ch.level })] : [])].join(' · ')
      : t('Into the line-up');
  }
  const parts = [];
  if (ch.prevLevel !== ch.level) parts.push(t('Level {from} → {to}', { from: ch.prevLevel, to: ch.level }));
  if (ch.prevStar !== ch.star) parts.push(t('Star level {from} → {to}', { from: ch.prevStar, to: ch.star }));
  if (ch.rerolled) parts.push(t('Bonuses rerolled'));
  return parts.join(' · ');
}

/** The short change (the table's metric) for one equipment history row. */
function equipmentChangeText(ch) {
  if (!ch.itemType) return t('Item taken off');
  if (ch.reworked) return t('Gems or enchantment changed');
  return t('Put on');
}

/** Who wears it, and what it replaced — the sub-line under the item's name. */
function equipmentChangeSub(ch, captainName) {
  const parts = [];
  if (captainName) parts.push(tGame(captainName));
  if (ch.itemType && !ch.reworked && ch.prevName) parts.push(t('Replaced {item}', { item: tGame(ch.prevName) }));
  return parts.join(' · ');
}

const linesHtml = (lines) => `<ul class="captain-bonus-list">${lines.map(([text, value]) => `<li><span>${esc(tGame(text))}</span><span class="captain-bonus-value">${esc(value)}</span></li>`).join('')}</ul>`;

/** One worn item: icon in its quality frame, name, grade, and (in full) its bonuses and inserts. */
function gearItemHtml(it, { full }) {
  const inserts = [...(it.enchantment ? [it.enchantment] : []), ...(it.gems || [])];
  return `<li class="gear-item grade-${Number(it.grade) || 0}">
      <span class="gear-icon">${it.iconUrl ? `<img src="${esc(it.iconUrl)}" alt="" loading="lazy" decoding="async">` : ''}</span>
      <span class="gear-body">
        <span class="gear-name">${esc(tGame(it.name))}</span>
        ${it.gradeName ? `<span class="gear-grade">${esc(tGame(it.gradeName))}</span>` : ''}
        ${full && it.lines?.length ? linesHtml(it.lines) : ''}
        ${full && inserts.length ? `<span class="gear-inserts">${inserts.map((g) => `<span class="gear-insert">${g.iconUrl ? `<img src="${esc(g.iconUrl)}" alt="" loading="lazy" decoding="async">` : ''}${esc(tGame(g.name))}</span>`).join('')}</span>` : ''}
      </span>
    </li>`;
}

function equipmentHtml(c, { full }) {
  const items = Array.isArray(c.equipment) ? c.equipment : [];
  if (!items.length) return '';
  return `<div class="captain-detail-section">${t('Equipment')}</div>
    <ul class="gear-list${full ? ' is-full' : ' is-compact'}">${items.map((it) => gearItemHtml(it, { full })).join('')}</ul>`;
}

/** History lines with something to say (a replayed read can repeat the one before). */
const historyLines = (rows, text) => rows
  .map((ch) => ({ ch, text: text(ch) }))
  .filter((r) => r.text)
  .slice(0, HISTORY_LINES)
  .map(({ ch, text: s }) => `<li><span>${esc(s)}</span><span class="muted-copy">${esc(formatDateShort(ch.changedAt))}</span></li>`)
  .join('');

/**
 * The captain's details: art, rarity, level, stars, XP, line-up, star bonuses,
 * history — and what it wears: in the hover card a compact list beside the art,
 * in the dialog every item in full across the dialog's width.
 */
function detailHtml(c, changes, { withName = false } = {}) {
  const art = c.artUrl || c.iconUrl;
  const bonuses = Array.isArray(c.starBonuses) ? c.starBonuses : [];
  const history = historyLines(changes.filter((ch) => ch.captainId === c.captainId), changeText);
  return `<div class="captain-detail rarity-${Number(c.rarity) || 0}">
      <div class="captain-detail-art${c.artUrl ? '' : ' is-portrait'}">${art ? `<img src="${esc(art)}" alt="" decoding="async">` : ''}</div>
      <div class="captain-detail-body">
        ${withName ? `<div class="captain-detail-name">${esc(tGame(c.name))}</div>` : ''}
        <div class="captain-detail-head">
          <span class="captain-detail-level">${t('Level {n}', { n: c.level })}</span>
          ${c.rarityName ? `<span class="captain-detail-rarity">${esc(tGame(c.rarityName))}</span>` : ''}
        </div>
        ${starsHtml(c.stars, c.maxStars)}
        ${xpBarHtml(c)}
        ${statsHtml(c.stats)}
        <dl class="captain-detail-facts">
          ${c.slot ? `<div><dt>${t('Active line-up')}</dt><dd>${t('Slot {n}', { n: c.slot })}</dd></div>` : ''}
          <div><dt>${t('Tracked since')}</dt><dd title="${esc(formatDate(c.firstSeen))}">${esc(formatDateShort(c.firstSeen))}</dd></div>
        </dl>
        ${bonuses.length ? `
          <div class="captain-detail-section">${t('Star level {n}', { n: c.stars })}</div>
          ${linesHtml(bonuses)}` : ''}
        ${withName ? equipmentHtml(c, { full: false }) : ''}
        ${history ? `
          <div class="captain-detail-section">${t('Level history')}</div>
          <ul class="captain-history">${history}</ul>` : ''}
        <p class="captain-detail-note">${t("Skill bonuses aren't read yet.")}</p>
      </div>
    </div>
    ${withName ? '' : `<div class="captain-gear">${equipmentHtml(c, { full: true })}</div>`}`;
}

/** An artifact as the game's artifact book shows it: level line, star line, random bonuses. */
function artifactDetailHtml(a, changes, { withName = false } = {}) {
  const history = historyLines(changes.filter((ch) => ch.artifactType === a.artifactType), artifactChangeText);
  const bonus = (b) => `<li class="artifact-roll quality-${Number(b.quality) || 0}"><span>${esc(tGame(b.text))}</span><span class="captain-bonus-value">${esc(b.value)}</span></li>`;
  return `<div class="captain-detail artifact-detail rarity-${artifactRarityClass(a.rarity)}">
      <div class="captain-detail-art is-portrait artifact-art">${a.iconUrl ? `<img src="${esc(a.iconUrl)}" alt="" decoding="async">` : ''}</div>
      <div class="captain-detail-body">
        ${withName ? `<div class="captain-detail-name">${esc(tGame(a.name))}</div>` : ''}
        <div class="captain-detail-head">
          <span class="captain-detail-level">${t('Level {n}/{max}', { n: a.level, max: a.maxLevel || a.level })}</span>
          ${a.rarityName ? `<span class="captain-detail-rarity">${esc(tGame(a.rarityName))}</span>` : ''}
        </div>
        ${a.levelLines?.length ? linesHtml(a.levelLines) : ''}
        <div class="captain-detail-section">${t('Star level {n}/{max}', { n: a.star, max: a.maxStar || a.star })}</div>
        ${artifactStarsHtml(a.star, a.maxStar)}
        ${a.starLines?.length ? linesHtml(a.starLines) : ''}
        ${a.bonusLines?.length ? `
          <div class="captain-detail-section">${t('Random bonuses')}</div>
          <ul class="captain-bonus-list artifact-rolls">${a.bonusLines.map(bonus).join('')}</ul>` : ''}
        <dl class="captain-detail-facts">
          <div><dt>${t('Tracked since')}</dt><dd title="${esc(formatDate(a.firstSeen))}">${esc(formatDateShort(a.firstSeen))}</dd></div>
          ${a.inLineup ? '' : `<div><dt>${t('Active line-up')}</dt><dd>${t('Not at the last read')}</dd></div>`}
        </dl>
        ${history ? `
          <div class="captain-detail-section">${t('Level history')}</div>
          <ul class="captain-history">${history}</ul>` : ''}
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
  clearTimeout(hideTimer);
  hoverCard?.classList.remove('is-visible');
}

function showHoverCard(tile, html) {
  // The tile may be gone by the time the delay runs: navigating away keeps the
  // old page on screen until the next one has loaded, and a card shown then
  // floated over the Dashboard with nothing left to hide it (Nov 2026).
  if (!tile.isConnected) return;
  if (!hoverCard) {
    hoverCard = document.createElement('div');
    hoverCard.className = 'captain-hovercard';
    hoverCard.setAttribute('aria-hidden', 'true');
    document.body.appendChild(hoverCard);
    window.addEventListener('hashchange', hideHoverCard);
    window.addEventListener('scroll', hideHoverCard, { passive: true, capture: true });
    // Anywhere but a tile: hide (also covers a tile removed under the pointer,
    // which never sends mouseout).
    document.addEventListener('pointermove', (ev) => {
      if (!hoverCard?.classList.contains('is-visible')) return;
      const over = ev.target instanceof Element ? ev.target.closest('[data-tile]') : null;
      if (over && over.isConnected) return;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideHoverCard, HIDE_DELAY_MS);
    }, { passive: true });
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

/**
 * Hover + click for every tile in `el`. `views[kind](index)` returns
 * `{ title, html, hoverHtml, wide }` for a tile, or null.
 */
function wireTiles(el, views) {
  const fine = window.matchMedia(FINE_HOVER);
  const viewOf = (tile) => views[tile.dataset.tile]?.(Number(tile.dataset.index)) ?? null;
  el.addEventListener('click', (ev) => {
    const tile = ev.target.closest('[data-tile]');
    const v = tile && viewOf(tile);
    if (!v) return;
    hideHoverCard();
    contentModal({ title: v.title, html: v.html, wide: !!v.wide, className: 'captain-modal' });
  });
  el.addEventListener('mouseover', (ev) => {
    if (!fine.matches) return;
    const tile = ev.target.closest('[data-tile]');
    if (!tile || tile.contains(ev.relatedTarget)) return;
    const v = viewOf(tile);
    if (!v) return;
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    // Already showing a card: swap straight to this one.
    const delay = hoverCard?.classList.contains('is-visible') ? 0 : SHOW_DELAY_MS;
    showTimer = setTimeout(() => showHoverCard(tile, v.hoverHtml), delay);
  });
  el.addEventListener('mouseout', (ev) => {
    const tile = ev.target.closest('[data-tile]');
    if (!tile || tile.contains(ev.relatedTarget)) return;
    clearTimeout(showTimer);
    hideTimer = setTimeout(hideHoverCard, HIDE_DELAY_MS);
  });
}

/**
 * Bonus lines with the next level's value beside each, as the game's upgrade
 * panel words it ("+41,25% > +42,0%"). `next` lines come in the same order.
 */
function stepLinesHtml(lines, next) {
  const after = new Map((next?.lines || []).map(([text, value]) => [text, value]));
  const rows = lines.length ? lines : (next?.lines || []).map(([text]) => [text, '']);
  if (!rows.length) return '';
  return `<ul class="captain-bonus-list hof-lines">${rows.map(([text, value]) => {
    const up = after.get(text);
    return `<li><span>${esc(tGame(text))}</span><span class="hof-values">${value ? `<span class="captain-bonus-value">${esc(value)}</span>` : ''}${up ? `<span class="hof-next-value">${value ? '&rsaquo; ' : ''}${esc(up)}</span>` : ''}</span></li>`;
  }).join('')}</ul>`;
}

/**
 * A level's bonuses as the game's upgrade panel shows them: the step
 * ("Level 55 → 56"), each bonus now › next, and what the next level takes
 * (the game's own conditions). At the top level, just the bonuses.
 */
function stepHtml(level, lines, next) {
  return `${next ? `<div class="hof-step">${t('Level {from} → {to}', { from: level, to: next.level })}</div>` : ''}
    ${stepLinesHtml(lines, next)}
    ${(next?.requires || []).map((r) => `<div class="hof-requires">${esc(tGame(r))}</div>`).join('')}`;
}

/**
 * The Hall of Fame as the game's screen shows it: each faction's stained-glass
 * window with its level and what that level gives, then the hall's own level.
 * Faction levels are city techs 800–803 (game-protocol/factions.ts).
 */
function hallOfFameCardHtml(hof) {
  if (!hof?.factions?.length) return '';
  const faction = (f) => `
    <div class="hof-faction hof-${esc(f.key)}${f.level > 0 ? '' : ' is-locked'}">
      <div class="hof-window">${f.windowUrl ? `<img src="${esc(f.windowUrl)}" alt="" loading="lazy" decoding="async">` : ''}</div>
      <div class="hof-faction-body">
        <div class="hof-faction-name">${f.crestUrl ? `<img class="hof-crest" src="${esc(f.crestUrl)}" alt="" decoding="async">` : ''}<span>${esc(tGame(f.name))}</span></div>
        <div class="hof-level">${esc(tGame(`Level: ${f.level}`))}</div>
        ${stepHtml(f.level, f.lines, f.next)}
      </div>
    </div>`;
  return `<div class="card hof-card">
      <div class="card-header"><h2>${esc(tGame('Hall of Fame'))}</h2>
        <span class="card-header-hint">${esc(tGame(`Level: ${hof.level}`))}</span>
      </div>
      <div class="card-body card-body-padded">
        <div class="hof-factions">${hof.factions.map(faction).join('')}</div>
        <div class="hof-hall">
          <div class="hof-hall-title">${esc(tGame('Hall of Fame bonuses'))}</div>
          ${stepHtml(hof.level, hof.lines, hof.next)}
        </div>
      </div>
    </div>`;
}

/** The evolution as the game's Progress tab counts it: one pip per stage, filled up to the dragon's. */
function evolutionPipsHtml(stage, max) {
  let pips = '';
  for (let i = 1; i <= max; i++) pips += `<span class="dragon-pip${i <= stage ? ' is-on' : ''}" aria-hidden="true"></span>`;
  return `<span class="dragon-pips" role="img" aria-label="${esc(t('Evolution {n} of {max}', { n: stage, max }))}">${pips}</span>`;
}

/**
 * The Dragon as the game's Dragon window shows it (city field 26 on the
 * Dragons table, game-protocol/dragon.ts): its picture on the window's
 * background, the name the player gave it, "Level 237/250" (its evolution's
 * cap), the evolution, the XP to the next level — or, at the cap, the game's
 * own note that it must evolve first — and what its level and evolution give,
 * with the next one's value where it changes ("+10% › +11%").
 */
function dragonCardHtml(d) {
  if (!d) return '';
  const title = tGame(d.title || 'Dragon');
  const progress = d.atCap
    ? `<p class="dragon-note">${esc(tGame("Raise your Dragon's evolution to unlock access to new levels."))}</p>`
    : d.xpNext == null
      ? `<p class="dragon-note">${esc(tGame('Reached the maximum level of the Dragon.'))}</p>`
      : xpBarHtml(d);
  const picture = d.artUrl || d.iconUrl;
  const levelGroup = `<div class="dragon-bonus-group">
      <div class="hof-step">${d.nextLevel ? esc(t('Level {from} → {to}', { from: d.level, to: d.nextLevel.level })) : esc(tGame(`Level: ${d.level}`))}</div>
      ${stepLinesHtml(d.levelLines || [], d.nextLevel)}
    </div>`;
  const stageGroup = d.stage ? `<div class="dragon-bonus-group">
      <div class="hof-step">${d.nextStage ? esc(t('Evolution {from} → {to}', { from: d.stage, to: d.nextStage.stage })) : esc(t('Evolution {n} of {max}', { n: d.stage, max: d.maxStage }))}</div>
      ${stepLinesHtml(d.stageLines || [], d.nextStage)}
      ${d.nextStage ? '' : `<div class="hof-requires">${esc(tGame('Reached the maximum evolution of the Dragon.'))}</div>`}
    </div>` : '';
  return `<div class="card dragon-card">
      <div class="card-header"><h2>${esc(title)}</h2></div>
      <div class="card-body card-body-padded">
        <div class="dragon-main">
          <div class="dragon-art${d.artUrl ? '' : ' is-icon'}"${d.backUrl ? ` style="--dragon-back: url('${esc(d.backUrl)}')"` : ''}>
            ${picture ? `<img src="${esc(picture)}" alt="" loading="lazy" decoding="async">` : ''}
          </div>
          <div class="dragon-body">
            ${d.name ? `<div class="dragon-name">${esc(d.name)}</div>` : ''}
            <div class="captain-detail-head">
              <span class="captain-detail-level">${esc(t('Level {n}', { n: d.level }))}${d.levelCap ? `<span class="dragon-cap">/${esc(String(d.levelCap))}</span>` : ''}</span>
              <span class="dragon-kind">${esc(title)}</span>
            </div>
            ${d.stage ? `<div class="dragon-evolution"><span class="dragon-evolution-label">${esc(tGame('Evolution'))}</span>${evolutionPipsHtml(d.stage, d.maxStage)}<span class="dragon-evolution-num">${d.stage}/${d.maxStage}</span></div>` : ''}
            ${progress}
          </div>
        </div>
        ${d.levelLines?.length || d.nextLevel?.lines?.length || d.stageLines?.length ? `<div class="dragon-bonuses">${levelGroup}${stageGroup}</div>` : ''}
      </div>
    </div>`;
}

function artifactsCardHtml(artifacts) {
  return `<div class="card">
      <div class="card-header"><h2>${t('Artifacts')}</h2>
        <span class="card-header-hint">${tn(artifacts.length, '{n} artifact', '{n} artifacts', { n: artifacts.length })}</span>
      </div>
      <div class="card-body card-body-padded">
        <p class="captain-section-note">${t('Only the artifacts the three line-up captains wear show in the game data.')}</p>
        ${artifacts.length
          ? `<div class="captain-grid artifact-grid">${artifacts.map((a, i) => artifactTileHtml(a, i)).join('')}</div>`
          : `<p class="muted-copy">${t('No artifacts on the line-up captains at the last read.')}</p>`}
      </div>
    </div>`;
}

/** Artifact and equipment changes, newest first, as one list. */
function gearChangeRows(data, captainNames) {
  const rows = [
    ...(data.artifactChanges || []).map((ch) => ({ name: ch.name, iconUrl: ch.iconUrl, text: artifactChangeText(ch), changedAt: ch.changedAt })),
    ...(data.equipmentChanges || []).map((ch) => ({
      name: ch.itemType ? ch.name : (ch.prevName || ''),
      sub: equipmentChangeSub(ch, captainNames.get(ch.captainId)),
      iconUrl: ch.iconUrl,
      text: equipmentChangeText(ch),
      changedAt: ch.changedAt,
    })),
  ];
  return rows.sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt))).slice(0, 40);
}

function changesTableHtml(title, firstColumn, allRows) {
  // A replayed read can repeat the one before it: nothing to list.
  const rows = allRows.filter((r) => r.text);
  if (!rows.length) return '';
  return `<div class="card">
      <div class="card-header"><h2>${title}</h2></div>
      <div class="card-body">
        <table class="table-responsive captain-changes-table">
          <colgroup><col class="col-captain"><col class="col-change"><col class="col-date"></colgroup>
          <thead><tr><th>${firstColumn}</th><th>${t('Change')}</th><th>${t('Date')}</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td data-label="${firstColumn}" data-role="primary"><span class="mrow-name captain-change-name">${r.iconUrl ? `<img class="captain-change-icon" src="${esc(r.iconUrl)}" alt="" loading="lazy" decoding="async">` : ''}${esc(tGame(r.name))}</span>${r.sub ? `<span class="mrow-sub captain-change-sub">${esc(r.sub)}</span>` : ''}</td>
            <td data-label="${t('Change')}" data-role="metric">${esc(r.text)}</td>
            <td data-label="${t('Date')}">${esc(formatDate(r.changedAt))}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
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
  tileArt = data.tileArt || {};
  const changes = data.changes || [];
  const artifacts = data.artifacts || [];
  const artifactChanges = data.artifactChanges || [];
  const hero = data.hero || null;
  const captainNames = new Map(captains.map((c) => [c.captainId, c.name]));
  // The hero's gear is stored under field 9's entry id 1: name it as the hero.
  if (hero) captainNames.set(HERO_ID, heroName(hero));
  // The game's own order: highest level first (the server sorts it so).
  const lineup = captains
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.slot > 0)
    .sort((a, b) => a.c.slot - b.c.slot);
  const recent = changes.slice(0, 40).map((ch) => ({ name: ch.name, iconUrl: ch.iconUrl, text: changeText(ch), changedAt: ch.changedAt }));
  el.innerHTML = `
    <div class="card">
      <div class="card-header"><h2>${t('Captains')}</h2>
        <span class="card-header-hint">${tn(captains.length, '{n} captain', '{n} captains', { n: captains.length })}</span>
      </div>
      <div class="card-body card-body-padded">
        ${hero || lineup.length ? `
          <div class="captain-group-label">${t('Active line-up')}</div>
          <div class="captain-grid is-lineup">${hero ? heroTileHtml(hero) : ''}${lineup.map(({ c, i }) => tileHtml(c, i)).join('')}</div>
          <div class="captain-group-label">${t('All captains')}</div>` : ''}
        <div class="captain-grid">${captains.map((c, i) => tileHtml(c, i)).join('')}</div>
      </div>
    </div>
    ${dragonCardHtml(data.dragon)}
    ${hallOfFameCardHtml(data.hallOfFame)}
    ${artifactsCardHtml(artifacts)}
    ${changesTableHtml(t('Recent captain progress'), t('Captain'), recent)}
    ${changesTableHtml(t('Recent artifact and equipment changes'), t('Item'), gearChangeRows(data, captainNames))}`;
  wireTiles(el, {
    hero: () => hero && {
      title: heroName(hero),
      html: heroDetailHtml(hero),
      hoverHtml: heroDetailHtml(hero, { withName: true }),
      wide: (hero.equipment?.length ?? 0) > 0,
    },
    captain: (i) => {
      const c = captains[i];
      return c && {
        title: tGame(c.name),
        html: detailHtml(c, changes),
        hoverHtml: detailHtml(c, changes, { withName: true }),
        // Room for the equipment cards side by side.
        wide: (c.equipment?.length ?? 0) > 0,
      };
    },
    artifact: (i) => {
      const a = artifacts[i];
      return a && { title: tGame(a.name), html: artifactDetailHtml(a, artifactChanges), hoverHtml: artifactDetailHtml(a, artifactChanges, { withName: true }) };
    },
  });
}
