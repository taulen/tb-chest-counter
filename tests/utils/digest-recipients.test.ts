import { describe, it, expect } from 'vitest';
import {
  parseDigestRecipients,
  normalizeDigestRecipients,
  MAX_DIGEST_RECIPIENTS,
} from '../../src/discord/digest-recipients.js';

describe('parseDigestRecipients', () => {
  it('parses a bare legacy single ID', () => {
    expect(parseDigestRecipients('123456789012345678')).toEqual(['123456789012345678']);
  });

  it('treats an empty/absent value as no recipients', () => {
    expect(parseDigestRecipients('')).toEqual([]);
    expect(parseDigestRecipients(null)).toEqual([]);
    expect(parseDigestRecipients(undefined)).toEqual([]);
  });

  it('splits on commas, semicolons, spaces and newlines', () => {
    expect(
      parseDigestRecipients('111111111111111111, 222222222222222222;333333333333333333\n444444444444444444'),
    ).toEqual([
      '111111111111111111',
      '222222222222222222',
      '333333333333333333',
      '444444444444444444',
    ]);
  });

  it('unwraps a pasted mention', () => {
    expect(parseDigestRecipients('<@111111111111111111>, <@!222222222222222222>')).toEqual([
      '111111111111111111',
      '222222222222222222',
    ]);
  });

  it('drops non-snowflakes and duplicates, preserving order', () => {
    expect(
      parseDigestRecipients('111111111111111111, someone@example.com, 12, 111111111111111111, 222222222222222222'),
    ).toEqual(['111111111111111111', '222222222222222222']);
  });

  it('caps the list so a bad paste cannot become a DM storm', () => {
    const many = Array.from({ length: 40 }, (_, i) => `1000000000000000${String(i).padStart(2, '0')}`);
    expect(parseDigestRecipients(many.join(','))).toHaveLength(MAX_DIGEST_RECIPIENTS);
  });
});

describe('normalizeDigestRecipients', () => {
  it('round-trips to the canonical stored form', () => {
    expect(normalizeDigestRecipients('  <@111111111111111111>  ;;  222222222222222222 ')).toBe(
      '111111111111111111, 222222222222222222',
    );
    expect(normalizeDigestRecipients('not-an-id')).toBe('');
  });
});
