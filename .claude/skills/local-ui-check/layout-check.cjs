// Screenshot pages per language × viewport and measure layout breakage,
// reported relative to English so only what a translation (or a change) adds
// shows up.
//   node .claude/skills/local-ui-check/layout-check.cjs [langs] [pages] [outName]
//   e.g. layout-check.cjs en,de,ru users,members
// Shots + results.json land in <RUN_DIR>/<outName or "check">/.
const fs = require('fs');
const path = require('path');
const { RUN_DIR, BASE, VIEWPORTS, runInfo, pageUrl, allPageKeys, launch, newContext, settle } = require('./common.cjs');

const info = runInfo();
const LANGS = (process.argv[2] || 'en,es,fr,ru,de').split(',');
const PAGE_KEYS = process.argv[3] ? process.argv[3].split(',') : allPageKeys(info);
const outDir = path.join(RUN_DIR, process.argv[4] || 'check');

function measure() {
  const vw = document.documentElement.clientWidth;
  const out = { pageOverflow: Math.max(0, document.documentElement.scrollWidth - vw), clipped: [], spill: [] };
  const describe = (el) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}: ${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 70)}`;
  // Screen-reader-only text and anything inside a closed <details> or a
  // collapsed compact row is invisible: skip it (it was the bulk of the false
  // positives the first time round).
  const invisible = (el) => el.closest('.visually-hidden, details:not([open]) > :not(summary)')
    || el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (invisible(el)) continue;
    const clips = cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis';
    if (clips && el.scrollWidth > el.clientWidth + 2 && !/^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName)) out.clipped.push(describe(el));
    // Text running out of its own (non-clipping) box: it spills over the
    // border and whatever is next to it, and a clipping parent then cuts it.
    // (Inline boxes report clientWidth 0 — skip them.)
    if (!clips && cs.display !== 'inline' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2
      && !/^(TEXTAREA|INPUT|SELECT|TABLE|TBODY|THEAD|TR)$/.test(el.tagName)) out.clipped.push(`${describe(el)} (text overflows its box)`);
    // Past the viewport — unless it sits in a strip built to scroll sideways
    // (.pb-chips, the phone period selector): that's reachable by design.
    const inScroller = (() => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const o = getComputedStyle(a).overflowX;
        if (o === 'auto' || o === 'scroll') return true;
      }
      return false;
    })();
    if (r.right > vw + 2 && cs.position !== 'fixed' && !inScroller) out.spill.push(describe(el));
    // Cut off by a clipping ancestor (the sidebar, a card): the box is still
    // inside the viewport, so neither check above sees it — that is how the
    // Russian next-scan pill slipped through the first pass.
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (acs.overflowX === 'visible') continue;
      if (acs.overflowX === 'auto' || acs.overflowX === 'scroll') break; // scrollable: reachable
      const ar = a.getBoundingClientRect();
      if (r.right > ar.right + 2 || r.left < ar.left - 2) out.clipped.push(`${describe(el)} (cut by ${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''})`);
      break;
    }
  }
  return out;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  const results = {};
  for (const lang of LANGS) {
    for (const vpName of Object.keys(VIEWPORTS)) {
      const ctx = await newContext(browser, lang, vpName);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      for (const key of PAGE_KEYS) {
        const id = `${lang}/${vpName}/${key}`;
        try {
          await page.goto(BASE + pageUrl(key, info), { waitUntil: 'networkidle', timeout: 30000 });
          await settle(page);
          const m = await page.evaluate(measure);
          m.lang = await page.evaluate(() => document.documentElement.lang);
          m.errors = errors.splice(0);
          results[id] = m;
          await page.screenshot({ path: path.join(outDir, `${key}-${vpName}-${lang}.png`) });
        } catch (err) {
          results[id] = { error: String(err) };
        }
      }
      await ctx.close();
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 1));

  let issues = 0;
  for (const [id, r] of Object.entries(results)) {
    const [lang, vp, key] = id.split('/');
    if (r.error) { console.log(`ERR   ${id}: ${r.error.slice(0, 160)}`); issues++; continue; }
    if (r.errors.length) { console.log(`JSERR ${id}: ${r.errors.join(' | ').slice(0, 200)}`); issues++; }
    if (r.lang !== lang) { console.log(`LANG  ${id}: <html lang="${r.lang}">`); issues++; }
    const en = results[`en/${vp}/${key}`] && !results[`en/${vp}/${key}`].error ? results[`en/${vp}/${key}`] : null;
    const base = lang === 'en' || !en ? { clipped: [], spill: [], pageOverflow: 0 } : en;
    const enClipped = new Set(base.clipped);
    const newClipped = r.clipped.filter((c) => !enClipped.has(c));
    const overflow = r.pageOverflow - base.pageOverflow;
    const spill = r.spill.length - base.spill.length;
    if (overflow > 2 || spill > 0 || (lang !== 'en' && newClipped.length)) {
      issues++;
      console.log(`${id}: page overflow ${r.pageOverflow}px (+${overflow}), spill ${r.spill.length} (+${spill}), clipped ${r.clipped.length}${lang === 'en' ? '' : ` (en ${base.clipped.length})`}`);
      newClipped.slice(0, 5).forEach((c) => console.log(`   clip  ${c}`));
      r.spill.slice(0, 4).forEach((c) => console.log(`   spill ${c}`));
    }
  }
  console.log(`${Object.keys(results).length} page loads, ${issues} to look at. Shots: ${outDir.replace(/\\/g, '/')}`);
})();
