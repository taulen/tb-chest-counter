/**
 * The slice of the game's static data the art pipeline needs: which icon each
 * hero avatar, unit, tech and item uses. A separate loader from
 * game-protocol/static-data.ts (which keeps its own small names.json) so that
 * module's exports and cache stay as they are; it reuses its parsers.
 *
 *   T8  items        f3 name vector, f6 visual JSON {"icon": "<72px icon>"}
 *   T9  units        f1 name vector, f2 tier (0–10: Archer I = 1, Corax II = 9;
 *                    picks the icon's frame colour, unit-frames.ts), f4 icon,
 *                    f10 strength, f12 health
 *   T13 hero avatars f1 name vector, f3 icon — a player's heroAvatar IS the T13 id
 *   T21 techs        f1 name vector, f3 icon (research and hero talents)
 *   T52 customizations f1 kind (1 portrait frame, 2 city look, 3 …), f2 name
 *                    vector, f4 visual JSON {"visual": "<frame sprite>", …} —
 *                    a player's 402 field 6 IS the id of their frame, field 5
 *                    of their city look (whose visual is JSON again, with an
 *                    icon per city level: {"icon": {"1": …, "5": …}})
 *   T110 artifacts   f7 JSON config {"icon": …}, f8 name vector
 *   T11 equipment    f2 icon address, f3 name vector (gems/enchantments: T8 f1 8/9)
 *   T29 titles       f1 name vector, f3 visual JSON {"smallIcon": <round 28 px,
 *                    an atlas sprite>, "mobileIcon": <72 px>, …}
 *
 * The raw files are ~67 MB and only held in memory; the result is cached as
 * data/game-art/static-<version>.json, rebuilt once per game patch.
 */
import fs from 'fs';
import path from 'path';
import { WireReader, type Wire } from '../game-protocol/codec.js';
import {
  fetchStaticVersion,
  readTables,
  parseTranslationsCsv,
  unzipFirst,
  type StaticVersion,
} from '../game-protocol/static-data.js';

const STATIC_BASE = 'https://assets-client-static.totalbattle.dev/';
const TRANSLATIONS_BASE = 'https://assets-translations.totalbattle.dev//';
const ENGLISH = 'csv_en_US';
const FETCH_TIMEOUT_MS = 120_000;

export const TABLE_ITEMS = 8;
export const TABLE_UNITS = 9;
export const TABLE_HERO_AVATARS = 13;
export const TABLE_TECHS = 21;
/** Captains: f5 name vector, f7 JSON config naming the sprites (smallIcon, unitAltarArt). */
export const TABLE_CAPTAINS = 75;
/** Customizations (portrait frames, city looks): f1 kind, f2 name vector, f4 visual JSON. */
export const TABLE_CUSTOMIZATIONS = 52;
/** T52 kind of a hero-portrait frame. */
const CUSTOMIZATION_FRAME = 1;
/** T52 kind of a city look; its visual JSON holds another JSON with {"icon": {minCityLevel: icon}}. */
const CUSTOMIZATION_CITY = 2;

export interface ArtUnit {
  id: number;
  name: string;
  /** T9 f2: the tier the game frames the icon by (0 = Dwarf-like, 1–10 = I–X). */
  tier: number;
  strength: number;
  health: number;
  icon: string;
}

/** Bumped when ArtStatic gains a field: a cache file of an older format is rebuilt once (2: unit tiers, portrait frames; 4: titles). */
export const ART_STATIC_FORMAT = 4;

export interface ArtItem {
  id: number;
  name: string;
  icon: string;
}

export interface ArtStatic {
  version: string;
  /** ART_STATIC_FORMAT it was built with (absent = 1). */
  format?: number;
  /** T13 id (= a player's heroAvatar) → { name, icon }. */
  heroes: Record<string, { name: string; icon: string }>;
  units: ArtUnit[];
  /** T21 id → { name, icon }. */
  techs: Record<string, { name: string; icon: string }>;
  items: ArtItem[];
  /** T75 id → { name, icon (smallIcon), art (unitAltarArt) }. */
  captains: Record<string, { name: string; icon: string; art: string }>;
  /** T52 id of a portrait frame → { name, visual (the frame sprite) }. */
  frames?: Record<string, { name: string; visual: string }>;
  /** T52 id of a city look → { name, icons: lowest city level → icon }. 9 = the default "Player's City". */
  cityLooks?: Record<string, { name: string; icons: Record<string, string> }>;
  /** T110 artifact type → { name, icon (config `icon`) }. Absent in caches built before Nov 2026's artifacts. */
  artifacts?: Record<string, { name: string; icon: string }>;
  /** T11 equipment item type → { name, icon (f2) }. Same age as `artifacts`. */
  equipment?: Record<string, { name: string; icon: string }>;
  /** T8 gems (f1 8) and enchantments (f1 9) → { name, icon }. Same age as `artifacts`. */
  inserts?: Record<string, { name: string; icon: string }>;
  /** T29 title id → { name, icon (round smallIcon), art (72 px mobileIcon, else rewardIcon) }. Format 4+. */
  titles?: Record<string, { name: string; icon: string; art: string }>;
}

