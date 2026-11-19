// Clans → "Account invites via chat": players DM the clan's scanner account a
// keyword and get a code for /join back (scheduler/chat-invites.ts,
// docs/account-invites.md). Off by default; loaded when the section opens.
//
// Layout: one line on what it is, then the two settings as rows that save
// the moment they change (a switch; Off / Dry run / On), the site name as a
// sentence with an Edit link, and the fine print folded into "How it works".

import { escapeHtml, notify, formatDate, confirmDialog, memberLink } from '../lib/ui.js';
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

const WELCOME_MODES = ['off', 'dry-run', 'on'];

function welcomeModeLabel(mode) {
  return mode === 'on' ? t('On') : mode === 'dry-run' ? t('Dry run') : t('Off');
}

/** One settings row: title, one-line description, current state on the left; the control on the right. */
function settingRow({ title, desc, state = '', note = '', control }) {
  return `<div class="invite-setting">
      <div class="invite-setting-text">
        <div class="invite-setting-title">${title}</div>
        <div class="invite-setting-desc">${desc}</div>
        ${state ? `<div class="invite-setting-state">${state}</div>` : ''}
        ${note ? `<div class="invite-setting-note">${note}</div>` : ''}
      </div>
      <div class="invite-setting-control">${control}</div>
    </div>`;
}

