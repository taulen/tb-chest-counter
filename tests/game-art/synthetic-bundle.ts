// Builders for synthetic Unity data: type trees, SerializedFiles, UnityFS
// bundles and LZ4 blocks. Everything here is made up in the test — no bytes
// from the game (the repository is public).

import { commonStringOffset } from '../../src/game-art/serialized-file.js';

export interface NodeSpec {
  type: string;
  name: string;
  meta?: number;
  flags?: number;
  size?: number;
  children?: NodeSpec[];
}

const ALIGN = 0x4000;

export const t = {
  int: (name: string): NodeSpec => ({ type: 'int', name, size: 4 }),
  uint: (name: string): NodeSpec => ({ type: 'unsigned int', name, size: 4 }),
  i64: (name: string): NodeSpec => ({ type: 'SInt64', name, size: 8 }),
  float: (name: string): NodeSpec => ({ type: 'float', name, size: 4 }),
  bool: (name: string, aligned = false): NodeSpec => ({ type: 'bool', name, size: 1, meta: aligned ? ALIGN : 0 }),
  string: (name: string): NodeSpec => ({
    type: 'string', name, meta: 0x8000,
    children: [{ type: 'Array', name: 'Array', meta: ALIGN | 1, flags: 1, children: [{ type: 'int', name: 'size' }, { type: 'char', name: 'data' }] }],
  }),
  typeless: (name: string): NodeSpec => ({
    type: 'TypelessData', name, meta: ALIGN | 1, flags: 1,
    children: [{ type: 'int', name: 'size' }, { type: 'UInt8', name: 'data' }],
  }),
  pptr: (name: string, target: string): NodeSpec => ({
    type: `PPtr<${target}>`, name, children: [{ type: 'int', name: 'm_FileID' }, { type: 'SInt64', name: 'm_PathID' }],
  }),
  rectf: (name: string): NodeSpec => ({
    type: 'Rectf', name, children: ['x', 'y', 'width', 'height'].map((n) => ({ type: 'float', name: n })),
  }),
  cls: (type: string, name: string, children: NodeSpec[]): NodeSpec => ({ type, name, children }),
};

export const TEXTURE2D_TREE: NodeSpec = t.cls('Texture2D', 'Base', [
  t.string('m_Name'),
  t.int('m_Width'),
  t.int('m_Height'),
  t.int('m_TextureFormat'),
  t.bool('m_IsReadable', true),
  t.typeless('image data'),
]);

export const SPRITE_TREE: NodeSpec = t.cls('Sprite', 'Base', [
  t.string('m_Name'),
  t.cls('pair', 'm_RenderDataKey', [
    t.cls('GUID', 'first', ['data[0]', 'data[1]', 'data[2]', 'data[3]'].map((n) => ({ type: 'unsigned int', name: n }))),
    t.i64('second'),
  ]),
  t.pptr('m_SpriteAtlas', 'SpriteAtlas'),
  t.cls('SpriteRenderData', 'm_RD', [
    t.pptr('texture', 'Texture2D'),
    t.pptr('alphaTexture', 'Texture2D'),
    t.rectf('textureRect'),
    t.uint('settingsRaw'),
  ]),
]);

class Writer {
  parts: Buffer[] = [];
  length = 0;
  constructor(readonly le = true) {}
  push(b: Buffer): void {
    this.parts.push(b);
    this.length += b.length;
  }
  u8(v: number): void { this.push(Buffer.from([v & 0xff])); }
  i16(v: number): void { const b = Buffer.alloc(2); if (this.le) b.writeInt16LE(v); else b.writeInt16BE(v); this.push(b); }
  u16(v: number): void { const b = Buffer.alloc(2); if (this.le) b.writeUInt16LE(v); else b.writeUInt16BE(v); this.push(b); }
  i32(v: number): void { const b = Buffer.alloc(4); if (this.le) b.writeInt32LE(v); else b.writeInt32BE(v); this.push(b); }
  u32(v: number): void { const b = Buffer.alloc(4); if (this.le) b.writeUInt32LE(v >>> 0); else b.writeUInt32BE(v >>> 0); this.push(b); }
  i64(v: bigint): void { const b = Buffer.alloc(8); if (this.le) b.writeBigInt64LE(v); else b.writeBigInt64BE(v); this.push(b); }
  f32(v: number): void { const b = Buffer.alloc(4); if (this.le) b.writeFloatLE(v); else b.writeFloatBE(v); this.push(b); }
  cstr(s: string): void { this.push(Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])); }
  align(n = 4): void { while (this.length % n) this.u8(0); }
  bytes(): Buffer { return Buffer.concat(this.parts); }
}

