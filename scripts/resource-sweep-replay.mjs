/**
 * Step 3 of the resource-history A/B rig: replay whole sweeps through the REAL stitch /
 * dedupe / collapse code, so the comparison is what would land in the DATABASE rather
 * than a per-page rate. Reports rows written, unknowns, zero-overlap pages and the summed
 * amount, and diffs the written rows when given two runs.
 *
 *   node scripts/resource-sweep-replay.mjs before before.jsonl after after.jsonl
 *
 * Validated against production: replaying the 269-page sweep of 2026-07-31 reproduces its
 * logged 2,048 rows / 31 unknown / 12 zero-overlap pages.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const cap = require(path.resolve('dist/browser/resource-history-capture.js'));
const { stitchPage, dedupeNearbyRepeats, collapseUnresolvedTwins, rowFingerprint, looseSweepKey } = cap;

const slugIds = new Map();
const idFor = (slug) => {
  if (slug == null) return null;
  if (!slugIds.has(slug)) slugIds.set(slug, slugIds.size + 1);
  return slugIds.get(slug);
};

function replay(label, file) {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const byPage = new Map();
  for (const r of rows) {
    if (r.page.includes('-firstpage')) continue;   // the sweep OCRs one crop per page
    if (!byPage.has(r.page)) byPage.set(r.page, []);
    byPage.get(r.page).push(r);
  }
  const pages = [...byPage.keys()].sort();

  let stitched = [];
  const maxPerKey = new Map();
  let zeroOverlap = 0, dedupeDropped = 0;

  for (const p of pages) {
    const pageRows = byPage.get(p).map((r) => ({
      memberId: null,
      resourceTypeId: idFor(r.slug),
      direction: r.dir,
      amount: r.amount,
      transactionDate: r.date,
      rawPlayerName: r.name,
      rowCropPath: null,
    })).map((row) => ({ ...row, fingerprint: rowFingerprint(row) }));

    const seen = new Map();
    for (const row of pageRows) {
      const k = looseSweepKey(row);
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const [k, c] of seen) if (c > (maxPerKey.get(k) ?? 0)) maxPerKey.set(k, c);

    const st = stitchPage(stitched, pageRows);
    stitched = st.rows;
    if (st.overlap === 0) zeroOverlap++;
    const dd = dedupeNearbyRepeats(stitched);
    dedupeDropped += dd.dropped;
    stitched = dd.rows;
  }

  const col = collapseUnresolvedTwins(stitched, maxPerKey);
  const final = col.rows;
  const unresolved = final.filter((r) => r.resourceTypeId == null).length;
  const total = final.reduce((a, r) => a + r.amount, 0);

  console.log(`\n=== ${label} (${pages.length} pages) ===`);
  console.log(`  rows written              : ${final.length}`);
  console.log(`  unresolved (unknown)      : ${unresolved} (${(unresolved / final.length * 100).toFixed(2)}%)`);
  console.log(`  pages sharing no rows     : ${zeroOverlap}`);
  console.log(`  dropped by adjacent dedupe: ${dedupeDropped}`);
  console.log(`  collapsed unresolved twins: ${col.dropped}`);
  console.log(`  summed amount             : ${total.toLocaleString('en-US')}`);
  return { final, label };
}

const runs = [];
for (let i = 0; i < process.argv.length - 2; i += 2) {
  runs.push(replay(process.argv[2 + i], process.argv[3 + i]));
}

if (runs.length === 2) {
  const [a, b] = runs;
  const key = (r) => `${r.rawPlayerName}|${r.direction}|${r.amount}|${r.transactionDate}`;
  const am = new Map(), bm = new Map();
  for (const r of a.final) am.set(key(r), (am.get(key(r)) ?? 0) + 1);
  for (const r of b.final) bm.set(key(r), (bm.get(key(r)) ?? 0) + 1);
  const onlyA = [...am.keys()].filter((k) => !bm.has(k));
  const onlyB = [...bm.keys()].filter((k) => !am.has(k));
  console.log(`\n=== written-row diff ===`);
  console.log(`  only in ${a.label}: ${onlyA.length}`);
  onlyA.slice(0, 25).forEach((k) => console.log(`      ${k}`));
  console.log(`  only in ${b.label}: ${onlyB.length}`);
  onlyB.slice(0, 25).forEach((k) => console.log(`      ${k}`));
}
