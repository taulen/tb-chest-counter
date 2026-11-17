// The WebGL client build reader, on made-up bytes — no game data (the
// repository is public).

import { describe, expect, it } from 'vitest';
import {
  parseUnityWebData,
  readPlayerTexture2D,
  webglClientVersionFromConfig,
  webglDataUrl,
} from '../../src/game-art/webgl-client.js';

const u32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const i32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };

/** A UnityWebData1.0 container holding `files` in order. */
function webData(files: Array<[string, Buffer]>): Buffer {
  const magic = Buffer.from('UnityWebData1.0\0', 'latin1');
  const headerSize = magic.length + 4 + files.reduce((n, [name]) => n + 12 + Buffer.byteLength(name), 0);
  const entries: Buffer[] = [];
  let at = headerSize;
  for (const [name, data] of files) {
    entries.push(u32(at), u32(data.length), u32(Buffer.byteLength(name)), Buffer.from(name, 'utf8'));
    at += data.length;
  }
  return Buffer.concat([magic, u32(headerSize), ...entries, ...files.map(([, d]) => d)]);
}

/** A Texture2D object in the 2020.2 – 2022.1 player layout (no type tree). */
function texture2d(name: string, width: number, height: number, format: number, pixels: Buffer, extra = Buffer.alloc(0)): Buffer {
  const parts: Buffer[] = [];
  let len = 0;
  const push = (b: Buffer): void => { parts.push(b); len += b.length; };
  const align = (): void => { while (len % 4) push(Buffer.from([0])); };
  const str = (s: string): void => { const b = Buffer.from(s, 'utf8'); push(i32(b.length)); push(b); align(); };
  str(name);
  push(i32(-1)); push(Buffer.from([0, 0])); align(); // fallback format, downscale, alpha optional
  push(i32(width)); push(i32(height)); push(i32(pixels.length)); push(i32(0)); push(i32(format)); push(i32(1));
  push(Buffer.from([0, 0, 0, 0])); align(); // readable, preprocessed, ignore limit, streaming mips
  push(i32(0)); push(i32(1)); push(i32(2)); // streaming priority, image count, dimension
  push(Buffer.alloc(24)); // texture settings
  push(i32(0)); push(i32(1)); // lightmap format, colour space
  push(i32(0)); align(); // platform blob
  push(i32(pixels.length)); push(pixels); align();
  push(Buffer.alloc(8)); push(u32(0)); str(''); // stream data
  push(extra);
  return Buffer.concat(parts);
}

describe('WebGL client build', () => {
  it('reads the build hash from the versions config', () => {
    const hash = 'dc0489eabb69b43d363fd26f7cf03182';
    expect(webglClientVersionFromConfig({ result: { webgl_client_version: { default: hash, other: 'x' } } })).toBe(hash);
    expect(() => webglClientVersionFromConfig({ result: {} })).toThrow(/no webgl client version/);
    expect(webglDataUrl(hash)).toBe(`https://assets-webgl-client.totalbattle.dev/${hash}/Build/Triumph.data`);
  });

  it('lists the files of a UnityWebData container', () => {
    const files = parseUnityWebData(webData([['boot.config', Buffer.from('a=1')], ['data.unity3d', Buffer.from('UnityFS\0xyz')]]));
    expect([...files.keys()]).toEqual(['boot.config', 'data.unity3d']);
    expect(files.get('boot.config')?.toString()).toBe('a=1');
    expect(files.get('data.unity3d')?.subarray(0, 7).toString()).toBe('UnityFS');
    expect(() => parseUnityWebData(Buffer.from('not a web data file at all'))).toThrow(/not a UnityWebData/);
  });

  it('reads a Texture2D without a type tree, and only on a layout it knows', () => {
    const pixels = Buffer.from([1, 2, 3, 255, 4, 5, 6, 128]);
    const obj = texture2d('back_icon_units_72x72_whiteII', 2, 1, 4, pixels);
    const tex = readPlayerTexture2D(obj, [2021, 3, 56]);
    expect(tex).toMatchObject({ name: 'back_icon_units_72x72_whiteII', width: 2, height: 1, format: 4 });
    expect([...tex.image]).toEqual([...pixels]);
    // A byte too many means the layout is not what we think: refuse, never guess.
    expect(() => readPlayerTexture2D(texture2d('x', 2, 1, 4, pixels, Buffer.alloc(4)), [2021, 3, 56])).toThrow(/layout mismatch/);
    expect(() => readPlayerTexture2D(obj, [2019, 4, 8])).toThrow(/no Texture2D layout/);
    expect(() => readPlayerTexture2D(obj, [2022, 3, 1])).toThrow(/no Texture2D layout/);
  });
});
