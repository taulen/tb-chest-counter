/**
 * Minimal image headers for upload tests. Only the parts the sniffer reads
 * (src/utils/image-sniff.ts) are real; nothing here is meant to decode.
 * `pad` adds filler after the header, to make a body of a given size.
 */

export function pngBytes(width: number, height: number, pad = 0): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head[24] = 8; // bit depth
  head[25] = 6; // RGBA
  return Buffer.concat([head, Buffer.alloc(pad)]);
}

export function jpegBytes(width: number, height: number): Buffer {
  // SOI, an APP0 (JFIF) segment to walk past, then SOF0 with the size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function riff(chunk: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(chunk.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, chunk]);
}

export function webpLossyBytes(width: number, height: number): Buffer {
  const c = Buffer.alloc(20);
  c.write('VP8 ', 0, 'latin1');
  c.writeUInt32LE(10, 4);
  // frame tag (3 bytes) then the key frame start code
  c[11] = 0x9d; c[12] = 0x01; c[13] = 0x2a;
  c.writeUInt16LE(width & 0x3fff, 14);
  c.writeUInt16LE(height & 0x3fff, 16);
  return riff(c);
}

export function webpLosslessBytes(width: number, height: number): Buffer {
  const c = Buffer.alloc(16);
  c.write('VP8L', 0, 'latin1');
  c.writeUInt32LE(5, 4);
  c[8] = 0x2f;
  c.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 9);
  return riff(c);
}

export function webpExtendedBytes(width: number, height: number): Buffer {
  const c = Buffer.alloc(18);
  c.write('VP8X', 0, 'latin1');
  c.writeUInt32LE(10, 4);
  c.writeUIntLE(width - 1, 12, 3);
  c.writeUIntLE(height - 1, 15, 3);
  return riff(c);
}
