/**
 * The patch notes' diffs — pure: two versions of the game's files in, what
 * changed out. game-patch/notes.ts reads the files and stores the result;
 * Tools → What's new shows it. Four parts:
 *
 *   sections  every kind of game data (notes-sections.ts): added, revealed
 *             (a placeholder given its real name), renamed, changed, removed
 *   trees     research trees: new ones whole (drawn as the game draws them),
 *             grown ones with their new nodes
 *   texts     every text of the game's translation catalogue, grouped by
 *             feature, and its help windows as readable guides — UI text
 *             ships before the feature does, so this is where a coming
 *             feature shows first
 *   images    what the art catalogue added, grouped by picture
 */
import { IGNORED_KEYS, sectionDef, sectionOrder, type SectionCtx, type SectionDef, type SectionSource, type ValueLine } from './notes-sections.js';

/** Bump when what a note holds changes: an index of an older format is noted afresh (the newest patch against the one before it). */
export const PATCH_NOTES_FORMAT = 3;
export const NOTE_LANGS = ['en', 'de', 'es', 'fr', 'ru'] as const;
export type NoteLang = (typeof NOTE_LANGS)[number];
export type LangTexts = Partial<Record<NoteLang, string>>;

export type ChangeKind = 'added' | 'revealed' | 'renamed' | 'changed' | 'removed';
const KIND_ORDER: Record<ChangeKind, number> = { added: 0, revealed: 1, renamed: 2, changed: 3, removed: 4 };

export interface ValueChange {
  at?: string;
  text: string;
  was: string | null;
  now: string | null;
}

export interface NoteEntry {
  id: string;
  kind: ChangeKind;
  /** The game's name (English; tGame on display). '' = it has none yet. */
  name: string;
  /** The name before (revealed, renamed). */
  was?: string;
  /** The name is an untranslated text key ("item.name.clan_duel_point"): the game hasn't written it yet. */
  unnamed?: boolean;
  /** Every id under this name (groupByName sections), when more than one. */
  ids?: string[];
  sub?: string;
  /** Picture names, best first. */
  icon?: string[];
  /** Big picture names for the drill-down, best first. */
  art?: string[];
  layers?: { back?: string; frame?: string };
  detail?: Record<string, unknown>;
  changes?: ValueChange[];
  /** Changes beyond the ones kept in `changes`. */
  moreChanges?: number;
}

export interface NoteSection {
  key: string;
  source: SectionSource;
  entries: NoteEntry[];
}

export interface TreeNode {
  techId: number;
  name: string;
  description?: string;
  icon?: string;
  maxLevel: number;
  col: number;
  row: number;
  requires?: Array<{ techId: number; level: number; atLevel?: number }>;
}

export interface TreeSnapshot {
  id: number;
  name: string;
  description?: string;
  kind: string;
  tab?: string | null;
  icon?: string;
  layout?: string;
  nodes: TreeNode[];
  /** Research of the tree the game doesn't draw yet (tech-trees.ts). */
  unplaced?: Array<Omit<TreeNode, 'col' | 'row'>>;
}

export interface TreeNote {
  kind: 'added' | 'grown' | 'removed';
  tree: TreeSnapshot;
  /** Nodes the tree didn't have (all of them for a new tree). */
  newNodes: number[];
  /** Nodes whose max level moved. */
  raised: Array<{ techId: number; was: number; now: number }>;
  /** The tree's name before, when it changed. */
  was?: string;
}

export interface TextNote {
  key: string;
  text: LangTexts;
  was?: LangTexts;
}

export interface TextGroup {
  key: string;
  /** The feature's own title, when the game has one (its window's header). */
  title?: LangTexts;
  added: TextNote[];
  changed: TextNote[];
  removed: TextNote[];
}

export interface GuidePart {
  title?: LangTexts;
  texts: LangTexts[];
}

export interface GuideNote {
  /** The help window's id ("pvp_ladder_3v3"). */
  key: string;
  title?: LangTexts;
  parts: GuidePart[];
}

export interface ArtGroup {
  stem: string;
  names: string[];
  /** What the game says about the picture, when anything names it (artNamesByStem, artTextKeys). */
  about?: { names?: string[]; texts?: LangTexts[] };
}

