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
 *   T11 equipment     see TABLE_EQUIPMENT (gems/enchantments are T8 items)
 *   T75 captains      see TABLE_CAPTAINS
 *   T110–T113         artifacts (types, star levels, levels, random-bonus pools)
 *                     — `$pairs` tables keyed `[type]`, see TABLE_ARTIFACTS
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
/**
 * Artifacts, all keyed by the artifact TYPE (one per type per player):
 *   T110 types        f7 JSON config {"icon": …}, f8 name vector, f9 tooltip
 *                     vector, f11 rarity (4 epic, 5 legendary, 6 mythic)
 *   T111 star levels  [[type], {star: [star, bigStar, effectId, cost, propsRef, …]}]
 *   T112 levels       [[type], xpItem, {level: [level, effectId, cond, xp, propsRef, …]}]
 *   T113 bonus pool   [[type], {effectId: [weight, propTextRef, valueTextRef, quality]}, unlocks]
 * An effect id (T20) names exactly one level, star level or random bonus of
 * one type, so a city's active effects (601 field 14) say which artifacts the
 * line-up captains wear, at what level and star level, with which rolls.
 */
export const TABLE_ARTIFACTS = 110;
export const TABLE_ARTIFACT_STARS = 111;
export const TABLE_ARTIFACT_LEVELS = 112;
export const TABLE_ARTIFACT_BONUSES = 113;
/**
 * Equipment (hero and captain gear), one row per item TYPE — and the type
 * includes the quality grade: "Cursed Claw Coat" exists once per grade.
 *   f1 set, f2 icon address ("arch_body": set prefix + slot), f3 name vector,
 *   f5 quality grade 1–8 (Poor … Godlike), f7 durability,
 *   f9 props JSON — the item's bonuses at that grade ("Crypt exploration
 *   efficiency +50,0%"); `equipment.client_info.n0001` is Durability.
 * Gems (T8 f1 8) and enchantments (T8 f1 9) set into an item are T8 items:
 * f3 name vector, f6 visual JSON {"icon": …}.
 */
export const TABLE_EQUIPMENT = 11;
/**
 * The Hall of Fame's factions: `[id, …, visualRef, techId]` — f4 a JSON string
 * ({banner, frameIcon, icon, stainedGlass, tooltipDescription:
 * "battler_fraction.tooltip.<key>"}), f5 the city TECH that holds the
 * faction's level: 1 Lions of Courage → 800, 2 Eagles of Resolve → 802,
 * 3 Wolves of Tenacity → 801. The ids are the captains' T75 f1 faction. The
 * Hall of Fame itself is tech 803, whose levels require
 * `HasFractionLevel(800,801,802,N)`. Every member's city techs (field 17)
 * carry them, so the levels are in game_player_techs like research.
 */
export const TABLE_FACTIONS = 78;
const NEEDED_TABLES = [
  TABLE_MAP_OBJECTS, TABLE_GIFT_TYPES, TABLE_HEROES, TABLE_TECHS, TABLE_CAPTAINS,
  TABLE_ARTIFACTS, TABLE_ARTIFACT_STARS, TABLE_ARTIFACT_LEVELS, TABLE_ARTIFACT_BONUSES,
  TABLE_EQUIPMENT, TABLE_CLAN_MEDALS, TABLE_FACTIONS,
];

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
  /** Artifacts by type (T110 id). Absent in names.json older than format 3. */
  artifacts?: Record<string, GameArtifact>;
  /** Equipment by item type (T11 id; the type includes the quality grade). Format 3+. */
  equipment?: Record<string, GameEquipment>;
  /** Equipment quality grade 1–8 → the game's label ("Poor" … "Godlike"). Format 3+. */
  equipmentGrades?: Record<string, string>;
  /** Gems and enchantments (T8 id) that can be set into equipment. Format 3+. */
  inserts?: Record<string, GameInsert>;
  /** The Hall of Fame's three factions by T78 id (1 Lions, 2 Eagles, 3 Wolves). Format 5+. */
  factions?: Record<string, GameFaction>;
  /** The Hall of Fame itself (tech 803): its levels, bonuses and requirements. Format 5+. */
  hallOfFame?: GameLevelledTech;
  /** NAMES_FORMAT the file was built with; an older one is rebuilt once. */
  format?: number;
}

