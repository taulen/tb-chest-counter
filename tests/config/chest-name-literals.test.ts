/**
 * One spelling per chest across every hand-written chest list.
 *
 * The Ragnarok "Jormungandr" column read 0 for weeks with 2113 matching records
 * sitting in the DB: the chest was stored as "Jörmungandr's Chest" and the
 * Events catalog still said "Jormungandr's Chest". A name-keyed literal that
 * misses fails as a zero that reads like a result, never as an error.
 *
 * This used to be pinned against the OCR-era spelling corrector and its name
 * catalog (`correctChestName(name) === name`). Both are gone: chests arrive
 * under the game's own names, so the stored spelling IS the game's, and there
 * is no committed list of game names to test against (the static data is
 * downloaded at run time). What a pure test can still catch is the shape of
 * that bug — the same chest spelled two ways in the code, an accent, a case or
 * an apostrophe apart — so whichever spelling the data holds, one of the lists
 * would be stranded. The data side is checked at boot by checkConfigIntegrity,
 * and resolvePredicate / clanRewardChestIds fold a stale literal onto the live
 * chest and warn.
 *
 * Runs as part of `npm run build`.
 */

import { describe, it, expect } from 'vitest';
import { EVENT_CATALOG } from '../../src/config/event-catalog.js';
import { SOURCE_CHEST_POINTS } from '../../src/data/source-names.js';
import { CHEST_TYPES, TRIUMPHAL_CHEST_NAMES } from '../../src/data/chest-names.js';
import { despace } from '../../src/utils/name-normalize.js';

/** Every chest-name literal in the code → where it is written. */
function chestLiterals(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (name: string, where: string): void => {
    const at = out.get(name) ?? [];
    at.push(where);
    out.set(name, at);
  };
  for (const def of EVENT_CATALOG) {
    for (const rule of def.rules) {
      for (const name of [...(rule.chestName ? [rule.chestName] : []), ...(rule.chestNames || [])]) {
        add(name, `EVENT_CATALOG ${def.key}`);
      }
    }
  }
  for (const [sourceKey, byName] of Object.entries(SOURCE_CHEST_POINTS)) {
    for (const name of Object.keys(byName)) add(name, `SOURCE_CHEST_POINTS ${sourceKey}`);
  }
  for (const name of Object.keys(CHEST_TYPES)) add(name, 'CHEST_TYPES');
  for (const name of TRIUMPHAL_CHEST_NAMES) add(name, 'TRIUMPHAL_CHEST_NAMES');
  return out;
}

describe('chest-name literals', () => {
  it('finds the lists it is meant to check', () => {
    // A refactor that empties one of them would turn this file into a no-op.
    const places = [...chestLiterals().values()].flat().join('\n');
    for (const list of ['EVENT_CATALOG', 'SOURCE_CHEST_POINTS', 'CHEST_TYPES', 'TRIUMPHAL_CHEST_NAMES']) {
      expect(places, list).toContain(list);
    }
  });

  it('spells every chest one way across the code', () => {
    const byKey = new Map<string, Set<string>>();
    for (const name of chestLiterals().keys()) {
      const k = despace(name);
      byKey.set(k, (byKey.get(k) ?? new Set()).add(name));
    }
    const literals = chestLiterals();
    const split = [...byKey.values()]
      .filter((spellings) => spellings.size > 1)
      .map((spellings) => [...spellings].map((s) => `"${s}" (${literals.get(s)?.join(', ')})`).join(' vs '));
    expect(split).toEqual([]);
  });

  it('writes every name trimmed and single-spaced, as the game does', () => {
    const bad = [...chestLiterals().entries()]
      .filter(([name]) => !name || name !== name.trim().replace(/\s+/g, ' '))
      .map(([name, at]) => `"${name}" (${at.join(', ')})`);
    expect(bad).toEqual([]);
  });
});
