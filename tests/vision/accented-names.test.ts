import { describe, expect, it } from 'vitest';
import { containsKnownChestName, correctChestName, getChestRarity } from '../../src/vision/chest-names.js';
import { canonicalSourceKey, getSourceKey } from '../../src/vision/source-names.js';
import { foldDiacritics, ocrNormalize } from '../../src/vision/ocr-normalize.js';

/**
 * An accent must FOLD onto its base letter, never be deleted.
 *
 * The strip-don't-fold bug was visible in production: the game's "Jörmungandr" reached the
 * chest catalog as "jrmungandrs chest" against a catalog entry of "jormungandrs chest", so
 * one missing letter kept them apart and the same chest was recorded under two names — 57
 * rows as "Jormungandr's Chest", 24 as "Jörmungandr's Chest", each scoring separately. The
 * source-key slug had the identical hole and produced "epic j rmungandr squad".
 */
describe('accented characters in OCR names', () => {
  it('folds a diacritic onto its base letter rather than dropping it', () => {
    expect(foldDiacritics('Jörmungandr')).toBe('Jormungandr');
    expect(foldDiacritics('LORD DRÁCON')).toBe('LORD DRACON');
    expect(foldDiacritics('SABÃO II')).toBe('SABAO II');
    expect(foldDiacritics('chaφs')).toBe('chaφs'); // not a diacritic — left alone
  });

  it('normalises an accented chest name onto the same form as its plain spelling', () => {
    expect(ocrNormalize("Jörmungandr's Chest")).toBe(ocrNormalize("Jormungandr's Chest"));
  });

  describe('chest names', () => {
    it('maps both spellings onto the one catalog name', () => {
      // The game spells it with the umlaut, so that is canonical — and the plain reading
      // still has to land on it.
      expect(correctChestName("Jörmungandr's Chest")).toBe("Jörmungandr's Chest");
      expect(correctChestName("Jormungandr's Chest")).toBe("Jörmungandr's Chest");
    });

    it('gives both spellings the same rarity, so scoring cannot diverge', () => {
      expect(getChestRarity("Jörmungandr's Chest")).toBe(getChestRarity("Jormungandr's Chest"));
    });

    it('recognises the name as a chest word either way round', () => {
      // The panel-header heuristic builds its token list from the catalog, so both the tokens
      // and the text it tests have to be folded or an accented name misses its own token.
      expect(containsKnownChestName('you opened a Jörmungandr chest')).toBe(true);
      expect(containsKnownChestName('you opened a Jormungandr chest')).toBe(true);
    });

    it('still refuses to map an unrelated name onto a catalog entry', () => {
      // Folding must not make the matcher greedier: this is not a catalog chest and has to
      // survive as itself so the review queue picks it up.
      expect(correctChestName('Zärgothian Trinket')).toBe('Zärgothian Trinket');
    });
  });

  describe('source keys', () => {
    it('keeps the letter instead of turning the accent into a gap', () => {
      expect(getSourceKey('Epic Jörmungandr squad')).toBe('epic jormungandr squad');
    });

    it('gives an accented and an unaccented reading of a squad the same key', () => {
      // The pair that split one squad into two groups on the source-points page. Both
      // halves matter: the accent has to fold, AND the plain-o reading must not be
      // swallowed by the Jörmungandr SHOP rule.
      expect(getSourceKey('Epic Jörmungandr squad')).toBe('epic jormungandr squad');
      expect(getSourceKey('Epic Jormungandr squad')).toBe('epic jormungandr squad');
    });

    it('still sends the actual shop to the shop key', () => {
      expect(getSourceKey('Jormungandr Shop')).toBe('jormungandr shop');
      expect(getSourceKey('Jörmungandr Shop')).toBe('jormungandr shop');
    });

    it('leaves the structured matchers alone', () => {
      // Folding is applied only in the slug fallback, so an accented source cannot fall
      // through into a name-match rule and take its chests' points with it.
      expect(getSourceKey('Epic Crypt level 30')).toBe('epic 30');
      expect(getSourceKey('Cursed Citadel level 12')).toBe('cursed citadel 12');
      expect(getSourceKey('Arena')).toBe('arena');
    });

    it('matches an accented key against its folded form', () => {
      expect(canonicalSourceKey('Jörmungandr Shop')).toBe(canonicalSourceKey('jormungandr shop'));
    });

    it('still rejects noise', () => {
      expect(getSourceKey('ö')).toBeNull();
      expect(getSourceKey('123')).toBeNull();
    });
  });
});
