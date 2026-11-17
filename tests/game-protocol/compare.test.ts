import { describe, expect, it } from 'vitest';
import { compareGifts, normalizeGiftText } from '../../src/game-protocol/compare.js';

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
      { sender: 'ZULU SK', chest: 'Barbarian Chest', source: 'Level 20 Crypt', at: capture - 100 },
      { sender: 'ZULU SK', chest: 'Barbarian Chest', source: 'Level 20 Crypt', at: capture - 90 },
      { sender: 'Fiin SK 3', chest: 'Sapphire Chest', source: 'Lvl 25-29 Vault of the Ancients', at: capture - 80 },
      // OCR transliterated a Cyrillic name: same chest + source, different sender.
      { sender: 'Kordobrek', chest: 'Mayan Chest', source: 'Level 15 Crypt', at: capture - 70 },
      // Arrived after the game capture — can only be on the OCR side.
      { sender: 'Goth Babe', chest: 'Golden Chest', source: 'Bank', at: capture + 300 },
    ];
    const c = compareGifts(game, ocr, capture);
    expect(c).toMatchObject({ game: 5, ocr: 5, matched: 3, misreads: 1, ocrOnly: 0, ocrLate: 1, gameOnly: 1 });
    expect(c.details.misreads[0]).toContain('OCR "Kordobrek" vs game "Кордобрек"');
    expect(c.details.gameOnly).toEqual(['Hunter sk | Rare Dragon Chest | Level 15 rare Crypt']);
  });
});
