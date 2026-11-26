/**
 * The game's WebGL client build — where its UI art lives.
 *
 * The asset catalogue (catalog.ts) only lists the bundles of game content
 * (portraits, icons, chests). The UI the client draws them in — unit frames,
 * coloured backs, tier badges — is in the build's own Resources, packed into
 * one file next to the client's code:
 *
 *   versions.totalbattle.com/config?branch=current&simple=true
 *     .result.webgl_client_version.default            → build hash
 *   assets-webgl-client.totalbattle.dev/<hash>/Build/Triumph.data
 *     (~43 MB brotli on the wire, ~69 MB raw; observed Nov 2026)
 *
 * Triumph.data is a "UnityWebData1.0" container:
 *   16-byte magic "UnityWebData1.0\0", u32 header size (LE), then per file
 *   u32 offset, u32 size, u32 name length, name — to the end of the header.
 * Its `data.unity3d` is a UnityFS bundle (unityfs.ts) whose `resources.assets`
 * holds the Resources folder: ~1,600 Texture2D among 211,000 objects, and —
 * unlike the content bundles — WITHOUT type trees. So Texture2D is read here
 * with Unity's fixed field layout for the engine the file names (2021.3.56f2
 * in Nov 2026); a layout we do not know fails loudly, never guesses: a
 * texture is only accepted when the read ends exactly at the object's size.
 */
import { BinaryReader } from './binary-reader.js';
import { readUnityBundle, nodeData, parseEngineVersion, type UnityBundle } from './unityfs.js';
import { readSerializedFile, CLASS_TEXTURE2D } from './serialized-file.js';
import { decodeTexture, flipRows, textureByteSize } from './texture.js';
import type { ExtractedImage, ExtractResult } from './extract.js';

export const WEBGL_CLIENT_BASE = 'https://assets-webgl-client.totalbattle.dev/';
/** The build's data file, relative to its hash. */
export const WEBGL_DATA_FILE = 'Build/Triumph.data';

const WEB_DATA_MAGIC = 'UnityWebData1.0\0';

/** The live WebGL client build hash, from the versions config. */
export function webglClientVersionFromConfig(body: unknown): string {
  const v = (body as { result?: { webgl_client_version?: { default?: unknown } } })?.result?.webgl_client_version?.default;
  if (typeof v !== 'string' || !/^[0-9a-f]{32}$/.test(v)) throw new Error('versions config has no webgl client version');
  return v;
}

export function webglDataUrl(clientVersion: string): string {
  return `${WEBGL_CLIENT_BASE}${clientVersion}/${WEBGL_DATA_FILE}`;
}

/** The files of a UnityWebData container, as views into `buf`. */
export function parseUnityWebData(buf: Buffer): Map<string, Buffer> {
  if (buf.length < 20 || buf.toString('latin1', 0, WEB_DATA_MAGIC.length) !== WEB_DATA_MAGIC) {
    throw new Error('not a UnityWebData file');
  }
  const r = new BinaryReader(buf, true, WEB_DATA_MAGIC.length);
  const headerSize = r.u32();
  if (headerSize > buf.length) throw new Error('UnityWebData header runs past the file');
  const files = new Map<string, Buffer>();
  while (r.pos < headerSize) {
    const offset = r.u32();
    const size = r.u32();
    const name = r.bytes(r.u32()).toString('utf8');
    if (offset + size > buf.length) throw new Error(`UnityWebData file ${name} runs past the data`);
    files.set(name, buf.subarray(offset, offset + size));
  }
  return files;
}

export interface PlayerTexture {
  name: string;
  width: number;
  height: number;
  format: number;
  /** Inline image data (a view); empty when the pixels stream from a .resS. */
  image: Buffer;
  stream: { offset: number; size: number; path: string };
}

const atLeast = (v: [number, number, number], major: number, minor: number): boolean =>
  v[0] > major || (v[0] === major && v[1] >= minor);

/**
 * A Texture2D object of a player build (no type tree), Unity 2020.2 – 2022.1
 * field layout. `obj` is exactly the object's bytes.
 */
export function readPlayerTexture2D(obj: Buffer, engine: [number, number, number]): PlayerTexture {
  if (!atLeast(engine, 2020, 2) || atLeast(engine, 2022, 2)) {
    throw new Error(`no Texture2D layout for engine ${engine.join('.')}`);
  }
  const r = new BinaryReader(obj, true);
  const str = (): string => {
    const s = r.bytes(r.i32()).toString('utf8');
    r.align(4);
    return s;
  };
  const name = str();
  r.i32(); // m_ForcedFallbackFormat
  r.bool(); // m_DownscaleFallback
  r.bool(); // m_IsAlphaChannelOptional
  r.align(4);
  const width = r.i32();
  const height = r.i32();
  r.i32(); // m_CompleteImageSize
  r.i32(); // m_MipsStripped
  const format = r.i32();
  r.i32(); // m_MipCount
  r.bool(); // m_IsReadable
  r.bool(); // m_IsPreProcessed
  r.bool(); // m_IgnoreMasterTextureLimit
  r.bool(); // m_StreamingMipmaps
  r.align(4);
  r.i32(); // m_StreamingMipmapsPriority
  r.i32(); // m_ImageCount
  r.i32(); // m_TextureDimension
  r.bytes(24); // m_TextureSettings: filter, aniso, mip bias, wrap U/V/W
  r.i32(); // m_LightmapFormat
  r.i32(); // m_ColorSpace
  r.bytes(r.i32()); // m_PlatformBlob
  r.align(4);
  const image = r.bytes(r.i32());
  r.align(4);
  const offset = Number(r.u64());
  const size = r.u32();
  const path = str();
  if (r.pos !== obj.length) throw new Error(`Texture2D ${name}: read ${r.pos} of ${obj.length} bytes (layout mismatch)`);
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) throw new Error(`Texture2D ${name}: implausible size ${width}x${height}`);
  return { name, width, height, format, image, stream: { offset, size, path } };
}

