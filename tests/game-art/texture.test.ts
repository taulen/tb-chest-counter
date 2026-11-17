// Texture decoders and image operations, against hand-built blocks.

import { describe, expect, it } from 'vitest';
import {
  decodeDxt1,
  decodeDxt5,
  decodeRgb565,
  decodeTexture,
  flipRows,
  cropImage,
  rotateClockwise,
  flipHorizontal,
  rotate180,
  TextureFormat,
  UnsupportedTextureFormat,
  type RgbaImage,
} from '../../src/game-art/texture.js';
import { cutSprite, pickImages } from '../../src/game-art/extract.js';

const px = (img: { width: number; data: Buffer }, x: number, y: number): number[] =>
  [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

/** One BC1 colour block: endpoints c0/c1 and 16 two-bit indices, pixel 0 in the low bits. */
function bc1Block(c0: number, c1: number, indices: number[]): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(c0, 0);
  b.writeUInt16LE(c1, 2);
  let lut = 0;
  indices.forEach((v, n) => {
    lut |= (v & 3) << (2 * n);
  });
  b.writeUInt32LE(lut >>> 0, 4);
  return b;
}

/** One BC3 alpha block: endpoints a0/a1 and 16 three-bit indices. */
function bc3AlphaBlock(a0: number, a1: number, indices: number[]): Buffer {
  const b = Buffer.alloc(8);
  b[0] = a0;
  b[1] = a1;
  let bits = 0n;
  indices.forEach((v, n) => {
    bits |= BigInt(v & 7) << BigInt(3 * n);
  });
  for (let k = 0; k < 6; k++) b[2 + k] = Number((bits >> BigInt(8 * k)) & 0xffn);
  return b;
}

const RED = 0xf800;
const BLUE = 0x001f;

