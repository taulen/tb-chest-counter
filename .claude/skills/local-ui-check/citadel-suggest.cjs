// Tools → Citadel's "Suggest troops for my levels": the account's levels set
// (default G6 · S5 · M5 · E6 — the levels are saved per account, so this
// writes them to the run copy), an empty army at a citadel, the button
// pressed, the search(es) waited out, a full-page shot. Reports the rows kept,
// overflow and page errors.
//   node .claude/skills/local-ui-check/citadel-suggest.cjs [langs] [citadelId] [g,s,m,e]
// Saved as <RUN_DIR>/snaps/citadel-suggest-<vp>-<lang>[-light].png.
const fs = require('fs');
const path = require('path');
const { RUN_DIR, BASE, pageUrl, launch, newContext, settle } = require('./common.cjs');

const [langsArg = 'en,ru', citadelId = 'elven-25', levelsArg = '6,5,5,6'] = process.argv.slice(2);
const [g, s, m, e] = levelsArg.split(',').map(Number);
const DRAFT = { citadelId, rows: [], countMode: 'auto', bonusesAt: null, bonusesFrom: null, bonusesReport: null, decimalComma: false };

(async () => {
  const outDir = path.join(RUN_DIR, 'snaps');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  for (const lang of langsArg.split(',')) {
    for (const vp of ['desk', 'phone']) {
      for (const theme of ['dark', 'light']) {
        const ctx = await newContext(browser, lang, vp, { theme });
        await ctx.request.put(`${BASE}/api/auth/theme`, { data: { theme: theme === 'dark' ? 'oled' : 'light' } }).catch(() => {});
        await ctx.request.put(`${BASE}/api/tools/citadel-levels`, { data: { g, s, m, e, span: 2 } }).catch(() => {});
        await ctx.addInitScript((d) => { try { localStorage.setItem('tbcc.citadel.draft.v1', d); } catch { /* */ } }, JSON.stringify(DRAFT));
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (er) => errors.push(String(er)));
        page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
        await page.goto(BASE + pageUrl('citadel'), { waitUntil: 'networkidle' });
        await settle(page);
        const t0 = Date.now();
        await page.click('[data-cit-action="suggest"]');
        // Searches until nothing is pending and no suggestion waits: the rows stop changing.
        let last = '';
        for (let i = 0; i < 120; i++) {
          await page.waitForTimeout(500);
          const now = await page.evaluate(() => `${document.querySelectorAll('.citadel-row[data-row]').length}|${!!document.querySelector('.search-progress')}`);
          if (now === last && now.endsWith('|false')) break;
          last = now;
        }
        const took = ((Date.now() - t0) / 1000).toFixed(1);
        const rows = await page.evaluate(() => [...document.querySelectorAll('.citadel-row[data-row]')].map((r) => `${r.querySelector('.citadel-troop-name')?.textContent} ${r.querySelector('[data-field="count"]')?.value}`));
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        const out = path.join(outDir, `citadel-suggest-${vp}-${lang}${theme === 'light' ? '-light' : ''}.png`);
        await page.screenshot({ path: out, fullPage: true });
        console.log(`${lang} ${vp} ${theme}: ${took}s, ${rows.length} rows: ${rows.join(', ')}; overflow ${over}px${errors.length ? `; errors: ${errors.join(' | ')}` : ''} → ${out}`);
        await ctx.close();
      }
    }
  }
  await browser.close();
})().catch((er) => { console.error(er); process.exit(1); });
