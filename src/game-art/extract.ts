/**
 * Bundle → images: every Sprite and Texture2D in a UnityFS bundle whose name
 * the caller wants, decoded to top-down RGBA.
 *
 * A Sprite is cut from its texture by its textureRect (the texture is the
 * sprite's own, a sliced sheet, or a packed atlas — via SpriteAtlas render
 * data when the sprite points at one), un-rotated/flipped when the packer
 * rotated it, then flipped to top-down. The cut is the full rect, the way a UI
 * Image draws it; pixels outside a tight sprite mesh are kept (they are
 * near-transparent by construction).
 */
import { readUnityBundle, nodeData, type UnityBundle } from './unityfs.js';
import {
  readSerializedFile,
  readObject,
  peekName,
  CLASS_SPRITE,
  CLASS_TEXTURE2D,
  CLASS_SPRITE_ATLAS,
  type SerializedFile,
  type UObject,
  type UValue,
} from './serialized-file.js';
import {
  decodeTexture,
  textureByteSize,
  flipRows,
  cropImage,
  flipHorizontal,
  rotate180,
  rotateClockwise,
  type RgbaImage,
} from './texture.js';

export interface ExtractedImage {
  /** The object's m_Name as stored (case kept). */
  name: string;
  kind: 'sprite' | 'texture';
  /** Texture format of the source pixels. */
  format: number;
  image: RgbaImage;
}

export interface ExtractResult {
  images: ExtractedImage[];
  /** One line per object that matched but could not be decoded. */
  errors: string[];
}

const SPRITE_ROTATE_FLIP_H = 1;
const SPRITE_ROTATE_FLIP_V = 2;
const SPRITE_ROTATE_180 = 3;
const SPRITE_ROTATE_90 = 4;

interface Loaded {
  file: SerializedFile;
  nodePath: string;
}

function obj(v: UValue | undefined): UObject | null {
  return v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) ? (v as UObject) : null;
}

function num(v: UValue | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return 0;
}

function pathIdOf(ptr: UObject | null): bigint {
  const p = ptr?.m_PathID;
  return typeof p === 'bigint' ? p : BigInt(typeof p === 'number' ? p : 0);
}

function fileIdOf(ptr: UObject | null): number {
  return num(ptr?.m_FileID);
}

