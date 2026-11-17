import { describe, expect, it } from 'vitest';
import { canonicalSourceKey, getSourceKey } from '../../src/data/source-names.js';
import { foldDiacritics } from '../../src/utils/name-normalize.js';

/**
 * An accent must FOLD onto its base letter, never be deleted.
 *
 * The strip-don't-fold bug was visible in production: the game's "Jörmungandr" reached the
 * (since retired) chest catalog as "jrmungandrs chest" against a catalog entry of
 * "jormungandrs chest", so one missing letter kept them apart and the same chest was
 * recorded under two names. The source-key slug had the identical hole and produced
 * "epic j rmungandr squad".
 */
describe('accented characters in names', () => {
  it('folds a diacritic onto its base letter rather than dropping it', () => {
    expect(foldDiacritics('Jörmungandr')).toBe('Jormungandr');
    expect(foldDiacritics('LORD DRÁCON')).toBe('LORD DRACON');
    expect(foldDiacritics('SABÃO II')).toBe('SABAO II');
    expect(foldDiacritics('chaφs')).toBe('chaφs'); // not a diacritic — left alone
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
