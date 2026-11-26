// Catalogue parsing and LZ4 block decoding, on synthetic data only.

import { describe, expect, it } from 'vitest';
import { parseCatalog, addressIndex, nameIndex, catalogVersionFromConfig } from '../../src/game-art/catalog.js';
import { lz4BlockDecompress } from '../../src/game-art/lz4.js';
import { lz4Encode, lz4Literal } from './synthetic-bundle.js';

function catalogBytes(
  entries: Array<{ name: string; group: number; content: string; bundle: string; addresses: string[] }>,
  declared = entries.length,
): Buffer {
  const u32 = (v: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const parts: Buffer[] = [Buffer.from([0x49, 0x17, 0x50, 0x2e]), u32(declared)];
  const str = (s: string): Buffer => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
  for (const e of entries) {
    parts.push(str(e.name), u32(e.group), Buffer.from(e.content, 'hex'), Buffer.from(e.bundle, 'hex'), u32(e.addresses.length));
    for (const a of e.addresses) parts.push(str(a));
  }
  return Buffer.concat(parts);
}

const H1 = '00112233445566778899aabbccddeeff';
const H2 = 'ffeeddccbbaa99887766554433221100';
const H3 = '0123456789abcdef0123456789abcdef';

describe('parseCatalog', () => {
  const buf = catalogBytes([
    { name: 'icon_test_72', group: 2, content: H1, bundle: H2, addresses: ['icon_test_72'] },
    { name: 'sheet', group: 4, content: H2, bundle: H3, addresses: ['Sprite_One', 'sprite_two'] },
  ]);

  it('reads every entry: name, group, both hashes, lower-cased addresses', () => {
    const entries = parseCatalog(buf);
    expect(entries).toEqual([
      { name: 'icon_test_72', group: 2, contentHash: H1, bundle: H2, addresses: ['icon_test_72'] },
      { name: 'sheet', group: 4, contentHash: H2, bundle: H3, addresses: ['sprite_one', 'sprite_two'] },
    ]);
  });

  it('indexes addresses to their bundle', () => {
    const idx = addressIndex(parseCatalog(buf));
    expect(idx.get('sprite_two')).toBe(H3);
    expect(idx.get('icon_test_72')).toBe(H2);
    expect(idx.has('missing')).toBe(false);
  });

  it('indexes bundle names too, lower-cased, the first entry naming one winning (lookups by asset name)', () => {
    const twice = catalogBytes([
      { name: 'GuardTree', group: 4, content: H1, bundle: H2, addresses: ['layout_a'] },
      { name: 'other', group: 4, content: H1, bundle: H3, addresses: ['guardtree', 'layout_a'] },
    ]);
    const idx = nameIndex(parseCatalog(twice));
    expect(idx.get('guardtree')).toBe(H2);
    expect(idx.get('layout_a')).toBe(H2);
    expect(idx.get('other')).toBe(H3);
    expect(idx.has('GuardTree')).toBe(false);
  });

  it('refuses a wrong header and a truncated file', () => {
    const bad = Buffer.from(buf);
    bad[0] = 0;
    expect(() => parseCatalog(bad)).toThrow(/header/);
    expect(() => parseCatalog(buf.subarray(0, buf.length - 3))).toThrow(/truncated/);
  });

  it('reads bytes 4–7 as the entry count, not a fixed header (the Nov 2026 patch: 14384 → 14523 entries)', () => {
    // 14384 entries wrote "08\0\0" there, which was once taken for magic; any
    // other count must parse too, and a count that disagrees is refused.
    const one = [{ name: 'a', group: 0, content: H1, bundle: H2, addresses: ['a'] }];
    expect(parseCatalog(catalogBytes(one))).toHaveLength(1);
    expect(catalogBytes(one).subarray(4, 8).toString('hex')).toBe('01000000');
    expect(() => parseCatalog(catalogBytes(one, 14384))).toThrow(/declares 14384 entries but holds 1/);
  });

  it('takes the webgl catalogue version from the versions config', () => {
    expect(catalogVersionFromConfig({ result: { unity_catalog_version: { webgl: H1 } } })).toBe(H1);
    expect(() => catalogVersionFromConfig({ result: {} })).toThrow();
    expect(() => catalogVersionFromConfig({ result: { unity_catalog_version: { webgl: '../x' } } })).toThrow();
  });
});

describe('lz4BlockDecompress', () => {
  it('decodes a literal-only block', () => {
    const src = Buffer.from('hello, block');
    expect(lz4BlockDecompress(lz4Literal(src), src.length).toString()).toBe('hello, block');
  });

  it('decodes a hand-made block with a match and extended lengths', () => {
    // 'abc' + match(offset 3, length 9) → "abcabcabcabc", then a run: 'a' + match
    // (offset 1, length 15+10+4) → 30 × 'a', then the final literals "xyz".
    const block = Buffer.from([
      0x35, 0x61, 0x62, 0x63, 0x03, 0x00,
      0x1f, 0x61, 0x01, 0x00, 0x0a,
      0x30, 0x78, 0x79, 0x7a,
    ]);
    const expected = 'abcabcabcabc' + 'a'.repeat(30) + 'xyz';
    expect(lz4BlockDecompress(block, expected.length).toString()).toBe(expected);
  });

  it('decodes a literal run longer than 15 (length extension bytes)', () => {
    const src = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff));
    expect(lz4BlockDecompress(lz4Literal(src), 300).equals(src)).toBe(true);
  });

  it('round-trips pseudo-random data through a reference encoder', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let trial = 0; trial < 20; trial++) {
      const n = 50 + (rnd() % 1500);
      const src = Buffer.alloc(n);
      // Low-entropy so matches (including overlapping ones) occur.
      for (let i = 0; i < n; i++) src[i] = rnd() % 5 === 0 ? rnd() & 0xff : src[Math.max(0, i - 1 - (rnd() % 8))];
      const packed = lz4Encode(src);
      expect(lz4BlockDecompress(packed, n).equals(src)).toBe(true);
    }
  });

  it('rejects corrupt input instead of producing garbage', () => {
    // match offset 9 with only 3 bytes of output
    expect(() => lz4BlockDecompress(Buffer.from([0x30, 0x61, 0x62, 0x63, 0x09, 0x00]), 10)).toThrow(/offset/);
    // claims more output than it produces
    expect(() => lz4BlockDecompress(lz4Literal(Buffer.from('abc')), 10)).toThrow(/expected 10/);
    // literal run past the end of the input
    expect(() => lz4BlockDecompress(Buffer.from([0x50, 0x61]), 5)).toThrow(/out of bounds/);
  });
});
