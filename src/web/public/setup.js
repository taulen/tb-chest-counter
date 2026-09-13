import {
  loginBridgePanelHTML,
  startLoginSession,
  bindLoginBridgeActions,
} from './lib/login-bridge.js';
import { bindThemeSwitcher } from './lib/theme.js';

const $ = (sel) => document.querySelector(sel);

let setupState = 'form'; // 'form' | 'auth-check'
let loginRedirectScheduled = false;
let bridgeMounted = false;

function showMessage(text, tone) {
  const box = $('#setupMessage');
  if (!box) return;
  box.classList.remove('is-hidden', 'ok', 'error');
  box.classList.add(tone === 'ok' ? 'ok' : 'error');
  box.textContent = text;
}

function setBusy(busy) {
  const btn = $('#submitBtn');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? 'Saving Setup...' : 'Complete Setup';
}

/**
 * Move to the Total Battle step, and close the door behind us.
 *
 * Once /api/setup/complete has succeeded the superadmin exists and app.env is
 * written, so BOTH of the things above this point are now dead ends the server
 * answers with a 409: re-submitting the form ("Setup is already complete") and
 * restoring a backup (needsSetup() is false). Leaving either reachable is how
 * an operator ends up staring at an error on a step they already finished —
 * which is exactly what the Go Back button used to do, and what any reload
 * did, since this page rendered the form unconditionally on load.
 */
function showAuthScreen() {
  const form = $('#setupForm');
  const restoreForm = $('#restoreForm');
  const modeSwitch = $('.setup-mode-switch');
  const authScreen = $('#authScreen');
  if (form) form.classList.add('is-hidden');
  if (restoreForm) restoreForm.classList.add('is-hidden');
  if (modeSwitch) modeSwitch.classList.add('is-hidden');
  if (authScreen) authScreen.classList.remove('is-hidden');
  setupState = 'auth-check';
  mountLoginBridge();
  checkTbAuthStatus();
}

/**
 * Inject the shared bridge panel into the auth screen on first show
 * and wire up its action buttons. The bridge itself stays hidden until
 * the operator clicks "Log in to Total Battle".
 */
function mountLoginBridge() {
  if (bridgeMounted) return;
  const mount = $('#loginBridgeMount');
  if (!mount) return;
  mount.innerHTML = loginBridgePanelHTML({ modal: true });
  bindLoginBridgeActions(mount);
  bridgeMounted = true;
}

async function launchTbLoginBridge() {
  const btn = $('#launchBridgeBtn');
  if (btn) btn.disabled = true;
  try {
    await startLoginSession(1, {
      onSaved: async (saveResult) => {
        const hasTbAuth = saveResult && saveResult.hasTbAuth !== false;
        if (!hasTbAuth) {
          showMessage('Session saved but no Total Battle auth was detected. Sign in fully and try again.', 'error');
          if (btn) btn.disabled = false;
          return;
        }
        showMessage('Total Battle session saved. Finishing setup…', 'ok');
        await completeSetup();
      },
    });
  } catch (err) {
    showMessage(String(err && err.message ? err.message : err), 'error');
    if (btn) btn.disabled = false;
  }
}

async function completeSetup() {
  try {
    const res = await fetch('/api/setup/auth-saved', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      showMessage(data.error || 'Could not finalize setup.', 'error');
      const btn = $('#launchBridgeBtn');
      if (btn) btn.disabled = false;
      return;
    }
    showMessage('Setup complete. Redirecting to the dashboard so you can calibrate the scanner…', 'ok');
    scheduleLoginRedirect();
  } catch {
    showMessage('Error finalizing setup.', 'error');
    const btn = $('#launchBridgeBtn');
    if (btn) btn.disabled = false;
  }
}

function scheduleLoginRedirect() {
  if (loginRedirectScheduled) return;
  loginRedirectScheduled = true;
  // Brief pause so the user sees the success message, then go. The
  // boot-time awaiter in src/index.ts is already resolving and the
  // container is swapping setup-mode → normal-mode; by the time the
  // redirect lands /login is being served.
  setTimeout(() => {
    window.location.assign('/login');
  }, 1500);
}

async function checkTbAuthStatus() {
  const statusEl = $('#tbAuthStatus');
  if (!statusEl) return;

  try {
    const res = await fetch('/api/setup/auth-status');
    const data = await res.json();

    if (data.authenticated) {
      statusEl.innerHTML = '<div style="color: #7ee2a8;">✓ Total Battle session already saved. You can re-run the bridge to refresh it, or continue.</div>';
      return;
    }

    statusEl.innerHTML = '<div style="color: #ffc1ad;">⏳ No Total Battle session yet. Click <strong>Log in to Total Battle</strong> below to open the in-page browser and sign in.</div>';
  } catch {
    statusEl.innerHTML = '<div style="color: #ffadad;">Could not check auth status.</div>';
  }
}

