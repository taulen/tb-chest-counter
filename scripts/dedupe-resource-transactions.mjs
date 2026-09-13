#!/usr/bin/env node
/**
 * Repair the duplicate resource_transactions rows the old cursor left behind.
 *
 * Forward-only fixes repair nothing. Before the settled-day anchor landed, the
 * capture anchored its marker on the block the game was still writing to, so the
 * marker evaporated roughly weekly and the sweep re-read and re-inserted days it
 * already held. Measured on one production clan: 809 exact cross-batch duplicate
 * rows worth ~4.37 billion, plus 317 stale partials worth ~1.14 billion, out of
 * 5,908 rows — about 19% of the table.
 *
 * A SCRIPT, NOT A MIGRATION, and the reasons matter:
 *   - it carries a judgement call about an ambiguous residue, which a migration
 *     would make silently and irreversibly on every install;
 *   - the defect recurred weekly, so a once-only migration would do nothing the
 *     next time;
 *   - it touches no DDL, and scripts/ is already this domain's home
 *     (resource-boundary-accuracy.mjs, resource-stitch-failures.mjs, …).
 *
 * Dry-run by default. Nothing is deleted without --apply.
 *
 *   node scripts/dedupe-resource-transactions.mjs --clan 1
 *   node scripts/dedupe-resource-transactions.mjs --clan 1 --apply
 *   node scripts/dedupe-resource-transactions.mjs --clan 1 --db path/to.db
 *
 * WHAT IT WILL NOT DO, and why each guard exists:
 *
 *   - It never collapses a (member, date, resource, direction) GROUP to one row.
 *     A player really does hold several distinct lines for one resource on one
 *     settled day — 33% of Scientific Tractates groups — so a rule like "keep the
 *     largest" or "keep one per group" deletes real donations. Only rows that are
 *     identical in EVERY field are candidates.
 *   - It never deletes a copy from a batch that might have been reading that date
 *     for the first time. A duplicate is only provable when the other batch swept
 *     PAST that date (its own oldest row is older), which shows it was re-reading
 *     rather than reading a fresh partial.
 *   - It never deletes below the multiplicity a single batch actually observed.
 *     If one batch legitimately read two identical rows, two survive.
 *   - It never touches upload batches. Scan and upload are deliberately
 *     independent and their overlap is an admin decision (listSourceOverlapDates).
 *
 * STALE PARTIALS ARE REPORTED, NOT DELETED. Where the same (member, date,
 * resource, direction) holds several DIFFERENT amounts, the smaller ones are
 * probably a partial day that was later re-read in full — but "probably" is not
 * good enough to delete a real transaction, and the two cases are not separable
 * from the data alone. They are printed for an admin to resolve in the UI.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? '') : null;
};
const APPLY = argv.includes('--apply');
const CLAN = Number.parseInt(flag('--clan') ?? '', 10);
const DB_PATH = flag('--db') ?? path.join('data', 'tb-chests.db');

if (!Number.isFinite(CLAN)) {
  console.error('Usage: node scripts/dedupe-resource-transactions.mjs --clan <id> [--apply] [--db <path>]');
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}. Pass --db.`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: !APPLY });
const despace = (n) => n.trim().toLowerCase().replace(/\s+/g, '');

// Scan batches only, with the oldest date each one reached — that is what proves a
// batch swept past a date rather than stopping inside it.
const batches = new Map();
for (const b of db.prepare(`
  SELECT b.id, b.upload_date AS uploadDate, b.notes,
         MIN(rt.transaction_date) AS oldestDate, COUNT(rt.id) AS rowCount
    FROM resource_upload_batches b
    JOIN resource_transactions rt ON rt.batch_id = b.id
   WHERE b.clan_id = ? AND b.source = 'scan'
   GROUP BY b.id
`).all(CLAN)) batches.set(b.id, b);

const rows = db.prepare(`
  SELECT rt.id, rt.batch_id AS batchId, rt.member_id AS memberId, rt.raw_player_name AS rawName,
         rt.direction, rt.amount, rt.transaction_date AS date,
         rt.resource_type_id AS resourceTypeId, rt.row_crop_path AS cropPath
    FROM resource_transactions rt
    JOIN resource_upload_batches b ON b.id = rt.batch_id
   WHERE rt.clan_id = ? AND b.source = 'scan'
   ORDER BY rt.id
`).all(CLAN);

console.log(`Clan ${CLAN}: ${rows.length} scan row(s) across ${batches.size} batch(es) in ${DB_PATH}`);

/** Identical in every field that describes the transaction. */
const contentKey = (r) =>
  `${r.memberId}|${r.date}|${r.resourceTypeId ?? 'x'}|${r.direction}|${r.amount}`;
/** The group a stale partial would live in — same row, any amount. */
const groupKey = (r) => `${r.memberId}|${r.date}|${r.resourceTypeId ?? 'x'}|${r.direction}`;

const byContent = new Map();
for (const r of rows) {
  const k = contentKey(r);
  if (!byContent.has(k)) byContent.set(k, []);
  byContent.get(k).push(r);
}

