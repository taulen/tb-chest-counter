import sharp from 'sharp';
import type { RgbaImage } from './texture.js';

function fullyOpaque(img: RgbaImage): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return false;
  return true;
}

/** RGBA (top-down) → PNG. Opaque images are written as RGB, which is smaller. */
export async function encodePng(img: RgbaImage): Promise<Buffer> {
  let pipeline = sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });
  if (fullyOpaque(img)) pipeline = pipeline.removeAlpha();
  return pipeline.png({ compressionLevel: 9 }).toBuffer();
}

/** PNG → RGBA (top-down); for tests and checks. */
export async function decodePng(png: Buffer): Promise<RgbaImage> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}
