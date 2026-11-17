import { describe, expect, it } from 'vitest';
import { normalizeGiftText } from '../../src/game-protocol/gift-text.js';

describe('normalizeGiftText', () => {
  it('normalises the spellings stored rows and the game differ on', () => {
    expect(normalizeGiftText('Lvl 25-29 Vault of the Ancients')).toBe(normalizeGiftText('Level 25–29 Vault of the Ancients'));
    expect(normalizeGiftText('Fiin SK 3')).toBe(normalizeGiftText('fiin sk3'));
  });
});
