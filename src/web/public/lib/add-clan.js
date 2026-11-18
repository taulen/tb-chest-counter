// "Add a clan with a code" — the in-app way for a signed-in account to use a
// code from a clan's tracker account (docs/account-invites.md). Same routes
// as /join (/api/join/check, /api/join/redeem), inside the app:
//   1. the code;
//   2. what it will do, before anything happens — add the clan (as which
//      player, with which role) or link this old account to its player — or
//      why it can't be used;
//   3. done: the clan switcher is redrawn, and the dialog offers to switch to
//      the clan now or stay here (redeem is sent with `stay: true`, so staying
//      really stays).
// Opened from the account menu, the clan switcher / phone More sheet
// ("Add a clan", via the tb:add-clan event lib/shell.js fires) and Home's
// line for an unlinked account.

import { t } from './i18n.js';
import { esc, contentModal } from './ui.js';
import { gameRankName } from './game-facts.js';
import { getCurrentUser } from './state.js';
import { refreshClanSwitcher } from './shell.js';

// The server's messages are English; show the known ones translated (join.js
// shows the same ones).
const SERVER_MESSAGES = {
  'This code is not valid or has expired.': () => t('This code is not valid or has expired.'),
  'Too many attempts. Please try again later.': () => t('Too many attempts. Please try again later.'),
  'Your account is already linked to this player.': () => t('Your account is already linked to this player.'),
  'This player is already linked to another account. Ask the superadmin to unlink it.': () => t('This player is already linked to another account. Ask the superadmin to unlink it.'),
  'Your account is already linked to another player in this clan.': () => t('Your account is already linked to another player in this clan.'),
  'Superadmin accounts are not linked to a player.': () => t('Superadmin accounts are not linked to a player.'),
};

/** The server's reason in the viewer's language; never trips on a non-object answer. */
function serverMessage(data, fallback) {
  const msg = data && typeof data === 'object' && typeof data.error === 'string' ? data.error : '';
  return msg ? (SERVER_MESSAGES[msg]?.() ?? msg) : fallback;
}