describe('RGB565', () => {
  it('scales 5/6-bit channels by x * 255 / max, truncated', () => {
    const src = Buffer.alloc(10);
    [0xffff, 0xf800, 0x07e0, 0x001f, 0x0841].forEach((v, i) => src.writeUInt16LE(v, i * 2));
    const out = decodeRgb565(src, 5, 1);
    expect(px({ width: 5, data: out }, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(px({ width: 5, data: out }, 1, 0)).toEqual([255, 0, 0, 255]);
    expect(px({ width: 5, data: out }, 2, 0)).toEqual([0, 255, 0, 255]);
    expect(px({ width: 5, data: out }, 3, 0)).toEqual([0, 0, 255, 255]);
    // r=1, g=2, b=1: 255/31 = 8.2 → 8, 510/63 = 8.1 → 8
    expect(px({ width: 5, data: out }, 4, 0)).toEqual([8, 8, 8, 255]);
  });
});

describe('DXT1', () => {
  it('4-colour mode (c0 > c1): endpoints and the two thirds', () => {
    const out = decodeDxt1(bc1Block(RED, BLUE, [0, 1, 2, 3, ...new Array(12).fill(0)]), 4, 4);
    const img = { width: 4, data: out };
    expect(px(img, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(img, 1, 0)).toEqual([0, 0, 255, 255]);
    expect(px(img, 2, 0)).toEqual([170, 0, 85, 255]); // (2·255 + 0) / 3, (0 + 255) / 3
    expect(px(img, 3, 0)).toEqual([85, 0, 170, 255]);
    expect(px(img, 0, 3)).toEqual([255, 0, 0, 255]);
  });

  it('3-colour mode (c0 <= c1): the midpoint, and index 3 is transparent black', () => {
    const out = decodeDxt1(bc1Block(BLUE, RED, [2, 3, ...new Array(14).fill(0)]), 4, 4);
    const img = { width: 4, data: out };
    expect(px(img, 0, 0)).toEqual([127, 0, 127, 255]);
    expect(px(img, 1, 0)).toEqual([0, 0, 0, 0]);
  });

  it('decodes sizes that are not a multiple of 4, block by block', () => {
    // 5×2: two blocks across; the second one is solid blue.
    const src = Buffer.concat([bc1Block(RED, RED, new Array(16).fill(0)), bc1Block(BLUE, BLUE, new Array(16).fill(0))]);
    const out = decodeDxt1(src, 5, 2);
    expect(out.length).toBe(5 * 2 * 4);
    expect(px({ width: 5, data: out }, 3, 1)).toEqual([255, 0, 0, 255]);
    expect(px({ width: 5, data: out }, 4, 1)).toEqual([0, 0, 255, 255]);
  });
});

describe('DXT5', () => {
  it('8-level alpha (a0 > a1) and a colour block that never uses 3-colour mode', () => {
    const alphaIdx = [0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0];
    // c0 < c1 would be 3-colour mode in DXT1; in DXT5 index 3 stays opaque.
    const block = Buffer.concat([bc3AlphaBlock(255, 0, alphaIdx), bc1Block(BLUE, RED, new Array(16).fill(3))]);
    const out = decodeDxt5(block, 4, 4);
    const img = { width: 4, data: out };
    const alphas = Array.from({ length: 16 }, (_, n) => px(img, n % 4, Math.floor(n / 4))[3]);
    // levels: 255, 0, (6·255)/7=218, 182, 145, 109, 72, 36
    expect(alphas).toEqual([255, 0, 218, 182, 145, 109, 72, 36, 36, 72, 109, 145, 182, 218, 0, 255]);
    // index 3 = (c0 + 2·c1) / 3 with c0 blue, c1 red: red 510/3 = 170, blue 255/3 = 85, opaque
    expect(px(img, 0, 0)).toEqual([170, 0, 85, 255]);
  });

  it('6-level alpha (a0 <= a1) with explicit 0 and 255', () => {
    const block = Buffer.concat([bc3AlphaBlock(50, 100, [0, 1, 2, 5, 6, 7, ...new Array(10).fill(0)]), bc1Block(RED, RED, new Array(16).fill(0))]);
    const img = { width: 4, data: decodeDxt5(block, 4, 4) };
    expect([0, 1, 2, 3, 4, 5].map((x) => px(img, x % 4, Math.floor(x / 4))[3])).toEqual([50, 100, 60, 90, 0, 255]);
  });
});

describe('decodeTexture', () => {
  it('passes RGBA32 through and expands RGB24 with opaque alpha', () => {
    const rgba = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...decodeTexture(TextureFormat.RGBA32, rgba, 2, 1).data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...decodeTexture(TextureFormat.RGB24, Buffer.from([1, 2, 3, 4, 5, 6]), 2, 1).data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it('reorders ARGB32 and BGRA32', () => {
    expect([...decodeTexture(TextureFormat.ARGB32, Buffer.from([9, 1, 2, 3]), 1, 1).data]).toEqual([1, 2, 3, 9]);
    expect([...decodeTexture(TextureFormat.BGRA32, Buffer.from([3, 2, 1, 9]), 1, 1).data]).toEqual([1, 2, 3, 9]);
  });

  it('refuses short data and unknown formats', () => {
    expect(() => decodeTexture(TextureFormat.RGBA32, Buffer.alloc(7), 2, 1)).toThrow(/need 8/);
    expect(() => decodeTexture(28, Buffer.alloc(64), 4, 4)).toThrow(UnsupportedTextureFormat);
  });
});

function grid(width: number, height: number): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.writeUInt32BE(((x + 1) << 24) | ((y + 1) << 16) | 0xff, (y * width + x) * 4);
  return { width, height, data };
}
const at = (img: RgbaImage, x: number, y: number): string => {
  const p = px(img, x, y);
  return `${p[0] - 1},${p[1] - 1}`;
};

describe('image operations', () => {
  const img = grid(3, 2);

  it('flips rows', () => {
    const f = flipRows(img);
    expect(at(f, 0, 0)).toBe('0,1');
    expect(at(f, 2, 1)).toBe('2,0');
  });

  it('crops', () => {
    const c = cropImage(img, 1, 1, 2, 1);
    expect([c.width, c.height]).toEqual([2, 1]);
    expect(at(c, 0, 0)).toBe('1,1');
  });

  it('rotates 90° clockwise, 180°, and mirrors', () => {
    const r = rotateClockwise(img); // 2×3: the old bottom-left becomes the top-left
    expect([r.width, r.height]).toEqual([2, 3]);
    expect(at(r, 0, 0)).toBe('0,1');
    expect(at(r, 1, 0)).toBe('0,0');
    expect(at(r, 0, 2)).toBe('2,1');
    expect(at(rotate180(img), 0, 0)).toBe('2,1');
    expect(at(flipHorizontal(img), 0, 1)).toBe('2,1');
  });
});

describe('cutSprite', () => {
  // A 4×4 texture in Unity's bottom-up order: stored row 0 is the bottom row.
  const tex = grid(4, 4);
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

  it('cuts the rect in bottom-up coordinates and returns it top-down', () => {
    const s = cutSprite(tex, rect(1, 0, 2, 3), 0);
    expect([s.width, s.height]).toEqual([2, 3]);
    expect(at(s, 0, 0)).toBe('1,2'); // the top of the sprite is the highest stored row
    expect(at(s, 1, 2)).toBe('2,0');
  });

  it('rounds fractional rects', () => {
    const s = cutSprite(tex, rect(0.6, 0.4, 2, 2), 0);
    expect([s.width, s.height]).toEqual([2, 2]);
    expect(at(s, 0, 1)).toBe('1,0');
  });

  it('undoes packing rotation only when the sprite is packed', () => {
    const packedRot90 = 1 | (4 << 2);
    const s = cutSprite(tex, rect(0, 0, 3, 2), packedRot90);
    expect([s.width, s.height]).toEqual([2, 3]);
    const unpacked = cutSprite(tex, rect(0, 0, 3, 2), 4 << 2);
    expect([unpacked.width, unpacked.height]).toEqual([3, 2]);
  });
});

describe('pickImages', () => {
  it('keeps one image per name and prefers the sprite', () => {
    const img = grid(1, 1);
    const picked = pickImages([
      { name: 'Icon_A', kind: 'texture', format: 4, image: img },
      { name: 'icon_a', kind: 'sprite', format: 4, image: img },
      { name: 'icon_b', kind: 'texture', format: 4, image: img },
    ]);
    expect(picked.map((p) => `${p.name}:${p.kind}`).sort()).toEqual(['icon_a:sprite', 'icon_b:texture']);
  });
});
