import { describe, expect, it } from 'vitest';
import { foldDiacritics } from '../../src/utils/name-normalize.js';

describe('foldDiacritics', () => {
  it('folds an accent for the point-key slug instead of dropping the letter', () => {
    expect(foldDiacritics("Jörmungandr's Chest")).toBe("Jormungandr's Chest");
    expect(foldDiacritics('Crème À la mode')).toBe('Creme A la mode');
    expect(foldDiacritics('Микам')).toBe('Микам'); // no Latin base letter to fold to
  });
});