/** The m_Name every named object starts with, or null when it does not look like one. */
function peekObjectName(data: Buffer, start: number, size: number): string | null {
  if (size < 4) return null;
  const n = data.readInt32LE(start);
  if (n < 0 || n > 256 || 4 + n > size) return null;
  return data.toString('utf8', start + 4, start + 4 + n);
}

/** The UnityFS bundle inside a WebGL client build's data file. */
export function readClientBundle(webData: Buffer): UnityBundle {
  const bundleBuf = parseUnityWebData(webData).get('data.unity3d');
  if (!bundleBuf) throw new Error('client data has no data.unity3d');
  return readUnityBundle(bundleBuf);
}

const CLASS_PLAYER_SETTINGS = 129;
export const CLIENT_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

/**
 * The build's version — PlayerSettings.bundleVersion, i.e. the game's
 * Application.version ("350.0.1122" in Nov 2026) — which the scan's login
 * sends. PlayerSettings sits in globalgamemanagers without a type tree, and its
 * field offsets move with the engine version, so it is not read at an offset.
 */
export function clientVersionFromBundle(bundle: UnityBundle): string {
  const node = bundle.nodes.find((n) => n.path === 'globalgamemanagers');
  if (!node) throw new Error('client data has no globalgamemanagers');
  const file = readSerializedFile(nodeData(bundle, node));
  const ps = file.objects.find((o) => o.classId === CLASS_PLAYER_SETTINGS);
  if (!ps) throw new Error('client data has no PlayerSettings');
  return clientVersionFromPlayerSettings(file.data.subarray(ps.byteStart, ps.byteStart + ps.byteSize));
}

/**
 * The one length-prefixed string shaped like a version in a PlayerSettings
 * object (companyName "Scorewarrior", productName "Triumph", bundleVersion…).
 * None, or two different ones, fails loudly rather than guessing.
 */
export function clientVersionFromPlayerSettings(obj: Buffer): string {
  const found = new Set<string>();
  for (let i = 0; i + 4 <= obj.length; i++) {
    const n = obj.readUInt32LE(i);
    if (n < 5 || n > 20 || i + 4 + n > obj.length) continue;
    const s = obj.toString('latin1', i + 4, i + 4 + n);
    if (CLIENT_VERSION_RE.test(s)) found.add(s);
  }
  if (found.size !== 1) {
    throw new Error(found.size ? `PlayerSettings holds ${found.size} version strings (${[...found].join(', ')})` : 'PlayerSettings holds no version string');
  }
  return [...found][0];
}

/**
 * Images (top-down, kind 'texture') of the Resources textures a WebGL client
 * build's data file holds, for the names `wanted` accepts (exact names).
 */
export function extractClientTextures(webData: Buffer, wanted: (name: string) => boolean): ExtractResult {
  return texturesFromClientBundle(readClientBundle(webData), wanted);
}

export function texturesFromClientBundle(bundle: UnityBundle, wanted: (name: string) => boolean): ExtractResult {
  const node = bundle.nodes.find((n) => n.path === 'resources.assets');
  if (!node) throw new Error('client data has no resources.assets');
  const file = readSerializedFile(nodeData(bundle, node));
  const engine = parseEngineVersion(file.engineVersion || bundle.engineVersion);
  const streams = new Map(bundle.nodes.map((n) => [n.path.replace(/^.*[\\/]/, ''), n]));
  const images: ExtractedImage[] = [];
  const errors: string[] = [];
  for (const info of file.objects) {
    if (info.classId !== CLASS_TEXTURE2D) continue;
    const name = peekObjectName(file.data, info.byteStart, info.byteSize);
    if (name === null || !wanted(name)) continue;
    try {
      const tex = readPlayerTexture2D(file.data.subarray(info.byteStart, info.byteStart + info.byteSize), engine);
      let bytes = tex.image;
      if (!bytes.length && tex.stream.size > 0) {
        const src = streams.get(tex.stream.path.replace(/^.*[\\/]/, ''));
        if (!src) throw new Error(`stream file ${tex.stream.path} not in the build`);
        const data = nodeData(bundle, src);
        if (tex.stream.offset + tex.stream.size > data.length) throw new Error('stream data runs past its file');
        bytes = data.subarray(tex.stream.offset, tex.stream.offset + tex.stream.size);
      }
      const need = textureByteSize(tex.format, tex.width, tex.height);
      if (need !== null && bytes.length < need) throw new Error(`data is ${bytes.length} bytes, format ${tex.format} needs ${need}`);
      images.push({ name, kind: 'texture', format: tex.format, image: flipRows(decodeTexture(tex.format, bytes, tex.width, tex.height)) });
    } catch (err) {
      errors.push(`texture ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { images, errors };
}
