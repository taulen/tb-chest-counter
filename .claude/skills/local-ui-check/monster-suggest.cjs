// Tools → Monsters as a player uses it: pick type, target and level, press
// "Suggest an army from my battles", wait for the count search, screenshot.
// Needs the account linked and its battles in the local copy
// (research/monster-sim/seed-local-reports.cjs).
//   node .claude/skills/local-ui-check/monster-suggest.cjs <type> "<target>" <level> [lang] [desk|phone]
// Saved as <RUN_DIR>/snaps/monsters-suggest-<target>-<level>-<vp>-<lang>.png; prints the rows.
const fs = require('fs');
const path = require('path');
const { RUN_DIR, BASE, pageUrl, launch, newContext, settle } = require('./common.cjs');

const [type, name, level, lang = 'en', vp = 'desk'] = process.argv.slice(2);
(async () => {
  const outDir = path.join(RUN_DIR, 'snaps');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  const ctx = await newContext(browser, lang, vp, { theme: 'dark' });
  await ctx.addInitScript(() => { try { localStorage.removeItem('tbcc.monsters.draft.v1'); } catch { /* */ } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + pageUrl('monsters'), { waitUntil: 'networkidle' });
  await settle(page);
  await page.selectOption('[data-mon="type"]', type);
  await page.waitForTimeout(300);
  await page.selectOption('[data-mon="family"]', name);
  await page.waitForTimeout(300);
  await page.selectOption('[data-mon="level"]', String(level));
  await page.waitForTimeout(300);
  await page.click('[data-mon-action="suggest"]');
  await page.waitForTimeout(6000);
  const rows = await page.$$eval('.monster-tool .citadel-row:not(.citadel-row-head)', (els) => els.map((el) => {
    const name = el.querySelector('.citadel-troop-name')?.textContent.trim();
    const note = el.querySelector('.citadel-troop-note')?.textContent.trim();
    const count = el.querySelector('[data-field="count"]')?.value;
    return `${count.padStart(7)}  ${name}  (${note})`;
  }));
  const verdicts = await page.$$eval('.citadel-outcome', (els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 160)));
  const waiting = await page.$$eval('.citadel-waiting', (els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
  await page.evaluate(() => document.querySelectorAll('.monster-tool details').forEach((d) => { d.open = d.classList.contains('citadel-log'); }));
  const out = path.join(outDir, `monsters-suggest-${name.replace(/\W+/g, '-')}-${level}-${vp}-${lang}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log(rows.join('\n'));
  console.log(verdicts.join('\n') || waiting.join('\n'));
  if (errors.length) console.log('errors:', errors.join(' | '));
  console.log('→', out);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
