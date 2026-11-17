/**
 * Unity SerializedFile reader (the "CAB-…" file inside a bundle), driven by
 * the type trees the file embeds — no per-version class layouts needed.
 *
 * Header (big-endian): u32 metadataSize, u32 fileSize, u32 version, u32 dataOffset,
 * then from version 9 an endianness byte + 3 reserved, and from 22 64-bit
 * sizes. The metadata that follows (in the file's endianness) holds the
 * engine version, platform, the types with their type trees, the object table
 * (pathID → byte range + type), script types, externals and ref types.
 *
 * Type tree nodes are flat with a depth; strings are offsets into the node
 * blob's own buffer, or — high bit set — into Unity's built-in common-string
 * table below.
 */
import { BinaryReader } from './binary-reader.js';

/**
 * Unity's common string table, in order. A name's offset is the sum of the
 * lengths (+1 for each NUL) of the names before it; only the order matters.
 */
const COMMON_STRINGS = [
  'AABB', 'AnimationClip', 'AnimationCurve', 'AnimationState', 'Array', 'Base', 'BitField', 'bitset', 'bool',
  'char', 'ColorRGBA', 'Component', 'data', 'deque', 'double', 'dynamic_array', 'FastPropertyName', 'first',
  'float', 'Font', 'GameObject', 'Generic Mono', 'GradientNEW', 'GUID', 'GUIStyle', 'int', 'list', 'long long',
  'map', 'Matrix4x4f', 'MdFour', 'MonoBehaviour', 'MonoScript', 'm_ByteSize', 'm_Curve',
  'm_EditorClassIdentifier', 'm_EditorHideFlags', 'm_Enabled', 'm_ExtensionPtr', 'm_GameObject', 'm_Index',
  'm_IsArray', 'm_IsStatic', 'm_MetaFlag', 'm_Name', 'm_ObjectHideFlags', 'm_PrefabInternal',
  'm_PrefabParentObject', 'm_Script', 'm_StaticEditorFlags', 'm_Type', 'm_Version', 'Object', 'pair',
  'PPtr<Component>', 'PPtr<GameObject>', 'PPtr<Material>', 'PPtr<MonoBehaviour>', 'PPtr<MonoScript>',
  'PPtr<Object>', 'PPtr<Prefab>', 'PPtr<Sprite>', 'PPtr<TextAsset>', 'PPtr<Texture>', 'PPtr<Texture2D>',
  'PPtr<Transform>', 'Prefab', 'Quaternionf', 'Rectf', 'RectInt', 'RectOffset', 'second', 'set', 'short', 'size',
  'SInt16', 'SInt32', 'SInt64', 'SInt8', 'staticvector', 'string', 'TextAsset', 'TextMesh', 'Texture',
  'Texture2D', 'Transform', 'TypelessData', 'UInt16', 'UInt32', 'UInt64', 'UInt8', 'unsigned int',
  'unsigned long long', 'unsigned short', 'vector', 'Vector2f', 'Vector3f', 'Vector4f',
  'm_ScriptingClassIdentifier', 'Gradient', 'Type*', 'int2_storage', 'int3_storage', 'BoundsInt',
  'm_CorrespondingSourceObject', 'm_PrefabInstance', 'm_PrefabAsset', 'FileSize', 'Hash128',
  'RenderingLayerMask', 'fixed_array', 'EntityId', 'LoadableObjectId', 'LoadableSceneId',
];

const COMMON_BY_OFFSET: Map<number, string> = (() => {
  const m = new Map<number, string>();
  let at = 0;
  for (const s of COMMON_STRINGS) {
    m.set(at, s);
    at += Buffer.byteLength(s, 'utf8') + 1;
  }
  return m;
})();

/** Exposed for tests: the common-string offset of a name, or undefined. */
export function commonStringOffset(name: string): number | undefined {
  for (const [off, s] of COMMON_BY_OFFSET) if (s === name) return off;
  return undefined;
}

export const CLASS_TEXTURE2D = 28;
export const CLASS_ASSET_BUNDLE = 142;
export const CLASS_SPRITE = 213;
export const CLASS_SPRITE_ATLAS = 687078895;

const ALIGN_FLAG = 0x4000;

export interface TypeNode {
  type: string;
  name: string;
  byteSize: number;
  level: number;
  typeFlags: number;
  metaFlag: number;
  children: TypeNode[];
}

export interface SerializedType {
  classId: number;
  tree: TypeNode | null;
}

export interface ObjectInfo {
  pathId: bigint;
  byteStart: number;
  byteSize: number;
  classId: number;
  type: SerializedType;
}

