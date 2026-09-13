/**
 * Pins the Events catalog against the chest-name corrector.
 *
 * The Ragnarok "Jormungandr" column read 0 for weeks with 2113 matching records
 * sitting in the DB: commit 89266dd renamed the chest to the umlaut spelling and
 * nothing connected that to the plain-o literal in event-catalog.ts. 652 tests
 * stayed green because no test imported EVENT_CATALOG at all.
 *
 * The load-bearing assertion is `correctChestName(name) === name`. `chests` rows
 * are reconciled through correctChestName on every boot (cleanupChestNames in
 * src/data/database.ts), so a catalog name the corrector would rewrite is, by
 * definition, a name no chest row will ever carry. That makes this a pure test —
 * no DB, no fixtures — that still catches the whole rename class, and it goes red
 * the moment someone edits KNOWN_CHESTS without updating the catalog.
 */

import { describe, it, expect } from 'vitest';
import { EVENT_CATALOG } from '../../src/config/event-catalog.js';
import { correctChestName } from '../../src/vision/chest-names.js';

function declaredNames(rule: { chestName?: string; chestNames?: string[] }): string[] {
  return [...(rule.chestName ? [rule.chestName] : []), ...(rule.chestNames || [])];
}

// Mirrors columnKeyForRule in src/data/repositories/event-repo.ts.
function columnKey(rule: { label?: string; chestName?: string; chestNames?: string[] }, i: number): string {
  return rule.label || rule.chestName || rule.chestNames?.[0] || `col-${i}`;
}

describe('EVENT_CATALOG', () => {
  it('declares every chest under the spelling correctChestName produces', () => {
    const wrong: string[] = [];
    for (const def of EVENT_CATALOG) {
      for (const rule of def.rules) {
        for (const name of declaredNames(rule)) {
          const corrected = correctChestName(name);
          if (corrected !== name) wrong.push(`${def.key}: "${name}" should be "${corrected}"`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('gives every rule in an event a distinct column key', () => {
    // columnKeyForRule collisions don't error — the `if (!chestIdToColumn.has(id))`
    // first-wins guard in event-repo silently folds the second rule into the first,
    // so one of the two chests just stops being counted.
    for (const def of EVENT_CATALOG) {
      const keys = def.rules.map(columnKey);
      expect(new Set(keys).size, `duplicate column key in "${def.key}": ${keys.join(', ')}`).toBe(keys.length);
    }
  });

  it('gives every rule something to match on', () => {
    for (const def of EVENT_CATALOG) {
      def.rules.forEach((rule, i) => {
        const hasChest = declaredNames(rule).length > 0;
        const hasSource = Boolean(rule.sourceContains?.trim());
        expect(hasChest || hasSource, `${def.key} rule ${i} matches nothing`).toBe(true);
      });
    }
  });

  it('declares clan rewards by chest name, and still declares some', () => {
    // `clanReward` is what src/data/clan-reward-chests.ts reads to keep an
    // end-of-event placement prize — handed to one account for the whole clan —
    // out of every member ranking. Two ways it fails silently, both covered:
    //
    //  - the set going empty (a refactor drops the flag, or the last rule
    //    carrying it is edited away): the boards quietly go back to crowning
    //    whoever received the reward, with nothing red anywhere.
    //  - a rule flagged clanReward that matches on `sourceContains` alone:
    //    the resolver works from chest NAMES only, so such a rule excludes
    //    nothing while reading as if it did.
    const flagged = EVENT_CATALOG.flatMap((def) =>
      def.rules.filter((r) => r.clanReward).map((r) => ({ def, rule: r })));
    expect(flagged.length, 'no rule declares clanReward any more').toBeGreaterThan(0);
    for (const { def, rule } of flagged) {
      expect(
        declaredNames(rule).length,
        `${def.key}: a clanReward rule must name its chest(s) — the resolver keys on names`,
      ).toBeGreaterThan(0);
    }
  });

  it('keeps sourceContains needles lowercase and non-empty', () => {
    // sourcesMatching folds and lowercases BOTH sides, so an accented needle is
    // fine — but a needle that isn't already lowercase reads as if case matters.
    for (const def of EVENT_CATALOG) {
      for (const rule of def.rules) {
        if (rule.sourceContains === undefined) continue;
        expect(rule.sourceContains.trim()).not.toBe('');
        expect(rule.sourceContains).toBe(rule.sourceContains.toLowerCase());
      }
    }
  });

  it('declares level buckets ascending, non-overlapping, and only in level mode', () => {
    // Buckets are the event's columns, so an overlap doesn't error — a chest
    // just lands in whichever range `findBucket` reaches first and vanishes
    // from the other, which reads as a quiet tier rather than a config bug.
    // A descending pair is the same failure with the columns out of order.
    for (const def of EVENT_CATALOG) {
      if (!def.levelBuckets) continue;
      expect(def.columnMode, `"${def.key}" declares levelBuckets outside level mode`).toBe('level');
      expect(def.levelBuckets.length, `"${def.key}" declares an empty bucket list`).toBeGreaterThan(0);
      let prevTo = -Infinity;
      for (const b of def.levelBuckets) {
        expect(Number.isInteger(b.from) && Number.isInteger(b.to), `"${def.key}" bucket ${b.from}-${b.to} is not integral`).toBe(true);
        expect(b.to, `"${def.key}" bucket ${b.from}-${b.to} ends before it starts`).toBeGreaterThanOrEqual(b.from);
        expect(b.from, `"${def.key}" bucket ${b.from}-${b.to} overlaps the previous one`).toBeGreaterThan(prevTo);
        prevTo = b.to;
      }
    }
  });

  it('has unique keys and orders, a parseable cycle anchor, and no blank calendar names', () => {
    const keys = EVENT_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    const orders = EVENT_CATALOG.map((e) => e.order);
    expect(new Set(orders).size).toBe(orders.length);

    for (const def of EVENT_CATALOG) {
      // Hash route + API path segment — see project convention: no spaces in URLs.
      expect(def.key, `event key "${def.key}" is not URL-safe`).toMatch(/^[a-z0-9-]+$/);
      if (def.cycle) {
        expect(Number.isFinite(Date.parse(def.cycle.anchor))).toBe(true);
        expect(def.cycle.days).toBeGreaterThan(0);
      }
      for (const name of def.calendarNames || []) {
        expect(name.trim()).not.toBe('');
      }
      // Both drive the same timeframe selector and mean different things.
      expect(Boolean(def.cycle) && Boolean(def.calendarNames)).toBe(false);
    }
  });
});
