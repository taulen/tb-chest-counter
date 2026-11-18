import { describe, expect, it } from 'vitest';
import { sniffImage } from '../../src/utils/image-sniff.js';
import {
  jpegBytes, pngBytes, webpExtendedBytes, webpLosslessBytes, webpLossyBytes,
} from '../helpers/image-bytes.js';

describe('sniffImage', () => {
  it('reads PNG, JPEG and all three WebP headers by their bytes', () => {
    expect(sniffImage(pngBytes(512, 512))).toEqual({ mime: 'image/png', ext: 'png', width: 512, height: 512 });
    expect(sniffImage(jpegBytes(640, 480))).toEqual({ mime: 'image/jpeg', ext: 'jpg', width: 640, height: 480 });
    expect(sniffImage(webpLossyBytes(512, 300))).toEqual({ mime: 'image/webp', ext: 'webp', width: 512, height: 300 });
    expect(sniffImage(webpLosslessBytes(1024, 1024))).toEqual({ mime: 'image/webp', ext: 'webp', width: 1024, height: 1024 });
    expect(sniffImage(webpExtendedBytes(2000, 1500))).toEqual({ mime: 'image/webp', ext: 'webp', width: 2000, height: 1500 });
  });

  it('refuses anything that is not one of the three — whatever it is called', () => {
    // A text file renamed .png: the name never reaches the sniffer, only bytes.
    expect(sniffImage(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a\x10\x00\x10\x00', 'latin1'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });

  it('refuses truncated headers and zero sizes', () => {
    expect(sniffImage(pngBytes(64, 64).subarray(0, 20))).toBeNull();
    expect(sniffImage(jpegBytes(64, 64).subarray(0, 12))).toBeNull();
    expect(sniffImage(webpLossyBytes(64, 64).subarray(0, 24))).toBeNull();
    expect(sniffImage(pngBytes(0, 64))).toBeNull();
  });
});
