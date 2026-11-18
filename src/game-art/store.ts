/**
 * Game art on the data volume, per game version:
 *
 *   data/game-art/state.json                  { current, previous }
 *   data/game-art/<catalogVersion>/index.json  see GameArtIndex
 *   data/game-art/<catalogVersion>/<name>.png
 *   data/game-art/static-<staticVersion>.json  icon slice of the static data (art-static.ts)
 *
 * ensureGameArt() checks the live catalogue version and, when it changed,
 * downloads only the bundles the selection needs (selection.ts), extracts their
 * images into a temp dir and renames it into place when complete. An image
 * whose bundle hash is unchanged since the previous version is copied instead
 * of downloaded. It never throws: a failed run logs and leaves the served
 * version alone. Only the current and previous versions are kept.
 *
 * The unit-icon frames (category `ui`) are not in the catalogue: they come
 * from the WebGL client build (webgl-client.ts, one ~43 MB download per client
 * build, reused across catalogue versions while the build is unchanged). They
 * are optional — when they cannot be read the troop icons show unframed and
 * the rest of the art is unaffected.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { childLogger } from '../utils/logger.js';
import { createCoalescedWarner } from '../utils/log-throttle.js';
import { parseCatalog, catalogVersionFromConfig, VERSIONS_URL, UNITY_BASE, type CatalogEntry } from './catalog.js';
import { isUnityFs } from './unityfs.js';
import { extractImages, extractTexts, pickImages } from './extract.js';
import { cutAtlasRegion, parseSpineAtlas } from './spine.js';
import { encodePng } from './png.js';
import { selectArt, safeArtName, ART_CATEGORIES, SPINE_REGIONS, LIBRARY_MAX_SIDE, type ArtCategory } from './selection.js';
import { loadArtStatic, type ArtStatic } from './art-static.js';
import {
  avatarFrameImageFrom,
  buildMappings,
  heroAvatarImageFrom,
  loadTroopList,
  type ArtMappings,
  type TroopStats,
} from './mappings.js';
import { clientUiTextures, itemFrameArt, unitFrameArt } from './unit-frames.js';
import { extractClientTextures, webglClientVersionFromConfig, webglDataUrl } from './webgl-client.js';

const log = childLogger('game-art');
/** Daily check failures repeat with the same cause; one line per 6 h is plenty. */
const warner = createCoalescedWarner((m) => log.warn({ noAlert: true }, m), 6 * 60 * 60 * 1000);

export interface GameArtImage {
  w: number;
  h: number;
  file: string;
  category: ArtCategory;
  /**
   * The bundle it came from; lets the next version reuse it when unchanged.
   * `client:<build>` for the WebGL client's UI art.
   */
  bundle: string;
}

/**
 * What we extract changes when we start using a new kind of image (2: captain
 * portraits; 3: the Ancients artifacts and boss; 4: unit-icon frames from the
 * WebGL client; 5: captains' artifacts and equipment; 6: clan logo layers,
 * medal and ranking icons, every item icon; 7: captains' full-body art
 * (`_scaled`) and their tile pieces; 8: the Hall of Fame's faction windows
 * and crests; 9: the Dragon's icons, frame and pictures; 10: item tiles — the
 * quality-coloured item backs and the item frame from the WebGL client, for
 * the chest rewards; 11: titles' round icons and pictures (T29), for the
 * profile header; 12: every tree's picture (T1 branches), every sprite name
 * names.json carries (`named`) and every UI icon in the catalogue (`icons`,
 * ~2,600 small images) — extract before a page needs it — Nov 2026). Bump this with
 * every change to the selection or mappings: an index built with an older one
 * is re-extracted on the next run — reusing every image it already has, so only
 * the new bundles download — instead of waiting for a game patch.
 */
export const ART_SELECTION_VERSION = 12;

