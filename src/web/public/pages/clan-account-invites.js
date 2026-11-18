// Clans → "Account invites via chat": players DM the clan's scanner account a
// keyword and get a code for /join back (scheduler/chat-invites.ts,
// docs/account-invites.md). Off by default; loaded when the section opens.

import { escapeHtml, notify, formatDate } from '../lib/ui.js';
import { t, tn } from '../lib/i18n.js';
import { gameRankName } from '../lib/game-facts.js';
import { getCurrentUser } from '../lib/state.js';

/** The collapsed section on the clan card. */
export function accountInvitesSectionHtml(clanId) {
  return `
        <hr class="section-divider">
        <details class="clan-subsection" id="clan-account-invites-details-${clanId}">
        <summary class="clan-subsection-summary"><h3>${t('Account invites via chat')}</h3></summary>
        <div class="mt-12" id="clan-account-invites-${clanId}"><p class="muted-copy">${t('Loading…')}</p></div>
        </details>`;
}

/** Load the section the first time it is opened (the element is fresh every render). */
export function attachAccountInvites(root, clanId) {
  const details = root.querySelector(`#clan-account-invites-details-${clanId}`);
  if (!details) return;
  details.addEventListener('toggle', () => {
    if (details.open) void loadAccountInvites(root, clanId);
  });
}

async function loadAccountInvites(root, clanId) {
  const box = root.querySelector(`#clan-account-invites-${clanId}`);
  if (!box) return;
  try {
    const r = await fetch(`/api/clans/${clanId}/account-invites`);
    if (!r.ok) throw new Error(String(r.status));
    renderAccountInvites(root, box, clanId, await r.json());
  } catch {
    box.innerHTML = `<p class="warning-text">${t('Could not load the account invite settings.')}</p>`;
  }
}

/** A request's outcome, glyph + words. */
function statusText(status, reason) {
  if (status === 'sent') return `✓ ${t('Code sent')}`;
  if (status === 'pending' || status === 'sending') return `◐ ${t('Waiting to send')}`;
  if (status === 'unknown') return `? ${t('May have been sent (not resent)')}`;
  if (status === 'failed') return `✕ ${t('Could not be sent')}`;
  const why = {
    'not-member': t('not on the roster'),
    'no-player': t('not a player'),
    cooldown: t('asked again within 10 minutes'),
    duplicate: t('already waiting'),
    'chat-account-mismatch': t('chat account does not match the player'),
    channel: t('not a private chat with the scanner'),
    'sending-disabled': t('sending is off on this server'),
    'too-old': t('too old'),
    disabled: t('invites were switched off'),
  }[reason] || reason || '';
  return `– ${t('Not answered')}${why ? ` (${escapeHtml(why)})` : ''}`;
}

