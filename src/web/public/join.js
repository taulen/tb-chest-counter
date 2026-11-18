// /join — enter the code the clan's scanner account sent in the game chat
// (docs/account-invites.md). Step 1 checks the code; step 2 shows what it does
// for this visitor and asks only for what that needs:
//   new        → choose a username and password (a new account)
//   recover    → choose a new password (the player's account exists)
//   link       → link the signed-in (old) account to the player
//   add-clan   → add the code's clan to the signed-in account
// and explains the cases where it can't be used.

import { t, bindLanguageSwitcher } from './lib/i18n.js';
import { esc } from './lib/ui.js';
import { wireCodeInput } from './lib/code-input.js';
import { gameRankName } from './lib/game-facts.js';

bindLanguageSwitcher(document, { syncServer: false });

// The server's messages are English; show the known ones translated.
const SERVER_MESSAGES = {
  'This code is not valid or has expired.': t('This code is not valid or has expired.'),
  'Too many attempts. Please try again later.': t('Too many attempts. Please try again later.'),
  'Your account is already linked to this player.': t('Your account is already linked to this player.'),
  'This player is already linked to another account. Ask the superadmin to unlink it.': t('This player is already linked to another account. Ask the superadmin to unlink it.'),
  'This player is linked to a superadmin account; its password cannot be reset with a code.': t('This player is linked to a superadmin account; its password cannot be reset with a code.'),
  'Username already exists': t('That username is taken. Pick another.'),
  'Username must be at least 3 characters': t('Username must be at least 3 characters'),
  'Username must be 32 characters or fewer': t('Username must be 32 characters or fewer'),
  'Username can only contain letters, numbers, dot, underscore, and dash': t('Username can only contain letters, numbers, dot, underscore, and dash'),
  'Password must be at least 10 characters': t('Password must be at least 10 characters'),
  'Password must include at least one uppercase letter': t('Password must include at least one uppercase letter'),
  'Password must include at least one lowercase letter': t('Password must include at least one lowercase letter'),
  'Password must include at least one number': t('Password must include at least one number'),
  'Password must include at least one symbol': t('Password must include at least one symbol'),
};

const body = document.getElementById('joinBody');
const errEl = document.getElementById('error');
const footer = document.getElementById('joinFooter');
let code = '';

function showError(message) {
  errEl.textContent = message;
  errEl.style.display = message ? 'block' : 'none';
}

function serverError(data, fallback) {
  return SERVER_MESSAGES[data?.error] || data?.error || fallback;
}

async function post(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Step 1: the code. */
function renderCodeStep() {
  footer.hidden = false;
  body.innerHTML = `
    <ol class="join-steps">
      <li>${t('In the game, open a private chat with the account that tracks your clan (your leaders know which one) and send the word <strong>code</strong>.')}</li>
      <li>${t('It answers in that chat with a code, usually within a few minutes.')}</li>
      <li>${t('Enter the code below. It works once, within the time its message gives.')}</li>
    </ol>
    <form id="codeForm" novalidate>
      <label for="code">${t('Code')}</label>
      <input type="text" id="code" class="input join-code" autocomplete="one-time-code" autocapitalize="characters"
        spellcheck="false" maxlength="20" placeholder="ABCD-EFGH" value="${esc(code)}" required>
      <button type="submit" class="btn">${t('Continue')}</button>
    </form>`;
  const input = document.getElementById('code');
  wireCodeInput(input);
  input.focus();
  document.getElementById('codeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    code = input.value.trim();
    if (!code) {
      showError(t('Enter the code from the game chat.'));
      input.focus();
      return;
    }
    await checkCode();
  });
}

async function checkCode() {
  showError('');
  try {
    const r = await post('/api/join/check', { code });
    if (!r.ok) {
      showError(serverError(r.data, t('This code is not valid or has expired.')));
      renderCodeStep();
      return;
    }
    renderAction(r.data);
  } catch {
    showError(t('Connection failed'));
  }
}

function roleWords(role) {
  return role === 'admin'
    ? t('You will be an admin of this clan on the site: your in-game rank runs the clan.')
    : t('You will be a member of this clan on the site.');
}

function passwordFields() {
  return `
    <label for="password">${t('Password')}</label>
    <input type="password" id="password" class="input" autocomplete="new-password" required>
    <label for="password2">${t('Repeat password')}</label>
    <input type="password" id="password2" class="input" autocomplete="new-password" required>
    <p class="join-hint">${t('At least 10 characters, with an uppercase and a lowercase letter, a number and a symbol.')}</p>`;
}

