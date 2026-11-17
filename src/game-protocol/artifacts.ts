/**
 * Artifacts from a city's active effects (601 field 14) — readable for ANY
 * player, not only the signed-in one.
 *
 * Field 14 lists every effect active in the city, `[effectId, sourceBits,
 * count]`. An artifact worn by one of the three line-up captains contributes
 * exactly one LEVEL effect, one STAR-LEVEL effect and its rolled RANDOM
 * BONUSES (count 2 = the same roll twice). Each of those effect ids belongs to
 * exactly one artifact type in the static tables (T111/T112/T113, see
 * static-data.ts), so the effects alone say which artifacts are worn, at what
 * level and star level, with which rolls. Artifacts on captains outside the
 * line-up are not active and are not in the city data at all.
 *
 * Source bits seen (Nov 2026): 16384 level, 8192 star level, 1 random bonus —
 * the effect id decides, the bits are not needed.
 *
 * Checked against the game's artifact book (Nov 2026): Torch of Olympus,
 * Legendary, level 50/60 "Crypt exploration efficiency 130%", star level 21
 * (4 stars and a partial 5th) "136%", random bonuses Epic Crypt +100%,
 * Common / Rare / Epic +50%.
 *
 * Message 61000 lists the SIGNED-IN account's own artifacts (all of them,
 * worn or not) and ignores any argument — it cannot read another player.
 */
import type { GameArtifact } from './static-data.js';

export interface CityEffect {
  id: number;
  source: number;
  count: number;
}

export interface WornArtifact {
  /** T110 artifact type. */
  type: number;
  /** 1–60; 0 when the level effect was missing. */
  level: number;
  /** Star level 1–25 (five steps per star); 0 when missing. */
  star: number;
  /** Random-bonus effect ids, a repeated roll listed once per copy, ascending. */
  bonuses: number[];
}

type EffectRef = { type: number; kind: 'level' | 'star' | 'bonus'; n: number };

const indexMemo = new WeakMap<Record<string, GameArtifact>, Map<number, EffectRef>>();

/** Effect id → which artifact type it belongs to and what it is. */
export function artifactEffectIndex(artifacts: Record<string, GameArtifact>): Map<number, EffectRef> {
  const memo = indexMemo.get(artifacts);
  if (memo) return memo;
  const out = new Map<number, EffectRef>();
  for (const [typeKey, a] of Object.entries(artifacts)) {
    const type = Number(typeKey);
    for (const [id, [n]] of Object.entries(a.levels ?? {})) out.set(Number(id), { type, kind: 'level', n });
    for (const [id, [n]] of Object.entries(a.stars ?? {})) out.set(Number(id), { type, kind: 'star', n });
    for (const id of Object.keys(a.bonuses ?? {})) out.set(Number(id), { type, kind: 'bonus', n: 0 });
  }
  indexMemo.set(artifacts, out);
  return out;
}

export interface ArtifactView {
  name: string;
  rarity: number;
  rarityName: string;
  icon: string;
  maxLevel: number;
  maxStar: number;
  /** The level's lines ("Crypt exploration efficiency", "+130.0%"). */
  levelLines: Array<[string, string]>;
  /** The star level's lines. */
  starLines: Array<[string, string]>;
  /** The rolls, best quality first (as the game lists the strongest roll on top). */
  bonusLines: Array<{ text: string; value: string; quality: number }>;
}

/** What the artifact book shows for one artifact at this level / star level / rolls. Pure. */
export function describeArtifact(
  type: number,
  level: number,
  star: number,
  bonuses: number[],
  artifacts: Record<string, GameArtifact> | undefined,
): ArtifactView {
  const a = artifacts?.[String(type)];
  const linesAt = (rows: Record<string, [number, Array<[string, string]>]> | undefined, n: number): Array<[string, string]> =>
    Object.values(rows ?? {}).find(([at]) => at === n)?.[1] ?? [];
  const bonusLines = bonuses
    .map((id, i) => {
      const b = a?.bonuses?.[String(id)];
      return { text: b?.[0] ?? `#${id}`, value: b?.[1] ?? '', quality: b?.[2] ?? 0, i };
    })
    .sort((x, y) => y.quality - x.quality || x.i - y.i)
    .map(({ text, value, quality }) => ({ text, value, quality }));
  return {
    name: a?.name ?? `#${type}`,
    rarity: a?.rarity ?? 0,
    rarityName: a?.rarityName ?? '',
    icon: a?.icon ?? '',
    maxLevel: a?.maxLevel ?? 0,
    maxStar: a?.maxStar ?? 0,
    levelLines: linesAt(a?.levels, level),
    starLines: linesAt(a?.stars, star),
    bonusLines,
  };
}

/** The artifacts the line-up captains wear, by type ascending. Pure. */
export function artifactsFromEffects(effects: CityEffect[], artifacts: Record<string, GameArtifact> | undefined): WornArtifact[] {
  if (!artifacts || !effects.length) return [];
  const index = artifactEffectIndex(artifacts);
  const byType = new Map<number, WornArtifact>();
  const get = (type: number): WornArtifact => {
    let a = byType.get(type);
    if (!a) byType.set(type, (a = { type, level: 0, star: 0, bonuses: [] }));
    return a;
  };
  for (const e of effects) {
    const ref = index.get(e.id);
    if (!ref) continue;
    const a = get(ref.type);
    if (ref.kind === 'level') a.level = Math.max(a.level, ref.n);
    else if (ref.kind === 'star') a.star = Math.max(a.star, ref.n);
    else for (let i = 0; i < Math.max(1, e.count); i++) a.bonuses.push(e.id);
  }
  return [...byType.values()]
    .map((a) => ({ ...a, bonuses: [...a.bonuses].sort((x, y) => x - y) }))
    .sort((x, y) => x.type - y.type);
}
