/**
 * What a hero's or captain's level means, from the Heroes table (T10, built
 * into names.json as `heroLevels`): the XP its level started at and the XP the
 * next one starts at (the game's "Experience points to the next level"), and
 * the Stats screen's Leadership / Authority / Dominance / Might.
 *
 * Checked Nov 2026: every one of prod's 6,179 captains has req(level) ≤ xp <
 * req(level + 1); Carter level 200 ★6 shows Leadership 40,000, Authority
 * 20,000, Dominance 10,000 and Might 2,770,000 = 2,500,000 (the levels' Might
 * up to 200) + 270,000 (★6's).
 */
import type { GameNames, HeroLevels } from './static-data.js';

export interface CaptainStats {
  leadership: number;
  authority: number;
  dominance: number;
  might: number;
}

export interface HeroLevelView {
  /** XP this level started at. */
  xpFloor: number | null;
  /** XP the next level starts at; null at the last level. */
  xpNext: number | null;
  /** Null for the hero: its Stats screen adds research and gear we don't model. */
  stats: CaptainStats | null;
}

const at = (levels: HeroLevels, idx: number, level: number): number | null => {
  const v = levels.series[idx]?.[level - 1];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/**
 * The level view of field-9 entry `heroId` (1 = the hero, else a T75 captain
 * id) at `level` / `stars`, or null when names.json has no levels for it.
 * `withStats` is for captains: their Stats screen is exactly these values.
 */
export function heroLevelView(
  names: Pick<GameNames, 'heroLevels' | 'captains'> | null | undefined,
  heroId: number,
  level: number,
  stars = 0,
  withStats = true,
): HeroLevelView | null {
  const levels = names?.heroLevels;
  const s = levels?.heroes?.[String(heroId)];
  if (!levels || !s || !Number.isInteger(level) || level < 1) return null;
  const maxLevel = levels.series[s.xp]?.length ?? 0;
  if (level > maxLevel) return null;
  let stats: CaptainStats | null = null;
  if (withStats) {
    const mightSeries = levels.series[s.might] ?? [];
    let might = 0;
    for (let i = 0; i < level && i < mightSeries.length; i++) might += mightSeries[i] ?? 0;
    might += names?.captains?.[String(heroId)]?.starMight?.[String(stars)] ?? 0;
    stats = {
      leadership: at(levels, s.leadership, level) ?? 0,
      authority: at(levels, s.authority, level) ?? 0,
      dominance: at(levels, s.dominance, level) ?? 0,
      might,
    };
  }
  return {
    xpFloor: at(levels, s.xp, level),
    xpNext: level < maxLevel ? at(levels, s.xp, level + 1) : null,
    stats,
  };
}
