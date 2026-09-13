/**
 * Pins the seeded scoring table against the name/key derivations it is read
 * through.
 *
 * SOURCE_CHEST_POINTS is name-keyed config, so it fails the same way every
 * other name-keyed surface in this repo fails: silently, as a zero that reads
 * like a result. A chest spelled differently from what `correctChestName`
 * produces can never match a `chests` row — cleanupChestNames reconciles every
 * row through that function on each boot — so the entry simply never fires and
 * the chest scores the source-wide default instead. Nothing logs. Same class of
 * bug as the Ragnarok/Jörmungandr rename, and the same fix as
 * tests/config/event-catalog.test.ts: assert the spelling here, in a pure test
 * that runs as part of `npm run build`.
 *
 * The source-key half has its own trap: keys are matched through
 * `canonicalSourceKey` (spacing and accents folded), so two keys that look
 * distinct here can collide into one bucket, and whichever loses is dead
 * config.
 */

import { describe, it, expect } from 'vitest';
import {
  SOURCE_CHEST_POINTS,
  SOURCE_POINT_KEYS,
  canonicalSourceKey,
  getDefaultPointsFor,
  getDefaultPointsForKey,
} from '../../src/vision/source-names.js';
import { correctChestName } from '../../src/vision/chest-names.js';

describe('seeded source point values', () => {
  it('spells every chest the way correctChestName does', () => {
    const wrong: string[] = [];
    for (const [sourceKey, byName] of Object.entries(SOURCE_CHEST_POINTS)) {
      for (const chestName of Object.keys(byName)) {
        const corrected = correctChestName(chestName);
        if (corrected !== chestName) {
          wrong.push(`${sourceKey}: "${chestName}" should be "${corrected}"`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('has no two source keys that collapse to the same canonical key', () => {
    // Both tables are looked up canonically, so a collision means one of the
    // two entries is unreachable — and which one wins depends on insertion
    // order, which is not something a config file should be deciding.
    const byCanonical = new Map<string, string[]>();
    for (const key of [...SOURCE_POINT_KEYS, ...Object.keys(SOURCE_CHEST_POINTS)]) {
      const canonical = canonicalSourceKey(key);
      const seen = byCanonical.get(canonical) ?? [];
      if (!seen.includes(key)) seen.push(key);
      byCanonical.set(canonical, seen);
    }
    const collisions = [...byCanonical.entries()].filter(([, keys]) => keys.length > 1);
    expect(collisions).toEqual([]);
  });

  it('resolves a per-chest seed ahead of the source-wide default', () => {
    // The Omen chests are the reason this layer exists: one source, three
    // chests, all of rarity `common`, three different values.
    expect(getDefaultPointsForKey('summoning dark omens')).toBe(15);
    expect(getDefaultPointsFor('summoning dark omens', 'Minor Omen Chest')).toBe(50);
    expect(getDefaultPointsFor('summoning dark omens', 'Major Omen Chest')).toBe(100);
    expect(getDefaultPointsFor('summoning dark omens', 'Epic Omen Chest')).toBe(150);
  });

  it('falls back to the source default for a chest it does not name', () => {
    expect(getDefaultPointsFor('summoning dark omens', 'Some New Chest')).toBe(15);
    expect(getDefaultPointsFor('epic 25', '')).toBe(getDefaultPointsForKey('epic 25'));
    expect(getDefaultPointsFor(null, 'Minor Omen Chest')).toBe(0);
  });

  it('matches a per-chest seed through a spaceless PaddleOCR source key', () => {
    // PaddleOCR drops inter-word spaces, so the key arriving at lookup time can
    // be "summoningdarkomens". The chest NAME is not folded — it has already
    // been through correctChestName by then.
    expect(getDefaultPointsFor('summoningdarkomens', 'Epic Omen Chest')).toBe(150);
    expect(getDefaultPointsFor('level35heroicmonster', 'Inferno Chest')).toBe(625);
  });

  it('scores heroic monsters by tier, not by the flat per-level placeholder', () => {
    // The tiers the game actually pays (see EVENT_CATALOG's heroics buckets):
    // 16-19 → 20, 20-24 → 60, 25-29 → 150, 30-34 → 350, 35-39 → 625.
    const tiers: Array<[number, string, number]> = [
      [16, 'Undead Chest', 20],
      [20, 'Inferno Chest', 60],
      [25, 'Inferno Chest', 150],
      [30, 'Inferno Chest', 350],
      [35, 'Inferno Chest', 625],
    ];
    for (const [level, chest, points] of tiers) {
      expect(getDefaultPointsFor(`level ${level} heroic monster`, chest)).toBe(points);
    }
  });
});
