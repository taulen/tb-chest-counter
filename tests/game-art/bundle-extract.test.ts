// UnityFS bundle → SerializedFile → Texture2D/Sprite → PNG, end to end on a
// synthetic bundle built in the test (see synthetic-bundle.ts).

import { describe, expect, it } from 'vitest';
import { readUnityBundle, nodeData, isUnityFs } from '../../src/game-art/unityfs.js';
import { readSerializedFile, readObject, peekName, commonStringOffset, CLASS_TEXTURE2D, CLASS_SPRITE } from '../../src/game-art/serialized-file.js';
import { extractImages, pickImages } from '../../src/game-art/extract.js';
import { encodePng, decodePng } from '../../src/game-art/png.js';
import { flipRows } from '../../src/game-art/texture.js';
import { buildBundle, buildSerializedFile, patternPixels, TEXTURE2D_TREE, SPRITE_TREE, type ObjectSpec } from './synthetic-bundle.js';

const TEX_ID = -7250658974773815517n; // 64-bit path ids are routinely past 2^53
const W = 4;
const H = 4;

function texture(name: string, pathId: bigint, pixels: Buffer): ObjectSpec {
  return {
    pathId,
    classId: CLASS_TEXTURE2D,
    tree: TEXTURE2D_TREE,
    value: { m_Name: name, m_Width: W, m_Height: H, m_TextureFormat: 4, m_IsReadable: false, 'image data': pixels },
  };
}

function sprite(name: string, pathId: bigint, rect: { x: number; y: number; width: number; height: number }, settingsRaw = 64): ObjectSpec {
  return {
    pathId,
    classId: CLASS_SPRITE,
    tree: SPRITE_TREE,
    value: {
      m_Name: name,
      m_RenderDataKey: { first: { 'data[0]': 1, 'data[1]': 2, 'data[2]': 3, 'data[3]': 4 }, second: 21300000n },
      m_SpriteAtlas: { m_FileID: 0, m_PathID: 0n },
      m_RD: {
        texture: { m_FileID: 0, m_PathID: TEX_ID },
        alphaTexture: { m_FileID: 0, m_PathID: 0n },
        textureRect: rect,
        settingsRaw,
      },
    },
  };
}

const pixels = patternPixels(W, H);
const serialized = buildSerializedFile([
  texture('Sheet_Texture', TEX_ID, pixels),
  sprite('Icon_Left', 2n, { x: 0, y: 0, width: 2, height: 4 }),
  sprite('icon_corner', 3n, { x: 2, y: 2, width: 2, height: 2 }),
]);

describe('UnityFS + SerializedFile', () => {
  for (const lz4 of [true, false]) {
    it(`reads the bundle's directory and data (${lz4 ? 'LZ4' : 'uncompressed'})`, () => {
      const buf = buildBundle([{ path: 'CAB-0123456789abcdef', data: serialized }], lz4);
      expect(isUnityFs(buf)).toBe(true);
      const bundle = readUnityBundle(buf);
      expect(bundle.engineVersion).toBe('2019.4.8f1');
      expect(bundle.nodes.map((n) => n.path)).toEqual(['CAB-0123456789abcdef']);
      expect(nodeData(bundle, bundle.nodes[0]).equals(serialized)).toBe(true);
    });
  }

  it('parses objects through their type trees (common and local strings)', () => {
    expect(commonStringOffset('m_Name')).toBe(427);
    expect(commonStringOffset('Texture2D')).toBe(874);
    const file = readSerializedFile(serialized);
    expect(file.version).toBe(21);
    expect(file.objects.map((o) => o.classId)).toEqual([CLASS_TEXTURE2D, CLASS_SPRITE, CLASS_SPRITE]);
    const tex = file.objects[0];
    expect(tex.pathId).toBe(TEX_ID);
    expect(peekName(file, tex)).toBe('Sheet_Texture');
    const value = readObject(file, tex);
    expect(value.m_Width).toBe(W);
    expect(value.m_TextureFormat).toBe(4);
    expect((value['image data'] as Buffer).equals(pixels)).toBe(true);
    const spr = readObject(file, file.objects[1]);
    expect(spr.m_Name).toBe('Icon_Left');
    expect((spr.m_RD as Record<string, unknown>).settingsRaw).toBe(64);
  });

  it('rejects what is not a bundle', () => {
    expect(isUnityFs(Buffer.from('UnityWeb\0'))).toBe(false);
    expect(() => readUnityBundle(Buffer.from('not a bundle at all\0'))).toThrow(/UnityFS/);
  });
});

describe('extractImages', () => {
  const bundle = buildBundle([{ path: 'CAB-0123456789abcdef', data: serialized }]);

  it('returns the texture top-down (Unity stores rows bottom-up)', () => {
    const { images, errors } = extractImages(bundle, (n) => n === 'Sheet_Texture');
    expect(errors).toEqual([]);
    expect(images).toHaveLength(1);
    expect(images[0].kind).toBe('texture');
    expect(images[0].image.data.equals(flipRows({ width: W, height: H, data: pixels }).data)).toBe(true);
  });

  it('cuts sprites from their texture by rect, case-insensitive wanted names', () => {
    const wanted = new Set(['icon_left', 'icon_corner']);
    const { images } = extractImages(bundle, (n) => wanted.has(n.toLowerCase()));
    const byName = new Map(pickImages(images).map((i) => [i.name, i.image]));
    const left = byName.get('Icon_Left')!;
    expect([left.width, left.height]).toEqual([2, 4]);
    // top-left of the sprite = stored row 3 (the top of the texture), column 0
    expect([...left.data.subarray(0, 4)]).toEqual([0, 48, 200, 252]);
    const corner = byName.get('icon_corner')!;
    expect([corner.width, corner.height]).toEqual([2, 2]);
    // stored (x=2, y=3) is the corner sprite's top-left
    expect([...corner.data.subarray(0, 4)]).toEqual([32, 48, 200, 250]);
  });

  it('reports a sprite whose texture is missing instead of throwing', () => {
    const broken = buildSerializedFile([sprite('orphan', 9n, { x: 0, y: 0, width: 1, height: 1 })]);
    const { images, errors } = extractImages(buildBundle([{ path: 'CAB-ff', data: broken }]), () => true);
    expect(images).toEqual([]);
    expect(errors[0]).toMatch(/orphan.*not found/);
  });
});

describe('PNG output', () => {
  it('round-trips RGBA pixels, alpha included', async () => {
    const img = { width: W, height: H, data: patternPixels(W, H) };
    const png = await encodePng(img);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const back = await decodePng(png);
    expect([back.width, back.height]).toEqual([W, H]);
    expect(back.data.equals(img.data)).toBe(true);
  });

  it('writes an opaque image without alpha and reads it back opaque', async () => {
    const data = Buffer.alloc(3 * 2 * 4, 255);
    data[0] = 10;
    const png = await encodePng({ width: 3, height: 2, data });
    expect(png[25]).toBe(2); // IHDR colour type 2 = truecolour, no alpha
    const back = await decodePng(png);
    expect(back.data.equals(data)).toBe(true);
  });
});
