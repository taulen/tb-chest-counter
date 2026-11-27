// Clans → In-game → "Battle reports": which chats the site reads shared battle
// reports from, and the clan's Tin Man rule (docs/battle-reports.md). The
// clan chat and private messages to the scanner account are always read; an
// admin adds up to five of the account's group chats (a "Tin Man hits" or
// "citadels" chat keeps the clan chat free of report spam). Built like "Chat
// commands" (its styles): one line on what it is, a switch per chat that saves
// on change, the rule, the fine print folded into "How it works".

import { escapeHtml, notify, formatDate } from '../lib/ui.js';
import { t, tn } from '../lib/i18n.js';

/** The section on the clan card's In-game tab. */
export function battleReportsSectionHtml(clanId) {
  return `
        <section class="clan-section" id="clan-battle-reports-details-${clanId}">
        <h3 class="clan-section-title">${t('Battle reports')}</h3>
        <div class="mt-12" id="clan-battle-reports-${clanId}"><p class="muted-copy">${t('Loading…')}</p></div>
        </section>`;
}

/** Load the section when its tab is shown (the element is fresh every render, so nothing stacks). */
export function attachBattleReports(root, clanId) {
  const section = root.querySelector(`#clan-battle-reports-details-${clanId}`);
  if (section && !section.closest('[hidden]')) void loadBattleReports(root, clanId);
}

async function loadBattleReports(root, clanId) {
  const box = root.querySelector(`#clan-battle-reports-${clanId}`);
  if (!box) return;
  try {
    const r = await fetch(`/api/clans/${clanId}/battle-reports`);
    if (!r.ok) throw new Error(String(r.status));
    renderBattleReports(root, box, clanId, await r.json());
  } catch {
    box.innerHTML = `<p class="warning-text">${t('Could not load the battle report settings.')}</p>`;
  }
}

async function save(clanId, body) {
  const r = await fetch(`/api/clans/${clanId}/battle-reports`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || String(r.status));
  return j;
}

