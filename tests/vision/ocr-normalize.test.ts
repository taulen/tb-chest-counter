import { describe, expect, it } from 'vitest';
import {
  ocrNormalize,
  normalizeNonLatin,
  transliterateCyrillicHomoglyphs,
  levenshtein,
  namesDifferByAltSuffix,
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

/**
 * The rule that separates an alt account from OCR damage. Every matcher in the
 * project consults it, so the cases live here rather than being restated per caller.
 *
 * Roster names below are real ones from the Sep 5 backup.
 */
describe('namesDifferByAltSuffix', () => {
  it('separates a numeric alt from the name it is suffixed from', () => {
    expect(namesDifferByAltSuffix('FELI 2', 'FELI')).toBe(true);
    expect(namesDifferByAltSuffix('FELI', 'FELI 2')).toBe(true);
    expect(namesDifferByAltSuffix('FELI2', 'FELI')).toBe(true);
    expect(namesDifferByAltSuffix('Toupie2', 'Toupie')).toBe(true);
    expect(namesDifferByAltSuffix('Kurt 2', 'Kurt 3')).toBe(true);
  });

  it('separates a 2+ character roman-numeral alt', () => {
    expect(namesDifferByAltSuffix('FLOKI II', 'FLOKI')).toBe(true);
    expect(namesDifferByAltSuffix('Morarn III', 'Morarn')).toBe(true);
    expect(namesDifferByAltSuffix('Somename IV', 'Somename')).toBe(true);
  });

  it('stays silent on a single trailing i, v or x — those are name endings', () => {
    // Also the commonest character for OCR to drop, so treating one as identity
    // would split a real member in two.
    expect(namesDifferByAltSuffix('Levi', 'Lev')).toBe(false);
    expect(namesDifferByAltSuffix('Max', 'Ma')).toBe(false);
  });

  it('stays silent on the digits that stand in for letters', () => {
    // 0→o, 5→s, 1→l, 8→b: a difference in one of these is OCR damage, and the
    // matchers must stay free to repair it.
    expect(namesDifferByAltSuffix('050', 'oSo')).toBe(false);
    expect(namesDifferByAltSuffix('Toup1e', 'Toupie')).toBe(false);
    expect(namesDifferByAltSuffix('bacardy1', 'bacardy')).toBe(false);
    expect(namesDifferByAltSuffix('Sezot0', 'Sezoto')).toBe(false);
  });

  it('is silent on two unrelated names and on the same name twice', () => {
    // It answers "are these separate accounts", not "are these the same player" —
    // an unrelated pair is left for distance to reject.
    expect(namesDifferByAltSuffix('Bain', 'Fain')).toBe(false);
    expect(namesDifferByAltSuffix('alex21rus', 'alex21rus')).toBe(false);
    expect(namesDifferByAltSuffix('Warrior 1977', 'War rior 1977')).toBe(false);
    expect(namesDifferByAltSuffix('', 'FELI')).toBe(false);
  });

  it('applies to non-Latin names, which despace would flatten to nothing', () => {
    expect(namesDifferByAltSuffix('علي 2', 'علي')).toBe(true);
    expect(namesDifferByAltSuffix('علي', 'علي')).toBe(false);
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