/** Step 2: what this code does for this visitor. */
function renderAction(info) {
  const rank = gameRankName(info.player.rank);
  const who = `<p class="join-player"><span class="join-player-name">${esc(info.player.name)}</span>${rank ? ` <span class="join-player-rank">${esc(rank)}</span>` : ''}</p>
    <p class="join-clan">${esc(info.clan.name)}</p>`;
  const signedIn = info.viewer
    ? `<p class="join-signed-in">${t('Signed in as <strong>{name}</strong>.', { name: esc(info.viewer.username) })}
        <button type="button" class="join-link-btn" id="signOut">${t('Not you? Sign out')}</button></p>`
    : '';
  let form = '';
  let note = '';
  switch (info.mode) {
    case 'new':
      form = `
        <label for="username">${t('Username')}</label>
        <input type="text" id="username" class="input" autocomplete="username" spellcheck="false" maxlength="32" value="${esc(info.suggestedUsername || '')}" required>
        ${passwordFields()}
        <button type="submit" class="btn">${t('Create account')}</button>`;
      note = roleWords(info.role);
      break;
    case 'recover':
      note = t('This player already has an account: <strong>{name}</strong>. Choose a new password to sign in.', { name: esc(info.username || '') });
      form = `${passwordFields()}<button type="submit" class="btn">${t('Set password and sign in')}</button>`;
      break;
    case 'link':
      note = `${t('Link your account to this player. From now on your role here follows your rank in the game.')} ${roleWords(info.role)}`;
      form = `<button type="submit" class="btn">${t('Link account')}</button>`;
      break;
    case 'add-clan':
      note = `${t('Add this clan to your account. You switch between your clans at the top of the site.')} ${roleWords(info.role)}`;
      form = `<button type="submit" class="btn">${t('Add clan')}</button>`;
      break;
    case 'already':
      note = t('Your account is already linked to this player.');
      form = '<a class="btn join-btn-link" href="/">' + t('Go to the site') + '</a>';
      break;
    case 'conflict':
      note = t('This player is already linked to another account. Ask the superadmin to unlink it.');
      break;
    case 'add-player':
      note = `${t('Add this player to your account, beside the player you already have in this clan.')} ${roleWords(info.role)}`;
      form = `<button type="submit" class="btn">${t('Add player')}</button>`;
      break;
    case 'link-player':
      note = t('Link this player to your account. Your superadmin access does not change.');
      form = `<button type="submit" class="btn">${t('Link player')}</button>`;
      break;
    case 'superadmin-recover':
      note = t('This player is linked to a superadmin account; its password cannot be reset with a code.');
      break;
    default:
      note = t('This code can’t be used here.');
  }
  footer.hidden = !!info.viewer;
  body.innerHTML = `
    <section class="join-summary" aria-label="${esc(t('The code is for'))}">${who}</section>
    ${signedIn}
    <p class="join-note">${note}</p>
    ${form ? `<form id="actionForm" novalidate>${form}</form>` : ''}
    <button type="button" class="join-link-btn join-back" id="back">${t('Use another code')}</button>`;

  document.getElementById('back').addEventListener('click', () => {
    code = '';
    showError('');
    renderCodeStep();
  });
  document.getElementById('signOut')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: { Accept: 'application/json' } }).catch(() => {});
    await checkCode();
  });
  const formEl = document.getElementById('actionForm');
  if (!formEl || info.mode === 'already') return;
  formEl.querySelector('input')?.focus();
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const payload = { code };
    if (info.mode === 'new') payload.username = document.getElementById('username').value.trim();
    if (info.mode === 'new' || info.mode === 'recover') {
      const p1 = document.getElementById('password').value;
      const p2 = document.getElementById('password2').value;
      if (p1 !== p2) {
        showError(t('The passwords do not match.'));
        document.getElementById('password2').focus();
        return;
      }
      payload.password = p1;
    }
    const submit = formEl.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const r = await post('/api/join/redeem', payload);
      if (!r.ok) {
        showError(serverError(r.data, t('That did not work. Try again.')));
        if (r.status === 404) renderCodeStep();
        return;
      }
      window.location.href = '/';
    } catch {
      showError(t('Connection failed'));
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

renderCodeStep();
