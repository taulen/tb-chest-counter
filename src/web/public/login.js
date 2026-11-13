import { t, bindLanguageSwitcher } from './lib/i18n.js';

// No account yet, so no server sync: the choice is kept in this browser and
// adopted by the account on sign-in (adoptAccountLanguage in app.js).
bindLanguageSwitcher(document, { syncServer: false });

// The server's messages are English; show the known ones translated.
const SERVER_MESSAGES = {
  'Invalid username or password': t('Invalid username or password'),
  'Username and password required': t('Username and password required'),
  'Too many authentication attempts. Please try again later.': t('Too many authentication attempts. Please try again later.'),
};

// Public boards: one link per clan that shares its leaderboard. Best-effort —
// on any failure (or no clan sharing) the section simply stays hidden.
async function loadPublicBoards() {
  try {
    const res = await fetch('/api/public/boards');
    if (!res.ok) return;
    const { boards } = await res.json();
    if (!Array.isArray(boards) || boards.length === 0) return;
    const list = document.getElementById('publicBoardsList');
    for (const b of boards) {
      // The server builds these, but only ever follow a web address or a path.
      if (typeof b?.url !== 'string' || !/^(https?:\/\/|\/)/.test(b.url)) continue;
      const a = document.createElement('a');
      a.href = b.url;
      const name = document.createElement('span');
      name.className = 'login-boards-name';
      name.textContent = String(b.name ?? '');
      const arrow = document.createElement('span');
      arrow.className = 'login-boards-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '→';
      a.append(name, arrow);
      const li = document.createElement('li');
      li.append(a);
      list.append(li);
    }
    if (list.children.length > 0) document.getElementById('publicBoards').hidden = false;
  } catch {
    // Stay hidden.
  }
}
loadPublicBoards();

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('error');
  errEl.style.display = 'none';

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = SERVER_MESSAGES[data.error] || data.error || t('Login failed');
      errEl.style.display = 'block';
      return;
    }
    window.location.href = '/';
  } catch {
    errEl.textContent = t('Connection failed');
    errEl.style.display = 'block';
  }
});