async function post(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

/** "CWB - ChaosWithoutBorders" → "CWB · ChaosWithoutBorders". */
const clanLabel = (name) => String(name ?? '').replace(' - ', ' · ');
/** " (Officer)", or '' when the rank isn't known. */
const rankSuffix = (rank) => {
  const name = gameRankName(rank);
  return name ? ` (${name})` : '';
};
const roleLine = (role) => (role === 'admin' ? t('Your role there: admin.') : t('Your role there: member.'));

/** Open the dialog. Returns nothing; everything happens inside it. */
export function openAddClanDialog() {
  const modal = contentModal({
    title: t('Add a clan with a code'),
    className: 'add-clan-modal',
    html: '<div class="add-clan" data-add-clan></div>',
  });
  if (!modal) return;
  const box = modal.content.querySelector('[data-add-clan]');
  let code = '';

  const errorHtml = (msg) => (msg ? `<p class="add-clan-error" role="alert">${esc(msg)}</p>` : '');

  function codeStep(error = '') {
    box.innerHTML = `
      <p class="add-clan-lede">${t('Send the word <strong>code</strong> to the clan’s tracker account in the game chat. It answers with a code: enter it here.')}</p>
      <form class="add-clan-form" data-step="code" novalidate>
        <label for="addClanCode">${t('Code')}</label>
        <input type="text" id="addClanCode" class="input add-clan-code" autocomplete="one-time-code" autocapitalize="characters"
          spellcheck="false" maxlength="12" placeholder="ABCD-EFGH" value="${esc(code)}" required>
        ${errorHtml(error)}
        <div class="modal-actions">
          <button type="submit" class="btn btn-primary">${t('Continue')}</button>
        </div>
      </form>`;
    const input = box.querySelector('#addClanCode');
    input.focus();
    box.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      code = input.value.trim();
      if (!code) return codeStep(t('Enter the code from the game chat.'));
      const btn = box.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const r = await post('/api/join/check', { code });
        if (!r.ok || !r.data || typeof r.data !== 'object' || !r.data.mode) {
          return codeStep(serverMessage(r.data, t('This code is not valid or has expired.')));
        }
        previewStep(r.data);
      } catch {
        codeStep(t('Connection failed'));
      }
    });
  }

  /** What the code will do for this account, before anything happens. */
  function previewStep(info, error = '') {
    const clan = clanLabel(info.clan?.name);
    const player = info.player?.name ?? '';
    const rank = rankSuffix(info.player?.rank);
    let what = '';
    let action = '';
    switch (info.mode) {
      case 'add-clan':
        what = `${t('Adds <strong>{clan}</strong> to your account as <strong>{player}</strong>{rank}.', { clan: esc(clan), player: esc(player), rank: esc(rank) })} ${roleLine(info.role)}`;
        action = t('Add clan');
        break;
      case 'link':
        what = `${t('Links your account to <strong>{player}</strong>{rank} in <strong>{clan}</strong>. From now on your role there follows your rank in the game.', { clan: esc(clan), player: esc(player), rank: esc(rank) })} ${roleLine(info.role)}`;
        action = t('Link account');
        break;
      case 'already':
        what = esc(t('Your account is already linked to this player.'));
        break;
      case 'conflict':
        what = esc(t('This player is already linked to another account. Ask the superadmin to unlink it.'));
        break;
      case 'other-player':
        what = esc(t('Your account is already linked to another player in this clan.'));
        break;
      default:
        what = esc(t('Superadmin accounts are not linked to a player.'));
    }
    const refused = !action;
    box.innerHTML = `
      <div class="add-clan-preview${refused ? ' is-refused' : ''}">
        <p class="add-clan-what">${refused ? '<span aria-hidden="true">✕ </span>' : ''}${what}</p>
      </div>
      ${errorHtml(error)}
      <div class="modal-actions">
        <button type="button" class="btn" data-add-clan-back>${t('Use another code')}</button>
        ${action ? `<button type="button" class="btn btn-primary" data-add-clan-confirm>${esc(action)}</button>` : ''}
      </div>`;
    box.querySelector('[data-add-clan-back]').addEventListener('click', () => {
      code = '';
      codeStep();
    });
    const confirm = box.querySelector('[data-add-clan-confirm]');
    if (!confirm) {
      box.querySelector('[data-add-clan-back]').focus();
      return;
    }
    confirm.focus();
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        const r = await post('/api/join/redeem', { code, stay: true });
        if (!r.ok || !r.data || r.data.ok !== true) {
          const msg = serverMessage(r.data, t('That did not work. Try again.'));
          // The code is gone (used, expired, off the roster): start over.
          if (r.status === 404) return codeStep(msg);
          return previewStep(info, msg);
        }
        await doneStep(info, r.data);
      } catch {
        previewStep(info, t('Connection failed'));
      }
    });
  }

  /** Done: redraw the switcher, offer the switch. */
  async function doneStep(info, result) {
    const clan = clanLabel(info.clan?.name);
    const clanId = Number(result.clanId ?? info.clan?.id);
    // The account may only now hold two clans: re-read it so the switcher
    // turns into one, and redraw it with the new clan in the list.
    try {
      const me = await fetch('/api/auth/me', { cache: 'no-store' }).then((res) => (res.ok ? res.json() : null));
      const user = getCurrentUser();
      if (me?.user && user) user.multiClan = !!me.user.multiClan;
      await refreshClanSwitcher(user ?? me?.user ?? null);
    } catch { /* the switcher catches up on the next page load */ }

    const activeId = getCurrentUser()?.activeClan?.id ?? null;
    const canSwitch = Number.isFinite(clanId) && clanId !== activeId;
    const message = result.mode === 'link'
      ? t('Your account is linked to <strong>{player}</strong>.', { player: esc(info.player?.name ?? '') })
      : t('<strong>{clan}</strong> is added to your account.', { clan: esc(clan) });
    box.innerHTML = `
      <div class="add-clan-preview is-done">
        <p class="add-clan-what"><span aria-hidden="true">✓ </span>${message}</p>
      </div>
      <div class="modal-actions">
        ${canSwitch
          ? `<button type="button" class="btn" data-add-clan-stay>${t('Stay here')}</button>
             <button type="button" class="btn btn-primary" data-add-clan-switch>${esc(t('Switch to {clan} now', { clan }))}</button>`
          : `<button type="button" class="btn btn-primary" data-add-clan-stay>${t('Close')}</button>`}
      </div>`;
    box.querySelector('[data-add-clan-stay]').addEventListener('click', () => modal.close());
    const sw = box.querySelector('[data-add-clan-switch]');
    (sw ?? box.querySelector('[data-add-clan-stay]')).focus();
    sw?.addEventListener('click', async () => {
      sw.disabled = true;
      try {
        const res = await fetch(`/api/clans/${clanId}/activate`, { method: 'POST' });
        if (res.ok) {
          window.location.reload();
          return;
        }
      } catch { /* fall through */ }
      sw.disabled = false;
    });
  }

  codeStep();
}
