import { describe, expect, it } from 'vitest';
import { normalizePublicUrl } from '../../src/utils/public-url.js';
import { clanPublicUrl } from '../../src/data/repositories/clan-repo.js';

describe('normalizePublicUrl', () => {
  it('keeps a bare origin', () => {
    expect(normalizePublicUrl('https://sinful.day')).toBe('https://sinful.day');
  });

  it('adds https to a scheme-less host', () => {
    expect(normalizePublicUrl('sinful.day')).toBe('https://sinful.day');
  });

  it('drops trailing slash, path and query', () => {
    expect(normalizePublicUrl(' https://chests.taul1.com/#leaderboard?x=1 ')).toBe('https://chests.taul1.com');
    expect(normalizePublicUrl('https://sinful.day/')).toBe('https://sinful.day');
  });

  it('keeps a port', () => {
    expect(normalizePublicUrl('http://192.168.1.5:3011')).toBe('http://192.168.1.5:3011');
  });

  it('treats blank as clearing', () => {
    expect(normalizePublicUrl('')).toBe('');
    expect(normalizePublicUrl('   ')).toBe('');
    expect(normalizePublicUrl(null)).toBe('');
  });

  it('rejects non-web input', () => {
    expect(normalizePublicUrl('ftp://sinful.day')).toBeNull();
    expect(normalizePublicUrl('javascript:alert(1)')).toBeNull();
    expect(normalizePublicUrl('not a url')).toBeNull();
    expect(normalizePublicUrl(42)).toBeNull();
  });
});

describe('clanPublicUrl', () => {
  it("prefers the clan's own domain", () => {
    expect(clanPublicUrl({ publicUrl: 'https://sinful.day' }, 'https://chests.taul1.com')).toBe('https://sinful.day');
  });

  it('falls back to the global URL, minus trailing slashes', () => {
    expect(clanPublicUrl({ publicUrl: '' }, 'https://chests.taul1.com/')).toBe('https://chests.taul1.com');
    expect(clanPublicUrl(null, 'https://chests.taul1.com')).toBe('https://chests.taul1.com');
  });

  it('is empty when neither is set', () => {
    expect(clanPublicUrl({ publicUrl: '' }, '')).toBe('');
  });
});
