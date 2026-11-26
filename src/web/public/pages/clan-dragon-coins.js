// Clans → "Dragon Coins back to members": the scanner account (Leader or
// Superior) sends each member the Dragon Coins their event rewards put into
// the clan treasury (scheduler/dragon-coin-returns.ts,
// docs/dragon-coin-returns.md). Off by default; loaded when the section
// opens. Built like "Chat commands" (its styles): one line on what it is, the
// switch as a row that saves on change, what's waiting, the fine print folded
// into "How it works", then recent sends.

import { escapeHtml, notify, formatDate, memberLink } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { gameRankName } from '../lib/game-facts.js';
import { loadGameArt } from '../lib/game-art.js';
import { resourceIconOnly } from '../lib/resource-format.js';

const COINS = 'Dragon Coins';

/** The section title: the game's own name for the coins. */
function titleText() {
  return t('{coins} back to members', { coins: tGame(COINS) });
}

/** The section on the clan card's In-game tab. */
export function dragonCoinsSectionHtml(clanId) {
  return `
        <section class="clan-section" id="clan-dragon-coins-details-${clanId}">
        <h3 class="clan-section-title">${escapeHtml(titleText())}</h3>
        <div class="mt-12" id="clan-dragon-coins-${clanId}"><p class="muted-copy">${t('Loading…')}</p></div>
        </section>`;
}

/** Load the section when its tab is shown (the element is fresh every render, so nothing stacks). */
export function attachDragonCoins(root, clanId) {
  const section = root.querySelector(`#clan-dragon-coins-details-${clanId}`);
  // Only while its tab is on screen: a hidden tab panel loads nothing.
  if (section && !section.closest('[hidden]')) void loadDragonCoins(root, clanId);
}

async function loadDragonCoins(root, clanId) {
  const box = root.querySelector(`#clan-dragon-coins-${clanId}`);
  if (!box) return;
  try {
    const [r] = await Promise.all([fetch(`/api/clans/${clanId}/dragon-coin-returns`), loadGameArt()]);
    if (!r.ok) throw new Error(String(r.status));
    renderDragonCoins(root, box, clanId, await r.json());
  } catch {
    box.innerHTML = `<p class="warning-text">${t('Could not load the {coins} settings.', { coins: escapeHtml(tGame(COINS)) })}</p>`;
  }
}

const amountHtml = (n) => `<span class="dc-amount">${resourceIconOnly(COINS)}${escapeHtml(Number(n || 0).toLocaleString())}</span>`;
const whenText = (ms) => escapeHtml(formatDate(new Date(ms).toISOString()).slice(0, 16));
const playerHtml = (row) => (row.player ? memberLink(row.memberId, row.player) : `<span class="muted-copy">${t('Unknown')}</span>`);

/** A send's outcome, glyph + words. */
function statusText(row, limits) {
  if (row.status === 'sent') return row.confirmed ? `✓ ${t('Sent')}` : `✓ ${t('Sent (not yet in the treasury history)')}`;
  if (row.status === 'sending') return `◐ ${t('Sending')}`;
  if (row.status === 'unknown') return `? ${t('No clear answer: the treasury history decides within {minutes} minutes', { minutes: limits.unconfirmedMinutes ?? 15 })}`;
  const why = row.reason === 'not-in-ledger' ? t('not in the treasury history') : '';
  return `✕ ${t('Not sent')}${why ? ` (${escapeHtml(why)})` : ''}`;
}

/** Why coins are left alone. */
function heldText(reason, limits) {
  if (reason === 'paid-by-hand') return t('Already paid back by hand');
  if (reason === 'left-clan') return t('Left the clan');
  if (reason === 'gave-up') return tn(limits.maxAttempts ?? 3, 'Not sent after {n} try', 'Not sent after {n} tries', { n: limits.maxAttempts ?? 3 });
  return reason || '';
}