export interface GameArtIndex {
  /** The catalogue hash; also the URL version segment. */
  version: string;
  /** ART_SELECTION_VERSION the images were selected with (absent = 1). */
  selection?: number;
  builtAt: string;
  /** Static data the mappings were computed from. */
  staticVersion: string | null;
  /** WebGL client build the `ui` images came from; null/absent = none read (yet). */
  client?: string | null;
  /** Keyed by image name (= file name without .png). */
  images: Record<string, GameArtImage>;
  mappings: ArtMappings;
  stats: { bundles: number; downloaded: number; reused: number; bytes: number; failed: number; seconds: number; optionalFailed?: number; skipped?: number };
  /**
   * Selected addresses whose bundle could not be DOWNLOADED this run (a CDN
   * hiccup). The next run with the same art and selection rebuilds — reusing
   * every image — to fetch just these, instead of keeping the hole until the
   * next game patch.
   */
  retry?: string[];
  /**
   * Selected addresses that are not to be had: the bundle holds no picture by
   * that name, or (`icons` catch-all) it is bigger than LIBRARY_MAX_SIDE. A
   * rebuild doesn't download their bundles again for them.
   */
  skipped?: string[];
}

interface StateFile {
  current: string;
  previous: string | null;
}

export const VERSION_RE = /^[0-9a-f]{32}$/;
export const FILE_RE = /^[a-z0-9_-]{1,128}\.png$/;

export function gameArtDir(): string {
  // GAME_ART_DIR: local runs and tools only; prod keeps data/game-art on the volume.
  return process.env.GAME_ART_DIR ? path.resolve(process.env.GAME_ART_DIR) : path.resolve('data', 'game-art');
}

// ---------------------------------------------------------------------------
// Reading (routes, mappings)
// ---------------------------------------------------------------------------

const stateMemo = new Map<string, StateFile | null>();
const indexMemo = new Map<string, GameArtIndex | null>();

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function readState(dir: string = gameArtDir()): StateFile | null {
  if (stateMemo.has(dir)) return stateMemo.get(dir) ?? null;
  let state: StateFile | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as Partial<StateFile>;
    if (typeof raw.current === 'string' && VERSION_RE.test(raw.current)) {
      state = {
        current: raw.current,
        previous: typeof raw.previous === 'string' && VERSION_RE.test(raw.previous) ? raw.previous : null,
      };
    }
  } catch {
    state = null;
  }
  stateMemo.set(dir, state);
  return state;
}

export function loadIndex(dir: string, version: string): GameArtIndex | null {
  if (!VERSION_RE.test(version)) return null;
  const key = `${dir}\0${version}`;
  if (indexMemo.has(key)) return indexMemo.get(key) ?? null;
  let index: GameArtIndex | null = null;
  try {
    index = JSON.parse(fs.readFileSync(path.join(dir, version, 'index.json'), 'utf8')) as GameArtIndex;
    if (index.version !== version || !index.images) index = null;
  } catch {
    index = null;
  }
  indexMemo.set(key, index);
  return index;
}

/** Forget cached state (after an update, or in tests). */
export function resetGameArtMemo(): void {
  stateMemo.clear();
  indexMemo.clear();
}

/** The versions the route serves: current and previous. */
export function servedVersions(dir: string = gameArtDir()): Set<string> {
  const s = readState(dir);
  const out = new Set<string>();
  if (s?.current) out.add(s.current);
  if (s?.previous) out.add(s.previous);
  return out;
}

export function currentGameArt(dir: string = gameArtDir()): GameArtIndex | null {
  const s = readState(dir);
  return s ? loadIndex(dir, s.current) : null;
}

/** URL of an image of the current version, or null (and a hole noted: noteMissingArt). */
export function gameArtUrl(name: string, dir: string = gameArtDir()): string | null {
  const index = currentGameArt(dir);
  const img = index?.images[name];
  if (index && !img && name) noteMissingArt(index.version, name, dir);
  return index && img ? `/game-art/${index.version}/${img.file}` : null;
}

/** Per version: every address the catalogue listed (safeArtName), written by the run. */
export const CATALOG_NAMES_FILE = 'catalog-names.txt';
// One line per minute at most: a page asks for many pictures at once, and each
// name is only ever reported once per art version (missingSeen), so batching
// keeps the warning buffer to a line per burst; the coalescer's window
// matches, so a batch is never swallowed into a "repeated" summary.
const MISSING_FLUSH_MS = 60_000;
const missingSeen = new Set<string>();
const missingPending = new Map<string, Set<string>>();
let missingTimer: ReturnType<typeof setTimeout> | null = null;
const catalogNames = new Map<string, Set<string> | null>();
const missingWarner = createCoalescedWarner((m) => log.warn({ noAlert: true }, m), MISSING_FLUSH_MS);