/** A tech whose levels the Hall of Fame shows: per level its bonuses and what reaching it requires. */
export interface GameLevelledTech {
  /** The city tech that holds the level (game_player_techs). */
  techId: number;
  /** The game's name ("Hall of Fame", "Lions of Courage"). */
  name: string;
  maxLevel: number;
  /**
   * Level → the bonuses AT that level ([text, value], the game's own lines:
   * "Army strength", "+41,25%") and the game's texts for what reaching it
   * requires beyond the level before ("Level 150 epic, legendary or mythic
   * Captains of this faction needed: 2", "Required level of all factions: 46").
   */
  levels: Record<string, { lines: GameTextLine[]; requires: string[] }>;
}

export interface GameFaction extends GameLevelledTech {
  /** T78 id = the captains' T75 f1 faction: 1 Lions of Courage, 2 Eagles of Resolve, 3 Wolves of Tenacity. */
  id: number;
  /** "courage" | "resolve" | "tenacity" (the game's key). */
  key: string;
  /** Sprites from the faction's visual config. */
  art: { stainedGlass: string; icon: string; banner: string; frameIcon: string };
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

/** A text line as the game's artifact book prints it: [text, value] ("Crypt exploration efficiency", "+130.0%"). */
export type GameTextLine = [string, string];

export interface GameEquipment {
  name: string;
  /** Icon address (T11 f2, e.g. "arch_body"). */
  icon: string;
  /** Quality grade 1–8 (Poor, Common, Uncommon, Rare, Epic, Legendary, Ascendant, Godlike). */
  grade: number;
  /** The item's bonuses at its grade, Durability left out. */
  lines: GameTextLine[];
}

export interface GameInsert {
  name: string;
  icon: string;
  kind: 'gem' | 'enchantment';
}

export interface GameArtifact {
  name: string;
  /** T110 f11: 4 epic, 5 legendary, 6 mythic. */
  rarity: number;
  /** The game's label for the rarity ("Legendary"). */
  rarityName: string;
  /** Icon sprite (T110 config `icon`). */
  icon: string;
  maxLevel: number;
  maxStar: number;
  /** Level effect id → [level, the level's lines]. */
  levels: Record<string, [number, GameTextLine[]]>;
  /** Star-level effect id → [star level 1–25, the star level's lines]. */
  stars: Record<string, [number, GameTextLine[]]>;
  /** Random-bonus effect id → [text, value, quality 1–5 (5 = best roll)]. */
  bonuses: Record<string, [string, string, number]>;
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
 * and rarity labels; 3: clan medals; 4: artifacts, equipment, gems; 5: the
 * Hall of Fame's factions, and the real names of techs 800–803 — Nov 2026); a
 * cached file with an older format is rebuilt.
 */
export const NAMES_FORMAT = 5;

/** T62 f6 medal tier → the game's own tier label key (the clan_medals config's goblet tierName). */
const MEDAL_TIER_KEYS: Record<number, string> = {
  1: 'client_config.value.goblet_bronze',
  2: 'client_config.value.goblet_silver',
  3: 'client_config.value.goblet_gold',
  4: 'client_config.value.goblet_platinum',
};

/** T11 f5 equipment quality grade → the forge's own label key. */
const EQUIPMENT_GRADE_KEYS: Record<number, string> = {
  1: 'client.craft.gray_item_title',
  2: 'client.craft.white_item_title',
  3: 'client.craft.green_item_title',
  4: 'client.craft.blue_item_title',
  5: 'client.craft.violet_item_title',
  6: 'client.craft.orange_item_title',
  7: 'client.craft.red_item_title',
  8: 'client.craft.gold_item_title',
};
/** The props line that is the item's durability, not a bonus. */
const DURABILITY_PROP = 'equipment.client_info.n0001';

/** T110 f11 rarity → the artifact book's own label key. */
const ARTIFACT_RARITY_KEYS: Record<number, string> = {
  4: 'client.artifact.window.artifact.epic_rarity',
  5: 'client.artifact.window.artifact.legendary_rarity',
  6: 'client.artifact.window.artifact.mythical_rarity',
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

/**
 * Decode only the requested tables of no_duplicates; the rest are skipped
 * unbuilt. Most tables are maps keyed by a plain id; some (the artifact tables)
 * are `$pairs` keyed by a one-element array `[id]` — those come back keyed by
 * that id, the same shape as the others.
 */
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
    const t = asIdRecord(r.value());
    if (t) out.set(i, t);
  }
  return out;
}

/** A table as `id → row`: a plain map as is, `$pairs` keyed `[id]` (or `id`) re-keyed; anything else null. */
export function asIdRecord(t: Wire): Record<string, Wire> | null {
  if (!t || typeof t !== 'object' || Array.isArray(t) || '$bin' in t) return null;
  if (!('$pairs' in t)) return t as Record<string, Wire>;
  const rec: Record<string, Wire> = {};
  for (const [k, v] of (t as { $pairs: Array<[Wire, Wire]> }).$pairs) {
    const id = Array.isArray(k) && k.length === 1 ? k[0] : k;
    if (typeof id === 'number' || typeof id === 'string') rec[String(id)] = v;
  }
  return rec;
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
  // The Hall of Fame. Its techs' own name vectors are placeholders ("Ranged
  // units' strength I" for the Lions' tech 800), which every research list
  // would show — they take the factions' real names.
  const { factions, hallOfFame } = buildFactions(tables, str, en);
  for (const f of [...Object.values(factions), ...(hallOfFame ? [hallOfFame] : [])]) {
    techs[String(f.techId)] = { name: f.name, maxLevel: f.maxLevel };
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
  const artifacts = buildArtifacts(tables, str, vecText, en);
  const equipment: Record<string, GameEquipment> = {};
  for (const [id, row] of rows(TABLE_EQUIPMENT)) {
    const name = vecText(row[3]);
    const icon = str(row[2]);
    if (!name || !icon) continue;
    let props: Array<{ propText?: string; propValue?: unknown }> = [];
    try { props = (JSON.parse(str(row[9]) ?? '{}') as { props?: typeof props }).props ?? []; } catch { /* no props */ }
    const lines = props
      .filter((p) => typeof p.propText === 'string' && p.propText && p.propText !== DURABILITY_PROP)
      .map((p): GameTextLine => [en.get(p.propText as string) ?? (p.propText as string), String(p.propValue ?? '')]);
    equipment[id] = { name, icon, grade: typeof row[5] === 'number' ? row[5] : 0, lines };
  }
  const equipmentGrades: Record<string, string> = {};
  for (const [grade, key] of Object.entries(EQUIPMENT_GRADE_KEYS)) {
    const label = en.get(key);
    if (label) equipmentGrades[grade] = label;
  }
  const inserts: Record<string, GameInsert> = {};
  for (const [id, row] of rows(TABLE_GIFT_TYPES)) {
    if (row[1] !== 8 && row[1] !== 9) continue;
    const name = vecText(row[3]);
    if (!name) continue;
    let icon = '';
    try {
      const v = JSON.parse(str(row[6]) ?? '{}') as { icon?: unknown };
      if (typeof v.icon === 'string') icon = v.icon;
    } catch { /* no visual */ }
    inserts[id] = { name, icon, kind: row[1] === 8 ? 'gem' : 'enchantment' };
  }
  return {
    version, builtAt: new Date().toISOString(), format: NAMES_FORMAT,
    gifts, techs, objects, heroes, captains, medals, artifacts, equipment, equipmentGrades, inserts,
    factions, ...(hallOfFame ? { hallOfFame } : {}),
  };
}

const isPlainObject = (v: Wire): v is Record<string, Wire> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !('$bin' in v) && !('$pairs' in v);

/**
 * The game's own texts for what reaching a tech level requires, from its
 * condition strings. "HasTech(…)" on the level before is left out (implied);
 * an unknown condition is left out rather than shown raw.
 *   HasCaptainFractionRarityLevel(lvl, faction, rarity, count)
 *     → "Level 150 epic, legendary or mythic Captains of this faction needed: 2"
 *   HasFractionLevel(800,801,802, lvl) → "Required level of all factions: 46"
 */
export function conditionTexts(conds: string[], en: Map<string, string>): string[] {
  const out: string[] = [];
  for (const cond of conds) {
    for (const part of cond.split('&&').map((p) => p.trim())) {
      const captains = /^HasCaptainFractionRarityLevel\((\d+),(\d+),(\d+),(\d+)\)$/.exec(part);
      if (captains) {
        // Rarity 2 = epic and up; 3 = legendary and up (T75 f2: 1 rare … 4 mythic).
        const key = Number(captains[3]) >= 3 ? 'legendary' : 'epic';
        const tpl = en.get(`client_config.value.conditions.has_captain_fraction_rarity_level.${key}`);
        if (tpl) out.push(tpl.replace('%lvl%', captains[1]).replace('%count%', captains[4]));
        continue;
      }
      const all = /^HasFractionLevel\((?:\d+,)+(\d+)\)$/.exec(part);
      if (all) {
        const tpl = en.get('client.conditions.has_fraction_level');
        if (tpl) out.push(tpl.replace('%lvl%', all[1]));
      }
    }
  }
  return out;
}

/**
 * The Hall of Fame from the static data: the three factions (T78 → their
 * techs' levels) and the Hall of Fame tech (the one whose levels require
 * `HasFractionLevel(…)`). Per level: the bonuses at that level and the game's
 * texts for its requirements. Pure; unit-tested.
 */
export function buildFactions(
  tables: Map<number, Record<string, Wire>>,
  str: (ref: Wire) => string | undefined,
  en: Map<string, string>,
): { factions: Record<string, GameFaction>; hallOfFame: GameLevelledTech | null } {
  const techRows = tables.get(TABLE_TECHS) ?? {};
  const levelled = (techId: number, name: string): GameLevelledTech | null => {
    const row = techRows[String(techId)];
    const lv = Array.isArray(row) ? row[5] : undefined;
    if (!lv || !isPlainObject(lv)) return null;
    const levels: GameLevelledTech['levels'] = {};
    for (const [level, r] of Object.entries(lv)) {
      if (!Array.isArray(r)) continue;
      // [level, effectId, …, [conditionRefs], propsRef, …]
      let props: Array<{ propText?: string; propValue?: unknown }> = [];
      try { props = (JSON.parse(str(r[4]) ?? '{}') as { props?: typeof props }).props ?? []; } catch { /* no props */ }
      const lines = props
        .filter((p) => typeof p.propText === 'string' && p.propText)
        .map((p): GameTextLine => [en.get(p.propText as string) ?? (p.propText as string), String(p.propValue ?? '')]);
      const conds = (Array.isArray(r[3]) ? r[3] : []).map((c) => str(c)).filter((c): c is string => !!c);
      levels[level] = { lines, requires: conditionTexts(conds, en) };
    }
    return { techId, name, maxLevel: Object.keys(levels).length, levels };
  };

  const factions: Record<string, GameFaction> = {};
  for (const [id, row] of Object.entries(tables.get(TABLE_FACTIONS) ?? {})) {
    if (!Array.isArray(row) || typeof row[5] !== 'number') continue;
    let visual: { banner?: string; frameIcon?: string; icon?: string; stainedGlass?: string; tooltipDescription?: string } = {};
    try { visual = JSON.parse(str(row[4]) ?? '{}'); } catch { /* no visual */ }
    const key = /battler_fraction\.tooltip\.([a-z_]+)/.exec(visual.tooltipDescription ?? '')?.[1] ?? '';
    const name = (key && en.get(`battler_fraction.description.${key}`)) || `#${id}`;
    const tech = levelled(row[5], name);
    if (!tech) continue;
    factions[id] = {
      ...tech,
      id: Number(id),
      key,
      art: { stainedGlass: visual.stainedGlass ?? '', icon: visual.icon ?? '', banner: visual.banner ?? '', frameIcon: visual.frameIcon ?? '' },
    };
  }

  let hallOfFame: GameLevelledTech | null = null;
  for (const [id, row] of Object.entries(techRows)) {
    const lv = Array.isArray(row) ? row[5] : undefined;
    if (!lv || !isPlainObject(lv)) continue;
    const first = Object.values(lv)[0];
    const conds = Array.isArray(first) && Array.isArray(first[3]) ? first[3].map((c) => str(c) ?? '') : [];
    if (conds.some((c) => c.startsWith('HasFractionLevel('))) {
      hallOfFame = levelled(Number(id), en.get('client.fractions_hall.title') ?? 'Hall of Fame');
      break;
    }
  }
  return { factions, hallOfFame };
}

/**
 * T110–T113 → per artifact type: name, rarity, icon, and every level, star
 * level and random bonus by the effect id the game puts in a city's active
 * effects. Lines are the game's own text ("Crypt exploration efficiency",
 * "+130.0%"), from the props JSON a level or star level carries.
 */
function buildArtifacts(
  tables: Map<number, Record<string, Wire>>,
  str: (ref: Wire) => string | undefined,
  vecText: (ref: Wire) => string | undefined,
  en: Map<string, string>,
): Record<string, GameArtifact> {
  const propLines = (ref: Wire): GameTextLine[] => {
    let props: Array<{ propText?: string; propValue?: unknown }> = [];
    try { props = (JSON.parse(str(ref) ?? '{}') as { props?: typeof props }).props ?? []; } catch { /* no props */ }
    return props
      .filter((p) => typeof p.propText === 'string' && p.propText)
      .map((p): GameTextLine => [en.get(p.propText as string) ?? (p.propText as string), String(p.propValue ?? '')]);
  };
  const out: Record<string, GameArtifact> = {};
  const types = tables.get(TABLE_ARTIFACTS) ?? {};
  for (const [id, row] of Object.entries(types)) {
    if (!Array.isArray(row)) continue;
    const name = vecText(row[8]);
    if (!name) continue;
    let icon = '';
    try {
      const cfg = JSON.parse(str(row[7]) ?? '{}') as { icon?: unknown };
      if (typeof cfg.icon === 'string') icon = cfg.icon;
    } catch { /* no config */ }
    const rarity = typeof row[11] === 'number' ? row[11] : 0;

    const levels: GameArtifact['levels'] = {};
    const lv = tables.get(TABLE_ARTIFACT_LEVELS)?.[id];
    const lvRows = Array.isArray(lv) ? lv[2] : undefined;
    if (lvRows && isPlainObject(lvRows)) {
      for (const r of Object.values(lvRows)) {
        if (Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number') levels[String(r[1])] = [r[0], propLines(r[4])];
      }
    }
    const stars: GameArtifact['stars'] = {};
    const st = tables.get(TABLE_ARTIFACT_STARS)?.[id];
    const stRows = Array.isArray(st) ? st[1] : undefined;
    if (stRows && isPlainObject(stRows)) {
      for (const r of Object.values(stRows)) {
        if (Array.isArray(r) && typeof r[0] === 'number' && typeof r[2] === 'number') stars[String(r[2])] = [r[0], propLines(r[4])];
      }
    }
    const bonuses: GameArtifact['bonuses'] = {};
    const bp = tables.get(TABLE_ARTIFACT_BONUSES)?.[id];
    const bpRows = Array.isArray(bp) ? bp[1] : undefined;
    if (bpRows && isPlainObject(bpRows)) {
      for (const [effectId, r] of Object.entries(bpRows)) {
        if (!Array.isArray(r)) continue;
        const key = str(r[1]);
        if (!key) continue;
        bonuses[effectId] = [en.get(key) ?? key, str(r[2]) ?? '', typeof r[3] === 'number' ? r[3] : 0];
      }
    }
    const levelNums = Object.values(levels).map(([n]) => n);
    const starNums = Object.values(stars).map(([n]) => n);
    out[id] = {
      name,
      rarity,
      rarityName: en.get(ARTIFACT_RARITY_KEYS[rarity] ?? '') ?? '',
      icon,
      maxLevel: levelNums.length ? Math.max(...levelNums) : 0,
      maxStar: starNums.length ? Math.max(...starNums) : 0,
      levels,
      stars,
      bonuses,
    };
  }
  return out;
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
 * A rebuild in flight: clans on different accounts scan at the same time
 * (scan-lanes.ts), and after a game patch each would otherwise download and
 * decode the ~67 MB of static data on its own.
 */
let building: { key: string; promise: Promise<GameNames> } | null = null;

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
  if (building?.key === key) return building.promise;
  const promise = buildAndCacheNames(version, key, file);
  building = { key, promise };
  try {
    return await promise;
  } finally {
    if (building?.promise === promise) building = null;
  }
}

async function buildAndCacheNames(version: StaticVersion, key: string, file: string): Promise<GameNames> {
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
    `${Object.keys(names.objects).length} map objects, ${Object.keys(names.heroes).length} heroes, ` +
    `${Object.keys(names.captains).length} captains, ${Object.keys(names.artifacts ?? {}).length} artifacts`,
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
