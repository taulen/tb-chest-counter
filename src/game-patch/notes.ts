/**
 * Patch notes: what each game patch added, revealed, renamed and changed, for
 * Tools → What's new (every member) — read from the game's own files the
 * moment the patch is read (watch.ts runs `notePatchSafely` after the readers).
 *
 * A patch is a move of the names version (static data + translations: the
 * data, the trees, the texts) and/or the art catalogue (the pictures) since
 * the last one noted. The diffs are notes-diff.ts; what a kind of data is
 * called and pictured is notes-sections.ts. An art move within
 * AMEND_WINDOW_MS of a noted patch amends it (the art reader often lands a
 * few minutes after the data); later it is a patch of its own.
 *
 * Kept in data/game-patch-notes/ (GAME_PATCH_NOTES_DIR overrides it):
 * index.json (what was noted last, a summary per patch) and <id>.json per
 * patch — history, the newest MAX_PATCHES. The first run on a volume notes
 * the newest patch against the one before it on disk, if any.
 *
 * The texts are read from the CDN for both catalogues (it keeps old ones), in
 * English whole and the four other site languages for the keys that changed.
 * When it no longer has the old one, the notes go without texts (textsError).
 * See docs/game-patches.md → "What's new".
 */
import fs from 'fs';
import path from 'path';
import { childLogger } from '../utils/logger.js';
import { resolveEntries } from '../utils/log-buffer.js';
import { safeArtName } from '../game-art/selection.js';
import { readPatchStatus } from './status.js';
import {
  NOTE_LANGS,
  PATCH_NOTES_FORMAT,
  artNamesByStem,
  artTextKeys,
  assembleTexts,
  claimedArt,
  textsOf,
  type ArtGroup,
  diffArtNames,
  diffSections,
  diffTrees,
  planKeys,
  planTexts,
  summarizeNotes,
  techsShownByTrees,
  type LangTexts,
  type NoteLang,
  type PatchNotes,
  type PatchSummary,
  type TreeSnapshot,
} from './notes-diff.js';
import { sectionOrder, type SectionCtx } from './notes-sections.js';

const log = childLogger('game-patch');

export const MAX_PATCHES = 60;
const AMEND_WINDOW_MS = 48 * 3600_000;
const RETRY_MS = 30 * 60_000;
const ID_RE = /^[a-z0-9-]{1,64}$/;
const VERSION_DIR_RE = /^[0-9a-z-]{8,80}$/i;
export const NOTES_WARNING_KEY = 'game-patch:notes';

export function notesDir(): string {
  return process.env.GAME_PATCH_NOTES_DIR ? path.resolve(process.env.GAME_PATCH_NOTES_DIR) : path.resolve('data', 'game-patch-notes');
}
function defaultStaticDir(): string {
  return process.env.GAME_STATIC_DIR ? path.resolve(process.env.GAME_STATIC_DIR) : path.resolve('data', 'game-static');
}
function defaultArtDir(): string {
  return process.env.GAME_ART_DIR ? path.resolve(process.env.GAME_ART_DIR) : path.resolve('data', 'game-art');
}

