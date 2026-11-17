import { describe, expect, it } from 'vitest';
import {
  KNOWN_CHESTS,
  correctChestName,
  getChestRarity,
} from '../../src/data/chest-names.js';
import { ChestType } from '../../src/models/enums.js';

/**
 * Chest-name correction and the canonical catalog. Pure functions (no DB,
 * no I/O): correctChestName still canonicalises every stored chest name,
 * including the ones the retired OCR scanner wrote, so given identical
 * inputs they must keep producing identical strings.
 */

describe('correctChestName', () => {
  it('returns canonical name unchanged', () => {
    expect(correctChestName('Stone Chest')).toBe('Stone Chest');
  });

  it('strips leading bracket+digits artefacts', () => {
    expect(correctChestName('7] Orc Chest')).toBe('Orc Chest');
  });

  it('strips leading punctuation artefacts', () => {
    expect(correctChestName('™ Barbarian Chest')).toBe('Barbarian Chest');
    expect(correctChestName('| Elegant Chest')).toBe('Elegant Chest');
  });

  it('fixes the most common letter swaps', () => {
    expect(correctChestName('Sarbarian Chest')).toBe('Barbarian Chest');
    expect(correctChestName('Ore Chest')).toBe('Orc Chest');
    expect(correctChestName('eplc Chest of Wealth')).toBe('Epic Chest of Wealth');
  });

  it('matches case-insensitively', () => {
    expect(correctChestName('stone chest')).toBe('Stone Chest');
    expect(correctChestName('STONE CHEST')).toBe('Stone Chest');
  });

  it('falls back to OCR-normalized fuzzy match', () => {
    // "Priests" (no apostrophe) should still resolve to "Priest's Chest"
    expect(correctChestName('Priests Chest')).toBe("Priest's Chest");
  });

  it('resolves a Cyrillic-homoglyph-tainted chest name', () => {
    // "Sтоnе Chest" — т/о/е are Cyrillic; must still resolve to canonical.
    expect(correctChestName('Sтоnе Chest')).toBe('Stone Chest');
  });

  it('returns the cleaned input when no known match exists', () => {
    expect(correctChestName('Unknown XYZ')).toBe('Unknown XYZ');
  });
});

describe('getChestRarity', () => {
  it('returns the rarity for known chests', () => {
    expect(getChestRarity('Stone Chest')).toBe(ChestType.COMMON);
    expect(getChestRarity('Magic Chest')).toBe(ChestType.LEGENDARY);
    expect(getChestRarity("Gladiator's Chest")).toBe(ChestType.ARENA);
  });

  it('falls back to COMMON for unknown chests (so points still resolve)', () => {
    expect(getChestRarity('Some Random Chest')).toBe(ChestType.COMMON);
  });
});

describe('KNOWN_CHESTS catalog sanity', () => {
  it('every entry maps to a real ChestType', () => {
    const validTypes = new Set(Object.values(ChestType));
    for (const [name, type] of Object.entries(KNOWN_CHESTS)) {
      expect(validTypes.has(type), `${name} → ${type} is not a ChestType`).toBe(true);
    }
  });

  it('has at least one entry for each rarity tier we care about', () => {
    const types = new Set(Object.values(KNOWN_CHESTS));
    expect(types.has(ChestType.COMMON)).toBe(true);
    expect(types.has(ChestType.RARE)).toBe(true);
    expect(types.has(ChestType.EPIC)).toBe(true);
    expect(types.has(ChestType.LEGENDARY)).toBe(true);
    expect(types.has(ChestType.ARENA)).toBe(true);
  });
});
