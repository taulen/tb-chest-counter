import { describe, expect, it } from 'vitest';
import { compareGifts, normalizeGiftText } from '../../src/game-protocol/compare.js';
import { captureEnabledFor } from '../../src/game-protocol/enabled.js';

describe('per-clan capture setting', () => {
  it('reads ids, "all" and empty', () => {
    expect(captureEnabledFor('2', 2)).toBe(true);
    expect(captureEnabledFor('2', 5)).toBe(false);
    expect(captureEnabledFor(' 2, 5 ', 5)).toBe(true);
    expect(captureEnabledFor('all', 9)).toBe(true);
    expect(captureEnabledFor('', 2)).toBe(false);
  });
});

describe('game vs OCR gift comparison', () => {
  it('normalises the spellings OCR and the game differ on', () => {
    expect(normalizeGiftText('Lvl 25-29 Vault of the Ancients')).toBe(normalizeGiftText('Level 25–29 Vault of the Ancients'));
    expect(normalizeGiftText('Fiin SK 3')).toBe(normalizeGiftText('fiin sk3'));
  });

  it('matches duplicates one for one and sorts the leftovers', () => {
    const game = [
      { sender: 'ZULU SK', chest: 'Barbarian Chest', source: 'Level 20 Crypt' },
      { sender: 'ZULU SK', chest: 'Barbarian Chest', source: 'Level 20 Crypt' },
      { sender: 'Fiin SK 3', chest: 'Sapphire Chest', source: 'Level 25–29 Vault of the Ancients' },
      { sender: 'Кордобрек', chest: 'Mayan Chest', source: 'Level 15 Crypt' },
      { sender: 'Hunter sk', chest: 'Rare Dragon Chest', source: 'Level 15 rare Crypt' },
    ];
    const capture = 1_794_870_000;
    const ocr = [
      { sender: 'ZULU SK', chest: 'Barbarian Chest', source: 'Level 20 Crypt', at: capture - 1000 },
      { sender: 'ZULU SK', chest: 'Barbarian Chest', source: 'Level 20 Crypt', at: capture - 990 },
      { sender: 'Fiin SK 3', chest: 'Sapphire Chest', source: 'Lvl 25-29 Vault of the Ancients', at: capture - 980 },
      // OCR transliterated a Cyrillic name: same chest + source, different sender.
      { sender: 'Kordobrek', chest: 'Mayan Chest', source: 'Level 15 Crypt', at: capture - 970 },
      // Arrived after the game capture — can only be on the OCR side.
      { sender: 'Goth Babe', chest: 'Golden Chest', source: 'Bank', at: capture + 300 },
      // Arrived in the capture's minute: OCR's minute-resolution clock puts it
      // a few seconds BEFORE the capture, but it still counts as late.
      { sender: 'Chaotic Sugman', chest: 'Elven Citadel Chest', source: 'Level 15 Citadel', at: capture - 2 },
    ];
    const c = compareGifts(game, ocr, capture);
    expect(c).toMatchObject({ game: 5, ocr: 6, matched: 3, misreads: 1, ocrOnly: 0, ocrLate: 2, gameOnly: 1 });
    expect(c.details.misreads[0]).toContain('OCR "Kordobrek" vs game "Кордобрек"');
    expect(c.details.gameOnly).toEqual(['Hunter sk | Rare Dragon Chest | Level 15 rare Crypt']);
  });
});
