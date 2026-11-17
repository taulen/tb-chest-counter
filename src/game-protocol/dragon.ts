/**
 * A player's Dragon as the game's Dragon window shows it: name, level out of
 * its evolution's cap ("Lvl. 237/250"), the XP to the next level, and the
 * bonuses of its level and of its evolution, each beside the next one's
 * ("Next level is +114% > +115%").
 *
 * Nothing new is read for it: city field 26 (CityRecord.dragon) holds level,
 * XP, evolution stage and the name the player gave it; the daily city
 * snapshot keeps it (column `hero`, named before field 26 was known to be the
 * dragon). The Dragons table (T73, static-data.ts buildDragon → GameNames)
 * gives the XP thresholds, bonuses and sprites.
 */
import type { GameDragon, GameNames, GameTextLine } from './static-data.js';

/** City field 26 as stored: stage and name only since Nov 2026 (older snapshots lack them). */
export interface StoredDragon {
  level?: number | null;
  xp?: number | null;
  stage?: number | null;
  name?: string | null;
}

export interface DragonView {
  /** The name the player gave it ("Salty"), null when unknown. */
  name: string | null;
  /** The game's word for it ("Dragon"). */
  title: string;
  level: number;
  maxLevel: number;
  /** Evolution stage 1–8, null when the stored read predates it. */
  stage: number | null;
  maxStage: number;
  /** The highest level this evolution reaches (the game's "/250"), null without the stage. */
  levelCap: number | null;
  xp: number | null;
  /** XP this level started at, and the XP the next one starts at (null at the top). */
  xpFloor: number | null;
  xpNext: number | null;
  /** At its evolution's cap below the top: it gains no XP until it evolves. */
  atCap: boolean;
  /** Bonuses at this level, and the next level's (null at the top). */
  levelLines: GameTextLine[];
  nextLevel: { level: number; lines: GameTextLine[] } | null;
  /** The evolution's own bonuses, and the next evolution's (null at the last, or without the stage). */
  stageLines: GameTextLine[];
  nextStage: { stage: number; levelCap: number; lines: GameTextLine[] } | null;
  /** The game's pictures through `artUrl`, null until extracted. */
  iconUrl: string | null;
  frameUrl: string | null;
  artUrl: string | null;
  backUrl: string | null;
}

/** A bonus value as the game shows it: a percent with its sign. */
export const dragonBonusText = (v: number): string => `${v >= 0 ? '+' : ''}${v}%`;

/**
 * Bonus lines for `now`, and the `next` values of the lines that change: a
 * line shows when either side gives anything (ten zeros at level 1 say
 * nothing), and a next value only where it moves — one level up changes one
 * or two of the ten lines, and "+114% › +114%" eight times over hides them.
 */
function linesOf(d: GameDragon, now: number[], next: number[] | null): { now: GameTextLine[]; next: GameTextLine[] } {
  const out = { now: [] as GameTextLine[], next: [] as GameTextLine[] };
  d.bonusNames.forEach((name, i) => {
    const a = now[i] ?? 0;
    const b = next ? next[i] ?? 0 : 0;
    if (!a && !b) return;
    out.now.push([name, dragonBonusText(a)]);
    if (next && b !== a) out.next.push([name, dragonBonusText(b)]);
  });
  return out;
}

/**
 * The view of a stored dragon, or null when there is none (no dragon yet, or
 * the static data has no T73 — a names.json from before format 9).
 */
export function dragonView(
  names: Pick<GameNames, 'dragon'> | null | undefined,
  stored: StoredDragon | null | undefined,
  artUrl: (name: string) => string | null,
): DragonView | null {
  const d = names?.dragon;
  const level = Number(stored?.level);
  if (!d || !Number.isInteger(level) || level < 1 || level > d.xp.length) return null;
  const maxLevel = d.xp.length;
  const stageNums = Object.keys(d.stages).map(Number).filter(Number.isInteger);
  const maxStage = stageNums.length ? Math.max(...stageNums) : 0;
  const stageNum = Number(stored?.stage);
  const stage = Number.isInteger(stageNum) && d.stages[String(stageNum)] ? stageNum : null;
  const st = stage !== null ? d.stages[String(stage)] : null;
  const nextSt = stage !== null ? d.stages[String(stage + 1)] ?? null : null;
  const xp = typeof stored?.xp === 'number' && Number.isFinite(stored.xp) ? stored.xp : null;

  const atTop = level >= maxLevel;
  const lv = linesOf(d, d.levelBonuses[level - 1] ?? [], atTop ? null : d.levelBonuses[level] ?? null);
  const sv = st ? linesOf(d, st.bonuses, nextSt ? nextSt.bonuses : null) : { now: [], next: [] };
  const url = (n: string) => (n ? artUrl(n) : null);
  return {
    name: typeof stored?.name === 'string' && stored.name.trim() ? stored.name.trim() : null,
    title: d.name,
    level,
    maxLevel,
    stage,
    maxStage,
    levelCap: st?.levelCap ?? null,
    xp,
    xpFloor: d.xp[level - 1] ?? null,
    xpNext: atTop ? null : d.xp[level] ?? null,
    atCap: !!st && !atTop && level >= st.levelCap,
    levelLines: lv.now,
    nextLevel: atTop ? null : { level: level + 1, lines: lv.next },
    stageLines: sv.now,
    nextStage: st && nextSt && stage !== null ? { stage: stage + 1, levelCap: nextSt.levelCap, lines: sv.next } : null,
    iconUrl: url(st?.icon ?? ''),
    frameUrl: url(d.art.frame),
    artUrl: url(st?.art ?? ''),
    backUrl: url(d.art.back),
  };
}
