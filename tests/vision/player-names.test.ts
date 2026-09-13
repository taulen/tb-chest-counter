import { describe, expect, it } from 'vitest';
import {
  cleanPlayerName,
  matchKnownPlayer,
  isLikelyNonLatinName,
} from '../../src/vision/player-names.js';

/**
 * Player-name OCR cleanup and fuzzy matching. Pure functions, no I/O.
 */

describe('cleanPlayerName', () => {
  it('strips trailing "Time left" leakage', () => {
    expect(cleanPlayerName('PropofolDoc Time left: 2h')).toBe('PropofolDoc');
  });

  it('strips leading decorator junk without truncating the name', () => {
    expect(cleanPlayerName(') Lucifer )')).toBe('Lucifer');
  });

  it('truncates at the first mid-string junk char', () => {
    expect(cleanPlayerName('Roli girl © a S65) 95.48')).toBe('Roli girl');
  });

  it('strips trailing punctuation', () => {
    expect(cleanPlayerName('Alice.')).toBe('Alice');
    expect(cleanPlayerName('Alice,')).toBe('Alice');
  });
});

describe('isLikelyNonLatinName', () => {
  it('is true for a predominantly non-Latin name', () => {
    expect(isLikelyNonLatinName('أوزيريس')).toBe(true); // Arabic
    expect(isLikelyNonLatinName('Дмитрий')).toBe(true); // Cyrillic
  });

  it('is false for Latin names', () => {
    expect(isLikelyNonLatinName('NailPounder')).toBe(false);
    expect(isLikelyNonLatinName('José')).toBe(false); // accented Latin still Latin
  });

  it('treats a homoglyph-tainted Latin name as Latin', () => {
    // "Аndre" — only the leading А is Cyrillic; 4 Latin letters win.
    expect(isLikelyNonLatinName('Аndre')).toBe(false);
  });

  it('is false for empty / digit-only strings', () => {
    expect(isLikelyNonLatinName('')).toBe(false);
    expect(isLikelyNonLatinName('12345')).toBe(false);
  });
});

describe('matchKnownPlayer', () => {
  it('returns input as-is when no candidates', () => {
    expect(matchKnownPlayer('Alice', [])).toBe('Alice');
  });

  it('matches exact normalized form', () => {
    expect(matchKnownPlayer('alice', ['Alice'])).toBe('Alice');
  });

  it('matches OCR-confused characters (0 ↔ o)', () => {
    expect(matchKnownPlayer('Pr0polf0lDoc', ['PropolfolDoc'])).toBe('PropolfolDoc');
  });

  it('matches a typo within Levenshtein distance', () => {
    expect(matchKnownPlayer('PropofolDok', ['PropofolDoc'])).toBe('PropofolDoc');
  });

  it('rejects short-name collisions where edit distance is 2 of 5 chars', () => {
    // "Niien" → "Biin" edit distance is exactly 2, but they're
    // different players. The threshold scales with length so names
    // shorter than 6 chars require dist ≤ 1.
    expect(matchKnownPlayer('Niien', ['Biin'])).toBe('Niien');
  });

  // Regression: any substring of a long member name used to fragment-
  // match into that member via the old Tier 3 (substring containment).
  it('rejects fragment matches into a long member name', () => {
    expect(matchKnownPlayer('che', ['Avalanche'])).toBe('che');
    expect(matchKnownPlayer('lan', ['Avalanche'])).toBe('lan');
    expect(matchKnownPlayer('anc', ['Avalanche'])).toBe('anc');
    expect(matchKnownPlayer('val', ['Avalanche'])).toBe('val');
    expect(matchKnownPlayer('nche', ['Avalanche'])).toBe('nche');
    expect(matchKnownPlayer('valanc', ['Avalanche'])).toBe('valanc');
  });

  it('does not silently merge OCR with 3+ chars of trailing noise (Tier 3 removed)', () => {
    expect(matchKnownPlayer('PropofolDocXYZ', ['PropofolDoc'])).toBe('PropofolDocXYZ');
  });

  it('still matches OCR with ≤ 2 chars of trailing noise via Levenshtein', () => {
    expect(matchKnownPlayer('PropofolDocXY', ['PropofolDoc'])).toBe('PropofolDoc');
  });

  describe('exact-only candidates (inactive members)', () => {
    // The scan pool is restricted to ACTIVE members so a new player's name can't
    // round to a departed one by distance. That protection has to survive, but it
    // must not let an active neighbour steal a name its owner spells exactly.
    //
    // Real case, months of wrong attribution: "Bardin" is a member who had gone
    // inactive, "Bain" is active, and they are 2 edits apart — inside the budget for
    // a 6-character name. Every Bardin chest was filed under Bain, and because the
    // name resolved to "Bain" it never reached upsertMember('Bardin') to reactivate
    // him, so he could never come back on his own.
    const ACTIVE = ['Bain'];
    const INACTIVE = ['Bardin'];

    it('lets an inactive member win their own name back', () => {
      expect(matchKnownPlayer('Bardin', ACTIVE)).toBe('Bain');            // the bug
      expect(matchKnownPlayer('Bardin', ACTIVE, INACTIVE)).toBe('Bardin'); // fixed
    });

    it('does not take a name away from the active member who owns it', () => {
      expect(matchKnownPlayer('Bain', ACTIVE, INACTIVE)).toBe('Bain');
    });

    it('still refuses to fuzzy-match a new name onto an inactive member', () => {
      // The reason the pool was restricted in the first place. "Bardim" is 1 edit
      // from inactive "Bardin", but inactive members are exact-only — so this must
      // fall through as a new player rather than reviving a departed one.
      expect(matchKnownPlayer('Bardim', [], INACTIVE)).toBe('Bardim');
    });

    it('applies the homoglyph tier to inactive members too', () => {
      // Tier 2 is an exact match under OCR folding, so it belongs to the same
      // broad candidate set: 0↔o must resolve an inactive member's real name.
      expect(matchKnownPlayer('mimo0000', [], ['mimooooo'])).toBe('mimooooo');
    });

    it('is unchanged when no exact-only names are supplied', () => {
      expect(matchKnownPlayer('Bardin', ACTIVE, [])).toBe('Bain');
    });
  });

  describe('non-Latin names', () => {
    it('matches an exact Arabic name against the member list', () => {
      // The Latin normalizers strip Arabic to nothing — this must go
      // through the dedicated non-Latin path instead of bailing.
      expect(matchKnownPlayer('أوزيريس', ['Alice', 'أوزيريس'])).toBe('أوزيريس');
    });

    it('matches a noisy Arabic OCR read within edit distance', () => {
      // One letter dropped — Levenshtein distance 1, name ≥ 6 chars.
      expect(matchKnownPlayer('أوزيري', ['أوزيريس'])).toBe('أوزيريس');
    });

    it('ignores Arabic diacritics / bidi marks when matching', () => {
      expect(matchKnownPlayer('‏أوزيريس‎', ['أوزيريس'])).toBe('أوزيريس');
    });

    it('does not match a Latin OCR garbage string to an Arabic member', () => {
      expect(matchKnownPlayer('gs sow', ['أوزيريس'])).toBe('gs sow');
    });

    it('returns the input when no non-Latin member is close enough', () => {
      expect(matchKnownPlayer('أوزيريس', ['Alice', 'Bob'])).toBe('أوزيريس');
    });
  });
});
