/**
 * Wire codec for Total Battle's game server ("rubens" HTTP endpoints).
 *
 * The body of every request and reply is a sequence of frames:
 *
 *   u32le len      — whole frame, including this 8-byte header
 *   u32le replyLen — header + the message itself; bytes [replyLen, len) are a
 *                    trailer: pushed events on replies, event acks on requests
 *   message        — MessagePack, EXCEPT that every multi-byte number and length
 *                    is LITTLE-endian (standard MessagePack is big-endian)
 *
 * A message is a head array `[type, seq, ...]` followed by body values. Type 2
 * is a batch whose body carries nested frames. Pushed events in a reply trailer
 * are `u32le len (incl. itself)`, then `[objectId(12 bytes), evType, ts, code]`,
 * then the event body.
 *
 * The encoder writes the smallest representation for each value, which is what
 * the game client does: captured requests re-encode byte-identical (verified on
 * 181 real requests). Full background: docs/game-protocol.md.
 */

/** A decoded MessagePack bin value. 12-byte bins are MongoDB-style object ids. */
export interface BinValue {
  $bin: number;
  hex: string;
}

/** A map whose keys aren't all scalars (the game uses array keys in places). */
export interface PairsValue {
  $pairs: Array<[Wire, Wire]>;
}

export type Wire =
  | null
  | boolean
  | number
  | string
  | BinValue
  | PairsValue
  | Wire[]
  | { [key: string]: Wire };

export class WireReader {
  pos: number;

