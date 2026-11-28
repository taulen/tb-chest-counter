// "Your levels" (lib/troop-levels.js) for a linked account, on Tools → Citadel
// (or Stacks): the game's levels with the player select, after a level is
// changed (the reset button), and the other player (not read yet). Needs the
// account linked in its active clan, with research on record (the run copy
// has none from before Nov 17 2026 — seed it). Prints each state's levels.
//   node .claude/skills/local-ui-check/levels-card.cjs [langs] [page: citadel|stacks]
// Saved as <RUN_DIR>/snaps/levels-<page>-<state>-<vp>-<lang>.png.
const fs = require('fs');
const path = require('path');
const { RUN_DIR, BASE, pageUrl, launch, newContext, settle } = require('./common.cjs');

const [langsArg = 'en,ru', pageKey = 'citadel'] = process.argv.slice(2);

(async () => {
  const outDir = path.join(RUN_DIR, 'snaps');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  for (const lang of langsArg.split(',')) {
    for (const vp of ['desk', 'phone']) {
      const ctx = await newContext(browser, lang, vp, { theme: 'dark' });
      await ctx.request.put(`${BASE}/api/auth/theme`, { data: { theme: 'oled' } }).catch(() => {});
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (er) => errors.push(String(er)));
      page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
      await page.goto(BASE + pageUrl(pageKey), { waitUntil: 'networkidle' });
      await settle(page);
      const card = page.locator('.citadel-levels').first();
      const levels = () => page.evaluate(() => [...document.querySelectorAll('[data-level-kind]')].map((s) => `${s.dataset.levelKind}=${s.value || 'any'}`).join(' '));
      const shot = async (state) => {
        const out = path.join(outDir, `levels-${pageKey}-${state}-${vp}-${lang}.png`);
        await card.screenshot({ path: out });
        console.log(`${lang} ${vp} ${state}: ${await levels()} → ${out}`);
      };
      await shot('game');
      await page.selectOption('[data-level-kind="g"]', '6');
      await page.waitForTimeout(400);
      await shot('changed');
      if (await page.locator('[data-level-player]').count()) {
        const other = await page.$eval('[data-level-player]', (s) => [...s.options].find((o) => !o.selected)?.value);
        if (other) { await page.selectOption('[data-level-player]', other); await page.waitForTimeout(800); await shot('other-player'); }
      }
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (errors.length || over > 0) console.log(`  overflow ${over}px; errors: ${errors.join(' | ')}`);
      await ctx.close();
    }
  }
  await browser.close();
})().catch((er) => { console.error(er); process.exit(1); });
