#!/usr/bin/env node
/**
 * Put an install back into first-run state so the /setup wizard runs again.
 *
 * needsSetup() is false as soon as EITHER env file exists or the database file
 * does, and both survive a container recreate because they live on the mounted
 * volume. So a half-finished setup — account created, Total Battle sign-in not
 * done — leaves the wizard permanently "already complete" with no way back to
 * it from inside the app. The only other route is deleting the whole volume,
 * which also throws away the browser profiles and every backup in it.
 *
 * NOTHING IS DELETED. The database and the clan profile dirs are RENAMED with a
 * timestamped suffix, so a reset fired at the wrong install is undone by
 * renaming them back (the script prints the exact commands). Only the two env
 * files are removed, and setup rewrites those from defaults anyway.
 *
 * Requires --yes, because there is no way for a script to tell a scratch
 * deployment from the real one.
 *
 *   node scripts/reset-setup.mjs                 # dry run: says what it would do
 *   node scripts/reset-setup.mjs --yes           # config + database
 *   node scripts/reset-setup.mjs --yes --all     # also the per-clan browser profiles
 *
 * In Docker, run it against the container and restart it:
 *
 *   docker exec <container> node scripts/reset-setup.mjs --yes
 *   docker restart <container>
 *
 * The restart is what matters: the running process decided its mode at boot and
 * holds an open handle to the old database file.
 */

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const includeProfiles = args.includes('--all');

const dbPath = path.resolve(process.env.DB_PATH?.trim() || './data/tb-chests.db');
const dataDir = path.dirname(dbPath);
const appEnvPath = path.resolve(process.env.APP_CONFIG_PATH?.trim() || path.join('data', 'app.env'));
const legacyEnvPath = path.resolve('.env');
const clansDir = path.join(dataDir, 'clans');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const plan = [];

// The database, plus the WAL sidecars — leaving those next to a new database
// would hand SQLite a journal belonging to a different file.
for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (fs.existsSync(file)) {
    plan.push({ kind: 'rename', from: file, to: `${file}.pre-reset-${stamp}` });
  }
}

for (const file of [appEnvPath, legacyEnvPath]) {
  if (fs.existsSync(file)) plan.push({ kind: 'delete', from: file });
}

if (includeProfiles && fs.existsSync(clansDir)) {
  plan.push({ kind: 'rename', from: clansDir, to: `${clansDir}.pre-reset-${stamp}` });
}

function describe(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) return 'directory';
    return `${(stat.size / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return '?';
  }
}

console.log(`\nReset first-run state${apply ? '' : ' — DRY RUN, nothing will change'}\n`);

if (plan.length === 0) {
  console.log('  Nothing to do: no env file and no database found. Setup would already run.\n');
  process.exit(0);
}

for (const step of plan) {
  const verb = step.kind === 'rename' ? 'move  ' : 'delete';
  console.log(`  ${verb} ${step.from}  (${describe(step.from)})`);
  if (step.kind === 'rename') console.log(`      -> ${step.to}`);
}

if (!apply) {
  console.log('\n  Re-run with --yes to apply.');
  console.log('  Add --all to also set aside the per-clan browser profiles (forces a fresh');
  console.log('  Total Battle sign-in), which is what a genuine new install looks like.\n');
  process.exit(0);
}

const undo = [];
for (const step of plan) {
  if (step.kind === 'rename') {
    fs.renameSync(step.from, step.to);
    undo.push(`mv ${JSON.stringify(step.to)} ${JSON.stringify(step.from)}`);
  } else {
    fs.rmSync(step.from);
  }
}

console.log('\n  Done. Restart the app and open /setup — the wizard will run from the top.');
console.log('  (The running process picked its mode at boot and still holds the old DB open.)');
if (undo.length) {
  console.log('\n  To undo, before restarting:');
  for (const cmd of undo) console.log(`    ${cmd}`);
}
console.log('');
