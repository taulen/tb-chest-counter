import { describe, expect, it } from 'vitest';
import { despace, foldDiacritics } from '../../src/utils/name-normalize.js';

describe('foldDiacritics', () => {
  it('folds the game\'s accented names onto the config\'s spelling instead of dropping the letter', () => {
    expect(foldDiacritics("Jörmungandr's Chest")).toBe("Jormungandr's Chest");
    expect(foldDiacritics('Crème À la mode')).toBe('Creme A la mode');
    expect(foldDiacritics('Микам')).toBe('Микам'); // no Latin base letter to fold to
  });
});

describe('despace', () => {
  it('keeps letters and digits only, folded and lowercased', () => {
    expect(despace('J I Z Z I C A')).toBe('jizzica');
    expect(despace('Jörmungandr Shop')).toBe('jormungandrshop');
    expect(despace('FELI 2')).toBe('feli2');
  });
});