function catalogHas(dir: string, version: string, name: string): boolean | null {
  const key = `${dir}|${version}`;
  if (!catalogNames.has(key)) {
    try {
      catalogNames.set(key, new Set(fs.readFileSync(path.join(dir, version, CATALOG_NAMES_FILE), 'utf8').split('\n')));
    } catch {
      catalogNames.set(key, null); // an index built before the list was written
    }
  }
  const names = catalogNames.get(key);
  return names ? names.has(name) : null;
}

/**
 * A page asked for a picture the current art doesn't have: a hole. Logged
 * once per name per art version, batched into one informational line a minute (a page asks for many at once), saying whether the game's catalogue
 * lists it — "listed" means the selection should take it (selection.ts),
 * "not listed" that the game has no such picture by that name.
 */
export function noteMissingArt(version: string, name: string, dir: string = gameArtDir()): void {
  const key = `${version}|${name}`;
  if (missingSeen.has(key)) return;
  missingSeen.add(key);
  if (!missingPending.has(version)) missingPending.set(version, new Set());
  missingPending.get(version)!.add(name);
  if (missingTimer) return;
  missingTimer = setTimeout(() => {
    missingTimer = null;
    for (const [v, names] of missingPending) {
      const listed: string[] = [];
      const unlisted: string[] = [];
      const unknown: string[] = [];
      for (const n of names) {
        const has = catalogHas(dir, v, n);
        (has === null ? unknown : has ? listed : unlisted).push(n);
      }
      const part = (label: string, list: string[]): string =>
        list.length ? `${label} ${list.length} (${list.slice(0, 12).join(', ')}${list.length > 12 ? ', …' : ''})` : '';
      missingWarner.warn(`missing:${v}`, `Game art ${v}: asked for pictures it hasn't got — ` + [
        part('in the catalogue, not selected:', listed),
        part('not in the catalogue:', unlisted),
        part('catalogue unknown:', unknown),
      ].filter(Boolean).join('; '));
    }
    missingPending.clear();
  }, MISSING_FLUSH_MS);
  missingTimer.unref?.();
}

/** Forget noted holes (tests). */
export function resetMissingArtForTests(): void {
  missingSeen.clear();
  missingPending.clear();
  catalogNames.clear();
  if (missingTimer) clearTimeout(missingTimer);
  missingTimer = null;
}

/** The portrait image name for a player's heroAvatar (game_players.hero_avatar), or null. */
export function heroAvatarImage(heroAvatar: number | null | undefined, dir: string = gameArtDir()): string | null {
  return heroAvatarImageFrom(currentGameArt(dir)?.mappings ?? null, heroAvatar);
}

