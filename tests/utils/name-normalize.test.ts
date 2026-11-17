import { describe, expect, it } from 'vitest';
import {
  transliterateCyrillicHomoglyphs,
  namesDifferByAltSuffix,
} from '../../src/utils/name-normalize.js';

/**
 * Shared name-matching primitives. Pure functions, no I/O — these
 * underpin the member-name matcher and the merge rules.
 */

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

  it('stays silent on a digit SUBSTITUTED for a letter', () => {
    // 0→o, 5→s, 1→l, 8→b, 9→g: a digit standing where a letter stands is OCR damage,
    // and the matchers must stay free to repair it. Every case here keeps its length.
    expect(namesDifferByAltSuffix('050', 'oSo')).toBe(false);
    expect(namesDifferByAltSuffix('Toup1e', 'Toupie')).toBe(false);
    expect(namesDifferByAltSuffix('Me9rond', 'Megrond')).toBe(false);
    expect(namesDifferByAltSuffix('Sezot0', 'Sezoto')).toBe(false);
    expect(namesDifferByAltSuffix('mimo0000', 'mimooooo')).toBe(false);
  });

  it('separates a digit APPENDED to a whole name, whatever the digit', () => {
    // The other half of the same coin: no OCR error bolts a digit onto a name that is
    // otherwise intact, so an appended one is the alt convention even when it is one
    // of the five that get folded above. All three are live roster names whose base
    // name joining the clan would otherwise be absorbed into them.
    expect(namesDifferByAltSuffix('Cordarus 1', 'Cordarus')).toBe(true);
    expect(namesDifferByAltSuffix('bacardy1', 'bacardy')).toBe(true);
    expect(namesDifferByAltSuffix('Stafford85', 'Stafford')).toBe(true);
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
