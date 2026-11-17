/**
 * Stills from the game's Spine animations.
 *
 * Some of the game's pictures exist only as an animated icon: the Ancients
 * event's Tome of Knowledge, Enchanted Figurine and Mysterious Clock
 * ("clandoom_icon_book_anim" …). Such a bundle holds one texture with every
 * part of the animation packed into it (outline, glow passes, the object
 * itself) and a TextAsset "<name>.atlas" — Spine's text atlas — naming each
 * part's rectangle. The still is the region holding the whole object, cut out
 * of the texture by its rectangle; with `pma: true` the colours are stored
 * premultiplied by alpha and are divided back out.
 *
 * Atlas format (Spine 4; Spine 3's `xy:` + `size:` is read too):
 *
 *   clandoom_icon_book_anim.png      ← page
 *   	size: 728, 164
 *   	pma: true
 *   book                             ← region
 *   	bounds: 153, 4, 146, 156        ← x, y (top-left origin), width, height
 *   	offsets: 0, 0, 150, 156
 */
import { cropImage, type RgbaImage } from './texture.js';

export interface AtlasRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Packed rotated by 90°: not cut (none of the regions we use are). */
  rotated: boolean;
}

export interface SpineAtlas {
  pma: boolean;
  regions: Map<string, AtlasRegion>;
}

const ints = (s: string): number[] => s.split(',').map((p) => Number.parseInt(p.trim(), 10));

export function parseSpineAtlas(text: string): SpineAtlas {
  const atlas: SpineAtlas = { pma: false, regions: new Map() };
  // A page starts with its image file name; the lines after it (indented or
  // not, depending on the exporter) are page settings until the first region.
  let inPage = false;
  let region: AtlasRegion | null = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      inPage = false;
      region = null;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      if (!inPage && /\.(png|jpg|webp)$/i.test(line)) {
        inPage = true;
        region = null;
        continue;
      }
      region = { x: 0, y: 0, w: 0, h: 0, rotated: false };
      atlas.regions.set(line, region);
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!region) {
      if (key === 'pma') atlas.pma = value === 'true';
      // Spine 3 says it with the page's format line instead.
      if (key === 'premultipliedAlpha') atlas.pma = value === 'true';
      continue;
    }
    if (key === 'bounds') [region.x, region.y, region.w, region.h] = ints(value);
    else if (key === 'xy') [region.x, region.y] = ints(value);
    else if (key === 'size') [region.w, region.h] = ints(value);
    else if (key === 'rotate') region.rotated = value === 'true' || value === '90' || value === '270';
  }
  return atlas;
}

/** Undo premultiplied alpha in place. */
function unpremultiply(img: RgbaImage): RgbaImage {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0 || a === 255) continue;
    for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, Math.round((d[i + c] * 255) / a));
  }
  return img;
}

/**
 * One region of a top-down texture as its own image, or null when the atlas
 * has no such region, it is packed rotated, or it falls outside the texture.
 */
export function cutAtlasRegion(texture: RgbaImage, atlas: SpineAtlas, name: string): RgbaImage | null {
  const r = atlas.regions.get(name);
  if (!r || r.rotated || r.w <= 0 || r.h <= 0) return null;
  if (r.x < 0 || r.y < 0 || r.x + r.w > texture.width || r.y + r.h > texture.height) return null;
  const cut = cropImage(texture, r.x, r.y, r.w, r.h);
  return atlas.pma ? unpremultiply(cut) : cut;
}
