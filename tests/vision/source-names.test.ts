import { describe, expect, it } from 'vitest';
import {
  cleanSource,
  getSourceKey,
  getDefaultPointsForKey,
  isKnownSourceKey,
  getPointsFromSource,
  parseSourceLevelRange,
  canonicalSourceKey,
  sourceSpellingKey,
} from '../../src/vision/source-names.js';

/**
 * Chest-source OCR cleanup, canonical source keys, and point lookups.
 * Pure functions, no I/O.
 */

describe('cleanSource', () => {
  it('strips trailing Open button text', () => {
    expect(cleanSource('Level 25 Crypt [Open]')).toBe('Level 25 Crypt');
    expect(cleanSource('Level 25 Crypt Open')).toBe('Level 25 Crypt');
  });

  it('fixes the eplc → epic OCR misread', () => {
    expect(cleanSource('Level 25 eplc Crypt')).toBe('Level 25 epic Crypt');
  });

  it('strips trailing 1-2-letter OCR junk like "EE"', () => {
    expect(cleanSource('Level 25 Crypt EE')).toBe('Level 25 Crypt');
  });
});

describe('getSourceKey', () => {
  it('extracts crypt + level keys', () => {
    expect(getSourceKey('Level 25 Crypt')).toBe('common 25');
    expect(getSourceKey('Level 20 epic Crypt')).toBe('epic 20');
    expect(getSourceKey('Level 30 rare Crypt')).toBe('rare 30');
  });

  it('extracts citadel keys with cursed/elven distinction', () => {
    expect(getSourceKey('Elven Citadel level 25')).toBe('elven citadel 25');
    expect(getSourceKey('Cursed Citadel level 25')).toBe('cursed citadel 25');
  });

  it('handles the lvl shorthand', () => {
    expect(getSourceKey('lvl 30 vault')).toBe('vault 30');
  });

  it('returns null for noise', () => {
    expect(getSourceKey('')).toBeNull();
    expect(getSourceKey('!@#')).toBeNull();
  });

  it('slugifies unknown source types', () => {
    expect(getSourceKey('Some Custom Source')).toBe('some custom source');
  });
});

describe('isKnownSourceKey', () => {
  it('recognises structured keys', () => {
    expect(isKnownSourceKey('common 25')).toBe(true);
    expect(isKnownSourceKey('epic 20')).toBe(true);
    expect(isKnownSourceKey('elven citadel 25')).toBe(true);
    expect(isKnownSourceKey('arena')).toBe(true);
  });

  it('rejects slugified fallbacks', () => {
    expect(isKnownSourceKey('some custom source')).toBe(false);
  });
});

describe('parseSourceLevelRange', () => {
  it('returns the full tier range for ranged sources', () => {
    expect(parseSourceLevelRange('Lvl 20-24 Raid Runic Squad')).toBe('20-24');
    expect(parseSourceLevelRange('Lvl 25-29 Raid Runic Squad')).toBe('25-29');
  });

  it('accepts a plain space between the two numbers (OCR variant)', () => {
    expect(parseSourceLevelRange('Lvl 30 34 Raid Runic Squad')).toBe('30-34');
  });

  it('falls back to the single level when there is no adjacent second number', () => {
    expect(parseSourceLevelRange('Level 25 Crypt')).toBe('25');
    expect(parseSourceLevelRange('level 16 heroic monster')).toBe('16');
  });

  it('returns null when there is no level', () => {
    expect(parseSourceLevelRange('')).toBeNull();
    expect(parseSourceLevelRange('Arena')).toBeNull();
  });
});

describe('getDefaultPointsForKey & getPointsFromSource', () => {
  it('looks up the canonical point value', () => {
    expect(getDefaultPointsForKey('epic 25')).toBe(450);
    expect(getDefaultPointsForKey('arena')).toBe(10);
  });

  it('returns 0 for null or unknown keys', () => {
    expect(getDefaultPointsForKey(null)).toBe(0);
    expect(getDefaultPointsForKey('made up key')).toBe(0);
  });

  it('end-to-end: getPointsFromSource(rawSource) → number', () => {
    expect(getPointsFromSource('Level 25 epic Crypt')).toBe(450);
    expect(getPointsFromSource('arena')).toBe(10);
  });
});

