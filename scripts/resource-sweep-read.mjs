/**
 * Step 1 of the resource-history A/B rig. Runs the REAL production OCR over every page
 * crop a sweep saved and writes one JSON line per row read.
 *
 * Run from the repo root, after `npx tsc` — it imports dist/ on purpose, so what you
 * measure is what ships:
 *
 *   node scripts/resource-sweep-read.mjs data/exports/run_<stamp> before.jsonl
 *   …change src/vision/resource-ocr.ts, npx tsc…
 *   node scripts/resource-sweep-read.mjs data/exports/run_<stamp> after.jsonl
 *   node scripts/resource-boundary-accuracy.mjs before.jsonl after.jsonl
 *   node scripts/resource-sweep-replay.mjs before before.jsonl after after.jsonl
 *
 * A page crop is only saved when the sweep ran with debugSavePages, so get one of those
 * first. ~2.3s per page. No crops are written (cropToken omitted) and the roster is
 * empty, which isolates the two things worth measuring: resourceTypeId and amount.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { processResourceScreenshot } = require(path.resolve('dist/vision/resource-ocr.js'));

const RUN = process.argv[2] ?? 'data/exports/run_2026-07-31T12-21-19-375Z';
const OUT = process.argv[3] ?? 'resource-sweep-rows.jsonl';
const LIMIT = process.argv[4] ? Number(process.argv[4]) : Infinity;

// Every slug with a shipped template is matchable; that set is the authority.
const dir = path.resolve('assets', 'resource-icons');
const slugs = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.png') && !/-\d+\.png$/.test(f))
  .map((f) => f.replace(/\.png$/, ''))
  .sort();
const allTypes = slugs.map((slug, i) => ({ id: i + 1, slug, name: slug }));
const byId = new Map(allTypes.map((t) => [t.id, t.slug]));

const files = fs.readdirSync(RUN).filter((f) => /p\d+-crop(-firstpage)?_/.test(f)).sort();
const out = fs.createWriteStream(OUT);
let n = 0, rows = 0, unresolved = 0;
const t0 = Date.now();
let carryDate;

for (const f of files) {
  if (n >= LIMIT) break;
  const res = await processResourceScreenshot({
    imageBuffer: fs.readFileSync(path.join(RUN, f)),
    uploadDate: new Date('2026-07-31T12:21:00Z'),
    members: [],
    allTypes,
    initialDateLabel: carryDate,
  });
  carryDate = res.finalDateLabel;
  for (const r of res.rows) {
    rows++;
    if (r.resourceTypeId == null) unresolved++;
    out.write(JSON.stringify({
      page: f, name: r.rawPlayerName, dir: r.direction, amount: r.amount,
      slug: r.resourceTypeId == null ? null : byId.get(r.resourceTypeId),
      date: r.transactionDate,
    }) + '\n');
  }
  n++;
  if (n % 20 === 0) {
    const per = (Date.now() - t0) / n;
    console.log(`${n}/${files.length}  rows=${rows} unresolved=${unresolved} (${((unresolved / rows) * 100).toFixed(2)}%)  ${Math.round(per)}ms/page  eta ${Math.round(per * (files.length - n) / 1000)}s`);
  }
}
out.end();
console.log(`done: ${n} pages, ${rows} rows, ${unresolved} unresolved (${((unresolved / rows) * 100).toFixed(2)}%) in ${Math.round((Date.now() - t0) / 1000)}s`);