function renderAccountInvites(root, box, clanId, data) {
  const s = data.settings;
  const isSuperAdmin = getCurrentUser()?.role === 'superadmin';
  const keywords = (data.keywords || []).map((k) => `<code>${escapeHtml(k)}</code>`).join(' ');
  const answerId = `clan-account-invites-enabled-${clanId}`;
  const welcomeLabelId = `clan-account-welcome-label-${clanId}`;

  const notices = [
    data.sendingDisabled ? t('Chat sending is switched off on this server (CHAT_SEND_DISABLED): nothing is answered.') : '',
    !data.scannerKnown ? t("The scanner account isn't known yet; it is read at the clan's next scan.") : '',
    // Our account is muted (the game's anti-spam), not the players: nothing goes out until then.
    data.chatPause ? t('The game muted the scanner account’s chat at {at}. Nothing is sent until {until}; codes wait and go out after that.', {
      at: data.chatPause.mutedAt ? formatDate(new Date(data.chatPause.mutedAt).toISOString()) : '—',
      until: formatDate(new Date(data.chatPause.until).toISOString()),
    }) : '',
  ].filter(Boolean);

  const answerState = s.enabled && s.enabledAt
    ? `<span class="invite-on">✓ ${t('On since {date}', { date: escapeHtml(formatDate(new Date(s.enabledAt).toISOString())) })}</span>`
    : `<span class="invite-off">○ ${t('Off')}</span>`;
  const linked = tn(data.linkedAccounts, '{n} linked account in this clan.', '{n} linked accounts in this clan.', { n: data.linkedAccounts });

  const answerRow = settingRow({
    title: `<label for="${answerId}">${t('Answer code requests')}</label>`,
    desc: t('A member messages the scanner account “code” in the game and gets one back.'),
    state: `${answerState} · ${linked}`,
    control: `<input type="checkbox" role="switch" class="invite-switch" id="${answerId}" ${s.enabled ? 'checked' : ''}>`,
  });

  const progress = welcomeProgressText(data.welcomeProgress, s);
  const welcomeRow = settingRow({
    title: `<span id="${welcomeLabelId}">${t('Send members a code')}</span>`,
    desc: t('The scanner account messages each member without an account once, then everyone who joins. One message every 10 minutes at most.'),
    state: progress ? escapeHtml(progress) : '',
    note: s.welcomeMode === 'on' ? '' : `⚠ ${t('Not tried live yet. Dry run lists who would get a code and sends nothing.')}`,
    control: `<div class="invite-segmented" role="radiogroup" aria-labelledby="${welcomeLabelId}">
        ${WELCOME_MODES.map((m) => `<button type="button" role="radio" class="invite-segmented-btn${s.welcomeMode === m ? ' is-active' : ''}" aria-checked="${s.welcomeMode === m}" data-welcome-mode="${m}">${welcomeModeLabel(m)}</button>`).join('')}
      </div>`,
  });

  const siteLine = data.siteName
    ? t('Messages name the site as {site}.', { site: `<strong>${escapeHtml(data.siteName)}</strong>` })
    : `⚠ ${t('No public address is set, so messages say “the TB Chest Counter site”.')}`;
  const siteRow = `<div class="invite-site" data-site-view>
      <span>${siteLine}</span>
      ${isSuperAdmin ? `<button type="button" class="invite-link-btn" data-site-edit>${t('Edit')}</button>` : ''}
    </div>
    ${isSuperAdmin ? `<form class="invite-site-form" data-site-form hidden>
      <label class="visually-hidden" for="clan-account-site-${clanId}">${t('Site name in messages (every clan)')}</label>
      <input id="clan-account-site-${clanId}" class="input" type="text" maxlength="80" spellcheck="false" placeholder="cwb.fyi" value="${escapeHtml(data.siteName || '')}">
      <button class="btn btn-primary btn-sm" type="submit">${t('Save')}</button>
      <button class="btn btn-sm" type="button" data-site-cancel>${t('Cancel')}</button>
      <span class="invite-site-hint">${t('Every clan. Leave it as the public address unless the game should see another name.')}</span>
    </form>` : ''}`;

  const how = `<details class="invite-how">
      <summary>${t('How it works')}</summary>
      <ul>
        <li>${t('Words that ask for a code: {words}', { words: keywords })}</li>
        <li>${t('Only members on the roster get a code. It lasts 72 hours, works once, and a player gets at most one every 10 minutes.')}</li>
        <li>${t('On the Join page the code creates their account linked to their player, sets a new password, or adds this clan to their account.')}</li>
        <li>${t('Roles follow the game: the {leader} and {superior} ranks are admins here, everyone else a member. Someone who leaves the clan in the game loses access until they are back.', { leader: escapeHtml(gameRankName(1)), superior: escapeHtml(gameRankName(2)) })}</li>
        <li>${t('The game blocks links, so messages spell the site out and tell players to pick “{label}”.', { label: escapeHtml(t('Have a code? Join here')) })}</li>
      </ul>
    </details>`;

  // Dry run: the list it is for — who switching it on would message now.
  const would = s.welcomeMode === 'dry-run' ? (data.wouldGetCode || []) : [];
  const wouldTable = s.welcomeMode === 'dry-run' ? `
    <h4 class="invite-subhead">${escapeHtml(tn(would.length, '{n} member would get a code', '{n} members would get a code', { n: would.length }))}</h4>
    <p class="ui-sub">${t('Dry run: nothing is sent. Switch to On to send these, one every 10 minutes.')}</p>
    ${would.length ? `<div class="table-wrap invite-would">
      <table class="data-table account-invite-would">
        <thead><tr><th scope="col">${t('Player')}</th><th scope="col">${t('Joined')}</th></tr></thead>
        <tbody>
          ${would.map((w) => `<tr><td>${memberLink(w.memberId, w.player)}</td><td>${w.joinedAt ? escapeHtml(formatDate(new Date(w.joinedAt * 1000).toISOString()).slice(0, 10)) : ''}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}` : '';

  const welcomesTable = s.welcomeMode !== 'dry-run' && (data.welcomes || []).length ? `
    <h4 class="invite-subhead">${t('Codes for members')} <span class="ui-sub">${data.welcomes.length}</span></h4>
    <div class="table-wrap invite-would">
      <table class="data-table account-invite-welcomes">
        <thead><tr><th scope="col">${t('Player')}</th><th scope="col">${t('Joined')}</th><th scope="col">${t('Sent')}</th><th scope="col">${t('Status')}</th><th scope="col">${t('Account')}</th></tr></thead>
        <tbody>
          ${data.welcomes.map((w) => `<tr>
            <td>${memberLink(w.memberId, w.player)}</td>
            <td>${w.joinedAt ? escapeHtml(formatDate(new Date(w.joinedAt * 1000).toISOString()).slice(0, 10)) : ''}</td>
            <td>${w.status === 'sent' && w.updatedAt ? escapeHtml(formatDate(w.updatedAt)) : ''}</td>
            <td>${welcomeStatusText(w.status, w.reason)}</td>
            <td>${welcomeAccountHtml(w)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  const requestsTable = (data.recent || []).length ? `
    <h4 class="invite-subhead">${t('Recent code requests')}</h4>
    <div class="table-wrap">
      <table class="data-table account-invite-requests">
        <thead><tr><th scope="col">${t('Asked')}</th><th scope="col">${t('Player')}</th><th scope="col">${t('Status')}</th></tr></thead>
        <tbody>
          ${data.recent.map((r) => `<tr>
            <td>${escapeHtml(formatDate(new Date(r.requestedAt).toISOString()))}</td>
            <td>${r.player ? memberLink(r.memberId, r.player) : `<span class="muted-copy">${t('Unknown')}</span>`}</td>
            <td>${statusText(r.status, r.reason)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  box.innerHTML = `
    <div class="invite-panel">
      <p class="invite-lede">${t('Players get a one-time code from the scanner account in the game chat, and enter it on the site to get an account linked to their player.')}</p>
      ${notices.map((n) => `<p class="invite-notice">⚠ ${escapeHtml(n)}</p>`).join('')}
      <div class="invite-settings">${answerRow}${welcomeRow}</div>
      ${wouldTable}
      ${siteRow}
      ${how}
      ${welcomesTable}
      ${requestsTable}
    </div>`;

  // The switch saves on change; a failed save puts it back.
  const sw = box.querySelector(`#${answerId}`);
  sw?.addEventListener('change', async () => {
    if (!(await save({ enabled: sw.checked }))) sw.checked = !sw.checked;
  });

  // Off / Dry run / On save on click; On asks first while it would message members.
  for (const btn of box.querySelectorAll('[data-welcome-mode]')) {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.welcomeMode;
      if (mode === s.welcomeMode) return;
      const p = data.welcomeProgress;
      const due = (s.welcomeBacklogAt ? p?.due : p?.backlogDue) ?? 0;
      if (mode === 'on' && due > 0) {
        const ok = await confirmDialog(
          tn(due, 'The scanner account will message {n} member a code, one every 10 minutes.', 'The scanner account will message {n} members a code, one every 10 minutes.', { n: due }),
          { title: t('Send members a code'), confirmLabel: t('Switch on') },
        );
        if (!ok) return;
      }
      await save({ welcomeMode: mode });
    });
  }

  // Site name: a sentence with Edit, which swaps in the field.
  const view = box.querySelector('[data-site-view]');
  const form = box.querySelector('[data-site-form]');
  box.querySelector('[data-site-edit]')?.addEventListener('click', () => {
    if (!form || !view) return;
    view.hidden = true;
    form.hidden = false;
    form.querySelector('input')?.focus();
  });
  box.querySelector('[data-site-cancel]')?.addEventListener('click', () => {
    if (!form || !view) return;
    form.hidden = true;
    view.hidden = false;
  });
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    void save({ siteName: form.querySelector('input')?.value || '' }, `/api/clans/${clanId}/account-invites/site-name`);
  });

  /** PUT, then redraw from the server; true when it saved. */
  async function save(payload, url = `/api/clans/${clanId}/account-invites`) {
    try {
      const r = await fetch(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        notify(t('Save failed: {error}', { error: j.error || r.status }), t('Account invites via chat'));
        return false;
      }
      notify(t('Saved.'), t('Account invites via chat'));
      void loadAccountInvites(root, clanId);
      return true;
    } catch {
      notify(t('Save failed.'), t('Account invites via chat'));
      return false;
    }
  }
}