export interface SerializedFile {
  version: number;
  engineVersion: string;
  littleEndian: boolean;
  types: SerializedType[];
  objects: ObjectInfo[];
  /** External file paths; a PPtr's m_FileID n > 0 refers to externals[n - 1]. */
  externals: string[];
  data: Buffer;
}

function readTypeTreeBlob(r: BinaryReader, version: number): TypeNode {
  const nodeCount = r.i32();
  const stringSize = r.i32();
  const nodeSize = version >= 19 ? 32 : 24;
  const nodeBytes = r.bytes(nodeCount * nodeSize);
  const strings = r.bytes(stringSize);
  const nr = new BinaryReader(nodeBytes, r.littleEndian);
  const str = (v: number): string => {
    if ((v & 0x80000000) === 0) {
      const end = strings.indexOf(0, v);
      return strings.toString('utf8', v, end < 0 ? strings.length : end);
    }
    const off = v & 0x7fffffff;
    return COMMON_BY_OFFSET.get(off) ?? String(off);
  };
  const flat: TypeNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    nr.u16(); // node version
    const level = nr.u8();
    const typeFlags = nr.u8();
    const typeOff = nr.u32();
    const nameOff = nr.u32();
    const byteSize = nr.i32();
    nr.i32(); // index
    const metaFlag = nr.u32();
    if (version >= 19) nr.u64(); // ref type hash
    flat.push({ type: str(typeOff), name: str(nameOff), byteSize, level, typeFlags, metaFlag, children: [] });
  }
  if (!flat.length) throw new Error('empty type tree');
  const stack: TypeNode[] = [flat[0]];
  for (let i = 1; i < flat.length; i++) {
    const n = flat[i];
    while (stack.length > n.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (!parent) throw new Error('malformed type tree levels');
    parent.children.push(n);
    stack.push(n);
  }
  return flat[0];
}

function readSerializedType(r: BinaryReader, version: number, typeTrees: boolean, isRef: boolean): SerializedType {
  const classId = r.i32();
  if (version >= 16) r.bool(); // stripped
  let scriptTypeIndex = -1;
  if (version >= 17) scriptTypeIndex = r.i16();
  if (version >= 13) {
    if ((isRef && scriptTypeIndex >= 0) || (version < 16 && classId < 0) || (version >= 16 && classId === 114)) {
      r.bytes(16); // script id
    }
    r.bytes(16); // old type hash
  }
  let tree: TypeNode | null = null;
  if (typeTrees) {
    let serializedSize = -1;
    if (version >= 23) {
      r.bytes(16); // type tree content hash
      serializedSize = r.i32();
    }
    if (version >= 12 || version === 10) {
      if (version < 23 || serializedSize) tree = readTypeTreeBlob(r, version);
    } else {
      throw new Error(`serialized file version ${version} type trees are not supported`);
    }
    if (version >= 21) {
      if (isRef) {
        r.cstring();
        r.cstring();
        r.cstring();
      } else {
        const n = r.i32();
        r.bytes(n * 4); // type dependencies
      }
    }
  }
  return { classId, tree };
}

export function readSerializedFile(buf: Buffer): SerializedFile {
  const r = new BinaryReader(buf, false);
  let metadataSize = r.u32();
  r.u32(); // file size
  const version = r.u32();
  let dataOffset = r.u32();
  if (version < 9) throw new Error(`serialized file version ${version} is too old`);
  const bigEndian = r.bool();
  r.bytes(3);
  if (version >= 22) {
    metadataSize = r.u32();
    r.i64(); // file size
    dataOffset = r.i64Number();
    r.i64();
  }
  void metadataSize;
  r.littleEndian = !bigEndian;
  const engineVersion = version >= 7 ? r.cstring() : '';
  if (version >= 8) r.i32(); // target platform
  const typeTrees = version >= 13 ? r.bool() : true;
  const typeCount = r.i32();
  const types: SerializedType[] = [];
  for (let i = 0; i < typeCount; i++) types.push(readSerializedType(r, version, typeTrees, false));
  const bigIds = version >= 7 && version < 14 ? r.i32() : 0;
  const objectCount = r.i32();
  const objects: ObjectInfo[] = [];
  for (let i = 0; i < objectCount; i++) {
    let pathId: bigint;
    if (bigIds) pathId = r.i64();
    else if (version < 14) pathId = BigInt(r.i32());
    else {
      r.align(4);
      pathId = r.i64();
    }
    const byteStart = (version >= 22 ? r.i64Number() : r.u32()) + dataOffset;
    const byteSize = r.u32();
    const typeId = r.i32();
    let type: SerializedType | undefined;
    let classId: number;
    if (version < 16) {
      classId = r.u16();
      type = types.find((t) => t.classId === typeId);
    } else {
      type = types[typeId];
      classId = type?.classId ?? -1;
    }
    if (version < 11) r.u16();
    if (version >= 11 && version < 17) r.i16();
    if (version === 15 || version === 16) r.u8();
    if (!type) throw new Error(`object ${pathId} has unknown type ${typeId}`);
    objects.push({ pathId, byteStart, byteSize, classId, type });
  }
  if (version >= 11) {
    const scriptCount = r.i32();
    for (let i = 0; i < scriptCount; i++) {
      r.i32();
      if (version < 14) r.i32();
      else {
        r.align(4);
        r.i64();
      }
    }
  }
  const externalCount = r.i32();
  const externals: string[] = [];
  for (let i = 0; i < externalCount; i++) {
    if (version >= 6) r.cstring();
    if (version >= 5) {
      r.bytes(16);
      r.i32();
    }
    externals.push(r.cstring());
  }
  return { version, engineVersion, littleEndian: !bigEndian, types, objects, externals, data: buf };
}