function renderBattleReports(root, box, clanId, data) {
  const chats = data.chats || [];
  const picked = chats.filter((c) => c.picked);
  const max = data.maxChats || 5;
  const reports = data.reports || { shared: 0, read: 0, waiting: 0, unavailable: 0, lastReadAt: null };

  const always = `<div class="invite-setting">
      <div class="invite-setting-text">
        <div class="invite-setting-title">${t('Clan chat and private messages')}</div>
        <div class="invite-setting-desc">${t('Always read: a report shared in the clan chat, or sent to the scanner account in a private message. A private message keeps citadel and Tin Man reports out of the clan chat.')}</div>
      </div>
      <div class="invite-setting-control"><span class="invite-on">✓ ${t('Always')}</span></div>
    </div>`;

  const chatRows = chats.map((c, i) => {
    const id = `clan-report-chat-${clanId}-${i}`;
    const full = !c.picked && picked.length >= max;
    const state = !c.member
      ? `<span class="invite-off">⚠ ${t('The scanner account is no longer in this chat.')}</span>`
      : c.picked ? `<span class="invite-on">✓ ${t('Read')}</span>` : `<span class="invite-off">○ ${t('Not read')}</span>`;
    return `<div class="invite-setting">
      <div class="invite-setting-text">
        <div class="invite-setting-title"><label for="${id}">${escapeHtml(c.name || t('Unnamed chat'))}</label></div>
        <div class="invite-setting-desc">${escapeHtml(tn(c.memberCount || 0, '{n} member', '{n} members'))}</div>
        <div class="invite-setting-state">${state}</div>
        ${full ? `<div class="invite-setting-note">${escapeHtml(t('At most {n} chats.', { n: max }))}</div>` : ''}
      </div>
      <div class="invite-setting-control"><input type="checkbox" role="switch" class="invite-switch" id="${id}" data-chat-url="${escapeHtml(c.url)}" ${c.picked ? 'checked' : ''} ${full ? 'disabled' : ''}></div>
    </div>`;
  }).join('');
  const chatsHtml = chats.length
    ? chatRows
    : `<p class="muted-copy">${t('The scanner account is in no group chat yet. Add it to a chat in the game; the chat shows here within a minute.')}</p>`;

  const ruleLabelId = `clan-tinman-rule-label-${clanId}`;
  const choices = [null, ...(data.stackChoices || [4, 3, 2])];
  const ruleRow = `<div class="invite-setting">
      <div class="invite-setting-text">
        <div class="invite-setting-title" id="${ruleLabelId}">${t('Tin Man rule')}</div>
        <div class="invite-setting-desc">${t('Hit the Tin Man only while it still has this many stacks of monsters. Events → Ancients → Hits marks every shared hit against it.')}</div>
      </div>
      <div class="invite-setting-control">
        <div class="invite-segmented" role="radiogroup" aria-labelledby="${ruleLabelId}">
          ${choices.map((n) => {
            const on = (data.requiredStacks ?? null) === n;
            const label = n === null ? t('Off') : tn(n, '{n} stack', '{n} stacks');
            return `<button type="button" role="radio" class="invite-segmented-btn${on ? ' is-active' : ''}" aria-checked="${on}" data-tinman-rule="${n === null ? '' : n}">${escapeHtml(label)}</button>`;
          }).join('')}
        </div>
      </div>
    </div>`;

  const status = reports.shared
    ? [
      tn(reports.shared, '{n} report shared', '{n} reports shared'),
      tn(reports.read, '{n} read', '{n} read'),
      reports.waiting ? tn(reports.waiting, '{n} waiting', '{n} waiting') : '',
      reports.unavailable ? tn(reports.unavailable, '{n} no longer in the game', '{n} no longer in the game') : '',
    ].filter(Boolean).join(' · ') + (reports.lastReadAt ? ` · ${t('last read {date}', { date: formatDate(reports.lastReadAt) })}` : '')
    : t('No report shared yet.');

  const how = `<details class="invite-how">
      <summary>${t('How it works')}</summary>
      <ul>
        <li>${t('A member shares a battle report in a chat the scanner account reads. Between scans the site opens it in the game’s journal, like a member tapping the link, and keeps what it says.')}</li>
        <li>${t('Nothing is posted: the scanner account doesn’t answer a report, in any chat.')}</li>
        <li>${t('Tin Man hits show under Events → Ancients → Hits. Clan announcements shared the same way are kept too.')}</li>
        <li>${t('The game keeps a report for some weeks. One shared after it is gone can’t be read.')}</li>
        <li>${t('To add a chat, add the scanner account to it in the game. It shows here within a minute.')}</li>
      </ul>
    </details>`;

  box.innerHTML = `
    <div class="invite-panel">
      <p class="invite-lede">${t('Battle reports members share are read from the game: who hit what, both armies, and for the Tin Man how many stacks it still had.')}</p>
      <p class="invite-setting-state">${escapeHtml(status)}</p>
      <div class="invite-settings">${always}${ruleRow}</div>
      <h4 class="invite-subhead">${t('Also read these group chats')}</h4>
      <div class="invite-settings">${chatsHtml}</div>
      ${how}
    </div>`;

  box.querySelectorAll('input[data-chat-url]').forEach((sw) => {
    sw.addEventListener('change', async () => {
      const urls = [...box.querySelectorAll('input[data-chat-url]')].filter((x) => x.checked).map((x) => x.dataset.chatUrl);
      try {
        await save(clanId, { chats: urls });
        notify(t('Saved.'), t('Battle reports'));
        void loadBattleReports(root, clanId);
      } catch (err) {
        sw.checked = !sw.checked;
        notify(t('Save failed: {error}', { error: err.message }), t('Battle reports'));
      }
    });
  });
  box.querySelectorAll('[data-tinman-rule]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const raw = btn.dataset.tinmanRule;
      try {
        await save(clanId, { requiredStacks: raw === '' ? null : Number(raw) });
        notify(t('Saved.'), t('Battle reports'));
        void loadBattleReports(root, clanId);
      } catch (err) {
        notify(t('Save failed: {error}', { error: err.message }), t('Battle reports'));
      }
    });
  });
}