export interface NotesIndex {
  format: number;
  /** The names version and art catalogue last noted (the next patch's "from"). */
  names: string | null;
  art: string | null;
  /** Newest first. */
  patches: PatchSummary[];
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function readNotesIndex(dir: string = notesDir()): NotesIndex | null {
  const idx = readJson<NotesIndex>(path.join(dir, 'index.json'));
  return idx && Array.isArray(idx.patches) ? idx : null;
}

export function readPatchNotes(id: string, dir: string = notesDir()): PatchNotes | null {
  if (!ID_RE.test(id)) return null;
  const notes = readJson<PatchNotes>(path.join(dir, `${id}.json`));
  return notes && notes.id === id ? notes : null;
}

// ---------------------------------------------------------------------------
// Noting a patch
// ---------------------------------------------------------------------------

type FetchTexts = (catalog: string, lang: NoteLang, keep?: ReadonlySet<string>) => Promise<Map<string, string>>;

export interface NotePatchDeps {
  /** The versions now read (default: the readers' status, when each read its live version). */
  current?: { names: string | null; art: string | null };
  staticDir?: string;
  artDir?: string;
  notesDir?: string;
  fetchTexts?: FetchTexts;
  catalogOf?: (namesKey: string) => string | null;
  now?: () => Date;
  /** Chest names the site stores, with their record counts (a renamed chest's old name). */
  storedChests?: (names: string[]) => Map<string, number>;
}

export interface NotePatchResult {
  status: 'unchanged' | 'baseline' | 'noted' | 'amended';
  id?: string;
}

/** The versions the readers read their live patch from; null where one serves an older patch or none. */
function currentVersions(): { names: string | null; art: string | null } {
  const s = readPatchStatus();
  const read = (r: 'names' | 'art'): string | null => {
    const st = s.readers[r];
    return st?.ok && st.served && st.served === st.live ? st.served : null;
  };
  return { names: read('names'), art: read('art') };
}

/** names.json's builtAt without parsing its 2 MB. */
function builtAtOf(file: string): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(300);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return /"builtAt":"([^"]+)"/.exec(buf.subarray(0, n).toString('utf8'))?.[1] ?? null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The names version on disk read just before `current` (the first run's "from"). */
function previousNamesOnDisk(dir: string, current: string): string | null {
  const mine = builtAtOf(path.join(dir, current, 'names.json'));
  let best: { key: string; at: string } | null = null;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const key of entries) {
    if (key === current || !VERSION_DIR_RE.test(key)) continue;
    const at = builtAtOf(path.join(dir, key, 'names.json'));
    if (!at || (mine && at >= mine)) continue;
    if (!best || at > best.at) best = { key, at };
  }
  return best?.key ?? null;
}

/** The art catalogue served before `current` (the art store's state). */
function previousArtOnDisk(dir: string, current: string): string | null {
  const st = readJson<{ current?: string; previous?: string | null }>(path.join(dir, 'state.json'));
  if (!st) return null;
  if (st.current === current) return st.previous ?? null;
  return st.current ?? null;
}

function readLines(file: string): string[] | null {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.length > 1 ? lines : null;
  } catch {
    return null;
  }
}

async function defaultFetchTexts(catalog: string, lang: NoteLang, keep?: ReadonlySet<string>): Promise<Map<string, string>> {
  const { fetchCatalogTexts } = await import('../game-protocol/static-data.js');
  return fetchCatalogTexts(catalog, lang, keep);
}

async function defaultCatalogOf(key: string): Promise<string | null> {
  const { catalogOfNamesKey } = await import('../game-protocol/static-data.js');
  return catalogOfNamesKey(key);
}

interface BuildInput {
  id: string;
  date: string;
  names: { from: string; to: string } | null;
  art: { from: string; to: string } | null;
  /** The names version whose texts describe the pictures when the names didn't move (an art-only patch). */
  textsKey?: string | null;
}

/** The art index's mappings and the static slice's icons, for picture names. */
function sectionCtx(artDir: string, artVersion: string | null, artStatic: Record<string, unknown> | null): SectionCtx {
  const index = artVersion ? readJson<{ mappings?: Record<string, unknown> }>(path.join(artDir, artVersion, 'index.json')) : null;
  const itemIcons = new Map<string, string>();
  for (const it of (artStatic?.items as Array<{ id: number; icon: string }> | undefined) ?? []) {
    if (it?.icon && !itemIcons.has(String(it.id))) itemIcons.set(String(it.id), safeArtName(it.icon));
  }
  const techIcons = new Map<string, string>();
  for (const [id, t] of Object.entries((artStatic?.techs as Record<string, { icon?: string }> | undefined) ?? {})) {
    if (t?.icon) techIcons.set(id, safeArtName(t.icon));
  }
  return { mappings: index?.mappings ?? {}, itemIcons, techIcons };
}

/**
 * The texts part: what changed between two catalogues (when they differ), and
 * the game's texts about each new picture (`images`, filled in place) from
 * the newer one — an art-only patch passes the current names key twice.
 */
