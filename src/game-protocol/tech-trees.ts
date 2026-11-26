/**
 * Research and hero-talent TREES — what a page needs to draw every player's
 * levels the way the game's Academy does: trees, their nodes (name, icon, max
 * level), where each node sits and which nodes unlock it.
 *
 * Three public sources, all from the game's own CDN:
 *
 *   static data (see static-data.ts)
 *     T21 techs   f1 name vector · f2 description vector · f3 icon sprite ·
 *                 f4 branch (tree) id · f5 levels {n: [n, …, [conditionRef], …]}
 *                 Each level's condition string gates buying that level:
 *                 "HasTech(1223,10,10)&&HasBuildingLevel(1,25,1)" — HasTech(id,
 *                 minLevel, _) on ANOTHER tech is a prerequisite (the third
 *                 argument varies by tree and isn't needed); on the tech itself
 *                 it's just "own previous level".
 *     T1  client config (client-config.ts): which trees exist, their Academy
 *         tabs ("Unlock" / "Boost") and order, the hero's talent trees
 *   Unity client assets (the art pipeline's reader, src/game-art: catalog,
 *   UnityFS + LZ4, SerializedFile type trees)
 *     a JSON TextAsset per tree, named after the branch's `tree` ("guardTree"
 *     → asset "guardtree"): {name, techs: [{id, x, y, linkType, …}]}. x grows
 *     to the right in steps of 390, y runs 0 → −330 downward in steps of 165
 *     (three rows, with half-steps between). linkType/linkPlace only pick the
 *     connector sprite; the real edges are the HasTech prerequisites.
 *
 * Gem combining is not a tree of its own: "Combining gems I–IV" are nodes of
 * the Blacksmithing research tree.
 *
 * The result is a small tech-trees.json cached next to names.json under
 * data/game-static/<static version>/, rebuilt when the static data, the
 * translations or the client's asset catalog change.
 */
import fs from 'fs';
import path from 'path';
import { WireReader, type Wire } from './codec.js';
import { TABLE_TECHS, parseTranslationsCsv, unzipFirst } from './static-data.js';
import { TABLE_CLIENT_CONFIG, academyTabs, clientConfig, readBranchDefs, type BranchDef, type TextLookup } from './client-config.js';
import { UNITY_BASE, nameIndex, parseCatalog } from '../game-art/catalog.js';
import { extractTexts } from '../game-art/extract.js';
import { childLogger } from '../utils/logger.js';
import { reportReaderFailed, reportReaderOk } from '../game-patch/status.js';

export { TABLE_CLIENT_CONFIG, type BranchDef };

const log = childLogger('tech-trees');

const VERSIONS_URL = 'https://versions.totalbattle.com/config/?branch=current&simple=true';
const STATIC_BASE = 'https://assets-client-static.totalbattle.dev/';
const TRANSLATIONS_BASE = 'https://assets-translations.totalbattle.dev//';
const STATIC_BRANCH = 'production';
const UNITY_PLATFORM = 'webgl';
const ENGLISH = 'csv_en_US';
const FETCH_TIMEOUT_MS = 120_000;

const NEEDED_TABLES = [TABLE_CLIENT_CONFIG, TABLE_TECHS];

/** The client's node pitch in layout units: one column, one row. */
const COL_UNIT = 390;
const ROW_UNIT = 165;

export type TechTreeKind = 'research' | 'talent' | 'clan' | 'other';

export interface TechRequirement {
  /** The prerequisite tech — may sit in another tree (Guardsmen II needs Guardsmen I nodes). */
  techId: number;
  /** Its minimum level. */
  level: number;
  /** The level of THIS node that first asks for it: 1 = needed to unlock at all. */
  atLevel: number;
}

export interface TechTreeNode {
  techId: number;
  name: string;
  /** The game's one-line description; '' when it has none. */
  description: string;
  /** Sprite name, e.g. "tech_guards_cost_72"; '' when the game has none. */
  icon: string;
  maxLevel: number;
  /** Grid position as the game draws it: col 0 = left, row 0 = top (0–2); halves occur. */
  col: number;
  row: number;
  requires: TechRequirement[];
}