describe('space-insensitive source keys (PaddleOCR drops inter-word spaces)', () => {
  it('canonicalSourceKey collapses spacing/punctuation', () => {
    expect(canonicalSourceKey('Clan Wealth')).toBe('clanwealth');
    expect(canonicalSourceKey('ClanWealth')).toBe('clanwealth');
    expect(canonicalSourceKey('Level 10 rare Crypt')).toBe('level10rarecrypt');
    expect(canonicalSourceKey("Arachne's Swarm Epic Squad")).toBe('arachnesswarmepicsquad');
  });

  it('structured sources score identically with or without spaces', () => {
    // PaddleOCR emits "Level10rareCrypt" etc.
    expect(getSourceKey('Level10rareCrypt')).toBe('rare 10');
    expect(getSourceKey('Level5Crypt')).toBe('common 5');
    expect(getPointsFromSource('Level10rareCrypt')).toBe(getPointsFromSource('Level 10 rare Crypt'));
  });

  it('slug-fallback sources resolve their default points despite missing spaces', () => {
    // The hardcoded table keys are spaced ("clan wealth" = 10); a spaceless
    // slug key from PaddleOCR must still find the value.
    expect(getDefaultPointsForKey('clanwealth')).toBe(getDefaultPointsForKey('clan wealth'));
    expect(getDefaultPointsForKey('clanwealth')).toBe(1);
    expect(getDefaultPointsForKey('lvl3034raidrunicsquad')).toBe(30);
  });

  describe('sourceSpellingKey', () => {
    // Row identity, not scoring. Every pair below is a real duplicate that was
    // sitting in production as two separate chest_sources rows (11 pairs total),
    // splitting one source across two entries in analytics and drill-downs.
    it.each([
      ['Jörmungandr Shop', 'Jormungandr Shop'],
      ['Epic Jörmungandr squad', 'Epic Jormungandr squad'],
      ["Hermes' Store", 'Hermes’ Store'],
      ['Sakura of Plenty', 'Sakura of Plenty‏'],
      ['Level 10 Crypt', 'Level10 Crypt'],
      ['Level 10 rare Crypt', 'Level10 rare Crypt'],
      ['Level 15 epic Crypt', 'Level15 epic Crypt'],
      ['Lvl 35-39 Vault of the Ancients', 'Level 35-39 Vault of the Ancients'],
      ['Lvl 40-44 Vault of the Ancients', 'Level 40-44 Vault of the Ancients'],
    ])('treats "%s" and "%s" as one source', (a, b) => {
      expect(sourceSpellingKey(a)).toBe(sourceSpellingKey(b));
    });

    it('folds the glued PaddleOCR reading of Lvl, where a word boundary would not fire', () => {
      expect(sourceSpellingKey('Lvl35-39Vault')).toBe(sourceSpellingKey('Level 35-39 Vault'));
    });

    it('keeps two genuinely different sources apart even when they score the same', () => {
      // Both derive getSourceKey "common 10" — same points, same admin bucket,
      // different in-game source. Grouping rows on the derived key would fuse them.
      expect(getSourceKey('Level 10 Crypt')).toBe(getSourceKey('Tartaros Crypt level 10'));
      expect(sourceSpellingKey('Level 10 Crypt')).not.toBe(sourceSpellingKey('Tartaros Crypt level 10'));
    });

    it('is stricter than canonicalSourceKey only where scoring does not care', () => {
      // canonicalSourceKey stays as it is because it keys live scoring config;
      // the Lvl/Level fold is the one thing this adds on top.
      expect(canonicalSourceKey('Lvl 35-39 Vault')).not.toBe(canonicalSourceKey('Level 35-39 Vault'));
      expect(sourceSpellingKey('Lvl 35-39 Vault')).toBe(sourceSpellingKey('Level 35-39 Vault'));
    });
  });
});
