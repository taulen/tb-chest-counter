// Tools → Citadel's count search: its progress bar, then the result. A draft
// (localStorage) with the user's cards at a citadel, in Auto.
//   1. Frozen bar: lib/battle-worker.js is answered by a stand-in that reports
//      one progress step (42%, "Improving the best army…") and never finishes,
//      so the shot is not a race against a search that takes under a second.
//   2. The real search: the real worker, the time it took, its URL (it must
//      carry /v/<build>/), overflow and page errors, and a shot of the result.
//   node .claude/skills/local-ui-check/citadel-progress.cjs [langs] [citadelId]
// Saved as <RUN_DIR>/snaps/citadel-progress-<vp>-<lang>[-light].png and …-done-….
const fs = require('fs');
const path = require('path');
const { RUN_DIR, BASE, pageUrl, launch, newContext, settle } = require('./common.cjs');

const [langsArg = 'en,ru', citadelId = 'elven-30'] = process.argv.slice(2);
const CARDS = [['siege-ballistae-7', 2277, 1616.75], ['corax-1', 5226.5, 3936.75], ['fire-phoenix-1', 3736.5, 2794.75], ['royal-lion-1', 3736.5, 2794.75], ['griffin-7', 5326.5, 4036.75], ['vulture-7', 3636.5, 2694.75]];
const DRAFT = {
  citadelId,
  rows: CARDS.map(([troopId, strengthPct, healthPct]) => ({ troopId, count: 0, strengthPct, healthPct })),
  countMode: 'auto',
  bonusesAt: null,
  bonusesFrom: null,
  bonusesReport: null,
  decimalComma: false,
};
const FROZEN_WORKER = "self.onmessage = (e) => { self.postMessage({ id: e.data.id, type: 'progress', done: 42, total: 100, phase: 'improve' }); };";

async function open(browser, lang, vp, theme, { frozen }) {
  const ctx = await newContext(browser, lang, vp, { theme });
  await ctx.request.put(`${BASE}/api/auth/theme`, { data: { theme: theme === 'dark' ? 'oled' : 'light' } }).catch(() => {});
  await ctx.addInitScript((d) => { try { localStorage.setItem('tbcc.citadel.draft.v1', d); } catch { /* */ } }, JSON.stringify(DRAFT));
  if (frozen) await ctx.route('**/lib/battle-worker.js', (route) => route.fulfill({ contentType: 'text/javascript', body: FROZEN_WORKER }));
  const page = await ctx.newPage();
  const errors = [];
  const workers = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('worker', (w) => workers.push(w.url()));
  // The learned starting points (data/army-starts.json) must load from the versioned path too.
  page.on('requestfinished', (r) => { if (r.url().includes('army-starts.json')) workers.push(`starts ${r.url().replace(BASE, '')}`); });
  page.on('requestfailed', (r) => { if (r.url().includes('army-starts.json')) errors.push(`starts failed ${r.url()}`); });
  return { ctx, page, errors, workers };
}

(async () => {
  const outDir = path.join(RUN_DIR, 'snaps');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  for (const lang of langsArg.split(',')) {
    for (const vp of ['desk', 'phone']) {
      for (const theme of ['dark', 'light']) {
        const tag = `${vp}-${lang}${theme === 'light' ? '-light' : ''}`;
        // 1. The bar, held still.
        {
          const { ctx, page, errors } = await open(browser, lang, vp, theme, { frozen: true });
          await page.goto(BASE + pageUrl('citadel'), { waitUntil: 'networkidle' });
          await settle(page);
          await page.waitForFunction(() => Number(document.querySelector('.search-progress')?.getAttribute('aria-valuenow')) === 42, null, { timeout: 15000 })
            .catch(() => errors.push('progress bar never reached the stand-in worker\'s 42%'));
          await page.evaluate(() => document.querySelector('.search-progress')?.scrollIntoView({ block: 'center' }));
          const words = await page.evaluate(() => document.querySelector('.search-progress-text')?.textContent ?? '');
          const out = path.join(outDir, `citadel-progress-${tag}.png`);
          await page.screenshot({ path: out });
          console.log(`${lang} ${vp} ${theme}: bar "${words}"${errors.length ? `; errors: ${errors.join(' | ')}` : ''} → ${out}`);
          await ctx.close();
        }
        // 2. The real search.
        {
          const { ctx, page, errors, workers } = await open(browser, lang, vp, theme, { frozen: false });
          const t0 = Date.now();
          await page.goto(BASE + pageUrl('citadel'), { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('.search-progress', { timeout: 15000 }).catch(() => {});
          await page.waitForSelector('.search-progress', { state: 'detached', timeout: 120000 }).catch(() => errors.push('search never finished'));
          const took = ((Date.now() - t0) / 1000).toFixed(1);
          await settle(page);
          const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          const out = path.join(outDir, `citadel-progress-done-${tag}.png`);
          await page.screenshot({ path: out, fullPage: true });
          console.log(`  loaded + searched in ~${took}s; worker: ${workers.join(', ') || 'none'}; overflow ${over}px${errors.length ? `; errors: ${errors.join(' | ')}` : ''} → ${out}`);
          await ctx.close();
        }
      }
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
