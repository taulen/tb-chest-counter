/**
 * Step 2 of the resource-history A/B rig: the accuracy metric, built so bundle sends
 * cannot confound it.
 *
 * A player can send the same amount of several resources on the same day, so
 * (name, amount, date) is NOT a row identity — "Clau +2,000,000" legitimately appears
 * six times with six resources. But rows read from the MIDDLE of a page are reliable
 * (measured: 7 of 4,376 unresolved, 0.16%), so:
 *
 *   ground truth  = groups whose middle-of-page reads are unanimous on one resource
 *   error rate    = how often a first/last-row read of the same group disagrees
 *
 * A bundle send cannot be unanimous among middle reads, so it is excluded automatically.
 */
import fs from 'fs';
const rd = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function report(label, rows) {
  const byPage = new Map();
  for (const r of rows) {
    if (!byPage.has(r.page)) byPage.set(r.page, []);
    byPage.get(r.page).push(r);
  }
  for (const [, rs] of byPage) rs.forEach((r, i) => { r._i = i; r._n = rs.length; });

  const groups = new Map();
  for (const r of rows) {
    const k = `${r.name}|${r.amount}|${r.dir}|${r.date}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const isBoundary = (r) => r._i === 0 || r._i === r._n - 1;
  let truthed = 0, bWrong = 0, bNull = 0, bRight = 0, bTot = 0;
  let mWrong = 0, mNull = 0, mTot = 0;
  const wrongEx = [];

  for (const [k, g] of groups) {
    // A bundle send puts two physical rows with the same name/amount/date on the SAME
    // page, so the key repeats within one page. Those groups have no single truth.
    const perPage = new Map();
    for (const r of g) perPage.set(r.page, (perPage.get(r.page) || 0) + 1);
    if ([...perPage.values()].some((c) => c > 1)) continue;

    const mid = g.filter((r) => !isBoundary(r));
    const midSlugs = [...new Set(mid.map((r) => r.slug).filter(Boolean))];
    if (midSlugs.length !== 1) continue;          // no unanimous ground truth
    truthed++;
    const truth = midSlugs[0];
    for (const r of g) {
      if (isBoundary(r)) {
        bTot++;
        if (r.slug == null) bNull++;
        else if (r.slug !== truth) { bWrong++; if (wrongEx.length < 10) wrongEx.push(`${k} truth=${truth} read=${r.slug} on ${r.page.slice(0, 4)} idx=${r._i}/${r._n - 1}`); }
        else bRight++;
      } else {
        mTot++;
        if (r.slug == null) mNull++;
        else if (r.slug !== truth) mWrong++;
      }
    }
  }
  const p = (n, d) => `${n} (${d ? (n / d * 100).toFixed(2) : '0.00'}%)`;
  console.log(`\n=== ${label} ===`);
  console.log(`  page-reads ${rows.length}, transactions with unanimous middle truth: ${truthed}`);
  console.log(`  MIDDLE reads   ${mTot}:  wrong ${p(mWrong, mTot)}   unresolved ${p(mNull, mTot)}`);
  console.log(`  BOUNDARY reads ${bTot}:  wrong ${p(bWrong, bTot)}   unresolved ${p(bNull, bTot)}   right ${p(bRight, bTot)}`);
  for (const e of wrongEx) console.log(`      ${e}`);
  return { bWrong, bNull, bRight, bTot };
}

for (const f of process.argv.slice(2)) {
  if (!fs.existsSync(f)) { console.log(`${f}: missing`); continue; }
  report(f, rd(f));
}
