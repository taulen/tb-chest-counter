// Dump Tools → Monsters' saved draft (localStorage) after a suggestion, for running the search in Node.
//   node .claude/skills/local-ui-check/monster-draft.cjs <type> "<target>" <level> <out.json>
const fs = require('fs');
const { BASE, pageUrl, launch, newContext, settle } = require('./common.cjs');
const [type, name, level, out] = process.argv.slice(2);
(async () => {
  const browser = await launch();
  const ctx = await newContext(browser, 'en', 'desk', { theme: 'dark' });
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('seen')) { localStorage.removeItem('tbcc.monsters.draft.v1'); sessionStorage.setItem('seen', '1'); } } catch { /* */ } });
  const page = await ctx.newPage();
  await page.goto(BASE + pageUrl('monsters'), { waitUntil: 'networkidle' });
  await settle(page);
  await page.selectOption('[data-mon="type"]', type);
  await page.selectOption('[data-mon="family"]', name);
  await page.selectOption('[data-mon="level"]', String(level));
  await page.click('[data-mon-action="suggest"]');
  await page.waitForTimeout(6000);
  fs.writeFileSync(out, await page.evaluate(() => localStorage.getItem('tbcc.monsters.draft.v1')));
  console.log('draft →', out);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
