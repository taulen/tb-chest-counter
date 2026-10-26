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