async function readTexts(
  from: string,
  to: string,
  deps: Required<Pick<NotePatchDeps, 'fetchTexts'>> & { catalogOf: (k: string) => Promise<string | null> | string | null },
  images: ArtGroup[],
): Promise<Pick<PatchNotes, 'guides' | 'texts' | 'textsTruncated' | 'textsError'>> {
  const [a, b] = await Promise.all([deps.catalogOf(from), deps.catalogOf(to)]);
  if (!b) return { guides: [], texts: [] };
  const compare = !!a && a !== b;
  if (!compare && !images.length) return { guides: [], texts: [] };
  try {
    const [prevEn, nextEn] = await Promise.all([compare ? deps.fetchTexts(a!, 'en') : null, deps.fetchTexts(b, 'en')]);
    const plan = prevEn ? planTexts(prevEn, nextEn) : null;
    const keys = plan ? planKeys(plan) : { next: new Set<string>(), prev: new Set<string>() };
    const about = artTextKeys(images, nextEn);
    for (const list of about.values()) for (const k of list) keys.next.add(k);
    const next = new Map<NoteLang, Map<string, string>>([['en', nextEn]]);
    const prev = new Map<NoteLang, Map<string, string>>(prevEn ? [['en', prevEn]] : []);
    for (const lang of NOTE_LANGS) {
      if (lang === 'en') continue;
      // A language that can't be read shows English: never the whole note lost.
      const [n, p] = await Promise.all([
        keys.next.size ? deps.fetchTexts(b, lang, keys.next).catch(() => null) : null,
        compare && keys.prev.size ? deps.fetchTexts(a!, lang, keys.prev).catch(() => null) : null,
      ]);
      if (n) next.set(lang, n);
      if (p) prev.set(lang, p);
    }
    for (const g of images) {
      const list = about.get(g.stem);
      if (list) g.about = { ...g.about, texts: list.map((k) => textsOf(k, next)) };
    }
    if (!plan) return { guides: [], texts: [] };
    const { guides, texts } = assembleTexts(plan, next, prev);
    return { guides, texts, ...(plan.truncated ? { textsTruncated: plan.truncated } : {}) };
  } catch (err) {
    return compare ? { guides: [], texts: [], textsError: err instanceof Error ? err.message : String(err) } : { guides: [], texts: [] };
  }
}

export async function buildPatchNotes(input: BuildInput, deps: NotePatchDeps = {}): Promise<PatchNotes> {
  const staticDir = deps.staticDir ?? defaultStaticDir();
  const artDir = deps.artDir ?? defaultArtDir();
  const n = input.names;
  const json = (dir: string, ...p: string[]): Record<string, unknown> | null => readJson<Record<string, unknown>>(path.join(dir, ...p));
  const prevNames = n ? json(staticDir, n.from, 'names.json') : null;
  const nextNames = n ? json(staticDir, n.to, 'names.json') : null;
  const prevStatic = n ? json(artDir, `static-${n.from}.json`) : null;
  const nextStatic = n ? json(artDir, `static-${n.to}.json`) : null;
  const prevTrees = n ? readJson<{ trees: TreeSnapshot[] }>(path.join(staticDir, n.from, 'tech-trees.json')) : null;
  const nextTrees = n ? readJson<{ trees: TreeSnapshot[] }>(path.join(staticDir, n.to, 'tech-trees.json')) : null;
  if (n && !nextNames) throw new Error(`no names.json for ${n.to}`);

  const artVersion = input.art?.to ?? readJson<{ current?: string }>(path.join(artDir, 'state.json'))?.current ?? null;
  const ctx = sectionCtx(artDir, artVersion, nextStatic);
  const trees = diffTrees(prevTrees, nextTrees, prevNames?.techs ? new Set(Object.keys(prevNames.techs as object)) : undefined);
  const sections = [
    ...(nextNames ? diffSections(prevNames, nextNames, 'names', ctx, new Map([['techs', techsShownByTrees(trees)]])) : []),
    ...(nextStatic ? diffSections(prevStatic, nextStatic, 'art', ctx) : []),
  ].sort((x, y) => sectionOrder(x.source, x.key) - sectionOrder(y.source, y.key) || x.key.localeCompare(y.key));

  const images = input.art
    ? diffArtNames(
      readLines(path.join(artDir, input.art.from, 'catalog-names.txt')),
      readLines(path.join(artDir, input.art.to, 'catalog-names.txt')) ?? [],
      claimedArt(sections, trees, safeArtName),
    )
    : [];
  // What the game's data calls each new picture (an item, a city look…).
  const textsKey = n?.to ?? input.textsKey ?? null;
  const slice = nextStatic ?? (textsKey ? json(artDir, `static-${textsKey}.json`) : null);
  const namesByStem = artNamesByStem(slice, safeArtName);
  for (const g of images) {
    const named = namesByStem.get(g.stem);
    if (named?.length) g.about = { names: named.slice(0, 4) };
  }

  const texts = textsKey
    ? await readTexts(n?.from ?? textsKey, textsKey, {
      fetchTexts: deps.fetchTexts ?? defaultFetchTexts,
      catalogOf: deps.catalogOf ?? defaultCatalogOf,
    }, images)
    : { guides: [], texts: [] };

  return {
    format: PATCH_NOTES_FORMAT,
    id: input.id,
    date: input.date,
    names: input.names,
    art: input.art,
    sections,
    trees,
    ...texts,
    images,
  };
}

