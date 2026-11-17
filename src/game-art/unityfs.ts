/**
 * UnityFS asset bundle reader: header, blocks info, block decompression and
 * the directory of files inside (a SerializedFile "CAB-…" plus, for textures,
 * a "CAB-….resS" stream file holding the pixel data).
 *
 * Layout (all big-endian):
 *   "UnityFS\0", u32 format version, "5.x.x\0", engine revision "2019.4.8f1\0",
 *   i64 total size, u32 compressed blocks-info size, u32 uncompressed size, u32 flags
 *   [align 16 from format 7 / engine 2019.4.15+]
 *   blocks info (here, or at the end of the file when flags & 0x80), compressed
 *   with flags & 0x3f: { 16-byte hash, i32 n, n × (u32 raw, u32 packed, u16 flags),
 *                        i32 m, m × (i64 offset, i64 size, u32 flags, path\0) }
 *   the blocks, back to back; together they form one stream the nodes index.
 *
 * The game's WebGL bundles (Unity 2019.4.8f1, format 6) use LZ4HC throughout.
 */
import { BinaryReader } from './binary-reader.js';
import { lz4BlockDecompress } from './lz4.js';

export interface BundleNode {
  path: string;
  offset: number;
  size: number;
  flags: number;
}

export interface UnityBundle {
  formatVersion: number;
  engineVersion: string;
  nodes: BundleNode[];
  /** The decompressed block stream; node offsets index into it. */
  data: Buffer;
}

const COMPRESSION_NONE = 0;
const COMPRESSION_LZMA = 1;
const COMPRESSION_LZ4 = 2;
const COMPRESSION_LZ4HC = 3;

const FLAG_BLOCKS_INFO_AT_END = 0x80;
/** Engine 2020.3.34+/2021.3.2+/2022.1.1+ only; before that 0x200 meant encryption. */
const FLAG_BLOCK_INFO_NEEDS_PADDING = 0x200;

export function decompressBlock(data: Buffer, uncompressedSize: number, flags: number): Buffer {
  const kind = flags & 0x3f;
  switch (kind) {
    case COMPRESSION_NONE:
      return data;
    case COMPRESSION_LZMA:
      // Every WebGL bundle the game ships is LZ4HC (all 1,283 sampled, Nov 2026);
      // LZMA would only appear if they changed their build, and fails that bundle.
      throw new Error('LZMA-compressed bundles are not supported');
    case COMPRESSION_LZ4:
    case COMPRESSION_LZ4HC:
      return lz4BlockDecompress(data, uncompressedSize);
    default:
      throw new Error(`unsupported bundle compression ${kind}`);
  }
}

/** [major, minor, patch] of "2019.4.8f1"; zeros when unparseable. */
export function parseEngineVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function versionAtLeast(v: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

/** True for engines whose flags use the newer meaning of 0x200 (block padding, not encryption). */
function usesNewArchiveFlags(v: [number, number, number]): boolean {
  if (v[0] < 2020) return false;
  if (v[0] === 2020) return versionAtLeast(v, [2020, 3, 34]);
  if (v[0] === 2021) return versionAtLeast(v, [2021, 3, 2]);
  if (v[0] === 2022) return versionAtLeast(v, [2022, 1, 1]);
  return true;
}

export function isUnityFs(buf: Buffer): boolean {
  return buf.length >= 8 && buf.toString('latin1', 0, 8) === 'UnityFS\0';
}

export function readUnityBundle(buf: Buffer): UnityBundle {
  const r = new BinaryReader(buf, false);
  const signature = r.cstring();
  if (signature !== 'UnityFS') throw new Error(`not a UnityFS bundle (signature "${signature.slice(0, 16)}")`);
  const formatVersion = r.u32();
  r.cstring(); // player version, "5.x.x"
  const engineVersion = r.cstring();
  const engine = parseEngineVersion(engineVersion);
  r.i64(); // total size
  const infoPacked = r.u32();
  const infoRaw = r.u32();
  const flags = r.u32();
  const newFlags = usesNewArchiveFlags(engine);
  if (!newFlags && flags & 0x200) throw new Error('encrypted bundles are not supported');
  if (formatVersion >= 7 || (engine[0] === 2019 && versionAtLeast(engine, [2019, 4, 15]))) r.align(16);

  let infoBytes: Buffer;
  if (flags & FLAG_BLOCKS_INFO_AT_END) {
    infoBytes = buf.subarray(buf.length - infoPacked, buf.length);
  } else {
    infoBytes = r.bytes(infoPacked);
  }
  const info = new BinaryReader(decompressBlock(infoBytes, infoRaw, flags), false);
  info.bytes(16); // uncompressed data hash
  const blockCount = info.i32();
  const blocks: Array<{ raw: number; packed: number; flags: number }> = [];
  let total = 0;
  for (let i = 0; i < blockCount; i++) {
    const raw = info.u32();
    const packed = info.u32();
    const bflags = info.u16();
    blocks.push({ raw, packed, flags: bflags });
    total += raw;
  }
  const nodeCount = info.i32();
  const nodes: BundleNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const offset = info.i64Number();
    const size = info.i64Number();
    const nflags = info.u32();
    const path = info.cstring();
    nodes.push({ path, offset, size, flags: nflags });
  }
  if (newFlags && flags & FLAG_BLOCK_INFO_NEEDS_PADDING) r.align(16);

  const data = Buffer.alloc(total);
  let at = 0;
  for (const b of blocks) {
    const chunk = decompressBlock(r.bytes(b.packed), b.raw, b.flags);
    if (chunk.length !== b.raw) throw new Error(`block decompressed to ${chunk.length} bytes, expected ${b.raw}`);
    chunk.copy(data, at);
    at += b.raw;
  }
  for (const n of nodes) {
    if (n.offset + n.size > data.length) throw new Error(`bundle node ${n.path} runs past the data`);
  }
  return { formatVersion, engineVersion, nodes, data };
}

export function nodeData(bundle: UnityBundle, node: BundleNode): Buffer {
  return bundle.data.subarray(node.offset, node.offset + node.size);
}

/** Header flags of a bundle, without decompressing anything (diagnostics). */
export function peekBundleFlags(buf: Buffer): { formatVersion: number; engineVersion: string; flags: number } {
  const r = new BinaryReader(buf, false);
  r.cstring();
  const formatVersion = r.u32();
  r.cstring();
  const engineVersion = r.cstring();
  r.i64();
  r.u32();
  r.u32();
  return { formatVersion, engineVersion, flags: r.u32() };
}
