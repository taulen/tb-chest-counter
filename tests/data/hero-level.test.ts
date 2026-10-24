import { describe, expect, it } from 'vitest';
import { saneHeroLevel } from '../../src/data/hero-level.js';

describe('saneHeroLevel', () => {
  it('reads a four-digit badge as the ornament glued onto three real digits', () => {
    // Every four-digit reading in production, against its member's neighbouring days.
    expect(saneHeroLevel(7147, 141_205_461)).toBe(147);
    expect(saneHeroLevel(1357, 890_142_505)).toBe(357);
    expect(saneHeroLevel(1307, 604_166_821)).toBe(307);
    expect(saneHeroLevel(1240, 328_018_990)).toBe(240);
  });

  it('rejects a level far too low for the might on the same row', () => {
    expect(saneHeroLevel(38, 213_517_185)).toBeNull();
    expect(saneHeroLevel(3, 145_000_000)).toBeNull();
    expect(saneHeroLevel(20, 241_158_231)).toBeNull();
  });

  it('keeps every level a real player of that might has been seen holding', () => {
    expect(saneHeroLevel(58, 110_000_000)).toBe(58); // the highest ratio held for days
    expect(saneHeroLevel(93, 43_145_291)).toBe(93);
    expect(saneHeroLevel(414, 1_500_000_000)).toBe(414);
    expect(saneHeroLevel(5, 500_000)).toBe(5);
  });

  it('treats no reading and no might as what they are', () => {
    expect(saneHeroLevel(null, 1_000_000)).toBeNull();
    expect(saneHeroLevel(0, 1_000_000)).toBeNull();
    expect(saneHeroLevel(38, 0)).toBe(38);
  });
});