function tableHtml(cls, headers, rows) {
  return `<div class="table-wrap">
      <table class="data-table table-responsive dc-table ${cls}">
        <colgroup><col class="dc-col-player"><col class="dc-col-amount"><col class="dc-col-when"><col class="dc-col-status"></colgroup>
        <thead><tr>${headers.map((h, i) => `<th scope="col"${i === 1 ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

function renderDragonCoins(root, box, clanId, data) {
  const s = data.settings;
  const limits = data.limits || {};
  const switchId = `clan-dragon-coins-enabled-${clanId}`;
  const coinsName = escapeHtml(tGame(COINS));
  const leader = gameRankName(1);
  const superior = gameRankName(2);

  const notices = [];
  if (data.sendingDisabled) notices.push(t('Sending is switched off on this server (DRAGON_COIN_RETURNS_DISABLED): nothing is sent.'));
  if (!data.scanner) {
    notices.push(t('The scanner account isn’t known yet: the clan’s next scan finds it.'));
  } else if (!data.rankOk) {
    notices.push(data.scanner.rank
      ? t('The scanner account, {name}, is {rank} in the clan. Only a {leader} or {superior} can send from the treasury, so nothing is sent.', {
        name: data.scanner.name || '—', rank: gameRankName(data.scanner.rank), leader, superior,
      })
      : t('The scanner account, {name}, is not on the clan’s roster, so nothing is sent.', { name: data.scanner.name || '—' }));
  }

  const week = data.sentLastWeek || { sends: 0, coins: 0 };
  const state = s.enabled && s.enabledAt
    ? `<span class="invite-on">✓ ${t('On since {date}', { date: escapeHtml(formatDate(new Date(s.enabledAt).toISOString())) })}</span>`
    : `<span class="invite-off">○ ${t('Off')}</span>`;
  const sentLine = tn(week.sends, '{n} send in the last 7 days', '{n} sends in the last 7 days', { n: week.sends })
    + (week.coins ? ` · ${Number(week.coins).toLocaleString()} ${tGame(COINS)}` : '');

  const switchRow = `<div class="invite-setting">
      <div class="invite-setting-text">
        <div class="invite-setting-title"><label for="${switchId}">${escapeHtml(t('Send {coins} back automatically', { coins: tGame(COINS) }))}</label></div>
        <div class="invite-setting-desc">${escapeHtml(t('Only coins that reach the treasury after this is switched on. What the clan itself wins in an event is never sent.'))}</div>
        <div class="invite-setting-state">${state} · ${escapeHtml(sentLine)}</div>
      </div>
      <div class="invite-setting-control"><input type="checkbox" role="switch" class="invite-switch" id="${switchId}" ${s.enabled ? 'checked' : ''}></div>
    </div>`;

  const coinsHead = `${resourceIconOnly(COINS)}${coinsName}`;
  const waiting = data.waiting || [];
  const waitingHtml = !s.enabled ? '' : `
    <h4 class="invite-subhead">${t('Waiting to be sent')}</h4>
    ${waiting.length
      ? `<p class="invite-setting-desc">${escapeHtml(t('Sent after the clan’s next scan.'))}</p>
        ${tableHtml('dc-waiting', [t('Player'), coinsHead, t('Arrived'), t('Entries')], waiting.map((w) => `<tr>
          <td data-label="${escapeHtml(t('Player'))}" data-role="primary"><span class="mrow-name">${playerHtml(w)}</span></td>
          <td data-label="${coinsName}" data-role="metric" class="num">${amountHtml(w.amount)}</td>
          <td data-label="${escapeHtml(t('Arrived'))}">${whenText(w.since)}</td>
          <td data-label="${escapeHtml(t('Entries'))}">${escapeHtml(String(w.entries))}</td>
        </tr>`))}`
      : `<p class="muted-copy">${escapeHtml(t('Nothing waiting: every member’s coins since the switch went on have been sent back.'))}</p>`}`;

  const held = data.held || [];
  // Folded: after an event it can be a long list, and nothing in it waits on anyone.
  const heldHtml = !s.enabled || !held.length ? '' : `
    <details class="invite-how dc-held-fold">
    <summary>${t('Left in the treasury')} · ${held.length}</summary>
    ${tableHtml('dc-held', [t('Player'), coinsHead, t('Arrived'), t('Why')], held.map((h) => `<tr>
      <td data-label="${escapeHtml(t('Player'))}" data-role="primary"><span class="mrow-name">${playerHtml(h)}</span><span class="mrow-sub">${escapeHtml(heldText(h.reason, limits))}</span></td>
      <td data-label="${coinsName}" data-role="metric" class="num">${amountHtml(h.amount)}</td>
      <td data-label="${escapeHtml(t('Arrived'))}">${whenText(h.at)}</td>
      <td data-label="${escapeHtml(t('Why'))}" data-role="hidden">${escapeHtml(heldText(h.reason, limits))}</td>
    </tr>`))}
    </details>`;

  const how = `<details class="invite-how">
      <summary>${t('How it works')}</summary>
      <ul>
        <li>${escapeHtml(t('Only coins a member brings in: when they collect an event reward, the game sends its {coins} to the treasury under their name. What the clan wins (credited to the {leader} at the reset) is never sent.', { coins: tGame(COINS), leader }))}</li>
        <li>${escapeHtml(t('Only coins that arrive after the switch goes on. Switching it off and on again starts from then.'))}</li>
        <li>${escapeHtml(t('One send per member with all their waiting coins, up to {perRun} members a scan, never more than the treasury holds.', { perRun: limits.perRun ?? 30 }))}</li>
        <li>${escapeHtml(t('Coins a {leader} or {superior} already paid back by hand (the same amount to that member after the coins arrived) are not sent again.', { leader, superior }))}</li>
        <li>${escapeHtml(t('Every send is checked in the treasury history. One that doesn’t show there within {minutes} minutes is tried again, at most {attempts} times.', { minutes: limits.unconfirmedMinutes ?? 15, attempts: limits.maxAttempts ?? 3 }))}</li>
        <li>${escapeHtml(t('Coins of a member who left the clan stay in the treasury.'))}</li>
      </ul>
    </details>`;

  const recent = data.recent || [];
  const recentHtml = !recent.length ? '' : `
    <h4 class="invite-subhead">${t('Recent sends')}</h4>
    ${tableHtml('dc-recent', [t('Player'), coinsHead, t('Sent'), t('Status')], recent.map((r) => `<tr>
      <td data-label="${escapeHtml(t('Player'))}" data-role="primary"><span class="mrow-name">${playerHtml(r)}</span><span class="mrow-sub">${statusText(r, limits)}</span></td>
      <td data-label="${coinsName}" data-role="metric" class="num">${amountHtml(r.amount)}</td>
      <td data-label="${escapeHtml(t('Sent'))}">${whenText(r.at)}</td>
      <td data-label="${escapeHtml(t('Status'))}" data-role="hidden">${statusText(r, limits)}</td>
    </tr>`))}`;

  box.innerHTML = `
    <div class="invite-panel">
      <p class="invite-lede">${escapeHtml(t('When a member collects an event reward, its {coins} go to the clan treasury. With this on, the scanner account sends each member theirs back after the scan that sees them arrive.', { coins: tGame(COINS) }))}</p>
      ${notices.map((n) => `<p class="invite-notice">⚠ ${escapeHtml(n)}</p>`).join('')}
      <div class="invite-settings">${switchRow}</div>
      ${waitingHtml}
      ${heldHtml}
      ${how}
      ${recentHtml}
    </div>`;

  // The switch saves on change; a failed save puts it back.
  const sw = box.querySelector(`#${switchId}`);
  sw?.addEventListener('change', async () => {
    try {
      const r = await fetch(`/api/clans/${clanId}/dragon-coin-returns`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: sw.checked }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        sw.checked = !sw.checked;
        notify(t('Save failed: {error}', { error: j.error || r.status }), titleText());
        return;
      }
      notify(t('Saved.'), titleText());
      void loadDragonCoins(root, clanId);
    } catch {
      sw.checked = !sw.checked;
      notify(t('Save failed.'), titleText());
    }
  });
}
