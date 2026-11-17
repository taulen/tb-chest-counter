// Clans → "In-game chat digest": the daily digest posted into one of the clan's
// in-game group chats by its scanner account (scheduler/chat-digest.ts).
// Loaded when the section is opened; saving never posts; the test post is
// queued for the clan's next scan and uses the day's one message.

import { escapeHtml, notify, confirmDialog, formatDate } from '../lib/ui.js';
import { t, LANGUAGES } from '../lib/i18n.js';

/** The collapsed section on the clan card. */
export function chatDigestSectionHtml(clanId) {
  return `
        <hr class="section-divider">
        <details class="clan-subsection" id="clan-chat-digest-details-${clanId}">
        <summary class="clan-subsection-summary"><h3>${t('In-game chat digest')}</h3></summary>
        <div class="mt-12" id="clan-chat-digest-${clanId}"><p class="muted-copy">${t('Loading…')}</p></div>
        </details>`;
}

/** Load the section the first time it is opened (the element is fresh every render, so nothing stacks). */
export function attachChatDigest(root, clanId) {
  const details = root.querySelector(`#clan-chat-digest-details-${clanId}`);
  if (!details) return;
  details.addEventListener('toggle', () => {
    if (details.open) void loadChatDigest(root, clanId);
  });
}

async function loadChatDigest(root, clanId) {
  const box = root.querySelector(`#clan-chat-digest-${clanId}`);
  if (!box) return;
  try {
    const r = await fetch(`/api/clans/${clanId}/chat-digest`);
    if (!r.ok) throw new Error(String(r.status));
    renderChatDigest(root, box, clanId, await r.json());
  } catch {
    box.innerHTML = `<p class="warning-text">${t('Could not load the chat digest settings.')}</p>`;
  }
}

function blockerText(b) {
  if (!b) return '';
  if (b.code === 'posted') return t("Today's message has gone out.");
  if (b.code === 'maybe-posted') return t("Today's message may already have gone out, so it is never sent again.");
  if (b.code === 'gave-up') return t('Posting failed twice for this day; it is not tried again.');
  if (b.code === 'other-today') return t('A message already went out today (the {date} digest).', { date: b.otherDay || '' });
  return '';
}

function coverageText(c) {
  if (!c || c.ok) return '';
  if (c.code === 'waiting') return t("Waiting for the day's closing scan.");
  if (c.code === 'no-scan-before') return t('Not posting: there was no scan before the day began, so it may be incomplete.');
  if (c.code === 'gap') return t('Not posting: a {hours} h gap between scans that day, so it may be incomplete.', { hours: (c.maxGapMs / 3600000).toFixed(1) });
  return '';
}

function statusLabel(status) {
  if (status === 'sent') return t('Posted');
  if (status === 'failed') return t('Failed');
  if (status === 'unknown') return t('Unknown — not resent');
  return t('Sending');
}

