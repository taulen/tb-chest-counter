/**
 * Step 4 of the resource-history A/B rig: explain every "shares no rows with the previous
 * page" warning. Replays stitchPage's own decision loop and prints, for each candidate
 * overlap, how many rows matched against how many were needed — so a warning resolves into
 * one of three things: the scroll really skipped rows, the rows were there but OCR read a
 * name differently, or the two reads disagreed about the DATE.
 *
 *   node scripts/resource-sweep-read.mjs data/exports/run_<stamp> rows.jsonl
 *   node scripts/resource-stitch-failures.mjs rows.jsonl
 *
 * The date printed against each row is what cracked it the first time: 10 of the 12
 * warnings on one 269-page sweep were the same rows dated one day apart.
 *
 * NOTE this file carries its OWN copy of the alignment rules, deliberately, so it can
 * compare the shipped rule against a candidate one. Re-sync them after changing
 * resource-history-capture.ts or the output will quietly describe the wrong code.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const cap = require(path.resolve('dist/browser/resource-history-capture.js'));
const { stitchPage, dedupeNearbyRepeats, rowFingerprint, sweepRowKey, looseSweepKey } = cap;

const slugIds = new Map();
const idFor = (s) => { if (s == null) return null; if (!slugIds.has(s)) slugIds.set(s, slugIds.size + 1); return slugIds.get(s); };

// verbatim from resource-history-capture.ts
const rowsAlign = (a, b) => {
  if (sweepRowKey(a) === sweepRowKey(b)) return true;
  const oneIsUnresolved = a.resourceTypeId == null || b.resourceTypeId == null;
  return oneIsUnresolved && looseSweepKey(a) === looseSweepKey(b);
};
const requiredMatches = (o) => (o <= 4 ? o : Math.max(4, Math.ceil(o * 0.6)));

const raw = fs.readFileSync(process.argv[2] ?? 'tmp-cur.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const byPage = new Map();
for (const r of raw) {
  if (r.page.includes('-firstpage')) continue;
  if (!byPage.has(r.page)) byPage.set(r.page, []);
  byPage.get(r.page).push(r);
}
const pages = [...byPage.keys()].sort();
const toRows = (n) => byPage.get(n).map((r) => ({
  memberId: null, resourceTypeId: idFor(r.slug), direction: r.dir, amount: r.amount,
  transactionDate: r.date, rawPlayerName: r.name, rowCropPath: null,
})).map((row) => ({ ...row, fingerprint: rowFingerprint(row) }));

const lbl = (r) => `${r.rawPlayerName}${r.direction > 0 ? '+' : '-'}${r.amount}`
  + `/${r.resourceTypeId ?? 'x'} [${r.transactionDate.slice(5)}]`;

let stitched = [];
const failures = [];
pages.forEach((p, pi) => {
  const pageRows = toRows(p);
  const st = stitchPage(stitched, pageRows);
  if (st.overlap === 0 && pi > 0) failures.push({ pi, page: p, acc: stitched.slice(), pageRows });
  stitched = dedupeNearbyRepeats(st.rows).rows;
});

let bestWasClose = 0, bestWasNothing = 0;
for (const f of failures) {
  const { acc, pageRows } = f;
  const maxOverlap = Math.min(acc.length, pageRows.length);
  const scored = [];
  for (let o = maxOverlap; o >= 1; o--) {
    let m = 0;
    for (let i = 0; i < o; i++) if (rowsAlign(acc[acc.length - o + i], pageRows[i])) m++;
    scored.push({ o, m, need: requiredMatches(o), short: requiredMatches(o) - m });
  }
  const best = scored.reduce((a, b) => (b.m > a.m || (b.m === a.m && b.short < a.short) ? b : a));
  const closest = scored.reduce((a, b) => (b.short < a.short ? b : a));
  console.log(`\n=== page ${f.pi + 1} (${f.page.slice(0, 4)}): ${pageRows.length} rows ===`);
  console.log(`  best candidate  : overlap ${best.o}, matched ${best.m}/${best.need}`);
  console.log(`  closest to pass : overlap ${closest.o}, matched ${closest.m}/${closest.need} (short by ${closest.short})`);
  if (best.m === 0) {
    bestWasNothing++;
    console.log(`  -> not one row of this page aligns anywhere in the accumulated tail.`);
  } else {
    bestWasClose++;
    const o = best.o;
    console.log(`  -> rows DO align. The window at overlap ${o}:`);
    for (let i = 0; i < Math.min(o, 14); i++) {
      const a = acc[acc.length - o + i], b = pageRows[i];
      console.log(`     ${rowsAlign(a, b) ? 'ok  ' : 'MISS'} acc:${lbl(a).padEnd(34)} page:${lbl(b)}`);
    }
  }
}

console.log(`\n=== verdict over ${failures.length} failures ===`);
console.log(`  best candidate matched NOTHING (real skip)      : ${bestWasNothing}`);
console.log(`  rows aligned but not enough of them (threshold) : ${bestWasClose}`);
