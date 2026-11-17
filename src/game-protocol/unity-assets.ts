/**
 * Just enough of the game client's Unity asset delivery to read a TEXT asset
 * by name — the research / talent tree layouts ship as small JSON TextAssets
 * ("guardtree", "herotree25", …), not in the static tables.
 *
 *   versions config .unity_catalog_version.webgl → the asset catalog
 *   assets-unity.totalbattle.dev/webgl/<catalog>  → name → bundle hash
 *   assets-unity.totalbattle.dev/webgl/<bundle>   → UnityFS bundle (LZ4 blocks)
 *
 * Catalog ("I\x17P.08" + entries): u32le-length strings, little-endian.
 *   entry = name · u32 kind · 16-byte content hash · 16-byte bundle hash ·
 *           u32 count · count × asset name
 * The bundle hash (hex) is the download file name.
 *
 * UnityFS: big-endian header, an LZ4/LZ4HC-compressed block table, then LZ4
 * data blocks holding one serialized file. A TextAsset's text is a u32le
 * length-prefixed byte string in that file; rather than walk Unity's type
 * tree we find the JSON object by its length prefix, which is unambiguous
 * for a JSON TextAsset. LZMA-compressed bundles aren't supported (the WebGL
 * build uses LZ4).
 */

const CATALOG_MAGIC = Buffer.from([0x49, 0x17, 0x50, 0x2e, 0x30, 0x38, 0x00, 0x00]);

export interface CatalogEntry {
  name: string;
  kind: number;
  bundle: string;
  assets: string[];
}

/** Asset name (lower case) → catalog entry. */
export function parseAssetCatalog(buf: Buffer): Map<string, CatalogEntry> {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(CATALOG_MAGIC)) throw new Error('not a Unity asset catalog (bad magic)');
  let p = 8;
  const u32 = (): number => {
    if (p + 4 > buf.length) throw new Error('asset catalog truncated');
    const v = buf.readUInt32LE(p);
    p += 4;
    return v;
  };
  const str = (): string => {
    const n = u32();
    if (p + n > buf.length) throw new Error('asset catalog truncated');
    const v = buf.toString('utf8', p, p + n);
    p += n;
    return v;
  };
  const out = new Map<string, CatalogEntry>();
  while (p < buf.length) {
    const name = str();
    const kind = u32();
    if (p + 32 > buf.length) throw new Error('asset catalog truncated');
    const bundle = buf.toString('hex', p + 16, p + 32);
    p += 32;
    const count = u32();
    const assets: string[] = [];
    for (let i = 0; i < count; i++) assets.push(str());
    const entry = { name, kind, bundle, assets };
    for (const a of [name, ...assets]) if (!out.has(a.toLowerCase())) out.set(a.toLowerCase(), entry);
  }
  return out;
}

/** LZ4 block-format decompression (no frame header). */
export function lz4BlockDecompress(src: Buffer, outSize: number): Buffer {
  const out = Buffer.alloc(outSize);
  let ip = 0;
  let op = 0;
  while (ip < src.length) {
    const token = src[ip++];
    let lit = token >> 4;
    if (lit === 15) {
      let b: number;
      do {
        b = src[ip++];
        lit += b;
      } while (b === 255 && ip < src.length);
    }
    if (op + lit > outSize || ip + lit > src.length) throw new Error('LZ4: literal run overruns the buffer');
    src.copy(out, op, ip, ip + lit);
    ip += lit;
    op += lit;
    if (ip >= src.length) break;
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error('LZ4: bad match offset');
    let len = token & 15;
    if (len === 15) {
      let b: number;
      do {
        b = src[ip++];
        len += b;
      } while (b === 255 && ip < src.length);
    }
    len += 4;
    if (op + len > outSize) throw new Error('LZ4: match overruns the buffer');
    for (let i = 0; i < len; i++, op++) out[op] = out[op - offset];
  }
  if (op !== outSize) throw new Error(`LZ4: decoded ${op} bytes, expected ${outSize}`);
  return out;
}

function decompress(data: Buffer, method: number, outSize: number): Buffer {
  if (method === 0) return data;
  if (method === 2 || method === 3) return lz4BlockDecompress(data, outSize);
  throw new Error(`UnityFS: unsupported compression ${method}`);
}

/** The uncompressed payload (every data block, concatenated) of a UnityFS bundle. */
export function unityFsPayload(buf: Buffer): Buffer {
  let p = 0;
  const cstr = (): string => {
    const end = buf.indexOf(0, p);
    if (end < 0) throw new Error('UnityFS: unterminated header string');
    const s = buf.toString('latin1', p, end);
    p = end + 1;
    return s;
  };
  if (cstr() !== 'UnityFS') throw new Error('not a UnityFS bundle');
  const version = buf.readUInt32BE(p);
  p += 4;
  cstr();
  cstr();
  p += 8; // total size (u64be)
  const infoCompressed = buf.readUInt32BE(p);
  const infoSize = buf.readUInt32BE(p + 4);
  const flags = buf.readUInt32BE(p + 8);
  p += 12;
  if (version >= 7) p = (p + 15) & ~15;
  const infoAtEnd = (flags & 0x80) !== 0;
  const infoStart = infoAtEnd ? buf.length - infoCompressed : p;
  const info = decompress(buf.subarray(infoStart, infoStart + infoCompressed), flags & 0x3f, infoSize);
  if (!infoAtEnd) p += infoCompressed;
  if (version >= 7 && (flags & 0x200) !== 0) p = (p + 15) & ~15;

  let q = 16; // uncompressed data hash
  const blockCount = info.readInt32BE(q);
  q += 4;
  const parts: Buffer[] = [];
  for (let i = 0; i < blockCount; i++) {
    const size = info.readUInt32BE(q);
    const csize = info.readUInt32BE(q + 4);
    const bflags = info.readUInt16BE(q + 8);
    q += 10;
    parts.push(decompress(buf.subarray(p, p + csize), bflags & 0x3f, size));
    p += csize;
  }
  return Buffer.concat(parts);
}

/** Every JSON object stored as a length-prefixed string (a JSON TextAsset) in a bundle. */
export function jsonTextAssets(bundle: Buffer): unknown[] {
  const data = unityFsPayload(bundle);
  const out: unknown[] = [];
  let i = data.indexOf(0x7b, 4);
  while (i >= 4) {
    const len = data.readUInt32LE(i - 4);
    if (len >= 2 && i + len <= data.length) {
      const text = data.toString('utf8', i, i + len).replace(/^﻿/, '');
      if (text.trimEnd().endsWith('}')) {
        try {
          out.push(JSON.parse(text));
          i = data.indexOf(0x7b, i + len);
          continue;
        } catch {
          /* not this one */
        }
      }
    }
    i = data.indexOf(0x7b, i + 1);
  }
  return out;
}
