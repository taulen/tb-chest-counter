"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEBGL_DATA_FILE = exports.WEBGL_CLIENT_BASE = void 0;
exports.webglClientVersionFromConfig = webglClientVersionFromConfig;
exports.webglDataUrl = webglDataUrl;
exports.parseUnityWebData = parseUnityWebData;
exports.readPlayerTexture2D = readPlayerTexture2D;
exports.extractClientTextures = extractClientTextures;
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
const binary_reader_js_1 = require("./binary-reader.js");
const unityfs_js_1 = require("./unityfs.js");
const serialized_file_js_1 = require("./serialized-file.js");
const texture_js_1 = require("./texture.js");
exports.WEBGL_CLIENT_BASE = 'https://assets-webgl-client.totalbattle.dev/';
/** The build's data file, relative to its hash. */
exports.WEBGL_DATA_FILE = 'Build/Triumph.data';
const WEB_DATA_MAGIC = 'UnityWebData1.0\0';
/** The live WebGL client build hash, from the versions config. */
function webglClientVersionFromConfig(body) {
    const v = body?.result?.webgl_client_version?.default;
    if (typeof v !== 'string' || !/^[0-9a-f]{32}$/.test(v))
        throw new Error('versions config has no webgl client version');
    return v;
}
function webglDataUrl(clientVersion) {
    return `${exports.WEBGL_CLIENT_BASE}${clientVersion}/${exports.WEBGL_DATA_FILE}`;
}
/** The files of a UnityWebData container, as views into `buf`. */
function parseUnityWebData(buf) {
    if (buf.length < 20 || buf.toString('latin1', 0, WEB_DATA_MAGIC.length) !== WEB_DATA_MAGIC) {
        throw new Error('not a UnityWebData file');
    }
    const r = new binary_reader_js_1.BinaryReader(buf, true, WEB_DATA_MAGIC.length);
    const headerSize = r.u32();
    if (headerSize > buf.length)
        throw new Error('UnityWebData header runs past the file');
    const files = new Map();
    while (r.pos < headerSize) {
        const offset = r.u32();
        const size = r.u32();
        const name = r.bytes(r.u32()).toString('utf8');
        if (offset + size > buf.length)
            throw new Error(`UnityWebData file ${name} runs past the data`);
        files.set(name, buf.subarray(offset, offset + size));
    }
    return files;
}
const atLeast = (v, major, minor) => v[0] > major || (v[0] === major && v[1] >= minor);
/**
 * A Texture2D object of a player build (no type tree), Unity 2020.2 – 2022.1
 * field layout. `obj` is exactly the object's bytes.
 */
function readPlayerTexture2D(obj, engine) {
    if (!atLeast(engine, 2020, 2) || atLeast(engine, 2022, 2)) {
        throw new Error(`no Texture2D layout for engine ${engine.join('.')}`);
    }
    const r = new binary_reader_js_1.BinaryReader(obj, true);
    const str = () => {
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
    if (r.pos !== obj.length)
        throw new Error(`Texture2D ${name}: read ${r.pos} of ${obj.length} bytes (layout mismatch)`);
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192)
        throw new Error(`Texture2D ${name}: implausible size ${width}x${height}`);
    return { name, width, height, format, image, stream: { offset, size, path } };
}
/** The m_Name every named object starts with, or null when it does not look like one. */
function peekObjectName(data, start, size) {
    if (size < 4)
        return null;
    const n = data.readInt32LE(start);
    if (n < 0 || n > 256 || 4 + n > size)
        return null;
    return data.toString('utf8', start + 4, start + 4 + n);
}
/**
 * Images (top-down, kind 'texture') of the Resources textures a WebGL client
 * build's data file holds, for the names `wanted` accepts (exact names).
 */
function extractClientTextures(webData, wanted) {
    const files = parseUnityWebData(webData);
    const bundleBuf = files.get('data.unity3d');
    if (!bundleBuf)
        throw new Error('client data has no data.unity3d');
    const bundle = (0, unityfs_js_1.readUnityBundle)(bundleBuf);
    const node = bundle.nodes.find((n) => n.path === 'resources.assets');
    if (!node)
        throw new Error('client data has no resources.assets');
    const file = (0, serialized_file_js_1.readSerializedFile)((0, unityfs_js_1.nodeData)(bundle, node));
    const engine = (0, unityfs_js_1.parseEngineVersion)(file.engineVersion || bundle.engineVersion);
    const streams = new Map(bundle.nodes.map((n) => [n.path.replace(/^.*[\\/]/, ''), n]));
    const images = [];
    const errors = [];
    for (const info of file.objects) {
        if (info.classId !== serialized_file_js_1.CLASS_TEXTURE2D)
            continue;
        const name = peekObjectName(file.data, info.byteStart, info.byteSize);
        if (name === null || !wanted(name))
            continue;
        try {
            const tex = readPlayerTexture2D(file.data.subarray(info.byteStart, info.byteStart + info.byteSize), engine);
            let bytes = tex.image;
            if (!bytes.length && tex.stream.size > 0) {
                const src = streams.get(tex.stream.path.replace(/^.*[\\/]/, ''));
                if (!src)
                    throw new Error(`stream file ${tex.stream.path} not in the build`);
                const data = (0, unityfs_js_1.nodeData)(bundle, src);
                if (tex.stream.offset + tex.stream.size > data.length)
                    throw new Error('stream data runs past its file');
                bytes = data.subarray(tex.stream.offset, tex.stream.offset + tex.stream.size);
            }
            const need = (0, texture_js_1.textureByteSize)(tex.format, tex.width, tex.height);
            if (need !== null && bytes.length < need)
                throw new Error(`data is ${bytes.length} bytes, format ${tex.format} needs ${need}`);
            images.push({ name, kind: 'texture', format: tex.format, image: (0, texture_js_1.flipRows)((0, texture_js_1.decodeTexture)(tex.format, bytes, tex.width, tex.height)) });
        }
        catch (err) {
            errors.push(`texture ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { images, errors };
}
//# sourceMappingURL=webgl-client.js.map