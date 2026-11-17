/**
 * LZ4 block-format decompression (no frame header), as Unity stores each
 * bundle block. LZ4 and LZ4HC share the decoder.
 *
 * A sequence is: token (high nibble = literal length, low = match length − 4),
 * extended lengths as runs of 255-bytes, the literals, then a 2-byte LE match
 * offset. The last sequence carries literals only.
 */
export function lz4BlockDecompress(src: Uint8Array, uncompressedSize: number): Buffer {
  const dst = Buffer.alloc(uncompressedSize);
  const srcLen = src.length;
  let si = 0;
  let di = 0;
  while (si < srcLen) {
    const token = src[si++];
    let litLen = token >>> 4;
    if (litLen === 15) {
      let b: number;
      do {
        if (si >= srcLen) throw new Error('lz4: truncated literal length');
        b = src[si++];
        litLen += b;
      } while (b === 255);
    }
    if (si + litLen > srcLen || di + litLen > uncompressedSize) throw new Error('lz4: literal run out of bounds');
    dst.set(src.subarray(si, si + litLen), di);
    si += litLen;
    di += litLen;
    if (si >= srcLen) break; // the last sequence ends after its literals
    if (si + 2 > srcLen) throw new Error('lz4: truncated match offset');
    const offset = src[si] | (src[si + 1] << 8);
    si += 2;
    if (offset === 0 || offset > di) throw new Error(`lz4: bad match offset ${offset} at output ${di}`);
    let matchLen = token & 15;
    if (matchLen === 15) {
      let b: number;
      do {
        if (si >= srcLen) throw new Error('lz4: truncated match length');
        b = src[si++];
        matchLen += b;
      } while (b === 255);
    }
    matchLen += 4;
    if (di + matchLen > uncompressedSize) throw new Error('lz4: match runs past the output');
    let mi = di - offset;
    if (offset >= matchLen) {
      dst.copyWithin(di, mi, mi + matchLen);
      di += matchLen;
    } else {
      // Overlapping copy: the run repeats the last `offset` bytes.
      for (let k = 0; k < matchLen; k++) dst[di++] = dst[mi++];
    }
  }
  if (di !== uncompressedSize) throw new Error(`lz4: produced ${di} bytes, expected ${uncompressedSize}`);
  return dst;
}
