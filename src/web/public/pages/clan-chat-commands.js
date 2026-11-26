// Clans → "Chat commands": members message the clan's scanner account one
// word in the game ("me", "top", …) and get their numbers back in that chat
// (scheduler/chat-commands.ts, docs/chat-commands.md). Off by default; loaded
// when its tab (Clans → In-game) is shown. Built like "Account invites via chat" (its styles):
// one line on what it is, the switch as a row that saves on change, the
// commands, the fine print folded into "How it works", then recent commands.

import { escapeHtml, notify, formatDate, memberLink } from '../lib/ui.js';
import { t, tn } from '../lib/i18n.js';
import { gameRankName } from '../lib/game-facts.js';

/** The section on the clan card's In-game tab. */
export function chatCommandsSectionHtml(clanId) {
  return `
        <section class="clan-section" id="clan-chat-commands-details-${clanId}">
        <h3 class="clan-section-title">${t('Chat commands')}</h3>
        <div class="mt-12" id="clan-chat-commands-${clanId}"><p class="muted-copy">${t('Loading…')}</p></div>
        </section>`;
}

/** Load the section when its tab is shown (the element is fresh every render, so nothing stacks). */
export function attachChatCommands(root, clanId) {
  const section = root.querySelector(`#clan-chat-commands-details-${clanId}`);
  // Only while its tab is on screen: a hidden tab panel loads nothing.
  if (section && !section.closest('[hidden]')) void loadChatCommands(root, clanId);
}

async function loadChatCommands(root, clanId) {
  const box = root.querySelector(`#clan-chat-commands-${clanId}`);
  if (!box) return;
  try {
    const r = await fetch(`/api/clans/${clanId}/chat-commands`);
    if (!r.ok) throw new Error(String(r.status));
    renderChatCommands(root, box, clanId, await r.json());
  } catch {
    box.innerHTML = `<p class="warning-text">${t('Could not load the chat command settings.')}</p>`;
  }
}

/** What each command answers. */
function commandDescription(command) {
  switch (command) {
    case 'me': return t('Your week: rank, points, chests, today, the goal, last week, might, guards and Gold Pass');
    case 'points': return t('This week’s points, rank and the goal');
    case 'chests': return t('This week’s chests');
    case 'top': return t('The clan’s top 10 this week');
    case 'progress': return t('The last 4 weeks against the goal');
    case 'events': return t('Events running now and coming up');
    case 'missing': return t('Who is behind pace this week (only {leader} and {superior})', { leader: gameRankName(1), superior: gameRankName(2) });
    case 'help': return t('The list of commands');
    default: return '';
  }
}

/** A command's outcome, glyph + words. */
function statusText(status, reason, limits) {
  if (status === 'sent') return `✓ ${t('Answered')}`;
  if (status === 'pending' || status === 'sending') return `◐ ${t('Waiting to send')}`;
  if (status === 'unknown') return `? ${t('May have been sent (not resent)')}`;
  if (status === 'failed') return `✕ ${t('Could not be sent')}`;
  const why = {
    'not-member': t('not on the roster'),
    'no-player': t('not a player'),
    'chat-account-mismatch': t('chat account does not match the player'),
    channel: t('not a private chat with the scanner'),
    'sending-disabled': t('sending is off on this server'),
    'too-old': t('too old'),
    disabled: t('commands were switched off'),
    repeat: tn(limits?.repeatMinutes ?? 10, 'asked again within {n} minute', 'asked again within {n} minutes', { n: limits?.repeatMinutes ?? 10 }),
    'player-limit': t('over the hourly limit for one member'),
    'group-off': t('answering in the group chat is off'),
  }[reason] || reason || '';
  return `– ${t('Not answered')}${why ? ` (${escapeHtml(why)})` : ''}`;
}