/** Serialise a value with a type tree — the inverse of the reader. */
function writeValue(w: Writer, node: NodeSpec, value: unknown): void {
  let align = ((node.meta ?? 0) & ALIGN) !== 0;
  const kids = node.children ?? [];
  switch (node.type) {
    case 'int': w.i32(Number(value)); break;
    case 'unsigned int': w.u32(Number(value)); break;
    case 'SInt64': w.i64(BigInt(value as number | bigint)); break;
    case 'float': w.f32(Number(value)); break;
    case 'bool': w.u8(value ? 1 : 0); break;
    case 'char': case 'UInt8': w.u8(Number(value)); break;
    case 'string': {
      const b = Buffer.from(String(value), 'utf8');
      w.i32(b.length);
      w.push(b);
      if (((kids[0]?.meta ?? 0) & ALIGN) !== 0) align = true;
      break;
    }
    case 'TypelessData': {
      const b = value as Buffer;
      w.i32(b.length);
      w.push(b);
      break;
    }
    default: {
      const obj = value as Record<string, unknown>;
      for (const c of kids) writeValue(w, c, obj[c.name]);
    }
  }
  if (align) w.align(4);
}

function typeTreeBlob(root: NodeSpec): Buffer {
  const flat: Array<{ n: NodeSpec; level: number }> = [];
  const walk = (n: NodeSpec, level: number): void => {
    flat.push({ n, level });
    for (const c of n.children ?? []) walk(c, level + 1);
  };
  walk(root, 0);
  const local: string[] = [];
  let localSize = 0;
  const localOffsets = new Map<string, number>();
  const ref = (s: string): number => {
    const common = commonStringOffset(s);
    if (common !== undefined) return (common | 0x80000000) >>> 0;
    if (!localOffsets.has(s)) {
      localOffsets.set(s, localSize);
      local.push(s);
      localSize += Buffer.byteLength(s) + 1;
    }
    return localOffsets.get(s)!;
  };
  const nodes = new Writer(true);
  for (const [i, { n, level }] of flat.entries()) {
    nodes.u16(1);
    nodes.u8(level);
    nodes.u8(n.flags ?? 0);
    nodes.u32(ref(n.type));
    nodes.u32(ref(n.name));
    nodes.i32(n.size ?? -1);
    nodes.i32(i);
    nodes.u32(n.meta ?? 0);
    nodes.i64(0n); // ref type hash (version >= 19)
  }
  const w = new Writer(true);
  w.i32(flat.length);
  w.i32(localSize);
  w.push(nodes.bytes());
  for (const s of local) w.cstr(s);
  return w.bytes();
}

export interface ObjectSpec {
  pathId: bigint;
  classId: number;
  tree: NodeSpec;
  value: Record<string, unknown>;
}

/** A version-21 SerializedFile (Unity 2019.4) holding the given objects. */
export function buildSerializedFile(objects: ObjectSpec[]): Buffer {
  const types: Array<{ classId: number; tree: NodeSpec }> = [];
  const typeIndex = (o: ObjectSpec): number => {
    let i = types.findIndex((x) => x.classId === o.classId);
    if (i < 0) {
      types.push({ classId: o.classId, tree: o.tree });
      i = types.length - 1;
    }
    return i;
  };
  const data = new Writer(true);
  const table: Array<{ pathId: bigint; start: number; size: number; type: number }> = [];
  for (const o of objects) {
    data.align(8);
    const start = data.length;
    writeValue(data, o.tree, o.value);
    table.push({ pathId: o.pathId, start, size: data.length - start, type: typeIndex(o) });
  }
  const HEADER = 20;
  const meta = new Writer(true);
  // Offsets inside the metadata must align against the start of the FILE, so
  // pad as if the 20-byte header were in front.
  meta.push(Buffer.alloc(HEADER));
  meta.cstr('2019.4.8f1');
  meta.i32(20); // WebGL
  meta.u8(1); // type trees on
  meta.i32(types.length);
  for (const ty of types) {
    meta.i32(ty.classId);
    meta.u8(0);
    meta.i16(-1);
    meta.push(Buffer.alloc(16));
    meta.push(typeTreeBlob(ty.tree));
    meta.i32(0); // type dependencies
  }
  meta.i32(table.length);
  for (const e of table) {
    meta.align(4);
    meta.i64(e.pathId);
    meta.u32(e.start);
    meta.u32(e.size);
    meta.i32(e.type);
  }
  meta.i32(0); // script types
  meta.i32(0); // externals
  meta.i32(0); // ref types
  meta.cstr(''); // user information
  const metaBytes = meta.bytes().subarray(HEADER);
  const dataOffset = Math.ceil((HEADER + metaBytes.length) / 16) * 16;
  const body = data.bytes();
  const header = new Writer(false);
  header.u32(metaBytes.length);
  header.u32(dataOffset + body.length);
  header.u32(21);
  header.u32(dataOffset);
  header.u8(0); // little-endian
  header.push(Buffer.alloc(3));
  return Buffer.concat([header.bytes(), metaBytes, Buffer.alloc(dataOffset - HEADER - metaBytes.length), body]);
}

