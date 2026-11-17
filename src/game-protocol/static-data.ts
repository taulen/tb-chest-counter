/**
 * Names for the game's numeric ids, built from Total Battle's own public static
 * data — the same files the game client downloads.
 *
 *   versions.totalbattle.com/config/?branch=current&simple=true
 *     .client_static_version.production   → strings / vectors / no_duplicates file names
 *     .client_translations_catalog_version → translations index → csv_en_US zip
 *
 * Table cells reference the string pool by index (no offset); localised text
 * fields reference a VECTOR of string refs, and templated text ("Level %value%
 * Crypt") is [templateRef, placeholderRef, valueRef, ...]. Each table has its
 * own id space. The tables we use:
 *
 *   T7  map objects   f3 name vector
 *   T8  gift types    f3 chest name vector, f14 source template vector
 *   T13 hero avatars  f1 name vector, f3 icon string
 *   T21 techs         f1 name vector, f5 levels (research + hero talents)
 *
 * The raw files are ~67 MB, so a rebuild happens only when the game ships new
 * static data: the result is a small names.json cached under
 * data/game-static/<version>/; the raw files are only ever held in memory. Decoding skips
 * every table we don't need without building it, which keeps a rebuild inside
 * the container's heap. Full background: docs/game-protocol.md.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { WireReader, type Wire } from './codec.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('game-static');

const VERSIONS_URL = 'https://versions.totalbattle.com/config/?branch=current&simple=true';
const STATIC_BASE = 'https://assets-client-static.totalbattle.dev/';
const TRANSLATIONS_BASE = 'https://assets-translations.totalbattle.dev//';
const STATIC_BRANCH = 'production';
const ENGLISH = 'csv_en_US';

export const TABLE_MAP_OBJECTS = 7;
export const TABLE_GIFT_TYPES = 8;
export const TABLE_HEROES = 13;
export const TABLE_TECHS = 21;
const NEEDED_TABLES = [TABLE_MAP_OBJECTS, TABLE_GIFT_TYPES, TABLE_HEROES, TABLE_TECHS];

export interface GameNames {
  /** `${composite}:${translations}` — changes whenever either source does. */
  version: string;
  builtAt: string;
  gifts: Record<string, { chest: string; source: string }>;
  techs: Record<string, { name: string; maxLevel: number }>;
  objects: Record<string, string>;
  heroes: Record<string, { name: string; icon: string }>;
}

export interface StaticVersion {
  composite: string;
  files: { strings: string; vectors: string; noDuplicates: string };
  translationsCatalog: string;
}

const FETCH_TIMEOUT_MS = 120_000;

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Which static data and translations the live game is on right now. */
export async function fetchStaticVersion(): Promise<StaticVersion> {
  const body = JSON.parse((await fetchBuffer(VERSIONS_URL)).toString('utf8')) as {
    result?: {
      client_static_version?: Record<string, Record<string, string>>;
      client_translations_catalog_version?: string;
    };
  };
  const branch = body.result?.client_static_version?.[STATIC_BRANCH];
  const catalog = body.result?.client_translations_catalog_version;
  if (!branch?.composite_hash || !branch.strings || !branch.vectors || !branch.no_duplicates || !catalog) {
    throw new Error('versions config is missing the static data or translations entries');
  }
  return {
    composite: branch.composite_hash,
    files: { strings: branch.strings, vectors: branch.vectors, noDuplicates: branch.no_duplicates },
    translationsCatalog: catalog,
  };
}

// ---------------------------------------------------------------------------
// Translations: a zip holding one CSV of "key","text" rows
// ---------------------------------------------------------------------------