  constructor(
    private readonly buf: Buffer,
    pos = 0,
    private readonly end = buf.length,
  ) {
    this.pos = pos;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) {
      throw new RangeError(`wire overrun at ${this.pos}+${n} > ${this.end}`);
    }
  }

  private u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }

  private num(read: (at: number) => number | bigint, bytes: number): number | string {
    this.need(bytes);
    const v = read.call(this.buf, this.pos);
    this.pos += bytes;
    if (typeof v === 'bigint') {
      // Ids fit comfortably below 2^53; anything bigger is kept exact as "<n>n".
      return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : `${v}n`;
    }
    return v;
  }

  private bytes(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  private str(n: number): string {
    return this.bytes(n).toString('utf8');
  }

  private arr(n: number): Wire[] {
    const out: Wire[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.value();
    return out;
  }

  private map(n: number): Wire {
    const pairs: Array<[Wire, Wire]> = [];
    let scalarKeys = true;
    for (let i = 0; i < n; i++) {
      const k = this.value();
      const v = this.value();
      if (k !== null && typeof k === 'object') scalarKeys = false;
      pairs.push([k, v]);
    }
    if (!scalarKeys) return { $pairs: pairs };
    const o: { [key: string]: Wire } = {};
    for (const [k, v] of pairs) o[String(k)] = v;
    return o;
  }

  private bin(b: Buffer): BinValue {
    return { $bin: b.length, hex: b.toString('hex') };
  }

  /** Decode one value. */
  value(): Wire {
    const t = this.u8();
    if (t <= 0x7f) return t;
    if (t >= 0xe0) return t - 0x100;
    if (t >= 0x80 && t <= 0x8f) return this.map(t & 0x0f);
    if (t >= 0x90 && t <= 0x9f) return this.arr(t & 0x0f);
    if (t >= 0xa0 && t <= 0xbf) return this.str(t & 0x1f);
    const b = this.buf;
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return this.bin(this.bytes(this.u8()));
      case 0xc5: return this.bin(this.bytes(this.num(b.readUInt16LE, 2) as number));
      case 0xc6: return this.bin(this.bytes(this.num(b.readUInt32LE, 4) as number));
      case 0xc7: { const n = this.u8(); this.u8(); return this.bin(this.bytes(n)); }
      case 0xc8: { const n = this.num(b.readUInt16LE, 2) as number; this.u8(); return this.bin(this.bytes(n)); }
      case 0xc9: { const n = this.num(b.readUInt32LE, 4) as number; this.u8(); return this.bin(this.bytes(n)); }
      case 0xca: return this.num(b.readFloatLE, 4) as number;
      case 0xcb: return this.num(b.readDoubleLE, 8) as number;
      case 0xcc: return this.u8();
      case 0xcd: return this.num(b.readUInt16LE, 2);
      case 0xce: return this.num(b.readUInt32LE, 4);
      case 0xcf: return this.num(b.readBigUInt64LE, 8);
      case 0xd0: return this.num(b.readInt8, 1);
      case 0xd1: return this.num(b.readInt16LE, 2);
      case 0xd2: return this.num(b.readInt32LE, 4);
      case 0xd3: return this.num(b.readBigInt64LE, 8);
      case 0xd4: this.u8(); return this.bin(this.bytes(1));
      case 0xd5: this.u8(); return this.bin(this.bytes(2));
      case 0xd6: this.u8(); return this.bin(this.bytes(4));
      case 0xd7: this.u8(); return this.bin(this.bytes(8));
      case 0xd8: this.u8(); return this.bin(this.bytes(16));
      case 0xd9: return this.str(this.u8());
      case 0xda: return this.str(this.num(b.readUInt16LE, 2) as number);
      case 0xdb: return this.str(this.num(b.readUInt32LE, 4) as number);
      case 0xdc: return this.arr(this.num(b.readUInt16LE, 2) as number);
      case 0xdd: return this.arr(this.num(b.readUInt32LE, 4) as number);
      case 0xde: return this.map(this.num(b.readUInt16LE, 2) as number);
      case 0xdf: return this.map(this.num(b.readUInt32LE, 4) as number);
      default: throw new TypeError(`unknown wire tag 0x${t.toString(16)} at ${this.pos - 1}`);
    }
  }

  /**
   * Advance past one value without building it. The static tables are ~45 MB
   * and we need a handful of them, so skipping is what keeps a rebuild inside
   * the container's heap.
   */
  skip(): void {
    const t = this.u8();
    if (t <= 0x7f || t >= 0xe0 || t === 0xc0 || t === 0xc2 || t === 0xc3) return;
    if (t >= 0x80 && t <= 0x8f) return this.skipN((t & 0x0f) * 2);
    if (t >= 0x90 && t <= 0x9f) return this.skipN(t & 0x0f);
    if (t >= 0xa0 && t <= 0xbf) return void this.bytes(t & 0x1f);
    const b = this.buf;
    const len16 = () => this.num(b.readUInt16LE, 2) as number;
    const len32 = () => this.num(b.readUInt32LE, 4) as number;
    switch (t) {
      case 0xc4: case 0xd9: return void this.bytes(this.u8());
      case 0xc5: case 0xda: return void this.bytes(len16());
      case 0xc6: case 0xdb: return void this.bytes(len32());
      case 0xc7: { const n = this.u8(); return void this.bytes(n + 1); }
      case 0xc8: { const n = len16(); return void this.bytes(n + 1); }
      case 0xc9: { const n = len32(); return void this.bytes(n + 1); }
      case 0xcc: case 0xd0: return void this.bytes(1);
      case 0xcd: case 0xd1: return void this.bytes(2);
      case 0xce: case 0xd2: case 0xca: return void this.bytes(4);
      case 0xcf: case 0xd3: case 0xcb: return void this.bytes(8);
      case 0xd4: return void this.bytes(2);
      case 0xd5: return void this.bytes(3);
      case 0xd6: return void this.bytes(5);
      case 0xd7: return void this.bytes(9);
      case 0xd8: return void this.bytes(17);
      case 0xdc: return this.skipN(len16());
      case 0xdd: return this.skipN(len32());
      case 0xde: return this.skipN(len16() * 2);
      case 0xdf: return this.skipN(len32() * 2);
      default: throw new TypeError(`unknown wire tag 0x${t.toString(16)} at ${this.pos - 1}`);
    }
  }

  private skipN(n: number): void {
    for (let i = 0; i < n; i++) this.skip();
  }

  /** Read an array header and return its length (for streaming over big arrays). */
  arrayLength(): number {
    const t = this.u8();
    if (t >= 0x90 && t <= 0x9f) return t & 0x0f;
    if (t === 0xdc) return this.num(this.buf.readUInt16LE, 2) as number;
    if (t === 0xdd) return this.num(this.buf.readUInt32LE, 4) as number;
    throw new TypeError(`expected an array at ${this.pos - 1}, got tag 0x${t.toString(16)}`);
  }

  /** Read a map header and return its entry count. */
  mapLength(): number {
    const t = this.u8();
    if (t >= 0x80 && t <= 0x8f) return t & 0x0f;
    if (t === 0xde) return this.num(this.buf.readUInt16LE, 2) as number;
    if (t === 0xdf) return this.num(this.buf.readUInt32LE, 4) as number;
    throw new TypeError(`expected a map at ${this.pos - 1}, got tag 0x${t.toString(16)}`);
  }
}

