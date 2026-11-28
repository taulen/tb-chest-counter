// What a battle's losses cost the player who fights it, at the game's own
// prices (Tools → Citadel and → Monsters; the user's rules, Nov 28 2026):
//  - a guardsman, specialist or siege engine lost is trained again with Silver:
//    battle-data.json `train`, less the player's training discount for its
//    kind, rounded down as the game does (Heavy Halberdier VII 1,500 × 0.22 =
//    330 — the training window's own price);
//  - a mercenary or monster is revived with Gold: `revive` divided by the
//    Temple's factor for the player's Temple level (battle-data `temple`, 5.91
//    at level 45). About 90 % of an attack's fallen reach the Temple; the rest
//    are gone (the game's own Temple help).
// The player's discounts and Temple come from /api/tools/player-economy (the
// account's own linked players, data/player-economy.ts).

import { api } from './api.js';
import { esc } from './ui.js';
import { t, tGame } from './i18n.js';

let economyLoading = null;

/**
 * The viewer's own linked players: { playerId, name, day, training:
 * {guardsmen, specialists, siege} (% or null), templeLevel, epicStrength }[];
 * [] when it can't be had.
 */
export function loadPlayerEconomy() {
  economyLoading ??= api('/tools/player-economy').then((r) => (Array.isArray(r?.players) ? r.players : [])).catch(() => {
    economyLoading = null;
    return [];
  });
  return economyLoading;
}

/**
 * Silver to train one again after the player's discount for its kind (null: not sold for Silver).
 * @param {number|undefined|null} train
 * @param {string|undefined|null} kind
 * @param {Record<string, number|null>|null} [discounts]
 * @returns {number|null}
 */
export function trainPrice(train, kind, discounts = null) {
  if (!(Number(train) > 0)) return null;
  const pct = Number(discounts?.[kind]);
  const factor = Number.isFinite(pct) ? Math.max(0, 1 + pct / 100) : 1;
  return Math.floor(train * factor + 1e-9);
}

/**
 * Gold to revive one: its price divided by the Temple's factor (none: the full price).
 * @param {number|undefined|null} revive
 * @param {number|null} [templeFactor]
 * @returns {number|null}
 */
export function revivePrice(revive, templeFactor = null) {
  if (!(Number(revive) > 0)) return null;
  return revive / (Number(templeFactor) > 0 ? templeFactor : 1);
}

/** The Temple's factor at a level, from battle-data's `temple` (null: unknown). */
export function templeFactor(temple, level) {
  const f = Number(temple?.times?.[String(level)]);
  return Number.isFinite(f) && f > 0 ? f : null;
}

/**
 * What some losses cost. `losses`: [{ lost, protected, kind, train, revive }]
 * (kind: guardsmen / specialists / siege for the discount). A normal troop the
 * game doesn't sell for Silver (event troops) is revived with Gold too.
 * @param {Array<{ lost: number, protected?: boolean, kind?: string|null, train?: number, revive?: number }>} losses
 * @param {{ discounts?: Record<string, number|null>|null, temple?: number|null }} [opts]
 * @returns {{ silver: number, gold: number, unpriced: number }}
 */
export function lossCosts(losses, { discounts = null, temple = null } = {}) {
  let silver = 0;
  let gold = 0;
  let unpriced = 0;
  for (const l of losses ?? []) {
    if (!(l.lost > 0)) continue;
    const s = l.protected ? null : trainPrice(l.train, l.kind, discounts);
    if (s !== null) {
      silver += l.lost * s;
      continue;
    }
    const g = revivePrice(l.revive, temple);
    if (g !== null) gold += l.lost * g;
    else unpriced += l.lost;
  }
  return { silver: Math.round(silver), gold: Math.round(gold), unpriced };
}

/** One line under an outcome: what its losses cost (empty without losses or prices). */
export function lossCostsHtml(c, cls = 'loss-costs') {
  const parts = [];
  if (c.silver > 0) parts.push(t('{amount} to train them again', { amount: `${c.silver.toLocaleString()} ${tGame('Silver')}` }));
  if (c.gold > 0) parts.push(t('{amount} to revive them', { amount: `${c.gold.toLocaleString()} ${tGame('Gold')}` }));
  return parts.length ? `<p class="${cls} muted-copy">${parts.map(esc).join(' · ')}</p>` : '';
}

/**
 * The note under the outcomes: whose prices these are. `players` the viewer's
 * own (loadPlayerEconomy), `picked` the one priced for; a select when there are
 * several (`data-price-player` on it) unless the page has its own (`select`
 * false: Monsters' Suggest player). `revived`: whether any outcome revives.
 */
export function pricesNoteHtml(players, picked, { revived = false, select = true } = {}) {
  const p = (players ?? []).find((x) => x.playerId === picked) ?? null;
  let who = '';
  if (select && players?.length > 1) {
    const opts = players.map((x) => `<option value="${x.playerId}" ${x.playerId === picked ? 'selected' : ''}>${esc(x.name || t('Unknown player'))}</option>`).join('');
    who = `<label class="loss-costs-player"><span class="visually-hidden">${esc(t('Prices for'))}</span><select class="input" data-price-player>${opts}</select></label>`;
  }
  let text;
  if (!p || !p.day) text = t('Prices: the game’s own, without discounts.');
  else if (p.templeLevel) text = t('Prices: {player}’s training discounts and Temple level {level}, from the city read on {day}.', { player: p.name || t('Unknown player'), level: p.templeLevel, day: p.day });
  else text = t('Prices: {player}’s training discounts, from the city read on {day}.', { player: p.name || t('Unknown player'), day: p.day });
  const temple = revived ? ` ${esc(t('About 90% of the troops lost in an attack reach the Temple to be revived; the rest are gone.'))}` : '';
  return `<p class="loss-costs-note muted-copy">${who}${esc(text)}${temple}</p>`;
}
