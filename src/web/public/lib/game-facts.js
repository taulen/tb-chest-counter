// What the game itself reports about a player — clan rank, when they joined,
// city level, VIP, Gold Pass, Gold Ingots, shield / burning, hero level — as a row of pills, plus the hero
// portrait. Shared by the member profile and the public board's hover card, so
// it imports only what the public page can load (no session, no router).
//
// `player` is the shape served by /api/game/members/:id and the public
// breakdown's `game` field: { role, joinedAt, inClan, cityLevel, vip,
// goldPass, goldIngots, shielded, burning, heroLevel, avatarUrl }.

import { esc, formatDate, formatDateShort } from './ui.js';
import { t, tGame } from './i18n.js';

/** The game's clan ranks by number — official names, translated by tGame. */
export const GAME_CLAN_RANKS = { 1: 'Leader', 2: 'Superior', 3: 'Officer', 4: 'Veteran', 5: 'Soldier' };

export function gameRankName(role) {
  return GAME_CLAN_RANKS[role] ? tGame(GAME_CLAN_RANKS[role]) : '';
}

/**
 * The pills. `joined: false` leaves the join date out (the hover card is short
 * on room); `heroLevel: true` adds the hero level (the profile shows it as a stat).
 */
export function gameFactsHtml(player, { joined = true, heroLevel = false } = {}) {
  const p = player;
  if (!p) return '';
  const pills = [];
  const rank = gameRankName(p.role);
  if (rank) pills.push(`<span class="game-fact-pill is-rank">${esc(rank)}</span>`);
  if (p.inClan === false) pills.push(`<span class="game-fact-pill is-left">${t('Not in the clan')}</span>`);
  // What the map shows of the city (null = not read yet: no pill). Burning
  // first — walls down is the one that needs someone to act.
  if (p.burning === true) {
    pills.push(`<span class="game-fact-pill is-burning" title="${esc(t('Walls down: the city is burning on the map'))}"><span aria-hidden="true">🔥</span> ${t('Burning')}</span>`);
  }
  if (p.shielded === true) {
    pills.push(`<span class="game-fact-pill is-shielded" title="${esc(t('The city has a shield on the map'))}"><span aria-hidden="true">🛡</span> ${t('Shielded')}</span>`);
  } else if (p.shielded === false) {
    pills.push(`<span class="game-fact-pill is-unshielded" title="${esc(t('The city has no shield on the map'))}">${t('No shield')}</span>`);
  }
  if (joined && p.joinedAt) {
    const iso = new Date(p.joinedAt * 1000).toISOString();
    pills.push(`<span class="game-fact-pill" title="${esc(formatDate(iso))}">${t('Joined {date}', { date: formatDateShort(iso) })}</span>`);
  }
  if (heroLevel && p.heroLevel) pills.push(`<span class="game-fact-pill">${t('Hero level {n}', { n: p.heroLevel })}</span>`);
  if (p.cityLevel) pills.push(`<span class="game-fact-pill">${t('City level {n}', { n: p.cityLevel })}</span>`);
  if (p.vip) pills.push(`<span class="game-fact-pill">${t('VIP {n}', { n: p.vip })}</span>`);
  // Gold Ingots are public in the game (every player's profile shows them); the
  // game's own name for them, via tGame.
  if (p.goldIngots != null) pills.push(`<span class="game-fact-pill">${esc(tGame('Gold Ingots'))} ${Number(p.goldIngots).toLocaleString()}</span>`);
  if (p.goldPass) pills.push(`<span class="game-fact-pill is-gold" title="${esc(t('This member has the Gold Pass, as the game reports it'))}">${t('Gold Pass')}</span>`);
  return pills.length ? `<div class="game-facts">${pills.join('')}</div>` : '';
}

/** The hero portrait, or nothing when there is no image for it. Decorative: the name is beside it. */
export function heroAvatarHtml(player, size = 40) {
  const url = player?.avatarUrl;
  if (!url) return '';
  return `<img class="hero-avatar" src="${esc(url)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
}