/** Decode a whole buffer holding exactly one value. */
export function decodeValue(buf: Buffer): Wire {
  return new WireReader(buf).value();
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

function encodeInto(v: Wire | undefined, o: number[]): void {
  const push = (...bytes: number[]) => { for (const x of bytes) o.push(x & 0xff); };
  const put = (b: Buffer) => { for (const x of b) o.push(x); };
  const int = (n: number | bigint, bytes: number, signed: boolean) => {
    const b = Buffer.alloc(bytes);
    if (bytes === 1) signed ? b.writeInt8(Number(n)) : b.writeUInt8(Number(n));
    else if (bytes === 2) signed ? b.writeInt16LE(Number(n)) : b.writeUInt16LE(Number(n));
    else if (bytes === 4) signed ? b.writeInt32LE(Number(n)) : b.writeUInt32LE(Number(n));
    else signed ? b.writeBigInt64LE(BigInt(n)) : b.writeBigUInt64LE(BigInt(n));
    put(b);
  };

  if (v === null || v === undefined) return push(0xc0);
  if (v === false) return push(0xc2);
  if (v === true) return push(0xc3);
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(v);
      push(0xcb);
      return put(b);
    }
    if (v >= 0) {
      if (v <= 0x7f) return push(v);
      if (v <= 0xff) return push(0xcc, v);
      if (v <= 0xffff) { push(0xcd); return int(v, 2, false); }
      if (v <= 0xffffffff) { push(0xce); return int(v, 4, false); }
      push(0xcf);
      return int(v, 8, false);
    }
    if (v >= -32) return push(0x100 + v);
    if (v >= -128) { push(0xd0); return int(v, 1, true); }
    if (v >= -32768) { push(0xd1); return int(v, 2, true); }
    if (v >= -2147483648) { push(0xd2); return int(v, 4, true); }
    push(0xd3);
    return int(v, 8, true);
  }
  if (typeof v === 'string') {
    if (/^-?\d+n$/.test(v)) {
      // An exact 64-bit integer the decoder kept as "<n>n".
      const n = BigInt(v.slice(0, -1));
      push(n < 0n ? 0xd3 : 0xcf);
      return int(n, 8, n < 0n);
    }
    const b = Buffer.from(v, 'utf8');
    if (b.length <= 31) push(0xa0 | b.length);
    else if (b.length <= 0xff) push(0xd9, b.length);
    else if (b.length <= 0xffff) { push(0xda); int(b.length, 2, false); }
    else { push(0xdb); int(b.length, 4, false); }
    return put(b);
  }
  if (Array.isArray(v)) {
    if (v.length <= 15) push(0x90 | v.length);
    else if (v.length <= 0xffff) { push(0xdc); int(v.length, 2, false); }
    else { push(0xdd); int(v.length, 4, false); }
    for (const x of v) encodeInto(x, o);
    return;
  }
  if ('$bin' in v && typeof (v as BinValue).hex === 'string') {
    const b = Buffer.from((v as BinValue).hex, 'hex');
    if (b.length <= 0xff) push(0xc4, b.length);
    else { push(0xc6); int(b.length, 4, false); }
    return put(b);
  }
  const pairs: Array<[Wire, Wire]> = '$pairs' in v
    ? (v as PairsValue).$pairs
    : Object.entries(v as { [key: string]: Wire }).map(([k, x]) => [/^-?\d+$/.test(k) ? Number(k) : k, x]);
  if (pairs.length <= 15) push(0x80 | pairs.length);
  else { push(0xde); int(pairs.length, 2, false); }
  for (const [k, x] of pairs) {
    encodeInto(k, o);
    encodeInto(x, o);
  }
}

/** Encode values back-to-back (no frame header). */
export function encodeValues(values: Wire[]): Buffer {
  const o: number[] = [];
  for (const v of values) encodeInto(v, o);
  return Buffer.from(o);
}

