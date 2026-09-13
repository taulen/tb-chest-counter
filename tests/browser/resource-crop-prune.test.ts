import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneUnreferencedCrops } from '../../src/browser/resource-history-capture.js';

/**
 * A sweep reads every row on ~4 consecutive pages, and each read that cannot identify
 * the resource writes its own crop. Most of those reads then pair with a clean one and
 * disappear into the stitch, so their crops belong to nothing — 236 written against 22
 * rows still unknown, on one 269-page sweep.
 *
 * The tempting shortcut is to skip the write for rows that look likely to be superseded,
 * and it is wrong: a row that reaches the database still unknown is precisely one no
 * clean read rescued, so it is the row whose crop an admin needs. That shortcut shipped
 * once and every unknown row in the resolve dialog came up with no screenshot. Hence:
 * write them all, prune once the surviving rows are known.
 */
describe('resource capture: pruning unreferenced row crops', () => {
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crop-prune-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const make = (name: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, 'not-really-a-png');
    return p;
  };

  it('keeps the crops surviving rows point at and deletes the rest', async () => {
    const kept = make('p10_r000.png');
    const orphanA = make('p11_r000.png');
    const orphanB = make('p12_r001.png');

    const removed = await pruneUnreferencedCrops(
      [kept, orphanA, orphanB],
      [{ rowCropPath: kept }, { rowCropPath: null }, {}],
    );

    expect(removed).toBe(2);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(orphanA)).toBe(false);
    expect(fs.existsSync(orphanB)).toBe(false);
  });

  it('deletes everything when no row survived — a failed insert keeps no evidence', async () => {
    const a = make('a.png');
    const b = make('b.png');

    expect(await pruneUnreferencedCrops([a, b], [])).toBe(2);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
  });

  it('counts a path written several times once', async () => {
    const dupe = make('dupe.png');
    // The same file can be reported twice if two page reads produced the same name.
    expect(await pruneUnreferencedCrops([dupe, dupe], [])).toBe(1);
  });

  it('never throws on a file that is already gone', async () => {
    const gone = path.join(dir, 'never-written.png');
    await expect(pruneUnreferencedCrops([gone], [])).resolves.toBe(0);
  });

  it('does nothing when the sweep wrote no crops', async () => {
    expect(await pruneUnreferencedCrops([], [{ rowCropPath: null }])).toBe(0);
  });
});