function patchId(date: string, version: string): string {
  return `${date.slice(0, 10)}-${version.replace(/[^0-9a-z]/gi, '').slice(0, 8)}`.toLowerCase();
}

function isEmpty(n: PatchNotes): boolean {
  return !n.sections.length && !n.trees.length && !n.guides.length && !n.texts.length && !n.images.length;
}

/** A renamed chest whose old name the site stores: its records need folding (docs/chest-identity.md). */
function warnStoredRenames(notes: PatchNotes, deps: NotePatchDeps): void {
  const renamed = notes.sections.find((s) => s.key === 'gifts')?.entries.filter((e) => e.kind === 'renamed' && e.was) ?? [];
  if (!renamed.length || !deps.storedChests) return;
  let stored: Map<string, number>;
  try {
    stored = deps.storedChests(renamed.map((e) => e.was!));
  } catch {
    return;
  }
  for (const e of renamed) {
    const count = stored.get(e.was!) ?? 0;
    if (!count) continue;
    log.warn(
      `Game patch renamed the chest "${e.was}" to "${e.name}"; ${count} record(s) are stored under "${e.was}". ` +
      'New ones arrive under the new name: fold the old row with a migration (docs/chest-identity.md).',
    );
  }
}

/**
 * Note the patch the readers just read, if it is new. Returns what it did;
 * throws when the notes could not be built (notePatchSafely reports it).
 */
