import { describe, expect, it } from 'vitest';
import {
  ocrNormalize,
  normalizeNonLatin,
  transliterateCyrillicHomoglyphs,
  levenshtein,
} from '../../src/vision/ocr-normalize.js';

/**
 * Shared OCR text-matching primitives. Pure functions, no I/O — these
 * underpin both the chest-name and player-name fuzzy matchers.
 */

describe('ocrNormalize', () => {
  it('lowercases and strips non-alpha', () => {
    expect(ocrNormalize("Priest's Chest")).toBe('priests chest');
  });

  it('maps OCR-confusable digits onto letters', () => {
    expect(ocrNormalize('0rc Chest')).toBe('orc chest');
    expect(ocrNormalize('5tone Chest')).toBe('stone chest');
    expect(ocrNormalize('1nferno')).toBe('lnferno'); // 1 → l
    expect(ocrNormalize('!nferno')).toBe('inferno');
    expect(ocrNormalize('8ronze')).toBe('bronze');
  });

  it('collapses whitespace', () => {
    expect(ocrNormalize('  Stone   Chest  ')).toBe('stone chest');
  });

  it('collapses Cyrillic homoglyphs onto their Latin lookalikes', () => {
    // "Sтоnе" — the т, о and е are Cyrillic (U+0442/043E/0435), a
    // misread the multi-lang Tesseract worker routinely produces.
    expect(ocrNormalize('Sтоnе Chest')).toBe('stone chest');
    // "Аndrе" — leading А and trailing е are Cyrillic.
    expect(ocrNormalize('Аndrе')).toBe('andre');
  });
});

describe('transliterateCyrillicHomoglyphs', () => {
  it('maps Cyrillic lookalikes to Latin and leaves real Latin alone', () => {
    expect(transliterateCyrillicHomoglyphs('Sтоnе')).toBe('Stone');
    expect(transliterateCyrillicHomoglyphs('Stone')).toBe('Stone');
  });

  it('leaves genuine Cyrillic letters with no Latin lookalike untouched', () => {
    // Ж, л, д have no Latin homoglyphs — must not be transliterated.
    expect(transliterateCyrillicHomoglyphs('Жлд')).toBe('Жлд');
  });
});

describe('normalizeNonLatin', () => {
  it('lowercases and strips whitespace + punctuation', () => {
    expect(normalizeNonLatin('  Ali  ')).toBe('ali');
    expect(normalizeNonLatin('a.b-c')).toBe('abc');
  });

  it('strips invisible bidi / format marks that leak into OCR Arabic', () => {
    // U+200F RIGHT-TO-LEFT MARK wrapped around the name.
    expect(normalizeNonLatin('‏علي‎')).toBe('علي');
  });

  it('strips Arabic combining diacritics (harakat / tanwin)', () => {
    // Same base letters, one with a tanwin mark (U+064B) — must collapse.
    expect(normalizeNonLatin('سيريزواً')).toBe(normalizeNonLatin('سيريزوا'));
  });
});

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('counts single-edit distances', () => {
    expect(levenshtein('abc', 'abd')).toBe(1); // substitution
    expect(levenshtein('abc', 'ab')).toBe(1);  // deletion
    expect(levenshtein('abc', 'abcd')).toBe(1); // insertion
  });
});