// ---------------------------------------------------------------------------
// Object values from type trees
// ---------------------------------------------------------------------------

export type UValue = number | bigint | boolean | string | Buffer | UValue[] | { [k: string]: UValue };
export type UObject = { [k: string]: UValue };

function readValue(node: TypeNode, r: BinaryReader): UValue {
  let align = (node.metaFlag & ALIGN_FLAG) !== 0;
  let v: UValue;
  switch (node.type) {
    case 'SInt8': v = r.i8(); break;
    case 'UInt8': case 'char': v = r.u8(); break;
    case 'bool': v = r.bool(); break;
    case 'SInt16': case 'short': v = r.i16(); break;
    case 'UInt16': case 'unsigned short': v = r.u16(); break;
    case 'SInt32': case 'int': v = r.i32(); break;
    case 'UInt32': case 'unsigned int': case 'Type*': v = r.u32(); break;
    case 'SInt64': case 'long long': v = r.i64(); break;
    case 'UInt64': case 'unsigned long long': case 'FileSize': v = r.u64(); break;
    case 'float': v = r.f32(); break;
    case 'double': v = r.f64(); break;
    case 'string': {
      const len = r.i32();
      v = r.bytes(len).toString('utf8');
      if (node.children[0] && node.children[0].metaFlag & ALIGN_FLAG) align = true;
      break;
    }
    case 'TypelessData': {
      const len = r.i32();
      v = r.bytes(len);
      break;
    }
    default: {
      const first = node.children[0];
      if (first && first.type === 'Array') {
        if (first.metaFlag & ALIGN_FLAG) align = true;
        const n = r.i32();
        const elem = first.children[1];
        if (!elem) throw new Error(`array ${node.name} has no element type`);
        if (n < 0) throw new Error(`negative array length for ${node.name}`);
        if ((elem.type === 'UInt8' || elem.type === 'char') && !(elem.metaFlag & ALIGN_FLAG)) {
          v = r.bytes(n);
        } else {
          const arr: UValue[] = new Array(n);
          for (let i = 0; i < n; i++) arr[i] = readValue(elem, r);
          v = arr;
        }
      } else {
        const obj: { [k: string]: UValue } = {};
        for (const c of node.children) obj[c.name] = readValue(c, r);
        v = obj;
      }
    }
  }
  if (align) r.align(4);
  return v;
}

export function readObject(file: SerializedFile, obj: ObjectInfo): UObject {
  const tree = obj.type.tree;
  if (!tree) throw new Error(`object ${obj.pathId} (class ${obj.classId}) has no type tree`);
  const r = new BinaryReader(file.data.subarray(obj.byteStart, obj.byteStart + obj.byteSize), file.littleEndian);
  const v = readValue(tree, r);
  if (!v || typeof v !== 'object' || Array.isArray(v) || Buffer.isBuffer(v)) throw new Error('object root is not a class');
  return v as UObject;
}

/** The object's m_Name without parsing the rest (it is the first field of every named asset). */
export function peekName(file: SerializedFile, obj: ObjectInfo): string | null {
  const first = obj.type.tree?.children[0];
  if (!first || first.name !== 'm_Name' || first.type !== 'string') return null;
  const r = new BinaryReader(file.data, file.littleEndian, obj.byteStart);
  const len = r.i32();
  if (len < 0 || len > obj.byteSize) return null;
  return r.bytes(len).toString('utf8');
}