export async function notePatch(deps: NotePatchDeps = {}): Promise<NotePatchResult> {
  const dir = deps.notesDir ?? notesDir();
  const staticDir = deps.staticDir ?? defaultStaticDir();
  const artDir = deps.artDir ?? defaultArtDir();
  const now = (deps.now ?? (() => new Date()))();
  const cur = deps.current ?? currentVersions();
  const idx = readNotesIndex(dir);
  const fromNames = idx ? idx.names : cur.names ? previousNamesOnDisk(staticDir, cur.names) : null;
  const fromArt = idx ? idx.art : cur.art ? previousArtOnDisk(artDir, cur.art) : null;
  const namesMoved = !!cur.names && !!fromNames && cur.names !== fromNames;
  const artMoved = !!cur.art && !!fromArt && cur.art !== fromArt;
  const base: NotesIndex = idx ?? { format: PATCH_NOTES_FORMAT, names: null, art: null, patches: [] };
  const remember = (patches: PatchSummary[]): void => {
    writeJsonAtomic(path.join(dir, 'index.json'), {
      ...base,
      names: cur.names ?? base.names,
      art: cur.art ?? base.art,
      patches,
    });
  };

  if (!namesMoved && !artMoved) {
    // Nothing to compare against yet (a fresh volume): start from here.
    if (!idx || (cur.names && !idx.names) || (cur.art && !idx.art)) {
      remember(base.patches);
      return { status: 'baseline' };
    }
    return { status: 'unchanged' };
  }

  // The art landing after the data of the same patch: amend that patch.
  const latest = base.patches[0];
  const latestNotes = latest ? readPatchNotes(latest.id, dir) : null;
  if (!namesMoved && artMoved && latestNotes && now.getTime() - Date.parse(latestNotes.date) < AMEND_WINDOW_MS) {
    const notes = await buildPatchNotes({
      id: latestNotes.id,
      date: latestNotes.date,
      names: latestNotes.names,
      art: { from: latestNotes.art?.from ?? fromArt!, to: cur.art! },
      textsKey: cur.names ?? base.names,
    }, { ...deps, staticDir, artDir });
    writeJsonAtomic(path.join(dir, `${notes.id}.json`), notes);
    remember([summarizeNotes(notes), ...base.patches.slice(1)]);
    log.info(`Game patch notes ${notes.id}: amended with the art catalogue ${cur.art}.`);
    return { status: 'amended', id: notes.id };
  }

  const date = namesMoved ? (builtAtOf(path.join(staticDir, cur.names!, 'names.json')) ?? now.toISOString()) : now.toISOString();
  // On a fresh volume the newest patch was read a while ago: date it by when it was.
  const when = idx ? now.toISOString() : date;
  let id = patchId(when, (namesMoved ? cur.names : cur.art) ?? 'patch');
  if (base.patches.some((p) => p.id === id)) id = `${id}-${base.patches.length}`;
  const notes = await buildPatchNotes({
    id,
    date: when,
    names: namesMoved ? { from: fromNames!, to: cur.names! } : null,
    art: artMoved ? { from: fromArt!, to: cur.art! } : null,
    textsKey: cur.names ?? base.names,
  }, { ...deps, staticDir, artDir });
  if (isEmpty(notes)) {
    remember(base.patches);
    log.info(`Game patch ${id}: nothing new to show (the version moved, the content didn't).`);
    return { status: 'unchanged' };
  }
  writeJsonAtomic(path.join(dir, `${notes.id}.json`), notes);
  const patches = [summarizeNotes(notes), ...base.patches];
  for (const old of patches.splice(MAX_PATCHES)) {
    try {
      fs.rmSync(path.join(dir, `${old.id}.json`), { force: true });
    } catch {
      // a file that won't go stays; the index no longer lists it
    }
  }
  remember(patches);
  warnStoredRenames(notes, deps);
  const s = summarizeNotes(notes);
  log.info(
    `Game patch notes ${notes.id}: ${Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(', ')}` +
    (s.highlights.length ? ` — ${s.highlights.map((h) => h.name).join(', ')}` : '') +
    (notes.textsError ? ` (texts: ${notes.textsError})` : ''),
  );
  return { status: 'noted', id: notes.id };
}

let failed: { at: number } | null = null;

/**
 * notePatch for the watcher: never throws; a failure is one alerting warning
 * (cleared when notes next build) and a retry after RETRY_MS, or at once with `force`.
 */
export async function notePatchSafely(opts: { force?: boolean } = {}): Promise<NotePatchResult | null> {
  if (failed && !opts.force && Date.now() - failed.at < RETRY_MS) return null;
  try {
    // Imported lazily: the watcher's module graph stays free of the database.
    const { getDb } = await import('../data/database.js');
    // The chest names the site stores, with their record counts.
    const storedChests = (names: string[]): Map<string, number> => {
      if (!names.length) return new Map();
      const rows = getDb().prepare(
        `SELECT c.name AS name, COUNT(r.id) AS n FROM chests c JOIN chest_records r ON r.chest_id = c.id
         WHERE c.name IN (${names.map(() => '?').join(',')}) GROUP BY c.name`,
      ).all(...names) as Array<{ name: string; n: number }>;
      return new Map(rows.map((r) => [r.name, r.n]));
    };
    const result = await notePatch({ storedChests });
    if (failed) resolveEntries(NOTES_WARNING_KEY);
    failed = null;
    return result;
  } catch (err) {
    const first = !failed;
    failed = { at: Date.now() };
    if (first) {
      log.warn(
        { resolveKey: NOTES_WARNING_KEY },
        `Game patch notes (Tools → What's new) couldn't be built: ${err instanceof Error ? err.message : String(err)}. ` +
        'Retried every 30 minutes; docs/game-patches.md.',
      );
    }
    return null;
  }
}

/** Test seam. */
export function resetPatchNotesMemo(): void {
  failed = null;
  viewMemo.clear();
}

// ---------------------------------------------------------------------------
// The page's view: picture names to URLs, texts in the reader's language
// ---------------------------------------------------------------------------

interface ArtIndexLike {
  version: string;
  images: Record<string, { file: string; w: number; h: number }>;
  mappings?: object;
}

/** URL of a picture the current art has; quiet about holes (these names are guesses, not requests). */
function artUrl(index: ArtIndexLike | null, name: string | undefined): string | null {
  if (!index || !name) return null;
  const img = index.images[name];
  return img ? `/game-art/${index.version}/${img.file}` : null;
}

