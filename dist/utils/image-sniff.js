"use strict";
/**
 * Identify an uploaded image by its bytes, never by its name or the
 * Content-Type the client claimed, and read its pixel size from the header.
 *
 * Only the three formats a browser's canvas exports (PNG, JPEG, WebP) are
 * recognised. Anything else — a renamed text file, an SVG, a GIF, a truncated
 * header — is null. The size comes from the format's own header (PNG IHDR,
 * JPEG SOFn, WebP VP8/VP8L/VP8X); nothing is decoded.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sniffImage = sniffImage;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function startsWith(buf, bytes, at = 0) {
    if (buf.length < at + bytes.length)
        return false;
    return bytes.every((b, i) => buf[at + i] === b);
}
function ascii(buf, at, len) {
    return buf.length >= at + len ? buf.toString('latin1', at, at + len) : '';
}
function sniffPng(buf) {
    // Signature, then the IHDR chunk: length (4) "IHDR" (4) width (4) height (4).
    if (!startsWith(buf, PNG_SIGNATURE) || ascii(buf, 12, 4) !== 'IHDR' || buf.length < 24)
        return null;
    return { mime: 'image/png', ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
function sniffJpeg(buf) {
    if (!startsWith(buf, [0xff, 0xd8, 0xff]))
        return null;
    // Walk the marker segments to the first start-of-frame (SOF0–SOF15, less the
    // DHT/JPG/DAC markers that share the range).
    let i = 2;
    while (i + 4 <= buf.length) {
        if (buf[i] !== 0xff)
            return null;
        const marker = buf[i + 1];
        // Fill bytes and the standalone markers carry no length.
        if (marker === 0xff) {
            i += 1;
            continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            i += 2;
            continue;
        }
        if (marker === 0xd9 || marker === 0xda)
            return null; // end of image / scan before any frame
        const len = buf.readUInt16BE(i + 2);
        if (len < 2)
            return null;
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
            if (i + 9 > buf.length)
                return null;
            return { mime: 'image/jpeg', ext: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
    }
    return null;
}
function sniffWebp(buf) {
    if (ascii(buf, 0, 4) !== 'RIFF' || ascii(buf, 8, 4) !== 'WEBP')
        return null;
    const chunk = ascii(buf, 12, 4);
    if (chunk === 'VP8 ') {
        // Lossy: a key frame's start code 9d 01 2a, then 14-bit width and height.
        if (buf.length < 30 || !startsWith(buf, [0x9d, 0x01, 0x2a], 23))
            return null;
        return { mime: 'image/webp', ext: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
        // Lossless: signature 0x2f, then width-1 and height-1 in 14 bits each.
        if (buf.length < 25 || buf[20] !== 0x2f)
            return null;
        const bits = buf.readUInt32LE(21);
        return { mime: 'image/webp', ext: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
        // Extended: canvas width-1 and height-1, 24 bits little-endian each.
        if (buf.length < 30)
            return null;
        return { mime: 'image/webp', ext: 'webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    return null;
}
/** The image's format and size, or null when the bytes aren't a PNG, JPEG or WebP. */
function sniffImage(buf) {
    const found = sniffPng(buf) ?? sniffJpeg(buf) ?? sniffWebp(buf);
    if (!found || found.width <= 0 || found.height <= 0)
        return null;
    return found;
}
//# sourceMappingURL=image-sniff.js.map