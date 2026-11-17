// Stills cut from a Spine animation's atlas (src/game-art/spine.ts).

import { describe, expect, it } from 'vitest';
import { cutAtlasRegion, parseSpineAtlas } from '../../src/game-art/spine.js';
import type { RgbaImage } from '../../src/game-art/texture.js';

// The real Tome of Knowledge atlas, trimmed (clandoom_icon_book_anim.atlas, Nov 2026).
const BOOK_ATLAS = `
clandoom_icon_book_anim.png
\tsize: 728, 164
\tfilter: Linear, Linear
\tpma: true
\tscale: 0.756
BackLight
\tbounds: 2, 2, 149, 158
\toffsets: 0, 1, 150, 160
book
\tbounds: 153, 4, 146, 156
\toffsets: 0, 0, 150, 156
gold copy 2
\tbounds: 301, 8, 120, 152
`;

describe('parseSpineAtlas', () => {
  it('reads the page flags and every region rectangle, names with spaces included', () => {
    const a = parseSpineAtlas(BOOK_ATLAS);
    expect(a.pma).toBe(true);
    expect([...a.regions.keys()]).toEqual(['BackLight', 'book', 'gold copy 2']);
    expect(a.regions.get('book')).toEqual({ x: 153, y: 4, w: 146, h: 156, rotated: false });
  });

  it('reads the Spine 3 form (xy + size, rotate) too', () => {
    const a = parseSpineAtlas('page.png\nsize: 64,64\nformat: RGBA8888\nstatue\n  rotate: true\n  xy: 2, 3\n  size: 10, 20\n');
    expect(a.pma).toBe(false);
    expect(a.regions.get('statue')).toEqual({ x: 2, y: 3, w: 10, h: 20, rotated: true });
  });
});

describe('cutAtlasRegion', () => {
  // 4×2 texture, top-down; pixel (2,0) half-transparent premultiplied grey.
  const tex: RgbaImage = {
    width: 4,
    height: 2,
    data: Buffer.from([
      0, 0, 0, 0, 10, 10, 10, 255, 64, 64, 64, 128, 0, 0, 0, 0,
      0, 0, 0, 0, 20, 20, 20, 255, 30, 30, 30, 255, 0, 0, 0, 0,
    ]),
  };
  const atlas = { pma: true, regions: new Map([['obj', { x: 1, y: 0, w: 2, h: 2, rotated: false }], ['turned', { x: 0, y: 0, w: 1, h: 1, rotated: true }]]) };

  it('cuts the named region and un-premultiplies semi-transparent pixels', () => {
    const cut = cutAtlasRegion(tex, atlas, 'obj');
    expect(cut).toEqual({
      width: 2,
      height: 2,
      data: Buffer.from([10, 10, 10, 255, 128, 128, 128, 128, 20, 20, 20, 255, 30, 30, 30, 255]),
    });
  });

  it('gives no image for a missing, rotated or out-of-bounds region', () => {
    expect(cutAtlasRegion(tex, atlas, 'nope')).toBeNull();
    expect(cutAtlasRegion(tex, atlas, 'turned')).toBeNull();
    const wide = { pma: false, regions: new Map([['x', { x: 3, y: 0, w: 2, h: 1, rotated: false }]]) };
    expect(cutAtlasRegion(tex, wide, 'x')).toBeNull();
  });
});
