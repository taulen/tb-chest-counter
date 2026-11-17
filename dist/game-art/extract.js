"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractImages = extractImages;
exports.extractFromBundle = extractFromBundle;
exports.extractTexts = extractTexts;
exports.decodeTextureObject = decodeTextureObject;
exports.cutSprite = cutSprite;
exports.pickImages = pickImages;
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
const unityfs_js_1 = require("./unityfs.js");
const serialized_file_js_1 = require("./serialized-file.js");
const texture_js_1 = require("./texture.js");
const SPRITE_ROTATE_FLIP_H = 1;
const SPRITE_ROTATE_FLIP_V = 2;
const SPRITE_ROTATE_180 = 3;
const SPRITE_ROTATE_90 = 4;
function obj(v) {
    return v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) ? v : null;
}
function num(v) {
    if (typeof v === 'number')
        return v;
    if (typeof v === 'bigint')
        return Number(v);
    return 0;
}
function pathIdOf(ptr) {
    const p = ptr?.m_PathID;
    return typeof p === 'bigint' ? p : BigInt(typeof p === 'number' ? p : 0);
}
function fileIdOf(ptr) {
    return num(ptr?.m_FileID);
}
function baseName(p) {
    const parts = p.split(/[/\\]/);
    return (parts[parts.length - 1] ?? '').toLowerCase();
}
/** Same render-data key? (pair<GUID, SInt64>) */
function sameKey(a, b) {
    const ka = obj(a);
    const kb = obj(b);
    if (!ka || !kb)
        return false;
    const ga = obj(ka.first);
    const gb = obj(kb.first);
    if (!ga || !gb)
        return false;
    for (const k of Object.keys(ga))
        if (ga[k] !== gb[k])
            return false;
    return ka.second === kb.second;
}
function extractImages(bundleBuf, wanted) {
    return extractFromBundle((0, unityfs_js_1.readUnityBundle)(bundleBuf), wanted);
}
function extractFromBundle(bundle, wanted) {
    const images = [];
    const errors = [];
    const files = [];
    const nodesByBase = new Map();
    for (const n of bundle.nodes)
        nodesByBase.set(baseName(n.path), (0, unityfs_js_1.nodeData)(bundle, n));
    for (const n of bundle.nodes) {
        if (/\.(resS|resource)$/i.test(n.path))
            continue;
        try {
            files.push({ file: (0, serialized_file_js_1.readSerializedFile)((0, unityfs_js_1.nodeData)(bundle, n)), nodePath: n.path });
        }
        catch (err) {
            errors.push(`${n.path}: not a serialized file (${String(err)})`);
        }
    }
    const textureCache = new Map();
    /** The raw (bottom-up) pixels of a texture object, decoded once. */
    const loadTexture = (from, ptr) => {
        const fileId = fileIdOf(ptr);
        const pathId = pathIdOf(ptr);
        let target = from;
        if (fileId !== 0) {
            const ext = from.file.externals[fileId - 1];
            target = ext ? files.find((f) => baseName(f.nodePath) === baseName(ext)) : undefined;
            if (!target)
                throw new Error(`texture lives in another bundle (${ext ?? `file ${fileId}`})`);
        }
        const key = `${target.nodePath}:${pathId}`;
        const hit = textureCache.get(key);
        if (hit)
            return hit;
        const info = target.file.objects.find((o) => o.pathId === pathId);
        if (!info || info.classId !== serialized_file_js_1.CLASS_TEXTURE2D)
            throw new Error(`texture ${pathId} not found`);
        const decoded = decodeTextureObject((0, serialized_file_js_1.readObject)(target.file, info), nodesByBase);
        textureCache.set(key, decoded);
        return decoded;
    };
    for (const loaded of files) {
        const { file } = loaded;
        for (const info of file.objects) {
            if (info.classId !== serialized_file_js_1.CLASS_SPRITE)
                continue;
            const name = (0, serialized_file_js_1.peekName)(file, info);
            if (name === null || !wanted(name))
                continue;
            try {
                const sprite = (0, serialized_file_js_1.readObject)(file, info);
                let rd = obj(sprite.m_RD);
                const atlasPtr = obj(sprite.m_SpriteAtlas);
                if (atlasPtr && pathIdOf(atlasPtr) !== 0n && fileIdOf(atlasPtr) === 0) {
                    const atlasInfo = file.objects.find((o) => o.pathId === pathIdOf(atlasPtr) && o.classId === serialized_file_js_1.CLASS_SPRITE_ATLAS);
                    if (atlasInfo) {
                        const atlas = (0, serialized_file_js_1.readObject)(file, atlasInfo);
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
                if (!rd)
                    throw new Error('sprite has no render data');
                let tex = loadTexture(loaded, obj(rd.texture));
                const alphaPtr = obj(rd.alphaTexture);
                if (alphaPtr && pathIdOf(alphaPtr) !== 0n) {
                    const alpha = loadTexture(loaded, alphaPtr);
                    tex = { format: tex.format, image: mergeAlpha(tex.image, alpha.image) };
                }
                images.push({ name, kind: 'sprite', format: tex.format, image: cutSprite(tex.image, obj(rd.textureRect), num(rd.settingsRaw)) });
            }
            catch (err) {
                errors.push(`sprite ${name}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    for (const loaded of files) {
        const { file } = loaded;
        for (const info of file.objects) {
            if (info.classId !== serialized_file_js_1.CLASS_TEXTURE2D)
                continue;
            const name = (0, serialized_file_js_1.peekName)(file, info);
            if (name === null || !wanted(name))
                continue;
            try {
                const tex = loadTexture(loaded, { m_FileID: 0, m_PathID: info.pathId });
                images.push({ name, kind: 'texture', format: tex.format, image: (0, texture_js_1.flipRows)(tex.image) });
            }
            catch (err) {
                errors.push(`texture ${name}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    return { images, errors };
}
const CLASS_TEXT_ASSET = 49;
/**
 * The TextAssets of a bundle whose name the caller wants, as text — e.g. a
 * Spine animation's "<name>.atlas" (see spine.ts). Unreadable ones are skipped.
 */
function extractTexts(bundleBuf, wanted) {
    const bundle = (0, unityfs_js_1.readUnityBundle)(bundleBuf);
    const out = new Map();
    for (const n of bundle.nodes) {
        if (/\.(resS|resource)$/i.test(n.path))
            continue;
        let file;
        try {
            file = (0, serialized_file_js_1.readSerializedFile)((0, unityfs_js_1.nodeData)(bundle, n));
        }
        catch {
            continue;
        }
        for (const info of file.objects) {
            if (info.classId !== CLASS_TEXT_ASSET)
                continue;
            const name = (0, serialized_file_js_1.peekName)(file, info);
            if (name === null || !wanted(name))
                continue;
            try {
                const script = (0, serialized_file_js_1.readObject)(file, info).m_Script;
                if (typeof script === 'string')
                    out.set(name, script);
                else if (Buffer.isBuffer(script))
                    out.set(name, script.toString('utf8'));
            }
            catch {
                // Not a text we can read: no still from it.
            }
        }
    }
    return out;
}
/** Decode a parsed Texture2D (inline image data or a .resS stream). Raw row order. */
function decodeTextureObject(tex, nodesByBase) {
    const width = num(tex.m_Width);
    const height = num(tex.m_Height);
    const format = num(tex.m_TextureFormat);
    const data = tex['image data'];
    let bytes = Buffer.isBuffer(data) ? data : Buffer.alloc(0);
    if (!bytes.length) {
        const stream = obj(tex.m_StreamData);
        const size = num(stream?.size);
        const path = typeof stream?.path === 'string' ? stream.path : '';
        if (size > 0 && path) {
            const src = nodesByBase.get(baseName(path));
            if (!src)
                throw new Error(`stream file ${path} not in bundle`);
            const offset = num(stream?.offset);
            if (offset + size > src.length)
                throw new Error('stream data runs past its file');
            bytes = src.subarray(offset, offset + size);
        }
    }
    if (!width || !height)
        throw new Error('texture has no size');
    if (!bytes.length)
        throw new Error('texture has no image data');
    const need = (0, texture_js_1.textureByteSize)(format, width, height);
    if (need !== null && bytes.length < need)
        throw new Error(`texture data is ${bytes.length} bytes, format ${format} needs ${need}`);
    return { image: (0, texture_js_1.decodeTexture)(format, bytes, width, height), format };
}
function mergeAlpha(color, alpha) {
    if (color.width !== alpha.width || color.height !== alpha.height)
        return color;
    const out = Buffer.from(color.data);
    // The alpha texture carries alpha in its first (red) channel.
    for (let i = 0; i < color.width * color.height; i++)
        out[i * 4 + 3] = alpha.data[i * 4];
    return { width: color.width, height: color.height, data: out };
}
/** Cut a sprite from raw (bottom-up) texture pixels and return it top-down. */
function cutSprite(texture, rect, settingsRaw) {
    if (!rect)
        throw new Error('sprite has no textureRect');
    const x0 = Math.round(num(rect.x));
    const y0 = Math.round(num(rect.y));
    const x1 = Math.round(num(rect.x) + num(rect.width));
    const y1 = Math.round(num(rect.y) + num(rect.height));
    if (x1 <= x0 || y1 <= y0)
        throw new Error('sprite rect is empty');
    let img = (0, texture_js_1.cropImage)(texture, x0, y0, x1 - x0, y1 - y0);
    const packed = (settingsRaw & 1) === 1;
    if (packed) {
        switch ((settingsRaw >> 2) & 0xf) {
            case SPRITE_ROTATE_FLIP_H:
                img = (0, texture_js_1.flipHorizontal)(img);
                break;
            case SPRITE_ROTATE_FLIP_V:
                img = (0, texture_js_1.flipRows)(img);
                break;
            case SPRITE_ROTATE_180:
                img = (0, texture_js_1.rotate180)(img);
                break;
            case SPRITE_ROTATE_90:
                img = (0, texture_js_1.rotateClockwise)(img);
                break;
            default: break;
        }
    }
    return (0, texture_js_1.flipRows)(img);
}
/**
 * One image per name: a Sprite wins over a Texture2D of the same name (for a
 * single-sprite texture they are the same pixels; for a sheet the sprite is the
 * part that is meant to be shown). Names compare case-insensitively.
 */
function pickImages(images) {
    const out = new Map();
    for (const img of images) {
        const key = img.name.toLowerCase();
        const prev = out.get(key);
        if (!prev || (prev.kind === 'texture' && img.kind === 'sprite'))
            out.set(key, img);
    }
    return [...out.values()];
}
//# sourceMappingURL=extract.js.map