/** An LZ4 block holding `src` as one literal run (valid, if not small). */
export function lz4Literal(src: Buffer): Buffer {
  const out: number[] = [];
  const n = src.length;
  out.push((Math.min(n, 15) << 4) & 0xff);
  if (n >= 15) {
    let v = n - 15;
    while (v >= 255) {
      out.push(255);
      v -= 255;
    }
    out.push(v);
  }
  return Buffer.concat([Buffer.from(out), src]);
}

/** A tiny greedy LZ4 block encoder (quadratic; small inputs only). */
export function lz4Encode(src: Uint8Array): Buffer {
  const out: number[] = [];
  const n = src.length;
  const writeLen = (v: number): void => {
    while (v >= 255) {
      out.push(255);
      v -= 255;
    }
    out.push(v);
  };
  let anchor = 0;
  let i = 0;
  const limit = n - 5; // the last five bytes stay literals
  while (i + 4 <= limit) {
    let bestLen = 0;
    let bestOff = 0;
    for (let j = Math.max(0, i - 65535); j < i; j++) {
      let l = 0;
      while (i + l < limit && src[j + l] === src[i + l]) l++;
      if (l > bestLen) {
        bestLen = l;
        bestOff = i - j;
      }
    }
    if (bestLen < 4) {
      i++;
      continue;
    }
    const lit = i - anchor;
    const ml = bestLen - 4;
    out.push((Math.min(lit, 15) << 4) | Math.min(ml, 15));
    if (lit >= 15) writeLen(lit - 15);
    for (let k = anchor; k < i; k++) out.push(src[k]);
    out.push(bestOff & 0xff, bestOff >> 8);
    if (ml >= 15) writeLen(ml - 15);
    i += bestLen;
    anchor = i;
  }
  const lit = n - anchor;
  out.push(Math.min(lit, 15) << 4);
  if (lit >= 15) writeLen(lit - 15);
  for (let k = anchor; k < n; k++) out.push(src[k]);
  return Buffer.from(out);
}

/**
 * A UnityFS bundle (format 6, engine 2019.4.8f1) with one block holding the
 * given files back to back. `lz4` compresses the blocks info and the block.
 */
export function buildBundle(files: Array<{ path: string; data: Buffer }>, lz4 = true): Buffer {
  const block = Buffer.concat(files.map((f) => f.data));
  const packedBlock = lz4 ? lz4Encode(block) : block;
  const info = new Writer(false);
  info.push(Buffer.alloc(16));
  info.i32(1);
  info.u32(block.length);
  info.u32(packedBlock.length);
  info.u16(lz4 ? 2 : 0);
  info.i32(files.length);
  let offset = 0;
  for (const f of files) {
    info.i64(BigInt(offset));
    info.i64(BigInt(f.data.length));
    info.u32(4);
    info.cstr(f.path);
    offset += f.data.length;
  }
  const infoRaw = info.bytes();
  const infoPacked = lz4 ? lz4Literal(infoRaw) : infoRaw;
  const head = new Writer(false);
  head.cstr('UnityFS');
  head.u32(6);
  head.cstr('5.x.x');
  head.cstr('2019.4.8f1');
  const tail = new Writer(false);
  tail.u32(infoPacked.length);
  tail.u32(infoRaw.length);
  tail.u32(0x40 | (lz4 ? 2 : 0));
  const headBytes = head.bytes();
  const total = headBytes.length + 8 + 12 + infoPacked.length + packedBlock.length;
  const size = new Writer(false);
  size.i64(BigInt(total));
  return Buffer.concat([headBytes, size.bytes(), tail.bytes(), infoPacked, packedBlock]);
}

/** A width×height RGBA32 image whose every byte says where it is. */
export function patternPixels(width: number, height: number): Buffer {
  const b = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      b[o] = x * 16;
      b[o + 1] = y * 16;
      b[o + 2] = 200;
      b[o + 3] = 255 - x - y;
    }
  }
  return b;
}
