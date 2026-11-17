"use strict";
/**
 * Texture2D pixel decoding to RGBA8, plus the few image operations sprite
 * cutting needs.
 *
 * Unity stores rows bottom-up: row 0 of the data is the BOTTOM of the image.
 * decodeTexture() returns the rows as stored ("raw" order); flipRows() turns
 * that into the top-down order a PNG wants. Sprite rects are in raw (bottom-up)
 * coordinates, so cut first and flip last.
 *
 * Channel conversions follow Pillow's unpackers, which is what the reference
 * extraction (UnityPy) used, so the output can be compared pixel for pixel:
 * 5/6-bit channels scale with x * 255 / 31 (or 63) truncated, DXT endpoints
 * expand by bit replication.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnsupportedTextureFormat = exports.TextureFormat = void 0;
exports.textureByteSize = textureByteSize;
exports.decodeRgb565 = decodeRgb565;
exports.decodeDxt1 = decodeDxt1;
exports.decodeDxt5 = decodeDxt5;
exports.decodeTexture = decodeTexture;
exports.flipRows = flipRows;
exports.cropImage = cropImage;
exports.flipHorizontal = flipHorizontal;
exports.rotate180 = rotate180;
exports.rotateClockwise = rotateClockwise;
exports.TextureFormat = {
    Alpha8: 1,
    ARGB4444: 2,
    RGB24: 3,
    RGBA32: 4,
    ARGB32: 5,
    RGB565: 7,
    DXT1: 10,
    DXT5: 12,
    RGBA4444: 13,
    BGRA32: 14,
};
class UnsupportedTextureFormat extends Error {
    format;
    constructor(format) {
        super(`unsupported texture format ${format}`);
        this.format = format;
    }
}
exports.UnsupportedTextureFormat = UnsupportedTextureFormat;
/** Bytes the top mip level takes in `format`, or null for unknown formats. */
function textureByteSize(format, width, height) {
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    switch (format) {
        case exports.TextureFormat.Alpha8: return width * height;
        case exports.TextureFormat.ARGB4444:
        case exports.TextureFormat.RGBA4444:
        case exports.TextureFormat.RGB565: return width * height * 2;
        case exports.TextureFormat.RGB24: return width * height * 3;
        case exports.TextureFormat.RGBA32:
        case exports.TextureFormat.ARGB32:
        case exports.TextureFormat.BGRA32: return width * height * 4;
        case exports.TextureFormat.DXT1: return bw * bh * 8;
        case exports.TextureFormat.DXT5: return bw * bh * 16;
        default: return null;
    }
}
function needBytes(src, n, what) {
    if (src.length < n)
        throw new Error(`${what}: ${src.length} bytes of image data, need ${n}`);
}
function decodeRgb565(src, width, height) {
    const n = width * height;
    needBytes(src, n * 2, 'RGB565');
    const out = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
        const p = src[i * 2] | (src[i * 2 + 1] << 8);
        out[i * 4] = Math.floor((((p >> 11) & 31) * 255) / 31);
        out[i * 4 + 1] = Math.floor((((p >> 5) & 63) * 255) / 63);
        out[i * 4 + 2] = Math.floor(((p & 31) * 255) / 31);
        out[i * 4 + 3] = 255;
    }
    return out;
}
/** A 565 endpoint, expanded by bit replication (as BC decoders do). */
function expand565(c, out, at) {
    const r = (c >> 11) & 31;
    const g = (c >> 5) & 63;
    const b = c & 31;
    out[at] = (r << 3) | (r >> 2);
    out[at + 1] = (g << 2) | (g >> 4);
    out[at + 2] = (b << 3) | (b >> 2);
    out[at + 3] = 255;
}
/**
 * One BC1 colour block (8 bytes) into a 4x4 RGBA palette lookup. `alwaysFour`
 * is the BC2/BC3 rule: their colour block never uses the 3-colour mode.
 */