/** Extract the first file of a zip (stored or deflated), via the central directory. */
export function unzipFirst(zip: Buffer): Buffer {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('zip central directory not found');
  const method = zip.readUInt16LE(cdOffset + 10);
  const compressed = zip.readUInt32LE(cdOffset + 20);
  const localOffset = zip.readUInt32LE(cdOffset + 42);
  const nameLen = zip.readUInt16LE(localOffset + 26);
  const extraLen = zip.readUInt16LE(localOffset + 28);
  const data = zip.subarray(localOffset + 30 + nameLen + extraLen, localOffset + 30 + nameLen + extraLen + compressed);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported zip compression method ${method}`);
}

/** Parse "key","text" CSV (quoted fields, "" escapes, newlines allowed in quotes). */
export function parseTranslationsCsv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  const n = text.length;
  const field = (): string => {
    if (text[i] !== '"') {
      const start = i;
      while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') i++;
      return text.slice(start, i);
    }
    i++;
    let s = '';
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        if (text[i + 1] === '"') { s += '"'; i += 2; continue; }
        i++;
        break;
      }
      s += c;
      i++;
    }
    return s;
  };
  while (i < n) {
    const key = field();
    if (text[i] !== ',') {
      while (i < n && text[i] !== '\n') i++;
      i++;
      continue;
    }
    i++;
    const value = field();
    while (i < n && text[i] !== '\n') i++;
    i++;
    if (key) out.set(key, value);
  }
  return out;
}

async function fetchEnglish(catalog: string): Promise<Map<string, string>> {
  const index = JSON.parse((await fetchBuffer(TRANSLATIONS_BASE + catalog)).toString('utf8')) as {
    files?: Array<{ name: string; fileName: string }>;
  };
  const entry = index.files?.find((f) => f.name === ENGLISH);
  if (!entry) throw new Error(`translations index has no ${ENGLISH}`);
  const csv = unzipFirst(await fetchBuffer(TRANSLATIONS_BASE + entry.fileName)).toString('utf8');
  return parseTranslationsCsv(csv);
}

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

/** The pool files are a one-element array wrapping the real array. */
function readWrappedArray(buf: Buffer): Wire[] {
  const r = new WireReader(buf);
  const outer = r.arrayLength();
  if (outer !== 1) throw new Error(`expected a wrapped array, got outer length ${outer}`);
  const n = r.arrayLength();
  const out: Wire[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = r.value();
  return out;
}

/** Decode only the requested tables of no_duplicates; the rest are skipped unbuilt. */
export function readTables(buf: Buffer, wanted: number[]): Map<number, Record<string, Wire>> {
  const r = new WireReader(buf);
  const count = r.arrayLength();
  const want = new Set(wanted);
  const out = new Map<number, Record<string, Wire>>();
  for (let i = 0; i < count; i++) {
    if (!want.has(i)) {
      r.skip();
      continue;
    }
    const t = r.value();
    if (t && typeof t === 'object' && !Array.isArray(t) && !('$pairs' in t) && !('$bin' in t)) {
      out.set(i, t as Record<string, Wire>);
    }
  }
  return out;
}

/** Turn pools + tables + English into the compact names we keep. Pure; unit-tested. */
export function buildNames(
  version: string,
  strings: Wire[],
  vectors: Wire[],
  tables: Map<number, Record<string, Wire>>,
  en: Map<string, string>,
): GameNames {
  const str = (ref: Wire): string | undefined => (typeof ref === 'number' && typeof strings[ref] === 'string' ? (strings[ref] as string) : undefined);
  const text = (ref: Wire): string | undefined => {
    const k = str(ref);
    return k === undefined ? undefined : (en.get(k) ?? k);
  };
  const vec = (vref: Wire): Wire[] | undefined => {
    const v = typeof vref === 'number' ? vectors[vref] : undefined;
    return Array.isArray(v) ? v : undefined;
  };
  // Localised text is a vector [templateRef, placeholderRef, valueRef, ...]: a
  // plain name is a one-element vector, a templated one ("Level %value% Crypt",
  // "Sacred Potion production %level%") substitutes each placeholder with its
  // raw value. Anything that resolves to a JSON fragment isn't a name.
  const vecText = (vref: Wire): string | undefined => {
    const v = vec(vref);
    if (!v?.length) return undefined;
    let out = text(v[0]) ?? '';
    for (let i = 1; i + 1 < v.length; i += 2) out = out.replace(str(v[i]) ?? '\u0000', str(v[i + 1]) ?? '');
    out = out.replace(/\s+/g, ' ').trim();
    return out && !out.startsWith('{') && !out.startsWith('[') ? out : undefined;
  };
  const vecTemplate = vecText;
  const rows = (table: number): Array<[string, Wire[]]> =>
    Object.entries(tables.get(table) ?? {}).filter((e): e is [string, Wire[]] => Array.isArray(e[1]));

  const gifts: GameNames['gifts'] = {};
  for (const [id, row] of rows(TABLE_GIFT_TYPES)) {
    const chest = vecText(row[3]);
    if (chest) gifts[id] = { chest, source: vecTemplate(row[14]) ?? '' };
  }
  const techs: GameNames['techs'] = {};
  for (const [id, row] of rows(TABLE_TECHS)) {
    const name = vecText(row[1]);
    const levels = row[5];
    if (name) techs[id] = { name, maxLevel: levels && typeof levels === 'object' && !Array.isArray(levels) ? Object.keys(levels).length : 0 };
  }
  const objects: GameNames['objects'] = {};
  for (const [id, row] of rows(TABLE_MAP_OBJECTS)) {
    const name = vecText(row[3]);
    if (name) objects[id] = name;
  }
  const heroes: GameNames['heroes'] = {};
  for (const [id, row] of rows(TABLE_HEROES)) {
    const name = vecText(row[1]);
    if (name) heroes[id] = { name, icon: str(row[3]) ?? '' };
  }
  return { version, builtAt: new Date().toISOString(), gifts, techs, objects, heroes };
}

// ---------------------------------------------------------------------------
// Cache on the data volume
// ---------------------------------------------------------------------------

function staticDir(): string {
  return path.resolve('data', 'game-static');
}

function versionKey(v: StaticVersion): string {
  return `${v.composite.slice(0, 16)}-${v.translationsCatalog.replace(/\.json$/, '')}`;
}

let memo: GameNames | null = null;

/**
 * Names for the live game version: from memory, else from the on-disk cache,
 * else rebuilt from the CDN. Falls back to the newest cached names when the
 * versions endpoint can't be reached, because stale names beat no names.
 */
export async function loadGameNames(): Promise<GameNames> {
  let version: StaticVersion;
  try {
    version = await fetchStaticVersion();
  } catch (err) {
    const cached = memo ?? newestCachedNames();
    if (cached) {
      log.warn({ noAlert: true }, `Game versions endpoint unreachable (${String(err)}); using cached names ${cached.version}.`);
      return cached;
    }
    throw err;
  }
  const key = versionKey(version);
  if (memo?.version === key) return memo;
  const file = path.join(staticDir(), key, 'names.json');
  if (fs.existsSync(file)) {
    memo = JSON.parse(fs.readFileSync(file, 'utf8')) as GameNames;
    return memo;
  }
  log.info(`Building game names for static data ${key} (downloads ~67 MB once per game patch)`);
  const started = Date.now();
  const [stringsBuf, vectorsBuf, tablesBuf, en] = await Promise.all([
    fetchBuffer(STATIC_BASE + version.files.strings),
    fetchBuffer(STATIC_BASE + version.files.vectors),
    fetchBuffer(STATIC_BASE + version.files.noDuplicates),
    fetchEnglish(version.translationsCatalog),
  ]);
  const names = buildNames(key, readWrappedArray(stringsBuf), readWrappedArray(vectorsBuf), readTables(tablesBuf, NEEDED_TABLES), en);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(names));
  log.info(
    `Game names ${key} built in ${Math.round((Date.now() - started) / 1000)}s: ` +
    `${Object.keys(names.gifts).length} gift types, ${Object.keys(names.techs).length} techs, ` +
    `${Object.keys(names.objects).length} map objects, ${Object.keys(names.heroes).length} heroes`,
  );
  memo = names;
  return names;
}

function newestCachedNames(): GameNames | null {
  const dir = staticDir();
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .map((d) => path.join(dir, d, 'names.json'))
    .filter((f) => fs.existsSync(f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ? (JSON.parse(fs.readFileSync(files[0], 'utf8')) as GameNames) : null;
}

/** Test seam. */
export function resetGameNamesMemo(): void {
  memo = null;
}