export interface TechTree {
  /** The game's branch id (T21 f4). */
  id: number;
  name: string;
  description: string;
  kind: TechTreeKind;
  /** Academy tab ("Unlock" / "Boost") for research trees; null elsewhere. */
  tab: string | null;
  /** The branch's sprite. */
  icon: string;
  /** The client's layout asset name ("guardTree"). */
  layout: string;
  nodes: TechTreeNode[];
}

export interface TechTrees {
  /** `${static version key}:${asset catalog}` — changes whenever any source does. */
  version: string;
  builtAt: string;
  trees: TechTree[];
}

/** A tree layout as the client ships it. */
export interface TreeLayout {
  name: string;
  techs: Array<{ id: number; x: number; y: number }>;
}

export interface TreeSources {
  strings: Wire[];
  vectors: Wire[];
  /** At least T1 (client config, an array table) and T21 (techs). */
  tables: Map<number, Wire>;
  en: TextLookup;
}

// ---------------------------------------------------------------------------
// Pure decoding
// ---------------------------------------------------------------------------

function resolver(src: TreeSources) {
  const { strings, vectors, en } = src;
  const str = (ref: Wire | undefined): string | undefined =>
    typeof ref === 'number' && typeof strings[ref] === 'string' ? (strings[ref] as string) : undefined;
  const text = (ref: Wire | undefined): string | undefined => {
    const k = str(ref);
    return k === undefined ? undefined : (en.get(k) ?? k);
  };
  // Same rule as static-data's names: a vector [templateRef, placeholderRef,
  // valueRef, …]; anything resolving to a JSON fragment isn't text.
  const vecText = (vref: Wire | undefined): string | undefined => {
    const v = typeof vref === 'number' ? vectors[vref] : undefined;
    if (!Array.isArray(v) || !v.length) return undefined;
    let out = text(v[0]) ?? '';
    for (let i = 1; i + 1 < v.length; i += 2) out = out.replace(str(v[i]) ?? '\u0000', str(v[i + 1]) ?? '');
    out = out.replace(/\s+/g, ' ').trim();
    return out && !out.startsWith('{') && !out.startsWith('[') ? out : undefined;
  };
  return { str, text, vecText };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const numList = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);

/** Every tree the client config declares, in-game English names resolved. */
export function readBranches(src: TreeSources): BranchDef[] {
  return readBranchDefs(src.tables.get(TABLE_CLIENT_CONFIG), resolver(src).str, src.en);
}