function renderChatCommands(root, box, clanId, data) {
  const s = data.settings;
  const limits = data.limits || {};
  const switchId = `clan-chat-commands-enabled-${clanId}`;

  const notices = [
    data.sendingDisabled ? t('Chat sending is switched off on this server (CHAT_SEND_DISABLED): nothing is answered.') : '',
    data.chatPause ? t('The game muted the scanner account’s chat at {at}. Nothing is sent until {until}; replies wait until then.', {
      at: data.chatPause.mutedAt ? formatDate(new Date(data.chatPause.mutedAt).toISOString()) : '—',
      until: formatDate(new Date(data.chatPause.until).toISOString()),
    }) : '',
  ].filter(Boolean);

  const state = s.enabled && s.enabledAt
    ? `<span class="invite-on">✓ ${t('On since {date}', { date: escapeHtml(formatDate(new Date(s.enabledAt).toISOString())) })}</span>`
    : `<span class="invite-off">○ ${t('Off')}</span>`;
  const sent = tn(data.sentLastDay || 0, '{n} reply in the last 24 hours', '{n} replies in the last 24 hours', { n: data.sentLastDay || 0 });

  const switchRow = `<div class="invite-setting">
      <div class="invite-setting-text">
        <div class="invite-setting-title"><label for="${switchId}">${t('Answer chat commands')}</label></div>
        <div class="invite-setting-desc">${t('Replies go only to the member who asked, in their private chat with the scanner account.')}</div>
        <div class="invite-setting-state">${state} · ${escapeHtml(sent)}</div>
      </div>
      <div class="invite-setting-control"><input type="checkbox" role="switch" class="invite-switch" id="${switchId}" ${s.enabled ? 'checked' : ''}></div>
    </div>`;

  // Also answer in the chat digest's group chat (CWB • Carter), for everyone there.
  const groupId = `clan-chat-commands-group-${clanId}`;
  const groupName = data.groupChat?.name || '';
  const groupState = !data.groupChat
    ? `<span class="invite-off">○ ${t('No group chat is picked under In-game chat digest yet.')}</span>`
    : s.groupEnabled && s.groupEnabledAt
      ? `<span class="invite-on">✓ ${t('On since {date}', { date: escapeHtml(formatDate(new Date(s.groupEnabledAt).toISOString())) })}</span>`
      : `<span class="invite-off">○ ${t('Off')}</span>`;
  const groupRow = `<div class="invite-setting">
      <div class="invite-setting-text">
        <div class="invite-setting-title"><label for="${groupId}">${groupName
          ? t('Also answer in {chat}', { chat: escapeHtml(groupName) })
          : t('Also answer in the digest’s group chat')}</label></div>
        <div class="invite-setting-desc">${t('Commands written in the group chat the daily digest goes to are answered there, for everyone in it. Never in any other chat.')}</div>
        <div class="invite-setting-state">${groupState}</div>
        ${s.enabled ? '' : `<div class="invite-setting-note">${t('Only while chat commands are on.')}</div>`}
      </div>
      <div class="invite-setting-control"><input type="checkbox" role="switch" class="invite-switch" id="${groupId}" ${s.groupEnabled ? 'checked' : ''} ${data.groupChat ? '' : 'disabled'}></div>
    </div>`;

  const commands = [...(data.commands || []), 'help', ...(data.leaderCommands || [])];
  const list = `<ul class="chat-cmd-list">
      ${commands.map((c) => `<li><code translate="no">${escapeHtml(c)}</code><span>${escapeHtml(commandDescription(c))}</span></li>`).join('')}
    </ul>`;

  const how = `<details class="invite-how">
      <summary>${t('How it works')}</summary>
      <ul>
        <li>${t('Only members on the roster get an answer. A message that isn’t a command gets no reply.')}</li>
        <li>${t('The words work in any language. A reply comes in the member’s site language, else the chat digest’s; “puntos”, “очки”, “Punkte”… work too and answer in that language.')}</li>
        <li>${escapeHtml(t('So the game doesn’t mute the scanner account: at most {perRun} replies a minute and {clanPerHour} an hour for the clan, {playerPerHour} an hour for one member, and the same command again within {minutes} minutes gets nothing.', {
          perRun: limits.perRun ?? 3, clanPerHour: limits.clanPerHour ?? 30, playerPerHour: limits.playerPerHour ?? 10, minutes: limits.repeatMinutes ?? 10,
        }))}</li>
        <li>${escapeHtml(t('In the group chat: one reply a minute and {groupPerHour} an hour, and top, events, help or missing asked again by anyone within {minutes} minutes gets nothing — the answer is right above.', {
          groupPerHour: limits.groupPerHour ?? 12, minutes: limits.repeatMinutes ?? 10,
        }))}</li>
        <li>${t('Every reply is one message, never longer than the chat allows: long lists end with “… and N more”.')}</li>
        <li>${t('Replies go out within a minute while the scanner keeps the game session of its last scan. After a server restart, the first command scans the clan to get one (at most every 10 minutes).')}</li>
      </ul>
    </details>`;

  const recent = (data.recent || []).length ? `
    <h4 class="invite-subhead">${t('Recent commands')}</h4>
    <div class="table-wrap">
      <table class="data-table chat-cmd-requests">
        <thead><tr><th scope="col">${t('Asked')}</th><th scope="col">${t('Player')}</th><th scope="col">${t('Command')}</th><th scope="col">${t('Status')}</th></tr></thead>
        <tbody>
          ${data.recent.map((r) => `<tr>
            <td>${escapeHtml(formatDate(new Date(r.requestedAt).toISOString()))}</td>
            <td>${r.player ? memberLink(r.memberId, r.player) : `<span class="muted-copy">${t('Unknown')}</span>`}</td>
            <td><code translate="no">${escapeHtml(r.command)}</code></td>
            <td>${statusText(r.status, r.reason, limits)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  box.innerHTML = `
    <div class="invite-panel">
      <p class="invite-lede">${data.scannerPlayer
        ? t('Members message the scanner account, {name}, one word in the game and get their numbers back in that chat.', { name: `<strong>${escapeHtml(data.scannerPlayer)}</strong>` })
        : t('Members message the scanner account one word in the game and get their numbers back in that chat.')}</p>
      ${notices.map((n) => `<p class="invite-notice">⚠ ${escapeHtml(n)}</p>`).join('')}
      <div class="invite-settings">${switchRow}${groupRow}</div>
      ${list}
      ${how}
      ${recent}
    </div>`;

  // Each switch saves on change; a failed save puts it back.
  const wire = (id, key) => {
    const sw = box.querySelector(`#${id}`);
    sw?.addEventListener('change', async () => {
      try {
        const r = await fetch(`/api/clans/${clanId}/chat-commands`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: sw.checked }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          sw.checked = !sw.checked;
          notify(t('Save failed: {error}', { error: j.error || r.status }), t('Chat commands'));
          return;
        }
        notify(t('Saved.'), t('Chat commands'));
        void loadChatCommands(root, clanId);
      } catch {
        sw.checked = !sw.checked;
        notify(t('Save failed.'), t('Chat commands'));
      }
    });
  };
  wire(switchId, 'enabled');
  wire(groupId, 'groupEnabled');
}