// Only the account is asked for. DB path, web port and scan interval are
// server-side defaults (SETUP_DEFAULTS) — /api/setup/complete fills in every
// field this omits, and all three are editable from the System page once the
// app is up, so putting them in front of a first-time operator only invited a
// typo into a path that has to be right.
function buildPayload() {
  return {
    adminUsername: $('#adminUsername').value,
    adminPassword: $('#adminPassword').value,
  };
}

/**
 * Base64 the picked file in chunks. A whole-buffer
 * String.fromCharCode(...bytes) blows the argument limit somewhere around a
 * megabyte, and a backup is three orders of magnitude past that.
 */
async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function setRestoreBusy(busy, label) {
  const btn = $('#restoreBtn');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? (label || 'Restoring…') : 'Restore and finish';
}

/**
 * Adopt an existing install's database instead of creating an account. On
 * success the setup flow is over server-side (app.env written, the awaiter
 * resolved, the container swapping to the normal server), so this goes to
 * /login rather than the Total Battle step — the accounts came from the
 * backup, and per-clan game sign-in happens from the Clans page.
 */
async function submitRestore(event) {
  event.preventDefault();
  const input = $('#restoreFile');
  const file = input && input.files && input.files[0];
  if (!file) {
    showMessage('Choose a .db or .db.gz backup file first.', 'error');
    return;
  }

  setRestoreBusy(true, 'Reading file…');
  try {
    const contentBase64 = await fileToBase64(file);
    setRestoreBusy(true, 'Restoring…');
    const res = await fetch('/api/setup/restore-backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, contentBase64 }),
    });
    const data = await res.json();
    if (!res.ok) {
      showMessage(data.error || 'Restore failed.', 'error');
      setRestoreBusy(false);
      return;
    }
    showMessage(
      `Restored ${data.users} user account${data.users === 1 ? '' : 's'} (${data.superadmins} superadmin${data.superadmins === 1 ? '' : 's'}). Sign in with your existing credentials…`,
      'ok',
    );
    scheduleLoginRedirect();
  } catch {
    showMessage('Unexpected error while restoring the backup.', 'error');
    setRestoreBusy(false);
  }
}

/** Swap between the "new install" form and the restore form. */
function setSetupMode(mode) {
  const isRestore = mode === 'restore';
  $('#setupForm')?.classList.toggle('is-hidden', isRestore);
  $('#restoreForm')?.classList.toggle('is-hidden', !isRestore);
  document.querySelectorAll('[data-action="set-setup-mode"]').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const box = $('#setupMessage');
  if (box) box.classList.add('is-hidden');
}

async function submitSetup(event) {
  event.preventDefault();
  const form = $('#setupForm');
  if (!form.reportValidity()) return;

  setBusy(true);
  try {
    const res = await fetch('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload()),
    });

    const data = await res.json();
    if (res.status === 409) {
      // The account already exists — this process has done the form step.
      // Carry on to where the operator actually is rather than reporting a
      // failure for work that succeeded.
      showMessage('That account is already set up. Continuing to the Total Battle sign-in…', 'ok');
      showAuthScreen();
      return;
    }
    if (!res.ok) {
      showMessage(data.error || 'Setup failed.', 'error');
      return;
    }

    showMessage(
      'Dashboard setup complete! Now let\'s authenticate with Total Battle.',
      'ok'
    );
    showAuthScreen();
  } catch {
    showMessage('Unexpected error while saving setup.', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * Decide which screen to show on load instead of always showing the form.
 *
 * /api/setup/auth-status answers 200 only once the form step is done in this
 * process, so it doubles as "which step am I on". Without this, every reload
 * of /setup after completing the form dropped the operator back on a form
 * whose submit button can only answer 409 — the page's own state was the only
 * record that the step had happened.
 */
async function bootstrapState() {
  try {
    const res = await fetch('/api/setup/auth-status');
    if (res.ok) showAuthScreen();
  } catch {
    // Offline or mid-restart: leave the form up, which is the safe default.
  }
}

$('#setupForm')?.addEventListener('submit', submitSetup);
$('#restoreForm')?.addEventListener('submit', submitRestore);
document.querySelectorAll('[data-action="set-setup-mode"]').forEach((btn) => {
  btn.addEventListener('click', () => setSetupMode(btn.dataset.mode));
});
$('#launchBridgeBtn')?.addEventListener('click', launchTbLoginBridge);
$('#recheckAuthBtn')?.addEventListener('click', checkTbAuthStatus);

// Theme picker (top-right of the card). bindThemeSwitcher syncs the active
// pill to the current theme and delegates clicks to applyTheme, which
// caches the choice in localStorage so it carries into the app afterward.
bindThemeSwitcher(document);

bootstrapState();