function bc1Palette(src, at, alwaysFour, pal) {
    const c0 = src[at] | (src[at + 1] << 8);
    const c1 = src[at + 2] | (src[at + 3] << 8);
    expand565(c0, pal, 0);
    expand565(c1, pal, 4);
    if (c0 > c1 || alwaysFour) {
        for (let k = 0; k < 3; k++) {
            pal[8 + k] = Math.floor((2 * pal[k] + pal[4 + k]) / 3);
            pal[12 + k] = Math.floor((pal[k] + 2 * pal[4 + k]) / 3);
        }
        pal[11] = 255;
        pal[15] = 255;
    }
    else {
        for (let k = 0; k < 3; k++) {
            pal[8 + k] = Math.floor((pal[k] + pal[4 + k]) / 2);
            pal[12 + k] = 0;
        }
        pal[11] = 255;
        pal[15] = 0; // transparent black
    }
    return (src[at + 4] | (src[at + 5] << 8) | (src[at + 6] << 16) | (src[at + 7] << 24)) >>> 0;
}
function decodeBlocks(src, width, height, dxt5) {
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    const blockSize = dxt5 ? 16 : 8;
    needBytes(src, bw * bh * blockSize, dxt5 ? 'DXT5' : 'DXT1');
    const out = Buffer.alloc(width * height * 4);
    const pal = new Array(16).fill(0);
    const alpha = new Array(8).fill(0);
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const at = (by * bw + bx) * blockSize;
            // 16 3-bit alpha indices in 6 bytes: pixels 0-7 in the first 24 bits, 8-15 in the next.
            let alphaLo = 0;
            let alphaHi = 0;
            if (dxt5) {
                const a0 = src[at];
                const a1 = src[at + 1];
                alpha[0] = a0;
                alpha[1] = a1;
                if (a0 > a1) {
                    for (let k = 1; k < 7; k++)
                        alpha[k + 1] = Math.floor(((7 - k) * a0 + k * a1) / 7);
                }
                else {
                    for (let k = 1; k < 5; k++)
                        alpha[k + 1] = Math.floor(((5 - k) * a0 + k * a1) / 5);
                    alpha[6] = 0;
                    alpha[7] = 255;
                }
                alphaLo = src[at + 2] | (src[at + 3] << 8) | (src[at + 4] << 16);
                alphaHi = src[at + 5] | (src[at + 6] << 8) | (src[at + 7] << 16);
            }
            const lut = bc1Palette(src, dxt5 ? at + 8 : at, dxt5, pal);
            for (let py = 0; py < 4; py++) {
                const y = by * 4 + py;
                if (y >= height)
                    break;
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    if (x >= width)
                        continue;
                    const n = py * 4 + px;
                    const ci = (lut >>> (2 * n)) & 3;
                    const o = (y * width + x) * 4;
                    out[o] = pal[ci * 4];
                    out[o + 1] = pal[ci * 4 + 1];
                    out[o + 2] = pal[ci * 4 + 2];
                    out[o + 3] = dxt5 ? alpha[n < 8 ? (alphaLo >> (3 * n)) & 7 : (alphaHi >> (3 * (n - 8))) & 7] : pal[ci * 4 + 3];
                }
            }
        }
    }
    return out;
}
function decodeDxt1(src, width, height) {
    return decodeBlocks(src, width, height, false);
}
function decodeDxt5(src, width, height) {
    return decodeBlocks(src, width, height, true);
}
/** Decode the top mip level into RGBA8, rows in stored (bottom-up) order. */
function decodeTexture(format, src, width, height) {
    const n = width * height;
    let data;
    switch (format) {
        case exports.TextureFormat.RGBA32:
            needBytes(src, n * 4, 'RGBA32');
            data = Buffer.from(src.subarray(0, n * 4));
            break;
        case exports.TextureFormat.RGB24: {
            needBytes(src, n * 3, 'RGB24');
            data = Buffer.alloc(n * 4);
            for (let i = 0; i < n; i++) {
                data[i * 4] = src[i * 3];
                data[i * 4 + 1] = src[i * 3 + 1];
                data[i * 4 + 2] = src[i * 3 + 2];
                data[i * 4 + 3] = 255;
            }
            break;
        }
        case exports.TextureFormat.ARGB32:
        case exports.TextureFormat.BGRA32: {
            needBytes(src, n * 4, format === exports.TextureFormat.ARGB32 ? 'ARGB32' : 'BGRA32');
            data = Buffer.alloc(n * 4);
            const argb = format === exports.TextureFormat.ARGB32;
            for (let i = 0; i < n; i++) {
                const s = i * 4;
                if (argb) {
                    data[s] = src[s + 1];
                    data[s + 1] = src[s + 2];
                    data[s + 2] = src[s + 3];
                    data[s + 3] = src[s];
                }
                else {
                    data[s] = src[s + 2];
                    data[s + 1] = src[s + 1];
                    data[s + 2] = src[s];
                    data[s + 3] = src[s + 3];
                }
            }
            break;
        }
        case exports.TextureFormat.Alpha8: {
            needBytes(src, n, 'Alpha8');
            data = Buffer.alloc(n * 4);
            for (let i = 0; i < n; i++) {
                data[i * 4] = 255;
                data[i * 4 + 1] = 255;
                data[i * 4 + 2] = 255;
                data[i * 4 + 3] = src[i];
            }
            break;
        }
        case exports.TextureFormat.ARGB4444:
        case exports.TextureFormat.RGBA4444: {
            needBytes(src, n * 2, 'RGBA4444');
            data = Buffer.alloc(n * 4);
            const argb = format === exports.TextureFormat.ARGB4444;
            for (let i = 0; i < n; i++) {
                const p = src[i * 2] | (src[i * 2 + 1] << 8);
                const n0 = (p & 15) * 17;
                const n1 = ((p >> 4) & 15) * 17;
                const n2 = ((p >> 8) & 15) * 17;
                const n3 = ((p >> 12) & 15) * 17;
                // ARGB4444: A in the top nibble, then R, G, B. RGBA4444: R on top, A at the bottom.
                data[i * 4] = argb ? n2 : n3;
                data[i * 4 + 1] = argb ? n1 : n2;
                data[i * 4 + 2] = argb ? n0 : n1;
                data[i * 4 + 3] = argb ? n3 : n0;
            }
            break;
        }
        case exports.TextureFormat.RGB565:
            data = decodeRgb565(src, width, height);
            break;
        case exports.TextureFormat.DXT1:
            data = decodeDxt1(src, width, height);
            break;
        case exports.TextureFormat.DXT5:
            data = decodeDxt5(src, width, height);
            break;
        default:
            throw new UnsupportedTextureFormat(format);
    }
    return { width, height, data };
}
/** Reverse the row order (Unity's bottom-up rows → top-down). */
function flipRows(img) {
    const stride = img.width * 4;
    const out = Buffer.alloc(img.data.length);
    for (let y = 0; y < img.height; y++) {
        img.data.copy(out, (img.height - 1 - y) * stride, y * stride, (y + 1) * stride);
    }
    return { width: img.width, height: img.height, data: out };
}
/** A sub-rectangle, in the image's own row order. Clamped to the image. */
function cropImage(img, x, y, w, h) {
    const x0 = Math.max(0, Math.min(img.width, x));
    const y0 = Math.max(0, Math.min(img.height, y));
    const x1 = Math.max(x0, Math.min(img.width, x + w));
    const y1 = Math.max(y0, Math.min(img.height, y + h));
    const cw = x1 - x0;
    const ch = y1 - y0;
    const out = Buffer.alloc(cw * ch * 4);
    for (let row = 0; row < ch; row++) {
        img.data.copy(out, row * cw * 4, ((y0 + row) * img.width + x0) * 4, ((y0 + row) * img.width + x1) * 4);
    }
    return { width: cw, height: ch, data: out };
}
/** Map every output pixel from a source pixel; `src(x, y)` gets output coordinates. */
function remap(img, width, height, src) {
    const out = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [sx, sy] = src(x, y);
            img.data.copy(out, (y * width + x) * 4, (sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4);
        }
    }
    return { width, height, data: out };
}
function flipHorizontal(img) {
    return remap(img, img.width, img.height, (x, y) => [img.width - 1 - x, y]);
}
function rotate180(img) {
    return remap(img, img.width, img.height, (x, y) => [img.width - 1 - x, img.height - 1 - y]);
}
/** 90 degrees clockwise (Pillow's ROTATE_270), in the image's own row order. */
function rotateClockwise(img) {
    return remap(img, img.height, img.width, (x, y) => [y, img.height - 1 - x]);
}
//# sourceMappingURL=texture.js.map