export interface PatchNotes {
  format: number;
  id: string;
  /** When this patch was first read (ISO). */
  date: string;
  names: { from: string; to: string } | null;
  art: { from: string; to: string } | null;
  sections: NoteSection[];
  trees: TreeNote[];
  guides: GuideNote[];
  texts: TextGroup[];
  /** Texts left out past MAX_TEXTS. */
  textsTruncated?: number;
  /** Why the texts couldn't be compared (the CDN no longer had a catalogue). */
  textsError?: string;
  images: ArtGroup[];
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** Changes kept per entry; the rest are counted. */
export const MAX_CHANGES = 12;
const MAX_LINES = 20_000;

/** An id map's keys are ids: "17146", "1037,4". Anything else is one object (the Dragon, the Hall of Fame). */
function isIdMap(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => /^-?\d+(?:,-?\d+)*$/.test(k));
}

/** An untranslated text key standing in for a name ("item.name.mod_roulette_4_progress"). */
export function looksLikeKey(name: string): boolean {
  return /^[a-z0-9_]+(?:\.[a-z0-9_%]+)+$/i.test(name) && !/\s/.test(name);
}

/** Every leaf of a value, by path; a [text, value] pair is one line named by its text. */
export function flattenLines(v: unknown, at = '', out: ValueLine[] = []): ValueLine[] {
  if (out.length >= MAX_LINES) return out;
  if (v === null || v === undefined) return out;
  if (typeof v !== 'object') {
    out.push({ at: at || undefined, text: '', value: String(v) });
    return out;
  }
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && (v[1] === null || typeof v[1] !== 'object')) {
    out.push({ at: at || undefined, text: v[0], value: String(v[1] ?? '') });
    return out;
  }
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
  for (const [k, x] of entries) flattenLines(x, at ? `${at} › ${k}` : k, out);
  return out;
}

/** A value as compared: "+30,0%" and "+30%" are the same number, a formatting change is no change. */
export function normalizeValue(s: string): string {
  return s
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/\d+(?:\.\d+)?/g, (m) => String(Number(m)))
    .replace(/\s+/g, ' ')
    .trim();
}