/** Titles: f1 name vector, f3 visual JSON. */
export const TABLE_TITLES = 29;

/** Artifact types: f7 JSON config {"icon": …}, f8 name vector. A `$pairs` table keyed [type]. */
export const TABLE_ARTIFACTS = 110;
/** Equipment: f2 icon address ("arch_body"), f3 name vector. */
export const TABLE_EQUIPMENT = 11;

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function readWrappedArray(buf: Buffer): Wire[] {
  const r = new WireReader(buf);
  if (r.arrayLength() !== 1) throw new Error('expected a wrapped array');
  const n = r.arrayLength();
  const out: Wire[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = r.value();
  return out;
}

async function fetchEnglish(catalog: string): Promise<Map<string, string>> {
  const index = JSON.parse((await fetchBuffer(TRANSLATIONS_BASE + catalog)).toString('utf8')) as {
    files?: Array<{ name: string; fileName: string }>;
  };
  const entry = index.files?.find((f) => f.name === ENGLISH);
  if (!entry) throw new Error(`translations index has no ${ENGLISH}`);
  return parseTranslationsCsv(unzipFirst(await fetchBuffer(TRANSLATIONS_BASE + entry.fileName)).toString('utf8'));
}

/** Pure: pools + tables + English → the icon slice. Unit-tested with synthetic tables. */
export function buildArtStatic(
  version: string,
  strings: Wire[],
  vectors: Wire[],
  tables: Map<number, Record<string, Wire>>,
  en: Map<string, string>,
): ArtStatic {
  const str = (ref: Wire): string | undefined => (typeof ref === 'number' && typeof strings[ref] === 'string' ? (strings[ref] as string) : undefined);
  const name = (vref: Wire): string => {
    const v = typeof vref === 'number' ? vectors[vref] : undefined;
    if (!Array.isArray(v) || !v.length) return '';
    const key = str(v[0]);
    const text = key === undefined ? '' : (en.get(key) ?? '');
    return text.replace(/\s+/g, ' ').trim();
  };
  const rows = (t: number): Array<[number, Wire[]]> =>
    Object.entries(tables.get(t) ?? {})
      .filter((e): e is [string, Wire[]] => Array.isArray(e[1]))
      .map(([id, row]) => [Number(id), row] as [number, Wire[]])
      .sort((a, b) => a[0] - b[0]);
  const num = (v: Wire): number => (typeof v === 'number' ? v : 0);

  const heroes: ArtStatic['heroes'] = {};
  for (const [id, row] of rows(TABLE_HERO_AVATARS)) {
    const icon = str(row[3]);
    if (icon) heroes[id] = { name: name(row[1]), icon };
  }
  const units: ArtUnit[] = [];
  for (const [id, row] of rows(TABLE_UNITS)) {
    const icon = str(row[4]);
    const n = name(row[1]);
    if (icon && n) units.push({ id, name: n, tier: num(row[2]), strength: num(row[10]), health: num(row[12]), icon });
  }
  const techs: ArtStatic['techs'] = {};
  for (const [id, row] of rows(TABLE_TECHS)) {
    const icon = str(row[3]);
    if (icon) techs[id] = { name: name(row[1]), icon };
  }
  const items: ArtItem[] = [];
  for (const [id, row] of rows(TABLE_ITEMS)) {
    const visual = str(row[6]);
    if (!visual || !visual.startsWith('{')) continue;
    let icon: unknown;
    try {
      icon = (JSON.parse(visual) as { icon?: unknown }).icon;
    } catch {
      continue;
    }
    const n = name(row[3]);
    if (typeof icon === 'string' && icon && n) items.push({ id, name: n, icon });
  }
  const captains: ArtStatic['captains'] = {};
  for (const [id, row] of rows(TABLE_CAPTAINS)) {
    const n = name(row[5]);
    let cfg: { smallIcon?: unknown; unitAltarArt?: unknown } = {};
    try { cfg = JSON.parse(str(row[7]) ?? '{}'); } catch { continue; }
    const icon = typeof cfg.smallIcon === 'string' ? cfg.smallIcon : '';
    const art = typeof cfg.unitAltarArt === 'string' ? cfg.unitAltarArt : '';
    if (n && (icon || art)) captains[id] = { name: n, icon, art };
  }
  const frames: NonNullable<ArtStatic['frames']> = {};
  const cityLooks: NonNullable<ArtStatic['cityLooks']> = {};
  for (const [id, row] of rows(TABLE_CUSTOMIZATIONS)) {
    if (row[1] !== CUSTOMIZATION_FRAME && row[1] !== CUSTOMIZATION_CITY) continue;
    let cfg: { visual?: unknown } = {};
    try { cfg = JSON.parse(str(row[4]) ?? '{}'); } catch { continue; }
    if (typeof cfg.visual !== 'string' || !cfg.visual) continue;
    if (row[1] === CUSTOMIZATION_FRAME) {
      // Animated frames name a Spine animation separately; `visual` is their still.
      frames[id] = { name: name(row[2]), visual: cfg.visual };
      continue;
    }
    let look: { icon?: unknown } = {};
    try { look = JSON.parse(cfg.visual); } catch { continue; }
    const icons: Record<string, string> = {};
    if (look.icon && typeof look.icon === 'object') {
      for (const [lvl, icon] of Object.entries(look.icon as Record<string, unknown>)) {
        if (/^\d+$/.test(lvl) && typeof icon === 'string' && icon) icons[lvl] = icon;
      }
    }
    if (Object.keys(icons).length) cityLooks[id] = { name: name(row[2]), icons };
  }
  const artifacts: NonNullable<ArtStatic['artifacts']> = {};
  for (const [id, row] of rows(TABLE_ARTIFACTS)) {
    let cfg: { icon?: unknown } = {};
    try { cfg = JSON.parse(str(row[7]) ?? '{}'); } catch { continue; }
    if (typeof cfg.icon === 'string' && cfg.icon) artifacts[id] = { name: name(row[8]), icon: cfg.icon };
  }
  const equipment: NonNullable<ArtStatic['equipment']> = {};
  for (const [id, row] of rows(TABLE_EQUIPMENT)) {
    const icon = str(row[2]);
    if (icon && /^[a-z0-9_]+$/i.test(icon)) equipment[id] = { name: name(row[3]), icon };
  }
  const inserts: NonNullable<ArtStatic['inserts']> = {};
  for (const [id, row] of rows(TABLE_ITEMS)) {
    if (row[1] !== 8 && row[1] !== 9) continue;
    let icon: unknown;
    try { icon = (JSON.parse(str(row[6]) ?? '{}') as { icon?: unknown }).icon; } catch { continue; }
    if (typeof icon === 'string' && icon) inserts[id] = { name: name(row[3]), icon };
  }
  const titles: NonNullable<ArtStatic['titles']> = {};
  for (const [id, row] of rows(TABLE_TITLES)) {
    let v: { smallIcon?: unknown; mobileIcon?: unknown; rewardIcon?: unknown } = {};
    try { v = JSON.parse(str(row[3]) ?? '{}'); } catch { continue; }
    const icon = typeof v.smallIcon === 'string' ? v.smallIcon : '';
    const art = typeof v.mobileIcon === 'string' && v.mobileIcon ? v.mobileIcon : typeof v.rewardIcon === 'string' ? v.rewardIcon : '';
    if (icon || art) titles[id] = { name: name(row[1]), icon, art };
  }
  return { version, format: ART_STATIC_FORMAT, heroes, units, techs, items, captains, frames, cityLooks, artifacts, equipment, inserts, titles };
}

export function staticKey(v: StaticVersion): string {
  return `${v.composite.slice(0, 16)}-${v.translationsCatalog.replace(/\.json$/, '')}`;
}

function cacheFile(dir: string, key: string): string {
  return path.join(dir, `static-${key}.json`);
}

/**
 * The icon slice for the live static data: from the on-disk cache, else
 * rebuilt from the CDN. Falls back to the newest cache when the versions
 * endpoint is unreachable. Keeps the two newest cache files.
 */
export async function loadArtStatic(dir: string): Promise<ArtStatic> {
  let version: StaticVersion;
  try {
    version = await fetchStaticVersion();
  } catch (err) {
    const cached = newestCache(dir);
    if (cached) return cached;
    throw err;
  }
  const key = staticKey(version);
  const file = cacheFile(dir, key);
  if (fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as ArtStatic;
    // A cache from an older format (no captains, no unit tiers, no artifacts or
    // equipment) is rebuilt once.
    if (cached.captains && cached.format === ART_STATIC_FORMAT && cached.artifacts && cached.equipment) return cached;
  }
  const [stringsBuf, vectorsBuf, tablesBuf, en] = await Promise.all([
    fetchBuffer(STATIC_BASE + version.files.strings),
    fetchBuffer(STATIC_BASE + version.files.vectors),
    fetchBuffer(STATIC_BASE + version.files.noDuplicates),
    fetchEnglish(version.translationsCatalog),
  ]);
  const data = buildArtStatic(
    key,
    readWrappedArray(stringsBuf),
    readWrappedArray(vectorsBuf),
    readTables(tablesBuf, [TABLE_ITEMS, TABLE_UNITS, TABLE_HERO_AVATARS, TABLE_TECHS, TABLE_CAPTAINS, TABLE_CUSTOMIZATIONS, TABLE_ARTIFACTS, TABLE_EQUIPMENT, TABLE_TITLES]),
    en,
  );
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
  pruneCaches(dir, 2);
  return data;
}

function cacheFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^static-.+\.json$/.test(f))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function newestCache(dir: string): ArtStatic | null {
  const f = cacheFiles(dir)[0];
  return f ? (JSON.parse(fs.readFileSync(f, 'utf8')) as ArtStatic) : null;
}

function pruneCaches(dir: string, keep: number): void {
  for (const f of cacheFiles(dir).slice(keep)) {
    try {
      fs.unlinkSync(f);
    } catch {
      // another process may have removed it; nothing to do
    }
  }
}