/** The frame image for a player's portrait (game_players.avatar_frame; the game's default when unknown), or null. */
export function avatarFrameImage(frameId: number | null | undefined, dir: string = gameArtDir()): string | null {
  return avatarFrameImageFrom(currentGameArt(dir)?.mappings ?? null, frameId);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface EnsureGameArtOptions {
  dir?: string;
  fetchImpl?: typeof fetch;
  loadStatic?: (dir: string) => Promise<ArtStatic>;
  loadTroops?: () => Promise<TroopStats[]>;
  /** names.json (static-data.ts loadGameNames); every sprite name in it is selected (`named`). */
  loadNames?: () => Promise<unknown>;
  /** Names of the app's resource types (resource_types.name). */
  resourceNames?: () => string[];
  concurrency?: number;
}

export interface EnsureGameArtResult {
  status: 'unchanged' | 'updated' | 'remapped' | 'failed';
  version: string | null;
  images?: number;
  error?: string;
}

const DEFAULT_CONCURRENCY = 6;
const BUNDLE_TIMEOUT_MS = 60_000;
const CATALOG_TIMEOUT_MS = 120_000;
/** A run with more failed bundles than this share is thrown away. */
const MAX_FAILED_SHARE = 0.2;

let inFlight: Promise<EnsureGameArtResult> | null = null;

/**
 * Bring the art up to the live game version. Never throws; concurrent calls
 * share one run.
 */
export function ensureGameArt(opts: EnsureGameArtOptions = {}): Promise<EnsureGameArtResult> {
  if (inFlight) return inFlight;
  inFlight = runEnsure(opts)
    .catch((err: unknown): EnsureGameArtResult => {
      const msg = err instanceof Error ? err.message : String(err);
      warner.warn(`fail:${msg}`, `Game art update failed, keeping the served version: ${msg}`);
      return { status: 'failed', version: readState(opts.dir ?? gameArtDir())?.current ?? null, error: msg };
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function fetchBuffer(fetchImpl: typeof fetch, url: string, timeoutMs: number, attempts = 3): Promise<Buffer> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function defaultResourceNames(): Promise<string[]> {
  try {
    // Imported lazily so the art modules don't pull the database in with them.
    const repo = await import('../data/repositories/resource-repo.js');
    return repo.listResourceTypes().map((t) => t.name);
  } catch {
    return [];
  }
}

async function runEnsure(opts: EnsureGameArtOptions): Promise<EnsureGameArtResult> {
  const dir = opts.dir ?? gameArtDir();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();
  fs.mkdirSync(dir, { recursive: true });

  const config = JSON.parse((await fetchBuffer(fetchImpl, VERSIONS_URL, 30_000)).toString('utf8')) as unknown;
  const version = catalogVersionFromConfig(config);
  let client: string | null = null;
  try {
    client = webglClientVersionFromConfig(config);
  } catch {
    client = null; // no frames this run; everything else proceeds
  }
  const state = readState(dir);
  const resourceNames = new Set((opts.resourceNames ? opts.resourceNames() : await defaultResourceNames()).map((n) => n.toLowerCase()));
  const loadStatic = opts.loadStatic ?? loadArtStatic;

  const current = state?.current === version ? loadIndex(dir, version) : null;
  // Same art but an older selection: rebuild, reusing what this version has.
  // A run that couldn't download some bundles left a retry list: rebuild
  // (reusing every image) to fill those holes instead of keeping them.
  const existing = current && (current.selection ?? 1) >= ART_SELECTION_VERSION && !current.retry?.length ? current : null;
  if (existing) {
    // Same art. The static data may still have moved on (a new tech, a renamed
    // chest): recompute the mappings over the images we have.
    let st: ArtStatic | null = null;
    try {
      st = await loadStatic(dir);
    } catch {
      st = null;
    }
    // Frames this version has not got yet (the client download failed last
    // time): add them in place. Only new file names are written, so nothing
    // already served changes under its immutable URL.
    let frames: UnitFrames | null = null;
    if (!existing.client && client) {
      try {
        frames = await collectUnitFrames(fetchImpl, client, path.join(dir, version), null, null, existing.images);
      } catch (err) {
        warner.warn('ui', `Game art ${version}: unit frames unavailable, troop icons stay unframed (${errText(err)})`);
      }
    }
    const staticMoved = !!st && st.version !== existing.staticVersion;
    if (!frames && !staticMoved) return { status: 'unchanged', version };
    const images = { ...existing.images, ...(frames?.images ?? {}) };
    const has = (n: string): boolean => n in images;
    const mappings = st
      ? buildMappings(st, await loadTroops(opts), resourceNames, has)
      : { ...existing.mappings, unitFrames: unitFrameArt(has), itemFrames: itemFrameArt(has) };
    const updated: GameArtIndex = {
      ...existing,
      images,
      staticVersion: st?.version ?? existing.staticVersion,
      client: frames?.client ?? existing.client ?? null,
      mappings,
    };
    writeJsonAtomic(path.join(dir, version, 'index.json'), updated);
    resetGameArtMemo();
    log.info(
      `Game art ${version}: ` +
      (frames ? `${Object.keys(frames.images).length} unit frames added from client ${frames.client}` : '') +
      (frames && staticMoved ? '; ' : '') +
      (staticMoved ? `mappings recomputed for static data ${st!.version}` : ''),
    );
    return { status: 'remapped', version, images: Object.keys(images).length };
  }

  const catalogBuf = await fetchBuffer(fetchImpl, UNITY_BASE + version, CATALOG_TIMEOUT_MS);
  const catalog = parseCatalog(catalogBuf);
  const st = await loadStatic(dir);
  const troops = await loadTroops(opts);
  const addresses: string[] = [];
  for (const e of catalog) addresses.push(...e.addresses);
  const names = await loadNames(opts);
  const selected = selectArt(addresses, st, resourceNames, names);

  // address → bundle (first listing wins), then bundle → wanted addresses
  const bundleOf = new Map<string, CatalogEntry>();
  for (const e of catalog) for (const a of e.addresses) if (!bundleOf.has(a)) bundleOf.set(a, e);
  const work = new Map<string, Map<string, ArtCategory>>();
  for (const [addr, cat] of selected) {
    const e = bundleOf.get(addr);
    if (!e) continue;
    if (!work.has(e.bundle)) work.set(e.bundle, new Map());
    work.get(e.bundle)!.set(addr, cat);
  }

  const prevVersion = state?.current && state.current !== version ? state.current : (current ? version : null);
  const prev = prevVersion ? loadIndex(dir, prevVersion) : null;
  const tmp = path.join(dir, `.tmp-${version}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });

  const images: Record<string, GameArtImage> = {};
  // Failures of bundles with a picture the app shows: too many abort the run.
  const failures: string[] = [];
  // The catch-alls (`named`, `icons`) are best effort: a failure there is
  // counted, retried next run when it was the download, never fatal.
  const optionalFailures: string[] = [];
  const retry: string[] = [];
  const skipped = new Set<string>();
  const prevSkipped = new Set(prev?.skipped ?? []);
  let downloaded = 0;
  let reused = 0;
  let bytes = 0;

  const processBundle = async (bundle: string, wanted: Map<string, ArtCategory>): Promise<void> => {
    // Unchanged bundle: copy the previous version's PNGs.
    if (prev && prevVersion) {
      const covered = [...wanted.keys()].filter((a) => prev.images[safeArtName(a)]?.bundle === bundle || prevSkipped.has(a));
      if (covered.length === wanted.size) {
        for (const [addr, cat] of wanted) {
          const name = safeArtName(addr);
          const old = prev.images[name];
          if (!old) {
            skipped.add(addr);
            continue;
          }
          fs.copyFileSync(path.join(dir, prevVersion, old.file), path.join(tmp, old.file));
          images[name] = { ...old, category: cat };
        }
        reused++;
        return;
      }
    }
    let buf: Buffer;
    try {
      buf = await fetchBuffer(fetchImpl, UNITY_BASE + bundle, BUNDLE_TIMEOUT_MS);
    } catch (err) {
      retry.push(...wanted.keys());
      throw err;
    }
    downloaded++;
    bytes += buf.length;
    if (!isUnityFs(buf)) throw new Error('not a UnityFS bundle');
    const { images: found, errors } = extractImages(buf, (n) => wanted.has(n.toLowerCase()));
    const picked = pickImages(found);
    if (!picked.length) {
      for (const a of wanted.keys()) skipped.add(a);
      throw new Error(errors[0] ?? 'no matching image in bundle');
    }
    // A Spine animation's picture is one region of its texture (spine.ts).
    const spine = [...wanted.keys()].filter((a) => SPINE_REGIONS.has(a));
    const atlases = spine.length
      ? extractTexts(buf, (n) => spine.includes(n.toLowerCase().replace(/\.atlas$/, '')) && /\.atlas$/i.test(n))
      : new Map<string, string>();
    for (const img of picked) {
      const addr = img.name.toLowerCase();
      const cat = wanted.get(addr);
      const name = safeArtName(addr);
      if (!cat || images[name]) continue;
      // The `icons` catch-all keeps icons, not the odd big picture named like one.
      if (cat === 'icons' && Math.max(img.image.width, img.image.height) > LIBRARY_MAX_SIDE) {
        skipped.add(addr);
        continue;
      }
      let pixels = img.image;
      const region = SPINE_REGIONS.get(addr);
      if (region) {
        const text = [...atlases].find(([n]) => n.toLowerCase() === `${addr}.atlas`)?.[1];
        const cut = text ? cutAtlasRegion(img.image, parseSpineAtlas(text), region) : null;
        if (!cut) {
          failures.push(`${bundle}: no "${region}" region in ${addr}.atlas`);
          continue;
        }
        pixels = cut;
      }
      const file = `${name}.png`;
      fs.writeFileSync(path.join(tmp, file), await encodePng(pixels));
      images[name] = { w: pixels.width, h: pixels.height, file, category: cat, bundle };
    }
  };

  const queue = [...work.entries()];
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        await processBundle(next[0], next[1]);
      } catch (err) {
        const optional = [...next[1].values()].every((c) => c === 'named' || c === 'icons');
        (optional ? optionalFailures : failures).push(`${next[0]}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  await Promise.all(workers);

  const total = work.size;
  const required = [...work.values()].filter((w) => [...w.values()].some((c) => c !== 'named' && c !== 'icons')).length;
  if (!Object.keys(images).length || failures.length > Math.max(10, required * MAX_FAILED_SHARE)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`${failures.length} of ${total} bundles failed (e.g. ${failures[0] ?? 'no images'})`);
  }

  // The unit-icon frames, from the client build: reused while the build is
  // unchanged; when it cannot be read, the previous version's frames are kept.
  const prevDir = prev && prevVersion ? path.join(dir, prevVersion) : null;
  let frames: UnitFrames | null = null;
  if (client) {
    try {
      frames = await collectUnitFrames(fetchImpl, client, tmp, prev, prevDir, {});
    } catch (err) {
      warner.warn('ui', `Game art ${version}: unit frames unavailable from client ${client} (${errText(err)})`);
    }
  }
  if (!frames && prev?.client && prevDir) frames = copyUnitFrames(prev, prevDir, tmp);
  Object.assign(images, frames?.images ?? {});

  const has = (n: string): boolean => n in images;
  const seconds = Math.round((Date.now() - started) / 1000);
  const index: GameArtIndex = {
    version,
    selection: ART_SELECTION_VERSION,
    builtAt: new Date().toISOString(),
    staticVersion: st.version,
    client: frames?.client ?? null,
    images: Object.fromEntries(Object.entries(images).sort(([a], [b]) => a.localeCompare(b))),
    mappings: buildMappings(st, troops, resourceNames, has),
    stats: { bundles: total, downloaded, reused, bytes, failed: failures.length, seconds, optionalFailed: optionalFailures.length, skipped: skipped.size },
    ...(retry.length ? { retry: [...new Set(retry)].sort() } : {}),
    ...(skipped.size ? { skipped: [...skipped].sort() } : {}),
  };
  writeJsonAtomic(path.join(tmp, 'index.json'), index);
  // Every address the catalogue lists, so a miss can say whether the game has
  // the picture at all (noteMissingArt). Not served: FILE_RE takes .png only.
  fs.writeFileSync(path.join(tmp, CATALOG_NAMES_FILE), [...new Set(addresses.map(safeArtName))].sort().join('\n'));

  const finalDir = path.join(dir, version);
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.renameSync(tmp, finalDir);
  const previous = state ? (state.current !== version ? state.current : state.previous) : null;
  writeJsonAtomic(path.join(dir, 'state.json'), { current: version, previous } satisfies StateFile);
  resetGameArtMemo();
  pruneVersions(dir, new Set([version, previous].filter((v): v is string => !!v)));

  const perCat = ART_CATEGORIES.map((c) => `${c} ${Object.values(images).filter((i) => i.category === c).length}`).join(', ');
  const troopIcons = Object.values(index.mappings.troops);
  const framed = Object.entries(index.mappings.troops)
    .filter(([id, icon]) => icon && index.mappings.unitFrames[String(index.mappings.troopTiers[id])]).length;
  log.info(
    `Game art ${version}: ${Object.keys(images).length} images (${perCat}) from ${total} bundles ` +
    `(${downloaded} downloaded, ${reused} reused), ${(bytes / 1048576).toFixed(1)} MB in ${seconds}s; ` +
    `${failures.length} failed, ${optionalFailures.length} catch-all bundle(s) without a usable picture, ${skipped.size} skipped, ` +
    `${retry.length ? `${new Set(retry).size} to retry next run, ` : ''}troop icons ${troopIcons.filter(Boolean).length}/${troopIcons.length}, ` +
    `framed ${framed} (client ${frames?.client ?? 'none'}${frames?.downloaded ? ', downloaded' : ''})`,
  );
  if (failures.length) {
    warner.warn('bundles', `Game art ${version}: ${failures.length} bundle(s) failed, e.g. ${failures.slice(0, 3).join('; ')}`);
  }
  return { status: 'updated', version, images: Object.keys(images).length };
}

/** names.json for the `named` catch-all; null (nothing named) when it can't be had. */
async function loadNames(opts: EnsureGameArtOptions): Promise<unknown> {
  try {
    if (opts.loadNames) return await opts.loadNames();
    // Imported lazily: static-data pulls the protocol codec and its caches in.
    const { loadGameNames } = await import('../game-protocol/static-data.js');
    return await loadGameNames();
  } catch (err) {
    warner.warn('names', `Game art: names.json unavailable, nothing selected by name this run (${errText(err)})`);
    return null;
  }
}

async function loadTroops(opts: EnsureGameArtOptions): Promise<TroopStats[]> {
  try {
    return await (opts.loadTroops ?? loadTroopList)();
  } catch (err) {
    warner.warn('troops', `Game art: troop list unavailable, no troop icon mapping (${String(err)})`);
    return [];
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The client data file is one ~43 MB download (brotli; ~69 MB once decoded). */
const CLIENT_TIMEOUT_MS = 300_000;

interface UnitFrames {
  images: Record<string, GameArtImage>;
  client: string;
  downloaded: boolean;
}

/**
 * The unit-icon frames of client build `client` as PNGs in `outDir`: copied
 * from the previous version when it read the same build, else extracted from
 * the build's data file. Names in `skip` are never written (adding frames to a
 * live version only ever adds files). Throws when the build yields none.
 */
async function collectUnitFrames(
  fetchImpl: typeof fetch,
  client: string,
  outDir: string,
  prev: GameArtIndex | null,
  prevDir: string | null,
  skip: Record<string, GameArtImage>,
): Promise<UnitFrames> {
  const wanted = clientUiTextures();
  if (prev && prevDir && prev.client === client && wanted.every((w) => prev.images[safeArtName(w)])) {
    const copied = copyUnitFrames(prev, prevDir, outDir);
    if (copied) return copied;
  }
  const names = new Set(wanted);
  const { images: found, errors } = extractClientTextures(
    await fetchBuffer(fetchImpl, webglDataUrl(client), CLIENT_TIMEOUT_MS, 2),
    (n) => names.has(n),
  );
  if (!found.length) throw new Error(errors[0] ?? 'no unit frame textures in the client build');
  const images: Record<string, GameArtImage> = {};
  for (const img of found) {
    const name = safeArtName(img.name);
    if (images[name] || skip[name]) continue;
    const file = `${name}.png`;
    fs.writeFileSync(path.join(outDir, file), await encodePng(img.image));
    images[name] = { w: img.image.width, h: img.image.height, file, category: 'ui', bundle: `client:${client}` };
  }
  if (errors.length) {
    warner.warn('ui-textures', `Game art: ${errors.length} unit frame texture(s) unreadable in client ${client}, e.g. ${errors[0]}`);
  }
  return { images, client, downloaded: true };
}

/** The previous version's unit frames, copied into `outDir` (null when it has none). */
function copyUnitFrames(prev: GameArtIndex, prevDir: string, outDir: string): UnitFrames | null {
  if (!prev.client) return null;
  const images: Record<string, GameArtImage> = {};
  for (const [name, img] of Object.entries(prev.images)) {
    if (img.category !== 'ui') continue;
    try {
      fs.copyFileSync(path.join(prevDir, img.file), path.join(outDir, img.file));
      images[name] = img;
    } catch {
      // a file gone from the previous version: that frame is missing, nothing more
    }
  }
  return Object.keys(images).length ? { images, client: prev.client, downloaded: false } : null;
}

/** Remove version dirs other than `keep`, and temp dirs left by a crashed run. */
function pruneVersions(dir: string, keep: Set<string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const stale = (VERSION_RE.test(entry.name) && !keep.has(entry.name)) || entry.name.startsWith('.tmp-');
    if (!stale) continue;
    try {
      fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    } catch (err) {
      warner.warn(`prune:${entry.name}`, `Game art: could not remove ${entry.name} (${String(err)})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let dailyTimer: ReturnType<typeof setInterval> | null = null;

/** Check shortly after startup, then every 24 h. Non-blocking; timers don't hold the process. */
export function startGameArtSchedule(initialDelayMs = 30_000, intervalMs = DAY_MS): void {
  if (firstTimer || dailyTimer) return;
  const run = (): void => {
    void ensureGameArt();
  };
  firstTimer = setTimeout(run, initialDelayMs);
  firstTimer.unref?.();
  dailyTimer = setInterval(run, intervalMs);
  dailyTimer.unref?.();
}

export function stopGameArtSchedule(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (dailyTimer) clearInterval(dailyTimer);
  firstTimer = null;
  dailyTimer = null;
}