function lineKey(l: ValueLine, seen: Map<string, number>): string {
  const base = `${l.at ?? ''}\u0000${l.text}`;
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}\u0000${n}` : base;
}

/** What moved between two values of one entry, formatting aside. */
export function valueChanges(def: SectionDef, a: unknown, b: unknown): { changes: ValueChange[]; more: number } {
  const linesOf = (v: unknown): Map<string, ValueLine> => {
    const seen = new Map<string, number>();
    const lines = def.lines ? def.lines(v) : flattenLines(v);
    return new Map(lines.map((l) => [lineKey(l, seen), l]));
  };
  const la = linesOf(a);
  const lb = linesOf(b);
  const all: ValueChange[] = [];
  for (const k of new Set([...la.keys(), ...lb.keys()])) {
    const x = la.get(k);
    const y = lb.get(k);
    if (x && y && normalizeValue(x.value) === normalizeValue(y.value)) continue;
    if (!x && y && !y.value) continue;
    if (x && !y && !x.value) continue;
    const l = (y ?? x)!;
    all.push({ at: l.at, text: l.text, was: x ? x.value : null, now: y ? y.value : null });
  }
  // A value that moved says the most, then a line the entry gained, then one it lost.
  const rank = (c: ValueChange): number => (c.was !== null && c.now !== null ? 0 : c.now !== null ? 1 : 2);
  const sorted = all.map((c, i) => ({ c, i })).sort((p, q) => rank(p.c) - rank(q.c) || p.i - q.i).map((p) => p.c);
  return { changes: sorted.slice(0, MAX_CHANGES), more: Math.max(0, sorted.length - MAX_CHANGES) };
}

const pictures = (list: Array<string | null | undefined> | undefined): string[] | undefined => {
  const out = [...new Set((list ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0))];
  return out.length ? out : undefined;
};

function entryOf(def: SectionDef, kind: ChangeKind, id: string, v: unknown, ctx: SectionCtx): NoteEntry {
  const name = def.name(v, id).trim();
  const e: NoteEntry = { id, kind, name };
  if (looksLikeKey(name)) e.unnamed = true;
  const sub = def.sub?.(v, id);
  if (sub) e.sub = sub;
  const icon = pictures(def.icon?.(v, id, ctx));
  if (icon) e.icon = icon;
  const art = pictures(def.art?.(v, id, ctx));
  if (art) e.art = art;
  const layers = def.layers?.(v, id, ctx);
  if (layers && (layers.back || layers.frame)) e.layers = layers;
  const detail = def.detail?.(v, id);
  if (detail) e.detail = Object.fromEntries(Object.entries(detail).filter(([, x]) => x !== undefined && x !== null && x !== ''));
  return e;
}

/** Entries of one kind and name fold into one when the section groups by name. */
function groupByName(entries: NoteEntry[]): NoteEntry[] {
  const out: NoteEntry[] = [];
  const byKey = new Map<string, NoteEntry>();
  for (const e of entries) {
    // A renamed group shares its old name too; revealed placeholders differ in theirs ("item.name.x_4", "_5").
    const key = `${e.kind}\u0000${e.name}\u0000${e.kind === 'renamed' ? e.was ?? '' : ''}`;
    const first = byKey.get(key);
    if (!first || !e.name) {
      byKey.set(key, e);
      out.push(e);
      continue;
    }
    first.ids = [...(first.ids ?? [first.id]), e.id];
    if (!first.icon && e.icon) first.icon = e.icon;
    if (e.changes?.length && (first.changes?.length ?? 0) < MAX_CHANGES) {
      const room = MAX_CHANGES - (first.changes?.length ?? 0);
      first.changes = [...(first.changes ?? []), ...e.changes.slice(0, room)];
      first.moreChanges = (first.moreChanges ?? 0) + Math.max(0, e.changes.length - room) + (e.moreChanges ?? 0);
    }
  }
  return out;
}

function diffIdMap(
  def: SectionDef,
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
  ctx: SectionCtx,
  skip: ReadonlySet<string> | undefined,
): NoteEntry[] {
  const before = a ?? {};
  const after = b ?? {};
  const prevNames = new Map<string, number>();
  for (const [id, v] of Object.entries(before)) {
    const n = def.name(v, id).trim();
    prevNames.set(n, (prevNames.get(n) ?? 0) + 1);
  }
  const entries: NoteEntry[] = [];
  for (const [id, v] of Object.entries(after)) {
    if (skip?.has(id)) continue;
    if (def.keep && !def.keep(v, id)) continue;
    if (!(id in before)) {
      const e = entryOf(def, 'added', id, v, ctx);
      // Nothing to show for a row with neither a name nor a picture.
      if (e.name || e.icon) entries.push(e);
      continue;
    }
    const old = before[id];
    if (JSON.stringify(old) === JSON.stringify(v)) continue;
    const name = def.name(v, id).trim();
    const was = def.name(old, id).trim();
    const { changes, more } = valueChanges(def, old, v);
    if (was !== name) {
      // A placeholder given its real name: blank, an untranslated key, or a
      // name the game had stamped on several ids at once ("Artemisia" ×5).
      const revealed = !was || looksLikeKey(was) || (prevNames.get(was) ?? 0) > 1;
      const e = entryOf(def, revealed ? 'revealed' : 'renamed', id, v, ctx);
      e.was = was;
      if (changes.length && !revealed) {
        e.changes = changes;
        if (more) e.moreChanges = more;
      }
      if (e.name || e.icon) entries.push(e);
      continue;
    }
    if (!changes.length) continue;
    const e = entryOf(def, 'changed', id, v, ctx);
    e.changes = changes;
    if (more) e.moreChanges = more;
    entries.push(e);
  }
  for (const [id, v] of Object.entries(before)) {
    if (id in after || skip?.has(id)) continue;
    if (def.keep && !def.keep(v, id)) continue;
    const e = entryOf(def, 'removed', id, v, ctx);
    if (e.name) entries.push(e);
  }
  const grouped = def.groupByName ? groupByName(entries) : entries;
  return grouped.sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.name.localeCompare(y.name) || x.id.localeCompare(y.id, undefined, { numeric: true }));
}

/**
 * Every section of one source that changed. `skip` leaves ids out per key
 * (techs the research trees already show).
 */
export function diffSections(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
  source: SectionSource,
  ctx: SectionCtx,
  skip: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): NoteSection[] {
  if (!prev) return [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)].filter((k) => !IGNORED_KEYS[source].has(k)));
  const out: NoteSection[] = [];
  for (const key of keys) {
    const def = sectionDef(source, key);
    const a = (def.values ? def.values(prev as Record<string, never>) : prev[key]) as unknown;
    const b = (def.values ? def.values(next as Record<string, never>) : next[key]) as unknown;
    if (a === undefined || b === undefined) continue; // a kind this side doesn't carry: not a change
    let entries: NoteEntry[];
    if (isIdMap(a) || isIdMap(b)) {
      entries = diffIdMap(def, isIdMap(a) ? a : {}, isIdMap(b) ? b : {}, ctx, skip.get(key));
    } else {
      // One object (the Dragon's levels): one "changed" entry when it moved.
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      const { changes, more } = valueChanges(def, a, b);
      if (!changes.length) continue;
      entries = [{ id: key, kind: 'changed', name: '', changes, ...(more ? { moreChanges: more } : {}) }];
    }
    if (entries.length) out.push({ key, source, entries });
  }
  return out.sort((x, y) => sectionOrder(x.source, x.key) - sectionOrder(y.source, y.key) || x.key.localeCompare(y.key));
}

// ---------------------------------------------------------------------------
// Research trees
// ---------------------------------------------------------------------------

/**
 * `known`: every tech id the previous patch had (its names.json techs). A
 * tree's research the old file didn't list as the tree's — an older
 * tech-trees.json kept no unplaced research — is new only if the old data
 * lacked the tech altogether.
 */
export function diffTrees(prev: { trees: TreeSnapshot[] } | null, next: { trees: TreeSnapshot[] } | null, known?: ReadonlySet<string>): TreeNote[] {
  if (!prev || !next) return [];
  const before = new Map(prev.trees.map((t) => [t.id, t]));
  const after = new Set(next.trees.map((t) => t.id));
  const all = (t: TreeSnapshot): Array<Omit<TreeNode, 'col' | 'row'>> => [...t.nodes, ...(t.unplaced ?? [])];
  const out: TreeNote[] = [];
  for (const tree of next.trees) {
    const old = before.get(tree.id);
    if (!old) {
      if (all(tree).length) out.push({ kind: 'added', tree, newNodes: all(tree).map((n) => n.techId), raised: [] });
      continue;
    }
    const oldNodes = new Map(all(old).map((n) => [n.techId, n]));
    const newNodes = all(tree)
      .filter((n) => !oldNodes.has(n.techId) && !known?.has(String(n.techId)))
      .map((n) => n.techId);
    const raised = all(tree)
      .filter((n) => oldNodes.has(n.techId) && oldNodes.get(n.techId)!.maxLevel !== n.maxLevel)
      .map((n) => ({ techId: n.techId, was: oldNodes.get(n.techId)!.maxLevel, now: n.maxLevel }));
    const renamed = old.name !== tree.name;
    if (newNodes.length || raised.length || renamed) {
      out.push({ kind: 'grown', tree, newNodes, raised, ...(renamed ? { was: old.name } : {}) });
    }
  }
  for (const old of prev.trees) {
    if (!after.has(old.id) && all(old).length) out.push({ kind: 'removed', tree: old, newNodes: [], raised: [] });
  }
  const order = { added: 0, grown: 1, removed: 2 };
  return out.sort((x, y) => order[x.kind] - order[y.kind] || x.tree.id - y.tree.id);
}

/** Techs the tree notes show, so the Research section doesn't list them twice. */
export function techsShownByTrees(trees: TreeNote[]): Set<string> {
  const out = new Set<string>();
  for (const t of trees) for (const id of t.newNodes) out.add(String(id));
  return out;
}

// ---------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------

/** Texts kept per patch (all languages of one key count once). */
export const MAX_TEXTS = 3000;
const HELP_PREFIX = 'client_config.value.help.windows.';
/** Key segments that only say where a text lives, not what it is about. */
const NAMESPACES = new Set(['client', 'client_config', 'value', 'global_tournament', 'client_info', 'help', 'windows']);
/** Groups of names of many features at once: no single title fits them. */
const MIXED_GROUPS = new Set(['', 'help', 'tech', 'item', 'customization', 'titles', 'equipment', 'artifact', 'captain']);

/** The feature a text is about: its first segment past the namespaces ('' for a one-word key). */
export function textGroupKey(key: string): string {
  const segs = key.split('.');
  if (segs.length === 1) return '';
  let i = 0;
  while (i < segs.length - 1 && NAMESPACES.has(segs[i])) i++;
  return segs[i];
}

/** The key's segments up to and including its group's (where the feature's other texts live). */
function groupPrefix(key: string): string {
  const segs = key.split('.');
  let i = 0;
  while (i < segs.length - 1 && NAMESPACES.has(segs[i])) i++;
  return segs.slice(0, i + 1).join('.');
}

export interface TextPlan {
  added: string[];
  changed: string[];
  removed: string[];
  truncated: number;
  /** Help window → its added keys (a guide). */
  guides: Map<string, string[]>;
  /** Guide → its title key; guide part → its title key (keys of the full catalogue). */
  guideTitles: Map<string, string>;
  /** Group → its keys, and the title key the catalogue has for it. */
  groups: Map<string, { added: string[]; changed: string[]; removed: string[]; titleKey?: string }>;
}

/** A title the group's own window shows: short, no placeholders, no markup. */
const usableTitle = (text: string | undefined): boolean => !!text && text.length <= 48 && !/[%<]/.test(text) && text.trim().length > 1;

/**
 * The group's own title: only its window's (`<feature>.title`,
 * `.header.title`, `.window.title`, `.info.title`, `.name`). A title deeper
 * down names one part of it — booster_categories' "Shield of Peace" is one
 * category among many (Nov 26 2026) — so none is better than that.
 */
function findGroupTitle(prefixes: Set<string>, en: ReadonlyMap<string, string>): string | undefined {
  for (const suffix of ['header.title', 'window.title', 'info.title', 'title', 'name']) {
    for (const p of prefixes) {
      const k = `${p}.${suffix}`;
      if (usableTitle(en.get(k))) return k;
    }
  }
  return undefined;
}

/**
 * A text as compared: its words, not its punctuation, spacing or case — a
 * full stop added ("5 times" → "5 times."), "Lv.%level%" → "Lv. %level%" is
 * no change worth listing.
 */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/<[^>]*>/g, '').replace(/\\n/g, ' ').replace(/[^\p{L}\p{N}%]+/gu, '');
}

/** What changed between two English catalogues, and which keys each part needs in every language. */
export function planTexts(prevEn: ReadonlyMap<string, string>, nextEn: ReadonlyMap<string, string>): TextPlan {
  let added = [...nextEn.keys()].filter((k) => !prevEn.has(k));
  let changed = [...nextEn.keys()].filter((k) => prevEn.has(k) && normalizeText(prevEn.get(k)!) !== normalizeText(nextEn.get(k)!));
  let removed = [...prevEn.keys()].filter((k) => !nextEn.has(k));
  const total = added.length + changed.length + removed.length;
  let truncated = 0;
  if (total > MAX_TEXTS) {
    // Keep new texts first: they are what a coming feature looks like.
    const keepAdded = Math.min(added.length, MAX_TEXTS);
    const keepChanged = Math.min(changed.length, MAX_TEXTS - keepAdded);
    const keepRemoved = Math.min(removed.length, MAX_TEXTS - keepAdded - keepChanged);
    added = added.sort().slice(0, keepAdded);
    changed = changed.sort().slice(0, keepChanged);
    removed = removed.sort().slice(0, keepRemoved);
    truncated = total - MAX_TEXTS;
  }

  // Help windows with new texts become guides; a window that only gained its
  // title (a Battle Pass captain's name) stays a plain text.
  const byWindow = new Map<string, string[]>();
  for (const k of added) {
    if (!k.startsWith(HELP_PREFIX)) continue;
    const win = k.slice(HELP_PREFIX.length).split('.')[0];
    if (!win) continue;
    if (!byWindow.has(win)) byWindow.set(win, []);
    byWindow.get(win)!.push(k);
  }
  const guides = new Map<string, string[]>();
  const guideTitles = new Map<string, string>();
  for (const [win, keys] of byWindow) {
    if (!keys.some((k) => !/\.title$/.test(k))) continue;
    guides.set(win, keys.sort());
    const titleKey = `${HELP_PREFIX}${win}.title`;
    if (nextEn.has(titleKey)) guideTitles.set(win, titleKey);
    for (const k of keys) {
      const part = k.slice(HELP_PREFIX.length + win.length + 1).split('.').slice(0, -1).join('.');
      if (!part) continue;
      const partTitle = `${HELP_PREFIX}${win}.${part}.title`;
      if (nextEn.has(partTitle)) guideTitles.set(`${win}.${part}`, partTitle);
    }
  }
  const inGuide = new Set([...guides.values()].flat());

  const groups: TextPlan['groups'] = new Map();
  const prefixes = new Map<string, Set<string>>();
  const put = (k: string, list: 'added' | 'changed' | 'removed'): void => {
    // A help window that isn't a guide (it only gained its title): the help windows' group.
    const g = k.startsWith(HELP_PREFIX) ? 'help' : textGroupKey(k);
    if (!groups.has(g)) groups.set(g, { added: [], changed: [], removed: [] });
    groups.get(g)![list].push(k);
    if (!prefixes.has(g)) prefixes.set(g, new Set());
    prefixes.get(g)!.add(groupPrefix(k));
  };
  for (const k of added) if (!inGuide.has(k)) put(k, 'added');
  for (const k of changed) put(k, 'changed');
  for (const k of removed) put(k, 'removed');
  for (const [g, entry] of groups) {
    if (MIXED_GROUPS.has(g)) continue;
    const titleKey = findGroupTitle(prefixes.get(g) ?? new Set(), nextEn);
    if (titleKey) entry.titleKey = titleKey;
  }
  return { added, changed, removed, truncated, guides, guideTitles, groups };
}

/** The keys to read in every language: from the new catalogue, and from the old (for what a changed text said). */
export function planKeys(plan: TextPlan): { next: Set<string>; prev: Set<string> } {
  const next = new Set<string>([...plan.added, ...plan.changed, ...plan.guideTitles.values()]);
  for (const g of plan.groups.values()) if (g.titleKey) next.add(g.titleKey);
  return { next, prev: new Set(plan.changed) };
}

export type LangMaps = ReadonlyMap<NoteLang, ReadonlyMap<string, string>>;

export function textsOf(key: string, maps: LangMaps): LangTexts {
  const out: LangTexts = {};
  for (const lang of NOTE_LANGS) {
    const v = maps.get(lang)?.get(key);
    if (v !== undefined && v !== '') out[lang] = v;
  }
  return out;
}

/** The plan's keys as texts in every language read. `next`/`prev` hold 'en' (whole) and the others (planKeys). */
export function assembleTexts(plan: TextPlan, next: LangMaps, prev: LangMaps): { guides: GuideNote[]; texts: TextGroup[] } {
  const guides: GuideNote[] = [];
  for (const [win, keys] of plan.guides) {
    const parts = new Map<string, GuidePart>();
    for (const k of keys) {
      const rest = k.slice(HELP_PREFIX.length + win.length + 1).split('.');
      const last = rest[rest.length - 1];
      const part = rest.slice(0, -1).join('.');
      if (!part && last === 'title') continue; // the guide's own title
      if (!parts.has(part)) {
        const titleKey = plan.guideTitles.get(`${win}.${part}`);
        parts.set(part, { ...(titleKey ? { title: textsOf(titleKey, next) } : {}), texts: [] });
      }
      if (last === 'title') continue;
      parts.get(part)!.texts.push(textsOf(k, next));
    }
    const titleKey = plan.guideTitles.get(win);
    const list = [...parts.entries()]
      .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, undefined, { numeric: true })))
      .map(([, p]) => p)
      .filter((p) => p.texts.length);
    if (list.length) guides.push({ key: win, ...(titleKey ? { title: textsOf(titleKey, next) } : {}), parts: list });
  }
  guides.sort((a, b) => b.parts.reduce((n, p) => n + p.texts.length, 0) - a.parts.reduce((n, p) => n + p.texts.length, 0) || a.key.localeCompare(b.key));

  const texts: TextGroup[] = [];
  for (const [key, g] of plan.groups) {
    texts.push({
      key,
      ...(g.titleKey ? { title: textsOf(g.titleKey, next) } : {}),
      added: g.added.sort().map((k) => ({ key: k, text: textsOf(k, next) })),
      changed: g.changed.sort().map((k) => ({ key: k, text: textsOf(k, next), was: textsOf(k, prev) })),
      removed: g.removed.sort().map((k) => ({ key: k, text: textsOf(k, prev) })),
    });
  }
  // Groups with the most new texts first: that's where a feature is arriving.
  texts.sort((a, b) => b.added.length - a.added.length || (b.changed.length + b.removed.length) - (a.changed.length + a.removed.length) || a.key.localeCompare(b.key));
  return { guides, texts };
}

// ---------------------------------------------------------------------------
// Art
// ---------------------------------------------------------------------------

/** The picture an address is a variant of: sizes, icon/shard/animation suffixes and the walk cycle stripped. */
export function artStem(name: string): string {
  let s = name.toLowerCase();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s
      .replace(/^anim_/, '')
      .replace(/^icon_/, '')
      .replace(/_spine$/, '')
      .replace(/_\d{2,4}x\d{2,4}(?:_[a-z])?$/, '')
      .replace(/_(?:22|28|32|36|42|44|48|50|56|62|64|72|80|96|128|144)$/, '')
      .replace(/_(?:hero|unit)(?:_(?:attack|down|left|left_down|left_up|up|right))?$/, '')
      .replace(/_shard_icon(?:_\d)?$/, '')
      .replace(/_icon(?:_\d)?$/, '')
      .replace(/_shard$/, '')
      .replace(/_anim$/, '');
    if (s === before) break;
  }
  return s || name.toLowerCase();
}

/**
 * Pictures the catalogue added, grouped by stem. Pictures a section entry
 * already shows (`claimed`, and anything sharing a stem with one) are left
 * out: the gallery is for what no entry explains.
 */
export function diffArtNames(prev: Iterable<string> | null, next: Iterable<string>, claimed: ReadonlySet<string>): ArtGroup[] {
  if (!prev) return [];
  const before = new Set(prev);
  const claimedStems = new Set([...claimed].map(artStem));
  const groups = new Map<string, string[]>();
  for (const n of next) {
    if (!n || before.has(n) || claimed.has(n)) continue;
    const stem = artStem(n);
    if (claimedStems.has(stem)) continue;
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem)!.push(n);
  }
  return [...groups.entries()]
    .map(([stem, names]) => ({ stem, names: names.sort() }))
    .sort((a, b) => a.stem.localeCompare(b.stem));
}

/** Every picture name the sections and trees use (for diffArtNames' `claimed`). */
export function claimedArt(sections: NoteSection[], trees: TreeNote[], safe: (n: string) => string): Set<string> {
  const out = new Set<string>();
  for (const s of sections) {
    for (const e of s.entries) {
      for (const n of [...(e.icon ?? []), ...(e.art ?? [])]) out.add(n);
    }
  }
  for (const t of trees) {
    if (t.tree.icon) out.add(safe(t.tree.icon));
    for (const n of [...t.tree.nodes, ...(t.tree.unplaced ?? [])]) if (n.icon) out.add(safe(n.icon));
  }
  return out;
}

/** Name parts too common to tie a picture to a text. */
const ART_TOKEN_STOP = new Set(['icon', 'icons', 'the', 'of', 'and', 'big', 'small', 'new', 'old', 'back', 'bg']);
const tokensOf = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 1 && !ART_TOKEN_STOP.has(x));
/** Texts kept per picture, and past how many matches a stem is too generic to say anything. */
const MAX_ART_TEXTS = 4;
const TOO_MANY_ART_TEXTS = 12;

/**
 * The game's texts about a picture: catalogue keys holding every part of its
 * stem ("clan_city_customization_union_57" → customization.name.union_clan_city_57,
 * customization.description.union_clan_city_57). Names and descriptions first.
 * A stem of fewer than two parts, or one that matches too much, gets nothing.
 */
export function artTextKeys(groups: ArtGroup[], en: ReadonlyMap<string, string>): Map<string, string[]> {
  const wanted = groups.map((g) => ({ stem: g.stem, tokens: tokensOf(g.stem) })).filter((g) => g.tokens.length >= 2);
  const hits = new Map<string, string[]>(wanted.map((g) => [g.stem, []]));
  for (const key of en.keys()) {
    const keyTokens = new Set(tokensOf(key));
    for (const g of wanted) {
      if (g.tokens.every((tk) => keyTokens.has(tk))) hits.get(g.stem)!.push(key);
    }
  }
  const rank = (k: string): number => (/\.(?:full_)?name\b/.test(k) ? 0 : /\.description\b/.test(k) ? 1 : /tooltip/.test(k) ? 2 : 3);
  const out = new Map<string, string[]>();
  for (const [stem, keys] of hits) {
    if (!keys.length || keys.length > TOO_MANY_ART_TEXTS) continue;
    out.set(stem, keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, MAX_ART_TEXTS));
  }
  return out;
}

/**
 * The game's names for a picture: any entry of the art static slice (items,
 * captains, units, frames, city looks…) drawn with a picture of the same stem.
 */
export function artNamesByStem(slice: Record<string, unknown> | null, safe: (n: string) => string): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const add = (pic: unknown, name: unknown): void => {
    if (typeof pic !== 'string' || !pic || typeof name !== 'string' || !name.trim()) return;
    const stem = artStem(safe(pic));
    if (!out.has(stem)) out.set(stem, new Set());
    out.get(stem)!.add(name.trim());
  };
  for (const section of Object.values(slice ?? {})) {
    const rows = Array.isArray(section) ? section : section && typeof section === 'object' ? Object.values(section) : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      for (const k of ['icon', 'visual', 'art']) add(r[k], r.name);
      if (r.icons && typeof r.icons === 'object') for (const pic of Object.values(r.icons as Record<string, unknown>)) add(pic, r.name);
    }
  }
  return new Map([...out].map(([k, v]) => [k, [...v]]));
}

// ---------------------------------------------------------------------------
// Summary (the list of patches, Home's notice)
// ---------------------------------------------------------------------------

export interface PatchSummary {
  id: string;
  date: string;
  /** Per part ("trees", "texts", "images", "guides") and per section key: how many things are new or changed. */
  counts: Record<string, number>;
  /** The few names worth a headline: new trees, events, captains, artifacts. */
  highlights: Array<{ section: string; name: string }>;
}

const HIGHLIGHT_SECTIONS = ['events', 'captains', 'artifacts', 'heroes'];

export function summarizeNotes(n: PatchNotes): PatchSummary {
  const counts: Record<string, number> = {};
  const trees = n.trees.filter((t) => t.kind !== 'removed').length;
  if (trees) counts.trees = trees;
  for (const s of n.sections) {
    const c = s.entries.filter((e) => e.kind !== 'removed').length;
    if (c) counts[s.key] = c;
  }
  if (n.guides.length) counts.guides = n.guides.length;
  const added = n.texts.reduce((sum, g) => sum + g.added.length, 0) + n.guides.reduce((sum, g) => sum + g.parts.reduce((x, p) => x + p.texts.length, 0), 0);
  if (added) counts.texts = added;
  if (n.images.length) counts.images = n.images.length;
  const highlights: PatchSummary['highlights'] = [];
  for (const t of n.trees) if (t.kind === 'added') highlights.push({ section: 'trees', name: t.tree.name });
  for (const key of HIGHLIGHT_SECTIONS) {
    const s = n.sections.find((x) => x.key === key);
    for (const e of s?.entries ?? []) {
      if ((e.kind === 'added' || e.kind === 'revealed') && e.name && !e.unnamed) highlights.push({ section: key, name: e.name });
    }
  }
  return { id: n.id, date: n.date, counts, highlights: highlights.slice(0, 8) };
}