function renderChatDigest(root, box, clanId, data) {
  const s = data.settings;
  const channels = data.channels || [];
  const selectedUrl = s.channelUrl || channels.find((c) => c.name === s.channelName)?.url || '';
  const chosenName = s.channelName || '';
  const p = data.preview;
  const blocked = blockerText(p.blocked);
  const coverage = coverageText(p.coverage);
  const canTest = !data.sendingDisabled && data.targetFound && !p.blocked && !!p.text;
  const testWhy = data.sendingDisabled ? t('Chat sending is switched off on this server.')
    : !data.targetFound ? t('Pick a group chat the scanner account is in first.')
      : p.blocked ? blocked
        : !p.text ? t('Nothing was collected that day.') : '';

  box.innerHTML = `
    <p class="muted-copy mb-8">${t("Posts the daily digest into one of the clan's in-game group chats, as the clan's scanner account: the same “Daily Digest — Our top 20 crypters” message the leaders post by hand. <strong>At most one message a day</strong>, never split, never into the clan chat, the kingdom chat or a private chat.")}</p>
    ${data.sendingDisabled ? `<p class="warning-text mb-8">⚠ ${t('Chat sending is switched off on this server (CHAT_SEND_DISABLED): nothing is posted.')}</p>` : ''}
    <p class="muted-copy mb-8">${s.posterName
      ? t('Posts as <strong>{name}</strong>, the account that scans this clan.', { name: escapeHtml(s.posterName) })
      : t("The scanner account and its group chats are read at the clan's next scan.")}</p>
    ${chosenName && !data.targetFound && s.channelsCheckedAt ? `<p class="warning-text mb-8">⚠ ${t('{account} is not a member of “{chat}”. Add the account to that chat in the game, or pick another.', { account: escapeHtml(s.posterName || t('The scanner account')), chat: escapeHtml(chosenName) })}</p>` : ''}
    <div class="inline-form-row">
      <label class="checkbox-row"><input type="checkbox" id="clan-chat-digest-enabled-${clanId}" ${s.enabled ? 'checked' : ''}> ${t('Post the daily digest')}</label>
    </div>
    <div class="inline-form-row mt-8">
      <div class="form-row-grow"><label for="clan-chat-digest-channel-${clanId}">${t('Group chat')}</label>
        <select id="clan-chat-digest-channel-${clanId}" class="input">
          <option value="">${channels.length ? t('— pick a chat —') : t('No group chats read yet')}</option>
          ${channels.map((c) => `<option value="${escapeHtml(c.url)}" ${c.url === selectedUrl ? 'selected' : ''}>${escapeHtml(c.name)} (${c.memberCount})</option>`).join('')}
        </select>
      </div>
      <div><label for="clan-chat-digest-entries-${clanId}">${t('Entries')}</label>
        <input id="clan-chat-digest-entries-${clanId}" class="input" type="number" min="${data.limits.entriesMin}" max="${data.limits.entriesMax}" step="1" value="${s.entries}"></div>
      <div><label for="clan-chat-digest-language-${clanId}">${t('Language of the post')}</label>
        <select id="clan-chat-digest-language-${clanId}" class="input">
          ${LANGUAGES.map((l) => `<option value="${escapeHtml(l.code)}" ${l.code === (s.language || 'en') ? 'selected' : ''}>${escapeHtml(l.label)}</option>`).join('')}
        </select></div>
      <button class="btn btn-primary" type="button" data-chat-digest-save>${t('Save')}</button>
    </div>
    <p class="muted-copy mt-4 hint-text">${t("Only the clan's named group chats the scanner account is in are listed. The post goes out with the first scan after the daily reset, once the game day has closed; saving never posts.")}</p>
    <h4 class="mt-12">${t('Preview — {date}', { date: escapeHtml(p.gameDate) })}</h4>
    ${p.text
      ? `<pre class="chat-digest-preview">${escapeHtml(p.text)}</pre>
         <p class="muted-copy hint-text">${t('{chars} of {max} characters · {shown} entries', { chars: p.chars, max: p.maxChars, shown: p.shown })}</p>`
      : `<p class="muted-copy">${t('Nothing was collected that day.')}</p>`}
    ${blocked ? `<p class="muted-copy mt-4">${escapeHtml(blocked)}</p>` : ''}
    ${coverage ? `<p class="warning-text mt-4">${escapeHtml(coverage)}</p>` : ''}
    <div class="actions mt-8">
      <button class="btn" type="button" data-chat-digest-test ${canTest ? '' : 'disabled'} title="${escapeHtml(testWhy)}">${t('Send test post now')}</button>
      ${canTest ? '' : `<span class="muted-copy hint-text">${escapeHtml(testWhy)}</span>`}
    </div>
    ${(data.recent || []).length ? `
    <div class="table-wrap mt-12">
      <table class="data-table chat-digest-posts">
        <thead><tr><th scope="col">${t('Day')}</th><th scope="col">${t('Group chat')}</th><th scope="col">${t('Status')}</th><th scope="col">${t('Updated')}</th></tr></thead>
        <tbody>
          ${data.recent.map((r) => `<tr>
            <td>${escapeHtml(r.gameDate)}${r.trigger === 'test' ? ` <span class="muted-copy">(${t('test')})</span>` : ''}</td>
            <td>${escapeHtml(r.channelName)}</td>
            <td title="${escapeHtml(r.error || '')}">${statusLabel(r.status)}</td>
            <td>${escapeHtml(formatDate(r.updatedAt))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}
  `;

  box.querySelector('[data-chat-digest-save]')?.addEventListener('click', async () => {
    const body = {
      enabled: !!box.querySelector(`#clan-chat-digest-enabled-${clanId}`)?.checked,
      channelUrl: box.querySelector(`#clan-chat-digest-channel-${clanId}`)?.value || null,
      entries: Number.parseInt(box.querySelector(`#clan-chat-digest-entries-${clanId}`)?.value || '', 10),
      language: box.querySelector(`#clan-chat-digest-language-${clanId}`)?.value || 'en',
    };
    try {
      const r = await fetch(`/api/clans/${clanId}/chat-digest`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        notify(t('Save failed: {error}', { error: j.error || r.status }), t('In-game chat digest'));
        return;
      }
      notify(t('Saved.'), t('In-game chat digest'));
      void loadChatDigest(root, clanId);
    } catch {
      notify(t('Save failed.'), t('In-game chat digest'));
    }
  });

  box.querySelector('[data-chat-digest-test]')?.addEventListener('click', async () => {
    const chat = channels.find((c) => c.url === selectedUrl)?.name || chosenName;
    const ok = await confirmDialog(
      t("Post the {date} digest to “{chat}”? It goes out with this clan's next scan and uses today's one message — the scheduled post will not go out again today.", { date: p.gameDate, chat }),
      { title: t('Send test post'), confirmLabel: t('Send test post now') },
    );
    if (!ok) return;
    try {
      const r = await fetch(`/api/clans/${clanId}/chat-digest/test`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      notify(r.ok
        ? t('Queued: it goes out with the next scan of this clan. Start a scan from the Dashboard to send it now.')
        : t('Not queued: {error}', { error: j.error || r.status }), t('In-game chat digest'));
      void loadChatDigest(root, clanId);
    } catch {
      notify(t('Not queued.'), t('In-game chat digest'));
    }
  });
}
