import { describe, expect, it } from 'vitest';
import {
  CHEST_TYPES,
  chestTypeFor,
  declaredChestType,
  TRIUMPHAL_PACKAGE_POINTS,
} from '../../src/data/chest-names.js';
import { ChestType } from '../../src/models/enums.js';

/**
 * The site's chest types. Chest names come from the game exactly, so there is
 * no name catalog or spelling correction any more — only the categorisation
 * the game has no equivalent for (see the CHEST_TYPES comment).
 */

describe('chestTypeFor', () => {
  it('returns the declared type', () => {
    expect(chestTypeFor('Magic Chest')).toBe(ChestType.LEGENDARY);
    expect(chestTypeFor("Gladiator's Chest")).toBe(ChestType.ARENA);
    expect(chestTypeFor('Harpy Chest')).toBe(ChestType.EPIC);
    expect(chestTypeFor('Rare Dragon Chest')).toBe(ChestType.RARE);
  });

  it('calls everything it does not list common', () => {
    expect(chestTypeFor('Stone Chest')).toBe(ChestType.COMMON);
    expect(chestTypeFor('Wooden Chest')).toBe(ChestType.COMMON);
    expect(chestTypeFor('Some New Event Chest')).toBe(ChestType.COMMON);
  });

  it('matches the exact name only — the game spells every chest one way', () => {
    // The OCR-era corrector folded case and misreads ("Ore Chest" → Orc Chest);
    // nothing produces those any more, so nothing folds them.
    expect(chestTypeFor('magic chest')).toBe(ChestType.COMMON);
    expect(declaredChestType('magic chest')).toBeUndefined();
  });

  it('is not fooled by Object.prototype names', () => {
    expect(declaredChestType('constructor')).toBeUndefined();
    expect(chestTypeFor('__proto__')).toBe(ChestType.COMMON);
  });
});

describe('CHEST_TYPES', () => {
  it('lists only real, non-common types', () => {
    // Common is the default; listing it would only hide which entries matter.
    const valid = new Set(Object.values(ChestType));
    for (const [name, type] of Object.entries(CHEST_TYPES)) {
      expect(valid.has(type), `${name} → ${type} is not a ChestType`).toBe(true);
      expect(type, `${name} is common, the default — drop it`).not.toBe(ChestType.COMMON);
    }
  });

  it('types every seeded Bank chest by its package, Wooden being common', () => {
    expect(Object.keys(TRIUMPHAL_PACKAGE_POINTS).map((n) => [n, chestTypeFor(n)])).toEqual([
      ['Magic Chest', ChestType.LEGENDARY],
      ['Precious Chest', ChestType.LEGENDARY],
      ['Golden Chest', ChestType.EPIC],
      ['Silver Chest', ChestType.RARE],
      ['Bronze Chest', ChestType.UNCOMMON],
      ['Wooden Chest', ChestType.COMMON],
      ["Conqueror's Chest", ChestType.COMMON],
    ]);
  });
});