function baseName(p: string): string {
  const parts = p.split(/[/\\]/);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/** Same render-data key? (pair<GUID, SInt64>) */
function sameKey(a: UValue | undefined, b: UValue | undefined): boolean {
  const ka = obj(a);
  const kb = obj(b);
  if (!ka || !kb) return false;
  const ga = obj(ka.first);
  const gb = obj(kb.first);
  if (!ga || !gb) return false;
  for (const k of Object.keys(ga)) if (ga[k] !== gb[k]) return false;
  return ka.second === kb.second;
}

export function extractImages(bundleBuf: Buffer, wanted: (name: string) => boolean): ExtractResult {
  return extractFromBundle(readUnityBundle(bundleBuf), wanted);
}

export function extractFromBundle(bundle: UnityBundle, wanted: (name: string) => boolean): ExtractResult {
  const images: ExtractedImage[] = [];
  const errors: string[] = [];
  const files: Loaded[] = [];
  const nodesByBase = new Map<string, Buffer>();
  for (const n of bundle.nodes) nodesByBase.set(baseName(n.path), nodeData(bundle, n));
  for (const n of bundle.nodes) {
    if (/\.(resS|resource)$/i.test(n.path)) continue;
    try {
      files.push({ file: readSerializedFile(nodeData(bundle, n)), nodePath: n.path });
    } catch (err) {
      errors.push(`${n.path}: not a serialized file (${String(err)})`);
    }
  }

  const textureCache = new Map<string, { image: RgbaImage; format: number }>();

  /** The raw (bottom-up) pixels of a texture object, decoded once. */
  const loadTexture = (from: Loaded, ptr: UObject | null): { image: RgbaImage; format: number } => {
    const fileId = fileIdOf(ptr);
    const pathId = pathIdOf(ptr);
    let target: Loaded | undefined = from;
    if (fileId !== 0) {
      const ext = from.file.externals[fileId - 1];
      target = ext ? files.find((f) => baseName(f.nodePath) === baseName(ext)) : undefined;
      if (!target) throw new Error(`texture lives in another bundle (${ext ?? `file ${fileId}`})`);
    }
    const key = `${target.nodePath}:${pathId}`;
    const hit = textureCache.get(key);
    if (hit) return hit;
    const info = target.file.objects.find((o) => o.pathId === pathId);
    if (!info || info.classId !== CLASS_TEXTURE2D) throw new Error(`texture ${pathId} not found`);
    const decoded = decodeTextureObject(readObject(target.file, info), nodesByBase);
    textureCache.set(key, decoded);
    return decoded;
  };

  for (const loaded of files) {
    const { file } = loaded;
    for (const info of file.objects) {
      if (info.classId !== CLASS_SPRITE) continue;
      const name = peekName(file, info);
      if (name === null || !wanted(name)) continue;
      try {
        const sprite = readObject(file, info);
        let rd = obj(sprite.m_RD);
        const atlasPtr = obj(sprite.m_SpriteAtlas);
        if (atlasPtr && pathIdOf(atlasPtr) !== 0n && fileIdOf(atlasPtr) === 0) {
          const atlasInfo = file.objects.find((o) => o.pathId === pathIdOf(atlasPtr) && o.classId === CLASS_SPRITE_ATLAS);
          if (atlasInfo) {
            const atlas = readObject(file, atlasInfo);
            const map = atlas.m_RenderDataMap;
            if (Array.isArray(map)) {
              for (const entry of map) {
                const e = obj(entry);
                if (e && sameKey(e.first, sprite.m_RenderDataKey)) {
                  rd = obj(e.second) ?? rd;
                  break;
                }
              }
            }
          }
        }
        if (!rd) throw new Error('sprite has no render data');
        let tex = loadTexture(loaded, obj(rd.texture));
        const alphaPtr = obj(rd.alphaTexture);
        if (alphaPtr && pathIdOf(alphaPtr) !== 0n) {
          const alpha = loadTexture(loaded, alphaPtr);
          tex = { format: tex.format, image: mergeAlpha(tex.image, alpha.image) };
        }
        images.push({ name, kind: 'sprite', format: tex.format, image: cutSprite(tex.image, obj(rd.textureRect), num(rd.settingsRaw)) });
      } catch (err) {
        errors.push(`sprite ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  for (const loaded of files) {
    const { file } = loaded;
    for (const info of file.objects) {
      if (info.classId !== CLASS_TEXTURE2D) continue;
      const name = peekName(file, info);
      if (name === null || !wanted(name)) continue;
      try {
        const tex = loadTexture(loaded, { m_FileID: 0, m_PathID: info.pathId });
        images.push({ name, kind: 'texture', format: tex.format, image: flipRows(tex.image) });
      } catch (err) {
        errors.push(`texture ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { images, errors };
}

/** Decode a parsed Texture2D (inline image data or a .resS stream). Raw row order. */
export function decodeTextureObject(tex: UObject, nodesByBase: Map<string, Buffer>): { image: RgbaImage; format: number } {
  const width = num(tex.m_Width);
  const height = num(tex.m_Height);
  const format = num(tex.m_TextureFormat);
  const data = tex['image data'];
  let bytes: Buffer = Buffer.isBuffer(data) ? data : Buffer.alloc(0);
  if (!bytes.length) {
    const stream = obj(tex.m_StreamData);
    const size = num(stream?.size);
    const path = typeof stream?.path === 'string' ? stream.path : '';
    if (size > 0 && path) {
      const src = nodesByBase.get(baseName(path));
      if (!src) throw new Error(`stream file ${path} not in bundle`);
      const offset = num(stream?.offset);
      if (offset + size > src.length) throw new Error('stream data runs past its file');
      bytes = src.subarray(offset, offset + size);
    }
  }
  if (!width || !height) throw new Error('texture has no size');
  if (!bytes.length) throw new Error('texture has no image data');
  const need = textureByteSize(format, width, height);
  if (need !== null && bytes.length < need) throw new Error(`texture data is ${bytes.length} bytes, format ${format} needs ${need}`);
  return { image: decodeTexture(format, bytes, width, height), format };
}

function mergeAlpha(color: RgbaImage, alpha: RgbaImage): RgbaImage {
  if (color.width !== alpha.width || color.height !== alpha.height) return color;
  const out = Buffer.from(color.data);
  // The alpha texture carries alpha in its first (red) channel.
  for (let i = 0; i < color.width * color.height; i++) out[i * 4 + 3] = alpha.data[i * 4];
  return { width: color.width, height: color.height, data: out };
}

/** Cut a sprite from raw (bottom-up) texture pixels and return it top-down. */
export function cutSprite(texture: RgbaImage, rect: UObject | null, settingsRaw: number): RgbaImage {
  if (!rect) throw new Error('sprite has no textureRect');
  const x0 = Math.round(num(rect.x));
  const y0 = Math.round(num(rect.y));
  const x1 = Math.round(num(rect.x) + num(rect.width));
  const y1 = Math.round(num(rect.y) + num(rect.height));
  if (x1 <= x0 || y1 <= y0) throw new Error('sprite rect is empty');
  let img = cropImage(texture, x0, y0, x1 - x0, y1 - y0);
  const packed = (settingsRaw & 1) === 1;
  if (packed) {
    switch ((settingsRaw >> 2) & 0xf) {
      case SPRITE_ROTATE_FLIP_H: img = flipHorizontal(img); break;
      case SPRITE_ROTATE_FLIP_V: img = flipRows(img); break;
      case SPRITE_ROTATE_180: img = rotate180(img); break;
      case SPRITE_ROTATE_90: img = rotateClockwise(img); break;
      default: break;
    }
  }
  return flipRows(img);
}

/**
 * One image per name: a Sprite wins over a Texture2D of the same name (for a
 * single-sprite texture they are the same pixels; for a sheet the sprite is the
 * part that is meant to be shown). Names compare case-insensitively.
 */
export function pickImages(images: ExtractedImage[]): ExtractedImage[] {
  const out = new Map<string, ExtractedImage>();
  for (const img of images) {
    const key = img.name.toLowerCase();
    const prev = out.get(key);
    if (!prev || (prev.kind === 'texture' && img.kind === 'sprite')) out.set(key, img);
  }
  return [...out.values()];
}