function renderAccountInvites(root, box, clanId, data) {
  const s = data.settings;
  const isSuperAdmin = getCurrentUser()?.role === 'superadmin';
  const keywords = (data.keywords || []).map((k) => `<code>${escapeHtml(k)}</code>`).join(', ');
  box.innerHTML = `
    <p class="muted-copy mb-8">${t("Players DM the clan's scanner account one word, and it answers in that private chat with a one-time code. On the site's Join page the code creates their account, linked to their player — or sets a new password, or adds this clan to their account. <strong>Only members on the roster get an answer</strong>, never more than one code per player per 10 minutes.")}</p>
    <p class="muted-copy mb-8">${t('Words that ask for a code: {words}', { words: keywords })}</p>
    <p class="muted-copy mb-8">${t('Roles follow the game: the {leader} and {superior} ranks are admins here, everyone else a member. Someone who leaves the clan in the game loses access until they are back.', { leader: escapeHtml(gameRankName(1)), superior: escapeHtml(gameRankName(2)) })}</p>
    ${data.sendingDisabled ? `<p class="warning-text mb-8">⚠ ${t('Chat sending is switched off on this server (CHAT_SEND_DISABLED): nothing is answered.')}</p>` : ''}
    ${!data.scannerKnown ? `<p class="warning-text mb-8">⚠ ${t("The scanner account isn't known yet; it is read at the clan's next scan.")}</p>` : ''}
    ${data.siteName
      ? `<p class="muted-copy mb-8">${t('The game blocks links, so messages name the site as <strong>{site}</strong> and tell players to pick “{label}” on its sign-in page.', { site: escapeHtml(data.siteName), label: escapeHtml(t('Have a code? Join here')) })}</p>`
      : `<p class="warning-text mb-8">⚠ ${t('No public address is set for the site, so messages can only say “the TB Chest Counter site”. Set the site name below.')}</p>`}
    ${isSuperAdmin ? `
    <div class="inline-form-row mb-8">
      <div class="form-row-grow"><label for="clan-account-site-${clanId}">${t('Site name in messages (every clan)')}</label>
        <input id="clan-account-site-${clanId}" class="input" type="text" maxlength="80" spellcheck="false" placeholder="${escapeHtml(t('From the public address'))}" value="${escapeHtml(data.siteNameOverride || '')}"></div>
      <button class="btn" type="button" data-account-site-save>${t('Save')}</button>
    </div>` : ''}
    <div class="inline-form-row">
      <label class="checkbox-row"><input type="checkbox" id="clan-account-invites-enabled-${clanId}" ${s.enabled ? 'checked' : ''}> ${t('Answer code requests in the game chat')}</label>
      <button class="btn btn-primary" type="button" data-account-invites-save>${t('Save')}</button>
    </div>
    <p class="muted-copy mt-4 hint-text">${s.enabled && s.enabledAt
      ? t('On since {date}. Only messages sent after that are answered.', { date: escapeHtml(formatDate(new Date(s.enabledAt).toISOString())) })
      : t('Off. Messages sent while it is off are never answered.')}
      ${tn(data.linkedAccounts, '{n} linked account in this clan.', '{n} linked accounts in this clan.', { n: data.linkedAccounts })}</p>
    <h4 class="mt-12">${t('Codes for members')}</h4>
    <p class="muted-copy mb-8">${t('The scanner account opens a private chat with a player and sends a code that lasts 72 hours, once per player, ever. The first time this is switched on, every current member without an account gets one; after that, everyone who joins. At most 10 per scan, a few seconds apart; never someone who already has an account. Switching it off stops it where it is.')}</p>
    <p class="muted-copy mb-8">⚠ ${t('Opening that chat has not been tried live yet: start with <strong>Dry run</strong>, which only lists who would get a code, then switch it on and watch the first sends.')}</p>
    <p class="muted-copy mb-8"><strong>${welcomeProgressText(data.welcomeProgress, s)}</strong></p>
    <div class="inline-form-row">
      <div><label for="clan-account-welcome-${clanId}">${t('Send members a code')}</label>
        <select id="clan-account-welcome-${clanId}" class="input">
          <option value="off" ${s.welcomeMode === 'off' ? 'selected' : ''}>${t('Off')}</option>
          <option value="dry-run" ${s.welcomeMode === 'dry-run' ? 'selected' : ''}>${t('Dry run (list only, sends nothing)')}</option>
          <option value="on" ${s.welcomeMode === 'on' ? 'selected' : ''}>${t('On')}</option>
        </select></div>
      <button class="btn btn-primary" type="button" data-account-welcome-save>${t('Save')}</button>
    </div>
    ${(data.welcomes || []).length ? `
    <div class="table-wrap mt-8">
      <table class="data-table account-invite-welcomes">
        <thead><tr><th scope="col">${t('Joined')}</th><th scope="col">${t('Player')}</th><th scope="col">${t('Status')}</th></tr></thead>
        <tbody>
          ${data.welcomes.map((w) => `<tr>
            <td>${w.joinedAt ? escapeHtml(formatDate(new Date(w.joinedAt * 1000).toISOString())) : ''}</td>
            <td>${escapeHtml(w.player)}</td>
            <td>${welcomeStatusText(w.status, w.reason)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}
    <h4 class="mt-12">${t('Recent code requests')}</h4>
    ${(data.recent || []).length ? `
    <div class="table-wrap mt-8">
      <table class="data-table account-invite-requests">
        <thead><tr><th scope="col">${t('Asked')}</th><th scope="col">${t('Player')}</th><th scope="col">${t('Status')}</th></tr></thead>
        <tbody>
          ${data.recent.map((r) => `<tr>
            <td>${escapeHtml(formatDate(new Date(r.requestedAt).toISOString()))}</td>
            <td>${r.player ? escapeHtml(r.player) : `<span class="muted-copy">${t('Unknown')}</span>`}</td>
            <td>${statusText(r.status, r.reason)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `<p class="muted-copy">${t('None yet.')}</p>`}
  `;

  box.querySelector('[data-account-invites-save]')?.addEventListener('click', () => {
    void save({ enabled: !!box.querySelector(`#clan-account-invites-enabled-${clanId}`)?.checked });
  });
  box.querySelector('[data-account-welcome-save]')?.addEventListener('click', () => {
    void save({ welcomeMode: box.querySelector(`#clan-account-welcome-${clanId}`)?.value || 'off' });
  });
  box.querySelector('[data-account-site-save]')?.addEventListener('click', () => {
    void save({ siteName: box.querySelector(`#clan-account-site-${clanId}`)?.value || '' }, `/api/clans/${clanId}/account-invites/site-name`);
  });

  async function save(payload, url = `/api/clans/${clanId}/account-invites`) {
    try {
      const r = await fetch(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        notify(t('Save failed: {error}', { error: j.error || r.status }), t('Account invites via chat'));
        return;
      }
      notify(t('Saved.'), t('Account invites via chat'));
      void loadAccountInvites(root, clanId);
    } catch {
      notify(t('Save failed.'), t('Account invites via chat'));
    }
  }
}

/** "Codes sent: 34 of 98", or what switching on would do before the first switch-on. */
function welcomeProgressText(p, s) {
  if (!p) return '';
  if (!s.welcomeBacklogAt) {
    return tn(p.backlogDue, 'Switching it on sends a code to {n} current member without an account.', 'Switching it on sends a code to {n} current members without an account.', { n: p.backlogDue });
  }
  const sent = t('Codes sent: {sent} of {total}', { sent: p.sent, total: p.total });
  const skipped = p.skipped ? ` · ${tn(p.skipped, '{n} could not be sent', '{n} could not be sent', { n: p.skipped })}` : '';
  const paused = s.welcomeMode !== 'on' && p.due ? ` · ${t('paused')}` : '';
  return `${sent}${skipped}${paused}`;
}

/** A welcome code's outcome, glyph + words. */
function welcomeStatusText(status, reason) {
  if (status === 'sent') return `✓ ${t('Code sent')}`;
  if (status === 'dry-run') return `○ ${t('Would get a code (dry run)')}`;
  if (status === 'waiting' || status === 'sending') return `◐ ${t('Waiting to send')}`;
  if (status === 'unknown') return `? ${t('May have been sent (not resent)')}`;
  const why = {
    'no-chat-account': t('chat account not found'),
    'chat-account-mismatch': t('chat account does not match the player'),
    'asked-themselves': t('asked for a code themselves'),
    'open-chat-failed': t('could not open a private chat'),
    channel: t('not a private chat with the scanner'),
  }[reason] || reason || '';
  return `– ${t('Not sent')}${why ? ` (${escapeHtml(why)})` : ''}`;
}
