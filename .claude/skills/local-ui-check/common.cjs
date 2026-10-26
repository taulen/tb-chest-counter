// Shared bits for the local UI check scripts: where the run lives, the
// session token, the pages, and a logged-in browser context per language.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUN_DIR = process.env.TB_UI_RUN || path.join(os.tmpdir(), 'tb-local-ui');
const PORT = Number(process.env.TB_UI_PORT || 3999);
const BASE = `http://localhost:${PORT}`;

const PAGES = {
  dashboard: '/#dashboard',
  analytics: '/#analytics',
  leaderboard: '/#leaderboard',
  members: '/#members',
  might: '/#might',
  events: '/#events',
  tools: '/#tools',
  triumphal: '/#triumphal',
  resources: '/#resources',
  resadmin: '/#resources/admin',
  sessions: '/#sessions',
  external: '/#external',
  admin: '/#admin',
  users: '/#users',
  clans: '/#clans',
  system: '/#system',
  login: '/login',
};
const VIEWPORTS = { desk: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

function runInfo() {
  const file = path.join(RUN_DIR, 'run.json');
  if (!fs.existsSync(file)) throw new Error(`No prepared run in ${RUN_DIR} — run prep.cjs first.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Page key → URL. `member` and `share` come from the prepared DB. */
function pageUrl(key, info = runInfo()) {
  if (key === 'member') return `/#member/${info.memberId}`;
  if (key === 'share') return `/${info.shareToken}`;
  if (PAGES[key]) return PAGES[key];
  throw new Error(`Unknown page "${key}". Known: ${[...Object.keys(PAGES), 'member', 'share'].join(', ')}`);
}

function allPageKeys(info = runInfo()) {
  return [...Object.keys(PAGES), ...(info.memberId ? ['member'] : []), ...(info.shareToken ? ['share'] : [])];
}

function playwright() {
  // Resolved from the repo (run the scripts from the repo root).
  return require(path.resolve('node_modules/playwright'));
}

/**
 * Playwright's own browser bundle isn't installed on this machine; the system
 * Edge (Chromium) is. TB_UI_BROWSER=chrome / bundled to override.
 */
async function launch() {
  const channel = process.env.TB_UI_BROWSER || 'msedge';
  return playwright().chromium.launch(channel === 'bundled' ? {} : { channel });
}

/**
 * A context signed in as the prepared superadmin, in `lang`. The account's
 * server-side language wins over localStorage (adoptAccountLanguage reloads to
 * it), so it is set first — otherwise switching language between runs loops.
 */
async function newContext(browser, lang, vpName, { signedIn = true, theme = 'dark' } = {}) {
  const info = runInfo();
  const ctx = await browser.newContext({ viewport: VIEWPORTS[vpName], deviceScaleFactor: 1 });
  if (signedIn) {
    await ctx.addCookies([{ name: 'tb_session', value: info.token, url: BASE }]);
    await ctx.request.put(`${BASE}/api/auth/language`, { data: { language: lang } });
  }
  await ctx.addInitScript(([l, th]) => {
    try { localStorage.setItem('lang', l); localStorage.setItem('theme', th); } catch (_) { /* ignore */ }
  }, [lang, theme]);
  return ctx;
}

async function settle(page) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);
}

module.exports = { RUN_DIR, PORT, BASE, PAGES, VIEWPORTS, runInfo, pageUrl, allPageKeys, launch, newContext, settle };
