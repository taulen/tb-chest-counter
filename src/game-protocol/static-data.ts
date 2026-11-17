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
/** Captains (Hercules, Skadi, Aurora…): f1 kind, f2 rarity, f5 name, f7 JSON config with the sprite names. */
export const TABLE_CAPTAINS = 75;
/** Clan medals (ids 1–40): f1 icon, f2 inactive icon, f4 unlock text vector, f5 name vector, f6 tier 1 bronze … 4 platinum. */
export const TABLE_CLAN_MEDALS = 62;
const NEEDED_TABLES = [TABLE_MAP_OBJECTS, TABLE_GIFT_TYPES, TABLE_HEROES, TABLE_TECHS, TABLE_CAPTAINS, TABLE_CLAN_MEDALS];

export interface GameNames {
  /** `${composite}:${translations}` — changes whenever either source does. */
  version: string;
  builtAt: string;
  gifts: Record<string, { chest: string; source: string }>;
  techs: Record<string, { name: string; maxLevel: number }>;
  objects: Record<string, string>;
  heroes: Record<string, { name: string; icon: string }>;
  /** Captains by T75 id: name, rarity (T75 f2), and the sprite names from its config. */
  captains: Record<string, GameCaptain>;
  /** Clan medals by T62 id (format ≥ 3). */
  medals?: Record<string, GameMedal>;
  /** NAMES_FORMAT the file was built with; an older one is rebuilt once. */
  format?: number;
}

export interface GameMedal {
  name: string;
  /** What earned it ("Clan members earned at least 1B points over …"). */
  description: string;
  /** 1 bronze, 2 silver, 3 gold, 4 platinum. */
  tier: number;
  /** The game's label for the tier. */
  tierName: string;
  /** Sprite name (achievement_capitals_competition_gold). */
  icon: string;
}

export interface GameCaptain {
  name: string;
  /** T75 f2: 1 rare, 2 epic, 3 legendary, 4 mythic. */
  rarity: number;
  /** The game's label for the rarity ("Epic Captain"). */
  rarityName: string;
  icon: string;
  art: string;
  /**
   * Bonuses per star level, as the game's Stats screen lists them under "Star
   * level N": [text, value] pairs ("Crypt exploration efficiency", "+50,0%").
   * From T75 f12 {star: [star, …, [7] props JSON, …]}.
   */
  stars: Record<string, Array<[string, string]>>;
}

/**
 * Bump when names.json gains a field the app reads (2: captain star bonuses
 * and rarity labels; 3: clan medals — Nov 2026); a cached file with an older
 * format is rebuilt.
 */
export const NAMES_FORMAT = 3;

/** T62 f6 medal tier → the game's own tier label key (the clan_medals config's goblet tierName). */
const MEDAL_TIER_KEYS: Record<number, string> = {
  1: 'client_config.value.goblet_bronze',
  2: 'client_config.value.goblet_silver',
  3: 'client_config.value.goblet_gold',
  4: 'client_config.value.goblet_platinum',
};

/** T75 f2 rarity → the game's own label key. */
const CAPTAIN_RARITY_KEYS: Record<number, string> = {
  1: 'client.captain.info.rare_captain',
  2: 'client.captain.info.epic_captain',
  3: 'client.captain.info.legendary_captain',
  4: 'client.captain.info.mythical_captain',
};

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
  const captains: GameNames['captains'] = {};
  for (const [id, row] of rows(TABLE_CAPTAINS)) {
    let cfg: { smallIcon?: string; unitAltarArt?: string; animationLinkage?: string } = {};
    try { cfg = JSON.parse(str(row[7]) ?? '{}'); } catch { /* not a config */ }
    // The battler's own name (battler_unit.name.<key of battler_<key>_unit>)
    // first: f5 is wrong for some rows — id 28 is Helen (her sprites, her
    // battler) but its f5 vector says "Hercules" (Nov 2026).
    const battler = /^battler_(.+)_unit$/.exec(cfg.animationLinkage ?? '')?.[1];
    const name = (battler ? en.get(`battler_unit.name.${battler}`) : undefined) ?? vecText(row[5]);
    if (!name) continue;
    const rarity = typeof row[2] === 'number' ? row[2] : 0;
    const stars: GameCaptain['stars'] = {};
    const starRows = row[12];
    if (starRows && typeof starRows === 'object' && !Array.isArray(starRows)) {
      for (const [star, sr] of Object.entries(starRows as Record<string, Wire>)) {
        if (!Array.isArray(sr)) continue;
        let props: Array<{ propText?: string; propValue?: string }> = [];
        try { props = (JSON.parse(str(sr[7]) ?? '{}') as { props?: typeof props }).props ?? []; } catch { /* no props */ }
        const lines = props
          .filter((p) => p.propText)
          .map((p): [string, string] => [en.get(p.propText as string) ?? (p.propText as string), String(p.propValue ?? '')]);
        if (lines.length) stars[star] = lines;
      }
    }
    captains[id] = {
      name,
      rarity,
      rarityName: en.get(CAPTAIN_RARITY_KEYS[rarity] ?? '') ?? '',
      icon: cfg.smallIcon ?? '',
      art: cfg.unitAltarArt ?? '',
      stars,
    };
  }
  const medals: NonNullable<GameNames['medals']> = {};
  for (const [id, row] of rows(TABLE_CLAN_MEDALS)) {
    const name = vecText(row[5]);
    if (!name) continue;
    const tier = typeof row[6] === 'number' ? row[6] : 0;
    medals[id] = {
      name,
      description: vecText(row[4]) ?? '',
      tier,
      tierName: en.get(MEDAL_TIER_KEYS[tier] ?? '') ?? '',
      icon: str(row[1]) ?? '',
    };
  }
  return { version, builtAt: new Date().toISOString(), format: NAMES_FORMAT, gifts, techs, objects, heroes, captains, medals };
}

// ---------------------------------------------------------------------------
// Cache on the data volume
// ---------------------------------------------------------------------------

/** Cache of the game's static data. GAME_STATIC_DIR overrides it for local runs and tools, never needed in prod. */
function staticDir(): string {
  return process.env.GAME_STATIC_DIR ? path.resolve(process.env.GAME_STATIC_DIR) : path.resolve('data', 'game-static');
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
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as GameNames;
    // A names.json from an older format (before captains' star bonuses) is rebuilt once.
    if ((cached.format ?? 1) >= NAMES_FORMAT) {
      memo = cached;
      return memo;
    }
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
