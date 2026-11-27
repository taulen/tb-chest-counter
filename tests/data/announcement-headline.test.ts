/**
 * Clan announcements' one-line headlines (data/announcement-headline.ts). The
 * shapes are the ones real announcements had on Nov 27 2026; the texts here
 * are made up.
 */
import { describe, expect, it } from 'vitest';
import { announcementHeadline, HEADLINE_MAX_LENGTH } from '../../src/data/announcement-headline.js';

describe('announcement headlines', () => {
  it('skips a line that only greets', () => {
    expect(announcementHeadline('HELLO ORCAS!\n\nWE START A NEW TINMAN SEASON!\n\nSummons at reset +4')).toBe('WE START A NEW TINMAN SEASON!');
    // A short line stays whole; only a long one is cut to its first sentence.
    expect(announcementHeadline('Hey family,\nSome of our gold mines were harvested. Please replace them.')).toBe('Some of our gold mines were harvested. Please replace them.');
    expect(announcementHeadline('Hello, my dear Orca family,\n\nVaults go up after the reset.')).toBe('Vaults go up after the reset.');
    expect(announcementHeadline('Hey Orcas -\n\nMany of us are back.')).toBe('Many of us are back.');
    expect(announcementHeadline('Hello Orcas\n\nSome vaults are still missing.')).toBe('Some vaults are still missing.');
  });

  it('skips a one- or two-word exclamation, never a short headline', () => {
    expect(announcementHeadline('ORCA FAMILY!!\nTinman is coming up.')).toBe('Tinman is coming up.');
    expect(announcementHeadline('WELL DONE ORCAS!\n\nThank you all for showing up.')).toBe('WELL DONE ORCAS!');
    expect(announcementHeadline('MAX SUMMONS FIRST\n\nNo points on time.')).toBe('MAX SUMMONS FIRST');
  });

  it('drops a greeting that runs into the text, and starts with a capital', () => {
    expect(announcementHeadline('Dear Orcas, we had a great time riding the chimeras! Thank you')).toBe('We had a great time riding the chimeras! Thank you');
    expect(announcementHeadline('Hello Orcas,\n\nfor those of you on zero points, join a raid.')).toBe('For those of you on zero points, join a raid.');
  });

  it('keeps a title line as written, without a trailing colon or markdown stars', () => {
    expect(announcementHeadline('Tinman times:\n\nR +0\nR +3')).toBe('Tinman times');
    expect(announcementHeadline('ORCA | BATTLE ORDERS\n\nSaturday')).toBe('ORCA | BATTLE ORDERS');
    expect(announcementHeadline('We go for *1 summon* again')).toBe('We go for 1 summon again');
    expect(announcementHeadline('• Do your dailies •')).toBe('Do your dailies');
  });

  it('takes the first sentence of a long line and cuts at a word', () => {
    const long = `${'It is with a heavy heart that we share some news about one of our dear friends today. '.repeat(3)}`;
    expect(announcementHeadline(long)).toBe('It is with a heavy heart that we share some news about one of our dear friends today.');
    const run = 'word '.repeat(60);
    const h = announcementHeadline(run);
    expect(h.length).toBeLessThanOrEqual(HEADLINE_MAX_LENGTH + 1);
    expect(h.endsWith('…')).toBe(true);
  });

  it('is empty for an empty announcement, and a lone greeting stays', () => {
    expect(announcementHeadline('')).toBe('');
    expect(announcementHeadline('   \n  ')).toBe('');
    expect(announcementHeadline('Hello Orcas!')).toBe('Hello Orcas!');
  });
});