/** "Codes sent: 34 of 98", or what switching on would do before the first switch-on. */
function welcomeProgressText(p, s) {
  if (!p) return '';
  if (!s.welcomeBacklogAt) {
    return tn(p.backlogDue, '{n} current member without an account would get one first.', '{n} current members without an account would get one first.', { n: p.backlogDue });
  }
  const sent = t('Codes sent: {sent} of {total}', { sent: p.sent, total: p.total });
  const skipped = p.skipped ? ` · ${tn(p.skipped, '{n} could not be sent', '{n} could not be sent', { n: p.skipped })}` : '';
  const paused = s.welcomeMode !== 'on' && p.due ? ` · ${t('paused')}` : '';
  return `${sent}${skipped}${paused}`;
}

/**
 * What became of a sent code: the account now linked to the player (whichever
 * code they used, with when; its name opens that player's profile), else
 * whether the code still works.
 */
function welcomeAccountHtml(w) {
  if (w.account) {
    const when = w.linkedAt ? ` title="${escapeHtml(formatDate(w.linkedAt))}"` : '';
    return `<span class="invite-on invite-account"${when}>✓ ${memberLink(w.memberId, w.account)}</span>`;
  }
  if (w.status !== 'sent') return '';
  const expired = w.codeExpiresAt && Date.parse(w.codeExpiresAt) < Date.now();
  return expired
    ? `<span class="muted-copy">○ ${escapeHtml(t('Code expired'))}</span>`
    : `<span class="muted-copy">– ${escapeHtml(t('Not used yet'))}</span>`;
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
