/**
 * Pins the schema a fresh install actually gets.
 *
 * The bootstrap is one consolidated baseline entry (see MIGRATIONS in
 * src/data/database.ts). That shape has a known failure mode, and this codebase
 * has already lived it once: the previous baseline was captured at v30 and then
 * quietly went stale as forty further migrations layered on top of it, so what
 * the file appeared to declare and what a database actually contained drifted
 * apart for months. Nothing failed — a bootstrap block is only ever executed on
 * a brand-new database, and nobody creates one of those.
 *
 * So the schema is snapshotted, and this compares a genuinely fresh database
 * against the snapshot. A new migration legitimately changes it; the point is
 * that the change shows up as a reviewable diff instead of a silent divergence.
 *
 * When it fails after an intentional schema change:
 *
 *     npm run build && node scripts/update-schema-baseline.mjs
 *
 * and commit the regenerated fixture alongside the migration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { makeTestDb } from '../helpers/test-db.js';

const FIXTURE = path.resolve(
  fileURLToPath(new URL('../fixtures/schema-baseline.json', import.meta.url)),
);

interface SchemaObject {
  type: string;
  name: string;
  sql: string;
}

/** Normalised so formatting differences don't read as schema differences. */
function readSchema(): SchemaObject[] {
  const rows = getDb().prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as SchemaObject[];
  return rows.map((r) => ({
    type: r.type,
    name: r.name,
    sql: r.sql.replace(/\s+/g, ' ').replace(/IF NOT EXISTS /gi, '').replace(/"/g, '').trim(),
  }));
}

describe('schema baseline', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('matches the committed snapshot of a fresh install', () => {
    ({ cleanup } = makeTestDb());
    const actual = readSchema();
    const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as SchemaObject[];

    // Compared name-by-name: a whole-array diff on 98 objects is unreadable,
    // and the useful question is always "which object changed".
    const actualNames = actual.map((o) => `${o.type}:${o.name}`);
    const expectedNames = expected.map((o) => `${o.type}:${o.name}`);
    expect(actualNames.filter((n) => !expectedNames.includes(n)), 'new schema objects').toEqual([]);
    expect(expectedNames.filter((n) => !actualNames.includes(n)), 'missing schema objects').toEqual([]);

    for (const want of expected) {
      const got = actual.find((o) => o.type === want.type && o.name === want.name);
      expect(got?.sql, `${want.type} ${want.name} differs from the snapshot`).toBe(want.sql);
    }
  });

  it('seeds the reference rows a fresh install cannot work without', () => {
    ({ cleanup } = makeTestDb());
    const db = getDb();

    // A resource type that isn't seeded fails silently: its rows land
    // unresolved and look like a bad OCR read, which is how Religious
    // Tractates went unnoticed for a week.
    const types = db.prepare('SELECT COUNT(*) AS c FROM resource_types').get() as { c: number };
    expect(types.c).toBeGreaterThan(0);

    // Triumphal values are seeded from TRIUMPHAL_PACKAGE_POINTS; zero rows
    // means a fresh install scores every triumphal package at nothing.
    const triumphal = db.prepare('SELECT COUNT(*) AS c FROM triumphal_chest_points').get() as { c: number };
    expect(triumphal.c).toBeGreaterThan(0);
  });

  it('records the baseline version so later migrations apply on top', () => {
    ({ cleanup } = makeTestDb());
    const row = getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    // If this is 0/null, the runner would re-apply the baseline on every boot;
    // if it ever exceeds the highest declared migration, something stamped a
    // version nothing created.
    expect(row.v).toBeGreaterThan(0);
  });
});
