// Find content sitting flush against the edge of the card (or panel) it is in:
// a filter bar touching a card's side, a tile row butting into the header line.
// Two of these shipped back to back in Nov 2026, both from content put in an
// unpadded `.card-body` (which is unpadded on purpose, so tables run full-bleed).
//   node .claude/skills/local-ui-check/padding-check.cjs [pages] [viewports]
//   e.g. padding-check.cjs resadmin,admin desk
// English only: padding doesn't depend on the language. Every <details> is
// opened first, so collapsed cards are checked too. Shots of flagged pages go to
// <RUN_DIR>/padding/.
const fs = require('fs');
const path = require('path');
const { RUN_DIR, BASE, VIEWPORTS, runInfo, pageUrl, allPageKeys, launch, newContext, settle } = require('./common.cjs');

const info = runInfo();
const PAGE_KEYS = process.argv[2] ? process.argv[2].split(',') : allPageKeys(info).filter((k) => k !== 'login');
const VPS = process.argv[3] ? process.argv[3].split(',') : Object.keys(VIEWPORTS);
const outDir = path.join(RUN_DIR, 'padding');

function measure() {
  const MIN_X = 8;   // px of breathing room expected from a side
  const MIN_Y = 6;   // and from the top / bottom
  const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const px = (v) => parseFloat(v) || 0;
  const invisible = (el) => el.closest('.visually-hidden, [hidden]')
    || el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false;
  const label = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '') + (el.id ? '#' + el.id : '');
  };
  const effectiveBg = (el) => {
    for (let a = el; a; a = a.parentElement) {
      const bg = getComputedStyle(a).backgroundColor;
      if (!transparent(bg)) return bg;
    }
    return '';
  };
  const hasSideBorders = (cs) => ['Left', 'Right'].every((s) => px(cs[`border${s}Width`]) > 0 && !transparent(cs[`border${s}Color`]));
  const FORM = /^(INPUT|SELECT|TEXTAREA|BUTTON|IMG|CANVAS|svg|SVG)$/;
  const TABLEISH = /^(TABLE|THEAD|TBODY|TFOOT|TR|TH|TD|COLGROUP|COL|CAPTION)$/;
  // Panels whose items sit 4px in on purpose: a segmented control's pills and
  // the Might picker's highlighted rows.
  const DESIGNED_INSET = '.resources-tabs, .might-pick-list';
  // Between the element and its panel, a strip that actually scrolls sideways
  // (the phone timeframe buttons): its overflow is reachable, not a fault.
  const inScrollStrip = (el, panel) => {
    for (let a = el.parentElement; a && a !== panel; a = a.parentElement) {
      const o = getComputedStyle(a).overflowX;
      if ((o === 'auto' || o === 'scroll') && a.scrollWidth > a.clientWidth + 1) return true;
    }
    return false;
  };

  // A panel draws an edge: a card, a card body, or any sizeable block with its
  // own side borders or a background of its own.
  const isPanel = (el) => {
    if (el.matches('.card, .card-body, .card-body-padded')) return true;
    if (FORM.test(el.tagName) || TABLEISH.test(el.tagName) || el.matches('a, summary, .card-header, .btn')) return false;
    const cs = getComputedStyle(el);
    if (!/^(block|flex|grid|flow-root)$/.test(cs.display)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 160 || r.height < 40) return false;
    const ownBg = !transparent(cs.backgroundColor) && cs.backgroundColor !== effectiveBg(el.parentElement);
    return hasSideBorders(cs) || ownBg;
  };
  const panelOf = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (isPanel(a)) return a;
    return null;
  };
  const innerBox = (p) => {
    const r = p.getBoundingClientRect();
    const cs = getComputedStyle(p);
    return {
      L: r.left + px(cs.borderLeftWidth), R: r.right - px(cs.borderRightWidth),
      T: r.top + px(cs.borderTopWidth), B: r.bottom - px(cs.borderBottomWidth),
    };
  };
  // Glyph box of an element's own text, not its block box: a centred or padded
  // label is judged by where its letters actually are.
  const textBox = (el) => {
    let box = null;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const rr of range.getClientRects()) {
        if (!rr.width || !rr.height) continue;
        box = box
          ? { left: Math.min(box.left, rr.left), right: Math.max(box.right, rr.right), top: Math.min(box.top, rr.top), bottom: Math.max(box.bottom, rr.bottom) }
          : { left: rr.left, right: rr.right, top: rr.top, bottom: rr.bottom };
      }
    }
    return box;
  };

  const found = new Map();
  for (const el of document.querySelectorAll('main *, #content *, .content *')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    if (/^(OPTION|SCRIPT|STYLE|BR|HR|COL)$/.test(el.tagName)) continue;
    if (el.matches('.card-header, .card-body, .card-body-padded, summary')) continue;
    if (invisible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'absolute' || cs.position === 'fixed') continue;
    const panel = panelOf(el);
    if (!panel) continue;
    if (panel.matches(DESIGNED_INSET) || inScrollStrip(el, panel)) continue;
    // Clipped with an ellipsis on purpose (full text in a title); layout-check
    // reports clipping, and the glyph box of hidden text says nothing here.
    if (cs.textOverflow === 'ellipsis') continue;

    let box = null;
    let kind = '';
    const tb = textBox(el);
    if (FORM.test(el.tagName)) { box = el.getBoundingClientRect(); kind = 'control'; }
    else if (!TABLEISH.test(el.tagName) && !isPanel(el) && (hasSideBorders(cs)
      || (!transparent(cs.backgroundColor) && cs.backgroundColor !== effectiveBg(el.parentElement)))) {
      box = el.getBoundingClientRect(); kind = 'box';
    } else if (tb) { box = tb; kind = 'text'; }
    else if (isPanel(el) && !el.matches('.card, .card-body, .card-body-padded')) { box = el.getBoundingClientRect(); kind = 'panel'; }
    if (!box || !(box.right - box.left) || !(box.bottom - box.top)) continue;

    const P = innerBox(panel);
    const w = box.right - box.left;
    // Full-bleed bands (a table's header row, a divider, a table itself) span
    // the panel on purpose; only text or a control touching an edge is a fault there.
    if (kind !== 'text' && kind !== 'control' && w >= (P.R - P.L) - 2) continue;
    // A table cell's text is inset by the cell; the panel edge isn't its edge.
    if (kind === 'text' && el.closest('td, th') && panel.contains(el.closest('table'))) continue;

    const dl = box.left - P.L, dr = P.R - box.right, dt = box.top - P.T, db = P.B - box.bottom;
    const edges = [];
    if (dl > -2 && dl < MIN_X) edges.push(`left ${Math.round(dl)}`);
    if (dr > -2 && dr < MIN_X) edges.push(`right ${Math.round(dr)}`);
    // Vertical only inside panels that aren't scroll strips of rows.
    if (dt > -2 && dt < MIN_Y) edges.push(`top ${Math.round(dt)}`);
    if (db > -2 && db < MIN_Y) edges.push(`bottom ${Math.round(db)}`);
    if (!edges.length) continue;

    const key = `${label(el)} in ${label(panel)} [${edges.map((e) => e.split(' ')[0]).join(',')}]`;
    const prev = found.get(key);
    if (prev) { prev.count++; continue; }
    const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    found.set(key, { key, kind, edges: edges.join(', '), text, count: 1 });
  }
  return [...found.values()];
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  const results = {};
  for (const vpName of VPS) {
    const ctx = await newContext(browser, 'en', vpName);
    const page = await ctx.newPage();
    for (const key of PAGE_KEYS) {
      const id = `${vpName}/${key}`;
      try {
        await page.goto(BASE + pageUrl(key, info), { waitUntil: 'networkidle', timeout: 30000 });
        await settle(page);
        // Open every collapsed card so its content is laid out and measured.
        await page.evaluate(() => document.querySelectorAll('details:not([open])').forEach((d) => { d.open = true; }));
        await page.waitForTimeout(800);
        results[id] = await page.evaluate(measure);
        if (results[id].length) await page.screenshot({ path: path.join(outDir, `${key}-${vpName}.png`), fullPage: true });
      } catch (err) {
        results[id] = { error: String(err) };
      }
    }
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 1));
  let n = 0;
  for (const [id, list] of Object.entries(results)) {
    if (list.error) { console.log(`ERR ${id}: ${list.error.slice(0, 160)}`); continue; }
    if (!list.length) continue;
    console.log(`${id}:`);
    for (const f of list) {
      n++;
      console.log(`   ${f.kind.padEnd(7)} ${f.key}${f.count > 1 ? ` ×${f.count}` : ''}  (${f.edges}px)  "${f.text}"`);
    }
  }
  console.log(`${Object.keys(results).length} page loads, ${n} flush element group(s). Full-page shots of flagged pages: ${outDir.replace(/\\/g, '/')}`);
})();