const firstUrl = (index: ArtIndexLike | null, names: string[] | undefined): string | null => {
  for (const n of names ?? []) {
    const u = artUrl(index, n);
    if (u) return u;
  }
  return null;
};

function pickLang(t: LangTexts | undefined, lang: NoteLang): LangTexts | undefined {
  if (!t) return undefined;
  const out: LangTexts = {};
  if (t.en !== undefined) out.en = t.en;
  if (lang !== 'en' && t[lang] !== undefined) out[lang] = t[lang];
  return out;
}

const viewMemo = new Map<string, unknown>();

/** Every patch noted, newest first. */
export function patchList(dir: string = notesDir()): PatchSummary[] {
  return readNotesIndex(dir)?.patches ?? [];
}

/**
 * One patch's notes as the page reads them: each picture name resolved to the
 * current art's URL (or dropped), texts cut to English + `lang`.
 */
export function patchNotesView(id: string, lang: NoteLang, art: ArtIndexLike | null, dir: string = notesDir()): unknown | null {
  const key = `${dir}|${id}|${lang}|${art?.version ?? ''}`;
  if (viewMemo.has(key)) return viewMemo.get(key);
  const n = readPatchNotes(id, dir);
  if (!n) return null;
  const techIcons = ((art?.mappings as { techs?: Record<string, string> } | undefined)?.techs ?? {});
  const nodeIcon = <T extends { techId: number; icon?: string }>(node: T): T & { iconUrl: string | null } => ({
    ...node,
    iconUrl: artUrl(art, techIcons[String(node.techId)] ?? (node.icon ? safeArtName(node.icon) : undefined)),
  });
  const view = {
    id: n.id,
    date: n.date,
    sections: n.sections.map((s) => ({
      key: s.key,
      source: s.source,
      entries: s.entries.map(({ icon, art: big, layers, ...e }) => ({
        ...e,
        iconUrl: firstUrl(art, icon),
        artUrl: firstUrl(art, big),
        backUrl: artUrl(art, layers?.back),
        frameUrl: artUrl(art, layers?.frame),
      })),
    })),
    trees: n.trees.map((t) => ({
      ...t,
      tree: {
        ...t.tree,
        iconUrl: t.tree.icon ? artUrl(art, safeArtName(t.tree.icon)) : null,
        nodes: t.tree.nodes.map(nodeIcon),
        unplaced: (t.tree.unplaced ?? []).map(nodeIcon),
      },
    })),
    guides: n.guides.map((g) => ({
      key: g.key,
      title: pickLang(g.title, lang),
      parts: g.parts.map((p) => ({ title: pickLang(p.title, lang), texts: p.texts.map((x) => pickLang(x, lang)) })),
    })),
    texts: n.texts.map((g) => ({
      key: g.key,
      title: pickLang(g.title, lang),
      added: g.added.map((x) => ({ key: x.key, text: pickLang(x.text, lang) })),
      changed: g.changed.map((x) => ({ key: x.key, text: pickLang(x.text, lang), was: pickLang(x.was, lang) })),
      removed: g.removed.map((x) => ({ key: x.key, text: pickLang(x.text, lang) })),
    })),
    textsTruncated: n.textsTruncated ?? 0,
    textsUnavailable: !!n.textsError,
    images: n.images
      .map((g) => {
        const pics = g.names
          .map((name) => ({ name, img: art?.images[name] }))
          .filter((p): p is { name: string; img: { file: string; w: number; h: number } } => !!p.img)
          .sort((a, b) => b.img.w * b.img.h - a.img.w * a.img.h)
          .slice(0, 4)
          .map((p) => ({ name: p.name, url: `/game-art/${art!.version}/${p.img.file}`, w: p.img.w, h: p.img.h }));
        const about = g.about
          ? { names: g.about.names ?? [], texts: (g.about.texts ?? []).map((x) => pickLang(x, lang)) }
          : null;
        return { stem: g.stem, names: g.names, pictures: pics, about };
      }),
  };
  viewMemo.set(key, view);
  if (viewMemo.size > 50) viewMemo.delete(viewMemo.keys().next().value as string);
  return view;
}