const doomed = [];
for (const [key, copies] of byContent) {
  const perBatch = new Map();
  for (const r of copies) {
    if (!perBatch.has(r.batchId)) perBatch.set(r.batchId, []);
    perBatch.get(r.batchId).push(r);
  }
  if (perBatch.size < 2) continue; // within one batch = a genuine same-day repeat

  // The true multiplicity is the most copies any SINGLE batch saw. Two identical
  // rows read by one batch are two real transactions and both must survive.
  const trueCount = Math.max(...[...perBatch.values()].map((v) => v.length));

  // Keep the batch that saw the most copies; ties to the earliest, which preserves
  // provenance and keeps the original read intact.
  const ranked = [...perBatch.entries()].sort((a, b) =>
    (b[1].length - a[1].length) || (a[0] - b[0]));
  const keepBatch = ranked[0][0];

  for (const [batchId, copies2] of ranked.slice(1)) {
    const b = batches.get(batchId);
    const date = copies2[0].date;
    // Only provable when this batch swept PAST the date: it was re-reading, not
    // reading that day for the first time.
    if (!b || !b.oldestDate || !(b.oldestDate < date)) continue;
    for (const r of copies2) doomed.push({ ...r, key, keepBatch, trueCount });
  }
}

// --- Assertions. Abort rather than delete something unprovable. -------------
const doomedIds = new Set(doomed.map((r) => r.id));
for (const [key, copies] of byContent) {
  const survivors = copies.filter((r) => !doomedIds.has(r.id));
  if (survivors.length === 0) {
    console.error(`ABORT: content key ${key} would lose its last row.`);
    process.exit(2);
  }
  const perBatch = new Map();
  for (const r of copies) perBatch.set(r.batchId, (perBatch.get(r.batchId) ?? 0) + 1);
  const trueCount = Math.max(...perBatch.values());
  if (survivors.length < trueCount) {
    console.error(`ABORT: ${key} saw ${trueCount} copies in one batch but only `
      + `${survivors.length} would survive.`);
    process.exit(2);
  }
}
const emptied = [...batches.keys()].filter((id) =>
  rows.filter((r) => r.batchId === id).every((r) => doomedIds.has(r.id)));
if (emptied.length > 0) {
  console.error(`ABORT: batch(es) ${emptied.join(', ')} would be emptied entirely.`);
  process.exit(2);
}

// --- Report ------------------------------------------------------------------
const perBatchCount = new Map();
let amount = 0;
for (const r of doomed) {
  perBatchCount.set(r.batchId, (perBatchCount.get(r.batchId) ?? 0) + 1);
  amount += r.amount;
}
console.log(`\nEXACT DUPLICATES — ${doomed.length} row(s), ${amount.toLocaleString('en-US')} in amount`);
for (const [batchId, n] of [...perBatchCount].sort((a, b) => a[0] - b[0])) {
  const b = batches.get(batchId);
  console.log(`  batch #${batchId} (${b.uploadDate}, ${b.rowCount} rows): ${n} duplicate(s)`
    + (String(b.notes ?? '').includes('not re-found') ? '  [cursor was lost]' : ''));
}

// Stale partials: reported only.
let staleGroups = 0;
let staleAmount = 0;
const staleSamples = [];
const byGroup = new Map();
for (const r of rows) {
  if (doomedIds.has(r.id)) continue;
  const k = groupKey(r);
  if (!byGroup.has(k)) byGroup.set(k, []);
  byGroup.get(k).push(r);
}
for (const [k, copies] of byGroup) {
  const batchIds = new Set(copies.map((r) => r.batchId));
  const amounts = [...new Set(copies.map((r) => r.amount))].sort((a, b) => a - b);
  if (batchIds.size < 2 || amounts.length < 2) continue;
  staleGroups++;
  staleAmount += amounts.slice(0, -1).reduce((s, a) => s + a, 0);
  if (staleSamples.length < 15) {
    staleSamples.push(`  ${k.padEnd(34)} ${copies.map((r) => `b${r.batchId}:${r.amount}`).join('  ')}`);
  }
}
console.log(`\nSTALE PARTIALS — ${staleGroups} group(s), ${staleAmount.toLocaleString('en-US')} `
  + 'in probably-superseded amount. NOT deleted: a smaller earlier amount is usually a '
  + 'partial day later re-read in full, but it can equally be a second real donation, and '
  + 'the two are not separable from the data. Resolve these in Resources → Admin.');
console.log(staleSamples.join('\n'));

if (!APPLY) {
  console.log('\nDRY RUN — nothing was changed. Re-run with --apply to delete the exact duplicates.');
  process.exit(0);
}

// --- Apply -------------------------------------------------------------------
const backupDir = path.join('data', 'exports', 'dbbackup');
fs.mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `pre-dedupe-clan${CLAN}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
fs.copyFileSync(DB_PATH, backup);
console.log(`\nBackup written to ${backup}`);

const crops = doomed.map((r) => r.cropPath).filter(Boolean);
const del = db.prepare('DELETE FROM resource_transactions WHERE id = ?');
const touched = new Set(doomed.map((r) => r.batchId));
db.transaction(() => {
  for (const r of doomed) del.run(r.id);
  for (const batchId of touched) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM resource_transactions WHERE batch_id = ?')
      .get(batchId).n;
    db.prepare('UPDATE resource_upload_batches SET row_count = ?, notes = notes || ? WHERE id = ?')
      .run(n, ` · ${perBatchCount.get(batchId)} duplicate row(s) removed ${new Date().toISOString().slice(0, 10)}`, batchId);
  }
})();
// After the commit: a failed unlink must not roll back the delete.
for (const p of crops) { try { fs.rmSync(p, { force: true }); } catch { /* orphan is cheap */ } }
console.log(`Deleted ${doomed.length} duplicate row(s); recounted ${touched.size} batch(es).`);
