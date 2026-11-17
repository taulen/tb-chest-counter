// Captains tab on the member profile: every captain the player owns
// (Hercules, Skadi, Aurora…) with the game's own portrait and the game's value
// for it, read from the player's city record (GET /api/game/members/:id/captains).

import { api } from '../lib/api.js';
import { esc, formatDate } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';

/** The panel placeholder; mountMemberCaptains fills it the first time its tab opens. */
export function memberCaptainsPanelHtml() {
  return `<div class="member-captains" data-member-captains><div class="card"><div class="card-body card-body-padded"><p class="muted-copy">${t('Loading…')}</p></div></div></div>`;
}

function noteCard(text) {
  return `<div class="card"><div class="card-body card-body-padded"><div class="empty-state"><p>${text}</p></div></div></div>`;
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
    el.innerHTML = noteCard(t("This member's captains haven't been read from the game yet. They are read once a day."));
    return;
  }
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const cards = data.captains.map((c) => `
    <div class="captain-card rarity-${Number(c.rarity) || 0}">
      ${c.iconUrl ? `<img class="captain-portrait" src="${esc(c.iconUrl)}" alt="" loading="lazy" decoding="async">` : '<span class="captain-portrait is-empty" aria-hidden="true"></span>'}
      <span class="captain-name">${esc(tGame(c.name))}</span>
      <span class="captain-value" title="${esc(t('As the game reports it'))}">${t('XP {n}', { n: fmt(c.value) })}</span>
    </div>`).join('');
  const changes = (data.changes || []).slice(0, 40);
  el.innerHTML = `
    <div class="card">
      <div class="card-header"><h2>${t('Captains')}</h2>
        <span class="card-header-hint">${tn(data.captains.length, '{n} captain', '{n} captains', { n: data.captains.length })}</span>
      </div>
      <div class="card-body card-body-padded"><div class="captain-grid">${cards}</div></div>
    </div>
    ${changes.length ? `<div class="card">
      <div class="card-header"><h2>${t('Recent captain progress')}</h2></div>
      <div class="card-body">
        <table class="table-responsive captain-changes-table">
          <colgroup><col class="col-captain"><col class="col-value"><col class="col-date"></colgroup>
          <thead><tr><th>${t('Captain')}</th><th class="num">${t('XP')}</th><th>${t('Date')}</th></tr></thead>
          <tbody>${changes.map((c) => `<tr>
            <td data-label="${t('Captain')}" data-role="primary"><span class="mrow-name">${esc(tGame(c.name))}</span></td>
            <td data-label="${t('XP')}" data-role="metric" class="num">${fmt(c.value)}</td>
            <td data-label="${t('Date')}">${esc(formatDate(c.changedAt))}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>` : ''}`;
}