/** Build one request frame: head + body values, no trailer. */
export function encodeFrame(head: Wire[], body: Wire[]): Buffer {
  const payload = encodeValues([head, ...body]);
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt32LE(buf.length, 0);
  buf.writeUInt32LE(buf.length, 4);
  payload.copy(buf, 8);
  return buf;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export interface PushedEvent {
  oid: string | undefined;
  evType: number | undefined;
  ts: number | undefined;
  code: number | undefined;
  body: Wire[];
}

export interface Frame {
  type: number | undefined;
  seq: number | undefined;
  head: Wire;
  body: Wire[];
  /** Nested frames (batches). */
  children: Frame[];
  events: PushedEvent[];
}

function looksLikeFrame(buf: Buffer, pos: number, end: number): boolean {
  if (pos + 9 > end) return false;
  const a = buf.readUInt32LE(pos);
  const b = buf.readUInt32LE(pos + 4);
  return a >= 9 && b >= 9 && b <= a && pos + a <= end && buf[pos + 8] >= 0x90 && buf[pos + 8] <= 0x9f;
}

function readEvents(buf: Buffer, start: number, stop: number): PushedEvent[] {
  const out: PushedEvent[] = [];
  let p = start;
  while (p + 5 <= stop) {
    const n = buf.readUInt32LE(p);
    if (n < 5 || p + n > stop) break;
    const r = new WireReader(buf, p + 4, p + n);
    const vals: Wire[] = [];
    try {
      while (!r.done) vals.push(r.value());
    } catch {
      // A malformed event never invalidates the reply it rode in on.
    }
    const h = Array.isArray(vals[0]) ? vals[0] : [];
    const oid = h[0] && typeof h[0] === 'object' && '$bin' in h[0] ? (h[0] as BinValue).hex : undefined;
    out.push({
      oid,
      evType: typeof h[1] === 'number' ? h[1] : undefined,
      ts: typeof h[2] === 'number' ? h[2] : undefined,
      code: typeof h[3] === 'number' ? h[3] : undefined,
      body: vals.slice(1),
    });
    p += n;
  }
  return out;
}

function readFrame(buf: Buffer, pos: number, end: number): { frame: Frame; next: number } {
  const len = buf.readUInt32LE(pos);
  const len2 = buf.readUInt32LE(pos + 4);
  const stop = Math.min(pos + len, end);
  const replyEnd = len2 >= 9 && len2 <= len ? Math.min(pos + len2, stop) : stop;
  const r = new WireReader(buf, pos + 8, replyEnd);
  const head = r.value();
  const frame: Frame = {
    type: Array.isArray(head) && typeof head[0] === 'number' ? head[0] : undefined,
    seq: Array.isArray(head) && typeof head[1] === 'number' ? head[1] : undefined,
    head,
    body: [],
    children: [],
    events: [],
  };
  while (r.pos < replyEnd) {
    if (looksLikeFrame(buf, r.pos, replyEnd)) {
      const sub = readFrame(buf, r.pos, replyEnd);
      frame.children.push(sub.frame);
      r.pos = sub.next;
    } else {
      frame.body.push(r.value());
    }
  }
  if (replyEnd < stop) frame.events = readEvents(buf, replyEnd, stop);
  return { frame, next: stop };
}

/** Decode a reply body: one or more back-to-back frames. */
export function decodeFrames(buf: Buffer): Frame[] {
  const frames: Frame[] = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    const { frame, next } = readFrame(buf, pos, buf.length);
    frames.push(frame);
    if (next <= pos) break;
    pos = next;
  }
  return frames;
}

/** Flatten batches: every non-batch message, depth-first. */
export function messages(frames: Frame[]): Frame[] {
  const out: Frame[] = [];
  for (const f of frames) {
    if (f.children.length) out.push(...messages(f.children));
    else out.push(f);
  }
  return out;
}

/** Every pushed event in the reply, batches included. */
export function pushedEvents(frames: Frame[]): PushedEvent[] {
  const out: PushedEvent[] = [];
  for (const f of frames) {
    out.push(...f.events);
    if (f.children.length) out.push(...pushedEvents(f.children));
  }
  return out;
}
