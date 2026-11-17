"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BinaryReader = void 0;
/**
 * A cursor over a Buffer with switchable endianness — Unity files mix both:
 * bundle and serialized-file headers are big-endian, object data is usually
 * little-endian.
 */
class BinaryReader {
    pos;
    littleEndian;
    buf;
    constructor(buf, littleEndian = false, pos = 0) {
        this.buf = buf;
        this.littleEndian = littleEndian;
        this.pos = pos;
    }
    get length() {
        return this.buf.length;
    }
    need(n) {
        if (n < 0 || this.pos + n > this.buf.length) {
            throw new RangeError(`read of ${n} bytes at ${this.pos} runs past the end (${this.buf.length})`);
        }
    }
    u8() {
        this.need(1);
        return this.buf[this.pos++];
    }
    i8() {
        this.need(1);
        return this.buf.readInt8(this.pos++);
    }
    bool() {
        return this.u8() !== 0;
    }
    u16() {
        this.need(2);
        const v = this.littleEndian ? this.buf.readUInt16LE(this.pos) : this.buf.readUInt16BE(this.pos);
        this.pos += 2;
        return v;
    }
    i16() {
        this.need(2);
        const v = this.littleEndian ? this.buf.readInt16LE(this.pos) : this.buf.readInt16BE(this.pos);
        this.pos += 2;
        return v;
    }
    u32() {
        this.need(4);
        const v = this.littleEndian ? this.buf.readUInt32LE(this.pos) : this.buf.readUInt32BE(this.pos);
        this.pos += 4;
        return v;
    }
    i32() {
        this.need(4);
        const v = this.littleEndian ? this.buf.readInt32LE(this.pos) : this.buf.readInt32BE(this.pos);
        this.pos += 4;
        return v;
    }
    i64() {
        this.need(8);
        const v = this.littleEndian ? this.buf.readBigInt64LE(this.pos) : this.buf.readBigInt64BE(this.pos);
        this.pos += 8;
        return v;
    }
    u64() {
        this.need(8);
        const v = this.littleEndian ? this.buf.readBigUInt64LE(this.pos) : this.buf.readBigUInt64BE(this.pos);
        this.pos += 8;
        return v;
    }
    /** A 64-bit size or offset; refuses anything past Number's exact range. */
    i64Number() {
        const v = this.i64();
        if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < 0n)
            throw new RangeError(`64-bit value ${v} out of range`);
        return Number(v);
    }
    f32() {
        this.need(4);
        const v = this.littleEndian ? this.buf.readFloatLE(this.pos) : this.buf.readFloatBE(this.pos);
        this.pos += 4;
        return v;
    }
    f64() {
        this.need(8);
        const v = this.littleEndian ? this.buf.readDoubleLE(this.pos) : this.buf.readDoubleBE(this.pos);
        this.pos += 8;
        return v;
    }
    /** A view (not a copy) of the next n bytes. */
    bytes(n) {
        this.need(n);
        const v = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return v;
    }
    /** A NUL-terminated UTF-8 string. */
    cstring() {
        const end = this.buf.indexOf(0, this.pos);
        if (end < 0)
            throw new RangeError(`unterminated string at ${this.pos}`);
        const s = this.buf.toString('utf8', this.pos, end);
        this.pos = end + 1;
        return s;
    }
    align(n = 4) {
        const rem = this.pos % n;
        if (rem)
            this.pos += n - rem;
    }
}
exports.BinaryReader = BinaryReader;
//# sourceMappingURL=binary-reader.js.map