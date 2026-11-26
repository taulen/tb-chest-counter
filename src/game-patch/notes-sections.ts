/**
 * What Tools → What's new lists, per kind of game data — the one place that
 * says how a kind is named, pictured and drilled into. Two sources, both per
 * static-data version and both diffed whole:
 *
 *   names  data/game-static/<version>/names.json (static-data.ts GameNames)
 *   art    data/game-art/static-<version>.json  (game-art/art-static.ts ArtStatic)
 *
 * A key that has no entry here is still diffed and listed (`genericSection`):
 * its entries named by `name` / `title` / a plain string, its changes as raw
 * values. So when the game data grows a new kind, the page shows it the next
 * patch with nothing to do; an entry below only makes it read better (a name,
 * a picture, a drill-down), and pages/whats-new.js's SECTION_VIEWS gives it a
 * label and a layout. See docs/game-patches.md → "What's new".
 */
import { safeArtName } from '../game-art/selection.js';

export type SectionSource = 'names' | 'art';

/** What the registry may use to find an entry's pictures (the current art). */
export interface SectionCtx {
  /** The art index's id mappings (game-art/mappings.ts ArtMappings); {} without art. */
  mappings: Record<string, unknown>;
  /** T8 item id → icon, from the art static slice. */
  itemIcons: Map<string, string>;
  /** Tech id → icon, from the art static slice. */
  techIcons: Map<string, string>;
}

