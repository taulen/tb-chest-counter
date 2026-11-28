// Tools → Monsters with an army loaded: a draft (localStorage) with a target
// and troops with bonuses, then full-page shots per language and viewport,
// strike list opened. Also reports horizontal overflow.
//   node .claude/skills/local-ui-check/monster-shots.cjs [langs] [target name] [level]
// Saved as <RUN_DIR>/snaps/monsters-army-<vp>-<lang>[-light].png.
const fs = require('fs');
const path = require('path');
const { RUN_DIR, BASE, pageUrl, launch, newContext, settle } = require('./common.cjs');

const [langsArg = 'en,ru', name = 'Rare Elf squad', levelArg = '20'] = process.argv.slice(2);
const DRAFT = {
  target: { name, level: Number(levelArg), variant: 0 },
  rows: [
    { unitId: '206', count: 0, strengthPct: 3936.75, healthPct: 2794.75, cap: 400 },
    { unitId: '191', count: 0, strengthPct: 3736.5, healthPct: 2794.75, cap: 40 },
    { unitId: '214', count: 0, strengthPct: 3736.5, healthPct: 2794.75, cap: 300 },
    { unitId: '36', count: 0, strengthPct: 3636.5, healthPct: 2694.75, cap: 5000 },
  ],
  countMode: process.env.MODE === 'manual' ? 'manual' : 'auto',
  eventPct: null,
  bonusesAt: new Date().toISOString(),
  bonusesNote: 'your 3 battles of the last week',
  decimalComma: false,
};
// Manual (MODE=manual): every troop sent at its cap.
if (DRAFT.countMode === 'manual') for (const r of DRAFT.rows) r.count = r.cap;
const TAG = process.env.TAG ? `-${process.env.TAG}` : '';

(async () => {
  const outDir = path.join(RUN_DIR, 'snaps');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  for (const lang of langsArg.split(',')) {
    for (const vp of ['desk', 'phone']) {
      for (const theme of ['dark', 'light']) {
        const ctx = await newContext(browser, lang, vp, { theme });
        await ctx.request.put(`${BASE}/api/auth/theme`, { data: { theme: theme === 'dark' ? 'oled' : 'light' } }).catch(() => {});
        await ctx.addInitScript((d) => { try { localStorage.setItem('tbcc.monsters.draft.v1', d); } catch { /* */ } }, JSON.stringify(DRAFT));
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(BASE + pageUrl('monsters'), { waitUntil: 'networkidle' });
        await settle(page);
        await page.waitForTimeout(3500); // the count search runs 350 ms after load, up to 2.5 s
        await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
        await page.waitForTimeout(300);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        const out = path.join(outDir, `monsters-army${TAG}-${vp}-${lang}${theme === 'light' ? '-light' : ''}.png`);
        await page.screenshot({ path: out, fullPage: true });
        console.log(`${lang} ${vp} ${theme}: overflow ${over}px${errors.length ? `, errors: ${errors.join(' | ')}` : ''} → ${out}`);
        await ctx.close();
      }
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
