#!/usr/bin/env node
/**
 * Regenerate tests/fixtures/schema-baseline.json — the snapshot of what a fresh
 * install's database looks like.
 *
 * Run it after any intentional schema change (a new migration, or an edit to
 * the consolidated baseline), then commit the fixture with that change:
 *
 *   npm run build && node scripts/update-schema-baseline.mjs
 *
 * The point of the snapshot is not the file itself but the diff: a schema
 * change should be something a reviewer sees. The previous baseline in this
 * project went stale for forty migrations without anything noticing, because a
 * bootstrap block only ever runs on a database nobody creates.
 *
 * Builds the database from dist/, so the compiled code is what gets measured —
 * the same code the container runs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// fileURLToPath, not the URL's pathname: on Windows the latter is
// "/C:/Users/..." and every path built from it lands somewhere that looks
// plausible in a log line and does not exist on disk.
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = path.join(repoRoot, 'tests', 'fixtures', 'schema-baseline.json');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbcc-schema-'));
const dbPath = path.join(tmpDir, 'baseline.db');

const { initDatabase, closeDb } = await import(
  new URL('../dist/data/database.js', import.meta.url).href
);

initDatabase(dbPath);
closeDb();

const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(`
  SELECT type, name, sql FROM sqlite_master
  WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
  ORDER BY type, name
`).all();
db.close();

// Same normalisation the test applies, so formatting never reads as a change.
const snapshot = rows.map((r) => ({
  type: r.type,
  name: r.name,
  sql: r.sql.replace(/\s+/g, ' ').replace(/IF NOT EXISTS /gi, '').replace(/"/g, '').trim(),
}));

fs.mkdirSync(path.dirname(fixture), { recursive: true });
fs.writeFileSync(fixture, `${JSON.stringify(snapshot, null, 2)}\n`);
fs.rmSync(tmpDir, { recursive: true, force: true });

const counts = snapshot.reduce((acc, o) => ({ ...acc, [o.type]: (acc[o.type] ?? 0) + 1 }), {});
console.log(`wrote ${path.relative(repoRoot, fixture)}`);
console.log(Object.entries(counts).map(([k, v]) => `${v} ${k}${v === 1 ? '' : 's'}`).join(', '));