/** A labelled value whose change is worth showing: "★2 · Specialists' strength" → "+30%". */
export interface ValueLine {
  /** Where in the entry: "★2", "Lv 60"; absent for a single-valued field. */
  at?: string;
  /** The game's own text (English; the page translates it with tGame). */
  text: string;
  value: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the sources are JSON of many shapes; each def reads its own */
export interface SectionDef {
  key: string;
  source: SectionSource;
  /** The section's values by id. Default: the source's `key` object. */
  values?(src: Record<string, any>): Record<string, any> | undefined;
  /** The entry's name ('' = the game has none yet). */
  name(v: any, id: string): string;
  /** A short line under the name: a rarity, a source, a tab. */
  sub?(v: any, id: string): string | undefined;
  /** Picture names, best first (any that the art has wins). */
  icon?(v: any, id: string, ctx: SectionCtx): Array<string | null | undefined>;
  /** Big picture names for the drill-down, best first. */
  art?(v: any, id: string, ctx: SectionCtx): Array<string | null | undefined>;
  /** Tile layers (a captain's rarity back and frame). */
  layers?(v: any, id: string, ctx: SectionCtx): { back?: string; frame?: string } | undefined;
  /** The drill-down's data, kept with the note (small). */
  detail?(v: any, id: string): Record<string, unknown> | undefined;
  /** The values compared for "changed" (default: every leaf, by path). */
  lines?(v: any): ValueLine[];
  /** Several ids under one name are one entry (a monster's many map objects). */
  groupByName?: boolean;
  /** Leave an entry out (internal rows). */
  keep?(v: any, id: string): boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const mapped = (ctx: SectionCtx, map: string, id: string): string | undefined => {
  const m = ctx.mappings[map] as Record<string, unknown> | undefined;
  const v = m?.[id];
  return typeof v === 'string' ? v : undefined;
};
const art = (name: unknown): string | undefined => (typeof name === 'string' && name ? safeArtName(name) : undefined);

/** [text, value] pairs (the game's own bonus lines) as ValueLines at `at`. */
function pairLines(pairs: unknown, at?: string): ValueLine[] {
  if (!Array.isArray(pairs)) return [];
  const out: ValueLine[] = [];
  for (const p of pairs) {
    if (Array.isArray(p) && typeof p[0] === 'string') out.push({ at, text: p[0], value: String(p[1] ?? '') });
  }
  return out;
}

/** A captain's star bonuses: { "1": [[text, value]…], … }. */
function starLines(stars: unknown): ValueLine[] {
  if (!stars || typeof stars !== 'object') return [];
  return Object.entries(stars as Record<string, unknown>).flatMap(([s, pairs]) => pairLines(pairs, `★${s}`));
}

/** An artifact's level or star table: { effectId: [level, [[text, value]…]] }. */
function levelTable(table: unknown, mark: string): ValueLine[] {
  if (!table || typeof table !== 'object') return [];
  return Object.values(table as Record<string, unknown>).flatMap((row) =>
    Array.isArray(row) ? pairLines(row[1], `${mark}${row[0]}`) : []);
}

/** The bonus lines of an artifact's lowest and highest level ({ effectId: [level, lines] }). */
function levelEnds(table: unknown): { first: unknown; last: unknown; firstLevel: number; lastLevel: number } | null {
  if (!table || typeof table !== 'object') return null;
  const rows = Object.values(table as Record<string, unknown>).filter((r): r is [number, unknown] => Array.isArray(r) && typeof r[0] === 'number');
  if (!rows.length) return null;
  rows.sort((a, b) => a[0] - b[0]);
  return { first: rows[0][1], last: rows[rows.length - 1][1], firstLevel: rows[0][0], lastLevel: rows[rows.length - 1][0] };
}

/** "boudica_icon" → "boudica": the stem the client derives a captain's other pictures from. */
const iconStem = (icon: unknown): string => str(icon).toLowerCase().replace(/_icon$/, '');

export const SECTION_DEFS: readonly SectionDef[] = [
  {
    key: 'events', source: 'names', groupByName: true,
    name: (v) => str(v.title),
    detail: (v) => ({ code: v.code }),
  },
  {
    key: 'captains', source: 'names',
    name: (v) => str(v.name),
    sub: (v) => str(v.rarityName) || undefined,
    icon: (v, id, ctx) => [mapped(ctx, 'captains', id), art(v.icon)],
    // The captain screen's full-body picture, else the city sprite. Not `art`
    // (lvlup_*): a tall level-up strip with the face at its foot.
    art: (v, id, ctx) => [mapped(ctx, 'captainArt', id), iconStem(v.icon) && `citizen_captain_${iconStem(v.icon)}`],
    layers: (v, _id, ctx) => {
      const tile = ctx.mappings.captainTile as { backs?: Record<string, string>; frames?: Record<string, string> } | undefined;
      const r = String(v.rarity ?? '');
      return tile ? { back: tile.backs?.[r], frame: tile.frames?.[r] } : undefined;
    },
    detail: (v) => ({ rarity: v.rarity, rarityName: v.rarityName, stars: v.stars }),
    lines: (v) => [{ text: 'Rarity', value: str(v.rarityName) }, ...starLines(v.stars)],
  },
  {
    key: 'heroes', source: 'names',
    name: (v) => str(v.name),
    icon: (v) => [art(v.icon)],
  },
  {
    key: 'artifacts', source: 'names',
    name: (v) => str(v.name),
    sub: (v) => str(v.rarityName) || undefined,
    icon: (v, id, ctx) => [mapped(ctx, 'artifacts', id), art(v.icon)],
    detail: (v) => {
      const ends = levelEnds(v.levels);
      return {
        rarity: v.rarity,
        rarityName: v.rarityName,
        maxLevel: v.maxLevel,
        maxStar: v.maxStar,
        first: ends?.first,
        firstLevel: ends?.firstLevel,
        last: ends?.last,
        lastLevel: ends?.lastLevel,
        bonuses: v.bonuses ? Object.values(v.bonuses).map((b: any) => [b?.[0], b?.[1]]) : undefined,
      };
    },
    lines: (v) => [
      { text: 'Max level', value: String(v.maxLevel ?? '') },
      { text: 'Max star level', value: String(v.maxStar ?? '') },
      ...levelTable(v.levels, 'Lv '),
      ...levelTable(v.stars, '★'),
    ],
  },
  {
    key: 'gifts', source: 'names', groupByName: true,
    // T8: a gift type's names (gifts) and the same id's kind and quality (items).
    values: (src) => {
      const gifts = src.gifts as Record<string, any> | undefined;
      if (!gifts) return undefined;
      const items = (src.items ?? {}) as Record<string, any>;
      const out: Record<string, any> = {};
      for (const [id, g] of Object.entries(gifts)) out[id] = { ...g, ...(items[id] ?? {}) };
      return out;
    },
    name: (v) => str(v.chest),
    sub: (v) => str(v.source) || undefined,
    icon: (_v, id, ctx) => [ctx.itemIcons.get(id)],
    detail: (v) => ({ source: v.source || undefined, kind: v.kind, quality: v.quality }),
    lines: (v) => [
      { text: 'Source', value: str(v.source) },
      { text: 'Quality', value: v.quality === undefined ? '' : String(v.quality) },
    ],
  },
  {
    key: 'titles', source: 'names',
    name: (v) => str(v.name),
    sub: (v) => str(v.source) || undefined,
    icon: (v, id, ctx) => [mapped(ctx, 'titleArt', id), art(v.art), mapped(ctx, 'titles', id), art(v.icon)],
    detail: (v) => ({ description: v.description, source: v.source, seconds: v.seconds }),
    lines: (v) => [
      { text: 'Bonus', value: str(v.description) },
      { text: 'Source', value: str(v.source) },
      { text: 'Duration', value: String(v.seconds ?? '') },
    ],
  },
  {
    key: 'medals', source: 'names',
    name: (v) => str(v.name),
    sub: (v) => str(v.tierName) || undefined,
    icon: (v) => [art(v.icon)],
    detail: (v) => ({ description: v.description, tier: v.tier, tierName: v.tierName }),
  },
  {
    key: 'equipment', source: 'names', groupByName: true,
    name: (v) => str(v.name),
    icon: (v, id, ctx) => [mapped(ctx, 'equipment', id), art(v.icon)],
    detail: (v) => ({ grade: v.grade, lines: v.lines }),
    lines: (v) => pairLines(v.lines),
  },
  {
    key: 'inserts', source: 'names',
    name: (v) => str(v.name),
    icon: (v, id, ctx) => [mapped(ctx, 'inserts', id), art(v.icon)],
    detail: (v) => ({ kind: v.kind }),
  },
  {
    key: 'factions', source: 'names',
    name: (v) => str(v.name),
    icon: (v) => [art(v.art?.icon), art(v.art?.frameIcon)],
    detail: (v) => ({ maxLevel: v.maxLevel }),
  },
  {
    key: 'techs', source: 'names',
    name: (v) => str(v.name),
    icon: (_v, id, ctx) => [mapped(ctx, 'techs', id), ctx.techIcons.get(id)],
    detail: (v) => ({ maxLevel: v.maxLevel }),
    lines: (v) => [{ text: 'Max level', value: String(v.maxLevel ?? '') }],
  },
  { key: 'objects', source: 'names', groupByName: true, name: (v) => str(v) },
  { key: 'terrains', source: 'names', name: (v) => str(v) },
  { key: 'equipmentGrades', source: 'names', name: (v) => str(v) },
  // The art static slice: what names.json does not carry.
  {
    key: 'frames', source: 'art',
    name: (v) => str(v.name),
    icon: (v, id, ctx) => [mapped(ctx, 'avatarFrames', id), art(v.visual)],
  },
  {
    key: 'cityLooks', source: 'art',
    name: (v) => str(v.name),
    // The look at its highest city level — the grandest of its pictures.
    icon: (v) => {
      const icons = v.icons && typeof v.icons === 'object' ? Object.entries(v.icons as Record<string, string>) : [];
      icons.sort((a, b) => Number(b[0]) - Number(a[0]));
      return icons.map(([, n]) => art(n));
    },
  },
  {
    key: 'units', source: 'art', groupByName: true,
    // An array of { id, … } in the slice.
    values: (src) => (Array.isArray(src.units) ? Object.fromEntries((src.units as any[]).map((u) => [String(u.id), u])) : undefined),
    name: (v) => str(v.name),
    sub: (v) => (v.tier ? `T${v.tier}` : undefined),
    icon: (v) => [art(v.icon)],
    detail: (v) => ({ tier: v.tier, strength: v.strength, health: v.health }),
    lines: (v) => [
      { text: 'Strength', value: String(v.strength ?? '') },
      { text: 'Health', value: String(v.health ?? '') },
    ],
  },
];

/**
 * Keys never listed: bookkeeping, and what another section already covers
 * (names.json `items` rides in `gifts`; the art slice's copies of names.json's
 * sections, and its tree `branches` — the research trees have their own part).
 */
export const IGNORED_KEYS: Readonly<Record<SectionSource, ReadonlySet<string>>> = {
  names: new Set(['version', 'builtAt', 'format', 'textLanguages', 'items']),
  art: new Set(['version', 'format', 'heroes', 'techs', 'items', 'captains', 'artifacts', 'equipment', 'inserts', 'titles', 'branches']),
};

/** A key without a registry entry: listed all the same, named as well as the value allows. */
export function genericSection(key: string, source: SectionSource): SectionDef {
  return {
    key,
    source,
    name: (v) => {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object') return str(v.name) || str(v.title) || str(v.chest);
      return '';
    },
    icon: (v) => (v && typeof v === 'object' ? [art(v.icon), art(v.visual), art(v.art)] : []),
  };
}

export function sectionDef(source: SectionSource, key: string): SectionDef {
  return SECTION_DEFS.find((d) => d.source === source && d.key === key) ?? genericSection(key, source);
}

/** Display order: the registry's, then any other key alphabetically. */
export function sectionOrder(source: SectionSource, key: string): number {
  const i = SECTION_DEFS.findIndex((d) => d.source === source && d.key === key);
  return i >= 0 ? i : SECTION_DEFS.length;
}
