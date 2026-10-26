// One screenshot, for looking at something the layout check flagged.
//   node .claude/skills/local-ui-check/snap.cjs <page> <lang> <desk|phone> [options]
//     --el <css>      shoot just this element (first visible match)
//     --click <css>   click this first (e.g. #userMenuBtn, #hamburgerBtn)
//     --full          full-page shot
//     --signed-out    no session (login page as a visitor sees it)
// Every <details> is opened first, so collapsed sections are in the shot.
// Saved as <RUN_DIR>/snaps/<page>-<vp>-<lang>[-n].png; the path is printed.
const fs = require('fs');
const path = require('path');
const { RUN_DIR, BASE, pageUrl, launch, newContext, settle } = require('./common.cjs');

const [key, lang = 'en', vpName = 'desk', ...rest] = process.argv.slice(2);
if (!key) throw new Error('usage: snap.cjs <page> <lang> <desk|phone> [--el css] [--click css] [--full] [--signed-out]');
const opt = (name) => { const i = rest.indexOf(name); return i === -1 ? null : rest[i + 1]; };
const el = opt('--el');
const click = opt('--click');

(async () => {
  const outDir = path.join(RUN_DIR, 'snaps');
  fs.mkdirSync(outDir, { recursive: true });
  let out = path.join(outDir, `${key}-${vpName}-${lang}.png`);
  for (let n = 2; fs.existsSync(out); n++) out = path.join(outDir, `${key}-${vpName}-${lang}-${n}.png`);

  const browser = await launch();
  const ctx = await newContext(browser, lang, vpName, { signedIn: !rest.includes('--signed-out') });
  const page = await ctx.newPage();
  await page.goto(BASE + pageUrl(key), { waitUntil: 'networkidle' });
  await settle(page);
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
  if (click) {
    await page.click(click);
    await page.waitForTimeout(500);
  }
  if (el) {
    const target = page.locator(`${el} >> visible=true`).first();
    await target.scrollIntoViewIfNeeded();
    await target.screenshot({ path: out });
  } else {
    await page.screenshot({ path: out, fullPage: rest.includes('--full') });
  }
  await browser.close();
  console.log(out.replace(/\\/g, '/'));
})();