/** Prerequisites on other techs, from each level's condition strings. */
function requirementsOf(techId: number, levels: Record<string, Wire>, str: (r: Wire | undefined) => string | undefined): TechRequirement[] {
  const seen = new Map<number, TechRequirement>();
  const order = Object.keys(levels).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  for (const lv of order) {
    const row = levels[String(lv)];
    const conds = Array.isArray(row) && Array.isArray(row[3]) ? row[3] : [];
    for (const ref of conds) {
      for (const m of (str(ref) ?? '').matchAll(/(!?)HasTech\((\d+),(\d+)/g)) {
        const other = Number(m[2]);
        if (m[1] || other === techId || seen.has(other)) continue;
        seen.set(other, { techId: other, level: Number(m[3]), atLevel: lv });
      }
    }
  }
  return [...seen.values()];
}

const half = (v: number): number => Math.round(v * 2) / 2 || 0;

/** Turn the static data + client layouts into drawable trees. Pure; unit-tested. */
export function buildTechTrees(version: string, src: TreeSources, layouts: TreeLayout[]): TechTrees {
  const { str, text, vecText } = resolver(src);
  const t21 = src.tables.get(TABLE_TECHS);
  const techs: Record<string, Wire> = isRecord(t21) ? (t21 as Record<string, Wire>) : {};

  const t1 = src.tables.get(TABLE_CLIENT_CONFIG);
  const academy = clientConfig(t1, str, 'academy/branches');
  const heroInfo = clientConfig(t1, str, 'hero_info');
  const talentIds = numList(heroInfo?.branches);
  const tabOf = academyTabs(t1, str, src.en);
  const rank = new Map<number, number>();
  for (const id of [...numList(academy?.order), ...talentIds]) if (!rank.has(id)) rank.set(id, rank.size);

  const layoutOf = new Map(layouts.map((l) => [l.name.toLowerCase(), l]));
  const kindOf = (b: BranchDef): TechTreeKind => {
    if (b.type === 'heroAbility') return talentIds.length === 0 || talentIds.includes(b.id) ? 'talent' : 'other';
    if (b.type === 'clanTalents' || /^clan/i.test(b.tree)) return 'clan';
    return b.type === 'tech' ? 'research' : 'other';
  };

  const trees: TechTree[] = [];
  for (const b of readBranches(src)) {
    const layout = layoutOf.get(b.tree.toLowerCase());
    if (!layout) continue;
    const nodes: TechTreeNode[] = [];
    for (const pos of layout.techs) {
      const row = techs[String(pos.id)];
      if (!Array.isArray(row)) continue;
      const levels = isRecord(row[5]) ? (row[5] as Record<string, Wire>) : {};
      const description = vecText(row[2]) ?? '';
      const icon = str(row[3]) ?? '';
      nodes.push({
        techId: pos.id,
        name: vecText(row[1]) ?? text(row[1]) ?? `#${pos.id}`,
        // Retired techs carry a placeholder description "(!!!)Irrelevant(!!!)".
        description: description.includes('(!!!)') ? '' : description,
        icon: /^[\w-]+$/.test(icon) ? icon : '',
        maxLevel: Object.keys(levels).length,
        col: half(pos.x / COL_UNIT),
        row: half(-pos.y / ROW_UNIT),
        requires: requirementsOf(pos.id, levels, str),
      });
    }
    if (!nodes.length) continue;
    trees.push({
      id: b.id,
      name: b.name || layout.name,
      description: b.description,
      kind: kindOf(b),
      tab: tabOf.get(b.id) ?? null,
      icon: b.visual,
      layout: b.tree,
      nodes,
    });
  }
  trees.sort((a, b) => (rank.get(a.id) ?? 1e6 + a.id) - (rank.get(b.id) ?? 1e6 + b.id));
  return { version, builtAt: new Date().toISOString(), trees };
}

/** A layout TextAsset's JSON, or null when it isn't one. */
export function asTreeLayout(v: unknown): TreeLayout | null {
  if (!isRecord(v) || typeof v.name !== 'string' || !Array.isArray(v.techs)) return null;
  const techs = v.techs
    .filter(isRecord)
    .filter((n) => typeof n.id === 'number' && typeof n.x === 'number' && typeof n.y === 'number')
    .map((n) => ({ id: n.id as number, x: n.x as number, y: n.y as number }));
  return { name: v.name, techs };
}

/**
 * The tree layout a layout bundle holds: its first TextAsset whose text is a
 * layout's JSON (a leading BOM allowed). Read with the art pipeline's Unity
 * reader — the bundle's SerializedFile, by its type tree.
 */
export function layoutFromBundle(bundle: Buffer): TreeLayout | null {
  for (const text of extractTexts(bundle, () => true).values()) {
    let json: unknown;
    try {
      json = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      continue;
    }
    const layout = asTreeLayout(json);
    if (layout) return layout;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

interface TreeVersion {
  /** Directory key — the same one names.json uses (static-data.ts versionKey). */
  dirKey: string;
  version: string;
  files: { strings: string; vectors: string; noDuplicates: string };
  translationsCatalog: string;
  unityCatalog: string;
}

async function fetchTreeVersion(): Promise<TreeVersion> {
  const body = JSON.parse((await fetchBuffer(VERSIONS_URL)).toString('utf8')) as {
    result?: {
      client_static_version?: Record<string, Record<string, string>>;
      client_translations_catalog_version?: string;
      unity_catalog_version?: Record<string, string>;
    };
  };
  const branch = body.result?.client_static_version?.[STATIC_BRANCH];
  const catalog = body.result?.client_translations_catalog_version;
  const unity = body.result?.unity_catalog_version?.[UNITY_PLATFORM];
  if (!branch?.composite_hash || !branch.strings || !branch.vectors || !branch.no_duplicates || !catalog || !unity) {
    throw new Error('versions config is missing the static data, translations or asset catalog entries');
  }
  const dirKey = `${branch.composite_hash.slice(0, 16)}-${catalog.replace(/\.json$/, '')}`;
  return {
    dirKey,
    version: `${dirKey}:${unity}`,
    files: { strings: branch.strings, vectors: branch.vectors, noDuplicates: branch.no_duplicates },
    translationsCatalog: catalog,
    unityCatalog: unity,
  };
}

/** The pool files are a one-element array wrapping the real array. */
function readWrappedArray(buf: Buffer): Wire[] {
  const r = new WireReader(buf);
  if (r.arrayLength() !== 1) throw new Error('expected a wrapped array');
  const n = r.arrayLength();
  const out: Wire[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = r.value();
  return out;
}

/** Decode the requested tables of no_duplicates — arrays too (T1 is one); the rest are skipped unbuilt. */
export function readAnyTables(buf: Buffer, wanted: number[]): Map<number, Wire> {
  const r = new WireReader(buf);
  const count = r.arrayLength();
  const want = new Set(wanted);
  const out = new Map<number, Wire>();
  for (let i = 0; i < count; i++) {
    if (want.has(i)) out.set(i, r.value());
    else r.skip();
  }
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

async function fetchLayouts(unityCatalog: string, names: string[]): Promise<{ layouts: TreeLayout[]; missing: string[] }> {
  const bundleOf = nameIndex(parseCatalog(await fetchBuffer(UNITY_BASE + unityCatalog)));
  const layouts: TreeLayout[] = [];
  const missing: string[] = [];
  const queue = [...new Set(names)];
  const worker = async (): Promise<void> => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      const bundle = bundleOf.get(name.toLowerCase());
      try {
        if (!bundle) throw new Error('not in the asset catalog');
        const layout = layoutFromBundle(await fetchBuffer(UNITY_BASE + bundle));
        if (!layout) throw new Error('bundle holds no tree layout');
        layouts.push({ ...layout, name });
      } catch (err) {
        missing.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { layouts, missing };
}

async function buildFromCdn(v: TreeVersion): Promise<TechTrees> {
  const [stringsBuf, vectorsBuf, tablesBuf, en] = await Promise.all([
    fetchBuffer(STATIC_BASE + v.files.strings),
    fetchBuffer(STATIC_BASE + v.files.vectors),
    fetchBuffer(STATIC_BASE + v.files.noDuplicates),
    fetchEnglish(v.translationsCatalog),
  ]);
  const src: TreeSources = {
    strings: readWrappedArray(stringsBuf),
    vectors: readWrappedArray(vectorsBuf),
    tables: readAnyTables(tablesBuf, NEEDED_TABLES),
    en,
  };
  const branches = readBranches(src);
  if (!branches.length) throw new Error('client config declares no tech trees');
  const { layouts, missing } = await fetchLayouts(v.unityCatalog, branches.map((b) => b.tree));
  if (!layouts.length) throw new Error(`no tree layout could be read: ${missing.slice(0, 3).join('; ')}`);
  if (missing.length) log.warn({ noAlert: true }, `Tech trees without a layout, left out: ${missing.join('; ')}`);
  return buildTechTrees(v.version, src, layouts);
}

// ---------------------------------------------------------------------------
// Cache on the data volume
// ---------------------------------------------------------------------------

const TREES_FILE = 'tech-trees.json';

/** Cache of the game's static data. GAME_STATIC_DIR overrides it for local runs and tools, never needed in prod. */
function staticDir(): string {
  return process.env.GAME_STATIC_DIR ? path.resolve(process.env.GAME_STATIC_DIR) : path.resolve('data', 'game-static');
}

let memo: TechTrees | null = null;
let building: Promise<TechTrees> | null = null;

/**
 * A game version whose trees failed to build. Not rebuilt (~67 MB of
 * downloads) on every page load and scan: retried after FAILED_BUILD_RETRY_MS,
 * the last trees built being served meanwhile.
 */
let failedBuild: { version: string; at: number; error: string } | null = null;
const FAILED_BUILD_RETRY_MS = 30 * 60_000;

/** Lift the retry wait (System → Game Patch → Check now). */
export function clearTechTreesRetry(): void {
  failedBuild = null;
}

/**
 * Trees for the live game version: from memory, else the on-disk cache, else
 * rebuilt from the CDN (~67 MB of static data plus ~25 small layout bundles,
 * once per game patch). Falls back to the newest cached trees when the
 * versions endpoint can't be reached, or when a patch's trees can't be built
 * (a format change in the game's files) — one patch old beats a blank
 * Research tab. Throws only when there are no trees at all.
 */
export async function loadTechTrees(): Promise<TechTrees> {
  let v: TreeVersion;
  try {
    v = await fetchTreeVersion();
  } catch (err) {
    const cached = memo ?? newestCachedTrees();
    if (cached) {
      log.warn({ noAlert: true }, `Game versions endpoint unreachable (${String(err)}); using cached tech trees ${cached.version}.`);
      return cached;
    }
    throw err;
  }
  if (memo?.version === v.version) return memo;
  const file = path.join(staticDir(), v.dirKey, TREES_FILE);
  if (fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as TechTrees;
    if (cached.version === v.version) {
      memo = cached;
      reportReaderOk('trees', v.version);
      return cached;
    }
  }
  if (failedBuild?.version === v.version && Date.now() - failedBuild.at < FAILED_BUILD_RETRY_MS) {
    const cached = memo ?? newestCachedTrees();
    if (cached) return cached;
    throw new Error(failedBuild.error);
  }
  if (!building) {
    building = (async () => {
      log.info(`Building tech trees for ${v.version}`);
      const started = Date.now();
      let trees: TechTrees;
      try {
        trees = await buildFromCdn(v);
      } catch (err) {
        failedBuild = { version: v.version, at: Date.now(), error: String(err) };
        const cached = memo ?? newestCachedTrees();
        reportReaderFailed('trees', v.version, cached?.version ?? null, err);
        if (cached) return cached;
        throw err;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(trees));
      log.info(
        `Tech trees ${v.version} built in ${Math.round((Date.now() - started) / 1000)}s: ${trees.trees.length} trees, ` +
        `${trees.trees.reduce((n, t) => n + t.nodes.length, 0)} nodes`,
      );
      failedBuild = null;
      reportReaderOk('trees', v.version);
      memo = trees;
      return trees;
    })().finally(() => {
      building = null;
    });
  }
  return building;
}

function newestCachedTrees(): TechTrees | null {
  const dir = staticDir();
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .map((d) => path.join(dir, d, TREES_FILE))
    .filter((f) => fs.existsSync(f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ? (JSON.parse(fs.readFileSync(files[0], 'utf8')) as TechTrees) : null;
}

/**
 * The trees already in hand, without any network: memory, else the newest file
 * on disk, else null. For synchronous readers (troop tiers in the guards
 * estimator) — the scan keeps them current by calling loadTechTrees().
 */
export function cachedTechTrees(): TechTrees | null {
  if (!memo) memo = newestCachedTrees();
  return memo;
}

/** Test seam. */
export function resetTechTreesMemo(): void {
  memo = null;
  failedBuild = null;
}
